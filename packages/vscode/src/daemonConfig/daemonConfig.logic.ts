/**
 * Pure logic for the "Daemon Configuration" surface. No `vscode`, no `fs` —
 * directly unit-testable; daemonConfig.ts (the command shell) and
 * daemonConfigFile.ts (the FS layer) call into these.
 *
 * The split this surface exists for: VS Code's `agentproto.*` settings.json
 * keys configure how the EXTENSION talks to the daemon (url, poll interval,
 * hold-permissions, …). The knobs here configure the DAEMON'S OWN behavior —
 * they live in `~/.agentproto/config.json` under `daemon.*` and are otherwise
 * only reachable via `agentproto config set`. This module reads them from two
 * sources and reconciles them:
 *
 *   - EFFECTIVE (live) values — what the running daemon is actually using —
 *     for the two behavior knobs the daemon surfaces on `GET /health` /
 *     `daemon_health` (`resumeSessionsOnBoot`, `idleReapAfterMs`).
 *   - PERSISTED values — what's written in `config.json` `daemon.*` — the
 *     source of truth for the boot-time knobs the health payload doesn't
 *     surface (`port`, `bind`, `allowedOrigins`, `strictOrigins`), and the
 *     value an edit writes.
 *
 * The reconciliation is the whole point of the "needs restart" flag: every
 * knob here is read by the daemon ONLY at boot, so a freshly-written
 * `config.json` value doesn't take effect until the daemon restarts. For the
 * two health-surfaced knobs we can PROVE a restart is pending by comparing
 * persisted-vs-effective; for the persisted-only knobs we can't compare, so
 * they're flagged boot-time generically.
 */

/** Keys of the `daemon.*` config knobs this surface understands. */
export type KnobKey =
  | "resumeSessionsOnBoot"
  | "idleReapAfterMs"
  | "port"
  | "bind"
  | "allowedOrigins"
  | "strictOrigins"

export interface KnobSpec {
  key: KnobKey
  /** Dot-notation path written to config.json — mirrors `agentproto config set`. */
  dotted: `daemon.${KnobKey}`
  label: string
  kind: "boolean" | "number" | "string" | "stringList"
  /** This surface offers an edit affordance for it (the two behavior knobs). */
  editable: boolean
  /** The daemon reads it only at boot, so an edit needs a restart to apply. */
  bootTime: boolean
  /** The live/effective value is surfaced by `GET /health` — lets us detect a
   *  pending restart by comparing persisted-vs-effective. */
  fromHealth: boolean
  /** Value the daemon falls back to when the knob is unset, for display. */
  defaultValue: boolean | number | string | readonly string[]
}

/**
 * The catalogue. Order is the display order. Only the two behavior knobs are
 * `editable` — this is the deliberate minimal cut (port/bind/origins are
 * shown read-only; editing `port` from the very extension that dials it is a
 * foot-gun best left to `config set`).
 */
export const KNOB_SPECS: readonly KnobSpec[] = [
  {
    key: "resumeSessionsOnBoot",
    dotted: "daemon.resumeSessionsOnBoot",
    label: "Resume sessions on boot",
    kind: "boolean",
    editable: true,
    bootTime: true,
    fromHealth: true,
    defaultValue: false,
  },
  {
    key: "idleReapAfterMs",
    dotted: "daemon.idleReapAfterMs",
    label: "Idle reap after (ms)",
    kind: "number",
    editable: true,
    bootTime: true,
    fromHealth: true,
    defaultValue: 0,
  },
  {
    key: "port",
    dotted: "daemon.port",
    label: "Port",
    kind: "number",
    editable: false,
    bootTime: true,
    fromHealth: false,
    defaultValue: 18790,
  },
  {
    key: "bind",
    dotted: "daemon.bind",
    label: "Bind address",
    kind: "string",
    editable: false,
    bootTime: true,
    fromHealth: false,
    defaultValue: "127.0.0.1",
  },
  {
    key: "allowedOrigins",
    dotted: "daemon.allowedOrigins",
    label: "Allowed origins",
    kind: "stringList",
    editable: false,
    bootTime: true,
    fromHealth: false,
    defaultValue: [],
  },
  {
    key: "strictOrigins",
    dotted: "daemon.strictOrigins",
    label: "Strict origins",
    kind: "boolean",
    editable: false,
    bootTime: true,
    fromHealth: false,
    defaultValue: false,
  },
]

