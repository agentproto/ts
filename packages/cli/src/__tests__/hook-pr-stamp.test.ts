import { describe, expect, it } from "vitest"
import { externalPrFooter, prUrlFromPayload, runPrStamp, type GhRun } from "../commands/hook-pr-stamp.js"

const URL = "https://github.com/agentproto/ts/pull/2447"
const payload = {
  session_id: "cc-123",
  cwd: "/repo",
  tool_name: "Bash",
  tool_input: { command: "gh pr create --title t --body-file /tmp/b.md" },
  tool_response: { stdout: `${URL}\n`, stderr: "" },
}

function fakeGh(body: string): { run: GhRun; edits: string[] } {
  const edits: string[] = []
  const run: GhRun = async args => {
    if (args[1] === "view") return { exitCode: 0, stdout: `${body}\n` }
    if (args[1] === "edit") edits.push(args[4] as string)
    return { exitCode: 0, stdout: "" }
  }
  return { run, edits }
}

describe("prUrlFromPayload", () => {
  it("finds the url of a gh pr create Bash call", () => {
    expect(prUrlFromPayload(payload)).toBe(URL)
  })
  it("ignores other commands and other tools", () => {
    expect(prUrlFromPayload({ ...payload, tool_input: { command: "gh pr view 2447" } })).toBeUndefined()
    expect(prUrlFromPayload({ ...payload, tool_name: "Read" })).toBeUndefined()
  })
  it("prefers the url on stdout over one elsewhere in the response", () => {
    const tool_response = { stderr: "see https://github.com/agentproto/ts/pull/1\n", stdout: `${URL}\n` }
    expect(prUrlFromPayload({ ...payload, tool_response })).toBe(URL)
  })
  it("falls back to the whole response when stdout carries no url", () => {
    expect(prUrlFromPayload({ ...payload, tool_response: `created ${URL}` })).toBe(URL)
    expect(prUrlFromPayload({ ...payload, tool_response: { stdout: "", output: URL } })).toBe(URL)
  })
})

describe("runPrStamp", () => {
  it("appends the footer once to a PR without one", async () => {
    const { run, edits } = fakeGh("Body.")
    expect(await runPrStamp(JSON.stringify(payload), { run, host: "mac", env: {} })).toBe(0)
    expect(edits).toHaveLength(1)
    expect(edits[0]).toMatch(/^Body\.\n\n---\n<sub>.*@agentproto-bot.*session `cc-123`.*host `mac`/)
  })
  it("leaves a PR that already has a footer", async () => {
    const { run, edits } = fakeGh(`Body.${externalPrFooter(payload, "mac")}`)
    await runPrStamp(JSON.stringify(payload), { run, host: "mac", env: {} })
    expect(edits).toEqual([])
  })
  it("skips a daemon-spawned session but not the desktop default id", async () => {
    const a = fakeGh("Body.")
    await runPrStamp(JSON.stringify(payload), { run: a.run, env: { AGENTPROTO_SESSION_ID: "sess_abc" } })
    expect(a.edits).toEqual([])
    const b = fakeGh("Body.")
    await runPrStamp(JSON.stringify(payload), { run: b.run, env: { AGENTPROTO_SESSION_ID: "claude-desktop" } })
    expect(b.edits).toHaveLength(1)
  })
  it("never throws on garbage input", async () => {
    expect(await runPrStamp("not json", { env: {} })).toBe(0)
  })
})
