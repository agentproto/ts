/**
 * agents — which agent harnesses from the bundled catalog the daemon can
 * actually spawn here.
 *
 * The adapter's `version_check` is an INSTALL-presence probe (what
 * `agentproto install` checks), which is not the same question: an adapter
 * spawned as `npx -y <bridge>@<pin>` (claude-code, codex, mastracode) runs
 * fine with nothing installed globally — npx fetches the pinned bridge on
 * first spawn. So for those, doctor checks what the spawn needs instead:
 * `npx` on PATH, the pinned package (cached or not), and the harness's own
 * CLI where the bridge drives one (`claude`, `codex`). Everything else keeps
 * the `version_check` probe; a probe that runs `node`/`npm`/`npx` rather
 * than the harness's own binary reports "available", never its version.
 */

import { join } from "node:path"
import type { AgentCliHandle } from "@agentproto/driver-agent-cli"
import { catalogByType } from "../../registry/catalog.js"
import { interpretVersionCheck } from "../../commands/install.js"
import { fetchHealth } from "../../commands/daemon.js"
import type { OnboardingStep, StepCheck, StepContext } from "../types.js"
import { readManifestVersion } from "./_util.js"

const PROBE_TIMEOUT_MS = 8_000

/** Harness CLIs an npx-spawned bridge drives (login, credentials). Missing
 *  one leaves the bridge spawnable but not really usable ⇒ `warn`. */
const COMPANION_CLIS: Readonly<Record<string, { bin: string; install: string }>> = {
  "claude-code": { bin: "claude", install: "npm i -g @anthropic-ai/claude-code" },
  codex: { bin: "codex", install: "npm i -g @openai/codex" },
}

/** Probes that run a toolchain binary, not the harness's own — their
 *  version says nothing about the harness. */
const TOOLCHAIN_PROBES = new Set(["node", "npm", "npx"])

type Handle = Pick<AgentCliHandle, "version_check" | "bin" | "bin_args">

type Presence =
  | { slug: string; name: string; state: "usable"; status: "ok" | "warn"; detail: string; version: string | null; fix?: string }
  | { slug: string; name: string; state: "stalePath"; resolved: string }
  | { slug: string; name: string; state: "absent" | "unresolvable" }

const SEMVER = /(\d+\.\d+\.\d+[^\s)]*)/

/**
 * Recap B4 (doctor detects a stale daemon PATH): when a harness binary is
 * installed in the user's login shell but the running daemon's PATH (captured
 * at daemon start) lost that directory, the spawn will fail `ENOENT` even
 * though every CLI-side probe says "installed". The diagnosis runs only when
 * the daemon is up AND its /health carries the `path` field (older daemons
 * omit it) AND the login-shell probe resolves the binary — anything less and
 * there is nothing compared, so we fall back to the plain "absent" verdict.
 * Pure: (dirList, resolved) both strings — trivially unit-testable.
 */
export function isStaleDaemonPath(
  daemonPath: string | null | undefined,
  shellResolved: string | null,
): boolean {
  if (!daemonPath || !shellResolved) return false
  const dirs = daemonPath.split(":")
  const parent = shellResolved.replace(/[/\\][^/\\]+$/, "")
  return !dirs.includes(parent)
}

export function stalePathHint(slug: string, resolved: string): string {
  const bin = slug
  return (
    `${bin} is installed in your login shell (${resolved}) but not visible to the daemon ` +
    `(PATH captured at daemon start) — run \`agentproto daemon restart\``
  )
}

/** Detect the shell-side install of an absent adapter (recap B4). Returns the
 *  resolved binary path, or null. Never throws; never crosses the daemon. */
async function shellProbe(ctx: StepContext, slug: string): Promise<string | null> {
  const [execCmd, execArgs]: [string, string[]] =
    ctx.platform === "win32" ? ["cmd", ["/c", `where ${slug}`]] : ["bash", ["-lc", `command -v ${slug}`]]
  const out = await ctx.exec(execCmd, execArgs, { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null)
  if (!out || out.code !== 0) return null
  const line = out.stdout.trim().split(/\r?\n/)[0]
  return line || null
}

function firstToken(cmd: string): string {
  return cmd.trim().split(/\s+/)[0] ?? ""
}

/** `@scope/name@1.2.3` / `name` → name + optional pinned version. */
export function parseNpxPackage(args: readonly string[]): { name: string; version: string | null } | null {
  const spec = args.find((a) => !a.startsWith("-"))
  if (!spec) return null
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0)
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) || null } : { name: spec, version: null }
}

