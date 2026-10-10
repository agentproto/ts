/**
 * `agentproto steward [classify|analyze|act] …` — the session steward in
 * three independently usable steps that share one persisted snapshot:
 *
 *   classify   fast + cheap: rules + Jev's typed verdict/probabilities, ONE
 *              recommended action per session, written to a snapshot.
 *   analyze    LLM pass over the relevant sessions only: writes the reason,
 *              question, error kind, next step and relaunch hint into it.
 *   act        applies a snapshot by the rules (dry run unless --apply),
 *              re-checking each session against the live registry first.
 *
 * Bare `steward` = classify. `steward --apply` = classify + act in one go.
 * `--legacy` runs the original single-workflow steward.
 *
 * Each step is a bundled workflow of the `session-steward` app, run through
 * the daemon's `workflow_run_file` (same plumbing as `agentproto maintain`).
 * The calling session (AGENTPROTO_SESSION_ID) is passed as `callerSessionId`
 * so a run never judges its own caller.
 */
import { parseArgs } from "node:util"
import { createRequire } from "node:module"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import matter from "gray-matter"
import { mcpToolCall, withDaemon } from "./workflow.js"
import { httpGetJson, type DaemonEndpoint } from "./_daemon-helpers.js"
import { waitForRunEnd, type MaintainRunShape } from "./maintain.js"

/** Mirrors `ACTIONS` in the app's `actions.mjs` (the workflow re-validates). */
export const STEWARD_ACTIONS = [
	"keep",
	"mark-complete",
	"mark-failed",
	"relaunch",
	"needs-input",
	"close-abandoned",
	"archive",
] as const

export type StewardSub = "classify" | "analyze" | "act" | "legacy"

const USAGE = `agentproto steward — classify agent sessions, then act on the snapshot

Usage:
  agentproto steward [classify] [--idle <min>] [--rules <file>] [--all] [--json]
  agentproto steward classify --llm            classify, then analyze the relevant rows
  agentproto steward analyze [<snapshotId|latest>] [--session <id,…>] [--only <action,…>]
                             [--judge <agent|jev>] [--max-sessions <n>] [--json]
  agentproto steward act [<snapshotId|latest>] [--rules <file>] [--only <action,…>]
                         [--session <id,…>] [--apply] [--allow-relaunch] [--json]
  agentproto steward --apply                   one-shot: classify + act
  agentproto steward --legacy [--apply] [--ask-sessions] [--judge <auto|jev|agent>] [--wait]
  agentproto steward --help

Steps (each usable alone, all write into the same snapshot):
  classify   Rules + Jev's typed verdict and probabilities. No agent LLM, no
             free-text reason. Prints a table grouped by recommended action
             and the snapshot id. Never mutates.
  analyze    LLM pass over ONLY the relevant sessions (action not "keep", low
             confidence, or --session). Records reason / question / errorKind
             / nextStep / relaunchHint into the snapshot; may revise the
             action (the classify verdict stays alongside). Never mutates.
  act        Re-checks each session against the live registry ("changed since
             snapshot" => skipped), applies the rules, bounds by origin (a
             user-origin session is never closed, only flagged), and records
             the outcome (done|failed|abandoned|needs-input + reason, …) on
             the session. Dry run unless --apply.

Actions: ${STEWARD_ACTIONS.join(" | ")}
  "relaunch" and "archive" run only when named with --only (relaunch also with
  --allow-relaunch), so a plain --apply keeps the conservative behaviour.

Flags:
  --apply              Perform the planned actions (act, or one-shot with classify).
  --idle <min>         Idle threshold in minutes. Default 30.
  --min-confidence <x> Confidence (0..1) needed to act on a verdict. Default 0.8.
  --relaunch-window <min>
                       classify: only recommend "relaunch" for sessions that
                       failed within this many minutes (older: mark-failed).
                       Default 360. Rules key: failedMinutesAgo.
  --rules <file>       Custom rules (YAML or JSON). Default: auto-load
                       ./.agentproto/steward-rules.yaml (or .yml/.json), then
                       ~/.agentproto/steward-rules.yaml. First match wins,
                       then the built-in defaults. Unknown keys are errors.
  --only <a,b,…>      Restrict to these recommended actions.
  --session <a,b,…>   Restrict to these session ids (repeatable).
  --allow-relaunch     Let "relaunch" run without naming it in --only.
  --judge <backend>    analyze: agent (default) | jev (no LLM spend). Legacy:
                       auto | jev | agent.
  --max-sessions <n>   analyze: most sessions analysed per run. Default 20.
  --llm                classify: run analyze on the new snapshot right after.
  --all                Also list "keep" rows in the report.
  --no-wait            Start the run and return its id (default: block, print
                       the report; exit 0 when done, 1 when failed). The
                       legacy mode keeps its old default (--wait is opt-in).
  --json               Print the run output (counts, rows, snapshot) instead
                       of the report.
  --legacy             The original single-run steward (also --ask-sessions).

Needs a running daemon (\`agentproto serve\`). Snapshots live in the
session-steward app's data dir (snapshots/latest.json).

Examples:
  agentproto steward                            # classify, print the table
  agentproto steward act latest                 # dry run of the default rules
  agentproto steward act latest --rules my.yaml --apply
  agentproto steward analyze --only mark-failed,needs-input
  agentproto steward --apply                    # classify + act in one go
`

