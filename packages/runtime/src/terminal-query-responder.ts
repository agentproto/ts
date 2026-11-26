/**
 * Terminal queries on a daemon PTY: who answers them.
 *
 * A TUI started under a daemon PTY (Claude Code, for instance) asks the
 * terminal what it can do before drawing anything: XTVERSION (`CSI > q`),
 * keyboard protocol flags (`CSI ? u`), graphics support (`APC G … a=q`),
 * cell size (`CSI 16 t`), mode state (`CSI ? 2026 $ p`), and ends with
 * device attributes (`CSI c`), which every terminal answers and which
 * therefore marks the end of the probe. Nothing sits at the other end of a
 * PTY spawned without an attached client, so nothing answered: the child
 * kept waiting for the DA1 reply, never settled its capabilities, and ran
 * with its fallbacks (no images, no synchronized output, ...).
 *
 * The rule applied by the sessions registry:
 *   - when a terminal client is attached, the most recently attached one
 *     sees the queries and answers them itself (its real capabilities
 *     reach the child); every other client gets the stream without the
 *     queries, so the child never receives two replies;
 *   - when no terminal client is attached, the daemon answers a small,
 *     consistent set itself ({@link answerTerminalQuery}).
 *
 * {@link TerminalQueryScanner} cuts the output stream into escape
 * sequences, across chunk boundaries, and reports the complete queries.
 */

import { isTerminalQuery } from "./terminal-query-filter.js"

const ESC = "\x1b"
const ST = `${ESC}\\`

/** What the daemon says about itself when it answers queries. */
export interface TerminalProfile {
  /** Name returned for XTVERSION (`DCS > | name ST`). Some programs only
   *  use a feature on terminals they know by name: Claude Code draws images
   *  only when this names a terminal it supports (kitty, Ghostty, iTerm2),
   *  even with `graphics` on. */
  name: string
  /** Size of one cell in pixels, used for `CSI 14 t`, `CSI 16 t` and the
   *  pixel fields of the PTY window size. */
  cellWidth: number
  cellHeight: number
  /** Answer the graphics support probe with "OK". Only enable it when the
   *  terminals attached to the sessions really display that protocol. */
  graphics: boolean
}

export const DEFAULT_TERMINAL_PROFILE: TerminalProfile = {
  name: "agentproto",
  cellWidth: 10,
  cellHeight: 20,
  graphics: false,
}

/** `auto`: an attached terminal answers, else the daemon does.
 *  `off`: queries go to the clients untouched and the daemon never answers
 *  (behaviour before this option existed). */
export type TerminalQueryMode = "auto" | "off"

export interface TerminalQueryOptions {
  mode: TerminalQueryMode
  profile: TerminalProfile
}

export const TERMINAL_QUERIES_ENV = "AGENTPROTO_PTY_QUERIES"
export const TERMINAL_GRAPHICS_ENV = "AGENTPROTO_PTY_GRAPHICS"
export const TERMINAL_CELL_SIZE_ENV = "AGENTPROTO_PTY_CELL_SIZE"
export const TERMINAL_NAME_ENV = "AGENTPROTO_PTY_TERMINAL_NAME"

/** Config keys read by {@link resolveTerminalQueryOptions}
 *  (`sessions.terminalQueries`, ...). */
export interface TerminalQueryConfig {
  terminalQueries?: string
  terminalGraphics?: boolean
  terminalCellSize?: string
  terminalName?: string
}

/** Printable ASCII only: the name is written inside a DCS string. */
export const TERMINAL_NAME_PATTERN = /^[\x20-\x7e]{1,64}$/

function parseName(raw: string | undefined): string | undefined {
  const v = raw?.trim()
  return v && TERMINAL_NAME_PATTERN.test(v) ? v : undefined
}

function parseCellSize(raw: string | undefined): { width: number; height: number } | undefined {
  const m = raw ? /^\s*(\d{1,3})\s*x\s*(\d{1,3})\s*$/i.exec(raw) : null
  if (!m) return undefined
  const width = Number(m[1])
  const height = Number(m[2])
  return width > 0 && height > 0 ? { width, height } : undefined
}

