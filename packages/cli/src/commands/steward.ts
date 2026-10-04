/**
 * `agentproto steward [--idle <min>] [--judge <agent|rules>] [--include-children]
 *   [--format <markdown|text>] [--wait] [--json]`   (default: attention)
 * `agentproto steward --wrapup [--apply] [--idle <min>] [--min-confidence <x>]
 *   [--judge <auto|jev|agent>] [--ask-sessions] [--wait] [--json]`
 *
 * Convenience shortcut over `agentproto workflow run-file` for the built-in
 * `session-steward` app (`@agentproto/apps`'s `session-steward/.agentproto/`):
 *  - default: the READ-ONLY `session-attention` workflow — which live sessions
 *    need the human (a reply, an unblock, a restart, a close), most urgent
 *    first;
 *  - `--wrapup`: the legacy `session-steward` workflow — classify idle
 *    sessions, close the rule-certain ones, judge the ambiguous ones and close
 *    or flag the confident verdicts (a dry run unless `--apply`).
 * Mirrors `agentproto maintain`: installs the bundled app (upsert), starts the
 * run, prints its id, and `--wait` prints the report.
 *
 * The calling session (AGENTPROTO_SESSION_ID, when this runs inside one) is
 * passed as `callerSessionId`, so a steward run never triages its own caller.
 */
import { parseArgs } from "node:util"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { mcpToolCall, withDaemon } from "./workflow.js"
import { httpGetJson } from "./_daemon-helpers.js"
import { waitForRunEnd, type MaintainRunShape } from "./maintain.js"

const USAGE = `agentproto steward — tell me which sessions need me

Usage:
  agentproto steward [--idle <min>] [--judge <agent|rules>] [--include-children]
                     [--format <markdown|text>] [--wait] [--json]
  agentproto steward --wrapup [--apply] [--idle <min>] [--min-confidence <x>]
                     [--judge <auto|jev|agent>] [--ask-sessions] [--wait] [--json]
  agentproto steward --help

Default (attention, read-only): triage every live session — needs-reply,
stuck (looping / errored), blocked, done, superseded, parked — most urgent
first, each with a one-line reason and an excerpt. Never closes or messages
anything.

  --idle <min>         Minutes since last activity before a finished turn
                       counts as waiting. Default 10 (30 with --wrapup).
  --judge <backend>    attention: agent (default) or rules (no model).
                       --wrapup: auto, jev or agent (default auto).
  --include-children   attention only: also triage executors whose supervisor
                       is still live.
  --format <fmt>       With --wait: print the markdown report (default) or the
                       plain-text digest (chat/Telegram-ready, capped).
  --wait               Block until the run ends, then print the report
                       (exit 0 when done, 1 when it failed/was cancelled).
  --json               Print the raw workflow_run_file reply (with --wait: the
                       finished run record).

Wrap-up mode (--wrapup) is the old behaviour — close or flag idle sessions:

  --apply              Close / flag sessions. Default: dry run.
  --min-confidence <x> Judge confidence (0..1) needed to act. Default 0.8.
  --ask-sessions       Ask low-confidence idle sessions directly whether
                       they're done (spends a turn in their conversation).

Runs the built-in session-steward app's workflows via the daemon's
workflow_run_file — needs a running daemon (\`agentproto serve\`). Poll a run
with \`agentproto workflow status <runId>\`, or pass --wait.

Examples:
  agentproto steward --wait                  # what needs me, markdown
  agentproto steward --wait --format text    # the Telegram-ready digest
  agentproto steward --wrapup --wait         # legacy dry run, print the report
  agentproto steward --wrapup --apply --idle 60
`

export interface StewardArgs {
	mode: "attention" | "wrapup"
	input: {
		apply?: boolean
		idleMinutes?: number
		minConfidence?: number
		judge?: "auto" | "jev" | "agent" | "rules"
		askSessions?: boolean
		includeChildren?: boolean
		callerSessionId?: string
	}
	format: "markdown" | "text"
	wait: boolean
	json: boolean
}

/** Parse argv into the workflow input + output flags. Pure — `env` supplies
 *  the caller's own session id. Wrap-up-only flags without `--wrapup` are an
 *  error (never a silent dry run). */
