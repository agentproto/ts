#!/usr/bin/env node
/**
 * `agentproto` — the binary entry. Three verbs:
 *
 *   agentproto install <slug>            install an adapter's underlying CLI
 *   agentproto run <slug> [--cwd <dir>]  spawn the adapter and stream a turn
 *   agentproto serve --connect <url>     daemon — relay spawns over WS
 *
 * Adapter slugs resolve through the registry (see ./registry/resolve.ts).
 * Out of the box we ship `claude-code`, `hermes` etc. via npm-installed
 * `@agentproto/adapter-<slug>` packages.
 *
 * argv handling: we identify the verb manually (first non-flag token)
 * and hand the rest verbatim to the verb's parser. Going through one
 * top-level parseArgs would either need to know every flag of every
 * verb up front (lossy) or use `strict: false` (which then eats verb
 * flags as positionals — see commit history for the bug this caused).
 */

import { runAuth } from "./commands/auth.js"
import { runConfig } from "./commands/config.js"
import { runInstall } from "./commands/install.js"
import { runSetupCommand } from "./commands/setup.js"
import { runPlugins } from "./commands/plugins.js"
import { runRun } from "./commands/run.js"
import { runChat } from "./commands/chat.js"
import { runChatTui } from "./commands/chat-tui.js"
import { runModels } from "./commands/models.js"
import { runRunSwarm } from "./commands/run-swarm.js"
import { runServe } from "./commands/serve.js"
import { runWorkspace } from "./commands/workspace.js"
import { runSessions } from "./commands/sessions.js"
import { runConversation } from "./commands/conversation.js"
import { runUsage } from "./commands/usage.js"
import { runTunnel } from "./commands/tunnel.js"
import { runProviderPresets } from "./commands/presets.js"
import { runPreset } from "./commands/preset.js"
import { runBrowser } from "./commands/browser.js"
import { runMcpBridge } from "./commands/mcp-bridge.js"
import { runInstallMcp } from "./commands/install-mcp.js"
import { runOnboard } from "./commands/onboard.js"
import { runCron } from "./commands/cron.js"
import { runPack } from "./commands/pack.js"
import { runApp } from "./commands/app.js"
import { runWorktree } from "./commands/worktree.js"
import { runPolicy } from "./commands/policy.js"
import { runPermissions } from "./commands/permissions.js"
import { runAcp } from "./commands/acp.js"
import { runPair } from "./commands/pair.js"
import { runRendezvous } from "./commands/rendezvous.js"
import { runSandbox } from "./commands/sandbox.js"

