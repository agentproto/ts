/**
 * Unit tests for the terminal preset resolver.
 *
 * Keeps config-shape validation and CLI-vs-preset precedence isolated
 * from daemon IO so failures are fast and deterministic.
 */

import { describe, it, expect } from "vitest"
import type { TerminalPreset } from "@agentproto/runtime/config"
import {
  resolveTerminalPreset,
  validateTerminalPreset,
} from "../terminal-preset.js"

const EMPTY_CONFIG = {}

const BASE_CONFIG = {
  terminalPresets: {
    terra: {
      argv: ["claude", "--resume"],
      env: {
        ANTHROPIC_BASE_URL: "http://localhost:4000",
        NO_COLOR: "1",
      },
      cwd: "~/projects/terra",
      workspace: "terra",
      name: "terra-tui",
      label: "Terra local TUI",
    },
    "env-only": {
      env: { FOO: "bar" },
    },
    "argv-only": {
      argv: ["bash"],
    },
  },
}

describe("validateTerminalPreset", () => {
  it("accepts a fully populated preset", () => {
    const result = validateTerminalPreset(BASE_CONFIG.terminalPresets.terra, "terra")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.preset.argv).toEqual(["claude", "--resume"])
    expect(result.preset.env).toEqual({
      ANTHROPIC_BASE_URL: "http://localhost:4000",
      NO_COLOR: "1",
    })
    expect(result.preset.cwd).toBe("~/projects/terra")
    expect(result.preset.workspace).toBe("terra")
    expect(result.preset.name).toBe("terra-tui")
    expect(result.preset.label).toBe("Terra local TUI")
  })

  it("accepts a preset with only env", () => {
    const result = validateTerminalPreset(
      BASE_CONFIG.terminalPresets["env-only"],
      "env-only",
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.preset.argv).toBeUndefined()
    expect(result.preset.env).toEqual({ FOO: "bar" })
  })

  it("rejects a non-array argv", () => {
    const result = validateTerminalPreset(
      { argv: "claude" } as unknown as TerminalPreset,
      "bad",
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("invalid argv")
  })

  it("rejects an empty argv array", () => {
    const result = validateTerminalPreset({ argv: [] }, "bad")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("invalid argv")
  })

  it("rejects argv entries that are not non-empty strings", () => {
    const result = validateTerminalPreset({ argv: ["claude", ""] }, "bad")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("argv must be non-empty strings")
  })

  it("rejects env values that are not strings", () => {
    const result = validateTerminalPreset(
      { env: { PORT: 4000 } as unknown as Record<string, string> },
      "bad",
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('env value for "PORT" must be a string')
  })

  it("rejects a non-object env", () => {
    const result = validateTerminalPreset({ env: ["x"] as unknown as Record<string, string> }, "bad")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("env must be an object")
  })

  it("rejects empty string optional fields", () => {
    const result = validateTerminalPreset({ cwd: "" }, "bad")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("cwd must be a non-empty string")
  })

  it("drops an empty env object", () => {
    const result = validateTerminalPreset({ env: {}, argv: ["bash"] }, "empty-env")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.preset.env).toBeUndefined()
  })
})

describe("resolveTerminalPreset", () => {
  it("returns an error when the preset does not exist", () => {
    const result = resolveTerminalPreset("missing", EMPTY_CONFIG, {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('terminal preset "missing" not found')
    expect(result.error).toContain("~/.agentproto/config.json")
  })

  it("uses argv from the preset when no explicit argv is given", () => {
    const result = resolveTerminalPreset("terra", BASE_CONFIG, {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.preset.argv).toEqual(["claude", "--resume"])
  })

  it("uses explicit argv over preset argv", () => {
    const result = resolveTerminalPreset("terra", BASE_CONFIG, {
      argv: ["zsh"],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.preset.argv).toEqual(["zsh"])
  })

  it("returns env, cwd, workspace, name and label from the preset", () => {
    const result = resolveTerminalPreset("terra", BASE_CONFIG, {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.preset.env).toEqual({
      ANTHROPIC_BASE_URL: "http://localhost:4000",
      NO_COLOR: "1",
    })
    expect(result.preset.cwd).toBe("~/projects/terra")
    expect(result.preset.workspace).toBe("terra")
    expect(result.preset.name).toBe("terra-tui")
    expect(result.preset.label).toBe("Terra local TUI")
  })

  it("lets explicit CLI flags override preset fields", () => {
    const result = resolveTerminalPreset("terra", BASE_CONFIG, {
      cwd: "/over/ride",
      workspace: "override-ws",
      name: "override-name",
      label: "override-label",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.preset.cwd).toBe("/over/ride")
    expect(result.preset.workspace).toBe("override-ws")
    expect(result.preset.name).toBe("override-name")
    expect(result.preset.label).toBe("override-label")
  })

  it("preserves preset env even when explicit argv overrides", () => {
    const result = resolveTerminalPreset("terra", BASE_CONFIG, {
      argv: ["zsh"],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.preset.env).toEqual({
      ANTHROPIC_BASE_URL: "http://localhost:4000",
      NO_COLOR: "1",
    })
  })

  it("propagates validation errors from malformed presets", () => {
    const cfg = {
      terminalPresets: {
        bad: { argv: [""], env: { X: 1 } as unknown as Record<string, string> },
      },
    }
    const result = resolveTerminalPreset("bad", cfg, {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("bad")
  })
})
