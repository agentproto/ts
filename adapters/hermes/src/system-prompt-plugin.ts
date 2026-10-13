/**
 * Install / status helpers for the `agentproto-system-prompt` hermes
 * plugin — the channel that gives hermes a real system-prompt delivery
 * path. Hermes' ACP server builds `AIAgent(**kwargs)` without
 * `ephemeral_system_prompt` and only its CLI/gateway reads
 * `HERMES_EPHEMERAL_SYSTEM_PROMPT`, so an ACP-spawned hermes has NO
 * native system-prompt channel. Its plugins do: a plugin can register
 * cache-safe system-prompt sections that hermes renders once at session
 * start and freezes (the rendered bytes survive resume).
 *
 * This package ships a tiny plugin (`plugin/agentproto-system-prompt/`)
 * that reads the path in `AGENTPROTO_SYSTEM_PROMPT_FILE` — set per
 * session by agentproto, one `hermes acp` process per session — and
 * registers the file's text as sections `agentproto.system-prompt.00`,
 * `.01`, … at position `after_memory`. The helpers here install that
 * plugin into `$HERMES_HOME/plugins/` and report whether it is installed
 * AND enabled (`plugins.enabled` in `$HERMES_HOME/config.yaml`).
 *
 * Enabling is explicit consent: it runs `hermes plugins enable
 * agentproto-system-prompt` (argv, never a shell) — config.yaml is never
 * edited by hand.
 */
import { spawn } from "node:child_process"
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"

/** Directory name of the plugin, both bundled and under `$HERMES_HOME/plugins/`. */
export const HERMES_SYSTEM_PROMPT_PLUGIN_NAME = "agentproto-system-prompt"

/**
 * Budget for the text delivered through this channel. Hermes caps ALL
 * plugin system-prompt sections (including the audit headings it prepends)
 * at 8000 chars and 32 sections; 7500 leaves headroom for the headings.
 * Longer text is NOT delivered through the plugin — the runtime falls
 * back to a first-prompt prefix + a harness warning naming this limit.
 */
export const MAX_HERMES_SYSTEM_PROMPT_CHARS = 7500

/** `$HERMES_HOME` — env override, else `~/.hermes`. */
export function resolveHermesHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["HERMES_HOME"]
  if (explicit && explicit.trim() !== "") return explicit
  return join(homedir(), ".hermes")
}

/** Absolute path of the plugin dir bundled inside this package. */
export function bundledHermesSystemPromptPluginDir(): string {
  // Resolves correctly from both `src/` (vitest) and `dist/` (published
  // package, including tsup's split chunks) — each is one level below the
  // package root, where `plugin/` ships.
  return fileURLToPath(
    new URL(`../plugin/${HERMES_SYSTEM_PROMPT_PLUGIN_NAME}`, import.meta.url),
  )
}

/** Parse a `version:` out of a plugin.yaml; undefined when unreadable. */
function readPluginVersion(dir: string): string | undefined {
  try {
    const doc: unknown = parse(readFileSync(join(dir, "plugin.yaml"), "utf8"))
    if (typeof doc !== "object" || doc === null) return undefined
    const version = (doc as Record<string, unknown>)["version"]
    return typeof version === "string" && version !== "" ? version : undefined
  } catch {
    return undefined
  }
}

/**
 * List `plugins.enabled` from a hermes config.yaml. Returns undefined when
 * the file is missing or the shape isn't confidently a list of strings —
 * callers treat unknown as NOT enabled (conservative: never claim a
 * consent we can't see).
 */
function readEnabledPlugins(configPath: string): string[] | undefined {
  let doc: unknown
  try {
    doc = parse(readFileSync(configPath, "utf8"))
  } catch {
    return undefined
  }
  if (typeof doc !== "object" || doc === null) return undefined
  const plugins = (doc as Record<string, unknown>)["plugins"]
  if (typeof plugins !== "object" || plugins === null) return undefined
  const enabled = (plugins as Record<string, unknown>)["enabled"]
  if (!Array.isArray(enabled)) return undefined
  return enabled.filter((entry): entry is string => typeof entry === "string")
}

/** Numeric `x.y.z` compare; missing segments count as 0. -1/0/1. */
function compareVersions(a: string, b: string): number {
  const parseSegments = (v: string): number[] =>
    v.split(".").map((seg) => {
      const n = Number.parseInt(seg, 10)
      return Number.isFinite(n) ? n : 0
    })
  const pa = parseSegments(a)
  const pb = parseSegments(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da !== db) return da < db ? -1 : 1
  }
  return 0
}

