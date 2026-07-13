/**
 * `agentproto run <slug> [--cwd <dir>] [--prompt <text>] [--resume <id>]`
 *
 * Boots the named adapter, dispatches a single user turn, streams events
 * to stdout, then exits. Designed for two use-cases:
 *   - one-shot scripting (pipe a prompt in, get stream back)
 *   - quick smoke-test from a fresh checkout ("does claude even spawn?")
 *
 * Long-lived multiplexing belongs to `agentproto serve`, not here.
 */

import { parseArgs } from "node:util"
import { resolve as resolvePath } from "node:path"
import {
  createAgentCliRuntime,
  type AgentCliRuntimeSession,
  type StreamEvent,
} from "@agentproto/driver-agent-cli"
import { formatToolCall, formatToolResult } from "@agentproto/runtime"
import { resolveAdapter } from "../registry/resolve.js"
import { readStdinIfPiped } from "../util/stdin.js"
import {
  buildRetryInstruction,
  buildSchemaInstruction,
  compileValidator,
  type OutputSchema,
  OutputSchemaError,
  parseFinalJson,
  resolveOutputSchema,
  type SchemaValidator,
} from "../util/output-schema.js"

const USAGE = `agentproto run — spawn an adapter, dispatch one turn, stream events, exit

Usage:
  agentproto run <slug> [--cwd <dir>] [--prompt <text>] [--model <id>]
                        [--effort <level>] [--resume <session-id>] [--json]
                        [--output-schema <path-or-inline-json>]
                        [--hold-permissions]

  agentproto run claude-code --prompt "summarise this repo"
  agentproto run claude-code --model claude-opus-4-8 --prompt "review this"
  echo "fix the bug" | agentproto run hermes --cwd .
  agentproto run claude-code --resume <session-id> --prompt "continue"
  agentproto run claude-code -p "did the tests pass?" \\
    --output-schema '{"type":"object","required":["passed"],"properties":{"passed":{"type":"boolean"}}}'

\`--model\` / \`--effort\` are applied the same way \`agentproto sessions start\`
and the MCP \`agent_start\` tool apply them (via the adapter's manifest
\`model\`/\`effort\` options). Adapters that don't declare them reject the
value with a clear error rather than silently ignoring it.

\`--output-schema\` takes a JSON Schema (inline JSON when the first non-space
char is \`{\`, otherwise a path to a \`.json\` file). The agent's final answer is
validated against it; on success stdout is EXACTLY the matching JSON (compact,
one line) and every log goes to stderr. On a mismatch the turn is re-prompted
up to twice before exiting non-zero with the validation errors on stderr.
Cannot be combined with \`--json\`.

One-shot scripting / smoke-test verb. Long-lived multiplexing belongs to
\`agentproto serve\`.
`

/** Initial attempt + this many schema-mismatch re-prompts before failing. */
const SCHEMA_MAX_RETRIES = 2

