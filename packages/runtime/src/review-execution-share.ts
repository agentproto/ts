/**
 * Run-scoped sharing of equivalent reviewer executions.
 *
 * Several lanes of one review run can resolve — through their own
 * `fallbackPresets` chains — to the SAME reviewer: same actual adapter /
 * model / auth profile, same rubric bytes, same effective frozen git range
 * (including a composed delta base) and same check options. Running that
 * reviewer once per lane pays for N identical reviews and records N verdicts
 * that look like independent agreement. This coordinator lets the first lane
 * (the OWNER) run the execution and every later lane that asks for the same
 * key (a JOINER) wait for it instead.
 *
 * What it does NOT do (those already exist elsewhere, and are not duplicated):
 * wallet / rate-limit cooldowns and the OpenRouter guard stay in
 * `review-reviewer-host.ts`; ledger composition stays in `review-compose.ts`;
 * cancellation stays the run's `AbortSignal`.
 *
 * Contract:
 *  - one coordinator per run (the lane executor builds it), so nothing is
 *    shared across runs; the owner/joiner decision is made synchronously, so
 *    concurrent acquires can never produce two owners;
 *  - the execution is bound by the OWNER's deadline (inside `execute`); a
 *    joiner never extends it and leaves with its own deadline if that is
 *    earlier;
 *  - the execution's abort signal fires only when EVERY participant has left
 *    (cancelled / hit its deadline), so cancelling the owner while joiners
 *    still wait does not kill their reviewer;
 *  - only a result `retain` accepts (a settled success) is kept for later
 *    lanes of the run; any other result is shared with the participants that
 *    were in flight and then forgotten, so a later lane retries for itself;
 *  - joiners and (when someone joined) the owner get a {@link SharedMark};
 *    lanes carrying one executionId are ONE reviewer's verdict.
 */

import { createHash } from "node:crypto"

/** Provenance of a shared execution — mirrors `LaneSharedExecution`. */
export interface SharedMark {
  executionId: string
  role: "owner" | "joiner"
  ownerLane: string
}

export type ShareOutcome<T> =
  | { kind: "value"; value: T; mark?: SharedMark }
  /** This participant stopped waiting (its signal aborted / its deadline
   *  passed). The execution itself keeps going while any participant remains. */
  | { kind: "left"; why: "cancelled" | "deadline"; mark?: SharedMark }

export interface ShareRunArgs<T> {
  /** Full equivalence key (caller-built; see `shareKeyOf`). */
  key: string
  laneId: string
  /** This participant's own cancel signal. */
  signal?: AbortSignal
  /** This participant's absolute deadline (epoch ms). Applied to JOINERS; the
   *  owner's `execute` enforces the owner's own deadline itself. */
  deadline: number
  /** Runs the work. Only called for the owner. `signal` aborts when every
   *  participant has left. */
  execute: (signal: AbortSignal) => Promise<T>
  /** Whether a settled value is kept for later lanes of the run. */
  retain: (value: T) => boolean
}

export interface ReviewExecutionShare {
  run<T>(args: ShareRunArgs<T>): Promise<ShareOutcome<T>>
  /** Executions currently running / settled-and-retained. */
  stats(): { inFlight: number; retained: number }
}

/** What the runner hands the reviewer host so its fallback steps can share. */
export interface ReviewerShareInput {
  coordinator: ReviewExecutionShare
  /** Run-scoped equivalence key (review id, rubric digest, effective range,
   *  check options). The host adds the resolved adapter/model/profile. */
  key: string
  laneId: string
}

export function shareKeyOf(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex")
}

interface Execution<T> {
  id: string
  ownerLane: string
  controller: AbortController
  refs: number
  joined: boolean
  done: boolean
  promise: Promise<T>
  retained?: { value: T }
}

export function createReviewExecutionShare(): ReviewExecutionShare {
  const executions = new Map<string, Execution<unknown>>()
  let seq = 0

  const forget = (key: string, exec: Execution<unknown>) => {
    if (executions.get(key) === exec) executions.delete(key)
  }

  const markOf = (exec: Execution<unknown>, role: SharedMark["role"]): SharedMark | undefined =>
    role === "joiner" || exec.joined ? { executionId: exec.id, role, ownerLane: exec.ownerLane } : undefined

  async function run<T>(args: ShareRunArgs<T>): Promise<ShareOutcome<T>> {
    const { key, laneId, signal } = args
    if (signal?.aborted) return { kind: "left", why: "cancelled" }

    const existing = executions.get(key) as Execution<T> | undefined
    if (existing?.retained) {
      return { kind: "value", value: existing.retained.value, mark: markOf(existing, "joiner")! }
    }

    let exec: Execution<T>
    let role: SharedMark["role"]
    if (existing) {
      exec = existing
      exec.refs++
      exec.joined = true
      role = "joiner"
    } else {
      role = "owner"
      const controller = new AbortController()
      exec = {
        id: `exec-${key.slice(0, 10)}-${++seq}`,
        ownerLane: laneId,
        controller,
        refs: 1,
        joined: false,
        done: false,
        promise: undefined as unknown as Promise<T>,
      }
      const started = exec
      executions.set(key, started as Execution<unknown>)
      started.promise = (async () => args.execute(controller.signal))().then(
        (value) => {
          started.done = true
          if (args.retain(value)) started.retained = { value }
          else forget(key, started)
          return value
        },
        (err: unknown) => {
          started.done = true
          forget(key, started)
          throw err
        },
      )
      started.promise.catch(() => undefined)
    }

    // The owner waits for its own (self-bounded) execution; a joiner also
    // stops at its own deadline.
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const leave = new Promise<"cancelled" | "deadline">((resolve) => {
      if (role === "joiner") timer = setTimeout(() => resolve("deadline"), Math.max(0, args.deadline - Date.now()))
      onAbort = () => resolve("cancelled")
      signal?.addEventListener("abort", onAbort, { once: true })
    })
    try {
      const first = await Promise.race([
        exec.promise.then((value) => ({ value }) as const),
        leave.then((why) => ({ why }) as const),
      ])
      if ("value" in first) return { kind: "value", value: first.value, mark: markOf(exec, role) }
      exec.refs--
      if (exec.refs === 0 && !exec.done) {
        forget(key, exec)
        exec.controller.abort()
        // The last participant out because of a cancel gets the execution's
        // own cancelled result (it names the killed reviewer session).
        const settled = await exec.promise.then((value) => ({ value }) as const, () => undefined)
        if (settled && first.why === "cancelled") return { kind: "value", value: settled.value, mark: markOf(exec, role) }
      }
      return { kind: "left", why: first.why, mark: markOf(exec, role) }
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort) signal?.removeEventListener("abort", onAbort)
    }
  }

  return {
    run,
    stats() {
      let inFlight = 0
      let retained = 0
      for (const e of executions.values()) e.retained ? retained++ : inFlight++
      return { inFlight, retained }
    },
  }
}