export interface StewardArgs {
	sub: StewardSub
	/** The workflow input for the (first) run. */
	input: Record<string, unknown>
	/** Rules file the user named (undefined = auto-load). */
	rulesPath?: string
	/** `classify --llm`: analyze the fresh snapshot afterwards. */
	llm: boolean
	/** Input for the analyze run that follows `classify --llm`. */
	analyzeInput?: Record<string, unknown>
	wait: boolean
	json: boolean
}

const SUBS = new Set(["classify", "analyze", "act"])

function csv(values: readonly string[] | undefined): string[] | undefined {
	if (!values || values.length === 0) return undefined
	const out = values
		.flatMap((v) => v.split(","))
		.map((s) => s.trim())
		.filter(Boolean)
	return out.length > 0 ? out : undefined
}

/** Parse argv into the sub-command, workflow input and output flags. Pure —
 *  `env` supplies the caller's own session id. */
export function parseStewardArgs(
	args: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
): { ok: true; value: StewardArgs } | { ok: false; error: string } {
	let values: Record<string, string | boolean | string[] | undefined>
	let positionals: string[]
	try {
		;({ values, positionals } = parseArgs({
			args: [...args],
			allowPositionals: true,
			strict: true,
			options: {
				apply: { type: "boolean", default: false },
				idle: { type: "string" },
				"min-confidence": { type: "string" },
				"relaunch-window": { type: "string" },
				judge: { type: "string" },
				"ask-sessions": { type: "boolean", default: false },
				legacy: { type: "boolean", default: false },
				llm: { type: "boolean", default: false },
				rules: { type: "string" },
				only: { type: "string", multiple: true },
				session: { type: "string", multiple: true },
				"allow-relaunch": { type: "boolean", default: false },
				"max-sessions": { type: "string" },
				all: { type: "boolean", default: false },
				wait: { type: "boolean", default: false },
				"no-wait": { type: "boolean", default: false },
				json: { type: "boolean", default: false },
			},
		}))
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) }
	}

	let sub: StewardSub = "classify"
	const rest = [...positionals]
	if (rest[0] !== undefined && SUBS.has(rest[0])) sub = rest.shift() as StewardSub
	if (values.legacy === true || values["ask-sessions"] === true) sub = "legacy"
	const snapshot = rest.shift()
	if (rest.length > 0) return { ok: false, error: `unexpected argument "${rest[0]}"` }
	if (snapshot !== undefined && sub !== "analyze" && sub !== "act") {
		return { ok: false, error: `unexpected argument "${snapshot}" (a snapshot id only applies to analyze / act)` }
	}
	if (values.llm === true && sub !== "classify") return { ok: false, error: "--llm only applies to classify" }
	if (values.wait === true && values["no-wait"] === true) return { ok: false, error: "--wait and --no-wait conflict" }

	const apply = values.apply === true
	const input: Record<string, unknown> = {}
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
	if (values["relaunch-window"] !== undefined) {
		const n = Number(values["relaunch-window"])
		if (!Number.isFinite(n) || n < 0) return { ok: false, error: `--relaunch-window must be a number of minutes >= 0, got "${String(values["relaunch-window"])}"` }
		input.relaunchWindowMinutes = n
	}
	const judge = values.judge as string | undefined
	if (judge !== undefined) {
		const allowed = sub === "legacy" ? ["auto", "jev", "agent"] : ["agent", "jev"]
		if (!allowed.includes(judge)) return { ok: false, error: `--judge must be ${allowed.join(", ")}, got "${judge}"` }
	}
	const only = csv(values.only as string[] | undefined)
	if (only) {
		const bad = only.filter((a) => !(STEWARD_ACTIONS as readonly string[]).includes(a))
		if (bad.length > 0) return { ok: false, error: `--only: unknown action ${bad.map((b) => `"${b}"`).join(", ")} (valid: ${STEWARD_ACTIONS.join(", ")})` }
	}
	let maxSessions: number | undefined
	if (values["max-sessions"] !== undefined) {
		const n = Number(values["max-sessions"])
		if (!Number.isInteger(n) || n < 1) return { ok: false, error: `--max-sessions must be a positive integer, got "${String(values["max-sessions"])}"` }
		maxSessions = n
	}
	const sessions = csv(values.session as string[] | undefined)
	const self = env["AGENTPROTO_SESSION_ID"]
	if (self) input.callerSessionId = self
	const json = values.json === true

	if (sub === "legacy") {
		input.apply = apply
		input.askSessions = values["ask-sessions"] === true
		if (judge) input.judge = judge
		return { ok: true, value: { sub, input, llm: false, wait: values.wait === true, json } }
	}

	if (sub === "classify") {
		if (apply) input.apply = true
		if (only) input.only = only
		if (sessions) input.sessions = sessions
		if (values["allow-relaunch"] === true) input.allowRelaunch = true
		if (values.all === true) input.showKeep = true
		if (json) input.returnSnapshot = true
	} else if (sub === "analyze") {
		input.snapshot = snapshot ?? "latest"
		if (only) input.only = only
		if (sessions) input.sessions = sessions
		if (judge) input.judge = judge
		if (maxSessions !== undefined) input.maxSessions = maxSessions
		if (values.all === true) input.showKeep = true
		if (json) input.returnSnapshot = true
	} else {
		input.snapshot = snapshot ?? "latest"
		if (apply) input.apply = true
		if (only) input.only = only
		if (sessions) input.sessions = sessions
		if (values["allow-relaunch"] === true) input.allowRelaunch = true
		if (values.all === true) input.showKeep = true
	}

	const llm = values.llm === true
	const analyzeInput: Record<string, unknown> | undefined = llm
		? {
				snapshot: "latest",
				...(only ? { only } : {}),
				...(sessions ? { sessions } : {}),
				...(judge ? { judge } : {}),
				...(maxSessions !== undefined ? { maxSessions } : {}),
				...(self ? { callerSessionId: self } : {}),
				...(json ? { returnSnapshot: true } : {}),
			}
		: undefined
	const rulesPath = values.rules as string | undefined
	return {
		ok: true,
		value: { sub, input, ...(rulesPath ? { rulesPath } : {}), llm, ...(analyzeInput ? { analyzeInput } : {}), wait: values["no-wait"] !== true, json },
	}
}

