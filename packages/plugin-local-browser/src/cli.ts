#!/usr/bin/env node
/**
 * `agentproto-browser <verb>` — interactive front-end for the
 * @agentproto/plugin-local-browser setup flow.
 *
 *   setup    pick a Chrome profile, clone it, register chrome-devtools-mcp
 *   status   show what's currently registered
 *   remove   unregister (clone dir on disk is left alone)
 *
 * Argument parsing is intentionally minimal — three verbs, a handful
 * of flags. The full programmatic API lives at the package root for
 * hosts that want to drive the flow themselves.
 */

import { parseArgs } from "node:util"
import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  listChromeProfiles,
  DEFAULT_AUTOMATION_USER_DATA_DIR,
  setup,
  teardown,
  IMPORTED_MCPS_PATH,
} from "./index.js"

const USAGE = `agentproto-browser — wire a real Chrome profile into the agentproto daemon

Usage:
  agentproto-browser setup   [--profile <dir>] [--yes]
                             [--skip-clone] [--skip-install]
                             [--user-data-dir <path>]
                             [--chrome-mcp-version <ver>]
                             [--headless]
  agentproto-browser status
  agentproto-browser remove
  agentproto-browser --help

setup steps:
  1. Reads ~/Library/Application Support/Google/Chrome/Local State
  2. Prompts you to pick one of your Chrome profiles (skip with --profile)
  3. Clones it to ~/.agentproto/chrome-profile/ (skip with --skip-clone)
  4. Installs chrome-devtools-mcp into ~/.agentproto/chrome-mcp/
     (skip with --skip-install — only safe on re-run)
  5. Writes an entry to ~/.agentproto/imported-mcps.json so the daemon
     proxies chrome-devtools-mcp through /mcp to every connected host

Restart the daemon after setup for the new tools to surface:
  ~/.agentproto/start-daemon-prod.sh
`

async function main(argv: readonly string[]): Promise<number> {
  const verb = argv[0]
  const rest = argv.slice(1)
  switch (verb) {
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(USAGE)
      return verb === undefined ? 2 : 0
    case "setup":
      return runSetup(rest)
    case "status":
      return runStatus()
    case "remove":
      return runRemove()
    default:
      process.stderr.write(`agentproto-browser: unknown verb '${verb}'.\n\n${USAGE}`)
      return 2
  }
}

async function runSetup(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      profile: { type: "string" },
      yes: { type: "boolean", short: "y" },
      "skip-clone": { type: "boolean" },
      "skip-install": { type: "boolean" },
      "user-data-dir": { type: "string" },
      "chrome-mcp-version": { type: "string" },
      headless: { type: "boolean" },
    },
  })

  let profiles
  try {
    profiles = await listChromeProfiles()
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      process.stderr.write(
        "agentproto-browser: Chrome's Local State file not found. " +
          "Install Google Chrome and launch it once before running setup.\n"
      )
      return 1
    }
    throw err
  }
  if (profiles.length === 0) {
    process.stderr.write(
      "agentproto-browser: no Chrome profiles found in Local State.\n"
    )
    return 1
  }

  let chosen: string | undefined = values.profile
  if (!chosen) {
    const picked = await promptProfile(profiles)
    if (!picked) {
      process.stderr.write("agentproto-browser: setup cancelled.\n")
      return 1
    }
    chosen = picked
  }

  const profile = profiles.find(p => p.directory === chosen)
  if (!profile) {
    process.stderr.write(
      `agentproto-browser: '${chosen}' is not one of your Chrome profiles ` +
        `(${profiles.map(p => p.directory).join(", ")}).\n`
    )
    return 1
  }

  const destUserDataDir = values["user-data-dir"] ?? DEFAULT_AUTOMATION_USER_DATA_DIR()
  const skipClone = values["skip-clone"] === true

  if (!values.yes) {
    process.stdout.write(
      `\nAbout to set up:\n` +
        `  Chrome profile        ${profile.directory} — ${profile.name}${
          profile.email ? ` <${profile.email}>` : ""
        }\n` +
        `  Clone to              ${destUserDataDir}${skipClone ? " (SKIPPED)" : ""}\n` +
        `  Install chrome-mcp    ${
          values["skip-install"] === true
            ? "SKIPPED"
            : "~/.agentproto/chrome-mcp"
        }\n` +
        `  Register MCP          ${IMPORTED_MCPS_PATH()}\n\n`
    )
    const ok = await promptYesNo("Proceed?")
    if (!ok) {
      process.stderr.write("agentproto-browser: setup cancelled.\n")
      return 1
    }
  }

  const extraChromeArgs: string[] = []
  if (values.headless) extraChromeArgs.push("--headless=new")

  const startedAt = Date.now()
  let lastClone = startedAt
  let cloneCount = 0
  let lastInstall = ""
  const result = await setup({
    profileDirectory: profile.directory,
    destUserDataDir,
    skipClone,
    skipInstall: values["skip-install"] === true,
    ...(values["chrome-mcp-version"]
      ? { chromeMcpVersion: values["chrome-mcp-version"] }
      : {}),
    ...(extraChromeArgs.length ? { extraChromeArgs } : {}),
    onCloneProgress: () => {
      cloneCount += 1
      const now = Date.now()
      if (now - lastClone > 250) {
        process.stdout.write(`\r  cloning… ${cloneCount} files`)
        lastClone = now
      }
    },
    onInstallProgress: line => {
      // npm output is chatty; collapse to a single overwriting line.
      lastInstall = line.split("\n").pop() ?? line
      if (lastInstall.length > 78) lastInstall = lastInstall.slice(0, 75) + "…"
      process.stdout.write(`\r  installing… ${lastInstall.padEnd(78)}`)
    },
  })
  if (cloneCount > 0) {
    process.stdout.write(`\r  cloning… ${cloneCount} files done.${" ".repeat(40)}\n`)
  }
  if (lastInstall) {
    process.stdout.write(`\r  installing… done.${" ".repeat(70)}\n`)
  }
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)

  process.stdout.write(
    `\n✓ local-browser ready (${elapsed}s)\n` +
      `  profile     ${result.profile.directory} — ${result.profile.name}\n`
  )
  if (result.clone) {
    process.stdout.write(
      `  cloned      ${result.clone.filesCopied} files, ` +
        `${formatBytes(result.clone.bytesCopied)} → ${result.userDataDir}\n` +
        (result.clone.skippedDirs.length
          ? `  skipped     ${result.clone.skippedDirs.length} dirs (caches, locks)\n`
          : "")
    )
  }
  process.stdout.write(
    `  installed   chrome-devtools-mcp@${result.install.installedVersion} → ${result.install.prefix}\n` +
      `  registered  ${result.register.replaced ? "(replaced)" : "(new)"} as ` +
      `alias 'local-browser' in ${result.register.importsPath}\n` +
      `\nRestart the daemon for the new tools to surface:\n` +
      `  ~/.agentproto/start-daemon-prod.sh\n`
  )
  return 0
}

