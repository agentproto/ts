import { describe, it, expect } from "vitest"
import { execSync } from "node:child_process"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Vendor-neutrality enforcement.
 *
 * The agentgovernance/v1 spec is vendor-neutral. Implementations of vendor-
 * specific adapters live in separate packages (e.g., @agentproto/governance-mastra).
 *
 * The `core` package MUST NOT import from any orchestration runtime, so a
 * consumer who only needs the spec / FS-only runtime never accidentally pulls
 * in Mastra/LangChain/Temporal/etc.
 *
 * This test fails if anyone introduces such an import.
 */

const __filename = fileURLToPath(import.meta.url)
const SRC_DIR = path.dirname(__filename)

const FORBIDDEN_PATTERNS = [
  // Bare-package imports
  /\bfrom\s+['"](mastra|langchain|temporal|@temporalio\/[^'"]+|@mastra\/[^'"]+|@langchain\/[^'"]+)['"]/,
  // Dynamic imports
  /\bimport\(\s*['"](mastra|langchain|temporal|@temporalio\/[^'"]+|@mastra\/[^'"]+|@langchain\/[^'"]+)['"]\s*\)/,
  // Require (CommonJS, just in case)
  /\brequire\(\s*['"](mastra|langchain|temporal|@temporalio\/[^'"]+|@mastra\/[^'"]+|@langchain\/[^'"]+)['"]\s*\)/,
]

describe("vendor neutrality", () => {
  it("src/ contains no imports from Mastra, LangChain, or Temporal packages", () => {
    // Use grep to scan all source files (excluding tests + build artifacts).
    // -r recursive, -n line numbers, -E extended regex
    // Excludes: dist/, *.test.ts (we may legitimately mention vendor names in comments)
    let raw = ""
    try {
      raw = execSync(
        `grep -rEn --include='*.ts' --exclude='*.test.ts' --exclude-dir='dist' '(import|from|require)\\s*\\(?\\s*[\\"'\\''](mastra|langchain|temporal|@mastra|@langchain|@temporalio)' "${SRC_DIR}" || true`,
        { encoding: "utf8" }
      )
    } catch {
      raw = ""
    }

    const lines = raw
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 0)

    const offenders = lines.filter(line =>
      FORBIDDEN_PATTERNS.some(pat => pat.test(line))
    )

    if (offenders.length > 0) {
      console.error("Vendor-neutrality violations:")
      for (const line of offenders) console.error("  " + line)
    }
    expect(offenders).toEqual([])
  })
})