function parseBool(raw: string | undefined): boolean | undefined {
  const v = raw?.trim().toLowerCase()
  if (!v) return undefined
  if (["1", "true", "yes", "on"].includes(v)) return true
  if (["0", "false", "no", "off"].includes(v)) return false
  return undefined
}

/** Environment variable > config field > default, per field. Unreadable
 *  values fall back to the next source. */
export function resolveTerminalQueryOptions(
  config: TerminalQueryConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): TerminalQueryOptions {
  const modeOf = (raw: string | undefined): TerminalQueryMode | undefined => {
    const v = raw?.trim().toLowerCase()
    return v === "auto" || v === "off" ? v : undefined
  }
  const mode = modeOf(env[TERMINAL_QUERIES_ENV]) ?? modeOf(config?.terminalQueries) ?? "auto"
  const graphics =
    parseBool(env[TERMINAL_GRAPHICS_ENV]) ??
    config?.terminalGraphics ??
    DEFAULT_TERMINAL_PROFILE.graphics
  const cell = parseCellSize(env[TERMINAL_CELL_SIZE_ENV]) ?? parseCellSize(config?.terminalCellSize)
  const name =
    parseName(env[TERMINAL_NAME_ENV]) ?? parseName(config?.terminalName) ?? DEFAULT_TERMINAL_PROFILE.name
  return {
    mode,
    profile: {
      ...DEFAULT_TERMINAL_PROFILE,
      name,
      graphics,
      ...(cell ? { cellWidth: cell.width, cellHeight: cell.height } : {}),
    },
  }
}

/** Pixel size of a `cols` x `rows` grid for the PTY window size. */
export function pixelSizeOf(
  profile: TerminalProfile,
  size: { cols: number; rows: number },
): { width: number; height: number } {
  return { width: size.cols * profile.cellWidth, height: size.rows * profile.cellHeight }
}

/**
 * The daemon's own answer to `query` (one complete sequence, latin1), or
 * undefined when it stays silent. Silence is the right answer for what
 * the daemon cannot know or does not offer: the cursor position (there is
 * no screen model here), the keyboard protocol flags and colour requests
 * (they depend on the client), and graphics unless the profile enables it.
 * DA1 is always answered, so a child that ends its probe with it stops
 * waiting.
 */
