import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const workflows = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows")

/** Split a workflow into its `- name:` / `- uses:` step blocks (6-space list items). */
const stepsOf = (text) => text.split(/\n(?=      - )/)

const read = (file) => readFileSync(join(workflows, file), "utf8")

test("every step that builds the workspace CLI sets the turbo remote cache env", () => {
  const offenders = []
  for (const file of readdirSync(workflows).filter((f) => f.endsWith(".yml"))) {
    for (const step of stepsOf(read(file))) {
      if (!/pnpm build\b[^\n]*--filter @agentproto\/cli\.\.\./.test(step)) continue
      for (const key of ["TURBO_API:", "TURBO_TEAM:", "TURBO_TOKEN:"]) {
        if (!step.includes(key)) offenders.push(`${file}: ${step.split("\n")[0].trim()} lacks ${key}`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})

test("the manual review passes the paid-rung key and allowlist to the agentproto-run step", () => {
  const run = stepsOf(read("agentic-review-manual.yml")).find((s) => s.includes("uses: ./.github/actions/agentproto-run"))
  assert.ok(run, "agentproto-run step not found")
  const env = run.slice(0, run.indexOf("        with:"))
  assert.match(env, /OPENCODE_GO_API_KEY: \$\{\{ secrets\.OPENCODE_GO_API_KEY \}\}/)
  assert.match(env, /AGENT_ALLOWED_METERED_MODELS: \$\{\{ vars\.AGENT_ALLOWED_METERED_MODELS \}\}/)
})
