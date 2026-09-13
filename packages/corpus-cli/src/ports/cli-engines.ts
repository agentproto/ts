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
 * branching at the call site). Add a CLI by adding a descriptor below.
 *
 * Two output shapes are covered:
 *   - **JSON-envelope** (claude-code) — `--output-format json` wraps the answer;
 *     `parseClaudeJsonOutput` unwraps `{ result }`.
 *   - **plain-text** (gemini / codex / opencode) — the CLI prints the answer
 *     straight to stdout; `plainTextOutput` only strips ANSI, and the tolerant
 *     `parseItems` grabs the `[…]` JSON array out of the text.
 *
 * NOTE on verification: claude-code's flags are verified against `claude -p
 * --help`. The other three use each CLI's *first-party non-interactive* print
 * mode (`gemini` piped stdin · `codex exec -` · `opencode run`), distinct from
 * the ACP wrappers `@agentproto/adapter-*` use for streaming/tool sessions. They
 * read the prompt from stdin and print plain text — the right fit for one-shot
 * distill with no adapter dependency. Confirm the exact flags against each CLI's
 * `--help` on the host before relying on them; they are easy to tweak here.
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
  /**
   * Build the argv for one completion.
   * Most engines receive the prompt over stdin and ignore `opts.prompt`.
   * Arg-based engines (hermes `-z`) embed the prompt in argv instead.
   */
  buildArgs(opts: { readonly model?: string; readonly prompt?: string }): string[]
  /** Extract the model's text from captured stdout; null → fall back to raw stdout. */
  parseOutput(stdout: string): string | null
}

/**
 * Plain-text print engines (gemini / codex / opencode) emit the model's answer
 * directly on stdout — no JSON envelope to unwrap. We only strip ANSI so the
 * tolerant `parseItems` JSON-array grab isn't tripped by colour codes when a CLI
 * forgets it's not a TTY. Returns the cleaned text (never null) — the fallback is
 * the text itself.
 */
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g")
function plainTextOutput(stdout: string): string {
  return stdout.replace(ANSI, "")
}

/**
 * Codex `exec --json` emits a JSONL event stream; the model's answer is the
 * `agent_message` item, not a clean text-only stdout (its human mode prints a
 * preamble whose brackets break the tolerant `[…]` grab). Walk the lines and
 * return the LAST agent-message text. Tolerates the two known event shapes
 * (`item.completed`→`item.text`, and the older `agent_message`→`message`);
 * verify against `codex exec --json` on the host if a version drifts. Null when
 * no message line is found → fall back to raw stdout.
 */
function parseCodexJsonl(stdout: string): string | null {
  let found: string | null = null
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    let evt: unknown
    try {
      evt = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!evt || typeof evt !== "object") continue
    const e = evt as Record<string, unknown>
    const item = e.item as Record<string, unknown> | undefined
    if (item?.type === "agent_message" && typeof item.text === "string") {
      found = item.text
    } else if (e.type === "agent_message" && typeof e.message === "string") {
      found = e.message
    }
  }
  return found
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

/**
 * Google Gemini CLI in non-interactive print mode. Piping the prompt on stdin to
 * a non-TTY `gemini` runs one completion and prints the answer to stdout. Auth is
 * the logged-in Google account (free tier) or GEMINI_API_KEY.
 *   -m <model>   optional model id (e.g. "gemini-2.5-pro" / "gemini-2.5-flash")
 */
const GEMINI: CliEngine = {
  id: "gemini",
  subscriptionBilled: true,
  command: "gemini",
  buildArgs: ({ model }) => [...(model ? ["-m", model] : [])],
  parseOutput: plainTextOutput,
}

/**
 * OpenAI Codex CLI in non-interactive automation mode (`codex exec`). The `-`
 * positional reads the prompt from stdin; the final assistant message prints to
 * stdout. Auth: ChatGPT login (subscription) or OPENAI_API_KEY / CODEX_API_KEY.
 *   exec                   one-shot, non-interactive run
 *   --skip-git-repo-check  allow running outside a git repo (cwd is os.tmpdir())
 *   --json                 JSONL event stream (clean — its human mode prints a
 *                          preamble whose brackets break the JSON-array grab)
 *   -m <model>             optional model id (e.g. "gpt-5-codex")
 *   -                      read the prompt from stdin
 * NOTE: this is Codex's own print mode, NOT the @agentclientprotocol/codex-acp bridge
 * the AIP-45 adapter uses for streaming sessions.
 */
const CODEX: CliEngine = {
  id: "codex",
  subscriptionBilled: true,
  command: "codex",
  buildArgs: ({ model }) => [
    "exec",
    "--skip-git-repo-check",
    "--json",
    ...(model ? ["-m", model] : []),
    "-",
  ],
  parseOutput: parseCodexJsonl,
}

/**
 * sst/opencode CLI in non-interactive run mode (`opencode run`). Reads the piped
 * stdin as the message and prints the assistant text to stdout. Multi-provider —
 * auth via the provider key the chosen model needs (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, OPENROUTER_API_KEY, …), so not subscription-billed by default.
 *   run            one-shot, non-interactive run
 *   -m <p/model>   optional provider/model id (e.g. "anthropic/claude-haiku-4-5")
 * NOTE: this is opencode's own print mode, NOT the `opencode acp` server the
 * AIP-45 adapter uses for streaming sessions.
 */
const OPENCODE: CliEngine = {
  id: "opencode",
  subscriptionBilled: false,
  command: "opencode",
  buildArgs: ({ model }) => ["run", ...(model ? ["-m", model] : [])],
  parseOutput: plainTextOutput,
}

/**
 * Hermes one-shot mode (`hermes -z/--oneshot "<prompt>"`). Unlike the stdin-piped
 * engines above, hermes takes the prompt as a positional argument via `-z`; stdin
 * is ignored. The `prompt` field in `buildArgs` is therefore REQUIRED for useful
 * output — `CliAgentDistiller` always passes it.
 *
 * Auth: logged-in Hermes session or HERMES_INFERENCE_PROVIDER env.
 *   -z <prompt>        one-shot prompt (prints ONLY the final response to stdout)
 *   -m <model>         optional model id (e.g. "claude-haiku-4-5")
 *   --provider <p>     optional provider override (e.g. "anthropic", "openrouter")
 *
 * Constraint: the full distill prompt (~10–30 KB) is passed as an argv value.
 * macOS ARG_MAX is 1 MB; this is well within limits. For very large sources the
 * 24 000-char body cap in `buildDistillPrompt` bounds the size.
 */
const HERMES: CliEngine = {
  id: "hermes",
  subscriptionBilled: true,
  command: "hermes",
  buildArgs: ({ model, prompt }) => [
    "--oneshot", prompt ?? "",
    ...(model ? ["-m", model] : []),
  ],
  parseOutput: plainTextOutput,
}

/** Registry of CLI engines, keyed by id. */
export const CLI_ENGINES: Readonly<Record<string, CliEngine>> = {
  [CLAUDE_CODE.id]: CLAUDE_CODE,
  [GEMINI.id]: GEMINI,
  [CODEX.id]: CODEX,
  [OPENCODE.id]: OPENCODE,
  [HERMES.id]: HERMES,
}