const USAGE = `agentproto — AIP-45 agent CLI host

Usage:
  agentproto auth      <login|status|logout> [--host <url>] [--label <name>]
  agentproto config    <show|path|get|set|unset|edit> [args]
  agentproto daemon    <install|uninstall|start|stop|status|logs> [args]
  agentproto install   <slug> [--force] [--dry-run] [--skip-setup] [--allow-unverified]
                       <slug> ∈ { <adapter-slug> | runtime-profile/<name> }
                       --allow-unverified: run a curl/download installer that
                       declares no verify_sha256 (refused by default in
                       non-interactive contexts)
  agentproto plugins   <list|show|install|uninstall|enable|disable> [args]
  agentproto setup     <slug> [--force] [--dry-run] [--only <stepId>...]
  agentproto run       <slug> [--cwd <dir>] [--prompt <text>] [--resume <session-id>]
  agentproto chat      <adapter> [--model <id>] [--cwd <dir>] [--keep] [--no-color]
  agentproto chat-tui  <adapter> [--model <id>] [--cwd <dir>] [--keep]
  agentproto models    [adapter] [--json]                  runnable models + provider-key status
  agentproto run-swarm --manifest <path> [--once] [--interval <duration>] [--verbose]
  agentproto serve     [--profile <name>]
                       [--workspace <dir>] [--port <n>] [--bind <ip>]
                       [--connect <url> [--token <jwt>] [--label <name>]]
                       [--allow-origin <url> …] [--interactive | -i]
  agentproto workspace <add|list|remove|use> [args]
  agentproto sessions  [--watch] [--attach <id-or-name>] [--json]
  agentproto sessions  start <adapter> [--cwd <dir>] [--workspace <slug>]
                                       [--prompt <text>] [--label <text>] [--attach]
                                       [--hold-permissions]
  agentproto sessions  terminal -- <argv...> [--cwd <dir>] [--workspace <slug>]
                                             [--name <slug>] [--label <text>]
                                             [--cols <n>] [--rows <n>] [--attach]
  agentproto sessions  mirror <id-or-name>   read-only tail (Ctrl-C to exit)
  agentproto sessions  export <id-or-name> [--json] [-o <file>]
  agentproto sessions  story  <id-or-name> [--json] [--no-color]
                                           readable per-session timeline
  agentproto sessions  stop <id-or-name>
  agentproto conversation locate <sessionId | native-jsonl-path> [--json]
                                           session ↔ native transcript, either direction
  agentproto usage    rollup --window <5h|7d|P7D> [--profile <ref>] [--json]
                                           local spend estimate over a rolling window
  agentproto browser   install <adapter> [--force] [--dry-run]
  agentproto browser   start <adapter> [--port N] [--camofox-port N] [--label L]
  agentproto browser   list  [--alive] [--json]
  agentproto browser   stop  <session-id>
  agentproto browser   status <session-id>
  agentproto tunnel    create --port <n> [--provider quick] [--name <slug>]
                              [--label <text>] [--host <host>] [--json]
  agentproto tunnel    list   [--active] [--json]
  agentproto tunnel    stop   <id-or-name> [--json]
  agentproto tunnel    status <id-or-name> [--json]
  agentproto provider-preset list [--json]   provider gateway definitions + key-env status
  agentproto presets  list [--json]          deprecated alias for provider-preset
  agentproto preset   <list|show|add|delete> saved user spawn configurations
  agentproto mcp-bridge                    stdio MCP proxy to daemon /mcp endpoint
  agentproto install-mcp [--agent <name>...] [--all] [--yes] [--update] [--uninstall]
                                           register the daemon's MCP server with coding CLIs
  agentproto onboard     [--yes] [--no-skills] [--skills <slug>] [--agent <name>...]
                                           first-run: register MCP + install the skill pack
  agentproto cron      add --schedule <cron> (--command <cmd> | --adapter <slug> --prompt <text>) [--once]
  agentproto cron      list [--json]
  agentproto cron      remove <id>
  agentproto cron      run    <id>
  agentproto worktree  ls      [--repo <dir>] [--json]
  agentproto worktree  archive <path> [--base <ref>] [--keep-branch] [--json]
  agentproto policy    attach (--session <id>|--sessions <id,id,…>) [--then emit|commit]
                              [-- <gate-cmd> [args...]] [--wait] [--json]
  agentproto policy    status <policyId> [--json]
  agentproto policy    wait   <policyId> [--timeout <duration>] [--json]
  agentproto policy    ack    <policyId> (--approve|--reject) [--json]
  agentproto policy    ls     [--json]
  agentproto policy    cancel <policyId> [--json]
  agentproto permissions ls    [--json]                   held tool-permission requests
  agentproto permissions <approve|deny> <id> [--always]   resolve a held request
  agentproto acp       ls      [--json]
  agentproto acp       add <slug> --bin <bin> [--args <arg>…] [--env <K=V>…] [--resumable]
  agentproto acp       rm  <slug>
  agentproto pair      offer  [--ttl 10m] [--rendezvous <wss://…>] [--no-qr]
  agentproto pair      accept "<offer-url>" [--name <label>]
  agentproto pair      ls     [--json]
  agentproto pair      revoke <fingerprint|name>
  agentproto pair      exec   <fingerprint|name> -- <verb> [args…]
  agentproto rendezvous serve [--port <n>] [--host <ip>]
  agentproto sandbox   attach <provider> <sandboxId> [--config-json <json>] [--json]
  agentproto app       pack <appDir> [--out <path.agentapp>] [--json]
  agentproto app       unpack <file.agentapp> [--dir <outDir>] [--json]
  agentproto app       serve [appDir] [--port <n>] [--json]
                     serve an app's .agentproto/ui/ with an MCP bridge
  agentproto --help
  agentproto --version

Examples:
  agentproto auth login --host wss://guilde.work     # device flow → ~/.agentproto/credentials.json
  agentproto install claude-code
  agentproto install runtime-profile/standard  # drops .claude/ swarm scaffolding into the cwd
  agentproto setup openclaw                # re-run setup (idempotent via skip_if + ledger)
  agentproto run claude-code --cwd . --prompt "summarise this repo"
  agentproto run-swarm --manifest .runtime/local.yaml --verbose
  agentproto workspace add ~/code/my-project --slug my-project
  agentproto workspace list
  agentproto serve --connect wss://guilde.work/api/v1/agentproto/tunnel
  agentproto sessions start claude-code --workspace my-app --attach
  agentproto sessions terminal --name claude-tui --attach -- claude
  agentproto sessions stop claude-tui
  agentproto config set daemon.port 18791
  agentproto config set daemon.allowedOrigins https://guilde.work
  agentproto daemon install            # write launchd plist + start (macOS)
  agentproto daemon status             # plist? loaded? /health probe?
  agentproto onboard --yes                 # wire all detected agents in one pass
`

