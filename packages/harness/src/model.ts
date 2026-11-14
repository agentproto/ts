/**
 * Agent CLI as a model port — turn ANY AIP-45 agent CLI runtime into a generic
 * `complete({system?, prompt}) → {result}` executor. This is the one bridge that
 * lets the SAME registry (hermes, claude-code, opencode, codex, openclaw, …)
 * back any prompt→completion seam: a report's chapter writer, a corpus
 * distiller, a Mastra tool's judgment step. The executor swaps, the prompts
 * (built by each seam's engine) don't.
 *
 * It drives the CLI over **ACP**: per `complete()` it spawns a fresh session,
 * sends one user turn, concatenates the `text-delta` stream until `turn-end`,
 * then closes. Lives here (not in a product) so seams BELOW the products —
 * `@agentproto/corpus` distill, the CLI — can consume it without importing
 * upward. The runner is injectable so assembly is unit-tested without a binary.
 */

import type { AgentCliRuntime } from "./types.js"

/**
 * The minimal structural model port every seam consumes. Anything with this
 * `complete` shape satisfies the corpus `ReportModelPort` / `DistillPort`-backing
 * model / an AIP `ModelPort` — duck-typed, no nominal coupling.
 */
export interface ModelLike {
  complete(req: {
    system?: string
    prompt: string
    [k: string]: unknown
  }): Promise<{ result: string }>
}

/**
 * The "file-reading sub-agent" tier — opt-in across every file-IO-capable
 * executor. When `datasetDir` is set the executor is rooted there and granted
 * its own read tools, so instead of being limited to the excerpts a seam quotes
 * in the prompt it can open the primary sources directly and ground first-hand.
 */
export interface FileReadingOptions {
  /** Absolute path to the dataset/source root the executor may read from. */
  datasetDir?: string
}

/** The instruction prepended to a completion when {@link FileReadingOptions.datasetDir} is set. */
export function datasetPreamble(datasetDir: string): string {
  return (
    `You have direct read access to the source files under \`${datasetDir}\` ` +
    `(e.g. \`sources/\` raw captures, \`entries/\` refined notes). Use your ` +
    `file-reading tools to consult the primary sources directly when grounding ` +
    `claims — do not rely only on the excerpts quoted in this prompt.`
  )
}

/** Compose system + prompt with an optional source-access preamble (shared by every executor). */
export function composePrompt(
  system: string | undefined,
  prompt: string,
  datasetDir?: string
): string {
  const head = datasetDir ? `${datasetPreamble(datasetDir)}\n\n` : ""
  return system ? `${head}${system}\n\n${prompt}` : `${head}${prompt}`
}

/** Provider keys an agent CLI may route through, forwarded from the parent env by default. */
export const PROVIDER_KEY_ENV = [
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const

export interface AgentCliModelOptions extends FileReadingOptions {
  /**
   * Env handed to the spawned CLI process — the provider key it routes through.
   * Defaults to forwarding {@link PROVIDER_KEY_ENV} from the parent process env.
   */
  env?: Record<string, string>
  /** Working directory for the CLI process. Defaults to `datasetDir` when set. */
  cwd?: string
  /** Timeout per completion (ms). Default 5 min. */
  timeoutMs?: number
  /**
   * Injectable runner (composed prompt → completion text). Defaults to driving
   * the runtime over ACP. Override in tests to avoid the CLI.
   */
  run?: (prompt: string) => Promise<string>
}

/** Build the env for the spawned CLI: explicit override, else forwarded provider keys. */
export function resolveCliEnv(
  opts: Pick<AgentCliModelOptions, "env">
): Record<string, string> {
  if (opts.env) return opts.env
  const env: Record<string, string> = {}
  for (const k of PROVIDER_KEY_ENV) {
    const v = process.env[k]
    if (v) env[k] = v
  }
  return env
}

/** Drive one ACP turn on `runtime`, concatenating the text deltas. */
async function driveTurn(
  runtime: AgentCliRuntime,
  prompt: string,
  opts: AgentCliModelOptions
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? 5 * 60 * 1000
  )

  const cwd = opts.cwd ?? opts.datasetDir
  const session = await runtime.start({
    env: resolveCliEnv(opts),
    signal: controller.signal,
    ...(cwd ? { cwd } : {}),
  })

  try {
    let text = ""
    for await (const evt of session.send({ role: "user", content: prompt })) {
      if (evt.kind === "text-delta") {
        text += evt.text
      } else if (evt.kind === "error") {
        throw new Error(`${runtime.definition.id} model: ${evt.error.message}`)
      } else if (evt.kind === "turn-end") {
        if (evt.reason !== "completed")
          throw new Error(`${runtime.definition.id} model: turn ${evt.reason}`)
        break
      }
    }
    if (controller.signal.aborted)
      throw new Error(`${runtime.definition.id} model: timed out`)
    return text.trim()
  } finally {
    clearTimeout(timer)
    await session.close()
  }
}

/**
 * Build a {@link ModelLike} backed by an AIP-45 agent-CLI runtime. Hand it any
 * `*Runtime()` from the registry (Hermes, claude-code, opencode, …); per-CLI
 * presets are one-liners over this.
 */
export function makeAgentCliModel(
  runtime: AgentCliRuntime,
  opts: AgentCliModelOptions = {}
): ModelLike {
  const run = opts.run ?? ((prompt: string) => driveTurn(runtime, prompt, opts))
  return {
    async complete({ system, prompt }) {
      return {
        result: await run(composePrompt(system, prompt, opts.datasetDir)),
      }
    },
  }
}
