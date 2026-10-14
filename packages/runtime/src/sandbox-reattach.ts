/**
 * Boot-time reattach pass for sandbox sessions a previous daemon process
 * detached from (or died holding) — the second half of "sandbox sessions
 * survive a host daemon restart".
 *
 * Shutdown no longer kills a provider box's session: it closes the host's
 * connection and leaves the box + its agent session running (see
 * `SessionsRegistry.detachSandboxSessions`). This pass runs at the next boot,
 * BEFORE the eager-resume / continue-interrupted passes, and for every row
 * still flagged `hostDetached`:
 *   1. `SandboxProvider.connect(sandboxId)` — the same `reuse` path a
 *      `sandbox.reuse` spawn takes (never boots);
 *   2. probes the box's own session — gone / ended / busy / unseen backlog /
 *      idle;
 *   3. hands the live proxy (cursor = the saved transcript seq) to the
 *      registry, which re-binds the SAME session id and, when the box kept
 *      working, replays the missed events into the host transcript. The box's
 *      agent is never re-prompted, and `continue-interrupted` is not involved.
 * A box that no longer exists ends the row with `sandbox_gone` and a ledger
 * entry.
 *
 * Every row runs under a PER-ROW DEADLINE ({@link DEFAULT_REATTACH_TIMEOUT_MS})
 * covering the whole connect→probe chain. None of the steps below is unbounded
 * on its own — the e2b provider's control-plane calls cap at the SDK's 60s
 * request timeout (3 retries), the in-box daemon readiness poll at
 * `daemonReadyTimeoutMs`, the MCP handshake at the SDK's 60s request timeout,
 * the box probe at 10s — but STACKED they legitimately run for minutes per row
 * (a resumed box that needs `npm i -g` alone allows 120s), which is exactly
 * how the pass was observed still showing `pending: N` long after boot while
 * every observer gave up waiting. The deadline bounds the row, resolves it
 * (`gone` when the provider can still say the box is gone, otherwise `failed`
 * with "reattach timed out after Ns"), and releases any half-open handle
 * WITHOUT killing a live box — so `pending` always settles to 0.
 */

import {
  createSandboxAgentSessionHost,
  isSandboxBoxGoneError,
  resolveLifecyclePolicy,
  type SandboxAgentSessionHost,
  type SandboxSpec,
} from "@agentproto/sandbox"
import { createSandboxAgentSessionProxy } from "./sandbox-agent-session-proxy.js"
import {
  createDeliveryHook,
  formatDeliveryNotice,
  resolveSandboxCheckpointConfig,
  sandboxCheckpointOpts,
} from "./sandbox-delivery.js"
import { loadConfig } from "./config.js"
import type { SpawnDefaultsConfig } from "./spawn-defaults.js"
import { recordSandboxState } from "./sandbox-ledger.js"
import { resolveSandboxSecretFromBroker } from "./session-restart-core.js"
import { sessionTranscriptDir } from "./transcript-writer.js"
import { readTarTarget, tarCheckpointProxyOpts } from "./sandbox-tar-checkpoint.js"
import type { SandboxProviderHandle, SandboxProviderResolver } from "./sandbox-adapters.js"
import type {
  SandboxReattachResult,
  SessionDescriptor,
  SessionsRegistry,
} from "./sessions.js"

/** Tally of one reattach pass, for the boot banner. */
export interface SandboxReattachSummary {
  /** Detached rows found at boot — the denominator of the banner line. */
  candidates: number
  reattached: number
  /** Box (or its session) no longer exists → row ended `sandbox_gone`. */
  gone: number
  /** The box session had finished while the daemon was down. */
  ended: number
  /** Box unreachable / provider unresolvable / row timed out — row fell back
   *  to the plain `daemon-restart` ghost. */
  failed: number
  /** Detached rows that belong to a workspace bucket this daemon does not
   *  serve — left untouched for the daemon that does. Not counted in
   *  `candidates`. */
  unserved: number
}

/**
 * Default per-row deadline for the WHOLE reattach (provider `connect` → box
 * daemon MCP connect → session probe), ms. Sized to outlast the fast paths
 * (a healthy box reconnects in ~1s) while staying well under anything an
 * observer should wait on — see the module doc for what the unbounded stack
 * used to add up to. Override with `runSandboxReattachPass({ timeoutMs })` or
 * `AGENTPROTO_REATTACH_TIMEOUT_MS` at the gateway.
 */
export const DEFAULT_REATTACH_TIMEOUT_MS = 30_000