const VERBS = new Set([
  "auth",
  "config",
  "daemon",
  "install",
  "plugins",
  "setup",
  "run",
  "chat",
  "chat-tui",
  "models",
  "run-swarm",
  "serve",
  "workspace",
  "sessions",
  "conversation",
  "usage",
  "tunnel",
  "presets",
  "provider-preset",
  "preset",
  "browser",
  "mcp-bridge",
  "install-mcp",
  "onboard",
  "cron",
  "pack",
  "worktree",
  "policy",
  "permissions",
  "app",
  "acp",
  "pair",
  "rendezvous",
  "sandbox",
])

async function main(argv: readonly string[]): Promise<number> {
  // Find the verb — first token that matches a known verb. Anything
  // before it is a top-level flag (--help/--version); anything after
  // is forwarded to the verb's own parser.
  const verbIdx = argv.findIndex((a) => VERBS.has(a))

  if (verbIdx === -1) {
    if (argv.includes("--version") || argv.includes("-v")) {
      const build = __CLI_BUILD_SHA__
        ? ` (${__CLI_BUILD_SHA__}, built ${__CLI_BUILT_AT__})`
        : ""
      process.stdout.write(`agentproto ${__CLI_VERSION__}${build}\n`)
      return 0
    }
    if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
      process.stdout.write(USAGE)
      return 0
    }
    process.stderr.write(
      `agentproto: unrecognised argument(s): ${argv.join(" ")}\n\n${USAGE}`
    )
    return 2
  }

  const verb = argv[verbIdx]
  const rest = argv.slice(verbIdx + 1)

  switch (verb) {
    case "auth":
      return runAuth(rest)
    case "config":
      return runConfig(rest)
    case "daemon": {
      // Lazy-import the daemon command — its launchctl/systemd
      // shims pull in platform-specific code (plist templating,
      // shell-out helpers) we don't need until the verb fires.
      const { runDaemon } = await import("./commands/daemon.js")
      return runDaemon(rest)
    }
    case "install":
      return runInstall(rest)
    case "plugins":
      return runPlugins(rest)
    case "setup":
      return runSetupCommand(rest)
    case "run":
      return runRun(rest)
    case "chat":
      return runChat(rest)
    case "chat-tui":
      return runChatTui(rest)
    case "models":
      return runModels(rest)
    case "run-swarm":
      return runRunSwarm(rest)
    case "serve":
      return runServe(rest)
    case "workspace":
      return runWorkspace(rest)
    case "sessions":
      return runSessions(rest)
    case "conversation":
      return runConversation(rest)
    case "usage":
      return runUsage(rest)
    case "tunnel":
      return runTunnel(rest)
    case "presets":
      process.stderr.write("agentproto presets is deprecated; use `agentproto provider-preset list`.\n")
      return runProviderPresets(rest)
    case "provider-preset":
      return runProviderPresets(rest)
    case "preset":
      return runPreset(rest)
    case "browser":
      return runBrowser(rest)
    case "mcp-bridge":
      return runMcpBridge(rest)
    case "install-mcp":
      return runInstallMcp(rest)
    case "onboard":
      return runOnboard(rest)
    case "cron":
      return runCron(rest)
    case "pack":
      return runPack(rest)
    case "app":
      return runApp(rest)
    case "worktree":
      return runWorktree(rest)
    case "policy":
      return runPolicy(rest)
    case "permissions":
      return runPermissions(rest)
    case "acp":
      return runAcp(rest)
    case "pair":
      return runPair(rest)
    case "rendezvous":
      return runRendezvous(rest)
    case "sandbox":
      return runSandbox(rest)
    default:
      // Unreachable — VERBS membership checked above.
      process.stderr.write(`agentproto: unknown verb '${verb}'\n\n${USAGE}`)
      return 2
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err)
    process.stderr.write(`agentproto: ${msg}\n`)
    process.exitCode = 1
  }
)
