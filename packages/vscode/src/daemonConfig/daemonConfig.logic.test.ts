import { describe, expect, it } from "vitest"

import {
  anyRestartPending,
  buildConfigView,
  formatKnobValue,
  KNOB_SPECS,
  normalizeIdleReapInput,
  parseDaemonSection,
  parseEffectiveKnobs,
  serializeConfig,
  setConfigKey,
  type KnobRow,
} from "./daemonConfig.logic.js"

function row(rows: KnobRow[], key: string): KnobRow {
  const found = rows.find(r => r.spec.key === key)
  if (!found) throw new Error(`no row for ${key}`)
  return found
}

describe("parseEffectiveKnobs", () => {
  it("narrows the two health-surfaced knobs", () => {
    expect(parseEffectiveKnobs({ resumeSessionsOnBoot: true, idleReapAfterMs: 60000 })).toEqual({
      resumeSessionsOnBoot: true,
      idleReapAfterMs: 60000,
    })
  })

  it("drops mistyped or missing fields (older daemon)", () => {
    expect(parseEffectiveKnobs({ resumeSessionsOnBoot: "yes", idleReapAfterMs: null })).toEqual({})
    expect(parseEffectiveKnobs(undefined)).toEqual({})
    expect(parseEffectiveKnobs("nope")).toEqual({})
  })

  it("keeps idleReapAfterMs: 0 (reaper off is a real value, not absence)", () => {
    expect(parseEffectiveKnobs({ idleReapAfterMs: 0 })).toEqual({ idleReapAfterMs: 0 })
  })
})

describe("parseDaemonSection", () => {
  it("narrows the daemon.* subset with validation", () => {
    const cfg = {
      version: 1,
      daemon: {
        resumeSessionsOnBoot: true,
        idleReapAfterMs: 30000,
        port: 18791,
        bind: "0.0.0.0",
        allowedOrigins: ["https://guilde.work"],
        strictOrigins: true,
      },
      tunnel: { host: "wss://x" },
    }
    expect(parseDaemonSection(cfg)).toEqual({
      resumeSessionsOnBoot: true,
      idleReapAfterMs: 30000,
      port: 18791,
      bind: "0.0.0.0",
      allowedOrigins: ["https://guilde.work"],
      strictOrigins: true,
    })
  })

  it("returns {} when there is no daemon section", () => {
    expect(parseDaemonSection({ version: 1 })).toEqual({})
    expect(parseDaemonSection({ daemon: [] })).toEqual({})
    expect(parseDaemonSection(null)).toEqual({})
  })

  it("drops a malformed allowedOrigins rather than throwing", () => {
    expect(parseDaemonSection({ daemon: { allowedOrigins: ["ok", 42] } })).toEqual({})
    expect(parseDaemonSection({ daemon: { allowedOrigins: "not-a-list" } })).toEqual({})
  })
})

describe("buildConfigView — display + restart reconciliation", () => {
  it("shows the LIVE value for a health knob, persisted for others", () => {
    const rows = buildConfigView(
      { resumeSessionsOnBoot: true, port: 18791 },
      { resumeSessionsOnBoot: false, idleReapAfterMs: 0 },
    )
    // persisted true but daemon still running false → display the live one
    expect(row(rows, "resumeSessionsOnBoot").displayValue).toBe(false)
    // persisted-only knob → display the persisted one
    expect(row(rows, "port").displayValue).toBe(18791)
  })

  it("falls back to the knob default when neither persisted nor effective is set", () => {
    const rows = buildConfigView({}, {})
    expect(row(rows, "port").displayValue).toBe(18790)
    expect(row(rows, "bind").displayValue).toBe("127.0.0.1")
    expect(row(rows, "idleReapAfterMs").displayValue).toBe(0)
    expect(row(rows, "resumeSessionsOnBoot").displayValue).toBe(false)
  })

  it("flags restartPending when a written value differs from the live one", () => {
    const rows = buildConfigView(
      { resumeSessionsOnBoot: true },
      { resumeSessionsOnBoot: false, idleReapAfterMs: 0 },
    )
    expect(row(rows, "resumeSessionsOnBoot").restartPending).toBe(true)
    expect(anyRestartPending(rows)).toBe(true)
  })

  it("does NOT flag restart when persisted matches live", () => {
    const rows = buildConfigView(
      { resumeSessionsOnBoot: true, idleReapAfterMs: 60000 },
      { resumeSessionsOnBoot: true, idleReapAfterMs: 60000 },
    )
    expect(anyRestartPending(rows)).toBe(false)
  })

  it("treats an unset persisted key as equal to its default (no false-positive restart)", () => {
    // config.json has no daemon.resumeSessionsOnBoot; daemon running with default false.
    const rows = buildConfigView({}, { resumeSessionsOnBoot: false, idleReapAfterMs: 0 })
    expect(row(rows, "resumeSessionsOnBoot").restartPending).toBe(false)
    expect(row(rows, "idleReapAfterMs").restartPending).toBe(false)
  })

  it("flags restart for idleReapAfterMs written but not yet booted", () => {
    const rows = buildConfigView({ idleReapAfterMs: 30000 }, { idleReapAfterMs: 0 })
    expect(row(rows, "idleReapAfterMs").restartPending).toBe(true)
  })

  it("never flags restart for a persisted-only (non-health) knob", () => {
    const rows = buildConfigView({ port: 18791 }, {})
    expect(row(rows, "port").restartPending).toBe(false)
  })
})