/**
 * How long a TIMED-OUT row waits for the provider's own liveness probe
 * (`SandboxProvider.probe`) to decide gone-vs-failed. One cheap
 * control-plane call; a provider with no probe, a throwing probe, or one
 * that outlives this window leaves the row `failed` — an unknown answer is
 * never read as "the box is gone".
 */
const GONE_PROBE_TIMEOUT_MS = 5_000

/** `Promise.race` discriminator for the per-row deadline. */
const TIMED_OUT = Symbol("sandbox-reattach-timed-out")

/** `reattach timed out after 30s` (sub-second deadlines read as `40ms`) — the
 *  `detail` every timed-out row carries. */
function reattachTimeoutDetail(ms: number): string {
  return `reattach timed out after ${ms >= 1_000 ? `${Math.round(ms / 100) / 10}s` : `${ms}ms`}`
}

const readUsageFor =
  (host: SandboxAgentSessionHost, remoteSessionId: string) =>
  async () => {
    if (typeof host.usage !== "function") return null
    const snap = await host.usage(remoteSessionId)
    const usage = {
      ...(typeof snap.model === "string" && snap.model.length > 0 ? { model: snap.model } : {}),
      ...(typeof snap.costUsd === "number" ? { costUsd: snap.costUsd } : {}),
      ...(typeof snap.tokensIn === "number" ? { tokensIn: snap.tokensIn } : {}),
      ...(typeof snap.tokensOut === "number" ? { tokensOut: snap.tokensOut } : {}),
    }
    return Object.keys(usage).length > 0 ? usage : null
  }

type SandboxProxySession = ReturnType<typeof createSandboxAgentSessionProxy>

/** Whatever half-open handles one row's attempt has built so far — the only
 *  things a deadline (or a late settle) may release, and never the box. */
interface ReattachAttemptState {
  /** Resolved provider handle — the timeout path asks it whether the box is
   *  still alive before choosing `gone` over `failed`. */
  handle?: SandboxProviderHandle
  host?: SandboxAgentSessionHost
  session?: SandboxProxySession
}

/** What one attempt computed. Applied to the registry ONLY when the row's
 *  deadline has not fired; a late result is released instead. */
interface ReattachAttemptOutcome {
  result: SandboxReattachResult
  /** Stamp the sandbox ledger `gone` when this lands — the provider answered
   *  that the box id no longer exists. */
  stampGone?: boolean
}

/**
 * On a row deadline: ask the provider whether the box still exists — a single
 * bounded control-plane call (`SandboxProvider.probe`). `false` also covers
 * "provider has no probe", a throwing probe, and one that outlives
 * {@link GONE_PROBE_TIMEOUT_MS}: unknown is never read as gone.
 */