export function answerTerminalQuery(
  query: string,
  profile: TerminalProfile,
  size: { cols: number; rows: number },
): string | undefined {
  // Primary device attributes: VT220 with ANSI colour.
  if (/^\x1b\[0?c$/.test(query)) return `${ESC}[?62;22c`
  // Secondary device attributes: VT220, firmware 10, no ROM cartridge.
  if (/^\x1b\[>0?c$/.test(query)) return `${ESC}[>1;10;0c`
  if (/^\x1b\[>0?q$/.test(query)) return `${ESC}P>|${profile.name}${ST}`
  // Operating status: ready.
  if (query === `${ESC}[5n`) return `${ESC}[0n`
  let m = /^\x1b\[\?([0-9]+)\$p$/.exec(query)
  if (m) {
    // Synchronized output only changes how the client paints: a client
    // without it ignores the markers, so it is safe to report as available
    // (2 = reset). Any other mode is reported as not recognised (0).
    const state = m[1] === "2026" ? 2 : 0
    return `${ESC}[?${m[1]};${state}$y`
  }
  m = /^\x1b\[([0-9]+)\$p$/.exec(query)
  if (m) return `${ESC}[${m[1]};0$y`
  if (query === `${ESC}[14t`) {
    const px = pixelSizeOf(profile, size)
    return `${ESC}[4;${px.height};${px.width}t`
  }
  if (query === `${ESC}[16t`) return `${ESC}[6;${profile.cellHeight};${profile.cellWidth}t`
  if (query === `${ESC}[18t`) return `${ESC}[8;${size.rows};${size.cols}t`
  if (query.startsWith(`${ESC}_G`) && profile.graphics) {
    // The graphics protocol only replies to a request that carries an id.
    const id = /(?:_G|,)i=([0-9]+)/.exec(query)
    if (id) return `${ESC}_Gi=${id[1]};OK${ST}`
  }
  return undefined
}

/** A sequence longer than this is not held back: no query is that long,
 *  and image data must not be delayed. */
const MAX_HELD = 512

type State = "ground" | "esc" | "escInt" | "csi" | "osc" | "str" | "oscEsc" | "strEsc"

/**
 * Splits a PTY output stream into escape sequences, keeping its state
 * between chunks, so a query cut in two by the PTY read is still found.
 *
 * `feed` returns the complete queries ended by this chunk and `stripped`,
 * the chunk without those queries. Bytes of a sequence still incomplete at
 * the end of a chunk are held until it completes (or grows past
 * `MAX_HELD`, then they are passed on as they come): they belong in
 * `stripped` only if the sequence turns out not to be a query.
 */
export class TerminalQueryScanner {
  private state: State = "ground"
  private seq = ""
  private overflow = false

  feed(chunk: Buffer): { queries: string[]; stripped: Buffer } {
    const text = chunk.toString("latin1")
    if (this.state === "ground" && !text.includes(ESC)) {
      return { queries: [], stripped: chunk }
    }
    const queries: string[] = []
    let out = ""
    let i = 0
    const startSequence = (): void => {
      this.seq = ESC
      this.overflow = false
      this.state = "esc"
    }
    const finish = (): void => {
      if (!this.overflow && isTerminalQuery(this.seq)) {
        queries.push(this.seq)
      } else if (!this.overflow) {
        out += this.seq
      }
      this.seq = ""
      this.overflow = false
      this.state = "ground"
    }
    // An ESC inside a sequence ends it unfinished: pass it on as is.
    const abandon = (): void => {
      if (!this.overflow) out += this.seq
      this.seq = ""
      this.overflow = false
    }
    const append = (c: string): void => {
      if (this.overflow) {
        out += c
        return
      }
      this.seq += c
      if (this.seq.length > MAX_HELD) {
        out += this.seq
        this.seq = ""
        this.overflow = true
      }
    }

    while (i < text.length) {
      if (this.state === "ground") {
        const next = text.indexOf(ESC, i)
        if (next === -1) {
          out += text.slice(i)
          i = text.length
          break
        }
        out += text.slice(i, next)
        startSequence()
        i = next + 1
        continue
      }
      const c = text[i]!
      const code = c.charCodeAt(0)
      i++
      switch (this.state) {
        case "esc":
          if (c === ESC) {
            abandon()
            startSequence()
            break
          }
          append(c)
          if (c === "[") this.state = "csi"
          else if (c === "]") this.state = "osc"
          else if (c === "P" || c === "_" || c === "^" || c === "X") this.state = "str"
          else if (code >= 0x20 && code <= 0x2f) this.state = "escInt"
          else finish()
          break
        case "escInt":
          if (c === ESC) {
            abandon()
            startSequence()
            break
          }
          append(c)
          if (code >= 0x30 && code <= 0x7e) finish()
          break
        case "csi":
          if (c === ESC) {
            abandon()
            startSequence()
            break
          }
          append(c)
          if (code >= 0x40 && code <= 0x7e) finish()
          else if (code === 0x18 || code === 0x1a) {
            // CAN / SUB cancel the sequence.
            abandon()
            this.state = "ground"
          }
          break
        case "osc":
        case "str":
          // The ESC that may start ST is kept aside until the next byte
          // says whether it ends this string or starts a new sequence.
          if (c === ESC) this.state = this.state === "osc" ? "oscEsc" : "strEsc"
          else {
            append(c)
            if (this.state === "osc" && code === 0x07) finish()
          }
          break
        case "oscEsc":
        case "strEsc":
          if (c === "\\") {
            append(ESC)
            append(c)
            finish()
          } else {
            // The ESC began a new sequence: the string ends unfinished.
            abandon()
            startSequence()
            i-- // read `c` again as the byte after ESC
          }
          break
      }
    }
    if (out === text) return { queries, stripped: chunk }
    return { queries, stripped: Buffer.from(out, "latin1") }
  }
}
