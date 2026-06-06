/**
 * CliAgentDistiller — a DistillPort backed by any local agent CLI running in
 * one-shot mode (prompt on stdin, response on stdout). The transport is generic;
 * the per-CLI specifics (command, argv, output parse) come from a CliEngine
 * descriptor, so claude / gemini / goose / … are one descriptor each.
 *
 * Same DistillPort contract + same prompt/parse as AnthropicDistiller (both use
 * the shared `distill-prompt` core), so the two are drop-in swappable behind the
 * `corpus distill --engine` flag.
 *
 * TRADE-OFFS vs the metered API:
 *   - Subscription rate caps — slower for big batches; pace with --throttle and
 *     let the runner skip+retry on non-zero exits.
 *   - Output is CLI text, not API structured output — same tolerant parse.
 *   - One process spawn per source — higher per-call overhead than fetch().
 */

import { tmpdir } from "node:os"
import { spawnWithStdin } from "@agentproto/cli-exec"
import type { DistillPort, DistillInput, DistilledItem } from "@agentproto/corpus"
import { buildDistillPrompt, parseItems } from "./distill-prompt.js"
import type { CliEngine } from "./cli-engines.js"

export interface CliAgentDistillerOptions {
  /** The CLI engine descriptor (command + argv + output parse). */
  readonly engine: CliEngine
  /** Optional model override passed to the engine, e.g. "haiku" to spend less quota. */
  readonly model?: string
  /** Max refined items per source (feeds the shared prompt). */
  readonly maxItems?: number
  /** Hard per-source timeout; kills a wedged CLI call. Default 120s. */
  readonly timeoutMs?: number
  /** Working dir. Default os.tmpdir() — neutral, no project CLAUDE.md / repo. */
  readonly cwd?: string
}

export class CliAgentDistiller implements DistillPort {
  private readonly engine: CliEngine
  private readonly model?: string
  private readonly maxItems: number
  private readonly timeoutMs: number
  private readonly cwd: string

  constructor(opts: CliAgentDistillerOptions) {
    this.engine = opts.engine
    this.model = opts.model
    this.maxItems = opts.maxItems ?? 8
    this.timeoutMs = opts.timeoutMs ?? 120_000
    this.cwd = opts.cwd ?? tmpdir()
  }

  async distill(input: DistillInput): Promise<readonly DistilledItem[]> {
    const prompt = buildDistillPrompt(input, this.maxItems)
    // A non-zero exit (often a rate cap) rejects here; the runner skips + retries
    // the source on the next pass.
    const stdout = await spawnWithStdin({
      command: this.engine.command,
      args: this.engine.buildArgs({ ...(this.model ? { model: this.model } : {}) }),
      stdin: prompt,
      cwd: this.cwd,
      timeoutMs: this.timeoutMs,
    })
    const text = this.engine.parseOutput(stdout) ?? stdout
    return parseItems(text)
  }
}
