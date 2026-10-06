/**
 * The app-UI install-confirmation guard (S6): `app_install` routed through
 * an app panel's tool-call surface (`dispatchAllowlistedAppTool` — the
 * `POST /apps/:appId/tool-call` route + the builtin panels' bridge) requires
 * an explicit two-step confirmation: first call (no `confirm`) answers a
 * preview `{needsConfirmation: true, confirm: <token>, kind, url, …}` and
 * installs NOTHING; only a second call echoing that token (bound to the
 * payload by fingerprint) reaches `dispatchTool`. A direct MCP/CLI call
 * (the registered `server.tool("app_install")` handler) is unaffected —
 * unit-guarded here by exercising only the guard + dispatcher layer, never
 * the MCP registration.
 */

import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import {
  appInstallConfirmationClass,
  buildAppInstallPreview,
  performBuiltinPanelToolCall,
  performAppToolCall,
} from "../app-tools.js"
import { createAppRegistry, type AppRegistry } from "../app-registry.js"

const STORE_UI_TOOLS = [
  "app_catalog",
  "app_list",
  "app_install",
  "app_resync",
  "app_updates",
  "app_uninstall",
  "app_status",
] as const

describe("appInstallConfirmationClass / buildAppInstallPreview", () => {
  it("a fresh remote install (no confirm) classifies unconfirmed", () => {
    expect(appInstallConfirmationClass({ url: "https://x.test/repo.git" })).toEqual({
      confirmed: false,
    })
  })

  it("a non-install payload (dir/file/empty) is out of the guard's scope", () => {
    expect(appInstallConfirmationClass({ dir: "/tmp/app" })).toBeUndefined()
    expect(appInstallConfirmationClass({ file: "/tmp/x.agentapp" })).toBeUndefined()
    expect(appInstallConfirmationClass({})).toBeUndefined()
  })

  it("the preview echoes the EXACT fields the second call must repeat", () => {
    const preview = buildAppInstallPreview({ url: "https://x.test/app.agentapp", sha256: "abc123x" })
    expect(preview.needsConfirmation).toBe(true)
    expect(preview.kind).toBe("agentapp")
    expect(preview.sha256).toBe("abc123x")
    expect(preview.runsBuildCommand).toBe(false)

    const git = buildAppInstallPreview({
      url: "https://x.test/repo.git",
      ref: "v1",
      subdir: "apps/x",
      sha: "deadbeef",
      allowBuild: true,
    })
    expect(git.kind).toBe("git")
    expect(git.sha).toBe("deadbeef")
    expect(git.ref).toBe("v1")
    expect(git.subdir).toBe("apps/x")
    expect(git.runsBuildCommand).toBe(true)
  })

  it("the confirm value is a server-issued nonce — a payload hash computed OFF the server is refused", () => {
    const payload = { url: "https://x.test/repo.git", sha: "deadbeef" }
    // What a blind CSRF caller could derive: the OLD deterministic token was
    // exactly sha256(canonicalJson(payload)); forge it without any preview
    // call and try to confirm with it.
    const forged = createHash("sha256")
      .update(JSON.stringify(["agentproto-app-install-confirm-v1", payload.url, "git", null, payload.sha, null, null, false]))
      .digest("hex")
      .slice(0, 32)
    expect(appInstallConfirmationClass({ ...payload, confirm: forged })).toEqual({ confirmed: false })
    // A preview's nonce is not derivable from the payload at all.
    const preview = buildAppInstallPreview({ ...payload, confirm: undefined } as Record<string, unknown>)
    expect(preview.confirm).not.toBe(forged)
    expect(appInstallConfirmationClass({ ...payload, confirm: preview.confirm })).toEqual({ confirmed: true })
  })

  it("the nonce binds the payload — echoing it proceeds, replaying it on a DIFFERENT payload re-previews", () => {
    const payload = { url: "https://x.test/repo.git", sha: "deadbeef" }
    const preview = buildAppInstallPreview(payload)
    expect(appInstallConfirmationClass({ ...payload, confirm: preview.confirm })).toEqual({
      confirmed: true,
    })
    // Same token re-presented (or against any other payload) — the nonce is
    // single-use, it was consumed by the confirming call.
    expect(appInstallConfirmationClass({ ...payload, confirm: preview.confirm })).toEqual({ confirmed: false })
    expect(appInstallConfirmationClass({ url: "https://x.test/other.git", sha: "fedcba", confirm: preview.confirm })).toEqual(
      { confirmed: false },
    )
  })

  it("a MODIFIED payload presenting a live nonce is refused (and the nonce burned)", () => {
    const payload = { url: "https://x.test/repo.git", sha: "deadbeef" }
    const preview = buildAppInstallPreview(payload)
    expect(appInstallConfirmationClass({ ...payload, sha: "fedcba", confirm: preview.confirm })).toEqual({
      confirmed: false,
    })
    // The mismatching attempt still consumed the nonce — the unmodified
    // payload confirming right after shows a preview again, never installs.
    expect(appInstallConfirmationClass({ ...payload, confirm: preview.confirm })).toEqual({ confirmed: false })
  })

  it("an expired nonce is refused (5-minute TTL, injectable clock via fake timers)", () => {
    vi.useFakeTimers()
    try {
      const payload = { url: "https://x.test/repo.git", sha: "deadbeef" }
      const preview = buildAppInstallPreview(payload)
      expect(appInstallConfirmationClass({ ...payload, confirm: preview.confirm })).toEqual({ confirmed: true })
      vi.advanceTimersByTime(5 * 60 * 1000 + 1)
      const preview2 = buildAppInstallPreview(payload)
      vi.advanceTimersByTime(5 * 60 * 1000 + 1)
      expect(appInstallConfirmationClass({ ...payload, confirm: preview2.confirm })).toEqual({ confirmed: false })
    } finally {
      vi.useRealTimers()
    }
  })
})

