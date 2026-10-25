/**
 * `clerk-turn-end` - the AIP-68 clerk pass that runs after a turn ends.
 *
 * Covers the four invariants (debounce, single-flight, fire-and-forget,
 * disabled by default), what the clerk ignores (its own sessions, empty
 * turns, excluded sessions), and the three-level configuration precedence
 * (agent > workspace > daemon default).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CLERK_HOOK_DEFAULTS,
  createClerkPassRunner,
  createClerkTurnEndController,
  loadWorkspaceClerkHook,
  parseAgentClerkHook,
  resolveClerkHookConfig,
  type ClerkHookConfig,
  type ClerkTurnEndEvent,
} from "../index.js"

const MIN = 60_000

function createSessionEventBus() {
  const handlers = new Map<string, Set<(ev: ClerkTurnEndEvent) => void>>()
  return {
    on(type: "session:turn-end", handler: (ev: ClerkTurnEndEvent) => void): () => void {
      const set = handlers.get(type) ?? new Set()
      set.add(handler)
      handlers.set(type, set)
      return () => set.delete(handler)
    },
    emit(ev: ClerkTurnEndEvent): void {
      for (const handler of handlers.get(ev.type) ?? []) handler(ev)
    },
  }
}

function enabledConfig(overrides: Partial<ClerkHookConfig> = {}): ClerkHookConfig {
  return { ...CLERK_HOOK_DEFAULTS, enabled: true, debounceMs: 10 * MIN, ...overrides }
}

function turnEnd(sessionId: string, extra: Partial<ClerkTurnEndEvent> = {}): ClerkTurnEndEvent {
  return {
    type: "session:turn-end",
    sessionId,
    ...extra,
  }
}

describe("clerk-turn-end controller", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("does nothing when the hook is disabled (the default)", () => {
    const bus = createSessionEventBus()
    const runPass = vi.fn()
    const controller = createClerkTurnEndController({
      registry: { get: () => ({ id: "sess_1", kind: "agent-cli" }) },
      sessionEvents: bus,
      resolveConfig: () => CLERK_HOOK_DEFAULTS,
      runPass,
    })
    bus.emit(turnEnd("sess_1"))
    vi.advanceTimersByTime(60 * MIN)
    expect(runPass).not.toHaveBeenCalled()
    controller.dispose()
  })

  it("runs one pass after the debounce window and debounces repeated turn-ends", async () => {
    const bus = createSessionEventBus()
    const runPass = vi.fn().mockResolvedValue(undefined)
    const controller = createClerkTurnEndController({
      registry: { get: () => ({ id: "sess_1", kind: "agent-cli" }) },
      sessionEvents: bus,
      resolveConfig: () => enabledConfig({ debounceMs: 10 * MIN }),
      runPass,
    })

    bus.emit(turnEnd("sess_1"))
    vi.advanceTimersByTime(5 * MIN)
    bus.emit(turnEnd("sess_1"))
    vi.advanceTimersByTime(5 * MIN)
    // The second turn-end restarted the window - no pass yet.
    expect(runPass).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10 * MIN)
    await vi.waitFor(() => expect(runPass).toHaveBeenCalledTimes(1))
    expect(runPass.mock.calls[0]?.[0]).toMatchObject({ sessionId: "sess_1" })

    // A NEW idle window produces a new pass.
    bus.emit(turnEnd("sess_1"))
    vi.advanceTimersByTime(10 * MIN)
    await vi.waitFor(() => expect(runPass).toHaveBeenCalledTimes(2))
    controller.dispose()
  })

  it("never runs two passes on the same session at the same time", async () => {
    const bus = createSessionEventBus()
    let release: (() => void) | undefined
    const runPass = vi.fn(
      () =>
        new Promise<void>(resolve => {
          release = resolve
        }),
    )
    const controller = createClerkTurnEndController({
      registry: { get: () => ({ id: "sess_1", kind: "agent-cli" }) },
      sessionEvents: bus,
      resolveConfig: () => enabledConfig({ debounceMs: 10 * MIN }),
      runPass,
    })

    bus.emit(turnEnd("sess_1"))
    vi.advanceTimersByTime(10 * MIN)
    await vi.waitFor(() => expect(runPass).toHaveBeenCalledTimes(1))
    expect(controller.inFlightIds()).toEqual(["sess_1"])

    // A turn-end while the pass is running re-arms the timer; when it
    // fires, the in-flight pass blocks a second one.
    bus.emit(turnEnd("sess_1"))
    vi.advanceTimersByTime(10 * MIN)
    await Promise.resolve()
    expect(runPass).toHaveBeenCalledTimes(1)

    release?.()
    await vi.waitFor(() => expect(controller.inFlightIds()).toEqual([]))
    controller.dispose()
  })

  it("never blocks the turn: the bus handler returns before the pass finishes", async () => {
    const bus = createSessionEventBus()
    let finished = false
    const runPass = vi.fn(
      () =>
        new Promise<void>(resolve =>
          setTimeout(() => {
            finished = true
            resolve()
          }, 5 * MIN),
        ),
    )
    const controller = createClerkTurnEndController({
      registry: { get: () => ({ id: "sess_1", kind: "agent-cli" }) },
      sessionEvents: bus,
      resolveConfig: () => enabledConfig({ debounceMs: 10 * MIN }),
      runPass,
    })

    const start = Date.now()
    bus.emit(turnEnd("sess_1"))
    // The emit itself is synchronous and does no work beyond arming a timer.
    expect(Date.now() - start).toBeLessThan(50)
    expect(runPass).not.toHaveBeenCalled()

    vi.advanceTimersByTime(10 * MIN)
    await vi.waitFor(() => expect(runPass).toHaveBeenCalledTimes(1))
    expect(finished).toBe(false)
    vi.advanceTimersByTime(5 * MIN)
    await vi.waitFor(() => expect(finished).toBe(true))
    controller.dispose()
  })

  it("ignores its own sessions, empty turns, interrupted turns and excluded sessions", () => {
    const bus = createSessionEventBus()
    const runPass = vi.fn()
    const sessions = new Map<string, { id: string; kind: string; label?: string }>([
      ["sess_own", { id: "sess_own", kind: "agent-cli" }],
      ["sess_empty", { id: "sess_empty", kind: "agent-cli" }],
      ["sess_int", { id: "sess_int", kind: "agent-cli" }],
      ["sess_excluded", { id: "sess_excluded", kind: "agent-cli", label: "noisy" }],
      ["sess_ok", { id: "sess_ok", kind: "agent-cli" }],
    ])
    const controller = createClerkTurnEndController({
      registry: { get: id => sessions.get(id) },
      sessionEvents: bus,
      resolveConfig: () => enabledConfig({ debounceMs: 10 * MIN, exclude: ["noisy"] }),
      runPass,
      selfSessionIds: ["sess_own"],
    })

    bus.emit(turnEnd("sess_own"))
    bus.emit(turnEnd("sess_empty", { empty: true }))
    bus.emit(turnEnd("sess_int", { interrupted: true }))
    bus.emit(turnEnd("sess_excluded"))
    bus.emit(turnEnd("sess_ok"))
    vi.advanceTimersByTime(30 * MIN)

    expect(runPass).toHaveBeenCalledTimes(1)
    expect(runPass.mock.calls[0]?.[0]).toMatchObject({ sessionId: "sess_ok" })
    controller.dispose()
  })

  it("ignores a session spawned by the clerk's own routine", () => {
    const bus = createSessionEventBus()
    const runPass = vi.fn()
    const controller = createClerkTurnEndController({
      registry: { get: () => ({ id: "sess_clerk", kind: "agent-cli", origin: "routine:steward" }) },
      sessionEvents: bus,
      resolveConfig: () => enabledConfig({ run: { routine: "steward" } }),
      runPass,
    })
    bus.emit(turnEnd("sess_clerk"))
    expect(controller.pendingIds()).toEqual([])
    vi.advanceTimersByTime(60 * MIN)
    expect(runPass).not.toHaveBeenCalled()
    controller.dispose()
  })

  it("does not fire for a session that is not an agent session", () => {
    const bus = createSessionEventBus()
    const runPass = vi.fn()
    const controller = createClerkTurnEndController({
      registry: { get: () => ({ id: "sess_1", kind: "command" }) },
      sessionEvents: bus,
      resolveConfig: () => enabledConfig(),
      runPass,
    })
    bus.emit(turnEnd("sess_1"))
    vi.advanceTimersByTime(30 * MIN)
    expect(runPass).not.toHaveBeenCalled()
    controller.dispose()
  })

  it("cancels pending passes on dispose", () => {
    const bus = createSessionEventBus()
    const runPass = vi.fn()
    const controller = createClerkTurnEndController({
      registry: { get: () => ({ id: "sess_1", kind: "agent-cli" }) },
      sessionEvents: bus,
      resolveConfig: () => enabledConfig(),
      runPass,
    })
    bus.emit(turnEnd("sess_1"))
    expect(controller.pendingIds()).toEqual(["sess_1"])
    controller.dispose()
    vi.advanceTimersByTime(30 * MIN)
    expect(runPass).not.toHaveBeenCalled()
  })

  it("survives a failing pass (the failure never escapes into the bus)", async () => {
    const bus = createSessionEventBus()
    const onError = vi.fn()
    const controller = createClerkTurnEndController({
      registry: { get: () => ({ id: "sess_1", kind: "agent-cli" }) },
      sessionEvents: bus,
      resolveConfig: () => enabledConfig(),
      runPass: () => Promise.reject(new Error("boom")),
      onError,
    })
    bus.emit(turnEnd("sess_1"))
    vi.advanceTimersByTime(10 * MIN)
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(controller.inFlightIds()).toEqual([])
    controller.dispose()
  })
})

describe("clerk hook configuration - three levels, most specific wins", () => {
  it("is disabled by default, with a 10-minute debounce and the steward routine", () => {
    const resolved = resolveClerkHookConfig({})
    expect(resolved.config.enabled).toBe(false)
    expect(resolved.config.debounceMs).toBe(10 * MIN)
    expect(resolved.config.run).toEqual({ routine: "steward" })
    expect(resolved.sources.enabled).toBe("default")
  })

  it("lets the daemon level override the default", () => {
    const resolved = resolveClerkHookConfig({
      daemon: { enabled: true, debounceMs: 60_000 },
    })
    expect(resolved.config.enabled).toBe(true)
    expect(resolved.config.debounceMs).toBe(60_000)
    expect(resolved.sources.enabled).toBe("daemon")
  })

  it("lets the workspace level override the daemon level", () => {
    const resolved = resolveClerkHookConfig({
      daemon: { enabled: false, debounceMs: 60_000 },
      workspace: { enabled: true },
    })
    expect(resolved.config.enabled).toBe(true)
    // The daemon's debounce is NOT reset by the workspace's `enabled` - the
    // merge is per field.
    expect(resolved.config.debounceMs).toBe(60_000)
    expect(resolved.sources.enabled).toBe("workspace")
    expect(resolved.sources.debounceMs).toBe("daemon")
  })

  it("lets the agent level override the workspace level", () => {
    const resolved = resolveClerkHookConfig({
      workspace: { enabled: true, debounceMs: 60_000, run: { routine: "workspace-routine" } },
      agent: { enabled: false, run: { command: "agentproto", args: ["steward"] } },
    })
    expect(resolved.config.enabled).toBe(false)
    expect(resolved.config.debounceMs).toBe(60_000)
    // The arms are exclusive: the agent's command REPLACES the workspace routine.
    expect(resolved.config.run).toEqual({ command: "agentproto", args: ["steward"] })
    expect(resolved.sources.enabled).toBe("agent")
    expect(resolved.sources.run).toBe("agent")
  })

  it("lets a command-only level replace the built-in steward routine", () => {
    const resolved = resolveClerkHookConfig({
      agent: { enabled: true, run: { command: "agentproto", args: ["steward", "act"] } },
    })
    expect(resolved.config.run).toEqual({ command: "agentproto", args: ["steward", "act"] })
    expect(resolved.config.run.routine).toBeUndefined()
  })

  it("lets a routine level replace an inherited command (and its args)", () => {
    const resolved = resolveClerkHookConfig({
      daemon: { run: { command: "agentproto", args: ["steward"], timeoutMs: 5_000 } },
      workspace: { run: { routine: "nightly" } },
    })
    expect(resolved.config.run).toEqual({ routine: "nightly", timeoutMs: 5_000 })
    expect(resolved.sources.run).toBe("workspace")
  })

  it("keeps the inherited arm when a level only tunes timeoutMs, and keeps its provenance", () => {
    const resolved = resolveClerkHookConfig({
      workspace: { run: { routine: "workspace-routine" } },
      agent: { run: { timeoutMs: 9_000 } },
    })
    expect(resolved.config.run).toEqual({ routine: "workspace-routine", timeoutMs: 9_000 })
    expect(resolved.sources.run).toBe("workspace")
  })

  it("makes the routine win when one level names both arms", () => {
    const resolved = resolveClerkHookConfig({
      agent: { run: { routine: "r", command: "agentproto", args: ["x"] } },
    })
    expect(resolved.config.run).toEqual({ routine: "r" })
  })

  it("ignores malformed values instead of throwing", () => {
    const resolved = resolveClerkHookConfig({
      daemon: { enabled: "yes", debounceMs: -1, on: "not_an_event" },
    })
    expect(resolved.config.enabled).toBe(false)
    expect(resolved.config.debounceMs).toBe(10 * MIN)
    expect(resolved.config.on).toBe("turn_end")
  })

  it("reads the workspace level out of .agentproto/hooks.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "clerk-hooks-"))
    mkdirSync(join(dir, ".agentproto"), { recursive: true })
    writeFileSync(
      join(dir, ".agentproto", "hooks.json"),
      JSON.stringify({
        rules: [],
        hooks: {
          clerk: {
            enabled: true,
            on: "turn_end",
            debounceMs: 120_000,
            run: { routine: "session-steward-hourly" },
          },
        },
      }),
    )
    const level = loadWorkspaceClerkHook(dir)
    expect(level.enabled).toBe(true)
    expect(level.debounceMs).toBe(120_000)
    expect(level.run).toEqual({ routine: "session-steward-hourly" })
  })

  it("accepts the generic `hooks` vocabulary too (PR #2142)", () => {
    const dir = mkdtempSync(join(tmpdir(), "clerk-hooks-generic-"))
    mkdirSync(join(dir, ".agentproto"), { recursive: true })
    writeFileSync(
      join(dir, ".agentproto", "hooks.json"),
      JSON.stringify({ hooks: { enabled: true, on: "turn_end", debounceMs: 30_000 } }),
    )
    const level = loadWorkspaceClerkHook(dir)
    expect(level.enabled).toBe(true)
    expect(level.debounceMs).toBe(30_000)
  })

  it("returns no workspace level when the file is absent or broken", () => {
    const dir = mkdtempSync(join(tmpdir(), "clerk-hooks-empty-"))
    expect(loadWorkspaceClerkHook(dir)).toEqual({})
    mkdirSync(join(dir, ".agentproto"), { recursive: true })
    writeFileSync(join(dir, ".agentproto", "hooks.json"), "{ not json")
    expect(loadWorkspaceClerkHook(dir)).toEqual({})
  })

  it("reads the agent level out of a manifest's metadata / an agent_start option", () => {
    expect(parseAgentClerkHook({ hooks: { clerk: { enabled: true, debounceMs: 42 } } })).toEqual({
      enabled: true,
      debounceMs: 42,
    })
    expect(parseAgentClerkHook({ hooks: { enabled: true } })).toEqual({ enabled: true })
    expect(parseAgentClerkHook({})).toEqual({})
  })
})

describe("clerk pass runner", () => {
  it("triggers the configured routine", async () => {
    const triggerRoutine = vi.fn().mockResolvedValue({ ok: true })
    const runner = createClerkPassRunner({ triggerRoutine })
    await runner({
      sessionId: "sess_1",
      session: { id: "sess_1" },
      config: { ...CLERK_HOOK_DEFAULTS, enabled: true, run: { routine: "steward" } },
    })
    expect(triggerRoutine).toHaveBeenCalledWith("steward")
  })

  it("spawns the configured command in the session's cwd", async () => {
    const spawnCommand = vi.fn().mockResolvedValue({ code: 0 })
    const runner = createClerkPassRunner({ spawnCommand, allowCommand: () => true })
    await runner({
      sessionId: "sess_1",
      session: { id: "sess_1", cwd: "/tmp/work" },
      config: {
        ...CLERK_HOOK_DEFAULTS,
        enabled: true,
        run: { command: "agentproto", args: ["steward", "act"] },
      },
    })
    expect(spawnCommand).toHaveBeenCalledWith({
      command: "agentproto",
      args: ["steward", "act"],
      cwd: "/tmp/work",
    })
  })

  it("refuses the command arm unless the allowlist gate approves it", async () => {
    const spawnCommand = vi.fn()
    const config = { ...CLERK_HOOK_DEFAULTS, enabled: true, run: { command: "/usr/bin/rm", args: ["-rf", "x"] } }
    const input = { sessionId: "sess_1", session: { id: "sess_1", cwd: "/tmp/work" }, config }

    // No gate wired: default-deny.
    await expect(createClerkPassRunner({ spawnCommand })(input)).rejects.toThrow(/not in the command allowlist/)
    // Gate says no; it sees the basename and the final args.
    const allowCommand = vi.fn().mockReturnValue(false)
    await expect(createClerkPassRunner({ spawnCommand, allowCommand })(input)).rejects.toThrow(
      /'rm' is not in the command allowlist/,
    )
    expect(allowCommand).toHaveBeenCalledWith({ command: "rm", args: ["-rf", "x"] })
    expect(spawnCommand).not.toHaveBeenCalled()
  })

  it("interpolates $SESSION_ID in the command args", async () => {
    const spawnCommand = vi.fn().mockResolvedValue({ code: 0 })
    const runner = createClerkPassRunner({ spawnCommand, allowCommand: () => true })
    await runner({
      sessionId: "sess_42",
      session: { id: "sess_42", cwd: "/tmp/work" },
      config: {
        ...CLERK_HOOK_DEFAULTS,
        enabled: true,
        run: { command: "agentproto", args: ["steward", "act", "--session", "$SESSION_ID"] },
      },
    })
    expect(spawnCommand).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["steward", "act", "--session", "sess_42"] }),
    )
  })

  it("anchors an explicit run.cwd against the session cwd", async () => {
    const spawnCommand = vi.fn().mockResolvedValue({ code: 0 })
    const anchorCwd = vi.fn((base: string, cwd: string) => `${base}/${cwd}`)
    const runner = createClerkPassRunner({ spawnCommand, allowCommand: () => true, anchorCwd })
    await runner({
      sessionId: "sess_1",
      session: { id: "sess_1", cwd: "/tmp/work" },
      config: { ...CLERK_HOOK_DEFAULTS, enabled: true, run: { command: "agentproto", cwd: "sub" } },
    })
    expect(spawnCommand).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/tmp/work/sub" }))
  })

  it("runs the agent's command when the agent only names a command (resolve to runner)", async () => {
    const triggerRoutine = vi.fn()
    const spawnCommand = vi.fn().mockResolvedValue({ code: 0 })
    const runner = createClerkPassRunner({ triggerRoutine, spawnCommand, allowCommand: () => true })
    const { config } = resolveClerkHookConfig({
      agent: { enabled: true, run: { command: "agentproto", args: ["steward", "act"] } },
    })
    await runner({ sessionId: "sess_1", session: { id: "sess_1", cwd: "/tmp/work" }, config })
    expect(triggerRoutine).not.toHaveBeenCalled()
    expect(spawnCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: "agentproto", args: ["steward", "act"] }),
    )
  })

  it("reports a configuration that names neither a routine nor a command", async () => {
    const runner = createClerkPassRunner({})
    await expect(
      runner({
        sessionId: "sess_1",
        session: { id: "sess_1" },
        config: { ...CLERK_HOOK_DEFAULTS, enabled: true, run: {} },
      }),
    ).rejects.toThrow(/neither a routine nor a command/)
  })
})
