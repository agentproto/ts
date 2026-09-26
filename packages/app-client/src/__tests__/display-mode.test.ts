/**
 * Tests for `@agentproto/app-client/display-mode` (`../display-mode.ts`) —
 * the one display-mode toggle both app UI paths now share (the built-in
 * panels' `panelBridgeScript`, and the `window.McpApp` bridge injected into
 * installed apps). This workspace's vitest config runs under `happy-dom`
 * (see `vitest.config.ts`), so the emitted ES5 is EXECUTED here and driven
 * against a real document rather than string-matched: the four behaviours
 * that were wrong or missing in the copies this replaces are exactly the
 * ones a string assertion can't see.
 *
 *   1. show/hide by `hostContext.availableDisplayModes`
 *   2. placement from `hostContext.safeAreaInsets`, re-synced on a later
 *      host-context change (the Codex "button under the host header" bug)
 *   3. `<meta name="agentproto-display-toggle" content="none">` opt-out, for
 *      an app that renders the toggle in its own header via `mountToggle`
 *   4. `optimistic`: visible against a host that advertises nothing, retired
 *      for good the first time that host refuses
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  DISPLAY_MODE_SCRIPT,
  DISPLAY_MODE_SCRIPT_BODY,
  DISPLAY_TOGGLE_META_NAME,
  type DisplayMode,
  type DisplayModeBridge,
  type DisplayModeController,
  type DisplayModeHostContext,
} from "../display-mode.js"

const BAR_ID = "agentproto-display-mode-bar"
const FULLSCREEN_ID = "agentproto-display-mode"
const PIP_ID = "agentproto-display-mode-pip"

/** A fake bridge with the same replay semantics the real ones have:
 *  `onHostContext` fires immediately with the current context, then on every
 *  `push()`. `requestDisplayMode` resolves/rejects on command. */
function fakeBridge(initial?: DisplayModeHostContext) {
  let ctx: DisplayModeHostContext = initial ?? {}
  const cbs: Array<(c: DisplayModeHostContext) => void> = []
  const requests: DisplayMode[] = []
  let answer: (mode: DisplayMode) => Promise<{ mode?: DisplayMode } | undefined> = async (
    mode,
  ) => ({ mode })

  const api: DisplayModeBridge = {
    getHostContext: () => ctx,
    onHostContext(cb) {
      cbs.push(cb)
      cb(ctx)
    },
    requestDisplayMode(mode) {
      requests.push(mode)
      return answer(mode)
    },
  }
  return {
    api,
    requests,
    /** Merge a host-context-changed payload and notify, like a real host. */
    push(next: DisplayModeHostContext) {
      ctx = { ...ctx, ...next }
      for (const cb of cbs) cb(ctx)
    },
    answerWith(fn: (mode: DisplayMode) => Promise<{ mode?: DisplayMode } | undefined>) {
      answer = fn
    },
  }
}

function install(
  api: DisplayModeBridge,
  opts?: { toggle?: "auto" | "none" | "optimistic" },
): DisplayModeController {
  if (!window.AgentprotoUI) throw new Error("AgentprotoUI not installed")
  return window.AgentprotoUI.installDisplayMode(api, opts)
}

function fullscreenBtn(): HTMLButtonElement {
  const el = document.getElementById(FULLSCREEN_ID)
  if (!(el instanceof window.HTMLButtonElement)) throw new Error("no fullscreen toggle")
  return el
}

function visible(el: HTMLElement | null): boolean {
  return !!el && el.style.display !== "none"
}

describe("DISPLAY_MODE_SCRIPT", () => {
  it("parses as a valid function body", () => {
    expect(() => new Function(DISPLAY_MODE_SCRIPT_BODY)).not.toThrow()
  })

  it("wraps the same body in a <script> tag for html injection", () => {
    expect(DISPLAY_MODE_SCRIPT).toContain("<script>")
    expect(DISPLAY_MODE_SCRIPT).toContain("</script>")
    expect(DISPLAY_MODE_SCRIPT).toContain(DISPLAY_MODE_SCRIPT_BODY)
  })

  it("carries no </script> sequence that would close its host tag early", () => {
    expect(DISPLAY_MODE_SCRIPT_BODY).not.toContain("</script>")
  })
})

