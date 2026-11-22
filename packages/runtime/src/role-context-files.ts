/**
 * Role `contextFiles`: files a role wants in front of every session spawned
 * with it, injected into the initial prompt right after the role disposition,
 * each fenced by `<tag>...</tag>`.
 *
 * Declared in ROLE.md frontmatter as `contextFiles: tag=path, tag2=path2`.
 * First user: the `recherche` role and the repo map `<carte-depots>`
 * (see the `recherche-large` skill): an agent asked to
 * "look globally" starts with the list of every repo in front of it instead of
 * the handful it remembers.
 *
 * Trust: the daemon reads these paths on the HOST with its own rights and ships
 * the bytes to the model provider, outside any session read grant or command
 * sandbox. Only a role pack the operator installed can declare them (same trust
 * as the disposition). The spawn skips them for device sandbox spawns, like
 * AGENTS.md and RULES.md. Paths must be absolute, `~/...` or start with `$VAR`
 * (a relative path would silently resolve against the daemon's cwd).
 *
 * Advisory like RULES.md: an unreadable file never blocks a spawn. A missing
 * file is announced in the prompt (`<tag absent="path"/>`) so the agent knows
 * to fall back on listing the repos itself.
 */

import { constants } from "node:fs"
import { open, stat } from "node:fs/promises"
import { homedir } from "node:os"

import type { RoleProfile } from "./role.js"

export const CONTEXT_FILE_MAX_BYTES = 64 * 1024

const TAG_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

export interface RoleContextFile {
  tag: string
  path: string
}

/** Parse the `contextFiles` frontmatter value (`tag=path, tag2=path2`). */
export function parseContextFiles(value: string | undefined): RoleContextFile[] | undefined {
  if (value === undefined || value.trim() === "") return undefined
  const out: RoleContextFile[] = []
  for (const raw of value.replace(/^\[/, "").replace(/\]$/, "").split(",")) {
    const item = raw.trim()
    if (!item) continue
    const eq = item.indexOf("=")
    const tag = eq < 1 ? "" : item.slice(0, eq).trim()
    const path = eq < 1 ? "" : item.slice(eq + 1).trim()
    if (!TAG_RE.test(tag) || !path || !/^(\/|~(\/|$)|\$)/.test(path)) {
      throw new Error(
        `parseRolePack: invalid 'contextFiles' entry "${item}" (expected tag=path, tag matching ${TAG_RE}, path absolute, ~/... or $VAR/...)`,
      )
    }
    out.push({ tag, path })
  }
  return out.length > 0 ? out : undefined
}

/** Expand `~` and `$VAR` / `${VAR}`. Undefined when a referenced variable is unset. */
export function expandContextPath(
  path: string,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string | undefined {
  let unset = false
  const expanded = path
    .replace(/^~(?=\/|$)/, home)
    .replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, a: string | undefined, b: string | undefined) => {
      const v = env[(a ?? b) as string]
      if (v === undefined || v === "") {
        unset = true
        return ""
      }
      return v
    })
  return unset ? undefined : expanded
}

export interface ComposeContextFilesDeps {
  env?: Readonly<Record<string, string | undefined>>
  home?: string
  maxBytes?: number
  /** Returns at most `maxBytes + 1` bytes of the file (a regular file; anything else rejects). */
  readFile?: (path: string, maxBytes: number) => Promise<Buffer>
}

async function readBounded(path: string, maxBytes: number): Promise<Buffer> {
  // stat BEFORE open: opening a FIFO for reading blocks until a writer shows up.
  if (!(await stat(path)).isFile()) throw new Error("not a regular file")
  const fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const want = maxBytes + 1
    const buf = Buffer.alloc(want)
    let total = 0
    while (total < want) {
      const { bytesRead } = await fh.read(buf, total, want - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    return buf.subarray(0, total)
  } finally {
    await fh.close()
  }
}

/** Cut a UTF-8 byte buffer to at most `max` bytes, on a codepoint boundary. */
function cutUtf8(buf: Buffer, max: number): string {
  if (buf.byteLength <= max) return buf.toString("utf8")
  let end = max
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1
  return buf.subarray(0, end).toString("utf8")
}

/** Keep the file from closing its own fence. */
function neutralizeFence(body: string, tag: string): string {
  return body.replace(new RegExp(`</${tag}>`, "gi"), `<\\/${tag}>`)
}

/** One prompt block per declared file. Never throws. */
export async function composeContextFiles(
  role: Pick<RoleProfile, "contextFiles">,
  deps: ComposeContextFilesDeps = {},
): Promise<string[]> {
  const files = role.contextFiles
  if (!files || files.length === 0) return []
  const env = deps.env ?? process.env
  const home = deps.home ?? homedir()
  const maxBytes = deps.maxBytes ?? CONTEXT_FILE_MAX_BYTES
  const read = deps.readFile ?? readBounded
  const blocks: string[] = []
  for (const { tag, path } of files) {
    const resolved = expandContextPath(path, env, home)
    if (resolved === undefined) continue
    try {
      const buf = await read(resolved, maxBytes)
      const text = buf.byteLength > maxBytes ? cutUtf8(buf, maxBytes) : buf.toString("utf8").trimEnd()
      const body = buf.byteLength > maxBytes ? `${text}\n[tronqué à ${maxBytes} octets]` : text
      blocks.push(`<${tag}>\n${neutralizeFence(body, tag)}\n</${tag}>`)
    } catch {
      blocks.push(`<${tag} absent="${resolved.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)}"/>`)
    }
  }
  return blocks
}
