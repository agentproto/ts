/**
 * preflight — can agentproto run here at all: Node version, OS, CLI
 * freshness, and a usable `~/.agentproto`.
 */

import { constants } from "node:fs"
import { join } from "node:path"
import { compareVersions } from "@agentproto/runtime/release-check"
import type { OnboardingStep, StepCheck, StepContext } from "../types.js"
import { pathExists, tildify } from "./_util.js"

/** `engines.node` of `@agentproto/cli`. */
export const MIN_NODE_VERSION = "20.9.0"

const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "linux"]

function checkNode(ctx: StepContext): StepCheck {
  const version = ctx.nodeVersion.replace(/^v/, "")
  const cmp = compareVersions(version, MIN_NODE_VERSION)
  const data = { version, required: `>=${MIN_NODE_VERSION}` }
  if (Number.isNaN(cmp)) {
    return {
      id: "preflight.node",
      title: "Node.js",
      status: "warn",
      detail: `could not parse node -v output "${ctx.nodeVersion}" (the raw version found — is the node on PATH a shim?)`,
      data,
    }
  }
  return cmp >= 0
    ? { id: "preflight.node", title: "Node.js", status: "ok", detail: `v${version} (>= ${MIN_NODE_VERSION})`, data }
    : {
        id: "preflight.node",
        title: "Node.js",
        status: "broken",
        detail: `v${version} is older than the required ${MIN_NODE_VERSION}`,
        fix: `install Node.js 20.9 or newer (Node 22 LTS is the known-good choice: https://nodejs.org)`,
        data,
      }
}

function checkPlatform(ctx: StepContext): StepCheck {
  const label = `${ctx.platform}/${ctx.arch}`
  const data = { platform: ctx.platform, arch: ctx.arch }
  return SUPPORTED_PLATFORMS.includes(ctx.platform)
    ? { id: "preflight.os", title: "Operating system", status: "ok", detail: label, data }
    : { id: "preflight.os", title: "Operating system", status: "warn", detail: `${label} is not a tested platform (darwin, linux)`, data }
}

async function checkCliVersion(ctx: StepContext): Promise<StepCheck> {
  const latest = await ctx.sources.latestCliVersion().catch(() => null)
  const data = { installed: ctx.cliVersion, latest }
  if (latest === null) {
    return { id: "preflight.cli-version", title: "CLI version", status: "warn", detail: `${ctx.cliVersion} (could not check npm for updates)`, data }
  }
  const cmp = compareVersions(latest, ctx.cliVersion)
  if (!Number.isNaN(cmp) && cmp > 0) {
    return {
      id: "preflight.cli-version",
      title: "CLI version",
      status: "warn",
      detail: `${ctx.cliVersion}, v${latest} available`,
      fix: "npm i -g @agentproto/cli",
      data,
    }
  }
  return { id: "preflight.cli-version", title: "CLI version", status: "ok", detail: `${ctx.cliVersion} (latest)`, data }
}

/**
 * Which `agentproto` is running this wizard. A published `npm i -g` install
 * is fine; a **workspace/monorepo build** is not, because `agentproto daemon
 * install` bakes the CLI entry into the service — so the daemon would be
 * installed from a local folder (a `dist/` path) instead of npm. Flag it with
 * the npm install, never a local copy.
 */
function checkCliSource(ctx: StepContext): StepCheck | null {
  const { source, entry } = ctx.sources.cliInstallSource()
  if (source !== "workspace") return null
  return {
    id: "preflight.cli-source",
    title: "CLI install source",
    status: "warn",
    detail:
      `this agentproto is a workspace build (${entry ? tildify(ctx, entry) : "?"}), not the npm install — ` +
      `\`agentproto daemon install\` would run that local folder`,
    fix: "npm i -g @agentproto/cli@latest",
    data: { source, entry },
  }
}

async function checkHomeDir(ctx: StepContext): Promise<StepCheck> {
  const dir = join(ctx.homedir, ".agentproto")
  const shown = tildify(ctx, dir)
  const data = { path: dir }
  if (!(await pathExists(ctx, dir))) {
    return { id: "preflight.home", title: "State directory", status: "warn", detail: `${shown} does not exist yet (created on first use)`, data }
  }
  try {
    await ctx.fs.access(dir, constants.W_OK)
    return { id: "preflight.home", title: "State directory", status: "ok", detail: `${shown} is writable`, data }
  } catch {
    return {
      id: "preflight.home",
      title: "State directory",
      status: "broken",
      detail: `${shown} is not writable`,
      fix: `chown -R "$(whoami)" ${shown}`,
      data,
    }
  }
}

export const preflightStep: OnboardingStep = {
  id: "preflight",
  title: "Preflight",
  required: true,
  async detect(ctx) {
    const checks = [checkNode(ctx), checkPlatform(ctx), await checkCliVersion(ctx), await checkHomeDir(ctx)]
    const source = checkCliSource(ctx)
    if (source) checks.push(source)
    return checks
  },
  stopIf(checks) {
    const blocker = checks.find(
      (c) => (c.id === "preflight.node" || c.id === "preflight.home") && c.status === "broken",
    )
    return blocker ? `${blocker.title}: ${blocker.detail ?? "broken"}${blocker.fix ? ` — ${blocker.fix}` : ""}` : null
  },
  async plan(checks) {
    const cli = checks.find((c) => c.id === "preflight.cli-version")
    const source = checks.find((c) => c.id === "preflight.cli-source")
    const outdated = cli?.status === "warn" && Boolean(cli.fix)
    const localBuild = source?.status === "warn"
    if (!outdated && !localBuild) return []
    const why = localBuild
      ? "Replace this workspace build with the published CLI (npm i -g @agentproto/cli@latest)"
      : "Update the CLI (npm i -g @agentproto/cli@latest)"
    return [
      {
        id: "preflight.update-cli",
        title: why,
        default: false,
        streamsOutput: true,
        async apply(io) {
          const code = await io.verbs.updateCli()
          return code === 0
            ? { ok: true, detail: "installed from npm — re-run `agentproto setup` to continue on the published CLI" }
            : { ok: false, detail: `npm exited ${code}` }
        },
      },
    ]
  },
}
