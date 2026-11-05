/**
 * Sandbox preflight probes: cheap checks that run against a freshly booted
 * box BEFORE the agent starts, so a placement that cannot work is discovered
 * in seconds instead of mid-run.
 *
 * Motivating failure: OpenCode's free tier is capped per SOURCE IP, and fleet
 * boxes can share one egress IP, so a box booted on an exhausted address
 * answers its first model call with "Free usage limit reached" and the run
 * dies. Asking the box to answer one line first turns that into a typed
 * spawn failure (`sandbox_preflight_failed`) a caller can act on.
 *
 * A probe is an `id` plus a `run(ctx)` that reaches the box through the same
 * exec seam `sandbox_exec` uses (`BootedSandbox.exec`). It answers one of:
 *   - `ok`      the box passes this check;
 *   - `ko`      the box demonstrably cannot do the thing (carries the
 *               {@link TurnErrorClass} from `classifyTurnError`, so a probe and
 *               a live turn speak the same classes);
 *   - `unknown` the probe could not decide (timeout, missing binary, provider
 *               without exec, unclassified failure). NEVER treated as `ko`:
 *               a probe that cannot run must not veto a placement.
 *
 * Probes live in a registry keyed by id, so a new criterion is an addition,
 * not an edit. {@link runSandboxPreflight} runs a list of ids in order and
 * stops at the first `ko`; the spawn path (`bootSandboxAgentSession`) tears
 * the box down on that and fails with {@link preflightFailedResult}. The
 * outcome list and the failure details are plain data on purpose: a placement
 * ladder can run the same probes, read the same `outcomes`, and move to the
 * next rung on `sandbox_preflight_failed` without reshaping any of this.
 */

import type { SandboxExecOpts, SandboxExecResult } from "@agentproto/sandbox"
import { classifyTurnError, type TurnErrorClass } from "./turn-retry.js"

export type PreflightVerdict = "ok" | "ko" | "unknown"

/** What a probe reports about one box. */
export interface PreflightResult {
  verdict: PreflightVerdict
  /** Set on `ko`: the class `classifyTurnError` gave the failure text. */
  errorClass?: TurnErrorClass
  /** One human-readable line (bounded); never a secret. */
  detail: string
  durationMs: number
}

/** A probe's result tagged with the probe that produced it. */
export interface PreflightOutcome extends PreflightResult {
  probe: string
}

/** What a probe may touch. Everything is optional-by-capability except `exec`. */
export interface PreflightContext {
  /** Run one command in the box: `BootedSandbox.exec`, i.e. what `sandbox_exec` calls. */
  exec: (opts: SandboxExecOpts) => Promise<SandboxExecResult>
  /** The adapter slug the session will run (`opencode`, `claude-code`, ...). */
  adapter: string
  /** The model the session will use, when the spawn named one. */
  model?: string
  /** A directory that exists in the box (the provider's home), when known. */
  cwd?: string
  /** Public source address the box egresses from, when the provider brokers one. */
  egressIp?: string
  /** Wall-clock budget for this probe; the runner enforces it too. */
  timeoutMs: number
}

/**
 * When a probe can run, relative to the agent's own `agent_start`.
 *
 * - `prelaunch` runs before the agent starts, through `host.exec`, and needs
 *   no credentials (a package is installed, an address is not capped for
 *   everyone). It always runs, authed spawn or not.
 * - `postlaunch` needs the session's credentials, which reach the box only
 *   through its own `agent_start`, so it can only run through the started
 *   session (see the seam comment in `session-spawn.ts`).
 */
export type PreflightPhase = "prelaunch" | "postlaunch"

export interface PreflightProbe {
  id: string
  description: string
  /** Hard budget in ms when the caller does not override it. */
  defaultTimeoutMs: number
  /** When the probe can run; defaults to `prelaunch`. */
  phase?: PreflightPhase
  run(ctx: PreflightContext): Promise<Omit<PreflightResult, "durationMs">>
}

export interface PreflightRegistry {
  register(probe: PreflightProbe): void
  get(id: string): PreflightProbe | undefined
  list(): PreflightProbe[]
}

export function createPreflightRegistry(probes: readonly PreflightProbe[] = []): PreflightRegistry {
  const byId = new Map<string, PreflightProbe>()
  for (const probe of probes) byId.set(probe.id, probe)
  return {
    register(probe) {
      byId.set(probe.id, probe)
    },
    get: id => byId.get(id),
    list: () => [...byId.values()],
  }
}

