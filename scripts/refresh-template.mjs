#!/usr/bin/env node
/** Publish and prove a fresh DEVELOPMENT workstation template. */

import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const ID_RE = /\b[a-z0-9]{20}\b/g
const ID_EXACT_RE = /^[a-z0-9]{20}$/

let root = DEFAULT_ROOT
let channel = null
let latest = false
let pinned = false
let dryRun = false
let check = false
let suppliedTemplateId = null
const args = process.argv.slice(2)

function usage(exitCode = 0) {
  const out = exitCode === 0 ? process.stdout : process.stderr
  out.write(
    "Usage: pnpm templates:refresh --channel dev (--latest | --check) [--dry-run] [--template-id <id>]\n" +
      "       pnpm templates:refresh --channel stable --pin [--dry-run] [--template-id <id>]\n\n" +
      "Builds and proves a new E2B template before updating versions.json.\n" +
      "dev: --latest is required for a publish and resolves npm's latest dist-tag.\n" +
      "stable: --pin is required and bakes exactly the versions pinned in versions.json\n" +
      "  (stable never resolves npm latest).\n" +
      "--check is credential-free and verifies generated files plus the recorded proofs.\n",
  )
  process.exit(exitCode)
}

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === "--channel") channel = args[++i]
  else if (arg === "--root") root = path.resolve(args[++i])
  else if (arg === "--latest") latest = true
  else if (arg === "--pin") pinned = true
  else if (arg === "--dry-run") dryRun = true
  else if (arg === "--check") check = true
  else if (arg === "--template-id") suppliedTemplateId = args[++i]
  else if (arg === "--help" || arg === "-h") usage()
  else {
    process.stderr.write(`templates:refresh: unknown argument ${arg}\n`)
    usage(2)
  }
}

const ROOT = root
const VERSIONS_PATH = path.join(ROOT, "templates/workstation/versions.json")
const SYNC_SCRIPT = path.join(ROOT, "scripts/sync-templates.mjs")

function fail(message) {
  process.stderr.write(`templates:refresh: ${message}\n`)
  process.exit(1)
}

if (channel !== "dev" && channel !== "stable") {
  fail("only --channel dev or --channel stable is supported")
}
if (channel === "dev" && pinned) {
  fail("--channel dev publishes only with --latest; --pin is a stable-only mode")
}
if (channel === "stable" && latest) {
  fail("stable must never pull npm latest; pass --pin to bake exactly the versions.json pins")
}
if (channel === "stable" && !pinned && !check) {
  fail("--channel stable requires --pin to bake the declared versions.json pins")
}
if (check && (latest || pinned || dryRun || suppliedTemplateId)) {
  fail("--check cannot be combined with --latest, --pin, --dry-run, or --template-id")
}
if (!check && !latest && !pinned) fail("refusing an implicit registry update; pass --latest (dev) or --pin (stable) explicitly")
if (suppliedTemplateId !== null && !ID_EXACT_RE.test(suppliedTemplateId)) {
  fail("--template-id must be an opaque 20-character lowercase E2B template id")
}

