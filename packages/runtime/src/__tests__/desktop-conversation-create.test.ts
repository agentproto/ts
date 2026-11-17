import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCodexConversation } from "../desktop-conversations.js"

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "desktop-create-"))
})
afterEach(async () => {
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
