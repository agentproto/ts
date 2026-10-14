/**
 * Harness freshness + upgrades — the logic behind
 * `agentproto harness outdated|check|upgrade`.
 *
 * A "harness" is the underlying agent CLI binary an adapter spawns
 * (opencode, gemini, copilot, …) — distinct from the adapter *package*
 * itself, which `agentproto adapters outdated` reports on. Three questions
 * live here, in increasing order of willingness to write:
 *
 *   outdated  — is what's installed behind what's published? read-only.
 *   check     — does the harness still speak ACP? read-only, spawns only
 *               the harness itself, in a temp cwd, and spends no tokens.
 *   upgrade   — run the adapter's declared `upgrade.cmd`, then re-check
 *               (version + ACP smoke probe) and roll back when it fails.
 *
 * Every network/local probe goes through {@link HarnessProbes} so tests
 * substitute fakes instead of touching npm, GitHub, or `bash -lc`.
 * Every probe degrades to `null` rather than guessing: an offline machine
 * reports "unknown", never "behind".
 *
 * Read-only outputs here are the source of truth for `--json`; the command
 * layer only formats them.
 */

import { spawn } from "node:child_process"
import {
  resolveSpawnBin,
  type AgentCliHandle,
  type AgentCliUpgrade,
  type AgentCliVersionCheck,
} from "@agentproto/driver-agent-cli"
import { compareVersions, freshnessVerdict } from "./freshness.js"
import { acpSmokeProbe, type SmokeProbeResult } from "./harness-probe.js"
import { listInstalledAdapters, resolveAdapter } from "./resolve.js"

/** Default bound for a single local/registry probe (`npm view`, one
 *  `version_check` run). A stalled probe reports `null` (unknown), never
 *  hangs the verb. */
const PROBE_TIMEOUT_MS = 10_000

/** Bound for the upgrade command itself — `npm i -g` on a cold cache can
 *  take minutes, and killing it mid-install is worse than waiting. */
const UPGRADE_CMD_TIMEOUT_MS = 5 * 60_000

/** First `x.y.z…` in a registry response (`npm view`, `tag_name`). */
const SEMVER_RE = /(\d+\.\d+\.\d+[^\s]*)/

/**
 * `bin_args` entry naming a pinned package: `pkg@1.2.3` or
 * `@scope/pkg@1.2.3` — exactly the `npx -y <pkg>@<x.y.z>` shape. The version
 * part must START with digits, so `pkg@latest` (a *channel*, not a pin) and
 * bare `pkg` both fail to match: only a real pin freezes what runs.
 */
const NPX_PIN_RE = /^((?:@[^/@]+\/)?[^/@]+)@(\d+\.\d+\.\d+.*)$/

// ── probes ────────────────────────────────────────────────────────────

export interface ExecResult {
  code: number | null
  stdout: string
}

/**
 * The I/O seam every harness operation goes through. `defaultHarnessProbes`
 * is the real thing (spawn + fetch); tests pass an object literal.
 */
export interface HarnessProbes {
  /** Run a command with captured stdout. `null` = spawn failed or timed out. */
  exec(
    cmd: string,
    args: readonly string[],
    opts?: { timeoutMs?: number },
  ): Promise<ExecResult | null>
  /** GET a JSON document. `null` = any failure (offline, 404, bad JSON). */
  fetchJson(url: string, opts?: { timeoutMs?: number }): Promise<unknown>
  /** Run a command with inherited stdio (the user sees the upgrade happen).
   *  `null` = spawn failed; otherwise the exit code. */
  run(
    cmd: string,
    args: readonly string[],
    opts?: { timeoutMs?: number },
  ): Promise<number | null>
}

function capture(
  cmd: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ExecResult | null> {
  return new Promise((resolve) => {
    let stdout = ""
    let settled = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "ignore"] })
    } catch {
      resolve(null)
      return
    }
    const done = (v: ExecResult | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      done(null)
    }, timeoutMs)
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8")
    })
    child.once("error", () => done(null))
    child.once("exit", (code) => done({ code, stdout }))
  })
}

function inherit(
  cmd: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, [...args], { stdio: "inherit" })
    } catch {
      resolve(null)
      return
    }
    const done = (v: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      done(null)
    }, timeoutMs)
    child.once("error", () => done(null))
    child.once("exit", (code) => done(code))
  })
}

