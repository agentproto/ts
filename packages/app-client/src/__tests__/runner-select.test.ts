/**
 * Tests for `@agentproto/app-client/runner-select` (`../runner-select.ts`):
 * script injection (idempotency + placement, mirroring `injectMcpAppBridge`'s
 * own test suite), the raw `RUNNER_SELECT_SCRIPT` parsing as valid JS, and —
 * since this workspace's vitest config already runs under `happy-dom` (see
 * `vitest.config.ts`) — a DOM test that evaluates the script for real and
 * drives `window.AgentprotoUI.mountRunnerSelect` with a fake `callTool`.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  APP_UI_DISCOVERY_TOOLS,
  injectRunnerSelect,
  RUNNER_SELECT_SCRIPT,
  type RunnerSelectOptions,
} from "../runner-select.js"

function scriptBody(script: string): string {
  return script.replace(/^<script>/, "").replace(/<\/script>\s*$/, "")
}

describe("APP_UI_DISCOVERY_TOOLS", () => {
  it("is the read-only discovery pair", () => {
    expect(APP_UI_DISCOVERY_TOOLS).toEqual(["adapter_list", "harness_preset_list"])
  })
})

describe("RUNNER_SELECT_SCRIPT", () => {
  it("parses as a valid function body", () => {
    expect(() => new Function(scriptBody(RUNNER_SELECT_SCRIPT))).not.toThrow()
  })
})

describe("injectRunnerSelect", () => {
  it("injects right after <head> when present", () => {
    const html = "<html><head><title>t</title></head><body>Panel</body></html>"
    const out = injectRunnerSelect(html)
    expect(out).toContain("AgentprotoUI")
    expect(out.indexOf("AgentprotoUI")).toBeLessThan(out.indexOf("<title>"))
  })

  it("falls back to <body> when there is no <head>", () => {
    const html = "<html><body>Panel</body></html>"
    const out = injectRunnerSelect(html)
    expect(out.indexOf("AgentprotoUI")).toBeLessThan(out.indexOf("Panel"))
  })

  it("falls back to <html> when there is neither <head> nor <body>", () => {
    const html = "<html>Panel</html>"
    const out = injectRunnerSelect(html)
    expect(out.indexOf("AgentprotoUI")).toBeLessThan(out.indexOf("Panel"))
  })

  it("falls back to prepending when there is no structural tag at all", () => {
    const out = injectRunnerSelect("Panel")
    expect(out.indexOf("AgentprotoUI")).toBeLessThan(out.indexOf("Panel"))
  })

  it("is idempotent: a no-op when the html already defines window.AgentprotoUI", () => {
    const html = "<html><head><script>window.AgentprotoUI = {};</script></head><body>Panel</body></html>"
    expect(injectRunnerSelect(html)).toBe(html)
  })

  it("only injects once even if run twice", () => {
    const html = "<html><body>Panel</body></html>"
    const once = injectRunnerSelect(html)
    const twice = injectRunnerSelect(once)
    expect(twice).toBe(once)
  })
})

describe("mountRunnerSelect (DOM, happy-dom)", () => {
  beforeAll(() => {
    // Evaluate the injected script for real, the same way a served app's
    // page would — this defines window.AgentprotoUI.mountRunnerSelect once.
    new Function(scriptBody(RUNNER_SELECT_SCRIPT))()
  })

  beforeEach(() => {
    window.localStorage.clear()
    document.body.innerHTML = ""
  })

  function mount(opts: RunnerSelectOptions) {
    if (!window.AgentprotoUI) throw new Error("AgentprotoUI not installed")
    const container = document.createElement("div")
    document.body.appendChild(container)
    const handle = window.AgentprotoUI.mountRunnerSelect(container, opts)
    return { container, handle }
  }

  it("renders discovered harnesses (default-preset label + disabled suffix) and the model datalist", async () => {
    const calls: Array<{ tool: string; args?: object }> = []
    const { container, handle } = mount({
      callTool: async (tool, args) => {
        calls.push({ tool, args })
        if (tool === "harness_preset_list") {
          return {
            presets: [
              {
                id: "hm-cheap",
                harnessSlug: "hermes",
                name: "Cheap",
                profileRef: "p1",
                defaultModel: "z-ai/glm-5.2",
                isDefault: true,
                profileDisabled: true,
              },
            ],
          }
        }
        if (tool === "adapter_list") {
          // Daemon 0.20+ paginated page envelope with the COMPACT rows —
          // exactly what the picker asks for (limit 50, no fields).
          return {
            items: [
              { slug: "hermes", name: "Hermes", version: "1.0.0", protocol: "acp", installed: true, modelCount: 2 },
              { slug: "claude-code", name: "Claude Code", version: "2.0.0", protocol: "acp", installed: true, modelCount: 0 },
            ],
            total: 2,
          }
        }
        throw new Error(`unexpected tool ${tool}`)
      },
    })
    await handle.refresh()

    // Budget-safe request: bounded COMPACT pages, no fields filter (an
    // explicit fields list bypasses the compact projection and would
    // re-ship the unbounded model arrays).
    expect(calls).toContainEqual({ tool: "adapter_list", args: { limit: 50 } })

    const select = container.querySelector("select")
    if (!select) throw new Error("no select rendered")
    expect(select.options.length).toBe(2)
    expect(select.options[0]?.value).toBe("hermes")
    expect(select.options[0]?.textContent).toBe("Hermes — Cheap (profile disabled)")
    expect(select.options[1]?.textContent).toBe("Claude Code")
    // First adapter auto-selected since neither defaults nor storage pinned one.
    expect(select.value).toBe("hermes")

    const input = container.querySelector("input")
    if (!input) throw new Error("no input rendered")
    expect(input.placeholder).toBe("z-ai/glm-5.2")

    const datalist = container.querySelector("datalist")
    if (!datalist) throw new Error("no datalist rendered")
    // Compact rows carry no model array — the preset's defaultModel seeds
    // the suggestions; the input stays free-text for anything else.
    expect(Array.from(datalist.options).map(o => o.value)).toEqual(["z-ai/glm-5.2"])

    expect(handle.getRunner()).toEqual({ harness: "hermes" })
  })

  it("filters not-installed catalog rows out of the harness dropdown and seeds the auto-selection from the first installed row", async () => {
    const { container, handle } = mount({
      callTool: async tool => {
        if (tool === "harness_preset_list") return { presets: [] }
        return {
          items: [
            { slug: "ghost", name: "Ghost", installed: false, modelCount: 0 },
            { slug: "hermes", name: "Hermes", installed: true, modelCount: 3 },
          ],
          total: 2,
        }
      },
    })
    await handle.refresh()

    const select = container.querySelector("select")
    if (!select) throw new Error("no select rendered")
    // The not-installed row is NOT offered as a spawnable harness; the
    // auto-selection came from the first INSTALLED row, not adapters[0].
    expect(Array.from(select.options).map(o => o.value)).toEqual(["hermes"])
    expect(select.value).toBe("hermes")
    expect(handle.getRunner()).toEqual({ harness: "hermes" })
  })

  it("restores a stored selection over defaults, keeping it as an option even before discovery resolves", () => {
    window.localStorage.setItem("agentproto.runner", JSON.stringify({ harness: "aider", model: "gpt-5" }))
    const { container, handle } = mount({
      callTool: () => new Promise(() => {}), // never resolves — mount must not block on it
      defaults: { harness: "hermes" },
    })

    expect(handle.getRunner()).toEqual({ harness: "aider", model: "gpt-5" })
    const select = container.querySelector("select")
    expect(select?.value).toBe("aider")
    const input = container.querySelector("input")
    expect(input?.value).toBe("gpt-5")
  })

  it("persists on every change and calls onChange", () => {
    const changes: Array<{ harness: string; model?: string }> = []
    const { container, handle } = mount({
      callTool: () => new Promise(() => {}),
      defaults: { harness: "hermes" },
      onChange: sel => changes.push(sel),
    })

    const input = container.querySelector("input")
    if (!input) throw new Error("no input rendered")
    input.value = "gpt-5"
    input.dispatchEvent(new Event("input"))

    expect(handle.getRunner()).toEqual({ harness: "hermes", model: "gpt-5" })
    expect(changes.at(-1)).toEqual({ harness: "hermes", model: "gpt-5" })
    const stored: unknown = JSON.parse(window.localStorage.getItem("agentproto.runner") ?? "{}")
    expect(stored).toEqual({ harness: "hermes", model: "gpt-5" })
  })

  it("omits model from getRunner() when blank", () => {
    const { handle } = mount({ callTool: () => new Promise(() => {}), defaults: { harness: "hermes" } })
    expect(handle.getRunner()).toEqual({ harness: "hermes" })
  })

  it("page-walks adapter_list until done and reassembles every adapter", async () => {
    const calls: Array<{ tool: string; args?: object }> = []
    const rows = Array.from({ length: 60 }, (_, i) => ({
      slug: `adapter-${i}`,
      name: `Adapter ${i}`,
      installed: true,
      modelCount: 0,
    }))
    const { container, handle } = mount({
      callTool: async (tool, args) => {
        calls.push({ tool, args })
        if (tool === "harness_preset_list") return { presets: [] }
        const a = (args ?? {}) as { limit?: number; cursor?: string }
        const start = a.cursor ? (JSON.parse(Buffer.from(a.cursor, "base64url").toString("utf8")) as { i: number }).i : 0
        const end = start + (a.limit ?? 50)
        return { items: rows.slice(start, end), total: rows.length, ...(end < rows.length ? { nextCursor: Buffer.from(JSON.stringify({ k: rows[end]!.slug, i: end })).toString("base64url") } : {}) }
      },
    })
    await handle.refresh()

    const select = container.querySelector("select")
    if (!select) throw new Error("no select rendered")
    expect(select.options.length).toBe(60)
    expect(select.options[select.options.length - 1]?.value).toBe("adapter-59")
    // 60 rows > limit 50 → every walk needs 2 pages; assert the walk
    // shape: its first call has no cursor, later ones do.
    const listCalls = calls.filter(c => c.tool === "adapter_list")
    expect(listCalls.length).toBeGreaterThanOrEqual(2)
    expect((listCalls[0]?.args as { cursor?: string }).cursor).toBeUndefined()
    expect(listCalls.some(c => Boolean((c.args as { cursor?: string })?.cursor))).toBe(true)
  })

  it("treats a truncated adapter_list stub as an error note — never as an empty list", async () => {
    const { container, handle } = mount({
      callTool: async tool => {
        if (tool === "harness_preset_list") return { presets: [] }
        // The daemon's over-budget marker replaces the whole payload.
        return { truncated: true, totalBytes: 109_340, hint: "use limit/cursor/fields" }
      },
    })
    await expect(handle.refresh()).resolves.toBeUndefined()
    expect(container.textContent).toContain("adapter list unavailable:")
    expect(container.textContent).toContain("truncated")
    // The picker is empty ONLY because discovery failed (the note says so),
    // not because no harness is installed.
  })

  it("degrades gracefully when a discovery call rejects: empty source + muted note, no throw", async () => {
    const { container, handle } = mount({
      callTool: async tool => {
        if (tool === "harness_preset_list") throw new Error("profile store unreadable")
        return { adapters: [] }
      },
    })

    await expect(handle.refresh()).resolves.toBeUndefined()
    expect(container.textContent).toContain("harness list unavailable: profile store unreadable")
  })

  it("destroy() removes the mounted element", () => {
    const { container, handle } = mount({ callTool: () => new Promise(() => {}) })
    expect(container.children.length).toBeGreaterThan(0)
    handle.destroy()
    expect(container.children.length).toBe(0)
  })
})