async function runVersionCheck(ctx: StepContext, check: Handle["version_check"]): Promise<string | null> {
  const out = await ctx.exec("bash", ["-lc", check.cmd], { timeoutMs: check.timeout_ms ?? PROBE_TIMEOUT_MS })
  const verdict = interpretVersionCheck(check, out.code, out.stdout)
  return verdict.ok ? verdict.message.replace(/^version /, "") : null
}

/** First semver printed by `<bin> --version`, or `null` when not on PATH. */
async function cliVersion(ctx: StepContext, bin: string): Promise<string | null> {
  const out = await ctx.exec("bash", ["-lc", `${bin} --version`], { timeoutMs: PROBE_TIMEOUT_MS })
  if (out.code !== 0) return null
  return out.stdout.match(SEMVER)?.[1] ?? null
}

/** Versions of `name` sitting in npx's cache (`<npm cache>/_npx/<hash>/node_modules/<name>`). */
async function npxCachedVersions(ctx: StepContext, name: string): Promise<string[]> {
  const cacheRoot = join(ctx.env.npm_config_cache ?? join(ctx.homedir, ".npm"), "_npx")
  let entries: string[]
  try {
    entries = await ctx.fs.readdir(cacheRoot)
  } catch {
    return []
  }
  const versions = await Promise.all(
    entries.map((e) => readManifestVersion(ctx, join(cacheRoot, e, "node_modules", name, "package.json"))),
  )
  return versions.filter((v): v is string => v !== null)
}

async function probeNpx(
  ctx: StepContext,
  slug: string,
  name: string,
  handle: Handle,
): Promise<Presence> {
  const pkg = parseNpxPackage(handle.bin_args ?? [])
  const npx = await ctx.exec("bash", ["-lc", "command -v npx"], { timeoutMs: PROBE_TIMEOUT_MS })
  if (!pkg || npx.code !== 0) return { slug, name, state: "absent" }

  const cached = await npxCachedVersions(ctx, pkg.name)
  const label = pkg.name.includes("acp") ? "ACP bridge" : pkg.name
  const where = pkg.version
    ? `${label} via npx (v${pkg.version}, ${cached.includes(pkg.version) ? "cached" : "fetched on first spawn"})`
    : `${label} via npx (${cached.length > 0 ? "cached" : "fetched on first spawn"})`

  const companion = COMPANION_CLIS[slug]
  if (!companion) {
    return { slug, name, state: "usable", status: "ok", detail: where, version: pkg.version }
  }
  const version = await cliVersion(ctx, companion.bin)
  return version === null
    ? {
        slug,
        name,
        state: "usable",
        status: "warn",
        detail: `${where}, but \`${companion.bin}\` is not on PATH`,
        version: null,
        fix: companion.install,
      }
    : { slug, name, state: "usable", status: "ok", detail: `${companion.bin} ${version} · ${where}`, version }
}

async function probeAdapter(ctx: StepContext, slug: string, name: string): Promise<Presence> {
  let handle: Handle
  try {
    handle = await ctx.sources.resolveAdapterHandle(slug)
  } catch {
    return { slug, name, state: "unresolvable" }
  }
  // Runs inside the daemon from the adapter package itself: resolvable ⇒ spawnable.
  if (handle.bin === "in-process") {
    return { slug, name, state: "usable", status: "ok", detail: "available (in-process)", version: null }
  }
  const check = handle.version_check
  const ownProbe = !TOOLCHAIN_PROBES.has(firstToken(check.cmd))
  // npx adapters whose presence probe is a toolchain query (`npm ls -g …`)
  // are judged by what the npx spawn needs, not by a global install.
  if (handle.bin === "npx" && !ownProbe) return probeNpx(ctx, slug, name, handle)

  const version = await runVersionCheck(ctx, check)
  if (version !== null) {
    return ownProbe
      ? { slug, name, state: "usable", status: "ok", detail: `v${version}`, version }
      : { slug, name, state: "usable", status: "ok", detail: "available", version: null }
  }
  // Harness binary absent, but an npx adapter can still fetch it on spawn.
  return handle.bin === "npx" ? probeNpx(ctx, slug, name, handle) : { slug, name, state: "absent" }
}