export const defaultHarnessProbes: HarnessProbes = {
  exec: (cmd, args, opts) => capture(cmd, args, opts?.timeoutMs ?? PROBE_TIMEOUT_MS),
  async fetchJson(url, opts) {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "agentproto" },
        signal: AbortSignal.timeout(opts?.timeoutMs ?? PROBE_TIMEOUT_MS),
      })
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  },
  run: (cmd, args, opts) =>
    inherit(cmd, args, opts?.timeoutMs ?? UPGRADE_CMD_TIMEOUT_MS),
}

// ── version ranges ────────────────────────────────────────────────────

interface ParsedVersion {
  maj: number
  min: number
  patch: number
  pre: string
}

function parseVersion(raw: string): ParsedVersion | null {
  const m = raw.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+]([^\s]*))?/)
  if (!m) return null
  return {
    maj: Number(m[1]),
    min: m[2] === undefined ? 0 : Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
    pre: m[4] ?? "",
  }
}

/** Full semver ordering on the shape we parsed: numeric triples first, then
 *  prerelease (a release beats its own prereleases — `1.0.0 > 1.0.0-rc.1`). */
function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  const d = a.maj - b.maj || a.min - b.min || a.patch - b.patch
  if (d !== 0) return d
  if (a.pre === b.pre) return 0
  if (a.pre === "") return 1
  if (b.pre === "") return -1
  return a.pre < b.pre ? -1 : 1
}

const version = (maj: number, min: number, patch: number, pre = ""): ParsedVersion => ({
  maj,
  min,
  patch,
  pre,
})

/** One whitespace-separated range token → a boolean. `null` = the token
 *  isn't a range we understand (caller reports "unknown", never guesses). */
function evaluateToken(token: string, v: ParsedVersion): boolean | null {
  if (token === "*" || token === "x" || token === "X" || token === "latest") return true
  const m = token.match(/^(>=|<=|>|<|=|\^|~)?(\d+)(?:\.(\d+))?(?:\.(\d+))?([-+][^\s]*)?$/)
  if (!m) return null
  const op = m[1] ?? ""
  const maj = Number(m[2])
  const min = m[3] === undefined ? null : Number(m[3])
  const patch = m[4] === undefined ? null : Number(m[4])
  const pre = m[5] ?? ""
  const target = version(maj, min ?? 0, patch ?? 0, pre)

  const atLeast = (lo: ParsedVersion): boolean => compareParsed(v, lo) >= 0
  const below = (hi: ParsedVersion): boolean => compareParsed(v, hi) < 0

  if (op === ">=") return compareParsed(v, target) >= 0
  if (op === ">") return compareParsed(v, target) > 0
  if (op === "<=") return compareParsed(v, target) <= 0
  if (op === "<") return compareParsed(v, target) < 0

  if (op === "^") {
    // npm caret: first nonzero component opens the range.
    let upper: ParsedVersion
    if (maj > 0) upper = version(maj + 1, 0, 0)
    else if (min === null) upper = version(1, 0, 0)
    else if (min > 0) upper = version(0, min + 1, 0)
    else if (patch === null) upper = version(0, 1, 0)
    else upper = version(0, 0, patch + 1)
    return atLeast(target) && below(upper)
  }

  if (op === "~") {
    const upper = min === null ? version(maj + 1, 0, 0) : version(maj, min + 1, 0)
    return atLeast(target) && below(upper)
  }

  // `=x.y.z` exact, or a bare component range (`20`, `1.2`) per npm:
  // missing components open the next one up.
  if (patch !== null) return compareParsed(v, target) === 0
  if (min !== null) return atLeast(version(maj, min, 0)) && below(version(maj, min + 1, 0))
  return atLeast(version(maj, 0, 0)) && below(version(maj + 1, 0, 0))
}

/**
 * Is `latest` inside `range` (the adapter's `version_check.range`)?
 * Supports the subset AIP-45 manifests actually use — comparators,
 * `^`, `~`, bare partials, `*`, and `||` groups. `null` = "couldn't tell"
 * (unparseable version or a token this deliberately doesn't guess at), so
 * callers can refuse an upgrade instead of silently allowing it.
 */