async function providerSaysGone(
  handle: SandboxProviderHandle | undefined,
  sandboxId: string,
): Promise<boolean> {
  const probe = handle?.provider.probe
  if (!probe) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const res = await Promise.race([
      probe(sandboxId),
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), GONE_PROBE_TIMEOUT_MS)
      }),
    ])
    return res?.alive === false
  } catch {
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Release whatever half-open handle the attempt left behind — the proxy's
 * `detach()` (MCP connection + watchdog timers only) when it got that far,
 * otherwise the raw host connection. Deliberately NEVER `stop()`/`pause()`:
 * a row that merely failed or timed out must not kill a live box.
 */
function releaseAttempt(state: ReattachAttemptState): void {
  if (state.session) {
    state.session.detach?.()
    return
  }
  const host = state.host
  if (host) void host.close().catch(() => undefined)
}

/**
 * Run the bounded reattach pass. Never throws: a per-row failure is tallied
 * and leaves that row as a plain ghost.
 */
export async function runSandboxReattachPass(opts: {
  registry: Pick<
    SessionsRegistry,
    "sandboxReattachCandidates" | "finishSandboxReattach" | "recordSandboxDelivery" | "recordSandboxCheckpoint"
  > &
    Partial<Pick<SessionsRegistry, "recordNotice" | "noteSandboxReattachUnserved">>
  resolveSandboxProvider: SandboxProviderResolver
  /** Max boxes reconnected concurrently. */
  concurrency?: number
  /** Per-row deadline for the whole reattach (connect + daemon connect +
   *  probe), ms. Defaults to {@link DEFAULT_REATTACH_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Cross-process gate, same meaning as the eager-resume pass's. */
  isServed?: (desc: SessionDescriptor) => boolean
  /** `defaults` block the checkpoint policy is resolved from; defaults to the
   *  config file. */
  loadDefaultsConfig?: () => Promise<SpawnDefaultsConfig | undefined>
}): Promise<SandboxReattachSummary> {
  const { registry } = opts
  const limit = Math.max(1, Math.floor(opts.concurrency ?? 4))
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs ?? DEFAULT_REATTACH_TIMEOUT_MS))
  const allCandidates = registry.sandboxReattachCandidates()
  // Rows a previous daemon detached that live in a workspace bucket THIS
  // daemon does not serve: another daemon owns them, so we must not resolve
  // them (that would race/steal) — but we DO report them so they don't read
  // as eternally `pending`. Left untouched; `hostDetached` stays set.
  const served = allCandidates.filter(d => opts.isServed?.(d) ?? true)
  const unserved = allCandidates.length - served.length
  registry.noteSandboxReattachUnserved?.(unserved)
  const candidates = served.sort((a, b) =>
    (b.lastActivityAt ?? b.startedAt).localeCompare(a.lastActivityAt ?? a.startedAt),
  )
  const summary: SandboxReattachSummary = {
    candidates: candidates.length,
    reattached: 0,
    gone: 0,
    ended: 0,
    failed: 0,
    unserved,
  }

  /**
   * Build everything up to (and including) the box probe, WITHOUT touching
   * the registry — the caller applies the outcome only if the row's deadline
   * is still open. Never rejects: a throw becomes a `failed` outcome.
   */
  const attemptReattach = async (
    desc: SessionDescriptor,
    record: NonNullable<SessionDescriptor["sandboxReattach"]>,
    sandboxId: string,
    providerSlug: string,
    state: ReattachAttemptState,
  ): Promise<ReattachAttemptOutcome> => {
    const handle = await opts.resolveSandboxProvider(providerSlug)
    if (!handle) {
      return {
        result: { kind: "failed", detail: `sandbox provider "${providerSlug}" not found` },
      }
    }
    state.handle = handle
    const spec: SandboxSpec = { provider: providerSlug, config: {} }
    let host: SandboxAgentSessionHost
    try {
      host = await createSandboxAgentSessionHost({
        provider: handle.provider,
        spec,
        sandboxId,
        secrets: { slugs: [], resolver: resolveSandboxSecretFromBroker },
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      if (isSandboxBoxGoneError(err)) {
        return { result: { kind: "gone", detail }, stampGone: true }
      }
      return { result: { kind: "failed", detail } }
    }
    state.host = host
    const teardown = desc.sandboxTeardown ?? resolveLifecyclePolicy(spec, true).teardown
    const deliveryTarget = desc.sandboxDeliveryTarget
    const checkpointConfig = resolveSandboxCheckpointConfig(
      (await (opts.loadDefaultsConfig?.() ?? loadConfig().then(cfg => cfg.defaults)).catch(() => undefined))?.sandbox
        ?.checkpoint,
      desc.sandboxCheckpointOverride,
    )
    const tarTarget = deliveryTarget ? undefined : await readTarTarget(sessionTranscriptDir(desc.id))
    const agentSession = createSandboxAgentSessionProxy({
      host,
      remoteSessionId: record.remoteSessionId,
      lifecyclePolicy: { teardown },
      ledger: { sandboxId, provider: providerSlug },
      detachable: true,
      initialTranscriptCursor: record.transcriptSeq,
      ...(tarTarget
        ? tarCheckpointProxyOpts({
            exec: host.exec,
            ...(host.readFile ? { readFile: host.readFile } : {}),
            target: tarTarget,
            outDir: sessionTranscriptDir(desc.id),
            config: checkpointConfig,
            notify: text => registry.recordNotice?.(desc.id, text),
          })
        : {}),
      ...(deliveryTarget && host.exec
        ? {
            onBeforeTeardown: createDeliveryHook({
              exec: host.exec,
              ...(host.readFile ? { readFile: host.readFile } : {}),
              target: deliveryTarget,
              outDir: sessionTranscriptDir(desc.id),
              snapshotUncommitted: checkpointConfig.onTeardown,
              onDelivery: delivery => {
                registry.recordSandboxDelivery(desc.id, delivery, formatDeliveryNotice(delivery))
              },
            }),
            ...sandboxCheckpointOpts(
              {
                exec: host.exec,
                ...(host.readFile ? { readFile: host.readFile } : {}),
                target: deliveryTarget,
                outDir: sessionTranscriptDir(desc.id),
                onCheckpoint: record => {
                  registry.recordSandboxCheckpoint(desc.id, record, formatDeliveryNotice(record))
                },
              },
              checkpointConfig,
            ),
          }
        : {}),
      watchdog: {},
    })
    state.session = agentSession
    const probe = (await agentSession.probeReattach?.()) ?? {
      state: "unreachable" as const,
      detail: "proxy cannot probe",
    }
    switch (probe.state) {
      case "gone":
      case "ended":
        return {
          result: {
            kind: probe.state,
            ...(probe.detail ? { detail: probe.detail } : {}),
          },
        }
      case "unreachable":
        return {
          result: { kind: "failed", ...(probe.detail ? { detail: probe.detail } : {}) },
        }
      default:
        return {
          result: {
            kind: "attach",
            agentSession,
            probe,
            readUsage: readUsageFor(host, record.remoteSessionId),
          },
        }
    }
  }

  /** Land one settled attempt on the registry (the only tallying path). */
  const applyOutcome = async (
    desc: SessionDescriptor,
    state: ReattachAttemptState,
    outcome: ReattachAttemptOutcome,
  ): Promise<void> => {
    const { result, stampGone } = outcome
    if (stampGone && desc.sandboxId) recordSandboxState(desc.sandboxId, "gone")
    switch (result.kind) {
      case "gone":
      case "ended": {
        registry.finishSandboxReattach(desc.id, {
          kind: result.kind,
          ...(result.detail ? { detail: result.detail } : {}),
        })
        if (result.kind === "gone") summary.gone++
        else summary.ended++
        // The remote session is over: tear the box down per its lifecycle
        // policy (delivery hook included) rather than leak it.
        await state.session?.close().catch(() => undefined)
        return
      }
      case "failed": {
        // Detach/close the half-open handle first — the box itself survives.
        releaseAttempt(state)
        registry.finishSandboxReattach(desc.id, {
          kind: "failed",
          ...(result.detail ? { detail: result.detail } : {}),
        })
        summary.failed++
        return
      }
      default: {
        const landed = registry.finishSandboxReattach(desc.id, {
          kind: "attach",
          agentSession: result.agentSession,
          probe: result.probe,
          readUsage: result.readUsage,
        })
        if (landed.status === "reattached") summary.reattached++
        return
      }
    }
  }

  const reattachOne = async (desc: SessionDescriptor): Promise<void> => {
    const record = desc.sandboxReattach
    const sandboxId = desc.sandboxId
    const providerSlug = desc.sandboxProvider
    if (!record || !sandboxId || !providerSlug) {
      registry.finishSandboxReattach(desc.id, { kind: "failed", detail: "no re-attach record" })
      summary.failed++
      return
    }

    const state: ReattachAttemptState = {}
    const work = attemptReattach(desc, record, sandboxId, providerSlug, state).catch(
      (err): ReattachAttemptOutcome => ({
        result: { kind: "failed", detail: err instanceof Error ? err.message : String(err) },
      }),
    )
    // A deadline win leaves the attempt running: whatever it eventually
    // builds is released (never applied — the row is already resolved), so a
    // slow-but-successful connect can't re-bind behind the row's back.
    let timedOut = false
    void work.then(() => {
      if (timedOut) releaseAttempt(state)
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<typeof TIMED_OUT>(resolve => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
    })
    const winner = await Promise.race([work, deadline])
    if (timer !== undefined) clearTimeout(timer)

    if (winner === TIMED_OUT) {
      timedOut = true
      const detail = reattachTimeoutDetail(timeoutMs)
      if (await providerSaysGone(state.handle, sandboxId)) {
        recordSandboxState(sandboxId, "gone")
        registry.finishSandboxReattach(desc.id, {
          kind: "gone",
          detail: `${detail} — the provider reports the box is gone`,
        })
        summary.gone++
      } else {
        registry.finishSandboxReattach(desc.id, { kind: "failed", detail })
        summary.failed++
      }
      releaseAttempt(state)
      return
    }

    await applyOutcome(desc, state, winner)
  }

  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < candidates.length) {
      const desc = candidates[cursor++]!
      try {
        await reattachOne(desc)
      } catch (err) {
        const outcome = registry.finishSandboxReattach(desc.id, {
          kind: "failed",
          detail: err instanceof Error ? err.message : String(err),
        })
        if (outcome.status !== "skipped") summary.failed++
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, candidates.length) }, () => worker()))
  return summary
}
