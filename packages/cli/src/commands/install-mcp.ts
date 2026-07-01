/**
 * `agentproto install-mcp` — auto-register the daemon's MCP server with
 * installed coding-CLI agents (Claude Code, Cursor, Codex CLI, Claude
 * Desktop, Aider).
 *
 * Detects which agents are installed, ensures the daemon is running (or
 * starts it), then writes the appropriate MCP server entry into each
 * agent's config file.  Tracks what it registered in
 * `~/.agentproto/install-state.json` so `--update` and `--uninstall`
 * work precisely without clobbering user-added MCP servers.
 *
 * Usage:
 *   agentproto install-mcp [--agent <name>...] [--all] [--yes] [--update] [--uninstall]
 *
 * Agent names: claude, cursor, codex, claude-desktop, aider
 */

import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import { homedir, platform } from "node:os"
import { join, dirname } from "node:path"
import { parseArgs } from "node:util"
import { loadConfig } from "@agentproto/runtime/config"
import { discoverDaemon, httpGetJson } from "./_daemon-helpers.js"

// ── types ───────────────────────────────────────────────────────────────────

type AgentName = "claude" | "cursor" | "codex" | "claude-desktop" | "aider"
type Transport = "http" | "stdio"

interface InstallStateEntry {
  agent: string
  configPath: string
  transport: Transport
  registeredAt: string
}

interface InstallState {
  entries: InstallStateEntry[]
}

interface AgentDetection {
  name: AgentName
  /** Human-readable label. */
  label: string
  /** Config file path we write to. */
  configPath: string
  /** True if the agent's binary is on PATH (not just its config dir). */
  hasBinary: boolean
  /** True if the config file/dir exists. */
  hasConfig: boolean
}

// ── constants ───────────────────────────────────────────────────────────────

const DEFAULT_PORT = 18790
const SERVER_NAME = "agentproto"
const STATE_FILE = join(homedir(), ".agentproto", "install-state.json")

const USAGE = `agentproto install-mcp — register the daemon's MCP server with coding CLIs

Usage:
  agentproto install-mcp [--agent <name>...] [--all] [--yes]
                          [--update] [--uninstall]

Options:
  --agent <name>   Target a specific agent (repeatable). Known: claude, cursor, codex, claude-desktop, aider
  --all            Target all detected agents (default when no --agent given)
  --yes            Skip prompts (non-interactive; auto-confirm)
  --skip-daemon    Skip daemon discovery/start (use default port from config)
  --update         Re-run registration for previously-registered agents (e.g. after a port change)
  --uninstall      Remove only the agentproto entries we added (uses install-state.json)

Detected agents are registered with the right MCP transport:
  claude          → HTTP via \`claude mcp add --transport http --scope user\` (or .mcp.json fallback)
  cursor          → stdio entry in ~/.cursor/mcp.json
  codex           → stdio entry in ~/.codex/config.toml
  claude-desktop  → stdio entry in ~/Library/Application Support/Claude/claude_desktop_config.json
  aider           → stdio entry in ~/.aider.conf.yml
`

const ALL_AGENTS: AgentName[] = [
  "claude",
  "cursor",
  "codex",
  "claude-desktop",
  "aider",
]

// ── entry point ──────────────────────────────────────────────────────────────

