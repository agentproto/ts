import { describe, it, expect } from "vitest"
import { createTunnelServer } from "../tunnel/server.js"
import type { FrameSink } from "../tunnel/transport.js"
import type { TunnelFrame } from "../tunnel/frames.js"

/** A FrameSink that just records what the server sends — enough to assert the
 *  hello frame the daemon greets the host with on construction. */
function recordingSink(): { sink: FrameSink; sent: TunnelFrame[] } {
  const sent: TunnelFrame[] = []
  let open = true
  const sink: FrameSink = {
    send: frame => {
      sent.push(frame)
    },
    close: () => {
      open = false
    },
    onFrame: () => () => {},
    onClose: () => () => {},
    get isOpen() {
      return open
    },
  }
  return { sink, sent }
}

const helloOf = (sent: TunnelFrame[]) =>
  sent.find(f => f.t === "hello") as
    | Extract<TunnelFrame, { t: "hello" }>
    | undefined

describe("tunnel hello capability announce", () => {
  it("announces the daemon's tools in the hello frame", () => {
    const { sink, sent } = recordingSink()
    createTunnelServer({
      sink,
      authorize: req => req,
      tools: ["claude", "codex", "browser"],
    })
    const hello = helloOf(sent)
    expect(hello).toBeDefined()
    expect(hello?.capabilities.tools).toEqual(["claude", "codex", "browser"])
  })

  it("omits tools when none are advertised (older-daemon parity)", () => {
    const { sink, sent } = recordingSink()
    createTunnelServer({ sink, authorize: req => req })
    const hello = helloOf(sent)
    expect(hello).toBeDefined()
    expect(hello?.capabilities.tools).toBeUndefined()
    // pty/wsForward still present — the announce is purely additive.
    expect(hello?.capabilities.pty).toBe(false)
  })
})
