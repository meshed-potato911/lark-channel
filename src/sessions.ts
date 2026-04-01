// Session persistence
// Maps chat_id -> Agent SDK session_id for resume support.
// Persists to disk so sessions survive process restarts.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

interface SessionEntry {
  sessionId: string
  lastActive: string  // ISO 8601
}

let store: Record<string, SessionEntry> = {}
let savePath = './sessions.json'
let ttlMs = 7 * 24 * 60 * 60 * 1000

export function initSessions(path: string, ttl: number): void {
  savePath = path
  ttlMs = ttl
  load()
  // Clean expired sessions on load
  cleanup()
}

function load(): void {
  try {
    if (existsSync(savePath)) {
      store = JSON.parse(readFileSync(savePath, 'utf-8'))
    }
  } catch {
    store = {}
  }
}

function save(): void {
  const dir = dirname(savePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(savePath, JSON.stringify(store, null, 2))
}

function cleanup(): void {
  const now = Date.now()
  let changed = false
  for (const [chatId, entry] of Object.entries(store)) {
    const age = now - new Date(entry.lastActive).getTime()
    if (age > ttlMs) {
      delete store[chatId]
      changed = true
    }
  }
  if (changed) save()
}

export function getSessionId(chatId: string): string | undefined {
  const entry = store[chatId]
  if (!entry) return undefined
  // Check TTL
  const age = Date.now() - new Date(entry.lastActive).getTime()
  if (age > ttlMs) {
    delete store[chatId]
    save()
    return undefined
  }
  return entry.sessionId
}

export function setSessionId(chatId: string, sessionId: string): void {
  store[chatId] = {
    sessionId,
    lastActive: new Date().toISOString(),
  }
  save()
}

export function getAllSessions(): Record<string, SessionEntry> {
  return { ...store }
}
