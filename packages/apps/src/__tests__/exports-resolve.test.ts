import { describe, it, expect } from "vitest"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import pkg from "../../package.json" with { type: "json" }

// Guard: every `exports` condition must point at a file that the build
// actually emits. Regression for the flat-vs-nested mismatch where tsup emits
// `dist/code-team.mjs` (flat) but tsc emits `dist/code-team/index.d.ts`
// (nested) — the `types` condition pointed at a non-existent
// `dist/code-team.d.ts`, so every typed subpath consumer broke with TS7016.
// This test only means something after `pnpm build` (it checks `dist/`).
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

function conditionPaths(entry: unknown): string[] {
  if (typeof entry === "string") return [entry]
  if (entry && typeof entry === "object") {
    return Object.values(entry as Record<string, unknown>).flatMap(conditionPaths)
  }
  return []
}

describe("@agentproto/apps package exports", () => {
  const paths = Object.values(pkg.exports).flatMap(conditionPaths)

  it("declares subpath entries for all apps", () => {
    expect(Object.keys(pkg.exports)).toEqual(
      expect.arrayContaining([
        ".",
        "./code-team",
        "./content-team",
        "./mail-triage",
        "./media-viewer",
        "./ops-panel",
        "./session-viewer",
      ]),
    )
  })

  it.each(paths)("resolves export target %s to a real file", (rel) => {
    // package.json itself is always present; dist targets require a build.
    if (rel.endsWith("package.json")) {
      expect(existsSync(join(pkgRoot, rel))).toBe(true)
      return
    }
    expect(existsSync(join(pkgRoot, rel))).toBe(true)
  })
})
