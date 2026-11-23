/**
 * `maintain_run`: the daemon tool a routine targets to maintain every repo
 * the user config names. `all: true` reads the config's `maintain` section
 * and starts one `maintain` workflow run per repo; config defaults vs
 * explicit inputs; refused without `repos` or `all`; one repo failing to
 * start does not stop the others; a worktree re-point refusal on install is
 * tolerated. Dispatch is faked: the assertions are on the tool calls made.
 */

import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { AgentprotoConfig } from "../config.js"
import { registerMaintainRunTools, runMaintainRun, type MaintainRunDeps } from "../maintain-run-tool.js"
import { APP_INSTALL_WORKTREE_REPOINT_REFUSED } from "../app-tools.js"

const cleanup: string[] = []
afterEach(async () => {
	for (const p of cleanup.splice(0)) await rm(p, { recursive: true, force: true }).catch(() => {})
})

function git(cwd: string, ...args: string[]): void {
	const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
	if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`)
}

async function tmp(prefix: string): Promise<string> {
	const dir = realpathSync(await mkdtemp(join(tmpdir(), prefix)))
	cleanup.push(dir)
	return dir
}

async function makeRepo(name: string): Promise<string> {
	const root = await tmp(`maintain-run-${name}-`)
	git(root, "init", "-q", "-b", "main")
	git(root, "config", "user.email", "t@t.t")
	git(root, "config", "user.name", "t")
	await writeFile(join(root, "f"), "x")
	git(root, "add", ".")
	git(root, "commit", "-q", "-m", "init")
	return root
}

async function makeWorktreesRoot(repos: string[]): Promise<string> {
	const root = await tmp("maintain-run-root-")
	for (const [i, repo] of repos.entries()) {
		await mkdir(join(root, `bucket-${i}`), { recursive: true })
		git(repo, "worktree", "add", "-q", join(root, `bucket-${i}`, "wt"), "-b", `wt/${i}`)
	}
	return root
}

const ok = (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] })
const err = (message: string) => ({ content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true })

interface Call {
	name: string
	inputs: Record<string, unknown>
}

function fakeDeps(
	config: AgentprotoConfig,
	opts: { failRepo?: string; throwRepo?: string; installReply?: unknown } = {},
): { deps: MaintainRunDeps; calls: Call[] } {
	const calls: Call[] = []
	let n = 0
	const deps: MaintainRunDeps = {
		loadConfig: async () => config,
		resolveApp: () => ({ appDir: "/apps/repo-maintenance", workflowPath: "/apps/repo-maintenance/maintain/WORKFLOW.md" }),
		env: {},
		loadWorkspaces: async () => [],
		dispatchTool: async (name, inputs) => {
			calls.push({ name, inputs })
			if (name === "app_install") return opts.installReply ?? ok({ appId: "repo-maintenance" })
			const repo = (inputs["input"] as { repoRoot: string }).repoRoot
			if (repo === opts.throwRepo) throw new Error("boom")
			if (repo === opts.failRepo) return err("workflow load failed")
			n += 1
			return ok({ runId: `run_${n}`, status: "running" })
		},
	}
	return { deps, calls }
}

const runInputs = (calls: Call[]) =>
	calls.filter(c => c.name === "workflow_run_file").map(c => c.inputs["input"] as Record<string, unknown>)

describe("maintain_run", () => {
	it("all:true reads the config and starts one run per repo, after installing the app", { timeout: 30_000 }, async () => {
		const a = await makeRepo("a")
		const b = await makeRepo("b")
		const c = await makeRepo("c")
		const root = await makeWorktreesRoot([a, b])
		const { deps, calls } = fakeDeps({ worktrees: { root }, maintain: { repos: [c], exclude: [b] } })

		const res = await runMaintainRun({ all: true, applyMerged: true }, deps)

		expect(calls[0]).toEqual({ name: "app_install", inputs: { dir: "/apps/repo-maintenance" } })
		expect(calls.slice(1).map(c => c.name)).toEqual(["workflow_run_file", "workflow_run_file"])
		expect(calls[1]?.inputs["path"]).toBe("/apps/repo-maintenance/maintain/WORKFLOW.md")
		expect(runInputs(calls).map(i => i["repoRoot"])).toEqual([a, c])
		expect(res.runs).toEqual([
			{ repo: a, runId: "run_1", status: "running" },
			{ repo: c, runId: "run_2", status: "running" },
		])
		expect(res.excluded).toEqual([b])
		expect(res.app).toBe("installed")
	})

	it("takes maxReviews/reviewPreset/notify from config.maintain when the inputs are absent", { timeout: 30_000 }, async () => {
		const a = await makeRepo("a")
		const notify = { provider: "telegram" as const, address: "123" }
		const { deps, calls } = fakeDeps({ maintain: { discover: false, repos: [a], maxReviews: 5, reviewPreset: "sonnet", notify } })

		await runMaintainRun({ all: true, applyMerged: true }, deps)

		expect(runInputs(calls)).toEqual([
			{ repoRoot: a, applyMerged: true, applyReviewed: false, maxReviews: 5, reviewPreset: "sonnet", notify },
		])
	})

	it("explicit inputs win over config.maintain", { timeout: 30_000 }, async () => {
		const a = await makeRepo("a")
		const { deps, calls } = fakeDeps({
			maintain: { discover: false, repos: [a], maxReviews: 5, reviewPreset: "sonnet", notify: { address: "123" } },
		})

		await runMaintainRun(
			{ all: true, maxReviews: 2, reviewPreset: "opus", notify: { provider: "agentpush", source: "ch" }, applyReviewed: true },
			deps,
		)

		expect(runInputs(calls)).toEqual([
			{
				repoRoot: a,
				applyMerged: false,
				applyReviewed: true,
				maxReviews: 2,
				reviewPreset: "opus",
				notify: { provider: "agentpush", source: "ch" },
			},
		])
	})

	it("explicit repos without all: no discovery, no config repos, no exclude", { timeout: 30_000 }, async () => {
		const a = await makeRepo("a")
		const b = await makeRepo("b")
		const root = await makeWorktreesRoot([a])
		const { deps, calls } = fakeDeps({ worktrees: { root }, maintain: { repos: [a], exclude: [b] } })

		const res = await runMaintainRun({ repos: [b] }, deps)

		expect(runInputs(calls).map(i => i["repoRoot"])).toEqual([b])
		expect(res.runs).toHaveLength(1)
	})

	it("refuses without repos or all, before installing anything", async () => {
		const { deps, calls } = fakeDeps({})
		await expect(runMaintainRun({}, deps)).rejects.toThrow(/pass `all: true`/)
		await expect(runMaintainRun({ all: false, repos: [] }, deps)).rejects.toThrow(/pass `all: true`/)
		expect(calls).toEqual([])
	})

	it("a repo failing to start does not stop the following ones", { timeout: 30_000 }, async () => {
		const a = await makeRepo("a")
		const b = await makeRepo("b")
		const c = await makeRepo("c")
		const { deps, calls } = fakeDeps(
			{ maintain: { discover: false, repos: [a, b, c] } },
			{ throwRepo: a, failRepo: b },
		)

		const res = await runMaintainRun({ all: true }, deps)

		expect(runInputs(calls).map(i => i["repoRoot"])).toEqual([a, b, c])
		expect(res.runs).toEqual([
			{ repo: a, error: "boom" },
			{ repo: b, error: "workflow load failed" },
			{ repo: c, runId: "run_1", status: "running" },
		])
	})

	it("tolerates an install refused as a worktree re-point, fails on any other install error", { timeout: 30_000 }, async () => {
		const a = await makeRepo("a")
		const config = { maintain: { discover: false, repos: [a] } }
		const kept = fakeDeps(config, { installReply: err(`app_install: ${APP_INSTALL_WORKTREE_REPOINT_REFUSED}: ...`) })
		const res = await runMaintainRun({ all: true }, kept.deps)
		expect(res.app).toBe("kept")
		expect(res.runs).toHaveLength(1)

		const broken = fakeDeps(config, { installReply: err("app_install: boom") })
		await expect(runMaintainRun({ all: true }, broken.deps)).rejects.toThrow(/failed to install the repo-maintenance app/)
		expect(broken.calls.map(c => c.name)).toEqual(["app_install"])
	})

	it("the MCP tool answers at once with the run ids, isError only when no run started", { timeout: 30_000 }, async () => {
		const a = await makeRepo("a")
		const server = new McpServer({ name: "t", version: "0" })
		const { deps } = fakeDeps({ maintain: { discover: false, repos: [a] } })
		registerMaintainRunTools(server, deps)
		const tool = (server as unknown as {
			_registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>
		})._registeredTools["maintain_run"]
		expect(tool).toBeDefined()

		const reply = await tool!.handler({ all: true }, {})
		expect(reply.isError).toBeUndefined()
		expect(JSON.parse(reply.content[0]!.text).runs).toEqual([{ repo: a, runId: "run_1", status: "running" }])

		const refused = await tool!.handler({}, {})
		expect(refused.isError).toBe(true)
		expect(JSON.parse(refused.content[0]!.text).error).toMatch(/pass `all: true`/)
	})
})