export function versionInRange(versionRaw: string, range: string): boolean | null {
  const v = parseVersion(versionRaw)
  if (!v) return null
  const groups = range.split("||").map((g) => g.trim()).filter(Boolean)
  if (groups.length === 0) return true
  let sawUnknown = false
  for (const group of groups) {
    const tokens = group.split(/\s+/).filter(Boolean)
    let groupUnknown = false
    let satisfied = true
    for (const token of tokens) {
      const result = evaluateToken(token, v)
      if (result === null) {
        groupUnknown = true
        satisfied = false
        break
      }
      if (!result) {
        satisfied = false
        break
      }
    }
    if (satisfied) return true
    if (groupUnknown) sawUnknown = true
  }
  return sawUnknown ? null : false
}

// ── manifest slice ────────────────────────────────────────────────────

/**
 * The manifest fields every harness operation reads. A structural subset of
 * `AgentCliHandle` (plus the resolver's `slug`), so a handle is assignable
 * via {@link harnessManifest} and tests can write a literal.
 */
export interface HarnessManifest {
  slug: string
  protocol: string
  bin: string
  bin_args?: string[]
  env?: Record<string, string>
  version_check: AgentCliVersionCheck
  upgrade?: AgentCliUpgrade
}

export function harnessManifest(slug: string, handle: AgentCliHandle): HarnessManifest {
  return {
    slug,
    protocol: handle.protocol,
    bin: handle.bin,
    bin_args: handle.bin_args,
    env: handle.env,
    version_check: handle.version_check,
    upgrade: handle.upgrade,
  }
}

/** Bin + args + env the probe spawns — the same resolution
 *  `createAgentCliRuntime` applies (`bin: "node"` → this process's execPath,
 *  `npx`/`npm` → execPath sibling when present). */
export function probeTarget(m: HarnessManifest): {
  bin: string
  bin_args?: string[]
  env?: Record<string, string>
} {
  return {
    bin: resolveSpawnBin(m.bin),
    ...(m.bin_args ? { bin_args: m.bin_args } : {}),
    ...(m.env ? { env: m.env } : {}),
  }
}

// ── pin + latest + presence ───────────────────────────────────────────

export interface NpxPin {
  package: string
  version: string
}

/** The pinned `npx -y <pkg>@<x.y.z>` this adapter runs through, or `null`
 *  (not an npx bin, or no `@x.y.z` entry → nothing is frozen). */
export function parseNpxPin(
  bin: string | undefined,
  binArgs: readonly string[] | undefined,
): NpxPin | null {
  if (!bin) return null
  const base = (bin.split(/[\\/]/).pop() ?? bin).replace(/\.(cmd|exe|ps1)$/i, "")
  if (base !== "npx") return null
  for (const arg of binArgs ?? []) {
    const m = arg.match(NPX_PIN_RE)
    if (m && m[1] !== undefined && m[2] !== undefined) {
      return { package: m[1], version: m[2] }
    }
  }
  return null
}

export async function latestFromNpm(
  pkg: string,
  probes: HarnessProbes = defaultHarnessProbes,
): Promise<string | null> {
  const res = await probes.exec("npm", ["view", pkg, "version"])
  if (!res || res.code !== 0) return null
  return res.stdout.match(SEMVER_RE)?.[1] ?? null
}

export async function latestFromGithubRelease(
  repo: string,
  probes: HarnessProbes = defaultHarnessProbes,
): Promise<string | null> {
  const doc = await probes.fetchJson(`https://api.github.com/repos/${repo}/releases/latest`)
  if (typeof doc !== "object" || doc === null) return null
  const tag = "tag_name" in doc ? doc.tag_name : undefined
  if (typeof tag !== "string") return null
  const cleaned = tag.trim().replace(/^[vV]/, "")
  return /^\d/.test(cleaned) ? cleaned : null
}

/** Latest published version for an adapter's `upgrade.latest` declaration. */
export function resolveLatestVersion(
  spec: AgentCliUpgrade["latest"],
  probes: HarnessProbes = defaultHarnessProbes,
): Promise<string | null> {
  if ("npm" in spec) return latestFromNpm(spec.npm, probes)
  return latestFromGithubRelease(spec.githubRelease, probes)
}

/** Installed version from the adapter's `version_check` (a local `bash -lc`
 *  probe — presence, not freshness), or `null` when the check exits
 *  non-zero / times out / doesn't parse. */
export async function readInstalledVersion(
  m: HarnessManifest,
  probes: HarnessProbes = defaultHarnessProbes,
): Promise<string | null> {
  const timeoutMs = m.version_check.timeout_ms ?? PROBE_TIMEOUT_MS
  const res = await probes.exec("bash", ["-lc", m.version_check.cmd], { timeoutMs })
  if (!res || res.code !== 0) return null
  let re: RegExp
  try {
    re = new RegExp(m.version_check.parse)
  } catch {
    return null
  }
  const match = res.stdout.match(re)
  return match?.[1] ?? null
}