export interface HermesSystemPromptPluginStatus {
  installed: boolean
  enabled: boolean
  installedVersion?: string
  bundledVersion: string
  path: string
}

export interface HermesSystemPromptPluginStatusOptions {
  env?: NodeJS.ProcessEnv
}

/**
 * Read-only status of the plugin on this machine: does the plugin dir
 * (with a parseable plugin.yaml) exist under `$HERMES_HOME/plugins/`, and
 * does `plugins.enabled` in `$HERMES_HOME/config.yaml` list it? Never
 * throws; anything unreadable degrades to not-installed / not-enabled.
 */
export function hermesSystemPromptPluginStatus(
  options: HermesSystemPromptPluginStatusOptions = {},
): HermesSystemPromptPluginStatus {
  const env = options.env ?? process.env
  const path = join(
    resolveHermesHome(env),
    "plugins",
    HERMES_SYSTEM_PROMPT_PLUGIN_NAME,
  )
  const installedVersion = readPluginVersion(path)
  const enabledPlugins = readEnabledPlugins(
    join(resolveHermesHome(env), "config.yaml"),
  )
  return {
    installed: installedVersion !== undefined,
    enabled:
      enabledPlugins?.includes(HERMES_SYSTEM_PROMPT_PLUGIN_NAME) ?? false,
    ...(installedVersion !== undefined ? { installedVersion } : {}),
    bundledVersion:
      readPluginVersion(bundledHermesSystemPromptPluginDir()) ?? "unknown",
    path,
  }
}

export interface HermesSystemPromptPluginEnableResult {
  requested: boolean
  exitCode?: number
  error?: string
}

export interface InstallHermesSystemPromptPluginResult {
  path: string
  action: "installed" | "updated" | "unchanged"
  bundledVersion: string
  installedVersion?: string
  enable: HermesSystemPromptPluginEnableResult
}

export interface InstallHermesSystemPromptPluginOptions {
  env?: NodeJS.ProcessEnv
  /** Run `hermes plugins enable agentproto-system-prompt` after copying. */
  enable?: boolean
}

/**
 * Run `hermes plugins enable <name>` (argv, no shell). Never throws — a
 * missing/failed hermes binary is reported in `error` so the caller can
 * surface it instead of crashing the install.
 */
function runHermesPluginsEnable(
  env: NodeJS.ProcessEnv,
): Promise<HermesSystemPromptPluginEnableResult> {
  return new Promise((resolveP) => {
    const child = spawn(
      "hermes",
      ["plugins", "enable", HERMES_SYSTEM_PROMPT_PLUGIN_NAME],
      { env, stdio: ["ignore", "ignore", "pipe"] },
    )
    let stderr = ""
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once("error", (err) => {
      resolveP({ requested: true, error: err.message })
    })
    child.once("exit", (code) => {
      const exitCode = code ?? 0
      const trimmed = stderr.trim()
      resolveP({
        requested: true,
        exitCode,
        ...(exitCode !== 0 && trimmed !== "" ? { error: trimmed } : {}),
      })
    })
  })
}

/**
 * Copy the bundled plugin into `$HERMES_HOME/plugins/agentproto-system-prompt/`
 * (install fresh, or overwrite when the bundled version is newer than the
 * installed one), then optionally enable it via `hermes plugins enable`.
 * The installed copy is left alone when it is the same version or newer.
 */
export async function installHermesSystemPromptPlugin(
  options: InstallHermesSystemPromptPluginOptions = {},
): Promise<InstallHermesSystemPromptPluginResult> {
  const env = options.env ?? process.env
  const path = join(
    resolveHermesHome(env),
    "plugins",
    HERMES_SYSTEM_PROMPT_PLUGIN_NAME,
  )
  const source = bundledHermesSystemPromptPluginDir()
  const bundledVersion = readPluginVersion(source)
  if (bundledVersion === undefined) {
    throw new Error(
      `bundled hermes system-prompt plugin is missing or unreadable at ${source}`,
    )
  }
  const installedVersion = readPluginVersion(path)

  let action: "installed" | "updated" | "unchanged"
  if (installedVersion === undefined) {
    mkdirSync(dirname(path), { recursive: true })
    cpSync(source, path, { recursive: true })
    action = "installed"
  } else if (compareVersions(bundledVersion, installedVersion) > 0) {
    rmSync(path, { recursive: true, force: true })
    cpSync(source, path, { recursive: true })
    action = "updated"
  } else {
    action = "unchanged"
  }

  const enable = options.enable
    ? await runHermesPluginsEnable(env)
    : { requested: false }

  return {
    path,
    action,
    bundledVersion,
    ...(installedVersion !== undefined ? { installedVersion } : {}),
    enable,
  }
}
