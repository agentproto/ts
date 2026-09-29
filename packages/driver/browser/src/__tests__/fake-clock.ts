import type { SupervisorClock } from "../index.js"

interface Timer {
  at: number
  fn: () => void
  id: number
}

/** Manual clock: time only moves when a test calls `advance`. */
export class FakeClock implements SupervisorClock {
  private t = 0
  private seq = 0
  private timers: Timer[] = []

  now(): number {
    return this.t
  }

  setTimeout(fn: () => void, ms: number): unknown {
    this.seq += 1
    this.timers.push({ at: this.t + ms, fn, id: this.seq })
    return this.seq
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== handle)
  }

  pending(): number {
    return this.timers.length
  }

  async flush(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setImmediate(r))
  }

  /** Run every timer due within `ms`, in order, flushing microtasks between them. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms
    await this.flush()
    for (;;) {
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!due) break
      this.timers = this.timers.filter((x) => x !== due)
      this.t = Math.max(this.t, due.at)
      due.fn()
      await this.flush()
    }
    this.t = target
  }

  /** Advance time in `step` chunks until `p` settles (bounded, so a hung promise fails fast). */
  async settle<T>(p: Promise<T>, step = 1_000, maxSteps = 500): Promise<PromiseSettledResult<T>> {
    let out: PromiseSettledResult<T> | undefined
    void p.then(
      (value) => {
        out = { status: "fulfilled", value }
      },
      (reason: unknown) => {
        out = { status: "rejected", reason }
      },
    )
    for (let i = 0; i < maxSteps && !out; i += 1) await this.advance(step)
    if (!out) throw new Error("promise did not settle within the fake-clock budget")
    return out
  }
}
