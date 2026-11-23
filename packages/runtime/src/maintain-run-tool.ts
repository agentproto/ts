/**
 * `maintain_run`: the daemon-side twin of `agentproto maintain`, so a routine
 * (`target.tool: maintain_run`) or any MCP caller can run repo maintenance
 * over every repo the operator's config names, not just one.
 *
 * Why it exists: a routine with a `workflow` target runs the `maintain`
 * workflow for exactly one `repoRoot` (the registrar injects the routine's
 * workspace), and multi-repo discovery only existed in the CLI. The shipped
 * routines therefore had to hardcode a repo path and a chat id. This tool
 * reads both from the user config's `maintain` section
 * (`maintain-repos.ts`), so the shipped routines stay generic.
 *
 * Behaviour: `all: true` resolves the repo list from the config
 * (`resolveMaintainRepos`), else the explicit `repos` (refused when neither).
 * Installs the bundled repo-maintenance app (an `app_install` refused as a
 * worktree re-point keeps the installed copy, as the CLI does), then starts
 * ONE `maintain` workflow run per repo through `workflow_run_file`, which
 * returns as soon as the run is queued. So the tool answers immediately with
 * `{repo, runId}` per repo and never holds a cron tick. A repo that fails to
 * start is reported and the next ones still start.
 */

import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { loadConfig as defaultLoadConfig, type AgentprotoConfig } from "./config.js"
import { MODEL_ROLE_PRESET_NAMES } from "./model-roles.js"
import { APP_INSTALL_WORKTREE_REPOINT_REFUSED } from "./app-tools.js"
import {
	mainRepoRootOf,
	maintainWorkflowInput,
	readMaintainConfig,
	resolveMaintainRepos,
	type MaintainRunOptions,
	type ResolvedMaintainRepos,
} from "./maintain-repos.js"

export type MaintainDispatchTool = (name: string, inputs: Record<string, unknown>) => Promise<unknown>

export interface MaintainRunDeps {
	/** The daemon's in-process tool dispatch (`app_install`, `workflow_run_file`). */
	dispatchTool: MaintainDispatchTool
	/** Default: `loadConfig()` (`~/.agentproto/config.json`). */
	loadConfig?: () => Promise<AgentprotoConfig>
	/** Default: the bundled app under `@agentproto/apps`. */
	resolveApp?: () => { appDir: string; workflowPath: string }
	/** Dir -> main repo root. Default: `git rev-parse --git-common-dir`. */
	resolveRepoRoot?: (dir: string) => string | null
	env?: NodeJS.ProcessEnv
	home?: string
}

const notifySchema = z
	.object({
		provider: z.enum(["telegram", "agentpush"]).optional(),
		alias: z.string().min(1).optional(),
		address: z.string().min(1).optional(),
		source: z.string().min(1).optional(),
		channel: z.string().min(1).optional(),
	})
	.strict()

export const maintainRunInputShape = {
	repos: z
		.array(z.string().min(1))
		.optional()
		.describe("Repos to maintain (any dir inside each; `~/` expands). With `all`, added on top of the config's list."),
	all: z
		.boolean()
		.optional()
		.describe(
			"Maintain every repo the daemon config's `maintain` section names: repos owning a worktree under " +
				"`worktrees.root` + `worktrees.extraRoots` (unless `maintain.discover` is false), plus `maintain.repos`, " +
				"minus `maintain.exclude`.",
		),
	applyMerged: z.boolean().optional().describe("Apply branch_gc (reclaim-class) + worktree_gc after review. Default false."),
	applyReviewed: z
		.boolean()
		.optional()
		.describe("With applyMerged, also reclaim review-class branches whose stored verdict agreed. Default false."),
	requireOperatorBelowGuard: z
		.boolean()
		.optional()
		.describe("Below branch_gc's line-coverage guard, only an operator approval reclaims."),
	maxReviews: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe("Most branches sent to a reviewer per repo. Default: config `maintain.maxReviews`, else the workflow's (40)."),
	reviewPreset: z
		.enum(MODEL_ROLE_PRESET_NAMES)
		.optional()
		.describe("Reviewer model preset. Default: config `maintain.reviewPreset`, else the daemon's `modelRolePreset`."),
	notify: notifySchema
		.optional()
		.describe("Report target `{ provider?, alias?, address?, source? }`. Default: config `maintain.notify`, else none."),
}

