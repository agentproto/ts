import { describe, it, expect } from "vitest"
import { execSync } from "node:child_process"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Vendor-neutrality enforcement for agentagencies/v1 (mirrors @agentproto/governance).
 *
 * The core package MUST NOT import from any orchestration runtime (Mastra,
 * LangChain, Temporal, etc.). Vendor adapters live in `@agentproto/agencies-mastra`,
 * `@agencies/langchain`, etc.
 */

const __filename = fileURLToPath(import.meta.url)
const SRC_DIR = path.dirname(__filename)

const FORBIDDEN_PATTERNS = [
  /\bfrom\s+['"](mastra|langchain|temporal|@temporalio\/[^'"]+|@mastra\/[^'"]+|@langchain\/[^'"]+)['"]/,
  /\bimport\(\s*['"](mastra|langchain|temporal|@temporalio\/[^'"]+|@mastra\/[^'"]+|@langchain\/[^'"]+)['"]\s*\)/,
  /\brequire\(\s*['"](mastra|langchain|temporal|@temporalio\/[^'"]+|@mastra\/[^'"]+|@langchain\/[^'"]+)['"]\s*\)/,
]

describe("vendor neutrality", () => {
  it("src/ contains no imports from Mastra, LangChain, or Temporal packages", () => {
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

  it("core does not import from Mastra adapter package", () => {
    let raw = ""
    try {
      // Look for actual imports of @agentproto/agencies-mastra (not comment mentions).
      raw = execSync(
        `grep -rEn --include='*.ts' --exclude='*.test.ts' --exclude-dir='dist' '(import|from|require)\\s*\\(?\\s*[\\"'\\''](@agentproto/agencies-mastra)' "${SRC_DIR}" || true`,
        { encoding: "utf8" }
      )
    } catch {
      raw = ""
    }
    const lines = raw.split("\n").filter(l => l.trim().length > 0)
    expect(lines).toEqual([])
  })
})
