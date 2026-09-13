/**
 * Read-only freshness probes — "is what's here the current published version?"
 *
 * Deliberately separate from PRESENCE (`version_check`, fixed in the
 * version-check-presence change): presence is a local probe; freshness is a
 * legitimate registry question, and `npm view <pkg> version` is exactly the
 * right tool for it. Nothing here writes: no installs, no config, no
 * `~/.agentproto`, no telemetry. Every probe degrades to `null` on any
 * failure (offline, slow registry, 404) — callers print nothing rather than
 * guessing.
 *
 * The `npm view` invocations here are the ones the presence fix relocated
 * out of the adapter manifests: the registry query was never the right
 * *presence* check, but it is exactly the right *freshness* check.
 */

import { spawn } from "node:child_process"

/** How long a single npm registry query may take. Bounded so a stalled
 *  registry can never hang the calling verb; on timeout we report `null`
 *  (unknown), never an error. */
const NPM_PROBE_TIMEOUT_MS = 10_000

/** Run a command, capture stdout, resolve `null` on any failure or timeout. */
function probeText(
  cmd: string,
  args: string[],
  timeoutMs = NPM_PROBE_TIMEOUT_MS
): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ""
    let settled = false
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] })
    const done = (v: string | null) => {
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
      out += c.toString("utf8")
    })
    child.once("error", () => done(null))
    child.once("exit", (code) => {
      done(code === 0 && out.trim() !== "" ? out : null)
    })
  })
}

/** Latest version of an npm package published to the registry, or `null`
 *  when offline / slow / package unknown. This is the freshness half of the
 *  old `npm view <pkg> version` version_check lines. */
export async function npmLatestVersion(
  pkg: string,
  timeoutMs = NPM_PROBE_TIMEOUT_MS
): Promise<string | null> {
  const out = await probeText("npm", ["view", pkg, "version"], timeoutMs)
  const m = out?.match(/(\d+\.\d+\.\d+[^\s]*)/)
  return m?.[1] ?? null
}

/** Version of an npm package installed in the GLOBAL tree, or `null` when
 *  it isn't there (or npm is unhappy). Reads `npm ls -g <pkg> --depth=0`,
 *  whose single package line ends in `@<version>`. Exit code 1 = absent —
 *  the same local probe the presence fix gave the `npm view` adapters. */
export async function npmInstalledVersion(
  pkg: string,
  timeoutMs = NPM_PROBE_TIMEOUT_MS
): Promise<string | null> {
  const out = await probeText("npm", ["ls", "-g", pkg, "--depth=0"], timeoutMs)
  if (out === null) return null
  // Line shape: `-- (empty)` on miss; on hit: `-- <pkg>@<version>` (plus
  // a first line with the global root). Take the version off the line
  // that actually names the package.
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const m = out.match(new RegExp(`${escaped}@(\\d+\\.[^\\s@]+)`))
  return m?.[1] ?? null
}

/** Plain semver-ish ordering for the two-version verdict. Full range
 *  semantics are deliberately out of scope: this answers "is the installed
 *  version the same as / older than the published one", which string
 *  component comparison handles for normal releases. Returns negative if
 *  `a` < `b`, 0 if equal, positive if `a` > `b`. Unparseable input sorts
 *  as unequal-but-unordered (compareVersion returns NaN → callers treat
 *  as "unknown"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(Number)
  const pb = b.split(/[.-]/).map(Number)
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return NaN
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** Freshness verdict for one thing that has a local and a published
 *  version. `null` on either side ⇒ "unknown" — never a false claim. */
export function freshnessVerdict(
  installed: string | null,
  latest: string | null
): "current" | "behind" | "unknown" {
  if (!installed || !latest) return "unknown"
  const cmp = compareVersions(installed, latest)
  if (Number.isNaN(cmp)) return "unknown"
  return cmp >= 0 ? "current" : "behind"
}

/** The `agentproto --version --check-updates` line: one human sentence
 *  comparing the running CLI version against the published `@agentproto/cli`.
 *  Returns `null` (print nothing) unless we positively know the running
 *  version is behind — a current version and an unresolvable registry both
 *  stay silent, so the flag can never nag on unrelated machines. */
export async function cliFreshnessLine(
  localVersion: string
): Promise<string | null> {
  const latest = await npmLatestVersion("@agentproto/cli")
  const verdict = freshnessVerdict(localVersion, latest)
  if (verdict !== "behind" || !latest) return null
  return (
    `agentproto: an update is available — installed ${localVersion}, ` +
    `published ${latest}. Update: npm i -g @agentproto/cli\n`
  )
}