export type RulesLoad = { ok: true; rules?: unknown; source?: string } | { ok: false; error: string }

const AUTO_RULE_NAMES = ["steward-rules.yaml", "steward-rules.yml", "steward-rules.json"]

/** Read a rules file (YAML or JSON). With no explicit path, auto-load
 *  `<cwd>/.agentproto/steward-rules.*`, then `<home>/.agentproto/…`; no file
 *  is fine (the built-in defaults apply). Parsing only — the workflow
 *  validates the shape and reports unknown keys. */
export function loadStewardRules(explicit: string | undefined, opts: { cwd?: string; home?: string } = {}): RulesLoad {
	const cwd = opts.cwd ?? process.cwd()
	const home = opts.home ?? homedir()
	let path = explicit ? resolve(cwd, explicit) : undefined
	if (!path) {
		for (const base of [join(cwd, ".agentproto"), join(home, ".agentproto")]) {
			const hit = AUTO_RULE_NAMES.map((n) => join(base, n)).find((p) => existsSync(p))
			if (hit) {
				path = hit
				break
			}
		}
	}
	if (!path) return { ok: true }
	let text: string
	try {
		text = readFileSync(path, "utf8")
	} catch (err) {
		return { ok: false, error: `cannot read rules file ${path}: ${err instanceof Error ? err.message : String(err)}` }
	}
	try {
		const parsed: unknown = path.endsWith(".json")
			? JSON.parse(text)
			: (matter as unknown as { engines: { yaml: { parse: (s: string) => unknown } } }).engines.yaml.parse(text)
		if (parsed === null || parsed === undefined || typeof parsed !== "object") {
			return { ok: false, error: `rules file ${path} must hold an object (or a list of rules)` }
		}
		// The workflow's `rules` input is an object; a bare list is shorthand for it.
		return { ok: true, rules: Array.isArray(parsed) ? { version: 1, rules: parsed } : parsed, source: path }
	} catch (err) {
		return { ok: false, error: `rules file ${path} is not valid ${path.endsWith(".json") ? "JSON" : "YAML"}: ${err instanceof Error ? err.message : String(err)}` }
	}
}

const WORKFLOW_IDS: Record<StewardSub, string> = {
	classify: "session-steward-classify",
	analyze: "session-steward-analyze",
	act: "session-steward-act",
	legacy: "session-steward",
}

/** The bundled session-steward app's dir, via @agentproto/apps's own package
 *  resolution (monorepo or npm install alike). */