async function runStatus(): Promise<number> {
  const path = IMPORTED_MCPS_PATH()
  let raw: string
  try {
    raw = await fs.readFile(path, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      process.stdout.write(
        "agentproto-browser: not set up yet — no imported-mcps.json.\n"
      )
      return 0
    }
    throw err
  }
  const parsed = JSON.parse(raw) as {
    imports?: Array<{ id: string; alias: string; snapshot?: { args?: string[] } }>
  }
  const ours = (parsed.imports ?? []).filter(e =>
    e.id.startsWith("plugin:local-browser:")
  )
  if (ours.length === 0) {
    process.stdout.write(
      "agentproto-browser: not set up yet — no local-browser entry in imported-mcps.json.\n"
    )
    return 0
  }
  for (const entry of ours) {
    process.stdout.write(
      `${entry.alias} (${entry.id})\n` +
        `  args: ${(entry.snapshot?.args ?? []).join(" ")}\n`
    )
  }
  // Surface the on-disk artifacts too — helpful when troubleshooting.
  const cloneDir = DEFAULT_AUTOMATION_USER_DATA_DIR()
  try {
    const ls = await fs.readdir(cloneDir)
    process.stdout.write(`\nclone dir: ${cloneDir}\n  entries: ${ls.join(", ")}\n`)
  } catch {
    process.stdout.write(`\nclone dir: ${cloneDir} (not present)\n`)
  }
  const mcpDir = join(homedir(), ".agentproto", "chrome-mcp")
  try {
    const pkg = JSON.parse(
      await fs.readFile(
        join(mcpDir, "node_modules", "chrome-devtools-mcp", "package.json"),
        "utf8"
      )
    ) as { version?: string }
    process.stdout.write(`chrome-mcp: ${mcpDir} (v${pkg.version ?? "?"})\n`)
  } catch {
    process.stdout.write(`chrome-mcp: ${mcpDir} (not installed)\n`)
  }
  return 0
}

async function runRemove(): Promise<number> {
  const { removed } = await teardown()
  if (removed === 0) {
    process.stdout.write("agentproto-browser: nothing to remove.\n")
    return 0
  }
  process.stdout.write(
    `agentproto-browser: removed ${removed} import(s).\n` +
      `Disk artifacts left in place — delete manually if you want to reclaim:\n` +
      `  ${DEFAULT_AUTOMATION_USER_DATA_DIR()}   (Chrome profile clone)\n` +
      `  ${join(homedir(), ".agentproto", "chrome-mcp")}        (chrome-devtools-mcp install)\n`
  )
  return 0
}

async function promptProfile(
  profiles: Array<{
    directory: string
    name: string
    email: string
    lastActive: string
    isLastUsed: boolean
  }>
): Promise<string | null> {
  process.stdout.write("\nYour Chrome profiles:\n\n")
  profiles.forEach((p, i) => {
    const marker = p.isLastUsed ? " (currently active)" : ""
    const date = p.lastActive ? p.lastActive.slice(0, 10) : "      ?   "
    const email = p.email ? ` <${p.email}>` : ""
    process.stdout.write(
      `  ${i + 1}. ${p.directory.padEnd(12)} ${p.name}${email}  · ${date}${marker}\n`
    )
  })
  process.stdout.write("\n")
  const rl = createInterface({ input, output })
  try {
    const answer = (
      await rl.question("Pick a profile [1]: ")
    ).trim()
    const idx = answer === "" ? 1 : Number(answer)
    if (!Number.isInteger(idx) || idx < 1 || idx > profiles.length) return null
    return profiles[idx - 1]!.directory
  } finally {
    rl.close()
  }
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input, output })
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
    return answer === "y" || answer === "yes"
  } finally {
    rl.close()
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const exitCode = await main(process.argv.slice(2))
process.exit(exitCode)
