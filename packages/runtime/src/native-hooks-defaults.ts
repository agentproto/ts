/**
 * Resolver for the `config.json` `defaults.nativeHooks` knobs: hooks the
 * daemon projects into a harness's own settings.
 *
 * `defaults.nativeHooks.preCompactCheckpoint`: `"on"` projects a synchronous
 * Claude Code `PreCompact` hook (matcher `auto`) running
 * `<defaults.nativeHooks.command> hook pre-compact`, so the harness's own
 * compaction is preceded by a daemon checkpoint. `"off"` (default): nothing.
 * Local claude-code spawns only: the projection lives in claude-code's
 * isolated settings.json, and a sandbox spawn runs on the box's own daemon.
 *
 * Hot, read at spawn and restart (so a change applies to sessions spawned
 * after it), the same way as `identity-defaults.ts`.
 */

import type { SpawnDefaultsConfig } from "./spawn-defaults.js"

export type PreCompactCheckpointMode = "off" | "on"

export const DEFAULT_PRE_COMPACT_CHECKPOINT_MODE: PreCompactCheckpointMode = "off"

/** The `agentproto` CLI, resolved on the daemon's PATH. An operator whose
 *  daemon has no `agentproto` on PATH sets an absolute path instead. */
export const DEFAULT_NATIVE_HOOKS_COMMAND = "agentproto"

/** The adapters whose settings carry a projected PreCompact hook. */
const PRE_COMPACT_ADAPTERS: ReadonlySet<string> = new Set(["claude-code"])

/** `defaults.nativeHooks.preCompactCheckpoint` out of an already-loaded
 *  `defaults` block; anything but `"on"` / `"off"` falls back to the default. */
export function preCompactCheckpointModeOf(defaults: SpawnDefaultsConfig | undefined): PreCompactCheckpointMode {
  const mode = defaults?.nativeHooks?.preCompactCheckpoint
  return mode === "on" || mode === "off" ? mode : DEFAULT_PRE_COMPACT_CHECKPOINT_MODE
}

/**
 * The command line to hand `startSession({ preCompactCommand })`, or
 * undefined when the hook is off, the adapter is not claude-code, or the
 * spawn is a sandbox one.
 */
export function preCompactCommandFor(
  defaults: SpawnDefaultsConfig | undefined,
  target: { adapter: string | undefined; sandbox?: unknown },
): string | undefined {
  if (preCompactCheckpointModeOf(defaults) !== "on") return undefined
  if (target.sandbox !== undefined) return undefined
  if (target.adapter === undefined || !PRE_COMPACT_ADAPTERS.has(target.adapter)) return undefined
  const raw = defaults?.nativeHooks?.command
  const command = typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_NATIVE_HOOKS_COMMAND
  return `${command} hook pre-compact`
}