export function parseStewardArgs(
	args: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
): { ok: true; value: StewardArgs } | { ok: false; error: string } {
	let values: Record<string, string | boolean | undefined>
	try {
		;({ values } = parseArgs({
			args: [...args],
			allowPositionals: false,
			strict: true,
			options: {
				wrapup: { type: "boolean", default: false },
				apply: { type: "boolean", default: false },
				idle: { type: "string" },
				"min-confidence": { type: "string" },
				judge: { type: "string" },
				"ask-sessions": { type: "boolean", default: false },
				"include-children": { type: "boolean", default: false },
				format: { type: "string" },
				wait: { type: "boolean", default: false },
				json: { type: "boolean", default: false },
			},
		}))
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) }
	}
	const wrapup = values.wrapup === true
	const mode: StewardArgs["mode"] = wrapup ? "wrapup" : "attention"
	if (!wrapup) {
		for (const flag of ["apply", "min-confidence", "ask-sessions"] as const) {
			if (values[flag] !== undefined && values[flag] !== false) {
				return { ok: false, error: `--${flag} belongs to the close/flag mode — add --wrapup (the default mode is read-only)` }
			}
		}
	} else if (values["include-children"] === true) {
		return { ok: false, error: "--include-children only applies to the default (attention) mode" }
	}
	const input: StewardArgs["input"] = wrapup ? { apply: values.apply === true, askSessions: values["ask-sessions"] === true } : {}
	if (!wrapup && values["include-children"] === true) input.includeChildren = true
	if (values.idle !== undefined) {
		const n = Number(values.idle)
		if (!Number.isInteger(n) || n < 1) return { ok: false, error: `--idle must be a positive integer (minutes), got "${String(values.idle)}"` }
		input.idleMinutes = n
	}
	if (values["min-confidence"] !== undefined) {
		const x = Number(values["min-confidence"])
		if (!Number.isFinite(x) || x < 0 || x > 1) {
			return { ok: false, error: `--min-confidence must be a number in 0..1, got "${String(values["min-confidence"])}"` }
		}
		input.minConfidence = x
	}
	if (values.judge !== undefined) {
		const allowed = wrapup ? ["auto", "jev", "agent"] : ["agent", "rules"]
		if (!allowed.includes(String(values.judge))) {
			return { ok: false, error: `--judge must be ${allowed.join(", ")}${wrapup ? "" : " (or add --wrapup for auto/jev)"}, got "${String(values.judge)}"` }
		}
		input.judge = values.judge as NonNullable<StewardArgs["input"]["judge"]>
	}
	let format: StewardArgs["format"] = "markdown"
	if (values.format !== undefined) {
		if (values.format !== "markdown" && values.format !== "text") {
			return { ok: false, error: `--format must be markdown or text, got "${String(values.format)}"` }
		}
		format = values.format
	}
	const self = env["AGENTPROTO_SESSION_ID"]
	if (self) input.callerSessionId = self
	return { ok: true, value: { mode, input, format, wait: values.wait === true, json: values.json === true } }
}

/** The bundled session-steward app's dir + WORKFLOW.md, via @agentproto/apps's
 *  own package resolution (monorepo or npm install alike). */
function resolveSessionStewardApp(mode: StewardArgs["mode"]): { appDir: string; workflowPath: string } {
	const require = createRequire(import.meta.url)
	const appDir = join(dirname(require.resolve("@agentproto/apps/package.json")), "session-steward")
	const id = mode === "wrapup" ? "session-steward" : "session-attention"
	return { appDir, workflowPath: join(appDir, ".agentproto", "workflows", id, "WORKFLOW.md") }
}

export async function runSteward(args: readonly string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(USAGE)
		return 0
	}
	const parsed = parseStewardArgs(args)
	if (!parsed.ok) {
		process.stderr.write(`agentproto steward: ${parsed.error}\n\n${USAGE}`)
		return 2
	}
	const { mode, input, format, wait, json } = parsed.value
	const runLabel = mode === "wrapup" ? `session steward (${input.apply ? "apply" : "dry run"})` : "session attention (read-only)"

	let appDir: string
	let workflowPath: string
	try {
		;({ appDir, workflowPath } = resolveSessionStewardApp(mode))
	} catch (err) {
		process.stderr.write(
			`agentproto steward: cannot locate the bundled session-steward app — is @agentproto/apps installed? ${
				err instanceof Error ? err.message : String(err)
			}\n`,
		)
		return 1
	}

	const daemon = await withDaemon("agentproto steward")
	if (!daemon.ok) return daemon.code

	// The `judge` agent step resolves `agent.ref` against the daemon's
	// installed-app registry — install (upsert) first, as `maintain` does.
	try {
		await mcpToolCall(daemon.endpoint, "app_install", { dir: appDir })
	} catch (err) {
		process.stderr.write(
			`agentproto steward: failed to install the session-steward app: ${err instanceof Error ? err.message : String(err)}\n`,
		)
		return 1
	}

	let result: Record<string, unknown>
	try {
		result = (await mcpToolCall(daemon.endpoint, "workflow_run_file", { path: workflowPath, input })) as Record<string, unknown>
	} catch (err) {
		process.stderr.write(`agentproto steward: ${err instanceof Error ? err.message : String(err)}\n`)
		return 1
	}
	if (result["error"] !== undefined) {
		process.stderr.write(`agentproto steward: ${String(result["error"])}\n`)
		return 1
	}
	const runId = String(result["runId"])
	if (!wait) {
		if (json) process.stdout.write(JSON.stringify(result, null, 2) + "\n")
		else
			process.stdout.write(
				`✓ Started ${runLabel} — run ${runId} (${String(result["status"])}).\n` +
					`  Follow: agentproto workflow status ${runId}   (or re-run with --wait)\n`,
			)
		return 0
	}

	process.stderr.write(`agentproto steward: waiting for run ${runId}…\n`)
	let run: MaintainRunShape
	try {
		run = await waitForRunEnd(() => httpGetJson<MaintainRunShape>(`${daemon.endpoint.url}/workflows/${encodeURIComponent(runId)}`))
	} catch (err) {
		process.stderr.write(`agentproto steward: ${err instanceof Error ? err.message : String(err)}\n`)
		return 1
	}
	if (json) {
		process.stdout.write(JSON.stringify(run, null, 2) + "\n")
	} else {
		const out = run.output?.[format === "text" && mode === "attention" ? "text" : "report"]
		process.stdout.write((typeof out === "string" ? out : "") + "\n")
		if (run.status !== "done") {
			process.stderr.write(`agentproto steward: run ${runId} ended ${run.status}${run.error ? ` — ${run.error}` : ""}\n`)
		}
	}
	return run.status === "done" ? 0 : 1
}
