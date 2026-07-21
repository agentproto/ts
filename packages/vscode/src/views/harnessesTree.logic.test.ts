import { describe, expect, it } from "vitest"

import {
  canInstallHarness,
  harnessContextValue,
  harnessDescription,
  harnessIcon,
  harnessTooltip,
  sortAdapters,
  type HarnessNode,
} from "./harnessesTree.logic.js"
import type { AdapterInfo } from "../client/types.js"

function adapter(over: Partial<AdapterInfo> = {}): AdapterInfo {
  return {
    slug: "claude-code",
    name: "Claude Code",
    protocol: "acp",
    version: "1.2.3",
    models: ["claude-sonnet", "claude-opus"],
    modes: [{ id: "subscription" }, { id: "api-key" }],
    status: "ready",
    hint: "anthropic · ACP · resumable",
    ...over,
  }
}

describe("sortAdapters", () => {
  it("orders ready before available before supported", () => {
    const adapters: AdapterInfo[] = [
      adapter({ slug: "supported-1", status: "supported" }),
      adapter({ slug: "ready-1", status: "ready" }),
      adapter({ slug: "available-1", status: "available" }),
      adapter({ slug: "ready-2", status: "ready" }),
      adapter({ slug: "supported-2", status: "supported" }),
    ]
    expect(sortAdapters(adapters).map(a => a.slug)).toEqual([
      "ready-1",
      "ready-2",
      "available-1",
      "supported-1",
      "supported-2",
    ])
  })

  it("preserves input order within the same status", () => {
    const adapters: AdapterInfo[] = [
      adapter({ slug: "a", status: "available" }),
      adapter({ slug: "b", status: "available" }),
      adapter({ slug: "c", status: "available" }),
    ]
    expect(sortAdapters(adapters).map(a => a.slug)).toEqual(["a", "b", "c"])
  })

  it("places adapters with no status last", () => {
    const adapters: AdapterInfo[] = [
      adapter({ slug: "unknown", status: undefined }),
      adapter({ slug: "ready", status: "ready" }),
      adapter({ slug: "supported", status: "supported" }),
    ]
    expect(sortAdapters(adapters).map(a => a.slug)).toEqual(["ready", "supported", "unknown"])
  })
})

describe("canInstallHarness", () => {
  it("offers install for a not-yet-installed harness (available/supported)", () => {
    expect(canInstallHarness("available")).toBe(true)
    expect(canInstallHarness("supported")).toBe(true)
  })

  it("does not offer install for a ready harness", () => {
    expect(canInstallHarness("ready")).toBe(false)
  })

  it("does not offer install for an unresolvable (mid-rebuild) harness", () => {
    expect(canInstallHarness("unresolvable")).toBe(false)
  })

  it("does not offer install for an unknown/absent status", () => {
    expect(canInstallHarness(undefined)).toBe(false)
    expect(canInstallHarness("weird")).toBe(false)
  })
})

describe("harnessContextValue", () => {
  it("marks installable rows with a distinct contextValue", () => {
    expect(harnessContextValue(adapter({ status: "supported" }))).toBe("harness-installable")
    expect(harnessContextValue(adapter({ status: "available" }))).toBe("harness-installable")
  })

  it("uses the base harness contextValue for ready/unresolvable/unknown rows", () => {
    expect(harnessContextValue(adapter({ status: "ready" }))).toBe("harness")
    expect(harnessContextValue(adapter({ status: "unresolvable" }))).toBe("harness")
    expect(harnessContextValue(adapter({ status: undefined }))).toBe("harness")
  })
})

describe("harnessIcon", () => {
  it("uses check for ready adapters", () => {
    expect(harnessIcon(adapter({ status: "ready" }))).toEqual({ id: "check" })
  })

  it("uses circle-filled for available adapters", () => {
    expect(harnessIcon(adapter({ status: "available" }))).toEqual({ id: "circle-filled" })
  })

  it("uses info for supported adapters", () => {
    expect(harnessIcon(adapter({ status: "supported" }))).toEqual({ id: "info" })
  })

  it("falls back to info when status is missing", () => {
    expect(harnessIcon(adapter({ status: undefined }))).toEqual({ id: "info" })
  })
})

describe("harnessDescription", () => {
  it("returns the hint when present", () => {
    expect(harnessDescription(adapter({ hint: "my hint" }))).toBe("my hint")
  })

  it("falls back to protocol/version", () => {
    expect(
      harnessDescription(adapter({ hint: undefined, protocol: "acp", version: "1.0.0" })),
    ).toBe("acp/1.0.0")
  })

  it("falls back to protocol alone when version is absent", () => {
    expect(harnessDescription(adapter({ hint: undefined, protocol: "stdio", version: undefined }))).toBe(
      "stdio",
    )
  })

  it("falls back to version alone when protocol is absent", () => {
    expect(harnessDescription(adapter({ hint: undefined, protocol: undefined, version: "2.0.0" }))).toBe(
      "2.0.0",
    )
  })

  it("falls back to status when nothing else is available", () => {
    expect(
      harnessDescription(
        adapter({ hint: undefined, protocol: undefined, version: undefined, status: "supported" }),
      ),
    ).toBe("supported")
  })

  it("returns an empty string when all fallbacks are absent", () => {
    expect(
      harnessDescription(
        adapter({
          hint: undefined,
          protocol: undefined,
          version: undefined,
          status: undefined,
        }),
      ),
    ).toBe("")
  })
})

describe("harnessTooltip", () => {
  it("includes the adapter name, protocol, version, model count, and modes", () => {
    const md = harnessTooltip(
      adapter({
        name: "Claude Code",
        protocol: "acp",
        version: "1.2.3",
        models: ["claude-sonnet", "claude-opus"],
        modes: [{ id: "subscription" }, { id: "api-key" }],
      }),
    )
    expect(md).toContain("**Claude Code**")
    expect(md).toContain("**Protocol:** acp")
    expect(md).toContain("**Version:** 1.2.3")
    expect(md).toContain("**Models:** 2")
    expect(md).toContain("**Modes:** subscription, api-key")
  })

  it("falls back to slug for the title when name is absent", () => {
    expect(harnessTooltip(adapter({ name: undefined, slug: "my-adapter" }))).toContain("**my-adapter**")
  })

  it("renders em-dashes for missing fields", () => {
    const md = harnessTooltip(
      adapter({
        name: "Bare",
        protocol: undefined,
        version: undefined,
        models: undefined,
        modes: undefined,
      }),
    )
    expect(md).toContain("**Protocol:** —")
    expect(md).toContain("**Version:** —")
    expect(md).toContain("**Models:** 0")
    expect(md).toContain("**Modes:** —")
  })
})
