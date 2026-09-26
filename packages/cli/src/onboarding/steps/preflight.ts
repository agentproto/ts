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
    return { id: "preflight.node", title: "Node.js", status: "warn", detail: `could not parse version "${ctx.nodeVersion}"`, data }
  }
  return cmp >= 0
    ? { id: "preflight.node", title: "Node.js", status: "ok", detail: `v${version} (>= ${MIN_NODE_VERSION})`, data }
    : {
        id: "preflight.node",
        title: "Node.js",
        status: "broken",
        detail: `v${version} is older than the required ${MIN_NODE_VERSION}`,
        fix: "install Node.js 20.9 or newer (https://nodejs.org)",
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
    return [checkNode(ctx), checkPlatform(ctx), await checkCliVersion(ctx), await checkHomeDir(ctx)]
  },
  stopIf(checks) {
    const blocker = checks.find(
      (c) => (c.id === "preflight.node" || c.id === "preflight.home") && c.status === "broken",
    )
    return blocker ? `${blocker.title}: ${blocker.detail ?? "broken"}${blocker.fix ? ` — ${blocker.fix}` : ""}` : null
  },
  async plan(checks) {
    const cli = checks.find((c) => c.id === "preflight.cli-version")
    if (cli?.status !== "warn" || !cli.fix) return []
    return [
      {
        id: "preflight.update-cli",
        title: "Update the CLI (npm i -g @agentproto/cli@latest)",
        default: false,
        streamsOutput: true,
        async apply(io) {
          const code = await io.verbs.updateCli()
          return code === 0
            ? { ok: true, detail: "updated — re-run `agentproto setup` to continue on the new version" }
            : { ok: false, detail: `npm exited ${code}` }
        },
      },
    ]
  },
}
