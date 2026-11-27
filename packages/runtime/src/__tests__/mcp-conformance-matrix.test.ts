/**
 * `docs/mcp-conformance-matrix.md` is generated from the `_conformance` blocks of the conformance fixtures by
 * `scripts/mcp-conformance-matrix.mjs`. This test fails when the committed page and the fixtures disagree (a fixture
 * added, removed or edited without regenerating the page), and checks every replayed method has both polarities.
 */
import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))
const SCRIPT = `${ROOT}scripts/mcp-conformance-matrix.mjs`

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" })
}

describe("MCP conformance matrix (generated page)", () => {
  it("the committed docs/mcp-conformance-matrix.md equals what the fixtures generate", () => {
    const out = run(["--check"])
    expect(out.stderr).toBe("")
    expect(out.status).toBe(0)
  })

  it("every served method has a positive and a negative case; an unserved one has a negative case", () => {
    const page = readFileSync(`${ROOT}docs/mcp-conformance-matrix.md`, "utf8")
    const rows = page.split("\n").filter(line => /^\| `[a-z/]+` \| (gateway|elicitation|tasks|skills) \|/.test(line))
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const [, , , capability, positive, negative] = row.split(" | ")
      expect(Number(negative), row).toBeGreaterThan(0)
      if (!capability!.endsWith("(negative cases only: the method is not served)")) expect(Number(positive), row).toBeGreaterThan(0)
    }
  })
})
