/**
 * Role `contextFiles`: files a role wants in front of every session spawned
 * with it, injected into the initial prompt right after the role disposition,
 * each fenced by `<tag>...</tag>`.
 *
 * Declared in ROLE.md frontmatter as `contextFiles: tag=path, tag2=path2`.
 * First user: the `recherche` role and the repo map `<carte-depots>`
 * (agentik-studio `docs/agents/recherche-large-contrat.md`): an agent asked to
 * "look globally" starts with the list of every repo in front of it instead of
 * the handful it remembers.
 *
 * Advisory like RULES.md: an unreadable file never blocks a spawn. A missing
 * file is announced in the prompt (`<tag absent="path"/>`) so the agent knows
 * to fall back on listing the repos itself.
 */

import { readFile as fsReadFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

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
    if (!TAG_RE.test(tag) || !path) {
      throw new Error(
        `parseRolePack: invalid 'contextFiles' entry "${item}" (expected tag=path, tag matching ${TAG_RE})`,
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
  readFile?: (path: string) => Promise<string>
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
  const read = deps.readFile ?? ((p: string) => fsReadFile(p, "utf8"))
  const blocks: string[] = []
  for (const { tag, path } of files) {
    const resolved = expandContextPath(path, env, home)
    if (resolved === undefined) continue
    try {
      const content = await read(join(resolved))
      const buf = Buffer.from(content, "utf8")
      const body =
        buf.byteLength > maxBytes
          ? `${buf.subarray(0, maxBytes).toString("utf8")}\n[tronqué à ${maxBytes} octets]`
          : content.trimEnd()
      blocks.push(`<${tag}>\n${body}\n</${tag}>`)
    } catch {
      blocks.push(`<${tag} absent="${resolved}"/>`)
    }
  }
  return blocks
}
