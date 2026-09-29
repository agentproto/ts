/**
 * Regression: the pool's detached deleter drops `.trash/.deleting` from an
 * EXIT trap. When the parent recorded the pid AFTER spawn, a deleter that
 * finished first (small tree, loaded host — the parent descheduled between
 * `spawn` and the write) ran its trap on a file that didn't exist yet, and the
 * parent then wrote a stale pid file: `.trash` was never empty again.
 *
 * The parent's stall is made deterministic by busy-waiting inside the real
 * `spawn` for longer than the deleter needs to drain and exit.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>()
	return {
		...actual,
		spawn: ((...args: Parameters<typeof actual.spawn>) => {
			const child = actual.spawn(...args)
			const until = Date.now() + 750
			while (Date.now() < until) {
				// parent stalled after spawn; the child runs to completion meanwhile
			}
			return child
		}) as typeof actual.spawn,
	}
})

import { ensureTrashDeleter } from "../fast-remove.js"

const cleanupPaths: string[] = []

afterEach(async () => {
	while (cleanupPaths.length) {
		await rm(cleanupPaths.pop()!, { recursive: true, force: true }).catch(() => {})
	}
})

describe("serialized background deleter — fast child", () => {
	it("leaves no stale pid file when the deleter finishes before the parent resumes", async () => {
		const trashParent = await mkdtemp(join(tmpdir(), "wt-fast-race-"))
		cleanupPaths.push(trashParent)
		await mkdir(join(trashParent, "one"))
		await writeFile(join(trashParent, "one", "x"), "y\n")

		ensureTrashDeleter(trashParent)

		const deadline = Date.now() + 10_000
		for (;;) {
			const left = await readdir(trashParent)
			if (left.length === 0) break
			if (Date.now() > deadline) throw new Error(`trash never drained, left: ${left}`)
			await new Promise((r) => setTimeout(r, 50))
		}
	}, 20_000)
})