function run(command, commandArgs, options = {}) {
  try {
    return execFileSync(command, commandArgs, {
      cwd: options.cwd ?? ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : ""
    const stdout = error.stdout ? String(error.stdout).trim() : ""
    throw new Error(`${command} ${commandArgs.join(" ")} failed: ${stderr || stdout || error.message}`)
  }
}

function readVersions() {
  try {
    return JSON.parse(readFileSync(VERSIONS_PATH, "utf8"))
  } catch (error) {
    fail(`cannot read ${path.relative(ROOT, VERSIONS_PATH)}: ${error.message}`)
  }
}

function isExactProof(entry, versions) {
  if (!entry?.id || !entry?.baked || entry.baked.cli !== versions.cli || !entry.baked.builtAt) return false
  const actual = entry.baked.adapters
  if (!actual || typeof actual !== "object") return false
  const expected = versions.adapters
  return Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([pkg, version]) => actual[pkg] === version)
}

function checkOnly(versions) {
  try {
    run(process.execPath, [SYNC_SCRIPT, "--check"])
  } catch (error) {
    fail(error.message)
  }
  for (const ch of ["dev", "stable"]) {
    if (!isExactProof(versions.templates[ch], versions)) {
      fail(`${ch} does not have a complete recorded proof for the declared pins; run pnpm templates:refresh --channel ${ch} ${ch === "stable" ? "--pin" : "--latest"}`)
    }
  }
  process.stdout.write("templates:refresh: generated files are in sync and both channels have complete recorded proofs.\n")
}

function requireCleanTree() {
  if (run("git", ["status", "--porcelain=v1"]).trim()) {
    fail("refusing to publish from a dirty tree; commit or stash changes first so the generated refresh is reviewable")
  }
}

function resolveLatest(pkg) {
  const raw = run("npm", ["view", `${pkg}@latest`, "version", "--json"]).trim()
  let version
  try { version = JSON.parse(raw) } catch { version = raw.replace(/^"|"$/g, "") }
  if (Array.isArray(version)) version = version.at(-1)
  if (typeof version !== "string" || !SEMVER_RE.test(version)) fail(`npm did not return an exact semver for ${pkg}@latest: ${JSON.stringify(version)}`)
  return version
}

function resolvePins(versions) {
  return {
    cli: resolveLatest("@agentproto/cli"),
    adapters: Object.fromEntries(Object.keys(versions.adapters).sort().map(pkg => [pkg, resolveLatest(pkg)])),
    runtime: Object.fromEntries(Object.keys(versions.runtime).sort().map(pkg => [pkg, resolveLatest(pkg)])),
  }
}

function withChannelPins(versions, channel, pins) {
  const next = structuredClone(versions)
  next.cli = pins.cli
  next.adapters = pins.adapters
  next.runtime = pins.runtime
  // The temporary Dockerfile is generated from these pins; an old proof must
  // never be carried over to a new image.
  next.templates[channel].baked = { cli: null, adapters: null, builtAt: null }
  return next
}

function resolveStablePins(versions) {
  return {
    cli: versions.cli,
    adapters: Object.fromEntries(Object.keys(versions.adapters).sort().map(pkg => [pkg, versions.adapters[pkg]])),
    runtime: Object.fromEntries(Object.keys(versions.runtime).sort().map(pkg => [pkg, versions.runtime[pkg]])),
  }
}

function makeBuildDirectory(nextVersions) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "agentproto-template-refresh-"))
  try {
    // sync-templates updates marked files as well as build artifacts. Copy the
    // source tree first so its dry generation can run without touching the
    // reviewable worktree.
    cpSync(path.join(ROOT, "templates"), path.join(tempRoot, "templates"), { recursive: true })
    cpSync(path.join(ROOT, "scripts"), path.join(tempRoot, "scripts"), { recursive: true })
    for (const relPath of [
      "packages/sandbox-e2b/src/template-versions.generated.ts",
      "packages/sandbox-e2b/README.md",
      "packages/sandbox-e2b/package.json",
      "packages/runtime/src/sandbox-providers/registry.ts",
      "packages/runtime/src/sandbox-adapters.ts",
      "docs/cli/guides/sandbox-rendezvous.md",
    ]) {
      const source = path.join(ROOT, relPath)
      const destination = path.join(tempRoot, relPath)
      if (existsSync(source)) cpSync(source, destination)
    }
    const tempVersions = path.join(tempRoot, "templates/workstation/versions.json")
    writeFileSync(tempVersions, JSON.stringify(nextVersions, null, 2) + "\n")
    run(process.execPath, [SYNC_SCRIPT, "--root", tempRoot])
    return tempRoot
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true })
    throw error
  }
}

function extractId(output, kind) {
  const text = String(output)
  const id = text.match(new RegExp(`(?:${kind} ID|${kind} id|ID)\\s+([a-z0-9]{20})\\b`, "i"))?.[1]
    ?? [...text.matchAll(ID_RE)].map(match => match[0]).at(-1)
  if (!id) throw new Error(`could not find a ${kind} id in e2b output`)
  return id
}

function assertCredentials() {
  try { run("e2b", ["auth", "info"]) } catch (error) {
    fail(`E2B credentials are required to publish; run e2b auth login or set E2B_ACCESS_TOKEN (${error.message})`)
  }
}

