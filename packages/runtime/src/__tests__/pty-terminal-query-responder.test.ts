/**
 * Terminal queries sent by a PTY child get an answer: from the attached
 * terminal when there is one, from the daemon otherwise. The startup probe
 * below is the one Claude Code 2.1 sends under a PTY (captured raw): it
 * waits for the reply to the final DA1 (`CSI c`) before settling its
 * terminal capabilities, so an unanswered probe leaves it on its fallbacks.
 */

import { describe, it, expect } from "vitest"

import { createSessionsRegistry } from "../sessions.js"
import type { PtyFactory, PtyProcess } from "../sessions.js"
import {
  answerTerminalQuery,
  DEFAULT_TERMINAL_PROFILE,
  resolveTerminalQueryOptions,
  TerminalQueryScanner,
  type TerminalQueryOptions,
} from "../terminal-query-responder.js"

const ESC = "\x1b"
const ST = `${ESC}\\`

const STARTUP_PROBE = `${ESC}[>0q${ESC}[?u${ESC}]7501;?\x07${ESC}[c`
const SECOND_PROBE =
  `${ESC}[?2026$p${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ST}${ESC}[16t${ESC}[?1016$p${ESC}[c`

const size = { cols: 120, rows: 40 }

describe("TerminalQueryScanner", () => {
  it("reports each query and removes it from the stripped output", () => {
    const scanner = new TerminalQueryScanner()
    const { queries, withoutQueries: stripped } = scanner.feed(
      Buffer.from(`hi${ESC}[1mbold${STARTUP_PROBE}${ESC}[0m`, "latin1"),
    )
    expect(queries).toEqual([`${ESC}[>0q`, `${ESC}[?u`, `${ESC}]7501;?\x07`, `${ESC}[c`])
    expect(stripped.toString("latin1")).toBe(`hi${ESC}[1mbold${ESC}[0m`)
  })

  it("finds a query cut at every possible byte", () => {
    const probe = `${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ST}`
    const whole = `a${probe}${ESC}[c b`
    for (let cut = 1; cut < whole.length; cut++) {
      const scanner = new TerminalQueryScanner()
      const first = scanner.feed(Buffer.from(whole.slice(0, cut), "latin1"))
      const second = scanner.feed(Buffer.from(whole.slice(cut), "latin1"))
      expect([...first.queries, ...second.queries]).toEqual([probe, `${ESC}[c`])
      expect(
        Buffer.concat([first.withoutQueries, second.withoutQueries]).toString("latin1"),
      ).toBe("a b")
    }
  })

  it("keeps drawing output byte for byte, wherever it is cut", () => {
    const drawing =
      `${ESC}[2J${ESC}[H${ESC}[?1049h${ESC}]0;title\x07${ESC}]8;;https://example.com${ST}link` +
      `${ESC}]8;;${ST}${ESC}_Ga=T,f=100,i=7;AAAA${ST}${ESC}(B${ESC}7café ✓${ESC}[0n`
    const bytes = Buffer.from(drawing, "utf8")
    for (let cut = 0; cut <= bytes.length; cut++) {
      const scanner = new TerminalQueryScanner()
      const a = scanner.feed(bytes.subarray(0, cut))
      const b = scanner.feed(bytes.subarray(cut))
      expect(a.queries.length + b.queries.length).toBe(0)
      expect(Buffer.concat([a.withoutQueries, b.withoutQueries]).equals(bytes)).toBe(true)
    }
  })

  it("passes a long sequence on without holding it back", () => {
    const scanner = new TerminalQueryScanner()
    const payload = "A".repeat(4096)
    const head = scanner.feed(Buffer.from(`${ESC}_Ga=T,f=100;${payload}`, "latin1"))
    // Everything past the hold limit is already out, before the sequence ends.
    expect(head.withoutQueries.length).toBe(`${ESC}_Ga=T,f=100;${payload}`.length)
    const tail = scanner.feed(Buffer.from(`${ST}x`, "latin1"))
    expect(tail.withoutQueries.toString("latin1")).toBe(`${ST}x`)
  })

  it("lets an ESC end an unfinished sequence", () => {
    const scanner = new TerminalQueryScanner()
    const { queries, withoutQueries: stripped } = scanner.feed(Buffer.from(`${ESC}]0;tit${ESC}[c!`, "latin1"))
    expect(queries).toEqual([`${ESC}[c`])
    expect(stripped.toString("latin1")).toBe(`${ESC}]0;tit!`)
  })

  it("holds back the same bytes in both streams", () => {
    const scanner = new TerminalQueryScanner()
    const a = scanner.feed(Buffer.from(`x${ESC}[3`, "latin1"))
    expect(a.withQueries.toString("latin1")).toBe("x")
    expect(a.withoutQueries.toString("latin1")).toBe("x")
    const b = scanner.feed(Buffer.from(`1mred${ESC}[c`, "latin1"))
    expect(b.withQueries.toString("latin1")).toBe(`${ESC}[31mred${ESC}[c`)
    expect(b.withoutQueries.toString("latin1")).toBe(`${ESC}[31mred`)
  })

  it("releases a held sequence on flush", () => {
    const scanner = new TerminalQueryScanner()
    scanner.feed(Buffer.from(`${ESC}]0;title${ESC}`, "latin1"))
    expect(scanner.flush().toString("latin1")).toBe(`${ESC}]0;title${ESC}`)
    expect(scanner.flush().byteLength).toBe(0)
    expect(scanner.feed(Buffer.from("ok")).withoutQueries.toString()).toBe("ok")
  })

  it("returns the input buffer when there is nothing to remove", () => {
    const scanner = new TerminalQueryScanner()
    const input = Buffer.from(`plain ${ESC}[31mred`)
    expect(scanner.feed(input).withoutQueries).toBe(input)
  })
})