describe("installDisplayMode (DOM, happy-dom)", () => {
  beforeAll(() => {
    // Evaluate the emitted script for real, exactly as a served page does.
    new Function(DISPLAY_MODE_SCRIPT_BODY)()
  })

  beforeEach(() => {
    document.body.innerHTML = ""
    document.head.querySelectorAll(`meta[name="${DISPLAY_TOGGLE_META_NAME}"]`).forEach((m) => {
      m.remove()
    })
    document.documentElement.removeAttribute("style")
    vi.restoreAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => {})
  })

  describe("visibility follows hostContext.availableDisplayModes", () => {
    it("stays hidden when the host advertises nothing (Claude Desktop's native control wins)", () => {
      install(fakeBridge({ displayMode: "inline", availableDisplayModes: [] }).api)
      expect(visible(document.getElementById(FULLSCREEN_ID))).toBe(false)
      expect(visible(document.getElementById(PIP_ID))).toBe(false)
    })

    it("shows the fullscreen toggle — and only it — when the host advertises fullscreen", () => {
      install(fakeBridge({ displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] }).api)
      expect(visible(document.getElementById(FULLSCREEN_ID))).toBe(true)
      expect(visible(document.getElementById(PIP_ID))).toBe(false)
    })

    it("shows the pip toggle too when the host advertises pip", () => {
      install(fakeBridge({ availableDisplayModes: ["inline", "fullscreen", "pip"] }).api)
      expect(visible(document.getElementById(PIP_ID))).toBe(true)
    })

    it("appears on a later host-context-changed, not only at initialize", () => {
      const host = fakeBridge({ displayMode: "inline", availableDisplayModes: [] })
      install(host.api)
      expect(visible(document.getElementById(FULLSCREEN_ID))).toBe(false)

      host.push({ availableDisplayModes: ["inline", "fullscreen"] })
      expect(visible(document.getElementById(FULLSCREEN_ID))).toBe(true)
    })

    it("flips glyph, label and aria-pressed with the current mode", () => {
      const host = fakeBridge({ displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] })
      install(host.api)
      const btn = fullscreenBtn()
      expect(btn.textContent).toBe("⤢")
      expect(btn.title).toBe("Agrandir")
      expect(btn.getAttribute("aria-label")).toBe("Agrandir")
      expect(btn.getAttribute("aria-pressed")).toBe("false")

      host.push({ displayMode: "fullscreen" })
      expect(btn.textContent).toBe("⤡")
      expect(btn.title).toBe("Réduire")
      expect(btn.getAttribute("aria-pressed")).toBe("true")
    })

    it("keeps the availableDisplayModes console diagnostic", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {})
      const host = fakeBridge({ displayMode: "inline", availableDisplayModes: ["fullscreen"] })
      install(host.api)
      expect(spy).toHaveBeenCalledWith(
        "[mcp-app] displayMode=",
        "inline",
        "availableDisplayModes=",
        ["fullscreen"],
      )
      // …and on every later change, not just at initialize.
      spy.mockClear()
      host.push({ displayMode: "fullscreen" })
      expect(spy).toHaveBeenCalledWith(
        "[mcp-app] displayMode=",
        "fullscreen",
        "availableDisplayModes=",
        ["fullscreen"],
      )
    })

    it("logs the host-context key names once — names only, never values", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {})
      const host = fakeBridge({
        displayMode: "inline",
        availableDisplayModes: ["fullscreen"],
        theme: "dark",
        safeAreaInsets: { top: 48 },
      })
      install(host.api)
      const keyLogs = spy.mock.calls.filter((c) => c[0] === "[mcp-app] hostContext keys=")
      expect(keyLogs).toHaveLength(1)
      expect(keyLogs[0]?.[1]).toBe("availableDisplayModes,displayMode,safeAreaInsets,theme")

      // A host that keeps pushing must not keep logging.
      host.push({ theme: "light" })
      expect(spy.mock.calls.filter((c) => c[0] === "[mcp-app] hostContext keys=")).toHaveLength(1)
    })
  })

  describe("requests", () => {
    it("asks for fullscreen from inline and for inline from fullscreen", async () => {
      const host = fakeBridge({ displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] })
      install(host.api)
      const btn = fullscreenBtn()

      btn.click()
      await Promise.resolve()
      expect(host.requests).toEqual(["fullscreen"])

      host.push({ displayMode: "fullscreen" })
      btn.click()
      await Promise.resolve()
      expect(host.requests).toEqual(["fullscreen", "inline"])
    })

    it("adopts the mode the host actually settled on, without waiting for a notification", async () => {
      // McpUiRequestDisplayModeResult.mode is authoritative and the spec lets
      // it differ from the request; a host that never follows up with
      // host-context-changed must still leave the button in the right state.
      const host = fakeBridge({ displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] })
      const ctl = install(host.api)
      await expect(ctl.request("fullscreen")).resolves.toBe("fullscreen")
      expect(ctl.get()).toBe("fullscreen")
      expect(fullscreenBtn().getAttribute("aria-pressed")).toBe("true")
    })

    it("reports the advertised modes through available()", () => {
      const ctl = install(fakeBridge({ availableDisplayModes: ["inline", "fullscreen"] }).api)
      expect(ctl.available()).toEqual(["inline", "fullscreen"])
      expect(install(fakeBridge({}).api).available()).toEqual([])
    })

    it("notifies onChange subscribers immediately and on every change", () => {
      const host = fakeBridge({ displayMode: "inline", availableDisplayModes: ["fullscreen"] })
      const ctl = install(host.api)
      const seen: DisplayMode[] = []
      const off = ctl.onChange((mode) => seen.push(mode))
      expect(seen).toEqual(["inline"])

      host.push({ displayMode: "fullscreen" })
      expect(seen).toEqual(["inline", "fullscreen"])

      off()
      host.push({ displayMode: "inline" })
      expect(seen).toEqual(["inline", "fullscreen"])
    })
  })

  describe("placement honours hostContext.safeAreaInsets", () => {
    it("offsets top/right past the host's chrome instead of the bare 8px both copies hard-coded", () => {
      install(
        fakeBridge({
          availableDisplayModes: ["fullscreen"],
          safeAreaInsets: { top: 44, right: 12, bottom: 0, left: 0 },
        }).api,
      )
      const root = document.documentElement
      expect(root.style.getPropertyValue("--agentproto-dm-safe-top")).toBe("52px")
      expect(root.style.getPropertyValue("--agentproto-dm-safe-right")).toBe("20px")
    })

    it("falls back to the plain 8px gap when the host sends no insets", () => {
      install(fakeBridge({ availableDisplayModes: ["fullscreen"] }).api)
      expect(document.documentElement.style.getPropertyValue("--agentproto-dm-safe-top")).toBe("8px")
      expect(document.documentElement.style.getPropertyValue("--agentproto-dm-safe-right")).toBe("8px")
    })

    it("re-syncs the offsets on host-context-changed", () => {
      const host = fakeBridge({ availableDisplayModes: ["fullscreen"] })
      install(host.api)
      host.push({ safeAreaInsets: { top: 60, right: 0 } })
      expect(document.documentElement.style.getPropertyValue("--agentproto-dm-safe-top")).toBe("68px")
      expect(document.documentElement.style.getPropertyValue("--agentproto-dm-safe-right")).toBe("8px")
    })

    it("leaves the app's own --agentproto-dm-top/right above the safe-area vars in the cascade", () => {
      install(fakeBridge({ availableDisplayModes: ["fullscreen"] }).api)
      const css = document.getElementById("agentproto-display-mode-style")?.textContent ?? ""
      expect(css).toContain("top:var(--agentproto-dm-top,var(--agentproto-dm-safe-top,8px))")
      expect(css).toContain("right:var(--agentproto-dm-right,var(--agentproto-dm-safe-right,8px))")
    })
  })

  describe("theme", () => {
    it("takes hostContext.theme when the host sends one", () => {
      const host = fakeBridge({ availableDisplayModes: ["fullscreen"], theme: "dark" })
      install(host.api)
      expect(fullscreenBtn().getAttribute("data-theme")).toBe("dark")

      host.push({ theme: "light" })
      expect(fullscreenBtn().getAttribute("data-theme")).toBe("light")
    })

    it("leaves data-theme off (so prefers-color-scheme decides) when the host sends none", () => {
      install(fakeBridge({ availableDisplayModes: ["fullscreen"] }).api)
      expect(fullscreenBtn().hasAttribute("data-theme")).toBe(false)
      const css = document.getElementById("agentproto-display-mode-style")?.textContent ?? ""
      expect(css).toContain("@media (prefers-color-scheme:dark)")
      // Every colour goes through an app-overridable custom property.
      expect(css).toContain("background:var(--agentproto-dm-bg,#fff)")
      expect(css).toContain("color:var(--agentproto-dm-fg,#1a1a1a)")
      expect(css).toContain("border:1px solid var(--agentproto-dm-border,#d0d0d0)")
    })
  })

  describe("app-controlled placement", () => {
    it('mounts no floating bar under <meta content="none">, leaving the app to place the toggle', () => {
      const meta = document.createElement("meta")
      meta.setAttribute("name", DISPLAY_TOGGLE_META_NAME)
      meta.setAttribute("content", "none")
      document.head.appendChild(meta)

      const ctl = install(fakeBridge({ availableDisplayModes: ["fullscreen"] }).api)
      expect(document.getElementById(BAR_ID)).toBeNull()

      const header = document.createElement("header")
      document.body.appendChild(header)
      const btn = ctl.mountToggle(header)
      expect(btn.parentElement).toBe(header)
      expect(visible(btn)).toBe(true)
      expect(document.getElementById(BAR_ID)).toBeNull()
    })

    it("lets an explicit toggle option override the meta", () => {
      const meta = document.createElement("meta")
      meta.setAttribute("name", DISPLAY_TOGGLE_META_NAME)
      meta.setAttribute("content", "none")
      document.head.appendChild(meta)

      install(fakeBridge({ availableDisplayModes: ["fullscreen"] }).api, { toggle: "auto" })
      expect(visible(document.getElementById(FULLSCREEN_ID))).toBe(true)
    })

    it("an inline toggle still follows availability and mode", () => {
      const host = fakeBridge({ availableDisplayModes: [] })
      const ctl = install(host.api, { toggle: "none" })
      const header = document.createElement("header")
      document.body.appendChild(header)
      const btn = ctl.mountToggle(header)
      expect(visible(btn)).toBe(false)

      host.push({ availableDisplayModes: ["fullscreen"] })
      expect(visible(btn)).toBe(true)
    })

    it("mounts only one floating bar when two bridges install in the same document", () => {
      // A built-in panel served standalone gets the injected window.McpApp
      // bridge's controller AND its own — two stacked buttons is a bug.
      install(fakeBridge({ availableDisplayModes: ["fullscreen"] }).api)
      install(fakeBridge({ availableDisplayModes: ["fullscreen"] }).api)
      expect(document.querySelectorAll(`#${BAR_ID}`)).toHaveLength(1)
      expect(document.querySelectorAll(".agentproto-dm-btn")).toHaveLength(2)
    })
  })

  describe("optimistic mode", () => {
    it("shows the toggle against a host that advertises nothing", () => {
      install(fakeBridge({ displayMode: "inline", availableDisplayModes: [] }).api, {
        toggle: "optimistic",
      })
      expect(visible(document.getElementById(FULLSCREEN_ID))).toBe(true)
      // Still only a guess about fullscreen — pip is never guessed at.
      expect(visible(document.getElementById(PIP_ID))).toBe(false)
    })

    it("opts in through the meta tag too", () => {
      const meta = document.createElement("meta")
      meta.setAttribute("name", DISPLAY_TOGGLE_META_NAME)
      meta.setAttribute("content", "optimistic")
      document.head.appendChild(meta)
      install(fakeBridge({ availableDisplayModes: [] }).api)
      expect(visible(document.getElementById(FULLSCREEN_ID))).toBe(true)
    })

    it("hides the toggle permanently when the host rejects the request", async () => {
      const host = fakeBridge({ availableDisplayModes: [] })
      host.answerWith(async () => {
        throw new Error("ui/request-display-mode: method not found")
      })
      install(host.api, { toggle: "optimistic" })
      const btn = fullscreenBtn()
      expect(visible(btn)).toBe(true)

      btn.click()
      await vi.waitFor(() => expect(visible(btn)).toBe(false))

      // …and a later host-context-changed can't resurrect it.
      host.push({ availableDisplayModes: ["fullscreen"] })
      expect(visible(btn)).toBe(false)
    })

    it("treats a result that settles on another mode as a refusal", async () => {
      const host = fakeBridge({ availableDisplayModes: [] })
      host.answerWith(async () => ({ mode: "inline" }))
      const ctl = install(host.api, { toggle: "optimistic" })
      const btn = fullscreenBtn()

      await expect(ctl.request("fullscreen")).rejects.toThrow(/refused/)
      expect(visible(btn)).toBe(false)
    })

    it("keeps the toggle when the host honours the unadvertised request", async () => {
      const host = fakeBridge({ availableDisplayModes: [] })
      const ctl = install(host.api, { toggle: "optimistic" })
      await expect(ctl.request("fullscreen")).resolves.toBe("fullscreen")
      expect(visible(fullscreenBtn())).toBe(true)
      expect(ctl.get()).toBe("fullscreen")
    })

    it("leaves a non-optimistic toggle alone when a request fails", async () => {
      const host = fakeBridge({ availableDisplayModes: ["fullscreen"] })
      host.answerWith(async () => {
        throw new Error("transient")
      })
      const ctl = install(host.api)
      const btn = fullscreenBtn()
      await expect(ctl.request("fullscreen")).rejects.toThrow("transient")
      // The host says it CAN do fullscreen — one failed call isn't a verdict.
      expect(visible(btn)).toBe(true)
    })
  })
})
