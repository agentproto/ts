/**
 * In-process transport harness for the E2E channel tests.
 *
 * `connect()` returns two linked `FrameSink` endpoints — an in-memory stand-in
 * for the spliced socket a rendezvous would provide. A `Middleware` sits in the
 * middle of each direction so a test can play the untrusted (or actively
 * malicious) broker: pass every frame through untouched, or flip bytes, drop,
 * duplicate, reorder, and record what crosses the wire.
 *
 * Delivery is asynchronous (microtask), FIFO within a direction — matching a
 * real duplex transport and avoiding send-reentrancy. Frames that arrive before
 * a handler is attached are buffered, so wrapping/handshake ordering can never
 * silently lose a frame.
 *
 * This file is a test utility, not a test suite (no `.test.ts` suffix).
 */

import type { FrameSink } from "../tunnel/transport.js"
import type { TunnelFrame } from "../tunnel/frames.js"

type FrameHandler = (f: TunnelFrame) => void
type CloseHandler = (reason?: string) => void

/** Called for each frame crossing one direction. Call `deliver` zero times
 *  (drop), once (pass), or many times (duplicate); pass a mutated frame to
 *  tamper; stash frames to reorder. */
export type Middleware = (
  frame: TunnelFrame,
  deliver: (frame: TunnelFrame) => void
) => void

export const passthrough: Middleware = (frame, deliver) => deliver(frame)

class Endpoint implements FrameSink {
  private frameHandlers = new Set<FrameHandler>()
  private closeHandlers = new Set<CloseHandler>()
  private queued: TunnelFrame[] = []
  private open = true
  peer!: Endpoint
  route: (frame: TunnelFrame) => void = () => {}

  get isOpen(): boolean {
    return this.open
  }

  /** Enqueue an inbound frame for asynchronous delivery to handlers. */
  deliver(frame: TunnelFrame): void {
    queueMicrotask(() => {
      if (!this.open) return
      if (this.frameHandlers.size === 0) {
        this.queued.push(frame)
        return
      }
      for (const h of this.frameHandlers) h(frame)
    })
  }

  private closeLocal(reason?: string): void {
    if (!this.open) return
    this.open = false
    for (const h of this.closeHandlers) h(reason)
  }

  send(frame: TunnelFrame): void {
    if (!this.open) return
    this.route(frame)
  }

  close(reason?: string): void {
    if (!this.open) return
    this.closeLocal(reason)
    this.peer.closeLocal(reason)
  }

  onFrame(handler: FrameHandler): () => void {
    this.frameHandlers.add(handler)
    if (this.queued.length > 0) {
      const pending = this.queued
      this.queued = []
      for (const f of pending) handler(f)
    }
    return () => this.frameHandlers.delete(handler)
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }
}

export interface Wire {
  a: FrameSink
  b: FrameSink
}

/** Link two endpoints. `aToB` runs on frames A sends toward B; `bToA` the
 *  reverse. Both default to passthrough. */
export function connect(aToB: Middleware = passthrough, bToA: Middleware = passthrough): Wire {
  const a = new Endpoint()
  const b = new Endpoint()
  a.peer = b
  b.peer = a
  a.route = frame => aToB(frame, f => b.deliver(f))
  b.route = frame => bToA(frame, f => a.deliver(f))
  return { a, b }
}

/** Await pending microtask/timer delivery. */
export const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
