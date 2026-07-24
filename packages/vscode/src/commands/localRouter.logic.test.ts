import { describe, expect, it } from "vitest"

import type {
  LlmEndpointDescriptorResult,
  LlmEndpointReloadPacksResult,
} from "../client/types.js"
import {
  buildLinkQuickPickItems,
  localRouterErrorMessage,
  reloadLlmEndpointPacksMessage,
  setUpstreamLinkMessage,
  startLlmEndpointMessage,
  stopLlmEndpointMessage,
  testLlmEndpointUpstreamMessage,
  UNLINK_QUICK_PICK_LABEL,
} from "./localRouter.logic.js"

function desc(over: Partial<LlmEndpointDescriptorResult> = {}): LlmEndpointDescriptorResult {
  return {
    pid: 4242,
    port: 18090,
    baseUrl: "http://localhost:18090",
    status: "running",
    startedAt: "2026-07-24T10:00:00.000Z",
    ...over,
  }
}

describe("startLlmEndpointMessage", () => {
  it("names the port on a fresh spawn", () => {
    expect(startLlmEndpointMessage(desc({ port: 18090 }))).toBe("Started Local Router on :18090.")
  })

  it("distinguishes an idempotent already-running no-op", () => {
    expect(startLlmEndpointMessage(desc({ port: 9000, wasAlreadyRunning: true }))).toBe(
      "Local Router already running on :9000.",
    )
  })
})

describe("stopLlmEndpointMessage", () => {
  it("is a fixed confirmation string", () => {
    expect(stopLlmEndpointMessage()).toBe("Stopped the Local Router.")
  })
})

describe("reloadLlmEndpointPacksMessage", () => {
  function result(over: Partial<LlmEndpointReloadPacksResult> = {}): LlmEndpointReloadPacksResult {
    return {
      object: "packs.reload",
      reloaded: true,
      source: "/ws/packs.local.json",
      local_pack_ids: ["mine"],
      pack_ids: ["default", "xai", "mine"],
      count: 3,
      ...over,
    }
  }

  it("names the reloaded count and the local subset", () => {
    expect(reloadLlmEndpointPacksMessage(result())).toBe("Reloaded packs — 3 available (1 local).")
  })

  it("reports zero local packs when packs.local.json is absent", () => {
    expect(reloadLlmEndpointPacksMessage(result({ local_pack_ids: [], source: null, pack_ids: ["default"], count: 1 }))).toBe(
      "Reloaded packs — 1 available (0 local).",
    )
  })
})

describe("localRouterErrorMessage", () => {
  it("folds an Error's message into the start/stop verb", () => {
    expect(localRouterErrorMessage("start", new Error("boom"))).toBe(
      "Could not start the Local Router: boom",
    )
    expect(localRouterErrorMessage("stop", new Error("nope"))).toBe(
      "Could not stop the Local Router: nope",
    )
  })

  it("uses a packs-specific phrasing for the reload verb", () => {
    expect(localRouterErrorMessage("reload", new Error("HTTP 400 — packs.bad.models.z.provider: required non-empty string"))).toBe(
      "Could not reload the Local Router's packs: HTTP 400 — packs.bad.models.z.provider: required non-empty string",
    )
  })

  it("uses an upstream-specific phrasing for the test verb", () => {
    expect(localRouterErrorMessage("test", new Error("HTTP 500"))).toBe(
      "Could not test the Local Router upstream: HTTP 500",
    )
  })

  it("stringifies a non-Error rejection", () => {
    expect(localRouterErrorMessage("start", "raw")).toBe("Could not start the Local Router: raw")
  })
})

describe("testLlmEndpointUpstreamMessage", () => {
  it("reports an ok verdict with the status and detail", () => {
    expect(
      testLlmEndpointUpstreamMessage({ provider: "groq", ok: true, status: 200, detail: "authenticated ok" }),
    ).toBe("Upstream groq: OK (HTTP 200 — authenticated ok).")
  })

  it("reports a failed verdict with the status and detail", () => {
    expect(
      testLlmEndpointUpstreamMessage({ provider: "xai", ok: false, status: 401, detail: "credential rejected" }),
    ).toBe("Upstream xai: failed (HTTP 401 — credential rejected).")
  })

  it("reports a no-probe upstream", () => {
    expect(testLlmEndpointUpstreamMessage({ provider: "zai", ok: null, reason: "no-probe" })).toBe(
      "Upstream zai: no cheap probe available (no-probe).",
    )
  })
})

describe("buildLinkQuickPickItems", () => {
  it("lists eligible profiles then an unlink escape, marking the current link", () => {
    const items = buildLinkQuickPickItems({
      provider: "anthropic",
      linkedProfile: "an-key",
      eligible: [
        { id: "an-key", label: "Jeremy", method: "api-key", endpoint: "anthropic" },
        { id: "an-oauth", method: "oauth-bearer", endpoint: "anthropic" },
      ],
    })
    expect(items).toEqual([
      { label: "Jeremy (an-key)", description: "api-key · anthropic", profileId: "an-key", picked: true },
      { label: "an-oauth", description: "oauth-bearer · anthropic", profileId: "an-oauth", picked: false },
      {
        label: UNLINK_QUICK_PICK_LABEL,
        description: "authenticate this upstream from its per-provider env key",
        profileId: null,
        picked: false,
      },
    ])
  })

  it("marks the unlink escape as picked when the upstream is unlinked", () => {
    const items = buildLinkQuickPickItems({ provider: "groq", linkedProfile: null, eligible: [] })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ profileId: null, picked: true })
  })
})

describe("setUpstreamLinkMessage", () => {
  it("names the link and asks for a restart when required", () => {
    expect(
      setUpstreamLinkMessage({
        ok: true,
        provider: "anthropic",
        profileId: "claude-subs",
        applied: false,
        restartRequired: true,
      }),
    ).toBe("Linked anthropic → claude-subs — restart the Local Router to apply.")
  })

  it("says it applies on next start when no restart is required", () => {
    expect(
      setUpstreamLinkMessage({
        ok: true,
        provider: "openrouter",
        profileId: "or",
        applied: false,
        restartRequired: false,
      }),
    ).toBe("Linked openrouter → or — applies on next start.")
  })

  it("phrases an unlink", () => {
    expect(
      setUpstreamLinkMessage({
        ok: true,
        provider: "anthropic",
        profileId: null,
        cleared: true,
        applied: false,
        restartRequired: true,
      }),
    ).toBe("Unlinked anthropic (env key) — restart the Local Router to apply.")
  })
})

describe("localRouterErrorMessage — link", () => {
  it("uses an upstream-specific phrasing for the link verb", () => {
    expect(localRouterErrorMessage("link", new Error("nope"))).toBe(
      "Could not link the Local Router upstream: nope",
    )
  })
})
