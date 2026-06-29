#!/usr/bin/env node
/**
 * Standalone CLI for the first-party Mastra agent.
 *
 *   agentproto-mastra acp [--model <id>] [--agent <AGENT.md>]
 *
 * `acp` boots the ACP server over stdio — this is both what the agentproto
 * daemon spawns (as the `mastra-agent` arm) and what a user runs directly to
 * drive the agent from any ACP-speaking host, with no other agent CLI in the
 * loop. Our loop, our models.
 */

import { makeAgentFactory } from "./default-agent.js"
import { runAcpOverStdio } from "./run.js"

interface ParsedArgs {
  cmd?: string
  model?: string
  agentFile?: string
}

function parseArgs(argv: string[]): ParsedArgs {
  const rest = argv.slice(2)
  const out: ParsedArgs = { cmd: rest[0] }
  for (let i = 1; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === "--model") out.model = rest[++i]
    else if (arg === "--agent") out.agentFile = rest[++i]
  }
  return out
}

const USAGE =
  "usage: agentproto-mastra acp [--model <provider/model>] [--agent <AGENT.md>]\n"

function main(): void {
  const { cmd, model, agentFile } = parseArgs(process.argv)
  if (cmd !== "acp") {
    process.stderr.write(USAGE)
    process.exit(cmd ? 1 : 0)
  }
  // The connection keeps the process alive (it holds stdin open); no explicit
  // wait loop needed.
  runAcpOverStdio(
    makeAgentFactory({
      model: model ?? process.env.AGENTPROTO_MASTRA_MODEL,
      agentFile: agentFile ?? process.env.AGENTPROTO_MASTRA_AGENT_FILE,
      // Tools are confined to the dir the daemon spawned us in.
      cwd: process.cwd(),
      // run_command is on unless explicitly disabled.
      allowExec: !process.env.AGENTPROTO_MASTRA_NO_EXEC,
    }),
  )
}

main()