describe("answerTerminalQuery", () => {
  const profile = DEFAULT_TERMINAL_PROFILE
  it("answers the minimal set", () => {
    expect(answerTerminalQuery(`${ESC}[c`, profile, size)).toBe(`${ESC}[?62;22c`)
    expect(answerTerminalQuery(`${ESC}[0c`, profile, size)).toBe(`${ESC}[?62;22c`)
    expect(answerTerminalQuery(`${ESC}[>c`, profile, size)).toBe(`${ESC}[>1;10;0c`)
    expect(answerTerminalQuery(`${ESC}[>0q`, profile, size)).toBe(`${ESC}P>|agentproto${ST}`)
    expect(answerTerminalQuery(`${ESC}[5n`, profile, size)).toBe(`${ESC}[0n`)
    expect(answerTerminalQuery(`${ESC}[?2026$p`, profile, size)).toBe(`${ESC}[?2026;2$y`)
    expect(answerTerminalQuery(`${ESC}[?1016$p`, profile, size)).toBe(`${ESC}[?1016;0$y`)
    expect(answerTerminalQuery(`${ESC}[4$p`, profile, size)).toBe(`${ESC}[4;0$y`)
    expect(answerTerminalQuery(`${ESC}[16t`, profile, size)).toBe(`${ESC}[6;20;10t`)
    expect(answerTerminalQuery(`${ESC}[14t`, profile, size)).toBe(`${ESC}[4;800;1200t`)
    expect(answerTerminalQuery(`${ESC}[18t`, profile, size)).toBe(`${ESC}[8;40;120t`)
  })

  it("stays silent on what it cannot know or does not offer", () => {
    for (const q of [
      `${ESC}[6n`, // cursor position: no screen model
      `${ESC}[?u`, // keyboard protocol: depends on the client
      `${ESC}]11;?${ST}`,
      `${ESC}]7501;?\x07`,
      `${ESC}P+q544e${ST}`,
      `${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ST}`,
    ]) {
      expect(answerTerminalQuery(q, profile, size)).toBeUndefined()
    }
  })

  it("reports graphics support only when the profile enables it", () => {
    const probe = `${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ST}`
    const withGraphics = { ...profile, graphics: true }
    expect(answerTerminalQuery(probe, withGraphics, size)).toBe(`${ESC}_Gi=31;OK${ST}`)
    expect(answerTerminalQuery(`${ESC}_Ga=q,t=d;AAAA${ST}`, withGraphics, size)).toBeUndefined()
  })
})

