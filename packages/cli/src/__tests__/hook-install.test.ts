import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { desktopMcpUrl, mergeDesktopSettings, runHookInstall } from "../commands/hook-install.js"
import { runHook } from "../commands/hook.js"

const inboxEntry = { hooks: [{ type: "command", command: "agentproto hook inbox" }] }

describe("mergeDesktopSettings", () => {
  it("adds the session env and both inbox hooks to an empty file", () => {
    const { settings, sessionId, changed } = mergeDesktopSettings({})
    expect(changed).toBe(true)
    expect(sessionId).toBe("claude-desktop")
    expect(settings).toEqual({
      env: { AGENTPROTO_SESSION_ID: "claude-desktop" },
      hooks: { UserPromptSubmit: [inboxEntry], PostToolUse: [inboxEntry] },
    })
  })

  it("is idempotent", () => {
    const first = mergeDesktopSettings({}, "desk-1")
    const second = mergeDesktopSettings(first.settings)
    expect(second.changed).toBe(false)
    expect(second.settings).toEqual(first.settings)
    expect(second.sessionId).toBe("desk-1")
  })

  it("keeps sibling keys, other hooks and other env vars", () => {
    const other = { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }
    const { settings } = mergeDesktopSettings({
      model: "opus",
      env: { FOO: "1" },
      hooks: { PostToolUse: [other], Stop: [other] },
    })
    expect(settings).toMatchObject({
      model: "opus",
      env: { FOO: "1", AGENTPROTO_SESSION_ID: "claude-desktop" },
      hooks: { PostToolUse: [other, inboxEntry], Stop: [other], UserPromptSubmit: [inboxEntry] },
    })
  })

  it("keeps an existing session id unless one is given", () => {
    const base = { env: { AGENTPROTO_SESSION_ID: "mine" } }
    expect(mergeDesktopSettings(base).sessionId).toBe("mine")
    expect(mergeDesktopSettings(base, "other").settings).toMatchObject({ env: { AGENTPROTO_SESSION_ID: "other" } })
  })
})

describe("desktopMcpUrl", () => {
  it("carries the session id and host", () => {
    expect(desktopMcpUrl("desk-1")).toBe("http://127.0.0.1:18790/mcp?callerSessionId=desk-1&host=claude-desktop")
    expect(desktopMcpUrl("desk-1", 9000)).toContain(":9000/mcp?")
  })
})

describe("hook install --host claude-desktop", () => {
  let dir: string
  let path: string
  let out: string
  let err: string
  const run = (args: string[]) =>
    runHookInstall(["--host", "claude-desktop", "--settings", path, ...args], {
      out: s => void (out += s),
      err: s => void (err += s),
    })
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hook-install-"))
    path = join(dir, "settings.json")
    out = ""
    err = ""
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("--dry-run prints the merged JSON and writes nothing", async () => {
    expect(await run(["--dry-run", "--session", "desk-1"])).toBe(0)
    expect(JSON.parse(out)).toMatchObject({ env: { AGENTPROTO_SESSION_ID: "desk-1" } })
    expect(err).toContain("callerSessionId=desk-1&host=claude-desktop")
    expect(existsSync(path)).toBe(false)
  })

  it("writes the file, then a second run changes nothing", async () => {
    writeFileSync(path, JSON.stringify({ model: "opus" }))
    expect(await run(["--session", "desk-1"])).toBe(0)
    const first = readFileSync(path, "utf8")
    expect(JSON.parse(first)).toMatchObject({ model: "opus", env: { AGENTPROTO_SESSION_ID: "desk-1" } })
    expect(out).toContain("Updated")
    expect(out).toContain('claude mcp add --transport http --scope user agentproto-desktop "http://127.0.0.1:18790/mcp?callerSessionId=desk-1&host=claude-desktop"')

    out = ""
    expect(await run([])).toBe(0)
    expect(readFileSync(path, "utf8")).toBe(first)
    expect(out).toContain("Already up to date")
  })

  it("leaves an unparseable file untouched and exits 1", async () => {
    writeFileSync(path, "{ not json")
    expect(await run([])).toBe(1)
    expect(readFileSync(path, "utf8")).toBe("{ not json")
  })

  it("rejects a missing or unsupported host, bad session id and bad port", async () => {
    const e = { out: () => undefined, err: () => undefined }
    expect(await runHookInstall(["--settings", path], e)).toBe(2)
    expect(await runHookInstall(["--host", "cursor", "--settings", path], e)).toBe(2)
    expect(await run(["--session", "bad id"])).toBe(2)
    expect(await run(["--port", "70000"])).toBe(2)
  })

  it("is reachable through runHook", async () => {
    expect(await runHook(["install", "--host", "claude-desktop", "--settings", path, "--dry-run"])).toBe(0)
  })
})
