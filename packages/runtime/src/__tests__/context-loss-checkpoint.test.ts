/**
 * Every path that discards conversation context writes a checkpoint FIRST,
 * and a session that reserves compaction to its operator refuses one from
 * any other session. Exercised against a REAL registry (real transcript
 * writer, real checkpoint builder, real files on disk) driving a fake
 * harness that behaves like claude-code: it takes `/compact` as a prompt,
 * advertises a `compact` mode, answers the daemon's handoff question with
 * JSON, and — the point — looks at the checkpoint directory at the instant
 * the cut reaches it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionsRegistry,
} from "../sessions.js"
import { registerSessionTools } from "../session-tools.js"
import { CONTEXT_CONTINUITY_DEFAULTS, type ResolvedContextContinuityPolicy } from "../context-continuity.js"
import { HANDOFF_PROMPT_OPENER } from "../handoff-markers.js"
import { sessionTranscriptDir } from "../transcript-writer.js"
import type { ContextCheckpoint } from "../context-checkpoint.js"

const HANDOFF_REPLY = JSON.stringify({
  goal: "pick the storage engine",
  decisions: ["Use Postgres, not SQLite: we need concurrent writers"],
  tests: { command: "", result: "" },
  openRisks: ["the migration is untested"],
  nextStep: "run the migration on staging",
})

interface FakeHarness extends AgentSessionLike {
  /** Everything the harness was asked, in order. */
  prompts: string[]
  /** Checkpoint files on disk when `/compact` reached the harness. */
  checkpointsAtCompact?: string[]
  /** Checkpoint files on disk when the runtime switched it to compact mode. */
  checkpointsAtModeSwitch?: string[]
  modeSwitches: string[]
}

/** The runtime hands the harness a string or an ACP content block (array). */
function promptText(message: unknown): string {
  const blocks = Array.isArray(message) ? message : [message]
  return blocks
    .map(b => (typeof b === "string" ? b : ((b as { text?: string } | undefined)?.text ?? "")))
    .join("")
}

/** `used` is the context fill the harness reports after each ordinary turn. */
function fakeHarness(sessionDir: () => string, used: number): FakeHarness {
  const listCheckpoints = (): string[] => {
    try {
      return readdirSync(join(sessionDir(), "checkpoints"))
    } catch {
      return []
    }
  }
  const harness: FakeHarness = {
    sessionId: "acp-fake",
    prompts: [],
    modeSwitches: [],
    availableModes: [{ id: "compact", name: "Compact" }],
    async *send(message): AsyncIterable<AgentStreamEvent> {
      const text = promptText(message)
      harness.prompts.push(text)
      if (text.startsWith("/compact")) {
        harness.checkpointsAtCompact = listCheckpoints()
        yield { kind: "usage_update", size: 100, used: 10 }
        yield { kind: "text-delta", text: "Conversation compacted." }
      } else if (text.includes(HANDOFF_PROMPT_OPENER)) {
        yield { kind: "text-delta", text: HANDOFF_REPLY }
        yield { kind: "usage_update", size: 100, used }
      } else {
        yield { kind: "text-delta", text: "Noted: we are going with Postgres." }
        yield { kind: "usage_update", size: 100, used }
      }
      yield { kind: "turn-end" }
    },
    async cancel() {},
    async close() {},
    async setSessionMode(modeId: string) {
      harness.modeSwitches.push(modeId)
      harness.checkpointsAtModeSwitch = listCheckpoints()
      return { applied: true, modeId }
    },
  }
  return harness
}

const policy = (over: Partial<ResolvedContextContinuityPolicy>): ResolvedContextContinuityPolicy => ({
  ...CONTEXT_CONTINUITY_DEFAULTS,
  label: "t",
  ...over,
})