export async function runInstallMcp(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }

  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      agent: { type: "string", multiple: true },
      all: { type: "boolean" },
      yes: { type: "boolean" },
      update: { type: "boolean" },
      uninstall: { type: "boolean" },
      "skip-daemon": { type: "boolean" },
    },
  })

  // --uninstall path
  if (values.uninstall) {
    return runUninstall()
  }

  // --update path
  if (values.update) {
    return runUpdate(values.yes === true)
  }

  // normal install path
  // 1. Detect installed agents
  const detections = await detectAgents()
  const detected = detections.filter(d => d.hasBinary || d.hasConfig)

  if (detected.length === 0) {
    if (values.yes) {
      process.stdout.write(
        "No coding-CLI agents detected. Nothing to do.\n",
      )
      return 0
    }
    process.stdout.write(
      "No coding-CLI agents detected on this machine.\n" +
        "Install one of: claude-code, cursor, codex, claude-desktop, aider — then re-run.\n",
    )
    return 0
  }

  process.stdout.write(
    `Detected ${detected.length} agent(s):\n` +
      detected.map(d => `  • ${d.label} (${d.configPath})`).join("\n") + "\n",
  )

  // 2. Determine which agents to target
  let targets: AgentDetection[]
  if (values.agent && values.agent.length > 0) {
    const requested = new Set(values.agent)
    const unknown = [...requested].filter(a => !ALL_AGENTS.includes(a as AgentName))
    if (unknown.length > 0) {
      process.stderr.write(
        `Unknown agent(s): ${unknown.join(", ")}\n` +
          `Known agents: ${ALL_AGENTS.join(", ")}\n`,
      )
      return 2
    }
    targets = detected.filter(d => requested.has(d.name))
    if (targets.length === 0) {
      process.stderr.write(
        "None of the requested agents are detected on this machine.\n",
      )
      return 1
    }
  } else {
    // --all or default → all detected
    targets = detected
  }

  // 3. Ensure the daemon is running (unless --skip-daemon)
  const skipDaemon = values["skip-daemon"] === true
  let port = DEFAULT_PORT

  if (!skipDaemon) {
    const daemonPort = await ensureDaemon(values.yes === true)
    if (daemonPort === null) {
      process.stderr.write(
        "Could not find or start the daemon. Run `agentproto serve` manually, then re-run `agentproto install-mcp`.\n",
      )
      return 1
    }
    port = daemonPort
  } else {
    // Try to read port from config
    const cfg = await loadConfig()
    port = cfg.daemon?.port ?? DEFAULT_PORT
  }

  // 4. Register each target
  const state = await loadInstallState()
  const results: string[] = []

  for (const target of targets) {
    try {
      const entry = await registerAgent(target, port, values.yes === true)
      if (entry) {
        // Replace any existing entry for this agent
        const existingIdx = state.entries.findIndex(
          e => e.agent === target.name,
        )
        if (existingIdx >= 0) {
          state.entries[existingIdx] = entry
        } else {
          state.entries.push(entry)
        }
        results.push(
          `  ✓ ${target.label} — ${entry.transport} → ${entry.configPath}`,
        )
      }
    } catch (err) {
      results.push(
        `  ✗ ${target.label} — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  await saveInstallState(state)

  // 5. Summary
  process.stdout.write("\nRegistration summary:\n")
  for (const r of results) process.stdout.write(r + "\n")

  const registered = results.filter(r => r.includes("✓"))
  if (registered.length > 0) {
    process.stdout.write(
      "\nRestart your CLI agent(s) to pick up the new MCP server.\n",
    )
  }

  return 0
}

// ── --uninstall ──────────────────────────────────────────────────────────────

async function runUninstall(): Promise<number> {
  const state = await loadInstallState()
  if (state.entries.length === 0) {
    process.stdout.write("No agentproto MCP registrations to remove.\n")
    return 0
  }

  process.stdout.write(
    `Removing ${state.entries.length} registration(s):\n`,
  )

  for (const entry of state.entries) {
    try {
      await unregisterAgent(entry)
      process.stdout.write(`  ✓ ${entry.agent} — removed from ${entry.configPath}\n`)
    } catch (err) {
      process.stdout.write(
        `  ✗ ${entry.agent} — ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }

  // Clear the state
  await saveInstallState({ entries: [] })
  process.stdout.write(
    "\nRestart your CLI agent(s) to drop the MCP server.\n",
  )
  return 0
}

// ── --update ─────────────────────────────────────────────────────────────────

async function runUpdate(yes: boolean): Promise<number> {
  const state = await loadInstallState()
  if (state.entries.length === 0) {
    process.stdout.write(
      "No previous registrations found. Run `agentproto install-mcp` first.\n",
    )
    return 0
  }

  // Ensure daemon is running to get the current port
  const daemonPort = await ensureDaemon(yes)
  if (daemonPort === null) {
    process.stderr.write(
      "Could not find or start the daemon. Run `agentproto serve` manually, then re-run `agentproto install-mcp --update`.\n",
    )
    return 1
  }

  process.stdout.write(
    `Updating ${state.entries.length} registration(s) to port ${daemonPort}:\n`,
  )

  for (const entry of state.entries) {
    const detection = await detectAgent(entry.agent as AgentName)
    if (!detection) {
      process.stdout.write(
        `  ⊘ ${entry.agent} — no longer detected, skipping\n`,
      )
      continue
    }
    try {
      const updated = await registerAgent(detection, daemonPort, yes)
      if (updated) {
        const idx = state.entries.findIndex(e => e.agent === entry.agent)
        if (idx >= 0) state.entries[idx] = updated
        process.stdout.write(
          `  ✓ ${entry.agent} — updated → ${updated.configPath}\n`,
        )
      }
    } catch (err) {
      process.stdout.write(
        `  ✗ ${entry.agent} — ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }

  await saveInstallState(state)
  process.stdout.write(
    "\nRestart your CLI agent(s) to pick up the updated MCP server.\n",
  )
  return 0
}

// ── agent detection ─────────────────────────────────────────────────────────

async function detectAgents(): Promise<AgentDetection[]> {
  const results: AgentDetection[] = []
  for (const name of ALL_AGENTS) {
    const detection = await detectAgent(name)
    if (detection) results.push(detection)
  }
  return results
}

async function detectAgent(name: AgentName): Promise<AgentDetection | null> {
  const home = homedir()
  switch (name) {
    case "claude": {
      const configPath = join(home, ".claude.json")
      const hasBinary = await isBinaryOnPath("claude")
      const hasConfig = await fileExists(configPath) || await fileExists(join(process.cwd(), ".mcp.json"))
      if (!hasBinary && !hasConfig) return null
      return { name, label: "Claude Code", configPath, hasBinary, hasConfig }
    }
    case "cursor": {
      const configPath = join(home, ".cursor", "mcp.json")
      const hasConfig = await fileExists(configPath) || await dirExists(join(home, ".cursor"))
      if (!hasConfig && !await dirExists(join(process.cwd(), ".cursor"))) return null
      return { name, label: "Cursor", configPath, hasBinary: false, hasConfig }
    }
    case "codex": {
      const configPath = join(home, ".codex", "config.toml")
      const hasBinary = await isBinaryOnPath("codex")
      const hasConfig = await fileExists(configPath)
      if (!hasBinary && !hasConfig) return null
      return { name, label: "Codex CLI", configPath, hasBinary, hasConfig }
    }
    case "claude-desktop": {
      if (platform() !== "darwin") return null
      const configPath = join(
        home,
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json",
      )
      const hasConfig = await fileExists(configPath)
      if (!hasConfig && !await dirExists(dirname(configPath))) return null
      return { name, label: "Claude Desktop", configPath, hasBinary: false, hasConfig }
    }
    case "aider": {
      const configPath = join(home, ".aider.conf.yml")
      const hasBinary = await isBinaryOnPath("aider")
      const hasConfig = await fileExists(configPath) || await fileExists(join(process.cwd(), ".aider.conf.yml"))
      if (!hasBinary && !hasConfig) return null
      return { name, label: "Aider", configPath, hasBinary, hasConfig }
    }
  }
}

// ── registration ────────────────────────────────────────────────────────────

async function registerAgent(
  detection: AgentDetection,
  port: number,
  _yes: boolean,
): Promise<InstallStateEntry | null> {
  const mcpUrl = `http://127.0.0.1:${port}/mcp`
  const stdioEnv: Record<string, string> =
    port === DEFAULT_PORT ? {} : { AGENTPROTO_MCP_URL: mcpUrl }

  switch (detection.name) {
    case "claude":
      return registerClaude(detection, port, mcpUrl)
    case "cursor":
      return registerStdioJson(detection, "cursor", stdioEnv)
    case "codex":
      return registerCodex(detection, stdioEnv)
    case "claude-desktop":
      return registerStdioJson(detection, "claude-desktop", stdioEnv)
    case "aider":
      return registerAider(detection, stdioEnv)
  }
}

/** Claude Code: prefer `claude mcp add --transport http --scope user`, fall back to .mcp.json */
async function registerClaude(
  detection: AgentDetection,
  port: number,
  mcpUrl: string,
): Promise<InstallStateEntry> {
  if (detection.hasBinary) {
    // Shell out to `claude mcp add` — self-healing against config format drift.
    const result = await runCommand("claude", [
      "mcp", "add",
      "--transport", "http",
      "--scope", "user",
      SERVER_NAME,
      mcpUrl,
    ])
    if (result.code === 0) {
      return {
        agent: "claude",
        configPath: detection.configPath,
        transport: "http",
        registeredAt: new Date().toISOString(),
      }
    }
    // Fall through to .mcp.json fallback on non-zero exit
    process.stderr.write(
      `  \`claude mcp add\` exited ${result.code}: ${result.stderr}\n` +
        `  Falling back to writing .mcp.json\n`,
    )
  }

  // Fallback: write/merge .mcp.json
  const mcpJsonPath = join(process.cwd(), ".mcp.json")
  let config: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(mcpJsonPath, "utf8")
    config = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // File doesn't exist — start fresh
  }
  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {}
  }
  const servers = config.mcpServers as Record<string, unknown>
  servers[SERVER_NAME] = { type: "http", url: mcpUrl }
  await fs.writeFile(mcpJsonPath, JSON.stringify(config, null, 2) + "\n", "utf8")

  return {
    agent: "claude",
    configPath: mcpJsonPath,
    transport: "http",
    registeredAt: new Date().toISOString(),
  }
}

/** Cursor / Claude Desktop: write/merge stdio entry into JSON config */
async function registerStdioJson(
  detection: AgentDetection,
  agentName: string,
  env: Record<string, string>,
): Promise<InstallStateEntry> {
  const configPath = detection.configPath
  let config: Record<string, unknown> = {}

  try {
    const raw = await fs.readFile(configPath, "utf8")
    config = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // File doesn't exist — start fresh
  }

  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {}
  }
  const servers = config.mcpServers as Record<string, Record<string, unknown>>
  servers[SERVER_NAME] = {
    command: "agentproto",
    args: ["mcp-bridge"],
    env,
  }

  await fs.mkdir(dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8")

  return {
    agent: agentName,
    configPath,
    transport: "stdio",
    registeredAt: new Date().toISOString(),
  }
}

/** Codex: write/merge [mcp_servers.agentproto] into config.toml */
async function registerCodex(
  detection: AgentDetection,
  env: Record<string, string>,
): Promise<InstallStateEntry> {
  const configPath = detection.configPath
  let content = ""
  try {
    content = await fs.readFile(configPath, "utf8")
  } catch {
    // File doesn't exist — start fresh
  }

  // Remove any existing [mcp_servers.agentproto] block
  content = removeTomlTable(content, "mcp_servers.agentproto")

  // Append the new block
  const envLine = Object.keys(env).length > 0
    ? `env = ${JSON.stringify(env).replace(/,/g, ", ").replace(/:/g, " = ")}\n`
    : ""
  const block = `\n[mcp_servers.agentproto]\ncommand = "agentproto"\nargs = ["mcp-bridge"]\n${envLine}`

  content = content.trimEnd() + "\n" + block

  await fs.mkdir(dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, content, "utf8")

  return {
    agent: "codex",
    configPath,
    transport: "stdio",
    registeredAt: new Date().toISOString(),
  }
}

/** Aider: write/merge mcp_servers into .aider.conf.yml */
async function registerAider(
  detection: AgentDetection,
  env: Record<string, string>,
): Promise<InstallStateEntry> {
  const configPath = detection.configPath
  let content = ""
  try {
    content = await fs.readFile(configPath, "utf8")
  } catch {
    // File doesn't exist — start fresh
  }

  // Remove any existing mcp_servers block (simple approach for YAML-ish config)
  content = removeYamlKey(content, "mcp_servers")

  // Append the new block
  const envStr = Object.keys(env).length > 0
    ? `    env:\n${Object.entries(env).map(([k, v]) => `      ${k}: ${v}`).join("\n")}\n`
    : ""
  const block = `\nmcp_servers:\n  ${SERVER_NAME}:\n    command: agentproto\n    args:\n      - mcp-bridge\n${envStr}`

  content = content.trimEnd() + "\n" + block

  await fs.mkdir(dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, content, "utf8")

  return {
    agent: "aider",
    configPath,
    transport: "stdio",
    registeredAt: new Date().toISOString(),
  }
}

// ── unregister ───────────────────────────────────────────────────────────────

async function unregisterAgent(entry: InstallStateEntry): Promise<void> {
  switch (entry.agent) {
    case "claude": {
      // Try `claude mcp remove` first, then fall back to file editing
      const result = await runCommand("claude", [
        "mcp", "remove", SERVER_NAME, "--scope", "user",
      ])
      if (result.code !== 0) {
        // Fall back to removing from .mcp.json
        if (entry.configPath.endsWith(".mcp.json")) {
          await removeFromJsonConfig(entry.configPath)
        }
      }
      break
    }
    case "cursor":
    case "claude-desktop":
      await removeFromJsonConfig(entry.configPath)
      break
    case "codex": {
      let content = ""
      try {
        content = await fs.readFile(entry.configPath, "utf8")
      } catch {
        return // file gone, nothing to remove
      }
      content = removeTomlTable(content, "mcp_servers.agentproto")
      await fs.writeFile(entry.configPath, content.trimEnd() + "\n", "utf8")
      break
    }
    case "aider": {
      let content = ""
      try {
        content = await fs.readFile(entry.configPath, "utf8")
      } catch {
        return
      }
      content = removeYamlKey(content, "mcp_servers")
      await fs.writeFile(entry.configPath, content.trimEnd() + "\n", "utf8")
      break
    }
  }
}

async function removeFromJsonConfig(configPath: string): Promise<void> {
  let config: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(configPath, "utf8")
    config = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return // file gone
  }
  if (config.mcpServers && typeof config.mcpServers === "object") {
    const servers = config.mcpServers as Record<string, unknown>
    delete servers[SERVER_NAME]
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8")
  }
}

// ── daemon management ────────────────────────────────────────────────────────

async function ensureDaemon(yes: boolean): Promise<number | null> {
  // Probe discovery first — maybe it's already running
  const report = await discoverDaemon()
  if (report.found) {
    // Verify it's actually reachable via /health
    try {
      await httpGetJson(`${report.found.url}/health`)
      const port = extractPort(report.found.url)
      process.stdout.write(`Daemon is running at ${report.found.url}\n`)
      return port
    } catch {
      // Fall through to start
    }
  }

  // Try to start the daemon via `agentproto daemon start` (launchd) or
  // `agentproto serve` (foreground fallback). We reuse the daemon command
  // for managed start, and serve for unmanaged.
  process.stdout.write("Starting daemon…\n")

  // First try `agentproto daemon start` (launchd kickstart)
  const startResult = await runCommand("agentproto", ["daemon", "start"])
  if (startResult.code === 0) {
    // Wait for it to come up — poll health for a few seconds
    const cfg = await loadConfig()
    const port = cfg.daemon?.port ?? DEFAULT_PORT
    if (await waitForHealth(port, 5000)) {
      process.stdout.write(`Daemon started at http://127.0.0.1:${port}\n`)
      return port
    }
  }

  // Fallback: `agentproto serve` in background (only if --yes to avoid surprise)
  if (yes) {
    const cfg = await loadConfig()
    const port = cfg.daemon?.port ?? DEFAULT_PORT
    const serveArgs = ["serve"]
    if (cfg.daemon?.workspace) serveArgs.push("--workspace", cfg.daemon.workspace)
    if (typeof cfg.daemon?.port === "number") serveArgs.push("--port", String(cfg.daemon.port))

    // Spawn in background
    const child = spawn("agentproto", serveArgs, {
      stdio: "ignore",
      detached: true,
    })
    child.unref()

    if (await waitForHealth(port, 10_000)) {
      process.stdout.write(`Daemon started at http://127.0.0.1:${port}\n`)
      return port
    }
  }

  return null
}

async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await httpGetJson(`http://127.0.0.1:${port}/health`)
      return true
    } catch {
      await sleep(500)
    }
  }
  return false
}

