import { describe, it, expect } from "vitest"
import { CLI_ENGINES } from "../cli-engines.js"

describe("CLI_ENGINES registry", () => {
  it("registers claude-code + gemini + codex + opencode + hermes", () => {
    expect(Object.keys(CLI_ENGINES).sort()).toEqual([
      "claude-code",
      "codex",
      "gemini",
      "hermes",
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

  it("codex: exec + skip-git-repo-check + json + stdin '-', -m <model> when given", () => {
    const e = CLI_ENGINES["codex"]!
    expect(e.buildArgs({})).toEqual([
      "exec",
      "--skip-git-repo-check",
      "--json",
      "-",
    ])
    expect(e.buildArgs({ model: "gpt-5-codex" })).toEqual([
      "exec",
      "--skip-git-repo-check",
      "--json",
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

  it("hermes: --oneshot <prompt>, -m <model> when given — uses arg not stdin", () => {
    const e = CLI_ENGINES["hermes"]!
    const p = "the distill prompt text"
    expect(e.buildArgs({ prompt: p })).toEqual(["--oneshot", p])
    expect(e.buildArgs({ prompt: p, model: "claude-haiku-4-5" })).toEqual([
      "--oneshot", p, "-m", "claude-haiku-4-5",
    ])
    // Empty prompt when none provided (avoids crashing CliAgentDistiller test harness)
    expect(e.buildArgs({})).toEqual(["--oneshot", ""])
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
    for (const id of ["gemini", "opencode", "hermes"]) {
      const cleaned = CLI_ENGINES[id]!.parseOutput(colored)
      expect(cleaned).toBe('[{"kind":"principle"}]')
    }
  })

  it("codex unwraps the agent_message from its JSONL event stream", () => {
    const e = CLI_ENGINES["codex"]!
    const jsonl = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"[{\\"kind\\":\\"principle\\"}]"}}',
      '{"type":"turn.completed"}',
    ].join("\n")
    expect(e.parseOutput(jsonl)).toBe('[{"kind":"principle"}]')
    // older shape
    expect(
      e.parseOutput('{"type":"agent_message","message":"hi"}')
    ).toBe("hi")
    // no message line → null (falls back to raw stdout)
    expect(e.parseOutput('{"type":"turn.started"}')).toBeNull()
  })
})
