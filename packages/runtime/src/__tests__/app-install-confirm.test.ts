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

  it("the token binds the payload — echoing it proceeds, replaying it on a DIFFERENT payload re-previews", () => {
    const payload = { url: "https://x.test/repo.git", sha: "deadbeef" }
    const preview = buildAppInstallPreview(payload)
    expect(appInstallConfirmationClass({ ...payload, confirm: preview.confirm })).toEqual({
      confirmed: true,
    })
    // Same token, different sha — the fingerprint no longer matches.
    expect(appInstallConfirmationClass({ url: "https://x.test/other.git", sha: "fedcba", confirm: preview.confirm })).toEqual(
      { confirmed: false },
    )
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
  const preview = buildAppInstallPreview(payload)

  it("first call returns a needsConfirmation preview and dispatches NOTHING", async () => {
    const dispatchTool = vi.fn(async () => [])
    const result = await performBuiltinPanelToolCall(
      STORE_UI_TOOLS,
      { appId: "@agentproto/store", tool: "app_install", args: payload },
      { dispatchTool },
    )
    const body = JSON.parse((result as { content: { text: string }[] }).content[0]!.text)
    expect(body.needsConfirmation).toBe(true)
    expect(body.confirm).toBe(preview.confirm)
    expect(body.url).toBe("https://x.test/repo.git")
    expect(body.sha).toBe("deadbeef")
    expect(body.runsBuildCommand).toBe(false)
    expect(dispatchTool).not.toHaveBeenCalled()
  })

  it("second call with the preview's confirm token dispatches app_install verbatim", async () => {
    const dispatchTool = vi.fn(async () => ({ installed: true }))
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
