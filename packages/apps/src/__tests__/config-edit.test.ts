/**
 * Real-DOM coverage for `@agentproto/config`'s edit flows (PR-7): the panel
 * is loaded through jsdom with `runScripts: "dangerously"` and a fake
 * `window.McpApp` bridge stands in for the daemon, the same pattern
 * `packages/vscode/src/webview/panelBridgeStandalone.dom.test.ts` uses for
 * `WORK_BOARD_HTML` — a real guest script driven against a scripted bridge,
 * not a hand-modeled re-implementation of the panel's logic.
 *
 * Each test stubs exactly the daemon tool calls its flow needs; every other
 * tool call gets the same "unknown daemon tool" text a pre-PR-2 daemon
 * would answer, which the panel already tolerates.
 */
import type { DomElement, DomWindow } from "jsdom"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, it, vi } from "vitest"

import { CONFIG_HTML } from "../config/ui.js"

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true }

interface ToolCall {
  tool: string
  args: Record<string, unknown>
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] }
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true }
}

type ToolHandler = (args: Record<string, unknown>) => ToolResult

interface Panel {
  window: DomWindow
  calls: ToolCall[]
  updateModelContextCalls: unknown[]
  teardown(): void
}

const openWindows: DomWindow[] = []

/** Minimal fixtures every section's initial load needs so a test that only
 *  cares about ONE flow doesn't have to hand-write every tool response. */
function baseHandlers(): Record<string, ToolHandler> {
  return {
    daemon_health: () => ok({ version: "1.2.3" }),
    auth_profile_list: () => ok({ profiles: [] }),
    usage_rollup: () => ok({ window: "7d", total: {} }),
    harness_preset_list: () => ok({ presets: [] }),
    remote_status: () => ok({ enabled: false }),
    pair_list: () => ok({ pairings: [] }),
    tunnel_list: () => ok({ tunnels: [] }),
    adapter_list: () => ok({ adapters: [] }),
    harness_capabilities: () => ok({ capabilities: [] }),
    role_list: () => ok({ roles: [] }),
    catalog_models: () => ok({ routes: [] }),
    config_get: () => ok({ revision: "rev1", path: "/tmp/config.json", keys: [] }),
  }
}

function renderPanel(overrides: Record<string, ToolHandler>): Panel {
  const calls: ToolCall[] = []
  const updateModelContextCalls: unknown[] = []
  const handlers = { ...baseHandlers(), ...overrides }
  let teardownCb: (() => void) | undefined

  const dom = new JSDOM(CONFIG_HTML, {
    runScripts: "dangerously",
    url: "https://example.test/",
    beforeParse(window) {
      window.McpApp = {
        connect: () =>
          Promise.resolve({
            callTool: (name: string, args: Record<string, unknown>) => {
              if (name !== "app_tool_call") return Promise.resolve(ok({}))
              const tool = String(args.tool)
              const toolArgs = (args.args as Record<string, unknown>) ?? {}
              calls.push({ tool, args: toolArgs })
              const handler = handlers[tool]
              if (!handler) return Promise.resolve(fail(`unknown daemon tool: ${tool}`))
              return Promise.resolve(handler(toolArgs))
            },
            updateModelContext: (ctx: unknown) => {
              updateModelContextCalls.push(ctx)
              return Promise.resolve()
            },
            openLink: () => {},
            onTeardown: (cb: () => void) => {
              teardownCb = cb
            },
          }),
      }
    },
  })
  openWindows.push(dom.window)
  return {
    window: dom.window,
    calls,
    updateModelContextCalls,
    teardown() {
      teardownCb?.()
    },
  }
}

async function settle(ms = 30): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function navigate(window: DomWindow, hash: string): void {
  window.location.hash = hash
  window.dispatchEvent(new window.Event("hashchange"))
}

function el(window: DomWindow, id: string): DomElement {
  const found = window.document.getElementById(id)
  if (!found) throw new Error(`#${id} not found in rendered panel`)
  return found
}

function click(window: DomWindow, node: DomElement): void {
  node.dispatchEvent(new window.Event("click"))
}

function change(window: DomWindow, node: DomElement): void {
  node.dispatchEvent(new window.Event("change"))
}

afterEach(() => {
  while (openWindows.length) openWindows.pop()!.close()
  vi.restoreAllMocks()
})

