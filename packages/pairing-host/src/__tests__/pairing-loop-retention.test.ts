import { getEventListeners } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { E2eFrameSink, FrameSink } from "@agentproto/acp/tunnel"
import { generateIdentity, type DaemonIdentity } from "@agentproto/secrets/identity"
import {
  createPairingRegistry,
  sleep,
  waitClosed,
  type PairingChannelHandle,
  type PairingHostRegistry,
} from "../pairing-registry.js"

class TrackingSink implements FrameSink {
  isOpen = true
  closeCalls = 0
  private closeHandlers = new Set<(reason?: string) => void>()

  send(): void {}
  close(reason?: string): void {
    this.closeCalls += 1
    this.isOpen = false
    for (const handler of [...this.closeHandlers]) handler(reason)
  }
  onFrame(): () => void {
    return () => {}
  }
  onClose(handler: (reason?: string) => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }
  emitClose(reason?: string): void {
    this.isOpen = false
    for (const handler of [...this.closeHandlers]) handler(reason)
  }
}

describe("pairing reconnect loop retention", () => {
  const registries: PairingHostRegistry[] = []
  let identity: DaemonIdentity | undefined

  afterEach(async () => {
    for (const registry of registries.splice(0)) await registry.shutdown().catch(() => {})
    identity = undefined
  })

  it("closes the sink of every failed handshake instead of stranding a socket per attempt", async () => {
    identity ??= await generateIdentity()
    const sinks: TrackingSink[] = []
    const registry = createPairingRegistry({
      loadIdentity: async () => identity as DaemonIdentity,
      dial: async () => {
        const sink = new TrackingSink()
        sinks.push(sink)
        return sink
      },
      serve: (): PairingChannelHandle => ({ close: async () => {} }),
      defaultRendezvousUrl: "ws://broker.invalid/v1",
      handshakeTimeoutMs: 10,
      reconnectMinMs: 5,
      reconnectMaxMs: 10,
    })
    registries.push(registry)

    await registry.createOffer({ ttlMs: 60_000 })
    await vi.waitFor(() => expect(sinks.length).toBeGreaterThanOrEqual(2), { timeout: 2_000 })

    expect(sinks[0]?.closeCalls).toBeGreaterThan(0)
  })

  it("removes the abort listener from a served channel once it closes", async () => {
    const controller = new AbortController()
    for (let i = 0; i < 25; i++) {
      const sink = new TrackingSink()
      const closed = waitClosed(sink as unknown as E2eFrameSink, controller.signal)
      sink.emitClose(undefined)
      await closed
    }
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  })

  it("removes the abort listener from a completed backoff sleep", async () => {
    const controller = new AbortController()
    await Promise.all(Array.from({ length: 25 }, () => sleep(0, controller.signal)))
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  })
})
