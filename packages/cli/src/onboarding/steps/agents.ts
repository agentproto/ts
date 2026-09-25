/**
 * agents — which agent harnesses from the bundled catalog are usable here:
 * the adapter package resolves AND the adapter's own `version_check`
 * presence probe (the one `agentproto install` uses) passes.
 */

import { catalogByType } from "../../registry/catalog.js"
import { interpretVersionCheck } from "../../commands/install.js"
import type { OnboardingStep, StepCheck, StepContext } from "../types.js"

const PROBE_TIMEOUT_MS = 8_000

type Presence =
  | { slug: string; name: string; state: "installed"; version: string }
  | { slug: string; name: string; state: "absent" }
  | { slug: string; name: string; state: "unresolvable" }

async function probeAdapter(ctx: StepContext, slug: string, name: string): Promise<Presence> {
  let check
  try {
    check = (await ctx.sources.resolveAdapterHandle(slug)).version_check
  } catch {
    return { slug, name, state: "unresolvable" }
  }
  const out = await ctx.exec("bash", ["-lc", check.cmd], { timeoutMs: check.timeout_ms ?? PROBE_TIMEOUT_MS })
  const verdict = interpretVersionCheck(check, out.code, out.stdout)
  return verdict.ok
    ? { slug, name, state: "installed", version: verdict.message.replace(/^version /, "") }
    : { slug, name, state: "absent" }
}

export const agentsStep: OnboardingStep = {
  id: "agents",
  title: "Agent harnesses",
  required: true,
  // Fans out one local presence probe per catalog adapter (login shell +
  // e.g. `npm ls -g`), run in parallel.
  timeoutMs: 20_000,
  async detect(ctx) {
    const entries = catalogByType("agent-cli")
    const results = await Promise.all(entries.map((e) => probeAdapter(ctx, e.slug, e.name)))
    const installed = results.filter((r) => r.state === "installed")
    const absent = results.filter((r) => r.state !== "installed").map((r) => r.slug)
    const unresolvable = results.filter((r) => r.state === "unresolvable").map((r) => r.slug)

    const checks: StepCheck[] = installed.map((r) => ({
      id: `agents.${r.slug}`,
      title: r.name,
      status: "ok",
      detail: `v${r.version}`,
      data: { slug: r.slug, version: r.version },
    }))
    if (installed.length === 0) {
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
}
