/**
 * `agentproto maintain` / `steward` install their bundled app on every run.
 * When the daemon refuses that install because it would re-point a live
 * install into a linked git worktree, the command keeps the installed copy
 * and still starts the run; any other install failure still exits 1.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const calls: string[] = []
let installError: Error | undefined

vi.mock("../commands/workflow.js", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../commands/workflow.js")>()
	return {
		...orig,
		withDaemon: vi.fn(async () => ({ ok: true, endpoint: { url: "http://127.0.0.1:9" } })),
		mcpToolCall: vi.fn(async (_endpoint: unknown, name: string) => {
			calls.push(name)
			if (name === "app_install" && installError !== undefined) throw installError
			return name === "workflow_run_file" ? { runId: "run_1", status: "running" } : {}
		}),
	}
})

const { runMaintain } = await import("../commands/maintain.js")
const { runSteward } = await import("../commands/steward.js")

const REFUSED = new Error('app_install: worktree-repoint-refused: "@agentproto/x" is installed from "/live"; ...')

let home: string
const originalHome = process.env.HOME
let err: string[]

beforeEach(async () => {
	calls.length = 0
	installError = undefined
	err = []
	// steward reads ~/.agentproto rules: keep it off the real home.
	home = await mkdtemp(join(tmpdir(), "repoint-implicit-"))
	process.env.HOME = home
	vi.spyOn(process.stdout, "write").mockImplementation(() => true)
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
		err.push(String(chunk))
		return true
	})
})

afterEach(async () => {
	vi.restoreAllMocks()
	process.env.HOME = originalHome
	await rm(home, { recursive: true, force: true })
})

describe("implicit app_install refused as a worktree re-point", () => {
	it("maintain keeps the installed copy and still starts the run", async () => {
		installError = REFUSED
		expect(await runMaintain(["--repo", process.cwd()])).toBe(0)
		expect(calls).toEqual(["app_install", "workflow_run_file"])
		expect(err.join("")).toContain("kept the installed repo-maintenance app")
	})

	it("maintain still fails on any other install error", async () => {
		installError = new Error("app_install: unknown daemon tool id(s)")
		expect(await runMaintain(["--repo", process.cwd()])).toBe(1)
		expect(calls).toEqual(["app_install"])
	})

	it("steward keeps the installed copy and still starts the run", async () => {
		installError = REFUSED
		expect(await runSteward(["--no-wait"])).toBe(0)
		expect(calls).toEqual(["app_install", "workflow_run_file"])
		expect(err.join("")).toContain("kept the installed session-steward app")
	})

	it("steward still fails on any other install error", async () => {
		installError = new Error("app_install: boom")
		expect(await runSteward(["--no-wait"])).toBe(1)
		expect(calls).toEqual(["app_install"])
	})
})
