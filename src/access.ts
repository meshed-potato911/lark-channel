// Sender access control
// Manages allowlist and pairing codes for Feishu sender authorization.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { AccessConfig } from './router.js'
import { sendText } from './lark.js'

interface PairingEntry {
  senderId: string
  chatId: string
  ts: number
}

let policy: 'open' | 'allowlist' = 'open'
let allowedSenders: string[] = []
const pendingCodes = new Map<string, PairingEntry>()

const PAIRING_TTL = 5 * 60 * 1000 // 5 minutes
const PAIRING_CHARS = 'abcdefghijkmnopqrstuvwxyz' // no 'l'

// Persistence file for allowed senders
let persistPath: string | null = null

export function initAccess(config: AccessConfig, savePath?: string): void {
  policy = config.policy
  allowedSenders = [...config.allowedSenders]
  persistPath = savePath ?? null

  // Load persisted senders if file exists
  if (persistPath && existsSync(persistPath)) {
    try {
      const data = JSON.parse(readFileSync(persistPath, 'utf-8'))
      if (Array.isArray(data.allowed)) {
        for (const id of data.allowed) {
          if (!allowedSenders.includes(id)) allowedSenders.push(id)
        }
      }
    } catch {
      // ignore parse errors
    }
  }
}

function save(): void {
  if (!persistPath) return
  const dir = dirname(persistPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(persistPath, JSON.stringify({ allowed: allowedSenders }, null, 2))
}

export function isSenderAllowed(senderId: string): boolean {
  if (policy === 'open') return true
  return allowedSenders.includes(senderId)
}

export function addSender(senderId: string): void {
  if (!allowedSenders.includes(senderId)) {
    allowedSenders.push(senderId)
    save()
  }
}

export function setAccessPolicy(p: 'open' | 'allowlist'): void {
  policy = p
}

export function getAllowed(): string[] {
  return [...allowedSenders]
}

function generateCode(): string {
  let code = ''
  for (let i = 0; i < 5; i++) {
    code += PAIRING_CHARS[Math.floor(Math.random() * PAIRING_CHARS.length)]
  }
  return code
}

export function createPairingCode(senderId: string, chatId: string): string {
  const code = generateCode()
  pendingCodes.set(code, { senderId, chatId, ts: Date.now() })
  setTimeout(() => pendingCodes.delete(code), PAIRING_TTL)
  return code
}

export function resolvePairingCode(code: string): PairingEntry | null {
  const normalized = code.toLowerCase().trim()
  const entry = pendingCodes.get(normalized)
  if (!entry) return null
  pendingCodes.delete(normalized)
  addSender(entry.senderId)
  return entry
}

// Handle unauthorized sender: send pairing code
export async function handleUnauthorized(chatId: string, senderId: string): Promise<void> {
  const code = createPairingCode(senderId, chatId)
  await sendText(chatId,
    `Sender not authorized. Pairing code: ${code}\n` +
    `Ask the admin to approve with: pair ${code}`,
  )
}
