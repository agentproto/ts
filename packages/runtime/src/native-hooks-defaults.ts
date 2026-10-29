/**
 * Resolver for the `config.json` `defaults.nativeHooks` knobs: hooks the
 * daemon projects into a harness's own settings.
 *
 * `defaults.nativeHooks.preCompactCheckpoint`: `"on"` projects a synchronous
 * Claude Code `PreCompact` hook (matcher `auto`) running
 * `<defaults.nativeHooks.command> hook pre-compact`, so the harness's own
 * compaction is preceded by a daemon checkpoint. When the key is unset the
 * command is the serving CLI by absolute path. `"off"` (default): nothing.
 * Local claude-code spawns only: the projection lives in claude-code's
 * isolated settings.json, and a sandbox spawn runs on the box's own daemon.
 *
 * Hot, read at spawn and restart (so a change applies to sessions spawned
 * after it), the same way as `identity-defaults.ts`.
 */

import type { SpawnDefaultsConfig } from "./spawn-defaults.js"

export type PreCompactCheckpointMode = "off" | "on"

export const DEFAULT_PRE_COMPACT_CHECKPOINT_MODE: PreCompactCheckpointMode = "off"

/** The last-resort command when neither `defaults.nativeHooks.command` nor
 *  the serving CLI is known: the bare `agentproto`, resolved on the PATH of
 *  the harness. */
export const DEFAULT_NATIVE_HOOKS_COMMAND = "agentproto"

/** POSIX single-quote a word for a shell command line. */
function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/**
 * The command line that runs THIS CLI (`'<node>' '<entry>'`), for a hook the
 * harness starts through a shell. POSIX only (a win32 daemon keeps the bare
 * word), and only for two absolute paths with a built JavaScript entry (a
 * daemon run from TypeScript sources through a loader cannot be re-run as
 * `node <entry>`): anything else returns undefined.
 */
export function servingCliCommand(
  execPath: string | undefined,
  entry: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === "win32") return undefined
  if (!execPath || !entry) return undefined
  if (!execPath.startsWith("/") || !entry.startsWith("/")) return undefined
  if (!/\.(?:mjs|cjs|js)$/.test(entry)) return undefined
  return `${shellQuote(execPath)} ${shellQuote(entry)}`
}

let servingCli: string | undefined

/** Set once by the CLI's `serve` command: the command line that runs the CLI serving this daemon. */
export function setServingCli(command: string | undefined): void {
  servingCli = command
}

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
  const explicit = typeof raw === "string" && raw.trim() ? raw.trim() : undefined
  const command = explicit ?? servingCli ?? DEFAULT_NATIVE_HOOKS_COMMAND
  return `${command} hook pre-compact`
}