export const MODEL_ANSWERS_PROBE_ID = "model-answers"
/** Default budget for `model-answers`: a cold harness start plus one model round trip. */
export const MODEL_ANSWERS_TIMEOUT_MS = 90_000
const MODEL_ANSWERS_PROMPT = "reply ok"
const DETAIL_MAX = 300
/** Model ids reach a shell command line: anything outside this set is not probed. */
const SAFE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/** Credential-shaped text in box output: bearer headers, `key=value` secrets, vendor-prefixed keys, long opaque tokens. */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\b([A-Za-z0-9_-]*(?:api[_-]?key|token|secret|passw(?:or)?d|authorization|credential)[A-Za-z0-9_-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1$2[redacted]"],
  [/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA)[-_]?[A-Za-z0-9_-]{12,}/g, "[redacted]"],
  [/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]"],
]

/** Box output leaves the daemon in an error body: scrub credential-shaped text first. */
export const redactProbeText = (text: string): string =>
  SECRET_PATTERNS.reduce((out, [re, to]) => out.replace(re, to), text)

const clip = (text: string): string => {
  const flat = redactProbeText(text.replace(/\s+/g, " ").trim())
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX)}...` : flat
}

/**
 * One-line prompt command per adapter, run INSIDE the box: the free models of
 * a harness only answer from within that harness. Adding a harness is adding
 * a row; an adapter without a row yields `unknown`, never `ko`.
 */
const ONE_LINE_PROMPT_COMMANDS: Record<string, (model: string | undefined) => string> = {
  opencode: model =>
    `opencode run ${model ? `-m ${shellQuote(model)} ` : ""}${shellQuote(MODEL_ANSWERS_PROMPT)} < /dev/null`,
}

/**
 * Does the model, as reached from THIS box (its egress IP included), answer a
 * one-line prompt? Failure text goes through `classifyTurnError`; only a
 * classified failure is `ko` (usage cap, rate limit, 5xx, auth). Everything
 * else that goes wrong is `unknown`.
 */
export const modelAnswersProbe: PreflightProbe = {
  id: MODEL_ANSWERS_PROBE_ID,
  description: "The session's model answers a one-line prompt through its harness from inside the box.",
  defaultTimeoutMs: MODEL_ANSWERS_TIMEOUT_MS,
  phase: "postlaunch",
  async run(ctx) {
    const build = ONE_LINE_PROMPT_COMMANDS[ctx.adapter]
    if (!build) {
      return { verdict: "unknown", detail: `no one-line prompt command known for adapter "${ctx.adapter}"` }
    }
    if (ctx.model !== undefined && !SAFE_MODEL_RE.test(ctx.model)) {
      return { verdict: "unknown", detail: `model id "${clip(ctx.model)}" is not probeable` }
    }
    const res = await ctx.exec({
      command: build(ctx.model),
      ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
      timeoutMs: ctx.timeoutMs,
    })
    const text = `${res.stderr}\n${res.stdout}`
    const answered = res.exitCode === 0 && res.stdout.trim() !== ""
    const errorClass = classifyTurnError(text)
    // A harness can print the provider's refusal and still exit 0, so a
    // zero-exit answer is checked for a usage cap. Any broader class (auth,
    // rate limit, 5xx) matched in an answer's prose is the model talking, not
    // the provider failing: only a non-zero exit or an empty answer is held
    // to the full classification.
    if (errorClass !== "other" && (!answered || errorClass === "usage-limit")) {
      return { verdict: "ko", errorClass, detail: clip(text) }
    }
    if (answered) {
      return { verdict: "ok", detail: clip(res.stdout) }
    }
    if (res.exitCode === 127) {
      return { verdict: "unknown", detail: `"${ctx.adapter}" is not installed in the box` }
    }
    return {
      verdict: "unknown",
      detail: `exit ${res.exitCode} with no recognizable provider error: ${clip(text) || "no output"}`,
    }
  },
}

/**
 * A probe declared in config (`defaults.sandbox.preflight.probes`): run one
 * shell command in the box and turn its result into a yes/no. Nothing in it is
 * specific to a harness or provider, so any "does this box have X" check is a
 * config entry, not code.
 */
export interface CommandProbeSpec {
  id: string
  description?: string
  command: string
  /** Exit code that means yes. Default 0. */
  okExitCode?: number
  /** Regex the stdout must match to count as yes. */
  okStdoutMatches?: string
  /** Output patterns that are a definite no, each with the class a caller (and the egress cooldown ledger) sees. */
  koWhen?: Array<{ match: string; errorClass?: "usage-limit" | "rate-limit" | "auth" | "other" }>
  /** What a result that is neither yes nor a `koWhen` hit means: `unknown` (default, never vetoes) or `ko`. */
  failAs?: "ko" | "unknown"
  timeoutMs?: number
  /** When the probe can run; defaults to `prelaunch`. See {@link PreflightPhase}. */
  phase?: PreflightPhase
  /**
   * @deprecated Use `phase` instead. `true` maps to `prelaunch`, `false` maps
   * to `postlaunch`; when absent a config probe defaults to `prelaunch`.
   */
  runsWithSpawnAuth?: boolean
}

const specPhase = (spec: CommandProbeSpec): PreflightPhase => {
  if (spec.phase !== undefined) return spec.phase
  if (spec.runsWithSpawnAuth === true) return "prelaunch"
  if (spec.runsWithSpawnAuth === false) return "postlaunch"
  return "prelaunch"
}

const compileOrUndefined = (source: string): RegExp | undefined => {
  try {
    return new RegExp(source, "i")
  } catch {
    return undefined
  }
}

export function commandPreflightProbe(spec: CommandProbeSpec): PreflightProbe {
  return {
    id: spec.id,
    description: spec.description ?? `Runs \`${clip(spec.command)}\` in the box.`,
    defaultTimeoutMs: spec.timeoutMs ?? MODEL_ANSWERS_TIMEOUT_MS,
    phase: specPhase(spec),
    async run(ctx) {
      const res = await ctx.exec({
        command: spec.command,
        ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
        timeoutMs: ctx.timeoutMs,
      })
      const text = `${res.stderr}\n${res.stdout}`
      for (const k of spec.koWhen ?? []) {
        const re = compileOrUndefined(k.match)
        if (re?.test(text)) return { verdict: "ko", errorClass: k.errorClass ?? "other", detail: clip(text) }
      }
      const stdoutRe = spec.okStdoutMatches !== undefined ? compileOrUndefined(spec.okStdoutMatches) : undefined
      if (spec.okStdoutMatches !== undefined && stdoutRe === undefined) {
        return { verdict: "unknown", detail: `okStdoutMatches is not a valid regex: ${clip(spec.okStdoutMatches)}` }
      }
      if (res.exitCode === (spec.okExitCode ?? 0) && (stdoutRe === undefined || stdoutRe.test(res.stdout))) {
        return { verdict: "ok", detail: clip(res.stdout) || `exit ${res.exitCode}` }
      }
      const detail = `exit ${res.exitCode}: ${clip(text) || "no output"}`
      return spec.failAs === "ko" ? { verdict: "ko", errorClass: "other", detail } : { verdict: "unknown", detail }
    },
  }
}