describe("context-losing paths checkpoint first", () => {
  let tmp: string
  let reg: SessionsRegistry

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ctx-loss-"))
    reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
  })
  afterEach(async () => {
    reg.shutdown()
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  const dirOf = (id: string): string => sessionTranscriptDir(id, tmp)
  const checkpointDir = (id: string): string => join(dirOf(id), "checkpoints")
  const readCheckpoint = (id: string, file: string): ContextCheckpoint =>
    JSON.parse(readFileSync(join(checkpointDir(id), file), "utf8")) as ContextCheckpoint
  const outputOf = (id: string): string[] => {
    const lines: string[] = []
    reg.attach(id, line => lines.push(line))?.()
    return lines
  }
  /** Make checkpoint persistence fail for real: a regular file where the directory must go. */
  const breakCheckpointDir = (id: string): void => {
    mkdirSync(dirOf(id), { recursive: true })
    writeFileSync(checkpointDir(id), "not a directory")
  }

  function spawn(used: number, p: Partial<ResolvedContextContinuityPolicy>) {
    let id = ""
    const harness = fakeHarness(() => dirOf(id), used)
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: harness,
      adapterSlug: "fake",
      contextContinuity: policy(p),
    })
    id = desc.id
    return { id, harness }
  }

  describe("a /compact prompt", () => {
    it("is preceded by a checkpoint carrying the session's own decisions", async () => {
      const { id, harness } = spawn(40, { mode: "manual" })
      await reg.sendPrompt(id, "Let's decide which database we use")
      expect(readdirSync(dirOf(id))).not.toContain("checkpoints")

      await reg.sendPrompt(id, "/compact")

      // On disk at the instant the cut reached the harness — not after.
      expect(harness.checkpointsAtCompact).toHaveLength(1)
      const ckpt = readCheckpoint(id, harness.checkpointsAtCompact![0]!)
      expect(ckpt.sourceSessionId).toBe(id)
      expect(ckpt.handoffTurn?.status).toBe("answered")
      expect(ckpt.sections.decisions).toContain("Postgres")
      expect(ckpt.sections.risks).toContain("migration is untested")
      expect(ckpt.recentDigest).toContain("decide which database")
      // handoff question first, compaction last
      expect(harness.prompts.at(-1)).toBe("/compact")
      expect(harness.prompts.some(p => p.includes(HANDOFF_PROMPT_OPENER))).toBe(true)
    })

    it("is refused, never sent, when no checkpoint can be written", async () => {
      const { id, harness } = spawn(40, { mode: "manual" })
      await reg.sendPrompt(id, "Let's decide which database we use")
      breakCheckpointDir(id)

      await expect(reg.sendPrompt(id, "/compact")).rejects.toThrow(/no checkpoint could be written/)

      expect(harness.prompts.some(p => p.startsWith("/compact"))).toBe(false)
      expect(reg.get(id)?.status).toBe("running")
      expect(reg.get(id)?.busy).toBe(false)
    })

    it("also guards /compress and a compaction hidden in a content block", async () => {
      const { id, harness } = spawn(40, { mode: "manual" })
      breakCheckpointDir(id)
      await expect(reg.sendPrompt(id, "  /compress now")).rejects.toThrow(/no checkpoint/)
      await expect(reg.sendPrompt(id, [{ type: "text", text: "/compact" }])).rejects.toThrow(/no checkpoint/)
      expect(harness.prompts.some(p => /^\/(compact|compress)/.test(p))).toBe(false)
    })

    it("does not touch ordinary prompts that merely mention compaction", async () => {
      const { id, harness } = spawn(40, { mode: "manual" })
      await reg.sendPrompt(id, "please /compact nothing, this is just prose")
      await reg.sendPrompt(id, "what does /compact do?")
      expect(harness.prompts).toHaveLength(2)
      expect(readdirSync(dirOf(id))).not.toContain("checkpoints")
    })
  })

  describe("a session that reserves compaction to the operator", () => {
    it("takes /compact from the operator, with a checkpoint first", async () => {
      const { id, harness } = spawn(40, { mode: "manual", compactRequiresOperator: true })
      await reg.sendPrompt(id, "Let's decide which database we use")
      await reg.sendPrompt(id, "/compact") // source-less: HTTP / CLI / UI
      expect(harness.checkpointsAtCompact).toHaveLength(1)
    })

    it("refuses /compact from a session — itself included — on every prompt path", async () => {
      const { id, harness } = spawn(40, { mode: "manual", compactRequiresOperator: true })
      await reg.sendPrompt(id, "Let's decide which database we use")
      const before = harness.prompts.length

      for (const source of [`agent:${id}`, "agent:sess_other"]) {
        await expect(reg.sendPrompt(id, "/compact", { source })).rejects.toThrow(/operator's agreement/)
        await expect(reg.enqueuePrompt(id, "/compact", { source })).rejects.toThrow(/operator's agreement/)
        await expect(
          reg.enqueuePrompt(id, "/compact focus on the db", { source, queue: true }),
        ).rejects.toThrow(/operator's agreement/)
      }

      expect(harness.prompts).toHaveLength(before)
      expect(readdirSync(dirOf(id))).not.toContain("checkpoints")
      expect(reg.get(id)?.status).toBe("running")
      expect(reg.get(id)?.promptQueue ?? []).toEqual([])
    })

    it("still accepts ordinary prompts from other sessions", async () => {
      const { id, harness } = spawn(40, { mode: "manual", compactRequiresOperator: true })
      await reg.sendPrompt(id, "carry on", { source: "agent:sess_other" })
      expect(harness.prompts).toContain("carry on")
    })

    it("leaves a default session alone: another session may compact it, with a checkpoint", async () => {
      const { id, harness } = spawn(40, { mode: "manual" })
      await reg.sendPrompt(id, "Let's decide which database we use")
      await reg.sendPrompt(id, "/compact", { source: "agent:sess_other" })
      expect(harness.checkpointsAtCompact).toHaveLength(1)
    })

    it("refuses the session_compact MCP tool when the caller is a session, accepts it from the operator", async () => {
      const { id, harness } = spawn(40, { mode: "manual", compactRequiresOperator: true })
      await reg.sendPrompt(id, "Let's decide which database we use")

      const call = async (callerSessionId: string | undefined) => {
        const server = new McpServer({ name: "t", version: "0" })
        registerSessionTools(server, {
          registry: reg,
          workspace: tmp,
          ...(callerSessionId ? { callerSessionId } : {}),
        })
        const [c, s] = InMemoryTransport.createLinkedPair()
        await server.connect(s)
        const client = new Client({ name: "t-client", version: "0" })
        await client.connect(c)
        try {
          return await client.callTool({ name: "session_compact", arguments: { idOrName: id } })
        } finally {
          await client.close()
        }
      }

      // The brain calling session_compact on itself: the exact bypass.
      const viaSession = await call(id)
      expect(viaSession.isError).toBe(true)
      expect(JSON.stringify(viaSession.content)).toContain("operator's agreement")
      expect(harness.prompts.some(p => p.startsWith("/compact"))).toBe(false)

      const viaOperator = await call(undefined)
      expect(viaOperator.isError).toBeFalsy()
      expect(harness.checkpointsAtCompact).toHaveLength(1)
    })
  })

  describe("the runtime's own compaction (auto mode)", () => {
    const auto = { mode: "auto" as const, warnAtPct: 50, compactAtPct: 60, continueFreshAtPct: 80 }

    it("switches the harness to compact only after the checkpoint is on disk", async () => {
      const { id, harness } = spawn(70, auto)
      await reg.sendPrompt(id, "Let's decide which database we use")

      expect(harness.modeSwitches).toEqual(["compact"])
      expect(harness.checkpointsAtModeSwitch).toHaveLength(1)
      const ckpt = readCheckpoint(id, harness.checkpointsAtModeSwitch![0]!)
      expect(ckpt.recentDigest).toContain("decide which database")
      expect(ckpt.recentDigest).toContain("going with Postgres")
    })

    it("does not compact at all when the checkpoint cannot be written", async () => {
      const { id, harness } = spawn(70, auto)
      breakCheckpointDir(id)
      await reg.sendPrompt(id, "Let's decide which database we use")

      expect(harness.modeSwitches).toEqual([])
      expect(outputOf(id).join("\n")).toMatch(/compact skipped: no checkpoint could be written/)
      expect(reg.get(id)?.status).toBe("running")
    })
  })

  describe("the hard stop", () => {
    it("checkpoints the session before killing it, whatever the mode", async () => {
      const { id } = spawn(95, { mode: "manual" })
      await reg.sendPrompt(id, "Let's decide which database we use")

      const desc = reg.get(id)!
      expect(desc.status).toBe("killed")
      expect(desc.endedReason).toBe("context-hard-stop")
      const files = readdirSync(checkpointDir(id))
      expect(files).toHaveLength(1)
      const ckpt = readCheckpoint(id, files[0]!)
      expect(ckpt.contextPct).toBe(95)
      // the turn that tipped it over is in the checkpoint, not lost with the session
      expect(ckpt.recentDigest).toContain("decide which database")
      expect(ckpt.recentDigest).toContain("going with Postgres")

      const out = outputOf(id)
      const wrote = out.findIndex(l => l.includes("checkpoint ckpt_") && l.includes("before hard stop"))
      const stopped = out.findIndex(l => l.includes("[context-hard-stop]"))
      expect(wrote).toBeGreaterThanOrEqual(0)
      expect(stopped).toBeGreaterThan(wrote)
    })

    it("still stops when the checkpoint fails, and says so", async () => {
      const { id } = spawn(95, { mode: "manual" })
      breakCheckpointDir(id)
      await reg.sendPrompt(id, "Let's decide which database we use")

      expect(reg.get(id)?.status).toBe("killed")
      expect(outputOf(id).join("\n")).toMatch(/stopping WITHOUT a checkpoint/)
    })
  })

  describe("continue fresh", () => {
    it("degrades to a checkpointed hard stop when no adapter resolver is wired", async () => {
      // The relève proper (checkpoint, then spawn) is covered by
      // session-continue-fresh.test.ts.
      const { id } = spawn(85, { mode: "auto", warnAtPct: 50, compactAtPct: 60, continueFreshAtPct: 80 })
      await reg.sendPrompt(id, "Let's decide which database we use")
      expect(reg.get(id)?.status).toBe("killed")
      const files = readdirSync(checkpointDir(id))
      expect(files).toHaveLength(1)
      expect(readCheckpoint(id, files[0]!).recentDigest).toContain("decide which database")
    })
  })
})
