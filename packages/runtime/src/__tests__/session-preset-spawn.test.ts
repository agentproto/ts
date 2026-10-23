import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnAgentSession } from "../session-spawn.js"
import { createSessionsRegistry } from "../sessions.js"
import { loadModelListSource } from "../model-list-store.js"
import type { UserPreset } from "../user-presets.js"

let previousHome: string | undefined
let home: string

beforeEach(async () => {
  previousHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-session-preset-spawn-"))
  process.env.HOME = home
  await mkdir(join(home, ".agentproto"), { recursive: true })
  await writeFile(
    join(home, ".agentproto", "model-lists.json"),
    JSON.stringify({
      version: 1,
      lists: [
        { id: "all-models", ids: ["acme/allowed", "acme/blocked"] },
        { id: "blocked", ids: ["acme/blocked"] },
      ],
    }),
  )
  await loadModelListSource()
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

function deps() {
  const registry = createSessionsRegistry({ persist: false })
  let started = 0
  return {
    started: () => started,
    deps: {
      registry,
      resolveAgentAdapter: async () => ({
        commandPreview: "mock",
        startSession: async () => {
          started++
          return {
            sessionId: "s",
            async *send() {
              yield { kind: "turn-end" as const, reason: "completed" as const }
            },
            async cancel() {},
            async close() {},
          }
        },
      }),
      loadDefaultsConfig: async () => undefined,
    },
  }
}

const blockedPreset: UserPreset = {
  id: "blocked",
  label: "Blocked",
  modelPolicy: { block: ["blocked"] },
}

describe("spawnAgentSession composes a preset's modelPolicy with the request's", () => {
  it("refuses a model the request allows but the preset blocks", async () => {
    const d = deps()
    const result = await spawnAgentSession(d.deps as never, {
      adapter: "opencode",
      cwd: "/tmp",
      model: "acme/blocked",
      modelPolicy: { allow: ["all-models"] },
      preset: blockedPreset,
      sessionPresets: [blockedPreset],
    } as never)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("model_policy_refused")
    expect(result.details).toMatchObject({ policyCode: "model_blocked" })
    expect(d.started()).toBe(0)
  })

  it("stores the composed policy on the descriptor so setModel keeps both rules", async () => {
    const d = deps()
    const result = await spawnAgentSession(d.deps as never, {
      adapter: "opencode",
      cwd: "/tmp",
      model: "acme/allowed",
      modelPolicy: { allow: ["all-models"] },
      preset: blockedPreset,
      sessionPresets: [blockedPreset],
    } as never)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.descriptor.modelPolicy?.all).toHaveLength(2)
  })
})

describe("spawnAgentSession applies the harness defaultFor preset", () => {
  it("uses the defaultFor preset's config when the request names no preset", async () => {
    const d = deps()
    const defaultPreset: UserPreset = {
      id: "harness-default",
      label: "Harness default",
      defaultFor: "opencode",
      model: "acme/allowed",
    }
    const result = await spawnAgentSession(d.deps as never, {
      adapter: "opencode",
      cwd: "/tmp",
      sessionPresets: [defaultPreset],
    } as never)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.descriptor.model).toBe("acme/allowed")
  })
})

describe("spawnAgentSession refuses a preset whose extends chain is broken", () => {
  it("returns session_preset_invalid for a missing extends target", async () => {
    const d = deps()
    const child: UserPreset = { id: "child", label: "Child", extends: ["missing"] }
    const result = await spawnAgentSession(d.deps as never, {
      adapter: "opencode",
      cwd: "/tmp",
      preset: child,
      sessionPresets: [child],
    } as never)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("session_preset_invalid")
    expect(result.details).toMatchObject({ presetCode: "unknown_extends" })
    expect(d.started()).toBe(0)
  })
})
