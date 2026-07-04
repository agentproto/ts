#!/usr/bin/env node
/**
 * `worktree-agent run` — runs `worktreeAgentWorkflow` end-to-end: provision a
 * git worktree, run a coding agent in it as a real daemon session (`agent_start`
 * against the agentproto daemon's MCP endpoint), gate the result, ask a human
 * to approve cleanup, then clean up (or leave it in place on gate failure /
 * rejection).
 */
import { runWorkflow } from "@agentproto/workflow-runtime"
import { worktreeAgentWorkflow } from "../workflow.js"
import { connectDaemonAgentSessionHost } from "../agent-session-host.js"
import { parseArgs, CliUsageError } from "./args.js"
import { makeApprove } from "./approve.js"

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (err) {
    if (!(err instanceof CliUsageError)) throw err
    process.stderr.write(`${err.message}\n`)
    process.exit(1)
  }
  const { input, yes } = parsed

  const host = await connectDaemonAgentSessionHost()
  try {
    const { output } = await runWorkflow({
      workflow: worktreeAgentWorkflow,
      input,
      agents: host,
      approve: makeApprove({ yes }),
    })
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  } finally {
    await host.close()
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
})
