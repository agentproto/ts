/**
 * `agentproto steward [--apply] [--idle <min>] [--min-confidence <x>]
 *   [--judge <auto|jev|agent>] [--ask-sessions] [--wait] [--json]`
 *
 * Convenience shortcut over `agentproto workflow run-file` for the built-in
 * `session-steward` app's workflow (`@agentproto/apps`'s
 * `session-steward/.agentproto/workflows/session-steward/WORKFLOW.md`):
 * classify idle sessions, close the rule-certain ones, judge the ambiguous
 * ones (Jev when JEV_API_KEY resolves, else a one-shot agent judge), and
 * close or flag the confident verdicts — a dry run unless `--apply`. Mirrors
 * `agentproto maintain`: installs the bundled app (upsert), starts the run,
 * prints its id, and `--wait` prints the report.
 *
 * The calling session (AGENTPROTO_SESSION_ID, when this runs inside one) is
 * passed as `callerSessionId`, so a steward run never judges its own caller.
 */
import { parseArgs } from "node:util"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { mcpToolCall, withDaemon } from "./workflow.js"
import { httpGetJson } from "./_daemon-helpers.js"
import { waitForRunEnd, type MaintainRunShape } from "./maintain.js"

const USAGE = `agentproto steward — wrap up idle agent sessions (judge, then close or flag)

Usage:
  agentproto steward [--apply] [--idle <min>] [--min-confidence <x>]
                     [--judge <auto|jev|agent>] [--ask-sessions] [--wait] [--json]
  agentproto steward --help

  --apply              Close / flag sessions. Default: dry run (plan + verdicts,
                       nothing is touched).
  --idle <min>         Idle threshold in minutes. Default 30.
  --min-confidence <x> Judge confidence (0..1) needed to act. Default 0.8.
  --judge <backend>    auto (Jev when JEV_API_KEY resolves, else the agent
                       judge), jev, or agent. Default auto. A Jev failure
                       always falls back to the agent judge.
  --ask-sessions       Ask low-confidence idle sessions directly whether
                       they're done (spends a turn in their conversation).
  --wait               Block until the run ends, then print its markdown report
                       (exit 0 when done, 1 when it failed/was cancelled).
  --json               Print the raw workflow_run_file reply (with --wait: the
                       finished run record).

Runs the built-in session-steward app's workflow via the daemon's
workflow_run_file — needs a running daemon (\`agentproto serve\`). Poll a run
with \`agentproto workflow status <runId>\`, or pass --wait.

Examples:
  agentproto steward --wait                  # dry run, print the report
  agentproto steward --apply --idle 60
  agentproto steward --apply --judge agent --min-confidence 0.9
`

export interface StewardArgs {
	input: {
		apply: boolean
		idleMinutes?: number
		minConfidence?: number
		judge?: "auto" | "jev" | "agent"
		askSessions: boolean
		callerSessionId?: string
	}
	wait: boolean
	json: boolean
}

/** Parse argv into the workflow input + output flags. Pure — `env` supplies
 *  the caller's own session id. */
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
				apply: { type: "boolean", default: false },
				idle: { type: "string" },
				"min-confidence": { type: "string" },
				judge: { type: "string" },
				"ask-sessions": { type: "boolean", default: false },
				wait: { type: "boolean", default: false },
				json: { type: "boolean", default: false },
			},
		}))
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) }
	}
	const input: StewardArgs["input"] = { apply: values.apply === true, askSessions: values["ask-sessions"] === true }
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
		if (values.judge !== "auto" && values.judge !== "jev" && values.judge !== "agent") {
			return { ok: false, error: `--judge must be auto, jev or agent, got "${String(values.judge)}"` }
		}
		input.judge = values.judge
	}
	const self = env["AGENTPROTO_SESSION_ID"]
	if (self) input.callerSessionId = self
	return { ok: true, value: { input, wait: values.wait === true, json: values.json === true } }
}

/** The bundled session-steward app's dir + WORKFLOW.md, via @agentproto/apps's
 *  own package resolution (monorepo or npm install alike). */
function resolveSessionStewardApp(): { appDir: string; workflowPath: string } {
	const require = createRequire(import.meta.url)
	const appDir = join(dirname(require.resolve("@agentproto/apps/package.json")), "session-steward")
	return { appDir, workflowPath: join(appDir, ".agentproto", "workflows", "session-steward", "WORKFLOW.md") }
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
	const { input, wait, json } = parsed.value

	let appDir: string
	let workflowPath: string
	try {
		;({ appDir, workflowPath } = resolveSessionStewardApp())
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
				`✓ Started session steward (${input.apply ? "apply" : "dry run"}) — run ${runId} (${String(result["status"])}).\n` +
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
		const report = run.output?.report
		process.stdout.write((typeof report === "string" ? report : "") + "\n")
		if (run.status !== "done") {
			process.stderr.write(`agentproto steward: run ${runId} ended ${run.status}${run.error ? ` — ${run.error}` : ""}\n`)
		}
	}
	return run.status === "done" ? 0 : 1
}
