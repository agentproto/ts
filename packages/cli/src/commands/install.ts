/**
 * `agentproto install <slug>`
 *
 * Reads the adapter manifest's `install` block and shells out to the
 * declared package manager. Idempotent: if `version_check` passes, we
 * skip and report "already installed" (override with --force).
 *
 * The adapter package itself must already be in node_modules (we resolve
 * it before reading its manifest). Bootstrapping the adapter package is
 * a separate concern — `npm i -g @agentproto/adapter-<slug>` first.
 *
 * Method support matrix:
 *   - `npm`            ✓
 *   - `brew`           ✓ (macOS / Linux Homebrew)
 *   - `curl`           ✓ (with optional verify_sha256)
 *   - `download`       ✓ (tarball/zip + extract_bin + optional verify_sha256)
 *   - `pip`            ✓ (with optional `user: true`)
 *   - `cargo`          ✓
 *   - `go`             ✓
 *   - `apt/dnf/pacman` ✗ (privilege escalation needs explicit sudo policy)
 *   - `choco/scoop`    ✗ (Windows-only; not yet platform-detected)
 *   - `vendored`       ✓ for generic ACP agents (acp-generic.ts) whose
 *                        `metadata.acpGeneric.install_hint` names a known
 *                        package manager (npm/uv/pip/pipx/brew/cargo/go) —
 *                        the SAME hint the daemon's `adapter_install` path
 *                        already runs (see install-driver.ts). A step with
 *                        no runnable hint and no binary already on PATH
 *                        still reports "install it manually".
 *
 * After install, runs the optional `setup[]` pipeline (AIP-29 § Setup).
 */

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import type { AgentCliHandle, AgentCliInstallMethod } from "@agentproto/driver-agent-cli"
import { resolveAdapter } from "../registry/resolve.js"
import { runSetup } from "./setup.js"
import { runInstallProfile } from "./install-profile.js"
import { runInstallSkill } from "./install-skill.js"
import { CATALOG } from "../registry/catalog.js"
import { binOnPath } from "../registry/acp-generic.js"
import {
  parseNpmPackageFromHint,
  parseShellHint,
  commandOnPath,
  KNOWN_INSTALL_COMMANDS,
} from "../registry/install-hint.js"

