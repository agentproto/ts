import { describe, expect, it } from "vitest"

import { resolveCronRunOk, type CronRunTriageRecord } from "../cron-run-triage.js"
import {
  classifyFollowEvent,
  DEFAULT_FOLLOW_TRIAGE_RULES,
  type TriageEvent,
  type TriageFacts,
} from "../follow-triage.js"

const EXIT_AT = "2026-10-05T00:05:00.000Z"
const JOB_ID = "cron_e89272da-fbd9-4c6d-9d6c-84825a829cfe"
const LABEL = `cron:${JOB_ID}`
const HOUR_MS = 60 * 60_000

const at = (offsetMs: number): string =>
  new Date(Date.parse(EXIT_AT) + offsetMs).toISOString()

function run(overrides: Partial<CronRunTriageRecord> = {}): CronRunTriageRecord {
  return {
    jobId: JOB_ID,
    ok: true,
    startedAt: "2026-10-05T00:03:00.000Z",
    endedAt: at(-1_000),
    ...overrides,
  }
}

function factsFor(runs: readonly CronRunTriageRecord[]): TriageFacts {
  return {
    cronOk: (sessionId, event?: TriageEvent) => {
      if (!event) throw new Error("the cron-ok provider now receives the exit event")
      return resolveCronRunOk({ runs, sessionId, label: event.label, at: event.ts })
    },
  }
}

function exited(sessionId: string, label?: string): TriageEvent {
  return {
    follower: "chief",
    event: "exited",
    sessionId,
    ts: EXIT_AT,
    ...(label ? { label } : {}),
  }
}

function classify(runs: readonly CronRunTriageRecord[], event: TriageEvent) {
  return classifyFollowEvent(event, DEFAULT_FOLLOW_TRIAGE_RULES, factsFor(runs))
}

describe("cron-ok triage for command crons", () => {
  it("drops when the job's run ended 1s after the exit and was ok", () => {
    const runs = [run({ ok: true, endedAt: at(1_000) })]
    expect(classify(runs, exited("sess_command", LABEL))).toEqual({
      decision: "drop",
      rule: "cron-ok",
    })
  })

  it("wakes when the nearest run failed, even with a stale ok run", () => {
    const runs = [
      run({ ok: false, endedAt: at(1_000) }),
      run({ ok: true, endedAt: at(-2 * HOUR_MS) }),
    ]
    expect(classify(runs, exited("sess_command", LABEL))).toEqual({
      decision: "wake",
      rule: "default",
    })
  })

  it("wakes when the only run is 2 hours old, outside the window", () => {
    const runs = [run({ ok: true, endedAt: at(-2 * HOUR_MS) })]
    expect(classify(runs, exited("sess_command", LABEL))).toEqual({
      decision: "wake",
      rule: "default",
    })
  })

  it("picks the nearest run, not just any earlier run", () => {
    const runs = [
      run({ ok: false, endedAt: at(1_000) }),
      run({ ok: true, endedAt: at(-50_000) }),
    ]
    expect(classify(runs, exited("sess_command", LABEL))).toEqual({
      decision: "wake",
      rule: "default",
    })
  })

  it("still matches a run by session id first", () => {
    const runs = [
      run({
        jobId: "cron_other",
        sessionId: "sess_agent",
        ok: true,
        endedAt: at(1_000),
      }),
      run({ ok: false, endedAt: at(1_000) }),
      run({ ok: true, endedAt: at(-2 * HOUR_MS) }),
    ]
    expect(classify(runs, exited("sess_agent", LABEL))).toEqual({
      decision: "drop",
      rule: "cron-ok",
    })
    expect(classify(runs, exited("sess_command", LABEL))).toEqual({
      decision: "wake",
      rule: "default",
    })
  })
})