function proveTemplate(templateId, expected) {
  let sandboxId = null
  try {
    sandboxId = extractId(run("e2b", ["sandbox", "create", "--detach", templateId]), "sandbox")
    const command = (...commandArgs) => run("e2b", ["sandbox", "exec", sandboxId, "--", ...commandArgs])
    const cliOutput = command("agentproto", "--version")
    if (!new RegExp(`\\b${expected.cli.replaceAll(".", "\\.")}\\b`).test(cliOutput)) {
      throw new Error(`proof failed: agentproto --version did not contain ${expected.cli}`)
    }
    command("node", "--version")
    command("git", "--version")
    const packageTree = JSON.parse(command("npm", "ls", "-g", "--depth=0", "--json"))
    const installed = packageTree.dependencies ?? {}
    for (const [pkg, version] of Object.entries({ "@agentproto/cli": expected.cli, ...expected.adapters, ...expected.runtime })) {
      if (installed[pkg]?.version !== version) throw new Error(`proof failed: ${pkg}@${version} is not globally installed`)
    }
    // Starts the already baked CLI directly; no runtime install can make this pass.
    command("sh", "-lc", "set -eu; agentproto serve --port 18790 --bind 127.0.0.1 --workspace /home/user >/tmp/agentproto-refresh-health.log 2>&1 & pid=$!; trap 'kill $pid 2>/dev/null || true' EXIT; for i in $(seq 1 30); do node -e 'fetch(\"http://127.0.0.1:18790/health\").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))' && exit 0; sleep 1; done; cat /tmp/agentproto-refresh-health.log >&2; exit 1")
    return { sandboxId, cliOutput: cliOutput.trim() }
  } finally {
    if (sandboxId) {
      try { run("e2b", ["sandbox", "kill", sandboxId]) } catch {
        process.stderr.write(`templates:refresh: warning: could not kill proof sandbox ${sandboxId}; clean it up in E2B.\n`)
      }
    }
  }
}

function snapshotGeneratedFiles() {
  const relPaths = [
    "templates/workstation/versions.json", "templates/workstation/Dockerfile", "templates/workstation/e2b.template.toml",
    "packages/sandbox-e2b/src/template-versions.generated.ts", "packages/sandbox-e2b/README.md",
    "docs/cli/guides/sandbox-rendezvous.md", "packages/runtime/src/sandbox-providers/registry.ts",
    "packages/runtime/src/sandbox-adapters.ts", "packages/sandbox-e2b/package.json",
  ]
  return relPaths.map(relPath => {
    const filePath = path.join(ROOT, relPath)
    return { filePath, content: existsSync(filePath) ? readFileSync(filePath, "utf8") : null }
  })
}

const versions = readVersions()
if (check) {
  checkOnly(versions)
  process.exit(0)
}

requireCleanTree()
let pins
if (pinned) {
  pins = resolveStablePins(versions)
} else {
  try { pins = resolvePins(versions) } catch (error) { fail(error.message) }
}
const nextVersions = withChannelPins(versions, channel, pins)
const pinLines = [
  `@agentproto/cli@${pins.cli}`,
  ...Object.entries(pins.adapters).map(([pkg, version]) => `${pkg}@${version}`),
  ...Object.entries(pins.runtime).map(([pkg, version]) => `${pkg}@${version}`),
]

if (dryRun) {
  process.stdout.write(`templates:refresh (dry-run): would publish and prove ${channel} with explicit pins:\n`)
  for (const pin of pinLines) process.stdout.write(`  ${pin}\n`)
  process.stdout.write(`  alias: ${versions.templates[channel].alias}\n`)
  process.exit(0)
}

assertCredentials()
let tempRoot
let templateId = suppliedTemplateId
try {
  tempRoot = makeBuildDirectory(nextVersions)
  if (!templateId) {
    const buildOutput = run("e2b", ["template", "create", versions.templates[channel].alias, "--cpu-count", String(versions.resources.cpuCount), "--memory-mb", String(versions.resources.memoryMb), "-d", "Dockerfile"], { cwd: path.join(tempRoot, "templates/workstation") })
    templateId = extractId(buildOutput, "template")
  }
  const proof = proveTemplate(templateId, pins)
  nextVersions.templates[channel] = { ...nextVersions.templates[channel], id: templateId, baked: { cli: pins.cli, adapters: pins.adapters, builtAt: new Date().toISOString() } }
  const otherChannel = channel === "dev" ? "stable" : "dev"
  if (JSON.stringify(nextVersions.templates[otherChannel]) !== JSON.stringify(versions.templates[otherChannel])) throw new Error(`internal safety check failed: refresh attempted to alter ${otherChannel}`)
  const snapshot = snapshotGeneratedFiles()
  try {
    writeFileSync(VERSIONS_PATH, JSON.stringify(nextVersions, null, 2) + "\n")
    run(process.execPath, [SYNC_SCRIPT])
    run(process.execPath, [SYNC_SCRIPT, "--check"])
  } catch (error) {
    for (const entry of snapshot) {
      if (entry.content !== null) writeFileSync(entry.filePath, entry.content)
      else rmSync(entry.filePath, { force: true })
    }
    throw new Error(`local metadata transaction rolled back after failure: ${error.message}`)
  }
  process.stdout.write(`templates:refresh: published and proved ${channel} template ${templateId} (proof sandbox ${proof.sandboxId}).\nRecorded ${pinLines.join(", ")}; ${channel === "dev" ? "stable" : "dev"} was not changed. Review and commit the generated diff.\n`)
} catch (error) {
  fail(error.message)
} finally {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
}
