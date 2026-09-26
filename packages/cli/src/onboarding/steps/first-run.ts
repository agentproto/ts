/**
 * first-run (setup only) — the proof it works: spawn the best available
 * harness on the daemon, run one short prompt, stream the reply, stop the
 * session. `detect` only reads the setup ledger, so a passed test isn't
 * re-offered on every `setup`.
 */

import { DEFAULT_PORT } from "../../commands/install-mcp.js"
import { onboardingLedgerPath, parseOnboardingLedger } from "../ledger.js"
import type { OnboardingStep, StepCheck } from "../types.js"
import { agentsStep } from "./agents.js"
import { readText } from "./_util.js"

export const FIRST_RUN_PROMPT = "Say hello and list the agentproto tools you can see, in 3 lines."
export const CONTROL_CENTER_APP = "@agentik/session-chat"
const PANEL_APP = "@agentproto/sessions-panel"

/** Most-capable-first; the first usable one is the test harness. */
const PREFERRED_HARNESSES = ["claude-code", "codex", "opencode", "gemini", "claude-sdk", "grok-cli", "hermes", "pi"]

export function pickHarness(agentChecks: readonly StepCheck[]): string | null {
  const usable = agentChecks
    .filter((c) => c.status === "ok" && c.id !== "agents.none" && c.id !== "agents.not-installed")
    .map((c) => c.id.slice("agents.".length))
  return PREFERRED_HARNESSES.find((s) => usable.includes(s)) ?? usable[0] ?? null
}

export const firstRunStep: OnboardingStep = {
  id: "first-run",
  title: "First run",
  required: false,
  async detect(ctx) {
    const ledger = parseOnboardingLedger(await readText(ctx, onboardingLedgerPath(ctx.homedir)), "")
    const entry = ledger.steps["first-run"]
    return entry?.status === "ok"
      ? [{ id: "first-run.session", title: "Test session", status: "ok", detail: `passed ${entry.at}` }]
      : [{ id: "first-run.session", title: "Test session", status: "warn", detail: "not run yet" }]
  },
  async plan(checks, ctx, previous) {
    if (checks.every((c) => c.status === "ok")) return []
    const agentChecks = previous.get("agents") ?? (await agentsStep.detect(ctx))
    const harness = pickHarness(agentChecks)
    if (!harness) return []
    const port = (await ctx.sources.loadConfig()).daemon?.port ?? DEFAULT_PORT
    return [
      {
        id: "first-run.session",
        title: `Run a 20-second test session on ${harness}`,
        default: true,
        streamsOutput: true,
        async apply(io) {
          io.log.step(`${harness} › ${FIRST_RUN_PROMPT}`)
          const result = await io.verbs.firstRun(harness, FIRST_RUN_PROMPT, (line) => io.log.message(line))
          const app = io.verbs.appInstalled(CONTROL_CENTER_APP) ? CONTROL_CENTER_APP : PANEL_APP
          const url = `http://127.0.0.1:${port}/apps/${app}/ui`
          return result.ok
            ? { ok: true, detail: `session ran and closed — watch sessions at ${url}`, notes: [`Control Center: ${url}`] }
            : { ok: false, detail: result.error ?? "the test session failed" }
        },
      },
    ]
  },
}
