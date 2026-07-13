import { z } from "zod"
import { execArgv } from "./exec.js"

/**
 * `agentproto.json` — the declarative per-repo worktree lifecycle.
 *
 * SECURITY: this file is always read from the **committed tree of the base
 * ref** (`git show <base>:agentproto.json`), never from a worktree's working
 * tree. A branch (or an agent editing files inside a worktree) therefore
 * cannot inject setup/teardown hooks or service commands that run on the host
 * — only what a reviewer merged into the base branch executes.
 */
export const CONFIG_FILENAME = "agentproto.json"

/** A hook body: one multiline shell string, or a list of commands run in order. */
const hookSchema = z.union([z.string(), z.array(z.string())])

/** `scripts.<name>` — a command, optionally a long-running service with a port. */
const scriptSchema = z.object({
  command: z.string().min(1, "script command must be non-empty"),
  type: z.literal("service").optional(),
  port: z.number().int().min(1).max(65535).optional(),
})

const configSchema = z.object({
  worktree: z
    .object({
      setup: hookSchema.optional(),
      teardown: hookSchema.optional(),
    })
    .optional(),
  scripts: z.record(z.string(), scriptSchema).optional(),
})

export type ScriptConfig = z.infer<typeof scriptSchema>
export type AgentprotoConfig = z.infer<typeof configSchema>

/** A validation failure with the offending file surfaced for error messages. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}

/**
 * Parse + validate raw `agentproto.json` text. Throws {@link ConfigError} on
 * malformed JSON or a schema violation.
 */
export function parseConfig(raw: string): AgentprotoConfig {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new ConfigError(
      `${CONFIG_FILENAME} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const result = configSchema.safeParse(json)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ")
    throw new ConfigError(`${CONFIG_FILENAME} failed validation: ${issues}`)
  }
  return result.data
}

/** Normalise a hook (string | string[] | undefined) into an ordered command list. */
export function normalizeHook(hook: string | readonly string[] | undefined): string[] {
  if (hook === undefined) return []
  return typeof hook === "string" ? [hook] : [...hook]
}

/** A named script, with its config attached — the shape supervisor/tools consume. */
export interface NamedScript extends ScriptConfig {
  name: string
}

/** All declared scripts as a list. */
export function listScripts(config: AgentprotoConfig): NamedScript[] {
  return Object.entries(config.scripts ?? {}).map(([name, cfg]) => ({ name, ...cfg }))
}

/** Only the `type: "service"` scripts. */
export function listServices(config: AgentprotoConfig): NamedScript[] {
  return listScripts(config).filter((s) => s.type === "service")
}

/** Look up a single named script, or `undefined` if it isn't declared. */
export function getScript(config: AgentprotoConfig, name: string): NamedScript | undefined {
  const cfg = config.scripts?.[name]
  return cfg ? { name, ...cfg } : undefined
}

/**
 * Load `agentproto.json` from the **committed tree** of `base` (default
 * `origin/main`) via `git show <base>:agentproto.json`. Returns `null` when
 * the base tree has no such file (the common "repo hasn't opted in" case).
 * Throws {@link ConfigError} on a present-but-invalid file.
 */
export async function loadConfigFromBase(
  repoRoot: string,
  base = "origin/main",
): Promise<AgentprotoConfig | null> {
  const spec = `${base}:${CONFIG_FILENAME}`
  const result = await execArgv("git", ["-C", repoRoot, "show", spec], repoRoot)
  if (result.exitCode !== 0) {
    // `git show` fails when the path doesn't exist in the tree, or the ref is
    // unknown. Treat "no config" (path/ref absent) as opt-out; surface other
    // git failures so a typo'd base ref isn't silently ignored.
    const stderr = result.stderr.toLowerCase()
    const pathAbsent =
      stderr.includes("does not exist") || stderr.includes("exists on disk, but not in")
    const refAbsent =
      stderr.includes("unknown revision") ||
      stderr.includes("bad revision") ||
      stderr.includes("invalid object name") ||
      stderr.includes("ambiguous argument")
    if (pathAbsent || refAbsent) return null
    throw new ConfigError(
      `could not read ${CONFIG_FILENAME} from '${spec}': ${result.stderr.trim() || `git exited ${result.exitCode}`}`,
    )
  }
  return parseConfig(result.stdout)
}
