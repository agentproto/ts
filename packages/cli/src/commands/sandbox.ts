/**
 * `agentproto sandbox attach <provider> <sandboxId> [--config-json <json>] [--json]`
 *
 * Phase 1 `sandbox attach` — connect to an ALREADY-EXISTING sandbox
 * (Box/e2b) without tearing it down. Pure local shell over
 * `@agentproto/runtime`'s `attachSandbox`, same "no daemon required" shape
 * as `agentproto worktree`: this resolves the sandbox provider directly
 * (reading credentials from `~/.agentproto/sandbox-creds/<slug>.json`,
 * same store `setup_sandbox_provider` writes to) rather than talking to an
 * already-running local daemon — attach is about reaching a REMOTE
 * sandbox's daemon, not this machine's.
 *
 * Prints the connection descriptor and a paste-ready `.mcp.json` snippet.
 * Never stops or pauses the sandbox.
 */
import { parseArgs } from "node:util"
import { attachSandbox, buildMcpConfigSnippet } from "@agentproto/runtime"

const USAGE = `agentproto sandbox — connect to sandbox providers

Usage:
  agentproto sandbox attach <provider> <sandboxId> [--config-json <json>] [--keep-alive] [--json]

Connects to an ALREADY-EXISTING sandbox (e.g. a Box or e2b sandbox booted by
a prior \`agent_start\` sandbox spawn) without tearing it down: resumes it,
ensures its agentproto daemon is healthy and reachably exposed with a
PERSISTENT, token-gated URL, and prints a connection descriptor plus a
paste-ready .mcp.json snippet any MCP client can use to reach it directly.

  <provider>    Sandbox provider slug, e.g. "box" or "e2b".
  <sandboxId>   Provider-assigned sandbox id to attach to.

  --config-json <json>  Provider-specific SandboxSpec config overrides as a
                         JSON object, e.g. '{"port":18790}'.
  --keep-alive           Keep the sandbox awake indefinitely for an
                          always-on rendezvous — pins Box's ttlSeconds to
                          null (no-auto-stop) on this box, defensively, even
                          if it already defaults to that. No-op for
                          providers without an equivalent.
  --json                Print only the descriptor + mcpConfig, as JSON.

Credentials: provider API keys (e.g. BOX_API_KEY, E2B_API_KEY) must be set
in this process's environment — same as \`agent_start.sandbox\` uses.

Examples:
  agentproto sandbox attach box bx_abc123
  agentproto sandbox attach box bx_abc123 --keep-alive
  agentproto sandbox attach e2b sbx_abc123 --json
`

export async function runSandbox(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }

  const sub = args[0]
  if (sub === "attach") return runAttach(args.slice(1))

  if (!sub) {
    process.stdout.write(USAGE)
    return 0
  }
  process.stderr.write(
    `agentproto sandbox: unknown subcommand "${sub}"\n` + `  Known: attach\n`,
  )
  return 2
}

async function runAttach(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      "config-json": { type: "string" },
      "keep-alive": { type: "boolean" },
      json: { type: "boolean" },
    },
  })

  const provider = positionals[0]
  const sandboxId = positionals[1]
  if (!provider || !sandboxId) {
    process.stderr.write(
      "agentproto sandbox attach: missing <provider> and/or <sandboxId>.\n" +
        "  Try: agentproto sandbox attach box bx_abc123\n",
    )
    return 2
  }

  let config: Record<string, unknown> | undefined
  if (values["config-json"]) {
    try {
      config = JSON.parse(values["config-json"]) as Record<string, unknown>
    } catch (err) {
      process.stderr.write(
        `agentproto sandbox attach: --config-json is not valid JSON — ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      )
      return 2
    }
  }

  const result = await attachSandbox({
    provider,
    sandboxId,
    ...(config ? { config } : {}),
    ...(values["keep-alive"] ? { keepAlive: true } : {}),
  })

  if (!result.ok) {
    process.stderr.write(`agentproto sandbox attach: ${result.message}\n`)
    return 1
  }

  const mcpConfig = buildMcpConfigSnippet(result.descriptor)

  if (values.json) {
    process.stdout.write(JSON.stringify({ descriptor: result.descriptor, mcpConfig }, null, 2) + "\n")
    return 0
  }

  process.stdout.write(
    `sandbox attached  provider=${result.descriptor.provider}  sandboxId=${result.descriptor.sandboxId}\n` +
      `  mcpUrl      ${result.descriptor.mcpUrl}\n` +
      `  token       ${result.descriptor.token ? "•".repeat(8) + " (gated)" : "—"}\n` +
      `  allowOrigin ${result.descriptor.allowOrigin}\n` +
      `  keepAlive   ${result.descriptor.keepAlive ? "yes (pinned no-auto-stop)" : "no"}\n\n` +
      `Paste into .mcp.json:\n${JSON.stringify(mcpConfig, null, 2)}\n`,
  )
  return 0
}