export async function runRun(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  let values: {
    cwd?: string
    prompt?: string
    model?: string
    effort?: string
    resume?: string
    json?: boolean
    "output-schema"?: string
    "hold-permissions"?: boolean
  }
  let positionals: string[]
  try {
    ;({ values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        cwd: { type: "string" },
        prompt: { type: "string", short: "p" },
        model: { type: "string" },
        effort: { type: "string" },
        resume: { type: "string" },
        json: { type: "boolean" },
        "output-schema": { type: "string" },
        "hold-permissions": { type: "boolean" },
      },
    }))
  } catch (err) {
    // A friendly message on an unknown flag/arg instead of a raw parseArgs
    // stack — point at the help so callers can discover the supported set.
    process.stderr.write(
      `agentproto run: ${err instanceof Error ? err.message : String(err)}\n` +
        "  See: agentproto run --help\n",
    )
    return 2
  }

  const slug = positionals[0]
  if (!slug) {
    process.stderr.write(
      "agentproto run: missing adapter slug. Try: agentproto run claude-code\n"
    )
    return 2
  }

  const cwd = values.cwd ? resolvePath(values.cwd) : process.cwd()
  const promptArg = values.prompt ?? (await readStdinIfPiped())
  if (!promptArg) {
    process.stderr.write(
      "agentproto run: no prompt provided. Pass --prompt or pipe one over stdin.\n"
    )
    return 2
  }

  // --output-schema: validate-and-emit-JSON mode. `--json` streams raw events
  // to stdout, which is exactly what schema mode must keep clean — they can't
  // both own stdout, so reject the combination up front.
  const schemaArg = values["output-schema"]
  if (schemaArg !== undefined && values.json) {
    process.stderr.write(
      "agentproto run: --output-schema cannot be combined with --json " +
        "(both control stdout).\n",
    )
    return 2
  }
  let schema: OutputSchema | undefined
  let validator: SchemaValidator | undefined
  if (schemaArg !== undefined) {
    try {
      schema = resolveOutputSchema(schemaArg)
      // Compile eagerly so an unusable schema fails before we spawn anything,
      // and keep the result so runSchemaMode can reuse it without recompiling.
      validator = compileValidator(schema)
    } catch (err) {
      if (err instanceof OutputSchemaError) {
        process.stderr.write(`agentproto run: --output-schema: ${err.message}\n`)
        return 2
      }
      throw err
    }
  }

  const adapter = await resolveAdapter(slug)
  const runtime = createAgentCliRuntime(adapter.handle)

  // Mirror serve.ts / agent_start: `model` and `effort` are manifest-declared
  // options, applied via the adapter's own model/effort handling (ACP
  // set_config_option for claude-code, a `/model` control turn for hermes).
  // Build config.options only when something is set — an empty options map
  // trips composeSpawn's "no declared options" early-return.
  const options: Record<string, string> = {}
  if (values.model) options.model = values.model
  if (values.effort) options.effort = values.effort
  const config =
    Object.keys(options).length > 0 ? { options } : undefined

  const controller = new AbortController()
  const onSignal = (sig: NodeJS.Signals) => {
    process.stderr.write(`\nagentproto: received ${sig}, cancelling…\n`)
    controller.abort()
  }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)

  let session: AgentCliRuntimeSession | null = null
  try {
    if (values["hold-permissions"]) {
      // One-shot `run` has no permission inbox of its own — surface the note so
      // the user understands the turn will BLOCK on the first gated tool call
      // (there's no responder here). The daemon-backed surfaces
      // (`agentproto sessions start --hold-permissions` + `agentproto
      // permissions`) are where a held request can actually be approved/denied.
      process.stderr.write(
        "\x1b[2magentproto run: --hold-permissions surfaces each permission " +
          "request; with no inbox attached the turn blocks until you Ctrl-C. " +
          "Use `agentproto sessions start --hold-permissions` for the approvable " +
          "daemon-backed flow.\x1b[0m\n",
      )
    }
    session = await runtime.start({
      cwd,
      signal: controller.signal,
      resumeSessionId: values.resume,
      ...(config ? { config } : {}),
      ...(values["hold-permissions"] ? { permissionHold: true } : {}),
    })

    if (schema && validator) {
      return await runSchemaMode(session, promptArg, schema, validator)
    }

    const printer = values.json ? printJson : printPretty
    let exit = 0
    for await (const ev of session.send(promptArg)) {
      printer(ev)
      if (ev.kind === "turn-end" && ev.reason !== "completed") exit = 1
      if (ev.kind === "error") exit = 1
    }
    return exit
  } finally {
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
    if (session) await session.close().catch(() => {})
  }
}

/**
 * Structured-output loop for `--output-schema`. Runs the turn, accumulates the
 * agent's final text, parses + validates it against `schema`, and re-prompts up
 * to {@link SCHEMA_MAX_RETRIES} times on a mismatch. On success, stdout is
 * EXACTLY the validated JSON (compact); every diagnostic goes to stderr.
 */
async function runSchemaMode(
  session: AgentCliRuntimeSession,
  firstPrompt: string,
  schema: OutputSchema,
  validator: SchemaValidator,
): Promise<number> {
  let prompt = `${firstPrompt}${buildSchemaInstruction(schema)}`

  for (let attempt = 0; attempt <= SCHEMA_MAX_RETRIES; attempt++) {
    let finalText = ""
    let turnBroke = false
    for await (const ev of session.send(prompt)) {
      // Never touch stdout here — it's reserved for the validated JSON.
      logToStderr(ev)
      if (ev.kind === "text-delta") finalText += ev.text
      if (ev.kind === "turn-end" && ev.reason !== "completed") turnBroke = true
      if (ev.kind === "error") turnBroke = true
    }
    if (turnBroke) {
      process.stderr.write(
        "agentproto run: turn did not complete cleanly; cannot validate output.\n",
      )
      return 1
    }

    let errors: string
    const parsed = parseFinalJson(finalText)
    if (parsed.ok) {
      const result = validator.validate(parsed.value)
      if (result.ok) {
        // The one and only thing on stdout: the validated JSON, compact.
        process.stdout.write(`${JSON.stringify(parsed.value)}\n`)
        return 0
      }
      errors = result.errors
    } else {
      errors = parsed.error
    }

    if (attempt < SCHEMA_MAX_RETRIES) {
      process.stderr.write(
        `\x1b[33magentproto run: output did not match schema ` +
          `(attempt ${attempt + 1}/${SCHEMA_MAX_RETRIES + 1}): ${errors}\x1b[0m\n`,
      )
      prompt = buildRetryInstruction(errors)
    } else {
      process.stderr.write(
        `\x1b[31magentproto run: output did not match schema after ` +
          `${SCHEMA_MAX_RETRIES + 1} attempts: ${errors}\x1b[0m\n`,
      )
      return 1
    }
  }
  // Unreachable — the loop always returns — but keeps the type checker happy.
  return 1
}