describe("formatKnobValue", () => {
  it("formats booleans, numbers, strings, and lists", () => {
    expect(formatKnobValue(true)).toBe("on")
    expect(formatKnobValue(false)).toBe("off")
    expect(formatKnobValue(60000)).toBe("60000")
    expect(formatKnobValue("127.0.0.1")).toBe("127.0.0.1")
    expect(formatKnobValue(["a", "b"])).toBe("a, b")
    expect(formatKnobValue([])).toBe("(none)")
  })
})

describe("normalizeIdleReapInput", () => {
  it("accepts a whole non-negative number", () => {
    expect(normalizeIdleReapInput("60000")).toEqual({ ok: true, value: 60000 })
    expect(normalizeIdleReapInput(" 0 ")).toEqual({ ok: true, value: 0 })
  })

  it("treats empty as off (0)", () => {
    expect(normalizeIdleReapInput("")).toEqual({ ok: true, value: 0 })
    expect(normalizeIdleReapInput("   ")).toEqual({ ok: true, value: 0 })
  })

  it("rejects negatives, non-integers, and garbage", () => {
    expect(normalizeIdleReapInput("-1").ok).toBe(false)
    expect(normalizeIdleReapInput("1.5").ok).toBe(false)
    expect(normalizeIdleReapInput("abc").ok).toBe(false)
  })
})

describe("setConfigKey + serializeConfig — write path", () => {
  it("sets a nested daemon key without mutating the input", () => {
    const before = { version: 1, daemon: { port: 18790 } }
    const after = setConfigKey(before, "daemon.resumeSessionsOnBoot", true)
    expect(after).toEqual({ version: 1, daemon: { port: 18790, resumeSessionsOnBoot: true } })
    // immutability
    expect(before).toEqual({ version: 1, daemon: { port: 18790 } })
    expect((before.daemon as Record<string, unknown>).resumeSessionsOnBoot).toBeUndefined()
  })

  it("creates the daemon object when missing", () => {
    expect(setConfigKey({}, "daemon.idleReapAfterMs", 30000)).toEqual({
      daemon: { idleReapAfterMs: 30000 },
    })
  })

  it("preserves unrelated keys (deep-clone of the branch, not a wipe)", () => {
    const before = { version: 1, daemon: { port: 18790, bind: "127.0.0.1" }, tunnel: { host: "x" } }
    const after = setConfigKey(before, "daemon.idleReapAfterMs", 5000)
    expect(after).toEqual({
      version: 1,
      daemon: { port: 18790, bind: "127.0.0.1", idleReapAfterMs: 5000 },
      tunnel: { host: "x" },
    })
  })

  it("treats undefined as a delete", () => {
    expect(setConfigKey({ daemon: { idleReapAfterMs: 5000 } }, "daemon.idleReapAfterMs", undefined)).toEqual({
      daemon: {},
    })
  })

  it("serializes with a version stamp, 2-space indent, and trailing newline", () => {
    const out = serializeConfig({ daemon: { resumeSessionsOnBoot: true } })
    expect(out).toBe(
      '{\n  "daemon": {\n    "resumeSessionsOnBoot": true\n  },\n  "version": 1\n}\n',
    )
  })
})

describe("KNOB_SPECS invariants", () => {
  it("marks exactly the two behavior knobs editable, and only health knobs as fromHealth", () => {
    const editable = KNOB_SPECS.filter(s => s.editable).map(s => s.key)
    expect(editable).toEqual(["resumeSessionsOnBoot", "idleReapAfterMs"])
    const fromHealth = KNOB_SPECS.filter(s => s.fromHealth).map(s => s.key)
    expect(fromHealth).toEqual(["resumeSessionsOnBoot", "idleReapAfterMs"])
    // every knob here is a boot-time knob
    expect(KNOB_SPECS.every(s => s.bootTime)).toBe(true)
  })
})