describe("resolveTerminalQueryOptions", () => {
  it("defaults to auto with the default profile", () => {
    expect(resolveTerminalQueryOptions(undefined, {})).toEqual({
      mode: "auto",
      profile: DEFAULT_TERMINAL_PROFILE,
    })
  })

  it("reads the config, and the environment over it", () => {
    const config = {
      terminalQueries: "off",
      terminalGraphics: true,
      terminalCellSize: "8x16",
      terminalName: "ghostty 1.2.3",
    }
    expect(resolveTerminalQueryOptions(config, {})).toEqual({
      mode: "off",
      profile: { name: "ghostty 1.2.3", graphics: true, cellWidth: 8, cellHeight: 16 },
    })
    expect(
      resolveTerminalQueryOptions(config, {
        AGENTPROTO_PTY_QUERIES: "auto",
        AGENTPROTO_PTY_GRAPHICS: "0",
        AGENTPROTO_PTY_CELL_SIZE: "9x18",
        AGENTPROTO_PTY_TERMINAL_NAME: "kitty(0.40.0)",
      }),
    ).toEqual({
      mode: "auto",
      profile: { name: "kitty(0.40.0)", graphics: false, cellWidth: 9, cellHeight: 18 },
    })
  })

  it("ignores unreadable values", () => {
    expect(
      resolveTerminalQueryOptions(
        { terminalCellSize: "0x20", terminalName: "bad\x1bname" },
        { AGENTPROTO_PTY_QUERIES: "sometimes", AGENTPROTO_PTY_GRAPHICS: "maybe" },
      ),
    ).toEqual({ mode: "auto", profile: DEFAULT_TERMINAL_PROFILE })
  })
})