describe("config app edit flows (real panel script, fake McpApp bridge)", () => {
  it("boots against a fake bridge and renders the wallets section by default", async () => {
    const panel = renderPanel({
      auth_profile_list: () =>
        ok({ profiles: [{ id: "p1", endpoint: "anthropic", method: "api-key", keyStatus: "stored", disabled: false }] }),
    })
    await settle(50)
    const cards = panel.window.document.querySelectorAll("#wallet-cards .card")
    expect(cards.length).toBe(1)
    expect(el(panel.window, "sec-wallets").classList.contains("active")).toBe(true)
  })

  it("calls config_set with the last known revision when a Defaults toggle is flipped", async () => {
    const panel = renderPanel({
      config_get: args => {
        if (args.section === "defaults") {
          return ok({
            revision: "rev-abc",
            path: "/tmp/config.json",
            keys: [
              {
                path: "defaults.langfuseTracing",
                value: false,
                effective: false,
                source: "config",
                apply: "restart",
                pendingRestart: false,
                writable: true,
              },
            ],
          })
        }
        return ok({ revision: "rev-abc", path: "/tmp/config.json", keys: [] })
      },
      config_set: args => ok({ ok: true, key: args.key, applied: "restart-required", revision: "rev-next" }),
    })
    await settle(50)
    navigate(panel.window, "#defaults")
    await settle(50)

    const checkbox = panel.window.document.querySelector('[data-cfg-auto="defaults.langfuseTracing"]')
    expect(checkbox).toBeTruthy()
    expect(checkbox!.checked).toBe(false)

    checkbox!.checked = true
    change(panel.window, checkbox!)
    await settle(50)

    const setCall = panel.calls.find(c => c.tool === "config_set")
    expect(setCall).toBeTruthy()
    expect(setCall!.args).toMatchObject({ key: "defaults.langfuseTracing", value: true, revision: "rev-abc" })
  })

  it("shows a stale_revision notice and reloads the section instead of applying the write", async () => {
    let configGetCalls = 0
    const panel = renderPanel({
      config_get: args => {
        if (args.section === "defaults") {
          configGetCalls += 1
          return ok({
            revision: "rev-1",
            path: "/tmp/config.json",
            keys: [
              {
                path: "defaults.langfuseTracing",
                value: false,
                effective: false,
                source: "config",
                apply: "restart",
                pendingRestart: false,
                writable: true,
              },
            ],
          })
        }
        return ok({ revision: "rev-1", path: "/tmp/config.json", keys: [] })
      },
      config_set: () => fail("config_set failed [stale_revision]: the config file changed since this revision was read."),
    })
    await settle(50)
    navigate(panel.window, "#defaults")
    await settle(50)
    expect(configGetCalls).toBe(1)

    const checkbox = panel.window.document.querySelector('[data-cfg-auto="defaults.langfuseTracing"]')!
    checkbox.checked = true
    change(panel.window, checkbox)
    await settle(50)

    expect(el(panel.window, "toast").textContent).toMatch(/changed elsewhere/i)
    // onStale reloads the WHOLE section (loadDefaults), a second config_get
    // for section "defaults" beyond the initial load.
    expect(configGetCalls).toBe(2)
  })

  it("renders a writable:false row as a disabled control with the reason in its title", async () => {
    const panel = renderPanel({
      config_get: args => {
        if (args.section === "defaults") {
          return ok({
            revision: "rev-1",
            path: "/tmp/config.json",
            keys: [
              {
                path: "daemon.port",
                value: 18790,
                effective: 18790,
                source: "config",
                apply: "restart",
                pendingRestart: false,
                writable: false,
              },
            ],
          })
        }
        return ok({ revision: "rev-1", path: "/tmp/config.json", keys: [] })
      },
    })
    await settle(50)
    navigate(panel.window, "#defaults")
    await settle(50)

    const input = panel.window.document.querySelector('[data-cfg-auto="daemon.port"]')
    expect(input).toBeTruthy()
    expect(input!.disabled).toBe(true)
    expect(input!.getAttribute("title")).toBeTruthy()
  })

  it("clears the credential field (DOM and JS variable) right after auth_profile_create submits, and never echoes it", async () => {
    const secret = "sk-super-secret-value"
    const panel = renderPanel({
      auth_profile_create: () => ok({ profile: { id: "new-wallet", endpoint: "anthropic", method: "api-key" } }),
    })
    await settle(50)
    navigate(panel.window, "#wallets")
    await settle(30)

    click(panel.window, el(panel.window, "wallet-add-toggle"))
    await settle(10)

    const idInput = el(panel.window, "wf-id")
    const endpointInput = el(panel.window, "wf-endpoint")
    const credentialInput = el(panel.window, "wf-credential")
    idInput.value = "new-wallet"
    endpointInput.value = "anthropic"
    credentialInput.value = secret

    click(panel.window, el(panel.window, "wf-submit"))
    // The field must be cleared SYNCHRONOUSLY on submit, before the async
    // auth_profile_create call even resolves.
    expect(credentialInput.value).toBe("")

    await settle(50)
    expect(credentialInput.value).toBe("")
    const createCall = panel.calls.find(c => c.tool === "auth_profile_create")
    expect(createCall?.args.credential).toBe(secret) // the daemon still needs it, once, in the request
    expect(JSON.stringify(panel.updateModelContextCalls)).not.toContain(secret)
  })

  it("blocks wallet delete client-side when a harness preset still references it, without calling auth_profile_delete", async () => {
    const panel = renderPanel({
      auth_profile_list: () =>
        ok({ profiles: [{ id: "p1", endpoint: "anthropic", method: "api-key", keyStatus: "stored", disabled: false }] }),
      harness_preset_list: () =>
        ok({
          presets: [
            { id: "pr1", harnessSlug: "claude-code", name: "Cheap", profileRef: "p1", defaultModel: "x", isDefault: true, profileDisabled: false },
          ],
        }),
      auth_profile_delete: () => ok({ deleted: true }),
    })
    await settle(50)

    const deleteBtn = panel.window.document.querySelector('[data-wallet-delete="p1"]')!
    click(panel.window, deleteBtn) // arm
    await settle(10)
    click(panel.window, deleteBtn) // confirm -> should be blocked
    await settle(30)

    expect(el(panel.window, "toast").textContent).toMatch(/cannot delete/i)
    expect(panel.calls.some(c => c.tool === "auth_profile_delete")).toBe(false)
  })

  it("deletes a wallet with no referencing preset after the second confirm click", async () => {
    const panel = renderPanel({
      auth_profile_list: () =>
        ok({ profiles: [{ id: "p1", endpoint: "anthropic", method: "api-key", keyStatus: "stored", disabled: false }] }),
      auth_profile_delete: () => ok({ deleted: true }),
    })
    await settle(50)

    const deleteBtn = panel.window.document.querySelector('[data-wallet-delete="p1"]')!
    click(panel.window, deleteBtn)
    await settle(10)
    click(panel.window, deleteBtn)
    await settle(30)

    expect(panel.calls.some(c => c.tool === "auth_profile_delete")).toBe(true)
    expect(panel.window.document.querySelector('[data-wallet-delete="p1"]')).toBeFalsy()
  })

  it("shows the remote_enable one-time reveal, then clears it from the DOM after navigating away and back", async () => {
    const bearer = "AGENTPROTO_BEARER_TOKEN_XYZ"
    const panel = renderPanel({
      remote_enable: () => ok({ publicUrl: "https://x.test", bearerToken: bearer, phoneUrl: `https://x.test/#token=${bearer}` }),
    })
    await settle(50)
    navigate(panel.window, "#remote")
    await settle(30)

    const enableBtn = el(panel.window, "remote-enable-btn")
    click(panel.window, enableBtn) // arm
    await settle(10)
    click(panel.window, enableBtn) // confirm
    await settle(50)

    expect(panel.window.document.body.innerHTML).toContain(bearer)
    expect(JSON.stringify(panel.updateModelContextCalls)).not.toContain(bearer)

    navigate(panel.window, "#wallets")
    await settle(30)
    navigate(panel.window, "#remote")
    await settle(30)

    expect(panel.window.document.body.innerHTML).not.toContain(bearer)
  })

  it("clears a pending pairing offer reveal on host teardown", async () => {
    const offerUrl = "agentproto://pair?token=SUPER_SECRET_OFFER"
    const panel = renderPanel({
      pair_offer: () => ok({ url: offerUrl, fingerprint: "fp123", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    })
    await settle(50)
    navigate(panel.window, "#remote")
    await settle(30)

    click(panel.window, el(panel.window, "pair-offer-btn"))
    await settle(50)
    expect(panel.window.document.body.innerHTML).toContain(offerUrl)

    panel.teardown()
    expect(JSON.stringify(panel.updateModelContextCalls)).not.toContain("SUPER_SECRET_OFFER")
  })

  it("never sends any fake-response secret material to updateModelContext across a full session", async () => {
    const secret = "sk-live-do-not-leak"
    const bearer = "bearer-do-not-leak"
    const panel = renderPanel({
      auth_profile_create: () => ok({ profile: { id: "w", endpoint: "anthropic", method: "api-key" } }),
      remote_enable: () => ok({ publicUrl: "https://x.test", bearerToken: bearer }),
    })
    await settle(50)

    navigate(panel.window, "#wallets")
    await settle(20)
    click(panel.window, el(panel.window, "wallet-add-toggle"))
    await settle(10)
    el(panel.window, "wf-id").value = "w"
    el(panel.window, "wf-endpoint").value = "anthropic"
    el(panel.window, "wf-credential").value = secret
    click(panel.window, el(panel.window, "wf-submit"))
    await settle(50)

    navigate(panel.window, "#remote")
    await settle(30)
    const enableBtn = el(panel.window, "remote-enable-btn")
    click(panel.window, enableBtn)
    await settle(10)
    click(panel.window, enableBtn)
    await settle(50)

    const serialized = JSON.stringify(panel.updateModelContextCalls)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain(bearer)
  })
})
