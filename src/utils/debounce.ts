export class DebounceMap {
  private readonly timers = new Map<string, NodeJS.Timeout>()

  schedule(key: string, delayMs: number, fn: () => void): void {
    this.clear(key)
    const timer = setTimeout(() => {
      this.timers.delete(key)
      fn()
    }, delayMs)
    this.timers.set(key, timer)
  }

  clear(key: string): void {
    const timer = this.timers.get(key)
    if (!timer) return
    clearTimeout(timer)
    this.timers.delete(key)
  }

  clearAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
  }
}
