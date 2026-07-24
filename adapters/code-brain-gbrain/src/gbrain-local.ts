/**
 * `ICodeBrainProvider` backed by a local gbrain container via `docker exec`.
 *
 * This is the tracked replacement for the untracked
 * `~/agentproto-kb/tools/code-explorer-mcp` script: it shells the exact same
 * gbrain subcommands the home script used, but behind the pure code-brain
 * contract so `ask_codebase` never sees a gbrain idiom. The gbrain dialect
 * (`code-def`, `code-callers`, `--source-id __all__`, `--autocut false`)
 * lives HERE and nowhere else.
 *
 * Command mapping (verified against live `gbrain-pg`, v0.42.62.0):
 *   defineSymbol(s) → gbrain code-def    <s>
 *   callers(s)      → gbrain code-callers <s> --all-sources
 *   callees(s)      → gbrain code-callees <s> --all-sources
 *   graphQuery(q)   → gbrain query <q> --source-id <scope|__all__> --autocut false --limit <n>
 */

import { execFile } from "node:child_process"
import type {
  CallEdge,
  GraphQuery,
  GraphResult,
  ICodeBrainProvider,
  SymbolDef,
} from "@agentproto/code-brain"
import { loadGbrainLocalEnv, type GbrainLocalEnv } from "./env.js"
import { parseCallEdges, parseQueryText, parseSymbolDef } from "./parse.js"

/** Default `limit` for a blend query, matching the home-script behaviour. */
const DEFAULT_QUERY_LIMIT = 10

/** All-sources scope wildcard — gbrain's federated-search sentinel. */
const ALL_SOURCES = "__all__"

export class GbrainLocalProvider implements ICodeBrainProvider {
  private readonly env: GbrainLocalEnv

  constructor(env: GbrainLocalEnv = loadGbrainLocalEnv()) {
    this.env = env
  }

  async defineSymbol(symbol: string): Promise<SymbolDef | null> {
    const stdout = await this.run(["code-def", symbol])
    return parseSymbolDef(symbol, stdout)
  }

  async callers(symbol: string): Promise<readonly CallEdge[]> {
    const stdout = await this.run(["code-callers", symbol, "--all-sources"])
    return parseCallEdges(stdout, "callers")
  }

  async callees(symbol: string): Promise<readonly CallEdge[]> {
    const stdout = await this.run(["code-callees", symbol, "--all-sources"])
    return parseCallEdges(stdout, "callees")
  }

  /**
   * Probe whether the gbrain container is locally operational — runs
   * `docker exec <container> gbrain --version`. Returns false (never throws)
   * when docker is absent, the container is down, or the binary errors.
   */
  async check(): Promise<boolean> {
    try {
      await this.run(["--version"])
      return true
    } catch {
      return false
    }
  }

  async graphQuery(query: GraphQuery): Promise<GraphResult> {
    const limit = query.limit ?? DEFAULT_QUERY_LIMIT
    const sourceId = query.scope ?? ALL_SOURCES
    const stdout = await this.run([
      "query",
      query.question,
      "--source-id",
      sourceId,
      "--autocut",
      "false",
      "--limit",
      String(limit),
    ])
    return { hits: parseQueryText(stdout) }
  }

  /** Run `docker exec <container> gbrain <…gbrainArgs>` and return stdout. */
  private run(gbrainArgs: readonly string[]): Promise<string> {
    const argv = ["exec", this.env.container, this.env.binary, ...gbrainArgs]
    return new Promise((resolve, reject) => {
      execFile(
        "docker",
        argv,
        { maxBuffer: this.env.maxBufferBytes, timeout: this.env.timeoutMs },
        (error, stdout, stderr) => {
          if (error !== null) {
            const detail = stderr.trim().length > 0 ? stderr.trim() : error.message
            reject(
              new Error(`gbrain ${gbrainArgs.join(" ")} failed (${this.env.container}): ${detail}`),
            )
            return
          }
          resolve(stdout.trim())
        },
      )
    })
  }
}

/** Construct a {@link GbrainLocalProvider} from the ambient environment. */
export function gbrainLocalProvider(env?: GbrainLocalEnv): GbrainLocalProvider {
  return new GbrainLocalProvider(env)
}
