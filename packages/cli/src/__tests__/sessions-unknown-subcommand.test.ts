import { afterEach, describe, expect, it, vi } from "vitest"
import {
  runSessions,
  suggestSessionsSubcommand,
  unknownSessionsSubcommandMessage,
} from "../commands/sessions.js"

async function run(args: string[]) {
  const err: string[] = []
  const out: string[] = []
  vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
    err.push(String(c))
    return true
  })
  vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
    out.push(String(c))
    return true
  })
  const code = await runSessions(args)
  return { code, err: err.join(""), out: out.join("") }
}

afterEach(() => vi.restoreAllMocks())

describe("sessions: unknown subcommand", () => {
  it("exits non-zero with a clear message and no stack for `sessions bogus`", async () => {
    const { code, err } = await run(["bogus", "ses_1"])
    expect(code).not.toBe(0)
    expect(err).toContain("unknown subcommand bogus")
    expect(err).toContain("valid subcommands:")
    expect(err).not.toMatch(/TypeError|ERR_PARSE_ARGS|\n\s+at /)
  })

  it("suggests `stop` for the near miss `stpo`", async () => {
    const { code, err } = await run(["stpo", "ses_1"])
    expect(code).not.toBe(0)
    expect(err).toContain("unknown subcommand stpo, did you mean stop?")
    expect(err).not.toMatch(/TypeError|ERR_PARSE_ARGS/)
  })

  it("suggests from synonyms and near misses", () => {
    expect(suggestSessionsSubcommand("rm")).toBe("stop")
    expect(suggestSessionsSubcommand("ls")).toBe("list")
    expect(suggestSessionsSubcommand("restar")).toBe("restart")
    expect(suggestSessionsSubcommand("zzzzzzzz")).toBeUndefined()
    expect(unknownSessionsSubcommandMessage("zzzzzzzz")).toContain("valid subcommands:")
  })
})

describe("sessions kill", () => {
  it("is routed to stop: same arg validation and messages", async () => {
    const stop = await run(["stop"])
    const kill = await run(["kill"])
    expect(kill.code).toBe(stop.code)
    expect(kill.code).toBe(2)
    expect(kill.err).toContain("missing session id")
    expect(kill.err).not.toContain("unknown subcommand")
  })

  it("accepts the stop flags", async () => {
    const { code, err } = await run(["kill", "ses_1", "--completed", "--outcome", "failed"])
    expect(code).toBe(2)
    expect(err).toContain("sessions stop:")
    expect(err).not.toContain("unknown subcommand")
  })
})