export async function runInstall(args: readonly string[]): Promise<number> {
  // Peek at the slug before parseArgs — it influences which option set is
  // valid. Adapter slugs, runtime-profile/* slugs, and skill/* slugs share
  // the verb but route through separate handlers with different flags.
  const slugPeek = args.find((a) => !a.startsWith("-"))
  if (slugPeek?.startsWith("runtime-profile/")) {
    return runInstallProfile(
      slugPeek,
      args.filter((a) => a !== slugPeek)
    )
  }
  if (slugPeek?.startsWith("skill/")) {
    return runInstallSkill(
      slugPeek,
      args.filter((a) => a !== slugPeek)
    )
  }

  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      force: { type: "boolean", short: "f" },
      "dry-run": { type: "boolean" },
      "skip-setup": { type: "boolean" },
      // Opt-in to running a `curl | bash` / `download` installer that
      // declares no `verify_sha256`. Off by default: in a non-interactive
      // context (agent, daemon, CI) an unverified installer is refused (see
      // `shouldRefuseUnverifiedInstaller`), because a silent MITM there
      // compromises the machine. A human at a TTY still gets warn-and-proceed.
      "allow-unverified": { type: "boolean" },
    },
  })

  const slug = positionals[0]
  if (!slug) {
    process.stderr.write(
      "agentproto install: missing adapter slug. Try: agentproto install claude-code\n"
    )
    return 2
  }

  // Bootstrap the adapter package itself. `resolveAdapter` requires the
  // `@agentproto/adapter-<slug>` package to be importable from this
  // process's module graph; on a fresh machine it isn't, so the verb used
  // to die with "could not load adapter … Install it with: npm i -g …" —
  // pushing the user out of the verb's purpose. When the slug maps to a
  // known catalog entry (so we're confident the npm package exists), run
  // `npm i -g` ourselves first, then re-resolve. A --dry-run only prints
  // what would run; an npm failure surfaces the manual path.
  let adapter: Awaited<ReturnType<typeof resolveAdapter>>
  try {
    adapter = await resolveAdapter(slug)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const isMissingPackage =
      /could not load adapter|Cannot find package|ERR_MODULE_NOT_FOUND/i.test(
        msg
      ) && msg.includes(`@agentproto/adapter-${slug}`)
    const catalogEntry = CATALOG.find((e) => e.slug === slug)
    if (!isMissingPackage || !catalogEntry?.packageName) throw err

    const pkg = catalogEntry.packageName
    if (values["dry-run"]) {
      process.stdout.write(
        `agentproto install: [bootstrap] would run: npm i -g ${pkg}\n` +
          `  (then read ${pkg}'s manifest and run its install[] steps)\n`
      )
      return 0
    }
    process.stdout.write(
      `agentproto install: [bootstrap] installing ${pkg}…\n`
    )
    const code = await spawnInherit("npm", ["install", "-g", pkg])
    if (code !== 0) {
      process.stderr.write(
        `agentproto install: npm i -g ${pkg} failed (exit ${code}). ` +
          `Install it manually: npm i -g ${pkg}\n`
      )
      return code
    }
    // Re-resolve. A failed dynamic `import()` is not cached by Node, so
    // the second call re-resolves from disk and picks up the freshly-
    // installed global package (the global node_modules is an ancestor of
    // a globally-installed CLI's location). Falling through to the
    // original `resolveAdapter` keeps the proprietary-adapter path-rewrite
    // and every other resolution nicety in one place.
    try {
      adapter = await resolveAdapter(slug)
    } catch (retryErr) {
      const cause =
        retryErr instanceof Error ? retryErr.message : String(retryErr)
      process.stderr.write(
        `agentproto install: ${pkg} installed but could not be loaded: ${cause}\n` +
          `Re-run \`agentproto install ${slug}\` from a fresh shell, or install manually: npm i -g ${pkg}\n`
      )
      return 1
    }
  }
  const installSteps: AgentCliInstallMethod[] = adapter.handle.install ?? []
  if (installSteps.length === 0) {
    process.stderr.write(
      `agentproto install: adapter '${slug}' declares no install steps.\n`
    )
    return 0
  }

  let alreadyInstalled = false
  if (!values.force) {
    const checked = await runVersionCheck(adapter.handle.version_check)
    if (checked.ok) {
      process.stdout.write(
        `agentproto: '${slug}' already installed (${checked.message}). Pass --force to reinstall.\n`
      )
      alreadyInstalled = true
    }
  }

  const installHint = installHintOf(adapter.handle)

  if (!alreadyInstalled) {
    let lastFailure: { step: AgentCliInstallMethod; code: number } | null = null
    let succeeded = false
    for (const [i, step] of installSteps.entries()) {
      // Spec: hosts try install methods *in order until one succeeds*.
      // Pre-this-fix the runner aborted on the first failure, which made
      // the curl-fallback pattern in opencode/openclaw unreachable
      // whenever npm wasn't viable. Now we collect failures and only
      // surface the last one if every method falls through.
      if (step.experimental) {
        process.stdout.write(
          `agentproto install [${i + 1}/${installSteps.length}] ${describeStep(step, installHint)} (experimental — skipping)\n`
        )
        continue
      }
      process.stdout.write(
        `agentproto install [${i + 1}/${installSteps.length}] ${describeStep(step, installHint)}\n`
      )
      if (values["dry-run"]) {
        succeeded = true
        continue
      }
      const code = await runStep(step, values["allow-unverified"] === true, installHint)
      if (code === 0) {
        succeeded = true
        break
      }
      lastFailure = { step, code }
      process.stdout.write(
        `agentproto install: method '${step.method}' returned ${code}; trying next.\n`
      )
    }
    if (!succeeded && lastFailure) {
      process.stderr.write(
        `agentproto install: all ${installSteps.length} install methods failed. Last failure: ${lastFailure.step.method} → exit ${lastFailure.code}.\n`
      )
      return lastFailure.code
    }
    if (!succeeded && !lastFailure) {
      // Every method was experimental/skipped.
      process.stderr.write(
        `agentproto install: no usable install method found for '${slug}'.\n`
      )
      return 1
    }
    process.stdout.write(`agentproto: '${slug}' installed.\n`)
  }

  // Run the AIP-29 § Setup pipeline (post-install configuration). Skipped
  // when --skip-setup is passed or the manifest declares no setup. The
  // setup engine is idempotent — already-satisfied steps short-circuit
  // via skip_if; previously-completed steps short-circuit via the ledger.
  if (!values["skip-setup"] && (adapter.handle.setup?.length ?? 0) > 0) {
    process.stdout.write(`agentproto: running setup for '${slug}'…\n`)
    const setupCode = await runSetup({
      slug,
      handle: adapter.handle,
      force: values.force ?? false,
      dryRun: values["dry-run"] ?? false,
    })
    if (setupCode !== 0) return setupCode
  }

  return 0
}

