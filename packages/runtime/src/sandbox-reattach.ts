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
 */

import {
  createSandboxAgentSessionHost,
  isSandboxBoxGoneError,
  resolveLifecyclePolicy,
  type SandboxAgentSessionHost,
  type SandboxSpec,
} from "@agentproto/sandbox"
import { createSandboxAgentSessionProxy } from "./sandbox-agent-session-proxy.js"
import { createDeliveryHook, formatDeliveryNotice } from "./sandbox-delivery.js"
import { recordSandboxState } from "./sandbox-ledger.js"
import { resolveSandboxSecretFromBroker } from "./session-restart-core.js"
import { sessionTranscriptDir } from "./transcript-writer.js"
import type { SandboxProviderResolver } from "./sandbox-adapters.js"
import type { SessionDescriptor, SessionsRegistry } from "./sessions.js"

/** Tally of one reattach pass, for the boot banner. */
export interface SandboxReattachSummary {
  /** Detached rows found at boot — the denominator of the banner line. */
  candidates: number
  reattached: number
  /** Box (or its session) no longer exists → row ended `sandbox_gone`. */
  gone: number
  /** The box session had finished while the daemon was down. */
  ended: number
  /** Box unreachable / provider unresolvable — row fell back to the plain
   *  `daemon-restart` ghost. */
  failed: number
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

/**
 * Run the bounded reattach pass. Never throws: a per-row failure is tallied
 * and leaves that row as a plain ghost.
 */
export async function runSandboxReattachPass(opts: {
  registry: Pick<
    SessionsRegistry,
    "sandboxReattachCandidates" | "finishSandboxReattach" | "recordSandboxDelivery"
  >
  resolveSandboxProvider: SandboxProviderResolver
  /** Max boxes reconnected concurrently. */
  concurrency?: number
  /** Cross-process gate, same meaning as the eager-resume pass's. */
  isServed?: (desc: SessionDescriptor) => boolean
}): Promise<SandboxReattachSummary> {
  const { registry } = opts
  const limit = Math.max(1, Math.floor(opts.concurrency ?? 4))
  const candidates = registry
    .sandboxReattachCandidates()
    .filter(d => opts.isServed?.(d) ?? true)
    .sort((a, b) => (b.lastActivityAt ?? b.startedAt).localeCompare(a.lastActivityAt ?? a.startedAt))
  const summary: SandboxReattachSummary = {
    candidates: candidates.length,
    reattached: 0,
    gone: 0,
    ended: 0,
    failed: 0,
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
    const handle = await opts.resolveSandboxProvider(providerSlug)
    if (!handle) {
      registry.finishSandboxReattach(desc.id, {
        kind: "failed",
        detail: `sandbox provider "${providerSlug}" not found`,
      })
      summary.failed++
      return
    }
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
        recordSandboxState(sandboxId, "gone")
        registry.finishSandboxReattach(desc.id, { kind: "gone", detail })
        summary.gone++
      } else {
        registry.finishSandboxReattach(desc.id, { kind: "failed", detail })
        summary.failed++
      }
      return
    }
    const teardown = desc.sandboxTeardown ?? resolveLifecyclePolicy(spec, true).teardown
    const deliveryTarget = desc.sandboxDeliveryTarget
    const agentSession = createSandboxAgentSessionProxy({
      host,
      remoteSessionId: record.remoteSessionId,
      lifecyclePolicy: { teardown },
      ledger: { sandboxId, provider: providerSlug },
      detachable: true,
      initialTranscriptCursor: record.transcriptSeq,
      ...(deliveryTarget && host.exec
        ? {
            onBeforeTeardown: createDeliveryHook({
              exec: host.exec,
              ...(host.readFile ? { readFile: host.readFile } : {}),
              target: deliveryTarget,
              outDir: sessionTranscriptDir(desc.id),
              onDelivery: delivery => {
                registry.recordSandboxDelivery(desc.id, delivery, formatDeliveryNotice(delivery))
              },
            }),
          }
        : {}),
    })
    const probe = (await agentSession.probeReattach?.()) ?? {
      state: "unreachable" as const,
      detail: "proxy cannot probe",
    }
    switch (probe.state) {
      case "gone":
      case "ended": {
        registry.finishSandboxReattach(desc.id, {
          kind: probe.state,
          ...(probe.detail ? { detail: probe.detail } : {}),
        })
        if (probe.state === "gone") summary.gone++
        else summary.ended++
        // The remote session is over: tear the box down per its lifecycle
        // policy (delivery hook included) rather than leak it.
        await agentSession.close().catch(() => undefined)
        return
      }
      case "unreachable": {
        agentSession.detach?.()
        registry.finishSandboxReattach(desc.id, {
          kind: "failed",
          ...(probe.detail ? { detail: probe.detail } : {}),
        })
        summary.failed++
        return
      }
      default: {
        const outcome = registry.finishSandboxReattach(desc.id, {
          kind: "attach",
          agentSession,
          probe,
          readUsage: readUsageFor(host, record.remoteSessionId),
        })
        if (outcome.status === "reattached") summary.reattached++
        return
      }
    }
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
