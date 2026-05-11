/**
 * Transport-agnostic frame sink. Wrap any duplex byte-stream (WebSocket,
 * TLS socket, ssh channel, in-process pair for tests) by adapting to
 * this shape. The tunnel client/server only ever talk to this — they
 * never know about `ws` directly.
 *
 * `send` MUST be best-effort non-blocking; the underlying transport
 * handles backpressure. `onFrame` fires for each successfully-parsed
 * frame; malformed frames are dropped silently (the transport-adapter
 * is the one that decides whether to log them).
 *
 * `close` is one-way — once called, no further sends are attempted and
 * `onClose` fires. `onClose` is also called when the remote end hangs
 * up.
 */

import type { TunnelFrame } from "./frames.js"

export interface FrameSink {
  send(frame: TunnelFrame): void
  close(reason?: string): void
  onFrame(handler: (frame: TunnelFrame) => void): () => void
  onClose(handler: (reason?: string) => void): () => void
  /** True until `close` is called or the remote disconnects. */
  readonly isOpen: boolean
}