// ── outdated ──────────────────────────────────────────────────────────

export type HarnessStatus = "current" | "behind" | "pinned" | "unknown"

export interface HarnessOutdatedRow {
  slug: string
  /** Effective installed version. For a pinned `npx` harness that is the
   *  pin itself — what npx will actually run — since a global install of
   *  the same package is irrelevant to what spawns. */
  installed: string | null
  /** Latest published version, `null` when nothing could resolve it. */
  latest: string | null
  status: HarnessStatus
  /** `latest` against `version_check.range`; `null` when either side is
   *  unknown. Drives the upgrade refusal, never a silent allow. */
  inRange: boolean | null
  /** True when `harness upgrade <slug>` has something to act on: declared
   *  `upgrade`, known-behind, AND latest inside `version_check.range` (the
   *  same guard the upgrade applies — an out-of-range row needs a range
   *  bump first, not an upgrade). */
  upgradable: boolean
  pin?: NpxPin
  /** One-line human verdict (omitted when there's nothing to say). */
  note?: string
}

function noteFor(row: {
  status: HarnessStatus
  installed: string | null
  latest: string | null
  inRange: boolean | null
  range: string
  slug: string
  hasUpgrade: boolean
  pin?: NpxPin
}): string | undefined {
  const { status, installed, latest, inRange, range, slug, hasUpgrade, pin } = row
  if (pin) {
    if (latest === null) return "latest unresolvable (offline?)"
    if (inRange === false) return `pin is outside ${range} — bump the pin in adapters/${slug}`
    const cmp = compareVersions(pin.version, latest)
    if (Number.isNaN(cmp)) return `could not compare pin ${pin.version} against ${latest}`
    return cmp < 0 ? `pinned — bump the pin in adapters/${slug}` : "pin is current"
  }
  if (installed === null) return "not installed, or version_check failed"
  if (latest === null) return hasUpgrade ? "latest unresolvable (offline?)" : "no upgrade declared"
  if (status === "behind" && inRange === false)
    return `behind, but latest is outside ${range} — bump version_check.range first`
  if (status === "behind")
    return hasUpgrade ? `run \`agentproto harness upgrade ${slug}\`` : "behind, but no upgrade declared"
  return undefined
}

/**
 * One outdated row: pin rule first (read-only, always safe), otherwise the
 * adapter's `upgrade.latest` vs its local `version_check` presence probe.
 */
export async function buildHarnessRow(
  m: HarnessManifest,
  probes: HarnessProbes = defaultHarnessProbes,
): Promise<HarnessOutdatedRow> {
  const range = m.version_check.range
  const pin = parseNpxPin(m.bin, m.bin_args)
  if (pin) {
    const latest = await latestFromNpm(pin.package, probes)
    const inRange = latest === null ? null : versionInRange(latest, range)
    const note = noteFor({
      status: "pinned",
      installed: pin.version,
      latest,
      inRange,
      range,
      slug: m.slug,
      hasUpgrade: m.upgrade !== undefined,
      pin,
    })
    return {
      slug: m.slug,
      installed: pin.version,
      latest,
      status: "pinned",
      inRange,
      upgradable: false,
      pin,
      ...(note ? { note } : {}),
    }
  }

  const [installed, latest] = await Promise.all([
    readInstalledVersion(m, probes),
    m.upgrade ? resolveLatestVersion(m.upgrade.latest, probes) : Promise.resolve(null),
  ])
  const status = freshnessVerdict(installed, latest)
  const inRange = latest === null ? null : versionInRange(latest, range)
  // The same guard `upgradeHarness` applies: declared + known-behind, but
  // only when latest sits inside version_check.range (out-of-range needs a
  // range bump first — an upgrade attempt would just be refused).
  const upgradable =
    m.upgrade !== undefined && status === "behind" && inRange !== false
  const note = noteFor({
    status,
    installed,
    latest,
    inRange,
    range,
    slug: m.slug,
    hasUpgrade: m.upgrade !== undefined,
  })
  return {
    slug: m.slug,
    installed,
    latest,
    status,
    inRange,
    upgradable,
    ...(note ? { note } : {}),
  }
}