export const agentsStep: OnboardingStep = {
  id: "agents",
  title: "Agent harnesses",
  required: true,
  // Fans out a few local probes per catalog adapter (login shell,
  // `--version`s), run in parallel.
  timeoutMs: 20_000,
  async detect(ctx) {
    const entries = catalogByType("agent-cli")
    const results = await Promise.all(entries.map((e) => probeAdapter(ctx, e.slug, e.name)))

    // Recap B4: an absent adapter may actually be installed in the user's
    // shell, invisible to the daemon's start-time PATH. Only when something
    // probed absent, the daemon answers /health, and /health carries its
    // PATH does this extra comparison run (never probed on a dead daemon).
    const plainlyAbsent = results.filter((r) => r.state === "absent")
    if (plainlyAbsent.length > 0) {
      const config = await ctx.sources.loadConfig().catch(() => null)
      const health = await fetchHealth({ config: config ?? undefined, fetchImpl: ctx.fetch }).catch(() => null)
      if (config && health) {
        for (const r of plainlyAbsent) {
          const resolved = await shellProbe(ctx, r.slug)
          if (resolved && isStaleDaemonPath(health.path, resolved)) {
            results[results.indexOf(r)] = { slug: r.slug, name: r.name, state: "stalePath", resolved }
          }
        }
      }
    }

    const absent = results.filter((r) => r.state === "absent").map((r) => r.slug)
    const unresolvable = results.filter((r) => r.state === "unresolvable").map((r) => r.slug)

    const checks: StepCheck[] = []
    for (const r of results) {
      if (r.state === "stalePath") {
        checks.push({
          id: `agents.${r.slug}`,
          title: r.name,
          status: "warn",
          detail: stalePathHint(r.slug, r.resolved),
          fix: "agentproto daemon restart",
          data: { slug: r.slug, version: null },
        })
        continue
      }
      if (r.state !== "usable") continue
      checks.push({
        id: `agents.${r.slug}`,
        title: r.name,
        status: r.status,
        detail: r.detail,
        ...(r.fix ? { fix: r.fix } : {}),
        data: { slug: r.slug, version: r.version },
      })
    }
    const anythingFound = checks.some(
      (c) => c.status === "ok" || c.status === "warn",
    )
    if (!anythingFound) {
      checks.push({
        id: "agents.none",
        title: "Agent harnesses",
        status: "missing",
        detail: "no agent harness installed",
        fix: "agentproto install claude-code",
        data: { notInstalled: absent, unresolvable },
      })
    } else if (absent.length > 0) {
      checks.push({
        id: "agents.not-installed",
        title: "Not installed",
        status: "skipped",
        detail: absent.join(", "),
        data: { notInstalled: absent, unresolvable },
      })
    }
    return checks
  },
  async plan(checks) {
    const summary = checks.find((c) => c.id === "agents.not-installed" || c.id === "agents.none")
    const notInstalled = stringList(summary?.data?.notInstalled)
    const unresolvable = new Set(stringList(summary?.data?.unresolvable))
    const candidates = catalogByType("agent-cli").filter(
      (e) => notInstalled.includes(e.slug) && !unresolvable.has(e.slug),
    )
    if (candidates.length === 0) return []
    const working = checks.some(
      (c) => c.id !== "agents.none" && c.id !== "agents.not-installed" && (c.status === "ok" || c.status === "warn"),
    )
    const choices = candidates.map((e) => ({
      value: e.slug,
      label: e.name,
      ...(e.hint ? { hint: e.hint } : {}),
      default: !working && e.slug === "claude-code",
    }))
    return [
      {
        id: "agents.install",
        title: "Install agent harnesses",
        default: choices.some((c) => c.default),
        choices,
        streamsOutput: true,
        async apply(io, selected = []) {
          const failed: string[] = []
          for (const slug of selected) {
            if ((await io.verbs.install([slug])) !== 0) failed.push(slug)
          }
          return failed.length === 0
            ? { ok: true, detail: `installed ${selected.join(", ")}` }
            : { ok: false, detail: `failed: ${failed.join(", ")}` }
        },
      },
    ]
  },
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
}
