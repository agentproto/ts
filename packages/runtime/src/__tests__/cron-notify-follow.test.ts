/**
 * A cron job can declare how loudly its success is heard. With
 * `notify: "onFailure"` a successful command run reaches followers as an fyi
 * digest (inbox only, no wake); a failed command still crashes and wakes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createCronScheduler, type CronScheduler } from "../cron-scheduler.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type SessionDescriptor,
  type SessionsRegistry,
} from "../sessions.js"
import { createSessionEventBus, type SessionEventBus } from "../session-event-bus.js"
import { createSessionFollowStore } from "../session-follow-store.js"
import { wireSessionFollow, type SessionFollowHandle } from "../session-follow.js"

const NOW = (): string => new Date().toISOString()

function liveAgentSession(sessionId: string): AgentSessionLike {
  return {
    sessionId,
    pid: process.pid,
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

describe("cron notify onFailure", () => {
  let workspace: string
  let sessionEvents: SessionEventBus
  let registry: SessionsRegistry
  let scheduler: CronScheduler
  let handle: SessionFollowHandle | undefined
  let follower: SessionDescriptor

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "cron-notify-follow-"))
    mkdirSync(join(workspace, ".agentproto"), { recursive: true })
    writeFileSync(
      join(workspace, ".agentproto", "allowed-commands.json"),
      JSON.stringify({ version: 1, commands: ["echo", "sh"] }),
    )
    sessionEvents = createSessionEventBus()
    registry = createSessionsRegistry({
      sessionEvents,
      persist: false,
      transcriptDir: join(workspace, "transcripts"),
    })
    scheduler = createCronScheduler({
      sessionEvents,
      registry,
      workspace,
      persistPath: join(workspace, "cron-jobs.json"),
    })
    follower = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: workspace,
      agentSession: liveAgentSession("acp-chief"),
      adapterSlug: "claude-code",
      label: "chief",
    })
    const store = createSessionFollowStore({ persist: false })
    store.upsert({ follower: follower.id, selector: { all: true }, batchMs: 60_000 })
    handle = wireSessionFollow({
      registry,
      sessionEvents,
      store,
      // Mirrors the daemon wiring in index.ts.
      sourceUrgency: (desc: SessionDescriptor) => {
        if (desc.origin !== "cron" || desc.kind !== "command" || !desc.label) return undefined
        const match = /^cron:(.+)$/.exec(desc.label)
        if (!match) return undefined
        const job = scheduler.get(match[1]!)
        return job?.notify === "onFailure" ? "fyi" : undefined
      },
      readLastOutput: () => undefined,
      parkedPath: join(workspace, "parked.jsonl"),
      log: () => {},
    })
  })

  afterEach(() => {
    handle?.dispose()
    handle = undefined
    scheduler.shutdown()
    registry.shutdown()
    rmSync(workspace, { recursive: true, force: true })
  })

  function inbox(): Array<{ urgency?: string; text: string }> {
    return (registry.listInbox(follower.id) ?? []) as Array<{ urgency?: string; text: string }>
  }

  async function createJob(notify: "always" | "onFailure" | undefined, args: string[]) {
    return scheduler.create({
      schedule: "0 0 1 1 *",
      action: { kind: "command", command: "sh", args: ["-c", ...args] },
      ...(notify ? { notify } : {}),
    })
  }

  it("a successful onFailure command lands in the inbox at fyi and does not wake", async () => {
    const enqueueSpy = vi.spyOn(registry, "enqueuePrompt")
    const job = await createJob("onFailure", ["echo delivered"])
    await scheduler.run(job.id)
    await handle!.flush()

    expect(enqueueSpy).not.toHaveBeenCalled()
    expect(registry.get(follower.id)?.promptQueue ?? []).toEqual([])
    const messages = inbox()
    expect(messages).toHaveLength(1)
    expect(messages[0]?.urgency).toBe("fyi")
    expect(messages[0]?.text).toContain("for your information only")
    expect(messages[0]?.text).toContain(`cron:${job.id}`)
  })

  it("the same job failing still crashes and wakes the follower", async () => {
    const enqueueSpy = vi.spyOn(registry, "enqueuePrompt")
    const job = await createJob("onFailure", ["exit 3"])
    expect(job.notify).toBe("onFailure")
    const result = await scheduler.run(job.id)
    expect(result?.ok).toBe(false)
    await handle!.flush()

    expect(enqueueSpy).toHaveBeenCalledTimes(1)
    const [to, text, opts] = enqueueSpy.mock.calls[0]!
    expect(to).toBe(follower.id)
    expect(String(text)).toContain("crashed")
    expect((opts as { envelope?: { urgency?: string } }).envelope?.urgency).toBe("next-turn")
  })

  it("notify absent and explicit always keep today's waking behaviour", async () => {
    const enqueueSpy = vi.spyOn(registry, "enqueuePrompt")
    const absent = await createJob(undefined, ["echo delivered"])
    await scheduler.run(absent.id)
    await handle!.flush()
    expect(enqueueSpy).toHaveBeenCalledTimes(1)
    const [absentTo, absentText, absentOpts] = enqueueSpy.mock.calls[0]!
    expect(absentTo).toBe(follower.id)
    expect(String(absentText)).not.toContain("for your information only")
    expect((absentOpts as { envelope?: { urgency?: string } }).envelope?.urgency).toBe("next-turn")

    enqueueSpy.mockClear()
    const always = await createJob("always", ["echo again"])
    expect(always.notify).toBe("always")
    await scheduler.run(always.id)
    await handle!.flush()
    expect(enqueueSpy).toHaveBeenCalledTimes(1)
    const [alwaysTo, alwaysText, alwaysOpts] = enqueueSpy.mock.calls[0]!
    expect(alwaysTo).toBe(follower.id)
    expect(String(alwaysText)).not.toContain("for your information only")
    expect((alwaysOpts as { envelope?: { urgency?: string } }).envelope?.urgency).toBe("next-turn")
  })

  it("a mixed digest wakes and still lists the fyi cron line", async () => {
    const enqueueSpy = vi.spyOn(registry, "enqueuePrompt")
    const other = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: join(workspace, "other"),
      agentSession: liveAgentSession("acp-other"),
      adapterSlug: "claude-code",
      label: "other",
    })
    const job = await createJob("onFailure", ["echo delivered"])
    expect(job.notify).toBe("onFailure")
    await scheduler.run(job.id)
    sessionEvents.emit({
      type: "session:turn-end",
      sessionId: other.id,
      awaitingInput: false,
      ts: NOW(),
    } as never)
    await handle!.flush()

    expect(enqueueSpy).toHaveBeenCalledTimes(1)
    const [to, text, opts] = enqueueSpy.mock.calls[0]!
    expect(to).toBe(follower.id)
    expect(String(text)).toContain(`cron:${job.id}`)
    expect(String(text)).toContain(`(${other.id}) turn-end`)
    expect((opts as { envelope?: { urgency?: string } }).envelope?.urgency).toBe("next-turn")
  })

  it("a job removed after the exit but before the flush is still delivered at fyi", async () => {
    const enqueueSpy = vi.spyOn(registry, "enqueuePrompt")
    const job = await createJob("onFailure", ["echo delivered"])
    await scheduler.run(job.id)
    scheduler.delete(job.id)
    await handle!.flush()

    expect(scheduler.get(job.id)).toBeUndefined()
    expect(enqueueSpy).not.toHaveBeenCalled()
    const messages = inbox()
    expect(messages).toHaveLength(1)
    expect(messages[0]?.urgency).toBe("fyi")
  })

  it("triage never raises a source-declared fyi back to wake", async () => {
    handle!.dispose()
    const store = createSessionFollowStore({ persist: false })
    store.upsert({
      follower: follower.id,
      selector: { all: true },
      batchMs: 60_000,
      triage: { enabled: true },
    })
    handle = wireSessionFollow({
      registry,
      sessionEvents,
      store,
      sourceUrgency: (desc: SessionDescriptor) => {
        if (desc.origin !== "cron" || desc.kind !== "command" || !desc.label) return undefined
        const match = /^cron:(.+)$/.exec(desc.label)
        if (!match) return undefined
        const job = scheduler.get(match[1]!)
        return job?.notify === "onFailure" ? "fyi" : undefined
      },
      readLastOutput: () => undefined,
      parkedPath: join(workspace, "parked.jsonl"),
      triagePath: join(workspace, "triage.jsonl"),
      log: () => {},
    })
    const job = await createJob("onFailure", ["echo delivered"])
    await scheduler.run(job.id)
    await handle!.flush()

    const messages = inbox()
    expect(messages).toHaveLength(1)
    expect(messages[0]?.urgency).toBe("fyi")
    expect(messages[0]?.text).toContain("for your information only")
    const { readFileSync } = await import("node:fs")
    const lines = readFileSync(join(workspace, "triage.jsonl"), "utf8").trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "exited", decision: "fyi" })
  })
})
