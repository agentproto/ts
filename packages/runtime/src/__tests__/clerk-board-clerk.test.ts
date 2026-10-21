/**
 * `clerk-board-clerk` - the BOARD arm of the clerk hook ("plateaux des
 * PM"): the pass that turns a PM's turn into board rows.
 *
 * Covers the extraction rules (task / promise / blocker, French and
 * English), the duplicate diff against the board, the board resolution,
 * and the gate: with the hook off - the DEFAULT - nothing is written.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createSessionEventBus, type SessionTurnEndEvent } from "../session-event-bus.js"
import { createClerkTurnEndController } from "../clerk-turn-end.js"
import { createClerkPassRunner } from "../clerk-pass-runner.js"
import {
  CLERK_HOOK_DEFAULTS,
  parseAgentClerkHook,
  resolveClerkHookConfig,
  type ClerkHookConfig,
} from "../clerk-hook-config.js"
import {
  classifyBoardSentence,
  extractBoardItems,
  isSameBoardItem,
  normalizeBoardTitle,
  runBoardClerkPass,
  type BoardClerkLedger,
  type BoardClerkTask,
} from "../clerk-board-clerk.js"

const MIN = 60_000

function boardConfig(overrides: Partial<ClerkHookConfig> = {}): ClerkHookConfig {
  return {
    ...CLERK_HOOK_DEFAULTS,
    enabled: true,
    debounceMs: 10 * MIN,
    run: { board: {} },
    ...overrides,
  }
}

/** A ledger fake: records the writes, holds the rows it was given. */
function fakeLedger(opts: { rows?: BoardClerkTask[]; boardId?: string } = {}) {
  const rows = [...(opts.rows ?? [])]
  const writes: Array<{ title: string; boardId?: string; meta?: Record<string, string> }> = []
  const ledger: BoardClerkLedger = {
    list: (_filter, _caller) => rows,
    create: (input, _caller) => {
      writes.push({ title: input.title, boardId: input.boardId, meta: input.meta })
      rows.push({
        taskId: `task_${writes.length}`,
        boardId: input.boardId ?? opts.boardId ?? "tree:root",
        title: input.title,
        status: "pending",
      })
      return { ok: true }
    },
    resolveBoardId: (_caller, explicit) => explicit ?? opts.boardId ?? "tree:root",
  }
  return { ledger, writes, rows }
}

function turnEnd(sessionId: string, extra: Partial<SessionTurnEndEvent> = {}): SessionTurnEndEvent {
  return {
    type: "session:turn-end",
    sessionId,
    awaitingInput: false,
    ts: new Date(0).toISOString(),
    ...extra,
  }
}

describe("board sentence classification", () => {
  it("reads a French blocker as a blocker", () => {
    expect(classifyBoardSentence("La livraison est bloquée par le budget")).toBe("blocker")
    expect(classifyBoardSentence("On est en attente de la validation du CTO")).toBe("blocker")
    expect(classifyBoardSentence("Je n'ai pas de réponse de l'équipeinfra")).toBe("blocker")
  })

  it("reads a French promise as a promise", () => {
    expect(classifyBoardSentence("Je m'engage à envoyer le rapport vendredi")).toBe("promise")
    expect(classifyBoardSentence("Je prends en charge le dossier de facturation")).toBe("promise")
    expect(classifyBoardSentence("Je vais merger la PR demain")).toBe("promise")
  })

  it("reads a French task as a task", () => {
    expect(classifyBoardSentence("TODO: relire la roadmap")).toBe("task")
    expect(classifyBoardSentence("Il faut revoir le planning")).toBe("task")
    expect(classifyBoardSentence("Prochaine étape: relancer le client")).toBe("task")
  })

  it("reads the English phrasings too", () => {
    expect(classifyBoardSentence("The release is blocked by the missing key")).toBe("blocker")
    expect(classifyBoardSentence("I will ship the report on Friday")).toBe("promise")
    expect(classifyBoardSentence("Next step: refactor the parser")).toBe("task")
  })

  it("leaves a sentence that states nothing alone", () => {
    expect(classifyBoardSentence("Bonjour, voici le resume de la semaine")).toBeUndefined()
  })
})

