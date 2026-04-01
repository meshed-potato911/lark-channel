// Per-group async message queue
// Messages within the same group are processed serially.
// Different groups process in parallel.

type Task = () => Promise<void>

class GroupQueue {
  private pending: Array<{ task: Task; resolve: () => void; reject: (e: unknown) => void }> = []
  private running = false

  async enqueue(task: Task): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ task, resolve, reject })
      this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    while (this.pending.length > 0) {
      const item = this.pending.shift()!
      try {
        await item.task()
        item.resolve()
      } catch (e) {
        item.reject(e)
      }
    }
    this.running = false
  }

  get size(): number {
    return this.pending.length + (this.running ? 1 : 0)
  }
}

const queues = new Map<string, GroupQueue>()

export function getQueue(chatId: string): GroupQueue {
  let q = queues.get(chatId)
  if (!q) {
    q = new GroupQueue()
    queues.set(chatId, q)
  }
  return q
}

export function getQueueStats(): Record<string, number> {
  const stats: Record<string, number> = {}
  for (const [chatId, q] of queues) {
    stats[chatId] = q.size
  }
  return stats
}
