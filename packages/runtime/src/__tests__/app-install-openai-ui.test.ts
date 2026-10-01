/**
 * `installed-app-extension-round-trip` (plan W-B task 1 + acceptance): the
 * normalized `ui.extensions.openai` block survives `performInstall`
 * structurally — `InstalledApp.ui.extensions` — and an app WITHOUT the
 * block installs with no extensions key at all (plan I1).
 */

import { beforeEach, afterEach, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineApp } from "@agentproto/app-kit"
import { defineAgent } from "@agentproto/agent"
import { defineWorkflow } from "@agentproto/workflow"
import { performInstall } from "../app-tools.js"
import { createAppRegistry, type AppRegistry } from "../app-registry.js"

const OPENAI_EXTENSION = {
  entrypoints: [{ type: "global" }, { type: "thread" }] as const,
  icons: [{ src: "data:image/svg+xml;base64,PHN2Zy8+", mimeType: "image/svg+xml" }] as const,
  display: { availableModes: ["inline", "fullscreen"] as const, preferredMode: "fullscreen" as const },
  mentions: { searchTool: "dossier_mentions" },
}

async function emitFixture(dir: string, appId: string, withOpenai: boolean): Promise<void> {
  await defineApp({
    id: appId,
    name: "Dossier desk",
    agents: [
      {
        agent: defineAgent({
          schema: "agent/v1",
          id: "worker",
          description: "A worker.",
          model: "claude-sonnet-5",
          workflows: [{ ref: "do-thing" }],
        }),
        body: "Work.",
      },
    ],
    workflows: [
      defineWorkflow({
        id: "do-thing",
        name: "Do thing",
        description: "Does a thing.",
        version: "0.1.0",
        inputs: {},
        outputs: {},
        steps: [{ id: "s1", kind: "tool", tool: "known_tool" }],
      }),
    ],
    ui: {
      html: "<html>dossier</html>",
      title: "Dossier desk",
      tools: ["dossier_list", "dossier_mentions"],
      ...(withOpenai ? { extensions: { openai: OPENAI_EXTENSION as never } } : {}),
    },
  }).emit(dir)
}

describe("performInstall — ui.extensions.openai carrier", () => {
  let dir: string
  let appRegistry: AppRegistry

  /** Minimal truthy AgentAdapterResolver — install only needs the adapter to RESOLVE. */
  const resolvableAdapter = async () => ({
    startSession: async () => ({ sessionId: "x", send: async function* () {}, cancel: async () => {}, close: async () => {} }),
    commandPreview: "mock",
  })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-install-openai-"))
    appRegistry = createAppRegistry()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("installed-app-extension-round-trip — the normalized declaration carries through to the persisted InstalledApp.ui.extensions", async () => {
    await emitFixture(dir, "@test/openai-app", true)
    const result = await performInstall(dir, appRegistry, async () => ["known_tool"], resolvableAdapter)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const ui = result.record.ui
    expect(ui).toBeDefined()
    expect(ui!.extensions?.openai).toEqual(OPENAI_EXTENSION)
    // The rest of the ui record is untouched by the extension carrier.
    expect(ui!.title).toBe("Dossier desk")
    expect(ui!.tools).toEqual(["dossier_list", "dossier_mentions"])

    // Structurally stable enough to round-trip JSON (apps.json persistence).
    expect(JSON.parse(JSON.stringify(ui!.extensions))).toEqual({ openai: OPENAI_EXTENSION })
  })

  it("app-without-openai-extension-is-unchanged — no extensions key on the installed record (I1)", async () => {
    await emitFixture(dir, "@test/plain-app", false)
    const result = await performInstall(dir, appRegistry, async () => ["known_tool"], resolvableAdapter)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.record.ui).toBeDefined()
    expect("extensions" in (result.record.ui ?? {})).toBe(false)
  })
})