function resolveSessionStewardApp(): { appDir: string; workflowPath: (id: string) => string } {
	const require = createRequire(import.meta.url)
	const appDir = join(dirname(require.resolve("@agentproto/apps/package.json")), "session-steward")
	return { appDir, workflowPath: (id) => join(appDir, ".agentproto", "workflows", id, "WORKFLOW.md") }
}

type StewardRun = Omit<MaintainRunShape, "output"> & { output?: Record<string, unknown> }

interface RunOutcome {
	run: StewardRun | null
	started?: Record<string, unknown>
	code: number
}

async function startAndWait(
	endpoint: DaemonEndpoint,
	path: string,
	input: Record<string, unknown>,
	wait: boolean,
	label: string,
): Promise<RunOutcome> {
	let result: Record<string, unknown>
	try {
		result = (await mcpToolCall(endpoint, "workflow_run_file", { path, input })) as Record<string, unknown>
	} catch (err) {
		process.stderr.write(`agentproto steward: ${err instanceof Error ? err.message : String(err)}\n`)
		return { run: null, code: 1 }
	}
	if (result["error"] !== undefined) {
		process.stderr.write(`agentproto steward: ${String(result["error"])}\n`)
		return { run: null, code: 1 }
	}
	const runId = String(result["runId"])
	if (!wait) return { run: null, started: result, code: 0 }
	process.stderr.write(`agentproto steward: ${label} — waiting for run ${runId}…\n`)
	try {
		const run = (await waitForRunEnd(() =>
			httpGetJson<MaintainRunShape>(`${endpoint.url}/workflows/${encodeURIComponent(runId)}`),
		)) as StewardRun
		return { run, code: run.status === "done" ? 0 : 1 }
	} catch (err) {
		process.stderr.write(`agentproto steward: ${err instanceof Error ? err.message : String(err)}\n`)
		return { run: null, code: 1 }
	}
}

function reportOf(run: StewardRun): string {
	const report = run.output?.["report"]
	return typeof report === "string" ? report : ""
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
	const { sub, wait, json, llm } = parsed.value
	const input = { ...parsed.value.input }

	if (sub !== "legacy") {
		const rules = loadStewardRules(parsed.value.rulesPath)
		if (!rules.ok) {
			process.stderr.write(`agentproto steward: ${rules.error}\n`)
			return 2
		}
		if (rules.rules !== undefined) {
			input["rules"] = rules.rules
			input["rulesSource"] = rules.source
		}
	}

	let app: ReturnType<typeof resolveSessionStewardApp>
	try {
		app = resolveSessionStewardApp()
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

	// Agent steps resolve `agent.ref` against the installed-app registry, and
	// the snapshots live in the app's data dir — install (upsert) first.
	try {
		await mcpToolCall(daemon.endpoint, "app_install", { dir: app.appDir })
	} catch (err) {
		process.stderr.write(
			`agentproto steward: failed to install the session-steward app: ${err instanceof Error ? err.message : String(err)}\n`,
		)
		return 1
	}

	const first = await startAndWait(daemon.endpoint, app.workflowPath(WORKFLOW_IDS[sub]), input, wait, sub)
	if (!first.run) {
		if (first.started && !json) {
			const runId = String(first.started["runId"])
			process.stdout.write(
				`✓ Started steward ${sub}${input["apply"] === true ? " (apply)" : ""} — run ${runId} (${String(first.started["status"])}).\n` +
					`  Follow: agentproto workflow status ${runId}   (or re-run without --no-wait)\n`,
			)
		} else if (first.started) {
			process.stdout.write(JSON.stringify(first.started, null, 2) + "\n")
		}
		return first.code
	}

	let second: StewardRun | null = null
	if (llm && first.run.status === "done") {
		const analyzeInput = { ...(parsed.value.analyzeInput ?? {}) }
		const snapshotId = (first.run.output?.["summary"] as { snapshotId?: string } | undefined)?.snapshotId
		if (snapshotId) analyzeInput["snapshot"] = snapshotId
		const next = await startAndWait(daemon.endpoint, app.workflowPath(WORKFLOW_IDS.analyze), analyzeInput, true, "analyze")
		second = next.run
		if (!second) return next.code || 1
	}

	if (json) {
		const out = second ? { classify: first.run.output, analyze: second.output } : first.run.output
		process.stdout.write(JSON.stringify(out ?? {}, null, 2) + "\n")
	} else {
		process.stdout.write(reportOf(first.run) + "\n")
		if (second) process.stdout.write("\n" + reportOf(second) + "\n")
	}
	for (const run of [first.run, second]) {
		if (run && run.status !== "done") {
			process.stderr.write(`agentproto steward: run ${run.runId} ended ${run.status}${run.error ? ` — ${run.error}` : ""}\n`)
		}
	}
	return first.run.status === "done" && (!second || second.status === "done") ? 0 : 1
}