/**
 * Pull a generic ACP handle's human "how to install" line out of its
 * manifest (`acp-generic.ts`'s `acpHandleFromSpec` stashes it at
 * `metadata.acpGeneric.install_hint` — there's no first-class AIP-45 field
 * for it, since a native adapter's `install[]` steps are already
 * self-describing). Returns `undefined` for a native adapter or a generic
 * agent declared with no hint (a true bring-your-own-binary CLI).
 */
function installHintOf(handle: AgentCliHandle): string | undefined {
  const acpGeneric = handle.metadata?.["acpGeneric"]
  if (!acpGeneric || typeof acpGeneric !== "object") return undefined
  const hint = (acpGeneric as Record<string, unknown>)["install_hint"]
  return typeof hint === "string" ? hint : undefined
}

function describeStep(step: AgentCliInstallMethod, hint?: string): string {
  switch (step.method) {
    case "npm":
      return `npm install ${step.global ? "-g " : ""}${step.package ?? "(?)"}`
    case "brew":
      return `brew install ${step.package ?? "(?)"}`
    case "pip":
      return `pip install ${step.user ? "--user " : ""}${step.package ?? "(?)"}`
    case "cargo":
      return `cargo install ${step.package ?? "(?)"}`
    case "go":
      return `go install ${step.package ?? "(?)"}`
    case "curl":
      return `curl ${step.url ?? "(?)"} | bash`
    case "download":
      return `download ${step.url ?? "(?)"} → ${step.extract_bin ?? "(?)"}`
    case "vendored":
      return hint ? `${hint} (vendored: ${step.path ?? "(?)"})` : `vendored ${step.path ?? "(?)"}`
    default:
      return `${step.method} ${step.package ?? step.url ?? step.path ?? "(?)"}`
  }
}

