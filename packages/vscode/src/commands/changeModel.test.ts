/**
 * The mid-session model switch, end to end through the vscode shell: the
 * picker is built from the CATALOG (the adapter's declared models) AND from
 * the LIVE session's own model vocabulary (the config options the running
 * agent advertises), and the picked row decides WHICH value is sent.
 *
 * The bug this closes (21/10): picking a catalog id (e.g.
 * "claude-sonnet-5-5") on a live claude-code session sent it straight to the
 * ACP model config option, where the agent rejected it ("Invalid value for
 * config option model"). Here the live vocabulary wins for the live switch,
 * and a catalog id outside it is routed through the restart path instead.
 */

import { describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor } from "../client/types.js"
import type { TranscriptPanelController } from "../webview/transcriptPanelController.js"
import { runChangeModelFlow } from "./changeModel.js"

/** The catalog id the adapter declares -- the value the picker used to send
 *  verbatim, and the one the running agent REJECTS. */
const CATALOG_MODEL = "claude-sonnet-5-5"
/** A value the running agent itself advertises for its model config option. */
const LIVE_MODEL = "claude-opus-5-5"

function descriptor(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "s1",
    kind: "agent-cli",
    workspaceSlug: "default",
    command: "claude",
    pid: 1,
    status: "running",
    startedAt: new Date(0).toISOString(),
    adapterSlug: "claude-code",
    model: CATALOG_MODEL,
    ...overrides,
  } as SessionDescriptor
}

/** The live session as the daemon reports it: the model config option and the
 *  values the running agent accepts for it. */
function liveDescriptor(values: string[] = [CATALOG_MODEL, LIVE_MODEL]): SessionDescriptor {
  return descriptor({
    configOptions: [
      {
        id: "model",
        category: "model",
        type: "select",
        currentValue: CATALOG_MODEL,
        options: values.map(value => ({ value })),
      },
    ],
  })
}

function controllerFor(session: SessionDescriptor, setModel: (model: string) => Promise<unknown>) {
  return {
    session,
    setModel,
  } as unknown as TranscriptPanelController
}

interface Harness {
  controller: TranscriptPanelController
  client: DaemonClient
  setModel: ReturnType<typeof vi.fn>
  restartSessionWithOverride: ReturnType<typeof vi.fn>
}

function harness(
  session: SessionDescriptor = descriptor(),
  live: SessionDescriptor = liveDescriptor(),
): Harness {
  const setModel = vi.fn(async (model: string) => ({
    ok: true,
    id: "s1",
    applied: true,
    model,
  }))
  const restartSessionWithOverride = vi.fn(async () => ({ id: "s2", label: "restarted" }))
  const client = {
    getAdapter: async () => ({
      slug: "claude-code",
      modelDetails: [{ id: CATALOG_MODEL, provider: "anthropic" }],
    }),
    getSession: async () => live,
    catalogModels: async () => undefined,
    restartSessionWithOverride,
    setSessionModel: setModel,
  } as unknown as DaemonClient
  return { controller: controllerFor(session, setModel), client, setModel, restartSessionWithOverride }
}

/** Pick the row whose label matches, out of the offered quick-pick items. */
function pickByLabel(items: readonly unknown[], label: string): unknown {
  const found = (items as Array<{ label?: string }>).find(i => i.label === label)
  if (!found) throw new Error(`no row labelled "${label}"`)
  return found
}

/** The rows the picker offered, captured from the quick-pick call. */
function captureOffered(): { rows: Array<{ label?: string; description?: string }> } {
  const state: { rows: Array<{ label?: string; description?: string }> } = { rows: [] }
  vi.spyOn(vscode.window, "showQuickPick").mockImplementation((async (
    items: readonly unknown[],
  ) => {
    state.rows = items as Array<{ label?: string; description?: string }>
    return undefined
  }) as never)
  return state
}

describe("runChangeModelFlow", () => {
  it("sends the value the LIVE agent advertises, not the catalog id", async () => {
    const h = harness()
    const spy = vi
      .spyOn(vscode.window, "showQuickPick")
      .mockImplementation((async (items: readonly unknown[]) =>
        pickByLabel(items, LIVE_MODEL)) as never)

    await runChangeModelFlow(h.controller, h.client)

    expect(h.setModel).toHaveBeenCalledWith(LIVE_MODEL)
    expect(h.restartSessionWithOverride).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it("routes a catalog id the agent does NOT accept through the restart path", async () => {
    // The live agent advertises a DIFFERENT vocabulary: the catalog id is
    // not one of the values it accepts, so a live switch would be rejected.
    const h = harness(descriptor(), liveDescriptor([LIVE_MODEL]))
    const spy = vi
      .spyOn(vscode.window, "showQuickPick")
      .mockImplementation((async (items: readonly unknown[]) =>
        pickByLabel(items, CATALOG_MODEL)) as never)
    const confirm = vi
      .spyOn(vscode.window, "showWarningMessage")
      .mockResolvedValue("Restart & switch" as never)

    await runChangeModelFlow(h.controller, h.client)

    expect(h.setModel).not.toHaveBeenCalled()
    expect(h.restartSessionWithOverride).toHaveBeenCalledTimes(1)
    expect(h.restartSessionWithOverride.mock.calls[0]?.[1]).toMatchObject({ model: CATALOG_MODEL })
    spy.mockRestore()
    confirm.mockRestore()
  })

  it("offers the agent's own value as a row even when the catalog does not list it", async () => {
    const h = harness()
    const offered = captureOffered()

    await runChangeModelFlow(h.controller, h.client)

    expect(offered.rows.map(i => i.label)).toContain(LIVE_MODEL)
    vi.restoreAllMocks()
  })

  it("flags a catalog id the agent does not accept as restart-only in the offered list", async () => {
    const h = harness(descriptor(), liveDescriptor([LIVE_MODEL]))
    const offered = captureOffered()

    await runChangeModelFlow(h.controller, h.client)

    const row = offered.rows.find(i => i.label === CATALOG_MODEL)
    expect(row?.description).toContain("not accepted live")
    vi.restoreAllMocks()
  })

  it("keeps the catalog-only behaviour when the session advertises no model vocabulary", async () => {
    const h = harness(descriptor(), descriptor())
    const spy = vi
      .spyOn(vscode.window, "showQuickPick")
      .mockImplementation((async (items: readonly unknown[]) =>
        pickByLabel(items, CATALOG_MODEL)) as never)

    await runChangeModelFlow(h.controller, h.client)

    expect(h.setModel).toHaveBeenCalledWith(CATALOG_MODEL)
    expect(h.restartSessionWithOverride).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
