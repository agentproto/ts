/**
 * `agentproto steward` argument parsing (sub-command → workflow input) and
 * the custom rules file loader.
 */

import { describe, it, expect } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadStewardRules, parseStewardArgs, STEWARD_ACTIONS } from "../commands/steward.js"

const ok = (args: string[], env: NodeJS.ProcessEnv = {}) => {
  const r = parseStewardArgs(args, env)
  if (!r.ok) throw new Error(r.error)
  return r.value
}

describe("parseStewardArgs", () => {
  it("bare steward = classify, waiting, no mutation", () => {
    expect(ok([])).toEqual({ sub: "classify", input: {}, llm: false, wait: true, json: false })
  })

  it("--apply on classify is the one-shot (classify + act)", () => {
    const v = ok(["--apply", "--idle", "45", "--min-confidence", "0.9"])
    expect(v.sub).toBe("classify")
    expect(v.input).toEqual({ apply: true, idleMinutes: 45, minConfidence: 0.9 })
  })

  it("act takes a snapshot id (default latest) and its selectors", () => {
    expect(ok(["act"]).input).toEqual({ snapshot: "latest" })
    const v = ok(["act", "snap_1", "--apply", "--only", "mark-failed,needs-input", "--session", "a,b", "--session", "c", "--allow-relaunch"])
    expect(v.sub).toBe("act")
    expect(v.input).toEqual({
      snapshot: "snap_1",
      apply: true,
      only: ["mark-failed", "needs-input"],
      sessions: ["a", "b", "c"],
      allowRelaunch: true,
    })
  })

  it("--relaunch-window maps to relaunchWindowMinutes and rejects bad values", () => {
    expect(ok(["--relaunch-window", "90"]).input).toEqual({ relaunchWindowMinutes: 90 })
    expect(ok(["--relaunch-window", "0"]).input).toEqual({ relaunchWindowMinutes: 0 })
    expect(parseStewardArgs(["--relaunch-window", "-1"])).toMatchObject({ ok: false })
    expect(parseStewardArgs(["--relaunch-window", "soon"])).toMatchObject({ ok: false })
  })

  it("analyze maps judge / max-sessions / selectors", () => {
    const v = ok(["analyze", "latest", "--judge", "jev", "--max-sessions", "5", "--only", "relaunch"])
    expect(v.sub).toBe("analyze")
    expect(v.input).toEqual({ snapshot: "latest", judge: "jev", maxSessions: 5, only: ["relaunch"] })
  })

  it("classify --llm queues an analyze of the fresh snapshot", () => {
    const v = ok(["classify", "--llm", "--only", "mark-failed", "--json"])
    expect(v.llm).toBe(true)
    expect(v.analyzeInput).toMatchObject({ snapshot: "latest", only: ["mark-failed"], returnSnapshot: true })
  })

  it("--json asks the workflow to return the snapshot", () => {
    expect(ok(["--json"]).input).toEqual({ returnSnapshot: true })
    expect(ok(["act", "--json"]).input).toEqual({ snapshot: "latest" })
  })

  it("--legacy / --ask-sessions select the original workflow and keep its flags", () => {
    const v = ok(["--legacy", "--apply", "--judge", "agent", "--wait"])
    expect(v).toMatchObject({ sub: "legacy", wait: true, input: { apply: true, askSessions: false, judge: "agent" } })
    expect(ok(["--ask-sessions"]).sub).toBe("legacy")
    expect(ok(["--legacy"]).wait).toBe(false)
  })

  it("--no-wait detaches", () => {
    expect(ok(["--no-wait"]).wait).toBe(false)
  })

  it("passes the calling session as callerSessionId", () => {
    expect(ok([], { AGENTPROTO_SESSION_ID: "sess_me" }).input["callerSessionId"]).toBe("sess_me")
  })

  it("accepts every action of the closed vocabulary in --only", () => {
    expect(ok(["act", "--only", STEWARD_ACTIONS.join(",")]).input["only"]).toEqual([...STEWARD_ACTIONS])
  })

  it("rejects bad values, unknown flags and misplaced positionals", () => {
    for (const args of [
      ["--idle", "0"],
      ["--idle", "abc"],
      ["--min-confidence", "1.5"],
      ["--judge", "gpt"],
      ["analyze", "--judge", "auto"],
      ["act", "--only", "explode"],
      ["analyze", "--max-sessions", "0"],
      ["act", "--llm"],
      ["--wait", "--no-wait"],
      ["--bogus"],
      ["positional"],
      ["classify", "snap_1"],
      ["act", "a", "b"],
    ]) {
      expect(parseStewardArgs(args, {}).ok, args.join(" ")).toBe(false)
    }
  })
})

describe("loadStewardRules", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "steward-rules-"))

  it("is fine with no file (defaults apply)", () => {
    expect(loadStewardRules(undefined, { cwd: dir(), home: dir() })).toEqual({ ok: true })
  })

  it("auto-loads ./.agentproto/steward-rules.yaml, project before home", () => {
    const cwd = dir()
    const home = dir()
    mkdirSync(join(cwd, ".agentproto"))
    mkdirSync(join(home, ".agentproto"))
    writeFileSync(join(home, ".agentproto", "steward-rules.yaml"), "version: 1\nrules: []\n")
    expect(loadStewardRules(undefined, { cwd, home })).toMatchObject({ ok: true, source: join(home, ".agentproto", "steward-rules.yaml") })
    writeFileSync(join(cwd, ".agentproto", "steward-rules.yaml"), "version: 1\nrules:\n  - id: a\n    when: { origin: review }\n    action: skip\n")
    const r = loadStewardRules(undefined, { cwd, home })
    expect(r).toMatchObject({ ok: true, source: join(cwd, ".agentproto", "steward-rules.yaml") })
    expect((r as { rules: { rules: unknown[] } }).rules.rules).toHaveLength(1)
  })

  it("reads YAML and JSON from an explicit path", () => {
    const cwd = dir()
    writeFileSync(join(cwd, "r.json"), JSON.stringify({ version: 1, rules: [{ id: "j", action: "skip", when: {} }] }))
    writeFileSync(join(cwd, "r.yml"), "- id: y\n  action: skip\n  when: { label: 'bench-*' }\n")
    expect(loadStewardRules("r.json", { cwd })).toMatchObject({ ok: true, rules: { version: 1 } })
    const y = loadStewardRules("r.yml", { cwd })
    expect(y).toMatchObject({ ok: true })
    expect((y as { rules: { version: number; rules: unknown[] } }).rules).toMatchObject({ version: 1, rules: [{ id: "y" }] })
  })

  it("reports an unreadable or malformed file", () => {
    const cwd = dir()
    writeFileSync(join(cwd, "bad.json"), "{nope")
    writeFileSync(join(cwd, "bad.yaml"), "a: [unclosed\n")
    writeFileSync(join(cwd, "scalar.yaml"), "just text\n")
    for (const f of ["missing.yaml", "bad.json", "bad.yaml", "scalar.yaml"]) {
      expect(loadStewardRules(f, { cwd }).ok, f).toBe(false)
    }
  })
})