/** The built-in probes plus the config-declared ones. A config id that reuses a built-in id is ignored. */
export function buildPreflightRegistry(specs: readonly CommandProbeSpec[] = []): PreflightRegistry {
  const registry = createPreflightRegistry([modelAnswersProbe])
  for (const spec of specs) {
    if (registry.get(spec.id) === undefined) registry.register(commandPreflightProbe(spec))
  }
  return registry
}

/** The daemon-wide registry: built-in probes, extendable with `register`. */
export const defaultPreflightRegistry: PreflightRegistry = createPreflightRegistry([modelAnswersProbe])

/** Ids in `ids` that no probe is registered under. */
export function unknownPreflightProbes(
  ids: readonly string[],
  registry: PreflightRegistry = defaultPreflightRegistry,
): string[] {
  return ids.filter(id => registry.get(id) === undefined)
}

/** Run one probe under its hard timeout. A throw or a timeout is `unknown`. */
export async function runPreflightProbe(
  probe: PreflightProbe,
  ctx: Omit<PreflightContext, "timeoutMs">,
  timeoutMs: number = probe.defaultTimeoutMs,
): Promise<PreflightOutcome> {
  const startedAt = Date.now()
  const finish = (r: Omit<PreflightResult, "durationMs">): PreflightOutcome => ({
    probe: probe.id,
    ...r,
    durationMs: Date.now() - startedAt,
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<"timeout">(resolve => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs)
  })
  // The probe reaches the box through this wrapper only: every command is
  // clamped to the probe's budget (the box kills it then), and once
  // the probe is over, a late call from a leaked run is refused instead of
  // reaching a box the spawn path is about to stop or reuse.
  let over = false
  const exec: PreflightContext["exec"] = opts => {
    if (over) return Promise.reject(new Error("preflight probe is over, exec refused"))
    return ctx.exec({ ...opts, timeoutMs: Math.min(opts.timeoutMs ?? timeoutMs, timeoutMs) })
  }
  try {
    const settled = await Promise.race([probe.run({ ...ctx, exec, timeoutMs }), timedOut])
    if (settled === "timeout") {
      // A silent model-answers timeout is the signature of opencode retrying a
      // rate limit without printing anything: it looks like a throttled IP but
      // is really a hidden refusal. Point the operator at the logs.
      const hint =
        probe.id === MODEL_ANSWERS_PROBE_ID
          ? "; opencode retries rate limits silently, so re-run opencode with --print-logs --log-level WARN to see the limit (it shows in ~5s)"
          : ""
      return finish({ verdict: "unknown", detail: `timed out after ${timeoutMs}ms with no output${hint}` })
    }
    return finish(settled)
  } catch (err) {
    return finish({ verdict: "unknown", detail: `probe failed to run: ${clip(err instanceof Error ? err.message : String(err))}` })
  } finally {
    over = true
    if (timer) clearTimeout(timer)
  }
}