export interface CollectRowsOptions {
  probes?: HarnessProbes
  /** Defaults to the installed-adapter listing. */
  listSlugs?: () => Promise<Array<{ slug: string }>>
  /** Defaults to `resolveAdapter(slug).handle`. */
  resolveSlug?: (slug: string) => Promise<AgentCliHandle>
}

/** One row per installed adapter, sorted by slug. An adapter that fails to
 *  resolve degrades to an `unknown` row — never a crash of the whole verb. */
export async function collectHarnessRows(
  opts: CollectRowsOptions = {},
): Promise<HarnessOutdatedRow[]> {
  const probes = opts.probes ?? defaultHarnessProbes
  const listSlugs = opts.listSlugs ?? (() => listInstalledAdapters())
  const resolveSlug =
    opts.resolveSlug ?? (async (slug: string) => (await resolveAdapter(slug)).handle)
  const listed = await listSlugs()
  const rows = await Promise.all(
    listed.map(async ({ slug }) => {
      try {
        return await buildHarnessRow(harnessManifest(slug, await resolveSlug(slug)), probes)
      } catch (err) {
        return {
          slug,
          installed: null,
          latest: null,
          status: "unknown" as const,
          inRange: null,
          upgradable: false,
          note: `could not resolve adapter: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }),
  )
  return rows.sort((a, b) => a.slug.localeCompare(b.slug))
}

// ── upgrade ───────────────────────────────────────────────────────────

export type UpgradeOutcome =
  /** cmd ran, version re-read, and (for ACP) the smoke probe passed. */
  | "upgraded"
  /** `--dry-run`: printed the command, ran nothing. */
  | "dry-run"
  /** Already at the latest version — nothing to do, exit 0. */
  | "current"
  /** Deliberate non-action (no declaration, out of range, live sessions). */
  | "refused"
  /** Probe failed and the declared rollback restored the previous version. */
  | "rolled-back"
  /** Probe/upgrade failed and could NOT be undone — previous version named. */
  | "failed"

export interface UpgradeResult {
  slug: string
  outcome: UpgradeOutcome
  before: string | null
  after: string | null
  command?: string[]
  probe?: SmokeProbeResult
  reason?: string
  /** Free-form context, e.g. why a smoke probe was skipped. */
  note?: string
}

export interface UpgradeDeps {
  probes?: HarnessProbes
  /** Defaults to the real ACP smoke probe against `probeTarget(m)`. */
  smokeProbe?: (m: HarnessManifest) => Promise<SmokeProbeResult>
  /** True when the daemon reports a live session for this slug. */
  hasLiveSessions?: (slug: string) => Promise<boolean>
}

export interface UpgradeOptions {
  dryRun?: boolean
  /** Skip the range, compare, and live-session refusals. */
  force?: boolean
  deps?: UpgradeDeps
}

const realSmokeProbe = (m: HarnessManifest): Promise<SmokeProbeResult> =>
  acpSmokeProbe(probeTarget(m))

/**
 * Upgrade one harness: guard → run `upgrade.cmd` → re-read → ACP smoke
 * probe → rollback on any failure. Never throws.
 *
 * Guards (each a `refused` result with the reason, all bypassable with
 * `--force`): no `upgrade` declaration, unresolvable latest, unreadable
 * installed version, latest outside `version_check.range`, and live daemon
 * sessions on this adapter.
 */
export async function upgradeHarness(
  m: HarnessManifest,
  opts: UpgradeOptions = {},
): Promise<UpgradeResult> {
  const probes = opts.deps?.probes ?? defaultHarnessProbes
  const smokeProbe = opts.deps?.smokeProbe ?? realSmokeProbe
  const hasLiveSessions = opts.deps?.hasLiveSessions

  const refused = (reason: string, before: string | null = null): UpgradeResult => ({
    slug: m.slug,
    outcome: "refused",
    before,
    after: null,
    reason,
  })

  if (!m.upgrade) {
    const pin = parseNpxPin(m.bin, m.bin_args)
    return refused(
      pin
        ? `npx pin ${pin.package}@${pin.version} — bump the pin in adapters/${m.slug}`
        : "adapter declares no upgrade command",
    )
  }
  if (m.upgrade.cmd.length === 0) return refused("upgrade.cmd is empty")

  const before = await readInstalledVersion(m, probes)
  const latest = await resolveLatestVersion(m.upgrade.latest, probes)

  if (latest === null) return refused("could not resolve latest version (offline?)", before)
  if (before === null) {
    return refused(
      opts.force ? "could not read installed version (no rollback possible)" : "could not read installed version — pass --force to upgrade anyway",
      before,
    )
  }

  const status = freshnessVerdict(before, latest)
  if (status === "current") {
    return {
      slug: m.slug,
      outcome: "current",
      before,
      after: before,
      reason: `already at ${latest}`,
    }
  }
  if (status === "unknown" && !opts.force) {
    return refused(`could not compare installed ${before} against latest ${latest} — pass --force`, before)
  }

  const inRange = versionInRange(latest, m.version_check.range)
  if (inRange === false && !opts.force) {
    return refused(
      `latest ${latest} is outside ${m.version_check.range} — bump version_check.range (or pass --force)`,
      before,
    )
  }
  if (inRange === null && !opts.force) {
    return refused(`could not place ${latest} in ${m.version_check.range} — pass --force`, before)
  }

  if (!opts.force && hasLiveSessions) {
    const live = await hasLiveSessions(m.slug)
    if (live) return refused("live session(s) on this adapter — stop them or pass --force", before)
  }

  const command = [...m.upgrade.cmd]
  if (opts.dryRun) {
    return { slug: m.slug, outcome: "dry-run", before, after: null, command }
  }

  const cmdBin = command[0]
  if (cmdBin === undefined) return refused("upgrade.cmd is empty")
  const code = await probes.run(cmdBin, command.slice(1))
  if (code === null) return failed(`could not run ${cmdBin}`, before, null, command)
  if (code !== 0) return failed(`upgrade command exited ${code}`, before, null, command)

  const after = await readInstalledVersion(m, probes)
  const probe = m.protocol === "acp" ? await smokeProbe(m) : undefined
  const probeOk = probe === undefined || probe.ok
  const note = m.protocol === "acp" ? undefined : `protocol '${m.protocol}' — ACP smoke probe skipped (not ACP)`
  if (probeOk && after !== null) {
    return {
      slug: m.slug,
      outcome: "upgraded",
      before,
      after,
      command,
      ...(probe ? { probe } : {}),
      ...(note ? { note } : {}),
    }
  }

  const why =
    after === null && probe && !probe.ok
      ? `version_check failed after upgrade; smoke probe failed: ${probe.error ?? "unknown error"}`
      : after === null
        ? "version_check failed after upgrade"
        : `smoke probe failed: ${probe?.error ?? "unknown error"}`

  const rollback = m.upgrade.rollback
  if (!rollback || before === null) {
    return failed(
      `${why} — no rollback possible (${rollback ? "unreadable previous version" : "no rollback declared"}); previous version was ${before ?? "unknown"}`,
      before,
      after,
      command,
      probe,
    )
  }

  const rollbackCommand = rollback.map((arg) => arg.replaceAll("{version}", before))
  const rollbackBin = rollbackCommand[0]
  if (rollbackBin === undefined) {
    return failed(
      `${why} — rollback command is empty; previous version was ${before}`,
      before,
      after,
      rollbackCommand,
      probe,
    )
  }
  const rollbackCode = await probes.run(rollbackBin, rollbackCommand.slice(1))
  const restored = await readInstalledVersion(m, probes)
  if (rollbackCode === 0 && restored !== null) {
    return {
      slug: m.slug,
      outcome: "rolled-back",
      before,
      after: restored,
      command: rollbackCommand,
      ...(probe ? { probe } : {}),
      reason: `${why} — rolled back to ${restored}`,
    }
  }
  return failed(
    `${why} — rollback ${rollbackCode === 0 ? "left version_check failing" : `exited ${rollbackCode}`}; previous version was ${before}`,
    before,
    after,
    rollbackCommand,
    probe,
  )

  function failed(
    reason: string,
    fBefore: string | null,
    fAfter: string | null,
    fCommand: string[],
    fProbe?: SmokeProbeResult,
  ): UpgradeResult {
    return {
      slug: m.slug,
      outcome: "failed",
      before: fBefore,
      after: fAfter,
      command: fCommand,
      reason,
      ...(fProbe ? { probe: fProbe } : {}),
    }
  }
}

/** The default whole-probe bound, re-exported so callers (docs, the
 *  command layer) can state the same number the probe enforces. */
export { SMOKE_PROBE_TIMEOUT_MS } from "./harness-probe.js"