const maintainRunInputSchema = z.object(maintainRunInputShape).strict()
export type MaintainRunInput = z.infer<typeof maintainRunInputSchema>

export interface MaintainRunRepoResult {
	repo: string
	runId?: string
	status?: string
	error?: string
}

export interface MaintainRunResult {
	runs: MaintainRunRepoResult[]
	/** `installed`, or `kept` when the install was refused as a worktree re-point. */
	app: "installed" | "kept"
	skipped: ResolvedMaintainRepos["skipped"]
	excluded: string[]
}

/** The bundled repo-maintenance app dir + its `maintain` WORKFLOW.md,
 *  resolved through `@agentproto/apps`'s own package (monorepo or npm). */
export function resolveRepoMaintenanceApp(): { appDir: string; workflowPath: string } {
	const require = createRequire(import.meta.url)
	const appDir = join(dirname(require.resolve("@agentproto/apps/package.json")), "repo-maintenance")
	return { appDir, workflowPath: join(appDir, ".agentproto", "workflows", "maintain", "WORKFLOW.md") }
}

/** Read a dispatched tool's reply: the MCP envelope's first text block,
 *  JSON-parsed when it is JSON, plus its `isError` flag. */
function readToolReply(reply: unknown): { isError: boolean; payload: unknown } {
	if (!reply || typeof reply !== "object") return { isError: false, payload: reply }
	const env = reply as { content?: Array<{ type?: string; text?: unknown }>; isError?: unknown }
	const text = env.content?.find(c => c.type === "text")?.text
	if (typeof text !== "string") return { isError: env.isError === true, payload: reply }
	let payload: unknown = text
	try {
		payload = JSON.parse(text)
	} catch {
		// plain-text reply, kept as is
	}
	return { isError: env.isError === true, payload }
}

function errorText(payload: unknown): string {
	if (payload && typeof payload === "object" && "error" in payload) return String((payload as { error: unknown }).error)
	return typeof payload === "string" ? payload : JSON.stringify(payload)
}

/**
 * The whole `maintain_run` behaviour, transport-free (the MCP handler below
 * wraps it). Throws on a caller error (no repos, invalid config, nothing to
 * maintain, the app cannot be installed); per-repo start failures are
 * reported in `runs[].error`, never thrown.
 */
