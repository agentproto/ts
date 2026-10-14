/**
 * AIP-53 `ui.toolScope` enforcement under a verified link-SESSION token's
 * claims — `performAppToolCall`/`performBuiltinPanelToolCall`'s
 * `linkClaims` parameter, routed through `dispatchAllowlistedAppTool`'s
 * scoped mode. This is the actual security boundary: http-server.ts only
 * decides whether a request reaches these functions at all; this is what
 * decides which tool, with which arguments, it may run once it does.
 */

import { describe, expect, it, vi } from "vitest"
import { performAppToolCall, performBuiltinPanelToolCall } from "../app-tools.js"
import { createAppRegistry, type AppRegistry } from "../app-registry.js"

function bodyOf(result: { content: { text: string }[] }): unknown {
  return JSON.parse(result.content[0]!.text)
}

function registryWithScopedApp(): AppRegistry {
  const appRegistry = createAppRegistry()
  appRegistry.upsertApp({
    appId: "@agentik/session-chat",
    dir: "/nonexistent",
    agents: [],
    workflows: [],
    unvalidatedAgentTools: [],
    ui: {
      path: "/x.html",
      tools: ["conversation_read", "session_rename", "adapter_list"],
      toolScope: { conversation_read: { sessionId: "$link.sessionId" } },
    },
  })
  return appRegistry
}

const CLAIMS = { sessionId: "sess_abc", telegramUserId: "42" }

describe("performAppToolCall — scoped mode (linkClaims)", () => {
  it("a tool in ui.toolScope with no explicit arg gets the claim injected", async () => {
    const dispatchTool = vi.fn(async () => ({ transcript: [] }))
    const result = await performAppToolCall(
      registryWithScopedApp(),
      { appId: "@agentik/session-chat", tool: "conversation_read" },
      { dispatchTool },
      CLAIMS,
    )
    expect(dispatchTool).toHaveBeenCalledWith("conversation_read", { sessionId: "sess_abc" })
    expect(bodyOf(result)).toEqual({ transcript: [] })
  })

  it("an explicit arg MATCHING the claim is allowed through unchanged", async () => {
    const dispatchTool = vi.fn(async () => ({ ok: true }))
    await performAppToolCall(
      registryWithScopedApp(),
      { appId: "@agentik/session-chat", tool: "conversation_read", args: { sessionId: "sess_abc" } },
      { dispatchTool },
      CLAIMS,
    )
    expect(dispatchTool).toHaveBeenCalledWith("conversation_read", { sessionId: "sess_abc" })
  })

  it("an explicit arg that DIFFERS from the claim is refused — the whole point of scoping", async () => {
    const dispatchTool = vi.fn(async () => ({ ok: true }))
    const result = await performAppToolCall(
      registryWithScopedApp(),
      { appId: "@agentik/session-chat", tool: "conversation_read", args: { sessionId: "sess_SOMEONE_ELSE" } },
      { dispatchTool },
      CLAIMS,
    )
    expect(dispatchTool).not.toHaveBeenCalled()
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(JSON.stringify(bodyOf(result))).toMatch(/does not match/)
  })

  it("a tool in ui.tools but NOT in ui.toolScope is refused under a scoped link, even though it's otherwise allowlisted", async () => {
    const dispatchTool = vi.fn(async () => ({ ok: true }))
    const result = await performAppToolCall(
      registryWithScopedApp(),
      { appId: "@agentik/session-chat", tool: "session_rename", args: { sessionId: "sess_abc", name: "x" } },
      { dispatchTool },
      CLAIMS,
    )
    expect(dispatchTool).not.toHaveBeenCalled()
    expect((result as { isError?: boolean }).isError).toBe(true)
  })

  it("APP_UI_DISCOVERY_TOOLS are NOT automatically granted under a scoped link (fail-closed, no union)", async () => {
    const dispatchTool = vi.fn(async () => ["x"])
    const result = await performAppToolCall(
      registryWithScopedApp(),
      { appId: "@agentik/session-chat", tool: "adapter_list" },
      { dispatchTool },
      CLAIMS,
    )
    expect(dispatchTool).not.toHaveBeenCalled()
    expect((result as { isError?: boolean }).isError).toBe(true)
  })

  it("app_link_mint is unconditionally refused through this gateway, scoped or not", async () => {
    const dispatchTool = vi.fn(async () => ({ token: "x" }))
    const unscoped = await performAppToolCall(
      registryWithScopedApp(),
      { appId: "@agentik/session-chat", tool: "app_link_mint", args: {} },
      { dispatchTool },
    )
    const scoped = await performAppToolCall(
      registryWithScopedApp(),
      { appId: "@agentik/session-chat", tool: "app_link_mint", args: {} },
      { dispatchTool },
      CLAIMS,
    )
    expect(dispatchTool).not.toHaveBeenCalled()
    expect((unscoped as { isError?: boolean }).isError).toBe(true)
    expect((scoped as { isError?: boolean }).isError).toBe(true)
  })

  it("a toolScope claim the token doesn't carry is refused with a clear error", async () => {
    const appRegistry = createAppRegistry()
    appRegistry.upsertApp({
      appId: "@x/app",
      dir: "/nonexistent",
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
      ui: { path: "/x.html", tools: ["conversation_read"], toolScope: { conversation_read: { sessionId: "$link.sessionId" } } },
    })
    const dispatchTool = vi.fn(async () => ({}))
    const result = await performAppToolCall(
      appRegistry,
      { appId: "@x/app", tool: "conversation_read" },
      { dispatchTool },
      { telegramUserId: "42" }, // no sessionId claim
    )
    expect(dispatchTool).not.toHaveBeenCalled()
    expect((result as { isError?: boolean }).isError).toBe(true)
  })

  it("without linkClaims, behaviour is exactly the normal ui.tools allowlist (unchanged)", async () => {
    const dispatchTool = vi.fn(async () => ({ ok: true }))
    const result = await performAppToolCall(
      registryWithScopedApp(),
      { appId: "@agentik/session-chat", tool: "session_rename", args: { sessionId: "sess_abc", name: "x" } },
      { dispatchTool },
    )
    expect(dispatchTool).toHaveBeenCalledWith("session_rename", { sessionId: "sess_abc", name: "x" })
    expect((result as { isError?: boolean }).isError).toBeUndefined()
  })
})

describe("performBuiltinPanelToolCall — scoped mode always fails closed", () => {
  it("a builtin panel declares no ui.toolScope, so ANY scoped call is refused", async () => {
    const dispatchTool = vi.fn(async () => ({ ok: true }))
    const result = await performBuiltinPanelToolCall(
      ["session_rename"],
      { appId: "@agentproto/sessions-panel", tool: "session_rename", args: { sessionId: "sess_abc" } },
      { dispatchTool },
      CLAIMS,
    )
    expect(dispatchTool).not.toHaveBeenCalled()
    expect((result as { isError?: boolean }).isError).toBe(true)
  })

  it("without linkClaims, a builtin panel's normal allowlist is unaffected", async () => {
    const dispatchTool = vi.fn(async () => ({ ok: true }))
    const result = await performBuiltinPanelToolCall(
      ["session_rename"],
      { appId: "@agentproto/sessions-panel", tool: "session_rename", args: { sessionId: "sess_abc" } },
      { dispatchTool },
    )
    expect(dispatchTool).toHaveBeenCalled()
    expect((result as { isError?: boolean }).isError).toBeUndefined()
  })
})
