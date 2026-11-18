import { describe, expect, it } from "vitest"
import { compactCommandNameFor, planSelfCommand } from "../session-self-command.js"

const allow = ["compact", "clear", "model"]
const adv = (...names: string[]) => names.map(name => ({ name }))

describe("planSelfCommand", () => {
  it("builds the verbatim slash text for an allowed command", () => {
    const p = planSelfCommand({ command: "compact", harness: "claude-code", allow, available: adv("compact", "clear") })
    expect(p).toEqual({ ok: true, name: "compact", args: "", text: "/compact" })
  })

  it("accepts a leading slash, any case, and carries one-line args", () => {
    const p = planSelfCommand({ command: "/Model", args: " claude-fable-5-2 ", harness: "claude-code", allow, available: undefined })
    expect(p).toMatchObject({ ok: true, text: "/model claude-fable-5-2" })
  })

  it("maps compact to the hermes spelling (compress)", () => {
    expect(compactCommandNameFor("hermes")).toBe("compress")
    const p = planSelfCommand({ command: "compact", harness: "hermes", allow: ["compress"], available: undefined })
    expect(p).toMatchObject({ ok: true, text: "/compress" })
  })

  it("refuses a command outside the manifest allow-list and lists the allowed ones", () => {
    const p = planSelfCommand({ command: "logout", harness: "codex", allow, available: adv("logout") })
    expect(p).toMatchObject({ ok: false, code: "command_not_allowed", allowed: allow })
    if (!p.ok) expect(p.message).toContain("/compact, /clear, /model")
  })

  it("refuses everything when the harness declares no self-commands", () => {
    const p = planSelfCommand({ command: "compact", harness: "gemini", allow: undefined, available: undefined })
    expect(p).toMatchObject({ ok: false, code: "no_self_commands" })
  })

  it("refuses an allowed command the live harness does not advertise", () => {
    const p = planSelfCommand({ command: "clear", harness: "claude-code", allow, available: adv("compact") })
    expect(p).toMatchObject({ ok: false, code: "command_not_available" })
  })

  it("does not require an advertised list when the harness advertised none", () => {
    expect(planSelfCommand({ command: "clear", harness: "claude-code", allow, available: [] })).toMatchObject({ ok: true })
  })

  it.each(["", "/", "a b", "../x", "rm -rf", "x;y", "1abc"])("rejects the bad name %j", cmd => {
    expect(planSelfCommand({ command: cmd, harness: "claude-code", allow, available: undefined })).toMatchObject({
      ok: false,
      code: "invalid_command",
    })
  })

  it("rejects multi-line or oversized args (no second command smuggled in)", () => {
    expect(
      planSelfCommand({ command: "model", args: "x\n/clear", harness: "claude-code", allow, available: undefined }),
    ).toMatchObject({ ok: false, code: "invalid_args" })
    expect(
      planSelfCommand({ command: "model", args: "x".repeat(501), harness: "claude-code", allow, available: undefined }),
    ).toMatchObject({ ok: false, code: "invalid_args" })
  })
})
