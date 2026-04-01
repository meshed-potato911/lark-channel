#!/usr/bin/env bun
// lark-channel: Feishu/Lark <-> Claude Code Agent collaboration bridge
//
// Architecture:
//   Feishu WebSocket (lark-cli event subscribe)
//     -> Bridge (NDJSON parser)
//     -> Router (chat_id -> group config from YAML)
//     -> Queue (per-group serial, cross-group parallel)
//     -> Agent (Python SDK subprocess with session resume)
//     -> Reply Engine (Reaction + Card + PATCH streaming)
//     -> lark-cli (send/reply)
//     -> Feishu group chat

import { resolve } from 'path'
import { loadConfig, initRoutes, routeChat, parseTtl } from './router.js'
import { startBridge, type LarkEvent } from './bridge.js'
import { getQueue } from './queue.js'
import { queryAgent, setPythonPath } from './agent.js'
import { handleAgentResponse } from './reply.js'
import { initAccess, isSenderAllowed, handleUnauthorized, resolvePairingCode, addSender, setAccessPolicy, getAllowed } from './access.js'
import { initSessions, getSessionId, setSessionId } from './sessions.js'
import { startPatrol, stopPatrol } from './patrol.js'
import { sendText } from './lark.js'

// Resolve config path from CLI arg or default
const configPath = process.argv[2] || './config.yaml'

function log(msg: string): void {
  console.error(`[lark-channel] ${msg}`)
}

async function main(): Promise<void> {
  log('Starting...')

  // 1. Load configuration
  const config = loadConfig(configPath)
  log(`Loaded ${config.groups.length} group(s) from ${configPath}`)

  // 2. Initialize subsystems
  const stateDir = resolve(process.env.HOME ?? '.', '.lark-channel')
  initRoutes(config.groups)
  initAccess(config.access, resolve(stateDir, 'access.json'))
  initSessions(resolve(stateDir, 'sessions.json'), parseTtl(config.settings.sessionTtl))
  setPythonPath(config.settings.python)

  // 3. Admin command handler (messages starting with special prefixes)
  function handleAdminCommand(event: LarkEvent): boolean {
    const text = event.content.trim().toLowerCase()

    // Pairing: "pair xxxxx"
    const pairMatch = text.match(/^pair\s+([a-km-z]{5})$/i)
    if (pairMatch) {
      const entry = resolvePairingCode(pairMatch[1])
      if (entry) {
        sendText(event.chat_id, `Sender ${entry.senderId} approved.`)
      }
      return true
    }

    // Policy: "access policy open" or "access policy allowlist"
    if (text === 'access policy open' || text === 'access policy allowlist') {
      const p = text.endsWith('open') ? 'open' : 'allowlist'
      setAccessPolicy(p as 'open' | 'allowlist')
      return true
    }

    // List allowed: "access list"
    if (text === 'access list') {
      const list = getAllowed()
      sendText(event.chat_id, list.length > 0 ? list.join('\n') : '(none)')
      return true
    }

    return false
  }

  // 4. Start Lark event bridge
  const bridge = startBridge(
    (event: LarkEvent) => {
      const group = routeChat(event.chat_id)
      if (!group) return // unconfigured group, ignore

      // Check admin commands first
      if (handleAdminCommand(event)) return

      // Access control
      if (!isSenderAllowed(event.sender_id)) {
        handleUnauthorized(event.chat_id, event.sender_id)
        return
      }

      // Enqueue for processing (serial within group)
      getQueue(event.chat_id).enqueue(async () => {
        try {
          const sessionId = getSessionId(event.chat_id)

          const chunks = queryAgent({
            message: event.content,
            sessionId,
            persona: group.persona,
            cwd: group.cwd,
            permissionMode: group.permissionMode,
            model: config.settings.defaultModel,
          })

          const result = await handleAgentResponse(
            event.message_id,
            event.chat_id,
            chunks,
          )

          if (result.sessionId) {
            setSessionId(event.chat_id, result.sessionId)
          }
        } catch (err) {
          log(`Error processing message in ${group.name}: ${err}`)
        }
      })
    },
    {
      onError: (err) => log(err),
    },
  )

  // 5. Start scheduled patrols
  startPatrol(config.groups, config.settings)

  // 6. Graceful shutdown
  const shutdown = () => {
    log('Shutting down...')
    stopPatrol()
    bridge.kill()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  log('Ready. Listening for Feishu messages...')
}

main().catch((err) => {
  log(`Fatal: ${err}`)
  process.exit(1)
})