/** A store allowlist slide — performBuiltinPanelToolCall against the real
 *  panel's own allowlist, the exact chain the POST route runs for it. */
function storeRegistry(): AppRegistry {
  const appRegistry = createAppRegistry()
  appRegistry.upsertApp({
    appId: "@agentproto/store",
    dir: "/nonexistent",
    agents: [],
    workflows: [],
    unvalidatedAgentTools: [],
  })
  return appRegistry
}

describe("panel-path install guard (dispatchAllowlistedAppTool)", () => {
  const payload = { url: "https://x.test/repo.git", sha: "deadbeef" }

  it("first call returns a needsConfirmation preview with a FRESH server nonce and dispatches NOTHING", async () => {
    const dispatchTool = vi.fn(async () => [])
    const first = await performBuiltinPanelToolCall(
      STORE_UI_TOOLS,
      { appId: "@agentproto/store", tool: "app_install", args: payload },
      { dispatchTool },
    )
    const body = JSON.parse((first as { content: { text: string }[] }).content[0]!.text)
    expect(body.needsConfirmation).toBe(true)
    expect(typeof body.confirm).toBe("string")
    expect(body.confirm).toMatch(/^[a-f0-9]{32}$/)
    expect(body.url).toBe("https://x.test/repo.git")
    expect(body.sha).toBe("deadbeef")
    expect(body.runsBuildCommand).toBe(false)
    expect(dispatchTool).not.toHaveBeenCalled()

    // A nonce issued for a DIFFERENT payload can't confirm THIS one (blind
    // substitute) — fresh preview again, and this preview's nonce is burned.
    const foreign = buildAppInstallPreview({ url: "https://x.test/other.git", sha: "fedcba" })
    const rejected = await performBuiltinPanelToolCall(
      STORE_UI_TOOLS,
      { appId: "@agentproto/store", tool: "app_install", args: { ...payload, confirm: foreign.confirm } },
      { dispatchTool },
    )
    expect(dispatchTool).not.toHaveBeenCalled()
    expect(JSON.parse((rejected as { content: { text: string }[] }).content[0]!.text).needsConfirmation).toBe(true)
  })

  it("second call with the preview's confirm token dispatches app_install verbatim", async () => {
    const dispatchTool = vi.fn(async () => ({ installed: true }))
    const first = await performBuiltinPanelToolCall(
      STORE_UI_TOOLS,
      { appId: "@agentproto/store", tool: "app_install", args: payload },
      { dispatchTool },
    )
    const preview = JSON.parse((first as { content: { text: string }[] }).content[0]!.text)
    const result = await performBuiltinPanelToolCall(
      STORE_UI_TOOLS,
      { appId: "@agentproto/store", tool: "app_install", args: { ...payload, confirm: preview.confirm } },
      { dispatchTool },
    )
    expect(dispatchTool).toHaveBeenCalledWith("app_install", { ...payload, confirm: preview.confirm })
    const body = JSON.parse((result as { content: { text: string }[] }).content[0]!.text)
    expect(body).toEqual({ installed: true })
  })

  it("an installed-app UI panel's tool-call path gets the SAME guard (performAppToolCall)", async () => {
    const sys = storeRegistry()
    sys.upsertApp({
      appId: "@some/panel",
      dir: "/nonexistent",
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
      ui: { path: "/x.html", tools: ["app_install"] },
    })
    const dispatchTool = vi.fn(async () => [])
    const result = await performAppToolCall(
      sys,
      { appId: "@some/panel", tool: "app_install", args: payload },
      { dispatchTool },
    )
    const body = JSON.parse((result as { content: { text: string }[] }).content[0]!.text)
    expect(body.needsConfirmation).toBe(true)
    expect(dispatchTool).not.toHaveBeenCalled()
  })
})
