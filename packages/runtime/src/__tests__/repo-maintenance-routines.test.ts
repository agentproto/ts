/**
 * The shipped repo-maintenance routines (`@agentproto/apps`'s
 * `repo-maintenance/routines/*`) stay generic: they target the daemon tool
 * `maintain_run` with `all: true`, carry no absolute path and no chat id,
 * and the registrar lowers them without injecting the routine workspace as
 * a `repoRoot` (that injection only applies to `workflow` targets, which is
 * what pinned the old routines to one repo).
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseRoutineManifest } from "@agentproto/routine"
import { routineTargetToToolCall } from "../routine-registrar.js"
import { resolveRepoMaintenanceApp } from "../maintain-run-tool.js"
import { DAEMON_TOOL_NAMES } from "../daemon-tool-names.generated.js"

const routinesDir = join(resolveRepoMaintenanceApp().appDir, "routines")

function load(id: string) {
	const source = readFileSync(join(routinesDir, id, "ROUTINE.md"), "utf8")
	return { source, frontmatter: parseRoutineManifest(source).frontmatter }
}

describe("shipped repo-maintenance routines", () => {
	it.each([
		["repo-maintenance-daily", { all: true, applyMerged: true }],
		["repo-maintenance-weekly", { all: true, applyMerged: true, applyReviewed: true }],
	])("%s targets maintain_run with no repoRoot injected", (id, inputs) => {
		const { frontmatter } = load(id)
		expect(frontmatter.enabled).toBe(false)
		const call = routineTargetToToolCall(frontmatter.target, id, { workspaceRoot: "/some/workspace" })
		expect(call).toEqual({ tool: "maintain_run", inputs })
		expect(call.inputs).not.toHaveProperty("repoRoot")
		expect(DAEMON_TOOL_NAMES).toContain("maintain_run")
	})

	it.each(["repo-maintenance-daily", "repo-maintenance-weekly"])("%s frontmatter holds no path and no chat id", id => {
		const { source } = load(id)
		const fm = source.split("\n---")[0] ?? ""
		expect(fm).not.toMatch(/\bfile:/)
		expect(fm).not.toMatch(/\baddress:/)
		expect(fm).not.toMatch(/\bnotify:/)
		expect(fm).not.toMatch(/(^|\s)\/[A-Za-z]/m)
		expect(fm).not.toContain("REPLACE_WITH")
	})
})
