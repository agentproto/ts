/**
 * WP-7 — DaemonStateEmitter: snapshot composition (own children + watched
 * sessions, git status), first-emit snapshot → changed-emit delta →
 * unchanged-emit skip (cacheKey dedup), and idle-persist targeting. All
 * against a fake `DaemonClient` and an injected `runGit`.
 */
import { describe, expect, it } from "vitest"
import type { AgentStateSignalInput } from "@mastra/core/agent"
import type { DaemonClient } from "../daemon-client.js"
import {
  DAEMON_STATE_SIGNAL_ID,
  DaemonStateEmitter,
  type DaemonStateSnapshot,
  type StateSignalAgentLike,
} from "../state-signals.js"

function fakeClient(sessions: () => Array<Record<string, unknown>>): DaemonClient {
  return { listSessions: async () => ({ sessions: sessions() }) } as unknown as DaemonClient
}

interface SentSignal {
  state: AgentStateSignalInput
  target: Record<string, unknown>
}

function fakeStateAgent(): { agent: StateSignalAgentLike; sent: SentSignal[] } {
  const sent: SentSignal[] = []
  return {
    sent,
    agent: {
      sendStateSignal: async (state, target) => {
        sent.push({ state, target: target as Record<string, unknown> })
        return {}
      },
    },
  }
}

const TARGET = { threadId: "thread-1", resourceId: "mastra-agent" }
const GIT_CLEANISH = "## main...origin/main [ahead 1]\n M src/a.ts\n?? src/b.ts\n"

describe("DaemonStateEmitter — computeSnapshot", () => {
  it("keeps own children and watched ids, drops unrelated sessions, sorts by id", async () => {
    const emitter = new DaemonStateEmitter({
      client: fakeClient(() => [
        { id: "z-child", parentSessionId: "me", status: "running", adapter: "hermes" },
        { id: "a-watched", parentSessionId: "someone-else", status: "exited", label: "worker" },
        { id: "unrelated", parentSessionId: "someone-else", status: "running" },
      ]),
      env: { AGENTPROTO_SESSION_ID: "me" },
      runGit: async () => GIT_CLEANISH,
    })

    const snapshot = await emitter.computeSnapshot(["a-watched"])

    expect(snapshot.sessions.map((s) => s.id)).toEqual(["a-watched", "z-child"])
    expect(snapshot.sessions[0]).toEqual({
      id: "a-watched",
      label: "worker",
      status: "exited",
      parentSessionId: "someone-else",
    })
    expect(snapshot.git).toEqual({ branch: "main", dirtyFiles: 2 })
  })

  it("without AGENTPROTO_SESSION_ID only watched ids qualify; git failure degrades to no git state", async () => {
    const emitter = new DaemonStateEmitter({
      client: fakeClient(() => [
        { id: "child", parentSessionId: undefined, status: "running" },
        { id: "watched", status: "running" },
      ]),
      env: {},
      runGit: async () => {
        throw new Error("not a git repo")
      },
    })

    const snapshot = await emitter.computeSnapshot(["watched"])

    expect(snapshot.sessions.map((s) => s.id)).toEqual(["watched"])
    expect(snapshot.git).toBeUndefined()
  })
})

describe("DaemonStateEmitter — emit", () => {
  function makeEmitter(sessions: () => Array<Record<string, unknown>>, git: () => string) {
    return new DaemonStateEmitter({
      client: fakeClient(sessions),
      env: { AGENTPROTO_SESSION_ID: "me" },
      runGit: async () => git(),
    })
  }

  it("first emit sends a full snapshot with the stable signal id and idle-persist target", async () => {
    const emitter = makeEmitter(
      () => [{ id: "c1", parentSessionId: "me", status: "running" }],
      () => GIT_CLEANISH,
    )
    const { agent, sent } = fakeStateAgent()

    const result = await emitter.emit(agent, TARGET, [])

    expect(result).toBe("snapshot")
    expect(sent).toHaveLength(1)
    expect(sent[0]!.state.id).toBe(DAEMON_STATE_SIGNAL_ID)
    expect(sent[0]!.state.mode).toBe("snapshot")
    expect(typeof sent[0]!.state.cacheKey).toBe("string")
    expect(sent[0]!.state.contents).toContain("c1")
    expect(sent[0]!.state.contents).toContain("main, 2 dirty file(s)")
    expect(sent[0]!.target).toEqual({ ...TARGET, ifIdle: { behavior: "persist" } })
  })

  it("unchanged state sends nothing; a change sends a delta with a new cacheKey", async () => {
    let status = "running"
    const emitter = makeEmitter(
      () => [{ id: "c1", parentSessionId: "me", status }],
      () => GIT_CLEANISH,
    )
    const { agent, sent } = fakeStateAgent()

    expect(await emitter.emit(agent, TARGET, [])).toBe("snapshot")
    expect(await emitter.emit(agent, TARGET, [])).toBe("unchanged")
    expect(sent).toHaveLength(1)

    status = "exited"
    expect(await emitter.emit(agent, TARGET, [])).toBe("delta")
    expect(sent).toHaveLength(2)
    expect(sent[1]!.state.mode).toBe("delta")
    expect(sent[1]!.state.cacheKey).not.toBe(sent[0]!.state.cacheKey)
    expect(sent[1]!.state.contents).toContain("c1: running → exited")
    const value = sent[1]!.state.value as DaemonStateSnapshot
    expect(value.sessions[0]!.status).toBe("exited")
    expect(sent[1]!.state.delta).toMatchObject({
      addedSessions: [],
      removedSessions: [],
      statusChanges: [{ id: "c1", from: "running", to: "exited" }],
    })
  })

  it("session appearing/disappearing and git changes surface in the delta", async () => {
    let rows: Array<Record<string, unknown>> = [{ id: "c1", parentSessionId: "me", status: "running" }]
    let git = GIT_CLEANISH
    const emitter = makeEmitter(
      () => rows,
      () => git,
    )
    const { agent, sent } = fakeStateAgent()

    await emitter.emit(agent, TARGET, [])
    rows = [{ id: "c2", parentSessionId: "me", status: "starting" }]
    git = "## main...origin/main\n"

    expect(await emitter.emit(agent, TARGET, [])).toBe("delta")
    const contents = String(sent[1]!.state.contents)
    expect(contents).toContain("new session c2")
    expect(contents).toContain("session c1 no longer listed")
    expect(contents).toContain("main, 0 dirty file(s)")
  })

  it("targets are tracked independently — a second thread gets its own snapshot", async () => {
    const emitter = makeEmitter(
      () => [{ id: "c1", parentSessionId: "me", status: "running" }],
      () => GIT_CLEANISH,
    )
    const { agent, sent } = fakeStateAgent()

    await emitter.emit(agent, TARGET, [])
    const result = await emitter.emit(agent, { threadId: "thread-2", resourceId: "mastra-agent" }, [])

    expect(result).toBe("snapshot")
    expect(sent).toHaveLength(2)
    expect(sent[1]!.state.mode).toBe("snapshot")
  })
})
