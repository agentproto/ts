/**
 * A terminal that attaches to a running PTY session gets the recent output
 * replayed. Terminal queries sent by the child earlier (device attributes,
 * terminal identity, graphics probe, cell size, colour requests) must not be
 * part of that replay: the attaching terminal would answer them long after
 * the child stopped waiting, and the reply would land in the child's input.
 */

import { describe, it, expect } from "vitest"

import { createSessionsRegistry } from "../sessions.js"
import type { PtyFactory, PtyProcess } from "../sessions.js"
import { stripTerminalQueries } from "../terminal-query-filter.js"

const ESC = "\x1b"
const ST = `${ESC}\\`

const QUERIES: Record<string, string> = {
  "device attributes": `${ESC}[c`,
  "device attributes with parameter": `${ESC}[0c`,
  "secondary device attributes": `${ESC}[>0c`,
  "terminal identity": `${ESC}[>0q`,
  "keyboard protocol flags": `${ESC}[?u`,
  "cursor position report": `${ESC}[6n`,
  "private status report": `${ESC}[?996n`,
  "mode state": `${ESC}[?2026$p`,
  "cell size in pixels": `${ESC}[16t`,
  "window size in pixels": `${ESC}[14t`,
  "terminal capability string": `${ESC}P+q544e${ST}`,
  "setting string": `${ESC}P$qm${ST}`,
  "background colour request (ST)": `${ESC}]11;?${ST}`,
  "palette colour request (BEL)": `${ESC}]4;1;?\x07`,
  "graphics support probe": `${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ST}`,
  "graphics probe, query key first": `${ESC}_Ga=q,i=9,t=f,s=1,v=1,f=32;L3RtcC94${ST}`,
}

// Output that only draws: it must survive the replay unchanged.
const DRAWING = [
  `${ESC}[1;31mred${ESC}[0m`,
  `${ESC}[2J${ESC}[H`,
  `${ESC}[?1049h`,
  `${ESC}[?2026h`,
  `${ESC}[22;0t`, // save window title: not a report request
  `${ESC}]0;window title\x07`,
  `${ESC}]8;;https://example.com${ST}link${ESC}]8;;${ST}`,
  `${ESC}_Ga=T,f=100,t=f,i=7,c=10,r=4;L3RtcC9hLnBuZw==${ST}`, // image transmit
  "plain text, café ✓",
  `${ESC}[0n`, // status reply ("ready"), not a request: kept on purpose
]

describe("stripTerminalQueries", () => {
  for (const [name, seq] of Object.entries(QUERIES)) {
    it(`drops ${name}`, () => {
      const out = stripTerminalQueries(Buffer.from(`before${seq}after`, "utf8"))
      expect(out.toString("utf8")).toBe("beforeafter")
    })
  }

  it("keeps drawing output byte for byte", () => {
    const input = Buffer.from(DRAWING.join(""), "utf8")
    expect(stripTerminalQueries(input).equals(input)).toBe(true)
  })

  it("keeps drawing output and drops only the queries around it", () => {
    const mixed = `${DRAWING[0]}${QUERIES["graphics support probe"]}${DRAWING[5]}${QUERIES["device attributes"]}${DRAWING[7]}`
    expect(stripTerminalQueries(Buffer.from(mixed, "utf8")).toString("utf8")).toBe(
      `${DRAWING[0]}${DRAWING[5]}${DRAWING[7]}`,
    )
  })

  it("keeps non-text bytes intact", () => {
    const input = Buffer.from([0x00, 0xff, 0x1b, 0x5b, 0x6d, 0xc3, 0x28, 0x80])
    expect(stripTerminalQueries(input).equals(input)).toBe(true)
  })

  it("returns the same buffer when there is nothing to drop", () => {
    const input = Buffer.from("hello")
    expect(stripTerminalQueries(input)).toBe(input)
  })
})

describe("attachPty replay", () => {
  function setup() {
    let emit: (data: string) => void = () => {}
    const factory: PtyFactory = (): PtyProcess => ({
      pid: 4242,
      write: () => {},
      resize: () => {},
      kill: () => {},
      onData: handler => {
        emit = handler
      },
      onExit: () => {},
    })
    const registry = createSessionsRegistry({ persist: false, spawnPty: factory })
    const desc = registry.spawnPty({
      workspaceSlug: "default",
      cwd: process.cwd(),
      argv: ["bash"],
      cols: 80,
      rows: 24,
    })
    return { registry, id: desc.id, emit: (s: string) => emit(s) }
  }

  it("does not replay terminal queries to a terminal that attaches late", () => {
    const { registry, id, emit } = setup()
    emit(`startup${QUERIES["graphics support probe"]}${QUERIES["device attributes"]}`)
    emit(`${QUERIES["cell size in pixels"]}drawn ${DRAWING[0]}`)

    const received: Buffer[] = []
    const handle = registry.attachPty(id, { cols: 80, rows: 24 }, c => received.push(c), () => {})
    expect(handle).not.toBeNull()

    const replay = Buffer.concat(received).toString("utf8")
    expect(replay).toBe(`startupdrawn ${DRAWING[0]}`)
    handle?.detach()
  })

  it("recognises a query split across two output chunks", () => {
    const { registry, id, emit } = setup()
    const probe = QUERIES["graphics support probe"]!
    emit(`a${probe.slice(0, 9)}`)
    emit(`${probe.slice(9)}b`)

    const received: Buffer[] = []
    const handle = registry.attachPty(id, { cols: 80, rows: 24 }, c => received.push(c), () => {})
    expect(Buffer.concat(received).toString("utf8")).toBe("ab")
    handle?.detach()
  })

  it("still delivers live output, queries included, after attaching", () => {
    const { registry, id, emit } = setup()
    const received: Buffer[] = []
    const handle = registry.attachPty(id, { cols: 80, rows: 24 }, c => received.push(c), () => {})
    emit(`live${QUERIES["device attributes"]}`)
    expect(Buffer.concat(received).toString("utf8")).toBe(`live${QUERIES["device attributes"]}`)
    handle?.detach()
  })
})