async function runStep(
  step: AgentCliInstallMethod,
  allowUnverified: boolean,
  installHint?: string,
): Promise<number> {
  switch (step.method) {
    case "npm": {
      if (!step.package) {
        process.stderr.write("agentproto install: npm step missing package.\n")
        return 2
      }
      const argv = ["install"]
      if (step.global) argv.push("-g")
      argv.push(step.package)
      return spawnInherit("npm", argv)
    }
    case "brew": {
      if (!step.package) {
        process.stderr.write("agentproto install: brew step missing package.\n")
        return 2
      }
      // Namespaced packages (e.g. `stripe/stripe-cli/stripe`) need an
      // implicit `brew tap`; `brew install` accepts the fully-qualified
      // form, so we pass it through verbatim. Bare names work too.
      return spawnInherit("brew", ["install", step.package])
    }
    case "pip": {
      if (!step.package) {
        process.stderr.write("agentproto install: pip step missing package.\n")
        return 2
      }
      const argv = ["install"]
      if (step.user) argv.push("--user")
      argv.push(step.package)
      // Prefer pip3 when it exists; fall back to pip. We just call `pip`
      // here because the user's PATH ordering is the right authority.
      return spawnInherit("pip", argv)
    }
    case "cargo": {
      if (!step.package) {
        process.stderr.write(
          "agentproto install: cargo step missing package.\n"
        )
        return 2
      }
      return spawnInherit("cargo", ["install", step.package])
    }
    case "go": {
      if (!step.package) {
        process.stderr.write("agentproto install: go step missing package.\n")
        return 2
      }
      return spawnInherit("go", ["install", step.package])
    }
    case "curl": {
      if (!step.url) {
        process.stderr.write("agentproto install: curl step missing url.\n")
        return 2
      }
      return runCurlInstaller(step.url, step.verify_sha256, allowUnverified)
    }
    case "download": {
      if (!step.url || !step.extract_bin) {
        process.stderr.write(
          "agentproto install: download step missing url or extract_bin.\n"
        )
        return 2
      }
      return runDownloadInstaller({
        url: step.url,
        extractBin: step.extract_bin,
        verifySha256: step.verify_sha256,
        allowUnverified,
      })
    }
    case "vendored": {
      // BYO binary (generic ACP agents — acp-generic.ts). Already present ⇒
      // nothing to do. Otherwise run its `install_hint` through the SAME
      // parser the daemon's `adapter_install` path uses (install-hint.ts),
      // so `agentproto install mistral-vibe` actually runs
      // `uv tool install mistral-vibe` instead of silently doing nothing —
      // the bug this case fixes (issue: adapter installed via the daemon
      // path showed as installed, but the CLI-direct path always failed
      // with "not yet implemented", which some install flows fall back to).
      if (step.path && (await binOnPath(step.path))) {
        process.stdout.write(
          `agentproto install: '${step.path}' already on PATH — nothing to do.\n`
        )
        return 0
      }
      const npmPkg = parseNpmPackageFromHint(installHint)
      if (npmPkg) {
        return spawnInherit("npm", ["install", "-g", npmPkg])
      }
      const shell = parseShellHint(installHint)
      if (shell) {
        if (!commandOnPath(shell.command)) {
          const howTo = KNOWN_INSTALL_COMMANDS[shell.command]
          process.stderr.write(
            `agentproto install: '${shell.command}' is not installed — required to install ` +
              `'${step.path ?? "this agent"}'. Install ${shell.command} first: ${howTo}\n`
          )
          return 1
        }
        return spawnInherit(shell.command, shell.args)
      }
      process.stderr.write(
        `agentproto install: '${step.path ?? "this binary"}' is bring-your-own — ` +
          `${installHint ? `unrecognized install hint "${installHint}"` : "no install hint declared"}. ` +
          `Install it manually (see the adapter's docs).\n`
      )
      return 1
    }
    default:
      process.stderr.write(
        `agentproto install: method '${step.method}' not yet implemented in this CLI version. ` +
          `Run it manually for now (see the adapter's docs).\n`
      )
      return 1
  }
}

/**
 * Decide whether to REFUSE an installer step that declares no
 * `verify_sha256`. AIP-29 (§ Install methods → §curl) says hosts SHOULD
 * refuse curl-style installers without one in production; the risk is a
 * silent MITM/supply-chain compromise of a `curl | bash` (or an unverified
 * downloaded binary dropped on PATH). We split the difference by context:
 *
 *   - verified (`verifySha256` present) → never refuse.
 *   - `--allow-unverified` opt-in → never refuse.
 *   - otherwise → refuse iff NON-interactive. Agents, the daemon, and CI
 *     run without a TTY, so an unverified installer there is refused by
 *     default; a human at a TTY keeps the warn-and-proceed dev behavior.
 *
 * Pure + exported so the policy is unit-testable without spawning an install.
 */
