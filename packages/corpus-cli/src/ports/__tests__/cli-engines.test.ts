import { describe, it, expect } from "vitest"
import { CLI_ENGINES } from "../cli-engines.js"

describe("CLI_ENGINES registry", () => {
  it("registers claude-code + gemini + codex + opencode", () => {
    expect(Object.keys(CLI_ENGINES).sort()).toEqual([
      "claude-code",
      "codex",
      "gemini",
      "opencode",
    ])
  })

  it("every descriptor declares an id matching its registry key", () => {
    for (const [key, engine] of Object.entries(CLI_ENGINES)) {
      expect(engine.id).toBe(key)
      expect(engine.command).toBeTruthy()
    }
  })
})

describe("buildArgs — model injection", () => {
  it("claude-code: print + json envelope, --model only when given", () => {
    const e = CLI_ENGINES["claude-code"]!
    expect(e.buildArgs({})).toEqual(["-p", "--output-format", "json", "--strict-mcp-config"])
    expect(e.buildArgs({ model: "haiku" })).toContain("--model")
    expect(e.buildArgs({ model: "haiku" })).toContain("haiku")
  })

  it("gemini: bare when no model, -m <model> when given", () => {
    const e = CLI_ENGINES["gemini"]!
    expect(e.buildArgs({})).toEqual([])
    expect(e.buildArgs({ model: "gemini-2.5-pro" })).toEqual(["-m", "gemini-2.5-pro"])
  })

  it("codex: exec + stdin '-', -m <model> when given", () => {
    const e = CLI_ENGINES["codex"]!
    expect(e.buildArgs({})).toEqual(["exec", "-"])
    expect(e.buildArgs({ model: "gpt-5-codex" })).toEqual([
      "exec",
      "-m",
      "gpt-5-codex",
      "-",
    ])
  })

  it("opencode: run, -m <provider/model> when given", () => {
    const e = CLI_ENGINES["opencode"]!
    expect(e.buildArgs({})).toEqual(["run"])
    expect(e.buildArgs({ model: "anthropic/claude-haiku-4-5" })).toEqual([
      "run",
      "-m",
      "anthropic/claude-haiku-4-5",
    ])
  })
})

describe("parseOutput", () => {
  it("claude-code unwraps the JSON envelope's result", () => {
    const e = CLI_ENGINES["claude-code"]!
    const out = JSON.stringify({ result: "[]", is_error: false })
    expect(e.parseOutput(out)).toBe("[]")
  })

  it("plain-text engines strip ANSI and keep the JSON array text", () => {
    const esc = String.fromCharCode(27)
    const colored = `${esc}[32m[{"kind":"principle"}]${esc}[0m`
    for (const id of ["gemini", "codex", "opencode"]) {
      const cleaned = CLI_ENGINES[id]!.parseOutput(colored)
      expect(cleaned).toBe('[{"kind":"principle"}]')
    }
  })
})
