// Lark WebSocket event bridge
// Subscribes to Feishu events via lark-cli and emits parsed events.

import { spawn, type Subprocess } from 'bun'

const LARK_CLI = 'lark-cli'

export interface LarkEvent {
  type: string
  id: string
  message_id: string
  chat_id: string
  chat_type: string      // p2p | group
  message_type: string   // text | post | image | file | ...
  content: string
  sender_id: string
  create_time: string
}

export type EventHandler = (event: LarkEvent) => void

interface BridgeOptions {
  eventTypes?: string[]
  onError?: (err: string) => void
  reconnectDelay?: number
}

const DEFAULT_EVENT_TYPES = [
  'im.message.receive_v1',
]

export function startBridge(handler: EventHandler, options: BridgeOptions = {}): Subprocess {
  const eventTypes = options.eventTypes ?? DEFAULT_EVENT_TYPES
  const reconnectDelay = options.reconnectDelay ?? 5000

  const args = [
    'event', '+subscribe',
    '--event-types', eventTypes.join(','),
    '--compact', '--quiet',
    '--as', 'bot',
    '--force',
  ]

  function launch(): Subprocess {
    const proc = spawn([LARK_CLI, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    // Stream stdout line by line (NDJSON)
    ;(async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const event = JSON.parse(line) as LarkEvent
              handler(event)
            } catch {
              // non-JSON line, skip
            }
          }
        }
      } catch (err) {
        options.onError?.(`Event stream read error: ${err}`)
      }

      // Process exited, attempt reconnect
      options.onError?.(`Event bridge process exited, reconnecting in ${reconnectDelay}ms...`)
      setTimeout(() => {
        try {
          currentProc = launch()
        } catch (err) {
          options.onError?.(`Reconnect failed: ${err}`)
        }
      }, reconnectDelay)
    })()

    // Capture stderr
    ;(async () => {
      const text = await new Response(proc.stderr).text()
      if (text.trim()) {
        options.onError?.(`lark-cli stderr: ${text.trim()}`)
      }
    })()

    return proc
  }

  let currentProc = launch()
  return currentProc
}