/** Live values the daemon surfaces on `GET /health` / `daemon_health`. */
export interface EffectiveDaemonKnobs {
  resumeSessionsOnBoot?: boolean
  idleReapAfterMs?: number
}

/** The `daemon.*` subset of `~/.agentproto/config.json`, narrowed & validated. */
export interface PersistedDaemonKnobs {
  resumeSessionsOnBoot?: boolean
  idleReapAfterMs?: number
  port?: number
  bind?: string
  allowedOrigins?: string[]
  strictOrigins?: boolean
}

/**
 * Narrow a raw `/health` payload into just the effective knob values. Tolerant
 * of missing/mistyped fields (an older daemon predates them) — an absent field
 * stays `undefined`, letting the caller fall back to the knob's default.
 */
export function parseEffectiveKnobs(healthRaw: unknown): EffectiveDaemonKnobs {
  const out: EffectiveDaemonKnobs = {}
  if (!healthRaw || typeof healthRaw !== "object") return out
  const record = healthRaw as Record<string, unknown>
  if (typeof record.resumeSessionsOnBoot === "boolean") {
    out.resumeSessionsOnBoot = record.resumeSessionsOnBoot
  }
  if (typeof record.idleReapAfterMs === "number" && Number.isFinite(record.idleReapAfterMs)) {
    out.idleReapAfterMs = record.idleReapAfterMs
  }
  return out
}

/**
 * Narrow the `daemon` section of a parsed `config.json` into typed knobs.
 * Same tolerant spirit as runtime/src/config.ts's loader: a mistyped field is
 * dropped rather than throwing, so one bad hand-edit can't blank the surface.
 */
export function parseDaemonSection(configRaw: unknown): PersistedDaemonKnobs {
  const out: PersistedDaemonKnobs = {}
  if (!configRaw || typeof configRaw !== "object") return out
  const daemon = (configRaw as Record<string, unknown>).daemon
  if (!daemon || typeof daemon !== "object" || Array.isArray(daemon)) return out
  const d = daemon as Record<string, unknown>

  if (typeof d.resumeSessionsOnBoot === "boolean") out.resumeSessionsOnBoot = d.resumeSessionsOnBoot
  if (typeof d.idleReapAfterMs === "number" && Number.isFinite(d.idleReapAfterMs)) {
    out.idleReapAfterMs = d.idleReapAfterMs
  }
  if (typeof d.port === "number" && Number.isFinite(d.port)) out.port = d.port
  if (typeof d.bind === "string") out.bind = d.bind
  if (Array.isArray(d.allowedOrigins) && d.allowedOrigins.every(o => typeof o === "string")) {
    out.allowedOrigins = d.allowedOrigins as string[]
  }
  if (typeof d.strictOrigins === "boolean") out.strictOrigins = d.strictOrigins
  return out
}

/** One reconciled row in the display model. */
export interface KnobRow {
  spec: KnobSpec
  /** Value written in config.json, or `undefined` when unset. */
  persisted: boolean | number | string | readonly string[] | undefined
  /** Live value from `/health` (only for `fromHealth` knobs), else `undefined`. */
  effective: boolean | number | undefined
  /** The value to show as current: the live one when we have it, else the
   *  persisted one, else the knob default. */
  displayValue: boolean | number | string | readonly string[]
  /** Provably true when a written value hasn't been booted yet: `fromHealth`
   *  boot knob whose normalized persisted value differs from the live one. */
  restartPending: boolean
}

function persistedFor(spec: KnobSpec, p: PersistedDaemonKnobs): KnobRow["persisted"] {
  return (p as Record<string, unknown>)[spec.key] as KnobRow["persisted"]
}

