/**
 * `agentproto maintain --max-reviews <n>`: a positive integer is forwarded
 * as the workflow's `maxReviews` input, anything else is refused with exit 2
 * before any daemon contact.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { parseMaxReviews, runMaintain } from "../commands/maintain.js"

afterEach(() => {
	vi.restoreAllMocks()
})

describe("parseMaxReviews", () => {
	it("is undefined when the flag is absent, so the workflow default applies", () => {
		expect(parseMaxReviews(undefined)).toBeUndefined()
	})

	it("accepts a positive integer", () => {
		expect(parseMaxReviews("10")).toBe(10)
		expect(parseMaxReviews(" 3 ")).toBe(3)
	})

	it("refuses zero, negatives, decimals and words", () => {
		for (const raw of ["0", "-1", "2.5", "ten", "", "1e2"]) {
			expect(parseMaxReviews(raw)).toBeNull()
		}
	})
})

describe("agentproto maintain --max-reviews", () => {
	it("exits 2 on a bad value before contacting the daemon", async () => {
		const errChunks: string[] = []
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			errChunks.push(String(chunk))
			return true
		})
		process.env["AGENTPROTO_DAEMON_URL"] = "http://127.0.0.1:9"
		const code = await runMaintain(["--max-reviews", "0"])
		expect(code).toBe(2)
		expect(errChunks.join("")).toContain("--max-reviews must be a positive integer")
	})
})
