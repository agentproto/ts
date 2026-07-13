/**
 * `agentproto run --output-schema`.
 *
 * Pins the structured-output loop: on a schema-matching final answer stdout is
 * EXACTLY the validated JSON (compact) and nothing else; on a mismatch the turn
 * is re-prompted with the errors and succeeds on retry; after the retry budget
 * is spent the verb exits non-zero. Also pins arg validation (bad schema →
 * exit 2, no session) and the `--json` incompatibility. Mocks the driver the
 * same way run-model.test.ts does — no real model/network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

type Ev =
  | { kind: "text-delta"; sessionId: string; text: string }
  | { kind: "turn-end"; sessionId: string; reason: "completed" | "error" }

/** Each element scripts one turn's event stream, consumed in order by send(). */
let turns: Ev[][] = []
const sentPrompts: string[] = []

function fakeSession() {
  let turn = 0
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *send(prompt: string) {
      sentPrompts.push(prompt)
      const events = turns[turn] ?? []
      turn += 1
      for (const ev of events) yield ev
    },
    async close() {},
  }
}

const startSpy = vi.fn()

vi.mock("@agentproto/driver-agent-cli", () => ({
  createAgentCliRuntime: () => ({
    definition: { id: "fake" },
    start: () => startSpy(),
  }),
}))

vi.mock("../registry/resolve.js", () => ({
  resolveAdapter: vi.fn(async () => ({ handle: { id: "fake", bin: "fake" } })),
}))

vi.mock("../util/stdin.js", () => ({
  readStdinIfPiped: vi.fn(async () => null),
}))

const { runRun } = await import("../commands/run.js")

const SCHEMA =
  '{"type":"object","required":["passed"],' +
  '"properties":{"passed":{"type":"boolean"}},"additionalProperties":false}'

function td(text: string): Ev {
  return { kind: "text-delta", sessionId: "s", text }
}
const done: Ev = { kind: "turn-end", sessionId: "s", reason: "completed" }

let stdout: string[]
let stderr: string[]
let outSpy: ReturnType<typeof vi.spyOn>
let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  turns = []
  sentPrompts.length = 0
  startSpy.mockReset()
  startSpy.mockResolvedValue(fakeSession())
  stdout = []
  stderr = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  outSpy = vi.spyOn(process.stdout as any, "write").mockImplementation((c: unknown) => {
    stdout.push(String(c))
    return true
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  errSpy = vi.spyOn(process.stderr as any, "write").mockImplementation((c: unknown) => {
    stderr.push(String(c))
    return true
  })
})

afterEach(() => {
  outSpy.mockRestore()
  errSpy.mockRestore()
})

describe("agentproto run — --output-schema", () => {
  it("prints ONLY the validated JSON on stdout for a matching answer", async () => {
    turns = [[td('```json\n{"passed":true}\n```'), done]]
    const code = await runRun([
      "claude-code",
      "-p",
      "did tests pass?",
      "--output-schema",
      SCHEMA,
    ])
    expect(code).toBe(0)
    expect(stdout.join("")).toBe('{"passed":true}\n')
    // The schema instruction rode along on the first prompt.
    expect(sentPrompts[0]).toContain("did tests pass?")
    expect(sentPrompts[0]).toContain("JSON Schema")
  })

  it("re-prompts on a mismatch and succeeds on retry", async () => {
    turns = [
      [td('{"passed":"yes"}'), done], // wrong type
      [td('{"passed":false}'), done], // corrected
    ]
    const code = await runRun([
      "claude-code",
      "-p",
      "q",
      "--output-schema",
      SCHEMA,
    ])
    expect(code).toBe(0)
    expect(stdout.join("")).toBe('{"passed":false}\n')
    expect(sentPrompts).toHaveLength(2)
    expect(sentPrompts[1]).toContain("did not match")
    expect(stderr.join("")).toContain("attempt 1/3")
  })

  it("exits 1 after the retry budget is exhausted", async () => {
    turns = [
      [td("garbage"), done],
      [td("still garbage"), done],
      [td("nope"), done],
    ]
    const code = await runRun([
      "claude-code",
      "-p",
      "q",
      "--output-schema",
      SCHEMA,
    ])
    expect(code).toBe(1)
    expect(stdout.join("")).toBe("") // stdout stays clean on failure
    expect(sentPrompts).toHaveLength(3) // initial + 2 retries
    expect(stderr.join("")).toMatch(/did not match schema after 3 attempts/)
  })

  it("rejects an unusable schema with exit 2 and never spawns", async () => {
    const code = await runRun([
      "claude-code",
      "-p",
      "q",
      "--output-schema",
      "{not json}",
    ])
    expect(code).toBe(2)
    expect(startSpy).not.toHaveBeenCalled()
    expect(stderr.join("")).toContain("--output-schema")
  })

  it("rejects --output-schema combined with --json", async () => {
    const code = await runRun([
      "claude-code",
      "-p",
      "q",
      "--json",
      "--output-schema",
      SCHEMA,
    ])
    expect(code).toBe(2)
    expect(startSpy).not.toHaveBeenCalled()
    expect(stderr.join("")).toContain("cannot be combined with --json")
  })
})
