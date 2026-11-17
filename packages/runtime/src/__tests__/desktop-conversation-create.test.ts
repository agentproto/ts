import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCodexConversation, registerDesktopConversationCreateTool } from "../desktop-conversations.js"

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "desktop-create-"))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

/** A fake `codex` CLI: records argv and stdin, then prints the given JSONL (or hangs). */
async function fakeCodex(events: object[], opts: { hang?: boolean } = {}) {
  const bin = join(root, "codex")
  const log = join(root, "call.json")
  await writeFile(
    bin,
    `#!/usr/bin/env node
const fs = require("fs")
let stdin = ""
process.stdin.on("data", d => (stdin += d))
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin }))
  for (const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e))
  ${opts.hang ? "setInterval(() => {}, 1000)" : ""}
})
`,
  )
  await chmod(bin, 0o755)
  return { bin, called: async () => JSON.parse(await (await import("node:fs/promises")).readFile(log, "utf8")) }
}

const TID = "01a1eb95-2b47-75c1-b260-86f148899358"

describe("createCodexConversation", () => {
  it("runs codex exec read-only in cwd, feeds the prompt on stdin and returns the thread and its answer", async () => {
    const f = await fakeCodex([
      { type: "thread.started", thread_id: TID },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "i", type: "agent_message", text: "bonjour" } },
      { type: "turn.completed" },
    ])
    const r = await createCodexConversation({ cwd: root, prompt: "salut", codexBin: f.bin, model: "m1" })
    expect(r).toMatchObject({ threadId: TID, externalId: `codex:${TID}`, status: "completed", reply: "bonjour" })
    expect((await f.called()).argv).toEqual(["exec", "--json", "--skip-git-repo-check", "-s", "read-only", "-m", "m1", "-C", root, "-"])
    expect((await f.called()).stdin).toBe("salut")
  })

  it("reports a failed first turn with the thread id, not a success", async () => {
    const f = await fakeCodex([
      { type: "thread.started", thread_id: TID },
      { type: "turn.started" },
      { type: "turn.failed", error: { message: "model_not_found" } },
    ])
    const r = await createCodexConversation({ cwd: root, prompt: "x", codexBin: f.bin })
    expect(r).toMatchObject({ threadId: TID, status: "failed", reply: null, error: "model_not_found" })
  })

  it("stops a first turn that never ends and says so", async () => {
    const f = await fakeCodex([{ type: "thread.started", thread_id: TID }], { hang: true })
    const r = await createCodexConversation({ cwd: root, prompt: "x", codexBin: f.bin, timeoutMs: 1_000 })
    expect(r).toMatchObject({ threadId: TID, status: "timeout" })
    expect(r.note).toMatch(/did not end within 1000 ms/)
  })

  it("rejects a relative or missing cwd and a missing binary", async () => {
    await expect(createCodexConversation({ cwd: "rel", prompt: "x" })).rejects.toThrow(/absolute/)
    await expect(createCodexConversation({ cwd: join(root, "nope"), prompt: "x" })).rejects.toThrow(/not a directory/)
    const r = await createCodexConversation({ cwd: root, prompt: "x", codexBin: join(root, "absent") })
    expect(r).toMatchObject({ status: "failed", threadId: null })
  })
})

describe("timeout kills the child for real", () => {
  it("sends SIGTERM, then SIGKILL after the grace period, and returns only once the child closed", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: { end: () => {} },
      stdout: new EventEmitter(),
      kill: vi.fn((sig: string) => {
        // an agent that ignores SIGTERM and dies on SIGKILL
        if (sig === "SIGKILL") setTimeout(() => child.emit("close", null), 5)
        return true
      }),
    })
    const t0 = Date.now()
    const r = await createCodexConversation({
      cwd: root,
      prompt: "x",
      timeoutMs: 1_000,
      killGraceMs: 50,
      spawnFn: (() => child) as any,
    })
    expect(child.kill.mock.calls.map(c => c[0])).toEqual(["SIGTERM", "SIGKILL"])
    expect(r.status).toBe("timeout")
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_050)
  })

  it.each([-1, Number.NaN])(
    "falls back to the default grace (not an instant SIGKILL) for killGraceMs %s",
    async bad => {
      const child = Object.assign(new EventEmitter(), {
        stdin: { end: () => {} },
        stdout: new EventEmitter(),
        kill: vi.fn((_sig: string) => true),
      })
      const p = createCodexConversation({
        cwd: root,
        prompt: "x",
        timeoutMs: 1_000,
        killGraceMs: bad,
        spawnFn: (() => child) as any,
      })
      // Past the timeout by a small margin: only SIGTERM must have been sent.
      // A raw setTimeout with a negative/NaN delay would fire at once and put
      // SIGKILL in this list.
      await new Promise(r => setTimeout(r, 1_100))
      expect(child.kill.mock.calls.map(c => c[0])).toEqual(["SIGTERM"])
      child.emit("close", null)
      expect((await p).status).toBe("timeout")
    },
    10_000
  )
})

describe("the registered tool", () => {
  async function call(events: object[]) {
    const f = await fakeCodex(events)
    // the tool spawns plain `codex`: put the fake first on PATH
    vi.stubEnv("PATH", `${root}:${process.env.PATH}`)
    void f
    const server = new McpServer({ name: "t", version: "0" })
    registerDesktopConversationCreateTool(server)
    const [c, sv] = InMemoryTransport.createLinkedPair()
    await server.connect(sv)
    const client = new Client({ name: "c", version: "0" })
    await client.connect(c)
    try {
      return (await client.callTool({ name: "desktop_conversation_create", arguments: { app: "codex", cwd: root, prompt: "x" } })) as {
        isError?: boolean
        content: Array<{ text: string }>
      }
    } finally {
      await client.close()
      await server.close()
    }
  }

  it("flags a failed creation as an error result, like ask does, and a completed one as success", async () => {
    const failed = await call([{ type: "thread.started", thread_id: TID }, { type: "turn.failed", error: { message: "boom" } }])
    expect(failed.isError).toBe(true)
    expect(JSON.parse(failed.content[0]!.text)).toMatchObject({ status: "failed", threadId: TID })
    const ok = await call([{ type: "thread.started", thread_id: TID }, { type: "turn.completed" }])
    expect(ok.isError).toBeFalsy()
  })
})
