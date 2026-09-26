/**
 * `agentproto onboard` — alias of the `agentproto setup` wizard (no slug).
 *
 * Its original flags keep working, mapped onto the wizard:
 *   --yes              → --yes
 *   --no-skills        → --skip skills
 *   --skills <slug>    → the skills action installs that skill instead of the pack
 *   --agent <name>...  → MCP registration limited to these clients
 */

import { parseArgs } from "node:util"
import { runSetupWizardCommand } from "./setup.js"

const USAGE = `agentproto onboard — alias of \`agentproto setup\` (the onboarding wizard)

Usage:
  agentproto onboard [--yes] [--no-skills] [--skills <slug>] [--agent <name>...]

  --yes              apply the wizard's defaults without prompting
  --no-skills        skip the skills step
  --skills <slug>    install this skill instead of the full pack (e.g. ap-spawn-agent)
  --agent <name>...  register the MCP server with these clients only

See \`agentproto setup --help\` for the full wizard.
`

/** Translate `onboard` flags into `setup` wizard args. */
export function mapOnboardArgs(args: readonly string[]): string[] {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      yes: { type: "boolean" },
      "no-skills": { type: "boolean" },
      skills: { type: "string" },
      agent: { type: "string", multiple: true },
    },
  })
  return [
    ...(values.yes ? ["--yes"] : []),
    ...(values["no-skills"] ? ["--skip", "skills"] : []),
    ...(values.skills ? ["--skills", values.skills] : []),
    ...(values.agent ?? []).flatMap((a) => ["--agent", a]),
  ]
}

export async function runOnboard(
  args: readonly string[],
  run: (args: readonly string[]) => Promise<number> = runSetupWizardCommand,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  let mapped: string[]
  try {
    mapped = mapOnboardArgs(args)
  } catch (err) {
    process.stderr.write(`agentproto onboard: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`)
    return 2
  }
  return run(mapped)
}