export function shouldRefuseUnverifiedInstaller(opts: {
  verifySha256?: string
  allowUnverified: boolean
  interactive: boolean
}): boolean {
  if (opts.verifySha256) return false
  if (opts.allowUnverified) return false
  return !opts.interactive
}

/**
 * `curl <url> | bash` with optional SHA-256 verification of the
 * installer script *before* executing it. When no `verify_sha256` is
 * declared, `shouldRefuseUnverifiedInstaller` gates execution: refused in
 * non-interactive contexts unless `--allow-unverified` was passed; a human
 * at a TTY gets a warning and proceeds.
 */
async function runCurlInstaller(
  url: string,
  verifySha256: string | undefined,
  allowUnverified: boolean
): Promise<number> {
  if (
    shouldRefuseUnverifiedInstaller({
      verifySha256,
      allowUnverified,
      interactive: process.stdout.isTTY === true,
    })
  ) {
    process.stderr.write(
      `agentproto install: refusing to run an unverified curl installer (${url}) ` +
        `in a non-interactive context. Declare verify_sha256 in the adapter ` +
        `manifest, or pass --allow-unverified to override.\n`
    )
    return 6
  }
  if (!verifySha256) {
    process.stdout.write(
      `agentproto install: curl ${url} (⚠ no verify_sha256 declared — installer integrity not verified)\n`
    )
  }
  const dir = await mkdtemp(join(tmpdir(), "agentproto-curl-"))
  const scriptPath = join(dir, "install.sh")
  try {
    const res = await fetch(url, { redirect: "follow" })
    if (!res.ok) {
      process.stderr.write(
        `agentproto install: curl fetch failed: ${res.status} ${res.statusText}\n`
      )
      return res.status
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (verifySha256) {
      const got = createHash("sha256").update(buf).digest("hex")
      if (got !== verifySha256.toLowerCase()) {
        process.stderr.write(
          `agentproto install: SHA-256 mismatch for ${url}\n  expected: ${verifySha256}\n  got:      ${got}\n`
        )
        return 4
      }
      process.stdout.write(
        `agentproto install: SHA-256 verified (${got.slice(0, 16)}…)\n`
      )
    }
    await writeFile(scriptPath, buf)
    await chmod(scriptPath, 0o755)
    return spawnInherit("bash", [scriptPath])
  } catch (err) {
    process.stderr.write(
      `agentproto install: curl install failed: ${err instanceof Error ? err.message : String(err)}\n`
    )
    return 1
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Download an archive, optionally verify SHA-256, extract the binary
 * named in `extract_bin`, drop it into `~/.local/bin/<id>` (or the
 * AGENTPROTO_BIN_DIR override), and chmod +x. Supports tar.gz, tgz,
 * zip via the host's `tar` and `unzip`. The CLI doesn't decide the
 * binary's final name — `extract_bin`'s basename becomes the symlink
 * name on PATH.
 */
async function runDownloadInstaller(opts: {
  url: string
  extractBin: string
  verifySha256?: string
  allowUnverified: boolean
}): Promise<number> {
  if (
    shouldRefuseUnverifiedInstaller({
      verifySha256: opts.verifySha256,
      allowUnverified: opts.allowUnverified,
      interactive: process.stdout.isTTY === true,
    })
  ) {
    process.stderr.write(
      `agentproto install: refusing to install an unverified download (${opts.url}) ` +
        `in a non-interactive context. Declare verify_sha256 in the adapter ` +
        `manifest, or pass --allow-unverified to override.\n`
    )
    return 6
  }
  const dir = await mkdtemp(join(tmpdir(), "agentproto-dl-"))
  try {
    const filename = opts.url.split("/").pop() || "archive.bin"
    const archivePath = join(dir, filename)
    const res = await fetch(opts.url, { redirect: "follow" })
    if (!res.ok) {
      process.stderr.write(
        `agentproto install: download fetch failed: ${res.status} ${res.statusText}\n`
      )
      return res.status
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (opts.verifySha256) {
      const got = createHash("sha256").update(buf).digest("hex")
      if (got !== opts.verifySha256.toLowerCase()) {
        process.stderr.write(
          `agentproto install: SHA-256 mismatch\n  expected: ${opts.verifySha256}\n  got:      ${got}\n`
        )
        return 4
      }
    }
    await writeFile(archivePath, buf)

    const extractDir = join(dir, "extract")
    await mkdir(extractDir, { recursive: true })
    let extractCode: number
    if (
      filename.endsWith(".tar.gz") ||
      filename.endsWith(".tgz") ||
      filename.endsWith(".tar")
    ) {
      extractCode = await spawnInherit("tar", [
        "-xf",
        archivePath,
        "-C",
        extractDir,
      ])
    } else if (filename.endsWith(".zip")) {
      extractCode = await spawnInherit("unzip", [
        "-q",
        archivePath,
        "-d",
        extractDir,
      ])
    } else {
      process.stderr.write(
        `agentproto install: unsupported archive format for ${filename}. ` +
          `Supported: .tar, .tar.gz, .tgz, .zip.\n`
      )
      return 5
    }
    if (extractCode !== 0) return extractCode

    const srcBin = join(extractDir, opts.extractBin)
    const binDir =
      process.env["AGENTPROTO_BIN_DIR"] ?? join(homedir(), ".local", "bin")
    await mkdir(binDir, { recursive: true })
    const destBin = join(binDir, opts.extractBin.split("/").pop()!)
    // Use cp -p to preserve mode bits then chmod +x to be safe.
    const cpCode = await spawnInherit("cp", ["-p", srcBin, destBin])
    if (cpCode !== 0) return cpCode
    await chmod(destBin, 0o755)
    process.stdout.write(`agentproto install: ${destBin}\n`)
    if (!process.env["PATH"]?.includes(binDir)) {
      process.stdout.write(
        `agentproto install: ⚠  ${binDir} is not on PATH — add it to your shell profile so the binary is reachable.\n`
      )
    }
    return 0
  } catch (err) {
    process.stderr.write(
      `agentproto install: download failed: ${err instanceof Error ? err.message : String(err)}\n`
    )
    return 1
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function homedir(): string {
  return process.env["HOME"] ?? process.env["USERPROFILE"] ?? "/"
}

function spawnInherit(cmd: string, argv: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: "inherit" })
    child.once("error", reject)
    child.once("exit", (code) => resolve(code ?? 0))
  })
}

async function runVersionCheck(
  check: Awaited<
    ReturnType<typeof resolveAdapter>
  >["handle"]["version_check"]
): Promise<{ ok: boolean; message: string }> {
  if (!check) return { ok: false, message: "no version_check declared" }
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", check.cmd], {
      stdio: ["ignore", "pipe", "ignore"],
    })
    let buf = ""
    child.stdout.on("data", (c: Buffer) => {
      buf += c.toString("utf8")
    })
    child.once("error", () => resolve({ ok: false, message: "check failed" }))
    child.once("exit", (code) => {
      if (code !== 0) {
        resolve({ ok: false, message: `check exited ${code}` })
        return
      }
      const re = new RegExp(check.parse)
      const m = buf.match(re)
      if (!m || !m[1]) {
        resolve({ ok: false, message: "could not parse version" })
        return
      }
      // semver-range matching is left to a future helper; we report
      // the captured version and trust it. --force remains the
      // escape hatch when range gating actually matters.
      resolve({ ok: true, message: `version ${m[1]}` })
    })
  })
}
