/**
 * CLI agent engines — descriptors for distilling through a local agent CLI in
 * headless one-shot mode (prompt on stdin, response on stdout), instead of a
 * metered API. Each engine declares its `command`, how to `buildArgs` (model
 * injection, output format, tool/MCP lockdown), and how to `parseOutput` of the
 * captured stdout into the model's text.
 *
 * WHY: distillation is a high-volume batch (hundreds of sources × ~8 items). On
 * the API that bills per token; routed through an authenticated agent-CLI
 * subscription (e.g. Claude Max) it draws on a flat monthly plan — ~$0 marginal
 * cost. Same DistillPort contract + same prompt/parse, swappable transport.
 *
 * Engines register full descriptors and are dispatched by id (no `engineId ===`
 * branching at the call site). Add a CLI by adding a descriptor below; gemini /
 * goose / codex etc. each become one entry.
 */

import { parseClaudeJsonOutput } from "@agentproto/cli-exec"

/** What a CLI engine needs to drive one stdin→stdout completion. */
export interface CliEngine {
  /** Stable id, used by `corpus distill --engine <id>`. */
  readonly id: string
  /** Whether this engine bills a subscription (no API key needed). Surfaced in help. */
  readonly subscriptionBilled: boolean
  /** Executable to invoke — must be on PATH and logged in. */
  readonly command: string
  /** Build the argv for one completion. The prompt is fed over stdin, not argv. */
  buildArgs(opts: { readonly model?: string }): string[]
  /** Extract the model's text from captured stdout; null → fall back to raw stdout. */
  parseOutput(stdout: string): string | null
}

/**
 * Claude Code in headless print mode, billed against the logged-in subscription.
 *
 * Flags (verified against `claude -p --help`):
 *   -p                     non-interactive print mode
 *   --output-format json   single-result JSON envelope ({ result, is_error, … })
 *   --strict-mcp-config    ignore all MCP servers (no --mcp-config ⇒ none load)
 *   --model <m>            optional alias ("haiku"/"sonnet") or full id
 * Deliberately NOT --bare: that flag forces ANTHROPIC_API_KEY auth and never
 * reads OAuth/keychain — which would bypass the subscription we're here to use.
 * Pair with cwd=os.tmpdir() (CliAgentDistiller default) so no project CLAUDE.md
 * is auto-discovered and the agent can't wander a repo.
 */
const CLAUDE_CODE: CliEngine = {
  id: "claude-code",
  subscriptionBilled: true,
  command: "claude",
  buildArgs: ({ model }) => [
    "-p",
    "--output-format",
    "json",
    "--strict-mcp-config",
    ...(model ? ["--model", model] : []),
  ],
  parseOutput: parseClaudeJsonOutput,
}

/** Registry of CLI engines, keyed by id. */
export const CLI_ENGINES: Readonly<Record<string, CliEngine>> = {
  [CLAUDE_CODE.id]: CLAUDE_CODE,
}