export async function runMaintainRun(input: MaintainRunInput, deps: MaintainRunDeps): Promise<MaintainRunResult> {
	const explicit = input.repos ?? []
	if (input.all !== true && explicit.length === 0) {
		throw new Error("maintain_run: pass `all: true` (repos from the daemon config's `maintain` section) or `repos`.")
	}
	const loadConfig = deps.loadConfig ?? (() => defaultLoadConfig())
	const config = await loadConfig()
	const maintain = readMaintainConfig(config)

	let resolved: ResolvedMaintainRepos
	if (input.all === true) {
		resolved = await resolveMaintainRepos(config, {
			repos: explicit,
			...(deps.resolveRepoRoot ? { resolveRepoRoot: deps.resolveRepoRoot } : {}),
			...(deps.env ? { env: deps.env } : {}),
			...(deps.home ? { home: deps.home } : {}),
		})
	} else {
		// Explicit repos only: no discovery, no config repos, no exclude.
		resolved = await resolveMaintainRepos(
			{ ...config, maintain: { discover: false } },
			{
				repos: explicit,
				...(deps.resolveRepoRoot ? { resolveRepoRoot: deps.resolveRepoRoot } : {}),
				...(deps.home ? { home: deps.home } : {}),
			},
		)
	}
	if (resolved.repos.length === 0) {
		const why = resolved.skipped.map(s => `${s.path}: ${s.reason}`).join("; ")
		throw new Error(`maintain_run: no repo to maintain${why ? ` (${why})` : ""}.`)
	}

	const { appDir, workflowPath } = (deps.resolveApp ?? resolveRepoMaintenanceApp)()
	// The `review` step's agent ref resolves against the installed-app
	// registry, so the app must be installed. `app_install` upserts: cheap.
	let app: MaintainRunResult["app"] = "installed"
	let installError: string | undefined
	try {
		const reply = readToolReply(await deps.dispatchTool("app_install", { dir: appDir }))
		if (reply.isError) installError = errorText(reply.payload)
	} catch (err) {
		installError = err instanceof Error ? err.message : String(err)
	}
	if (installError !== undefined) {
		// A daemon running from a linked worktree's build while the app is
		// installed from a live checkout refuses to re-point it: keep the
		// installed copy and run anyway.
		if (!installError.includes(APP_INSTALL_WORKTREE_REPOINT_REFUSED)) {
			throw new Error(`maintain_run: failed to install the repo-maintenance app: ${installError}`)
		}
		app = "kept"
	}

	const opts: MaintainRunOptions = {
		...(input.applyMerged !== undefined ? { applyMerged: input.applyMerged } : {}),
		...(input.applyReviewed !== undefined ? { applyReviewed: input.applyReviewed } : {}),
		...(input.requireOperatorBelowGuard !== undefined ? { requireOperatorBelowGuard: input.requireOperatorBelowGuard } : {}),
		...(input.maxReviews !== undefined ? { maxReviews: input.maxReviews } : {}),
		...(input.reviewPreset !== undefined ? { reviewPreset: input.reviewPreset } : {}),
		...(input.notify !== undefined ? { notify: input.notify } : {}),
	}
	const runs: MaintainRunRepoResult[] = []
	for (const repo of resolved.repos) {
		try {
			const reply = readToolReply(
				await deps.dispatchTool("workflow_run_file", {
					path: workflowPath,
					input: maintainWorkflowInput(repo, opts, maintain),
				}),
			)
			const payload = (reply.payload && typeof reply.payload === "object" ? reply.payload : {}) as Record<string, unknown>
			if (reply.isError || payload["error"] !== undefined || typeof payload["runId"] !== "string") {
				runs.push({
					repo,
					...(typeof payload["runId"] === "string" ? { runId: payload["runId"] } : {}),
					error: errorText(reply.payload),
				})
				continue
			}
			runs.push({ repo, runId: payload["runId"], status: String(payload["status"] ?? "running") })
		} catch (err) {
			runs.push({ repo, error: err instanceof Error ? err.message : String(err) })
		}
	}
	return { runs, app, skipped: resolved.skipped, excluded: resolved.excluded }
}

export function registerMaintainRunTools(server: McpServer, deps: MaintainRunDeps): void {
	server.tool(
		"maintain_run",
		"Run repo maintenance (the bundled repo-maintenance app's `maintain` workflow: plan worktree/branch gc, review " +
			"unmerged branches, optionally apply) over several repos at once. `all: true` takes the repo list from the " +
			"daemon config's `maintain` section (discovered worktree-owning repos + `maintain.repos` - `maintain.exclude`); " +
			"else pass `repos`. `maxReviews`/`reviewPreset`/`notify` default to `maintain.*` in the config. Starts one " +
			"background run per repo and returns at once with `runs: [{repo, runId}]` (poll each with `workflow_status`); " +
			"a repo that fails to start is reported in its `error` and does not stop the others.",
		maintainRunInputShape,
		async input => {
			try {
				const result = await runMaintainRun(input, deps)
				const started = result.runs.filter(r => r.error === undefined).length
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					...(started === 0 ? { isError: true } : {}),
				}
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
					isError: true,
				}
			}
		},
	)
}