describe("extractBoardItems", () => {
  it("reads only the agent's own turns", () => {
    const items = extractBoardItems([
      { role: "user", text: "TODO: peux-tu revoir la roadmap ?" },
      { role: "assistant", text: "Je m'engage à envoyer le rapport vendredi." },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe("promise")
    expect(items[0]?.title).toBe("[promise] Je m'engage à envoyer le rapport vendredi.")
  })

  it("splits bullets and sentences", () => {
    const items = extractBoardItems([
      {
        role: "assistant",
        text: "- Bloqué par le budget\n- Je vais merger la PR\n- On mangera ensemble.",
      },
    ])
    expect(items.map(i => i.kind)).toEqual(["blocker", "promise"])
  })

  it("keeps one copy of an item stated twice", () => {
    const items = extractBoardItems([
      { role: "assistant", text: "Je m'engage à envoyer le rapport vendredi." },
      { role: "assistant", text: "Je m'engage à envoyer le rapport vendredi." },
    ])
    expect(items).toHaveLength(1)
  })

  it("honours the kinds filter", () => {
    const items = extractBoardItems(
      [{ role: "assistant", text: "TODO: relire la roadmap. La livraison est bloquée par le budget." }],
      { kinds: ["blocker"] },
    )
    expect(items.map(i => i.kind)).toEqual(["blocker"])
  })
})

describe("board title comparison", () => {
  it("sees the same item through its kind tag and its accent/case noise", () => {
    expect(normalizeBoardTitle("[promise] Envoyer le rapport")).toBe("envoyer le rapport")
    expect(isSameBoardItem(normalizeBoardTitle("[promise] Envoyer le rapport"), "envoyer le rapport")).toBe(
      true,
    )
  })

  it("keeps two different items apart", () => {
    expect(isSameBoardItem(normalizeBoardTitle("[task] Relire la roadmap"), "refaire la roadmap")).toBe(
      false,
    )
  })
})

describe("runBoardClerkPass", () => {
  it("writes the PM's items to the session's board", () => {
    const { ledger, writes } = fakeLedger({ boardId: "pm:sarah" })
    const result = runBoardClerkPass({
      sessionId: "sess_pm",
      turns: [
        {
          role: "assistant",
          text: "Je m'engage à envoyer le rapport vendredi. La livraison est bloquée par le budget. TODO: relire la roadmap.",
        },
      ],
      config: boardConfig(),
      ledger,
    })

    expect(result.boardId).toBe("pm:sarah")
    expect(result.created).toBe(3)
    expect(writes.map(w => w.title)).toEqual([
      "[promise] Je m'engage à envoyer le rapport vendredi.",
      "[blocker] La livraison est bloquée par le budget.",
      "[task] TODO: relire la roadmap.",
    ])
    expect(writes[0]?.meta).toMatchObject({ source: "clerk-board", kind: "promise", sessionId: "sess_pm" })
  })

  it("honours an explicit board in the config", () => {
    const { ledger, writes } = fakeLedger({ boardId: "tree:root" })
    const result = runBoardClerkPass({
      sessionId: "sess_pm",
      turns: [{ role: "assistant", text: "TODO: relire la roadmap" }],
      config: boardConfig({ run: { board: { boardId: "pm:sarah" } } }),
      ledger,
    })
    expect(result.boardId).toBe("pm:sarah")
    expect(writes[0]?.boardId).toBe("pm:sarah")
  })

  it("does not write an item the board already carries", () => {
    const { ledger, writes } = fakeLedger({
      boardId: "pm:sarah",
      rows: [
        {
          taskId: "task_0",
          boardId: "pm:sarah",
          title: "[promise] Je m'engage à envoyer le rapport vendredi.",
          status: "done",
        },
      ],
    })
    const result = runBoardClerkPass({
      sessionId: "sess_pm",
      turns: [{ role: "assistant", text: "Je m'engage à envoyer le rapport vendredi." }],
      config: boardConfig(),
      ledger,
    })
    expect(result.created).toBe(0)
    expect(result.skipped).toBe(1)
    expect(writes).toHaveLength(0)
  })

  it("caps the number of items one pass writes", () => {
    const { ledger, writes } = fakeLedger()
    const result = runBoardClerkPass({
      sessionId: "sess_pm",
      turns: [
        {
          role: "assistant",
          text: "TODO: un. TODO: deux. TODO: trois. TODO: quatre.",
        },
      ],
      config: boardConfig({ run: { board: { maxItems: 2 } } }),
      ledger,
    })
    expect(result.created).toBe(2)
    expect(writes).toHaveLength(2)
  })

  it("reports a refused write instead of throwing", () => {
    const ledger: BoardClerkLedger = {
      list: () => [],
      create: () => ({ ok: false, error: "board \"pm:sarah\" is outside the caller's lineage" }),
      resolveBoardId: () => "pm:sarah",
    }
    const result = runBoardClerkPass({
      sessionId: "sess_pm",
      turns: [{ role: "assistant", text: "TODO: relire la roadmap" }],
      config: boardConfig(),
      ledger,
    })
    expect(result.created).toBe(0)
    expect(result.errors).toHaveLength(1)
  })
})

describe("the board arm in the configuration", () => {
  it("replaces the inherited routine arm (the arms are exclusive)", () => {
    const agent = parseAgentClerkHook({ hooks: { clerk: { run: { board: { boardId: "pm:sarah" } } } } })
    const resolved = resolveClerkHookConfig({ agent })
    expect(resolved.config.run.routine).toBeUndefined()
    expect(resolved.config.run.board).toEqual({ boardId: "pm:sarah" })
    expect(resolved.sources.run).toBe("agent")
  })

  it("merges the board options per field", () => {
    const workspace = { run: { board: { boardId: "pm:sarah", maxItems: 3 } } }
    const agent = parseAgentClerkHook({ hooks: { clerk: { run: { board: { maxItems: 1 } } } } })
    const resolved = resolveClerkHookConfig({ workspace, agent })
    expect(resolved.config.run.board).toEqual({ boardId: "pm:sarah", maxItems: 1 })
  })

  it("keeps the board arm off by default", () => {
    const resolved = resolveClerkHookConfig({})
    expect(resolved.config.enabled).toBe(false)
    expect(resolved.config.run.board).toBeUndefined()
  })
})

describe("the gate: nothing leaves when the hook is off", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("writes nothing when the resolved config says disabled (the default)", async () => {
    const { ledger, writes } = fakeLedger({ boardId: "pm:sarah" })
    const bus = createSessionEventBus()
    const controller = createClerkTurnEndController({
      registry: { get: () => ({ id: "sess_pm", kind: "agent-cli" }) },
      sessionEvents: bus,
      // Exactly what the daemon resolves with nothing configured.
      resolveConfig: session =>
        resolveClerkHookConfig({ agent: session.clerkHook }).config,
      runPass: createClerkPassRunner({
        runBoardClerk: input =>
          runBoardClerkPass({
            sessionId: input.sessionId,
            turns: [{ role: "assistant", text: "Je m'engage à envoyer le rapport vendredi." }],
            config: input.config,
            ledger,
          }),
      }),
    })

    bus.emit(turnEnd("sess_pm"))
    vi.advanceTimersByTime(30 * MIN)
    await vi.waitFor(() => expect(controller.pendingIds()).toEqual([]))

    expect(writes).toHaveLength(0)
    controller.dispose()
  })

  it("writes to the board once the hook is enabled for that agent", async () => {
    const { ledger, writes } = fakeLedger({ boardId: "pm:sarah" })
    const bus = createSessionEventBus()
    const controller = createClerkTurnEndController({
      registry: { get: () => ({ id: "sess_pm", kind: "agent-cli" }) },
      sessionEvents: bus,
      resolveConfig: () => boardConfig(),
      runPass: createClerkPassRunner({
        runBoardClerk: input =>
          runBoardClerkPass({
            sessionId: input.sessionId,
            turns: [{ role: "assistant", text: "Je m'engage à envoyer le rapport vendredi." }],
            config: input.config,
            ledger,
          }),
      }),
    })

    bus.emit(turnEnd("sess_pm"))
    vi.advanceTimersByTime(10 * MIN)
    await vi.waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]?.title).toBe("[promise] Je m'engage à envoyer le rapport vendredi.")
    controller.dispose()
  })
})