describe("PTY sessions answer terminal queries", () => {
  function setup(terminalQueries?: TerminalQueryOptions) {
    let emit: (data: string) => void = () => {}
    let exit: (evt: { exitCode: number }) => void = () => {}
    const written: string[] = []
    const resizes: unknown[][] = []
    const factory: PtyFactory = (): PtyProcess => ({
      pid: 4242,
      write: data => {
        written.push(data)
      },
      resize: (...args: unknown[]) => {
        resizes.push(args)
      },
      kill: () => {},
      onData: handler => {
        emit = handler
      },
      onExit: handler => {
        exit = handler
      },
    })
    const registry = createSessionsRegistry({
      persist: false,
      spawnPty: factory,
      ...(terminalQueries ? { terminalQueries } : {}),
    })
    const desc = registry.spawnPty({
      workspaceSlug: "default",
      cwd: process.cwd(),
      argv: ["claude"],
      cols: 120,
      rows: 40,
    })
    const attach = (answersQueries?: boolean) => {
      const received: Buffer[] = []
      const flagged: string[] = []
      const handle = registry.attachPty(
        desc.id,
        { cols: 120, rows: 40 },
        (c, info) => {
          received.push(c)
          if (info?.carriesQueries) flagged.push(c.toString("latin1"))
        },
        () => {},
        answersQueries === undefined ? undefined : { answersQueries },
      )
      expect(handle).not.toBeNull()
      return { handle: handle!, flagged, text: () => Buffer.concat(received).toString("latin1") }
    }
    return { emit: (s: string) => emit(s), exit: () => exit({ exitCode: 0 }), written, resizes, attach }
  }

  it("answers the startup probe when no terminal is attached", () => {
    const { emit, written } = setup()
    emit(STARTUP_PROBE)
    expect(written).toEqual([`${ESC}P>|agentproto${ST}`, `${ESC}[?62;22c`])
    written.length = 0
    emit(SECOND_PROBE)
    expect(written).toEqual([`${ESC}[?2026;2$y`, `${ESC}[6;20;10t`, `${ESC}[?1016;0$y`, `${ESC}[?62;22c`])
  })

  it("answers a probe split across two output chunks", () => {
    const { emit, written } = setup()
    emit(`${ESC}[>`)
    emit(`0q${ESC}`)
    emit("[c")
    expect(written).toEqual([`${ESC}P>|agentproto${ST}`, `${ESC}[?62;22c`])
  })

  it("leaves the queries to an attached terminal, and only to the latest one", () => {
    const { emit, written, attach } = setup()
    const older = attach()
    const latest = attach()
    emit(`draw${STARTUP_PROBE}more`)
    expect(written).toEqual([])
    expect(latest.text()).toBe(`draw${STARTUP_PROBE}more`)
    expect(older.text()).toBe("drawmore")
    // The latest detaches: the older one answers from now on.
    latest.handle.detach()
    emit(`${ESC}[c`)
    expect(older.text()).toBe(`drawmore${ESC}[c`)
    expect(written).toEqual([])
    older.handle.detach()
    emit(`${ESC}[c`)
    expect(written).toEqual([`${ESC}[?62;22c`])
  })

  it("keeps every client's stream whole when the answering client changes mid-sequence", () => {
    const { emit, attach } = setup()
    const older = attach()
    const latest = attach()
    emit(`a${ESC}[3`)
    latest.handle.detach() // `older` answers from now on
    emit(`1mb`)
    expect(older.text()).toBe(`a${ESC}[31mb`)
    expect(latest.text()).toBe("a")
    const newest = attach()
    emit(`c${ESC}[`)
    attach().handle.detach() // a client comes and goes mid-sequence
    emit(`0m`)
    expect(older.text()).toBe(`a${ESC}[31mbc${ESC}[0m`)
    expect(newest.text().endsWith(`c${ESC}[0m`)).toBe(true)
  })

  it("tells the transport which chunks carry queries for its client", () => {
    const { emit, attach } = setup()
    const older = attach()
    const latest = attach()
    emit(`draw`)
    emit(`x${ESC}[c`)
    expect(latest.flagged).toEqual([`x${ESC}[c`])
    expect(older.flagged).toEqual([])
  })

  it("delivers held bytes before the exit", () => {
    const { emit, exit, attach } = setup()
    const viewer = attach(false)
    emit(`bye${ESC}]0;tit`)
    expect(viewer.text()).toBe("bye")
    exit()
    expect(viewer.text()).toBe(`bye${ESC}]0;tit`)
  })

  it("answers itself when the attached clients do not answer queries", () => {
    const { emit, written, attach } = setup()
    const viewer = attach(false)
    emit(`x${ESC}[c`)
    expect(written).toEqual([`${ESC}[?62;22c`])
    expect(viewer.text()).toBe("x")
  })

  it("reports graphics support only when configured to", () => {
    const probe = `${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ST}`
    const off = setup()
    off.emit(probe)
    expect(off.written).toEqual([])
    const on = setup({ mode: "auto", profile: { ...DEFAULT_TERMINAL_PROFILE, graphics: true } })
    on.emit(probe)
    expect(on.written).toEqual([`${ESC}_Gi=31;OK${ST}`])
  })

  it("in mode off, neither answers nor filters", () => {
    const { emit, written, attach } = setup({ mode: "off", profile: DEFAULT_TERMINAL_PROFILE })
    emit(STARTUP_PROBE)
    expect(written).toEqual([])
    const older = attach()
    attach()
    emit(`${ESC}[c`)
    expect(older.text().endsWith(`${ESC}[c`)).toBe(true)
  })

  it("passes the pixel size of the window to the PTY on resize", () => {
    const { resizes, attach } = setup()
    const client = attach()
    client.handle.resize(100, 30)
    expect(resizes.at(-1)).toEqual([100, 30, { width: 1000, height: 600 }])
  })
})
