// Scheduled patrol/digest tasks
// Runs cron-like schedules per group to trigger proactive Agent queries.

import type { GroupConfig, ScheduleConfig, Settings } from './router.js'
import { queryAgent } from './agent.js'
import { sendReportCard } from './reply.js'
import { getSessionId, setSessionId } from './sessions.js'

interface ScheduledJob {
  timer: ReturnType<typeof setTimeout>
  group: GroupConfig
  schedule: ScheduleConfig
}

const jobs: ScheduledJob[] = []

// Parse cron minute/hour/dom/month/dow fields
// Simplified: only supports exact values, ranges (1-5), and * (any)
function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>()
  if (field === '*') {
    for (let i = min; i <= max; i++) values.add(i)
    return values
  }
  for (const part of field.split(',')) {
    const rangeMatch = part.match(/^(\d+)-(\d+)$/)
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10)
      const end = parseInt(rangeMatch[2], 10)
      for (let i = start; i <= end; i++) values.add(i)
    } else {
      values.add(parseInt(part, 10))
    }
  }
  return values
}

function getNextCronTime(cron: string): Date | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const minutes = parseCronField(parts[0], 0, 59)
  const hours = parseCronField(parts[1], 0, 23)
  const doms = parseCronField(parts[2], 1, 31)
  const months = parseCronField(parts[3], 1, 12)
  const dows = parseCronField(parts[4], 0, 6) // 0=Sunday

  const now = new Date()
  const candidate = new Date(now.getTime() + 60000) // start from next minute
  candidate.setSeconds(0, 0)

  // Search up to 7 days ahead
  for (let i = 0; i < 7 * 24 * 60; i++) {
    if (
      minutes.has(candidate.getMinutes()) &&
      hours.has(candidate.getHours()) &&
      doms.has(candidate.getDate()) &&
      months.has(candidate.getMonth() + 1) &&
      dows.has(candidate.getDay())
    ) {
      return candidate
    }
    candidate.setTime(candidate.getTime() + 60000)
  }

  return null
}

function scheduleJob(group: GroupConfig, schedule: ScheduleConfig, settings: Settings): void {
  const nextTime = getNextCronTime(schedule.cron)
  if (!nextTime) {
    console.error(`[patrol] Invalid cron expression for ${group.name}: ${schedule.cron}`)
    return
  }

  const delay = nextTime.getTime() - Date.now()
  console.error(`[patrol] ${group.name}: next run at ${nextTime.toISOString()} (in ${Math.round(delay / 60000)}min)`)

  const timer = setTimeout(async () => {
    await executePatrol(group, schedule, settings)
    // Re-schedule for next occurrence
    scheduleJob(group, schedule, settings)
  }, delay)

  jobs.push({ timer, group, schedule })
}

async function executePatrol(group: GroupConfig, schedule: ScheduleConfig, settings: Settings): Promise<void> {
  console.error(`[patrol] Executing patrol for ${group.name}: ${schedule.prompt.slice(0, 80)}...`)

  try {
    const sessionId = getSessionId(group.chatId)
    let resultText = ''
    let newSessionId: string | undefined

    const chunks = queryAgent({
      message: schedule.prompt,
      sessionId,
      persona: group.persona,
      cwd: group.cwd,
      permissionMode: 'default',
      model: settings.defaultModel,
    })

    for await (const chunk of chunks) {
      if (chunk.type === 'text') {
        resultText += chunk.content
      } else if (chunk.type === 'result') {
        newSessionId = chunk.sessionId
      }
    }

    if (resultText) {
      await sendReportCard(group.chatId, `Patrol: ${group.name}`, resultText)
    }

    if (newSessionId) {
      setSessionId(group.chatId, newSessionId)
    }
  } catch (err) {
    console.error(`[patrol] Error for ${group.name}: ${err}`)
  }
}

export function startPatrol(groups: GroupConfig[], settings: Settings): void {
  for (const group of groups) {
    for (const schedule of group.schedule) {
      scheduleJob(group, schedule, settings)
    }
  }
}

export function stopPatrol(): void {
  for (const job of jobs) {
    clearTimeout(job.timer)
  }
  jobs.length = 0
}
