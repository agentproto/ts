/**
 * `agentproto onboard` — first-run umbrella that wires your coding agents
 * to the daemon in one pass: register the daemon MCP server, then install
 * the agentproto skill pack.
 *
 * Wraps the two existing standalone verbs:
 *   - `agentproto install-mcp`        (runInstallMcp)
 *   - `agentproto install skill/<name>` (runInstallSkill)
 *
 * Both remain independently usable and unchanged.
 */

import { parseArgs } from "node:util"
import { runInstallMcp } from "./install-mcp.js"
import { runInstallSkill } from "./install-skill.js"

// ── types ───────────────────────────────────────────────────────────────────

/** Injected runners — real ones in prod, fakes in tests. */
export interface OnboardDeps {
  installMcp: (args: readonly string[]) => Promise<number>
  installSkill: (slug: string, args: readonly string[]) => Promise<number>
}

export interface OnboardOptions {
  /** Non-interactive: forward `--yes` to install-mcp. */
  yes: boolean
  /** Run the skill-install step (false ⇒ skip it). */
  skills: boolean
  /** Skill slug for the skill step (default "skill/agentproto-pack"). */
  skillSlug: string
  /** Explicit MCP agent list; empty ⇒ install-mcp `--all`. */
  agents: readonly string[]
}

export interface OnboardReport {
  /** Exit code from the MCP step. */
  mcpCode: number
  /** Exit code from the skill step, or null when skipped. */
  skillCode: number | null
}

// ── constants ───────────────────────────────────────────────────────────────

const DEFAULT_SKILL_SLUG = "skill/agentproto-pack"

const REAL_DEPS: OnboardDeps = { installMcp: runInstallMcp, installSkill: runInstallSkill }

const USAGE = `agentproto onboard — first-run: wire your coding agents to the daemon

Usage:
  agentproto onboard [--yes] [--no-skills] [--skills <slug>] [--agent <name>...]

Steps (both are also runnable standalone at any time):
  ① register the daemon MCP server with detected agents   (see: agentproto install-mcp)
  ② install the agentproto skill pack into skill-capable agents (see: agentproto install skill/<name>)

Options:
  --yes              non-interactive (forward to install-mcp)
  --no-skills        skip the skill-install step
  --skills <slug>    install this skill instead of the full pack (e.g. nested-orchestration)
  --agent <name>...  limit MCP registration to these agents (default: all detected)
`

// ── primitive ───────────────────────────────────────────────────────────────

export async function onboardFlow(opts: OnboardOptions, deps: OnboardDeps): Promise<OnboardReport> {
  process.stdout.write("agentproto onboarding — wiring your coding agents to the daemon\n\n")

  // ① MCP
  process.stdout.write("① Registering the daemon MCP server\n")
  const mcpArgs: string[] = [
    ...(opts.agents.length > 0 ? opts.agents.flatMap((a) => ["--agent", a]) : ["--all"]),
    ...(opts.yes ? ["--yes"] : []),
  ]
  const mcpCode = await deps.installMcp(mcpArgs)

  // ② Skills
  let skillCode: number | null = null
  if (opts.skills) {
    process.stdout.write("\n② Installing the agentproto skill pack\n")
    skillCode = await deps.installSkill(opts.skillSlug, [])
  } else {
    process.stdout.write("\n② Skills — skipped (--no-skills)\n")
  }

  // Summary
  const ok = (c: number | null): string => (c === null ? "skipped" : c === 0 ? "ok" : `failed (exit ${c})`)
  process.stdout.write(
    `\nonboarding summary\n` +
      `  MCP registration : ${ok(mcpCode)}\n` +
      `  skill pack       : ${ok(skillCode)}\n`,
  )
  if (mcpCode === 0 && (skillCode === null || skillCode === 0)) {
    process.stdout.write("\nNext: `agentproto daemon install` then `agentproto serve`.\n")
  }

  return { mcpCode, skillCode }
}

// ── verb ────────────────────────────────────────────────────────────────────

export async function runOnboard(
  args: readonly string[],
  deps: OnboardDeps = REAL_DEPS,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      yes: { type: "boolean" },
      "no-skills": { type: "boolean" },
      skills: { type: "string" }, // override the skill slug
      agent: { type: "string", multiple: true },
    },
  })

  const rawSlug = values.skills
  const skillSlug =
    rawSlug === undefined
      ? DEFAULT_SKILL_SLUG
      : rawSlug.startsWith("skill/")
        ? rawSlug
        : `skill/${rawSlug}`

  const opts: OnboardOptions = {
    yes: values.yes === true,
    skills: values["no-skills"] !== true,
    skillSlug,
    agents: values.agent ?? [],
  }

  const report = await onboardFlow(opts, deps)
  return report.mcpCode !== 0 ? report.mcpCode : (report.skillCode ?? 0)
}
