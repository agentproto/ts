/**
 * In-memory sentinel provider for tests (AIP-60 step 2). Never registered in
 * `BUILTIN_SENTINEL_PROVIDERS` — it exists purely so `sentinel-runtime.ts`'s
 * poll loop, dedup, lifetime, and dead-session paths are exercisable without
 * any real external system.
 *
 * `emit()` appends an event to the provider's shared in-memory stream;
 * `poll()` reads from a handle's own `cursor` (a stringified index into that
 * stream), so multiple sentinels attached to the SAME fake provider instance
 * each see the full stream independently, exactly like a real poll-mode
 * provider with a per-subscription cursor.
 */

import type {
  DeliveryPreference,
  SentinelEvent,
  SentinelHandle,
  SentinelProviderHandle,
  SentinelSpec,
} from "./types.js"

export interface FakeSentinelProvider extends SentinelProviderHandle {
  /** Test hook: append an event to the shared stream every attached handle
   *  polls from. */
  emit(event: SentinelEvent): void
  /** Handles passed to `cancel()`, by remoteId — for assertions. */
  readonly canceled: ReadonlySet<string>
  /** Every `create`/`attach` call's delivery preference, in order — lets a
   *  test assert re-attach happened with the expected cadence. */
  readonly attachCalls: DeliveryPreference[]
}

export interface CreateFakeSentinelProviderOptions {
  slug?: string
  /** Ack calls are recorded but otherwise no-ops (the fake keeps full
   *  history for test inspection) unless this throws. */
  onAck?: (handle: SentinelHandle, cursor: string) => void
}

/** Build a fresh {@link SentinelEvent} with sane defaults — the pure event
 *  fields a test doesn't care about are filled in so callers only specify
 *  what the assertion is about. */
export function makeFakeEvent(
  input: Pick<SentinelEvent, "id" | "type" | "subject"> & Partial<SentinelEvent>,
): SentinelEvent {
  return {
    specversion: "1.0",
    source: "//agentproto.local/sentinel/fake",
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    data: {},
    summary: `${input.type} on ${input.subject}`,
    subjects: [input.subject],
    terminal: false,
    ...input,
  }
}

export function createFakeSentinelProvider(
  opts?: CreateFakeSentinelProviderOptions,
): FakeSentinelProvider {
  const slug = opts?.slug ?? "fake"
  const stream: SentinelEvent[] = []
  const canceled = new Set<string>()
  const attachCalls: DeliveryPreference[] = []

  const provider: FakeSentinelProvider = {
    slug,
    name: "Fake Sentinel Provider",
    version: "0.0.0-test",
    description: "In-memory sentinel provider for tests — never a real built-in.",
    requiresSetup: false,
    capabilities: {
      subjects: ["*"],
      push: false,
      poll: true,
      durable: false,
      needsPublicUrl: false,
      requiresAuth: false,
      typicalLatencyMs: 0,
    },
    canceled,
    attachCalls,

    async check(): Promise<boolean> {
      return true
    },

    async create(spec: SentinelSpec, delivery: DeliveryPreference): Promise<SentinelHandle> {
      attachCalls.push(delivery)
      // The first match clause's subject stands in for "the primary thing
      // being watched" — good enough for a test double's remoteId.
      return { provider: slug, remoteId: spec.match[0]?.subject, cursor: "0" }
    },

    async attach(handle: SentinelHandle, delivery: DeliveryPreference): Promise<SentinelHandle> {
      attachCalls.push(delivery)
      return { ...handle }
    },

    async cancel(handle: SentinelHandle): Promise<void> {
      if (handle.remoteId) canceled.add(handle.remoteId)
    },

    async status(handle: SentinelHandle): Promise<{ ok: boolean; pending?: number }> {
      return { ok: !canceled.has(handle.remoteId ?? ""), pending: stream.length }
    },

    async poll(
      handle: SentinelHandle,
      limit: number,
    ): Promise<{ events: SentinelEvent[]; cursor: string }> {
      const cursor = handle.cursor ? Number(handle.cursor) : 0
      const slice = stream.slice(cursor, cursor + limit)
      return { events: slice, cursor: String(cursor + slice.length) }
    },

    async ack(handle: SentinelHandle, cursor: string): Promise<void> {
      opts?.onAck?.(handle, cursor)
    },

    defaultTypes(_subject: string): string[] {
      return ["fake.*"]
    },

    emit(event: SentinelEvent): void {
      stream.push(event)
    },
  }

  return provider
}