// ── install-state ────────────────────────────────────────────────────────────

async function loadInstallState(): Promise<InstallState> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8")
    const parsed = JSON.parse(raw) as InstallState
    if (Array.isArray(parsed.entries)) return parsed
  } catch {
    // File doesn't exist or is malformed
  }
  return { entries: [] }
}

async function saveInstallState(state: InstallState): Promise<void> {
  await fs.mkdir(dirname(STATE_FILE), { recursive: true })
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8")
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path)
    return stat.isDirectory()
  } catch {
    return false
  }
}

async function isBinaryOnPath(name: string): Promise<boolean> {
  const result = await runCommand(
    process.platform === "win32" ? "where" : "which",
    [name],
  )
  return result.code === 0 && result.stdout.trim().length > 0
}

interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

function runCommand(cmd: string, args: string[]): Promise<CommandResult> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.setEncoding("utf8").on("data", c => (stdout += c))
    child.stderr?.setEncoding("utf8").on("data", c => (stderr += c))
    child.on("error", err =>
      resolve({ code: 127, stdout, stderr: err.message }),
    )
    child.on("exit", code => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

function extractPort(url: string): number {
  const match = url.match(/:(\d+)$/)
  return match ? parseInt(match[1]!, 10) : DEFAULT_PORT
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Remove a `[section.name]` table block from TOML content. */
function removeTomlTable(content: string, fullName: string): string {
  // Match [mcp_servers.agentproto] and everything until the next table header or EOF
  const header = `[${fullName}]`
  const lines = content.split("\n")
  const result: string[] = []
  let skipping = false
  for (const line of lines) {
    if (line.trim() === header) {
      skipping = true
      continue
    }
    if (skipping) {
      // Stop skipping when we hit another table header or EOF
      if (/^\s*\[/.test(line) && line.trim() !== header) {
        skipping = false
        result.push(line)
      }
      // else: skip the line (part of the block)
    } else {
      result.push(line)
    }
  }
  return result.join("\n")
}

/** Remove a top-level YAML key and its nested block. */
function removeYamlKey(content: string, key: string): string {
  const lines = content.split("\n")
  const result: string[] = []
  let skipping = false
  let skipIndent = -1
  for (const line of lines) {
    if (!skipping) {
      // Match top-level key (no leading whitespace, followed by colon)
      const match = new RegExp(`^${key}:\\s*$`).exec(line)
      if (match) {
        skipping = true
        skipIndent = 0
        continue
      }
      result.push(line)
    } else {
      const indent = line.search(/\S/)
      if (indent === -1 || indent <= skipIndent) {
        // Blank line or dedented — stop skipping
        skipping = false
        skipIndent = -1
        result.push(line)
      }
      // else: skip (part of the block)
    }
  }
  return result.join("\n")
}