/** Log a stream event to stderr (schema mode keeps stdout clean). */
function logToStderr(ev: StreamEvent): void {
  switch (ev.kind) {
    case "text-delta":
      process.stderr.write(`\x1b[2m${ev.text}\x1b[0m`)
      break
    case "tool-call":
      process.stderr.write(
        `\x1b[36m[tool] ${formatToolCall(ev.toolName, ev.arguments)}\x1b[0m\n`,
      )
      break
    case "tool-result": {
      const summary = formatToolResult(undefined, ev.result, ev.isError ?? false)
      if (summary) {
        process.stderr.write(
          ev.isError
            ? `\x1b[31m[tool-error] ${summary}\x1b[0m\n`
            : `\x1b[2m[tool-result] ${summary}\x1b[0m\n`,
        )
      }
      break
    }
    case "thought":
      process.stderr.write(`\x1b[2m[thought] ${ev.text}\x1b[0m\n`)
      break
    case "turn-end":
      process.stderr.write(`\x1b[2m[turn-end: ${ev.reason}]\x1b[0m\n`)
      break
    case "error":
      process.stderr.write(`\x1b[31m[error] ${ev.error.message}\x1b[0m\n`)
      break
    default:
      break
  }
}

function printJson(ev: StreamEvent): void {
  process.stdout.write(`${JSON.stringify(ev)}\n`)
}

function printPretty(ev: StreamEvent): void {
  switch (ev.kind) {
    case "text-delta":
      process.stdout.write(ev.text)
      break
    case "thought":
      process.stderr.write(`\x1b[2m[thought] ${ev.text}\x1b[0m\n`)
      break
    case "tool-call":
      process.stderr.write(
        `\x1b[36m[tool] ${formatToolCall(ev.toolName, ev.arguments)}\x1b[0m\n`
      )
      break
    case "tool-result": {
      const summary = formatToolResult(undefined, ev.result, ev.isError ?? false)
      if (summary) {
        process.stderr.write(
          ev.isError
            ? `\x1b[31m[tool-error] ${summary}\x1b[0m\n`
            : `\x1b[2m[tool-result] ${summary}\x1b[0m\n`
        )
      } else if (ev.isError) {
        process.stderr.write(`\x1b[31m[tool-error]\x1b[0m\n`)
      }
      break
    }
    case "agent-prompt":
      process.stderr.write(`\x1b[33m[agent-prompt: needs input]\x1b[0m\n`)
      break
    case "turn-end":
      process.stdout.write(`\n\x1b[2m[turn-end: ${ev.reason}]\x1b[0m\n`)
      break
    case "error": {
      const code =
        typeof ev.error.code === "number" ? ` (code ${ev.error.code})` : ""
      process.stderr.write(
        `\x1b[31m[error]${code} ${ev.error.message}\x1b[0m\n`,
      )
      // Attached child stderr (added by define-agent-cli) — usually
      // the most useful line ("not authenticated", "model gated",
      // missing binary path). Print after the headline so the
      // headline still scans first.
      const data = ev.error.data
      if (data && typeof data === "object") {
        const stderr = (data as { stderr?: unknown }).stderr
        if (typeof stderr === "string" && stderr.trim()) {
          process.stderr.write(`\x1b[2m── child stderr ──\n${stderr}\x1b[0m\n`)
        }
        // Surface any non-stderr fields as JSON so callers don't
        // have to switch to --json to see what payload was rejected.
        const rest = { ...(data as Record<string, unknown>) }
        delete rest.stderr
        if (Object.keys(rest).length > 0) {
          process.stderr.write(
            `\x1b[2m── error.data ──\n${JSON.stringify(rest, null, 2)}\x1b[0m\n`,
          )
        }
      }
      break
    }
  }
}
