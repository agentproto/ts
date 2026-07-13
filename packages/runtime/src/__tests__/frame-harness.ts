/**
 * In-process `FrameSink` transport harness for the pairing integration tests —
 * a mirror of `@agentproto/acp`'s own e2e-harness. `connect()` returns two
 * linked endpoints (a stand-in for the spliced socket a rendezvous would
 * provide); a `Middleware` per direction lets a test play the untrusted — or
 * actively malicious — broker: record, tamper, drop, duplicate.
 *
 * Test utility (no `.test.ts` suffix).
 */

import type { FrameSink } from "@agentproto/acp/tunnel"

// The FrameSink surface is generic over its frame type in spirit, but the acp
// types pin it to TunnelFrame. We keep it loose here to avoid importing the
// (large) frame union — a frame is any object with a `t` string.
type Frame = { t: string; [k: string]: unknown }
type FrameHandler = (f: Frame) => void
type CloseHandler = (reason?: string) => void

export type Middleware = (frame: Frame, deliver: (frame: Frame) => void) => void
export const passthrough: Middleware = (frame, deliver) => deliver(frame)

class Endpoint {
  private frameHandlers = new Set<FrameHandler>()
  private closeHandlers = new Set<CloseHandler>()
  private queued: Frame[] = []
  private openState = true
  peer!: Endpoint
  route: (frame: Frame) => void = () => {}

  get isOpen(): boolean {
    return this.openState
  }

  deliver(frame: Frame): void {
    queueMicrotask(() => {
      if (!this.openState) return
      if (this.frameHandlers.size === 0) {
        this.queued.push(frame)
        return
      }
      for (const h of this.frameHandlers) h(frame)
    })
  }

  private closeLocal(reason?: string): void {
    if (!this.openState) return
    this.openState = false
    for (const h of this.closeHandlers) h(reason)
  }

  send(frame: Frame): void {
    if (!this.openState) return
    this.route(frame)
  }

  close(reason?: string): void {
    if (!this.openState) return
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

export function connect(
  aToB: Middleware = passthrough,
  bToA: Middleware = passthrough,
): Wire {
  const a = new Endpoint()
  const b = new Endpoint()
  a.peer = b
  b.peer = a
  a.route = frame => aToB(frame, f => b.deliver(f))
  b.route = frame => bToA(frame, f => a.deliver(f))
  // The Endpoint shape structurally satisfies FrameSink (send/close/onFrame/
  // onClose/isOpen over frame objects); the cast is the one seam where the
  // loose harness type meets acp's TunnelFrame-pinned FrameSink.
  return { a: a as unknown as FrameSink, b: b as unknown as FrameSink }
}

export const flush = (): Promise<void> =>
  new Promise(resolve => setImmediate(resolve))
