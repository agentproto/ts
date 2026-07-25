import { describe, expect, it } from "vitest"

import type { AdapterInfo } from "../client/types.js"
import {
  buildHarnessesWebviewModel,
  harnessStatusFor,
  type HarnessWebviewRow,
} from "./harnessesWebview.logic.js"

function adapter(over: Partial<AdapterInfo> = {}): AdapterInfo {
  return {
    slug: "claude-code",
    name: "Claude Code",
    protocol: "acp",
    version: "1.0",
    status: "ready",
    hint: "anthropic · ACP · resumable",
    ...over,
  }
}

describe("harnessStatusFor", () => {
  it("maps ready to ready", () => {
    expect(harnessStatusFor("ready")).toBe("ready")
  })

  it("maps available and supported to available", () => {
    expect(harnessStatusFor("available")).toBe("available")
    expect(harnessStatusFor("supported")).toBe("available")
  })

  it("maps everything else to dim", () => {
    expect(harnessStatusFor("unresolvable")).toBe("dim")
    expect(harnessStatusFor(undefined)).toBe("dim")
  })
})

describe("buildHarnessesWebviewModel", () => {
  it("sorts ready before available before supported", () => {
    const adapters = [
      adapter({ slug: "supported", status: "supported" }),
      adapter({ slug: "ready", status: "ready" }),
      adapter({ slug: "available", status: "available" }),
    ]
    const model = buildHarnessesWebviewModel(adapters, "")
    expect(model.rows.map(r => r.slug)).toEqual(["ready", "available", "supported"])
  })

  it("marks installable rows for available and supported harnesses", () => {
    const adapters = [
      adapter({ slug: "ready", status: "ready" }),
      adapter({ slug: "available", status: "available" }),
      adapter({ slug: "supported", status: "supported" }),
    ]
    const model = buildHarnessesWebviewModel(adapters, "")
    expect(model.rows.find(r => r.slug === "ready")?.installable).toBe(false)
    expect(model.rows.find(r => r.slug === "available")?.installable).toBe(true)
    expect(model.rows.find(r => r.slug === "supported")?.installable).toBe(true)
  })

  it("uses the real logo for known adapters and lettermark for unknowns", () => {
    const adapters = [adapter({ slug: "claude-code" }), adapter({ slug: "pi" })]
    const model = buildHarnessesWebviewModel(adapters, "")
    expect(model.rows.find(r => r.slug === "claude-code")?.logo).toEqual({ kind: "icon", file: "claude.svg" })
    expect(model.rows.find(r => r.slug === "pi")?.logo).toEqual({ kind: "lettermark", text: "π" })
  })

  it("filters by name, slug, and description", () => {
    const adapters = [
      adapter({ slug: "claude-code", name: "Claude Code", hint: "anthropic helper" }),
      adapter({ slug: "codex", name: "Codex", hint: "openai tool" }),
    ]
    expect(buildHarnessesWebviewModel(adapters, "openai").rows).toHaveLength(1)
    expect(buildHarnessesWebviewModel(adapters, "codex").rows).toHaveLength(1)
    expect(buildHarnessesWebviewModel(adapters, "helper").rows).toHaveLength(1)
    expect(buildHarnessesWebviewModel(adapters, "gemini").rows).toHaveLength(0)
  })

  it("reports shown and total counts", () => {
    const adapters = [adapter({ slug: "alpha" }), adapter({ slug: "beta" })]
    const model = buildHarnessesWebviewModel(adapters, "alpha")
    expect(model.shownCount).toBe(1)
    expect(model.totalCount).toBe(2)
  })

  it("prefers the adapter hint for the description", () => {
    const model = buildHarnessesWebviewModel([adapter({ hint: "custom hint" })], "")
    expect((model.rows[0] as HarnessWebviewRow).description).toBe("custom hint")
  })
})