export interface PreflightRun {
  /** False when some probe said `ko`. */
  ok: boolean
  /** One entry per probe that ran, in order. Probes after a `ko` do not run. */
  outcomes: PreflightOutcome[]
  /** The `ko` outcome that stopped the run. */
  failed?: PreflightOutcome
}

export interface RunSandboxPreflightOptions {
  registry?: PreflightRegistry
  /** Overrides every probe's own default budget. */
  timeoutMs?: number
}

/** Run probes by id, in order, stopping at the first `ko`. Unknown ids are `unknown` outcomes. */
export async function runSandboxPreflight(
  ids: readonly string[],
  ctx: Omit<PreflightContext, "timeoutMs">,
  opts: RunSandboxPreflightOptions = {},
): Promise<PreflightRun> {
  const registry = opts.registry ?? defaultPreflightRegistry
  const outcomes: PreflightOutcome[] = []
  for (const id of new Set(ids)) {
    const probe = registry.get(id)
    const outcome: PreflightOutcome = probe
      ? await runPreflightProbe(probe, ctx, opts.timeoutMs)
      : { probe: id, verdict: "unknown", detail: "no probe registered under this id", durationMs: 0 }
    outcomes.push(outcome)
    if (outcome.verdict === "ko") return { ok: false, outcomes, failed: outcome }
  }
  return { ok: true, outcomes }
}

/** Machine-readable payload of `sandbox_preflight_failed` (flat: it is spread into the tool/HTTP error body). */
export interface SandboxPreflightFailedDetails extends Record<string, unknown> {
  probe: string
  errorClass?: TurnErrorClass
  probeDetail: string
  /** The box's public egress address, when the provider brokered one. */
  egressIp?: string
  provider: string
  sandboxId: string
  outcomes: PreflightOutcome[]
}

/** The typed spawn failure for a run that ended in `ko`. */
export function preflightFailedResult(
  run: PreflightRun & { failed: PreflightOutcome },
  box: { provider: string; sandboxId: string; egressIp?: string },
): { ok: false; code: "sandbox_preflight_failed"; message: string; details: SandboxPreflightFailedDetails } {
  const { failed } = run
  const where = box.egressIp ? ` (egress ${box.egressIp})` : ""
  return {
    ok: false,
    code: "sandbox_preflight_failed",
    message:
      `agent_start: sandbox preflight "${failed.probe}" failed on ${box.provider} box ${box.sandboxId}${where}` +
      `${failed.errorClass ? ` [${failed.errorClass}]` : ""}: ${failed.detail}`,
    details: {
      probe: failed.probe,
      ...(failed.errorClass !== undefined ? { errorClass: failed.errorClass } : {}),
      probeDetail: failed.detail,
      ...(box.egressIp !== undefined ? { egressIp: box.egressIp } : {}),
      provider: box.provider,
      sandboxId: box.sandboxId,
      outcomes: run.outcomes,
    },
  }
}