function effectiveFor(spec: KnobSpec, e: EffectiveDaemonKnobs): KnobRow["effective"] {
  if (!spec.fromHealth) return undefined
  return (e as Record<string, unknown>)[spec.key] as KnobRow["effective"]
}

/**
 * Build the display model by reconciling persisted (config.json) with
 * effective (health) values. For a `fromHealth` boot knob, `restartPending`
 * is set when the persisted value — normalized against the knob default so an
 * unset key compares equal to its default — differs from the live one.
 */
export function buildConfigView(
  persisted: PersistedDaemonKnobs,
  effective: EffectiveDaemonKnobs,
): KnobRow[] {
  return KNOB_SPECS.map(spec => {
    const p = persistedFor(spec, persisted)
    const e = effectiveFor(spec, effective)
    // The live value wins for display when the daemon reports it; otherwise
    // fall back to what's persisted, then the knob default.
    const displayValue = (e ?? p ?? spec.defaultValue) as KnobRow["displayValue"]

    let restartPending = false
    if (spec.fromHealth && spec.bootTime) {
      const persistedEffectively = (p ?? spec.defaultValue) as boolean | number
      const liveEffectively = (e ?? spec.defaultValue) as boolean | number
      restartPending = persistedEffectively !== liveEffectively
    }

    return { spec, persisted: p, effective: e, displayValue, restartPending }
  })
}

/** True when any row has a written-but-not-yet-booted value. */
export function anyRestartPending(rows: readonly KnobRow[]): boolean {
  return rows.some(r => r.restartPending)
}

/** Format a knob value for display in the picker. */
export function formatKnobValue(value: KnobRow["displayValue"]): string {
  if (Array.isArray(value)) return value.length ? value.join(", ") : "(none)"
  if (typeof value === "boolean") return value ? "on" : "off"
  return String(value)
}

/**
 * Validate & coerce the raw text a user typed for `idleReapAfterMs`. Empty or
 * "0" means off. Rejects negatives and non-integers so a fat-finger can't
 * write a value the daemon will silently treat as off (`<= 0`).
 */
export function normalizeIdleReapInput(
  raw: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = raw.trim()
  if (trimmed === "") return { ok: true, value: 0 }
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return { ok: false, error: "Enter a whole number of milliseconds (0 = off)." }
  if (!Number.isInteger(n)) return { ok: false, error: "Milliseconds must be a whole number." }
  if (n < 0) return { ok: false, error: "Milliseconds cannot be negative (0 = off)." }
  return { ok: true, value: n }
}

/**
 * Dot-notation setter, self-contained mirror of runtime/src/config.ts's
 * `setConfigKey`: returns a NEW object (never mutates), creates intermediate
 * objects as needed, and treats `undefined` as a delete. Kept local so the
 * extension doesn't take a dependency on @agentproto/runtime.
 */
export function setConfigKey(
  config: Record<string, unknown>,
  dotted: string,
  value: unknown,
): Record<string, unknown> {
  const parts = dotted.split(".")
  const out: Record<string, unknown> = { ...config }
  let cur = out
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!
    const next = cur[k]
    cur[k] = next && typeof next === "object" && !Array.isArray(next)
      ? { ...(next as Record<string, unknown>) }
      : {}
    cur = cur[k] as Record<string, unknown>
  }
  const leaf = parts[parts.length - 1]!
  if (value === undefined) delete cur[leaf]
  else cur[leaf] = value
  return out
}

/**
 * Serialize a config object the way runtime/src/config.ts's `saveConfig`
 * does — stamped with `version`, 2-space indented, trailing newline — so a
 * config.json this surface writes is byte-compatible with one the CLI wrote.
 */
export const CONFIG_VERSION = 1 as const

export function serializeConfig(config: Record<string, unknown>): string {
  const payload = { ...config, version: CONFIG_VERSION }
  return JSON.stringify(payload, null, 2) + "\n"
}
