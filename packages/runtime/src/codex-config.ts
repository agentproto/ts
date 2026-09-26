/**
 * codex-config — read the `[mcp_servers.<name>]` tables out of a codex
 * `config.toml` (`~/.codex/config.toml`, `<project>/.codex/config.toml`).
 *
 * `@agentproto/runtime` has no TOML dependency (the only parser in the
 * pnpm store, smol-toml, is a transitive dep of an unrelated package), so
 * this carries a small parser for the subset codex's own config uses:
 * `[table]` / `[a."b.c"]` headers, dotted/quoted keys, basic + literal
 * strings (incl. multi-line), numbers, booleans, arrays (multi-line) and
 * inline tables. `[[array.of.tables]]` blocks are skipped — codex keeps
 * no MCP config in them. Anything the parser can't read throws with a
 * line number; callers treat a bad file as "no servers found here".
 */

import { promises as fs } from "node:fs"

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable
export interface TomlTable {
  [key: string]: TomlValue
}

/** A codex `[mcp_servers.<name>]` entry mapped onto the `.mcp.json`
 *  field names the rest of discovery speaks. */
export interface CodexMcpServerEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

/**
 * Parse `config.toml` text and return its `mcp_servers` map.
 *
 * Field mapping (codex → mcpServers shape):
 *   command / args / env             → same (stdio)
 *   url                              → url (streamable http)
 *   http_headers                     → headers
 *   env_http_headers { H = "VAR" }   → headers { H: "${VAR}" }
 *   bearer_token_env_var = "VAR"     → headers.Authorization "Bearer ${VAR}"
 * Header placeholders stay unexpanded here (discovery never holds a
 * secret it read from the environment); the client pool expands them at
 * connect time.
 */
export function parseCodexMcpServers(text: string): Record<string, CodexMcpServerEntry> {
  const root = parseToml(text)
  const servers = root.mcp_servers
  if (!isTable(servers)) return {}
  const out: Record<string, CodexMcpServerEntry> = {}
  for (const [name, raw] of Object.entries(servers)) {
    if (!isTable(raw)) continue
    const entry: CodexMcpServerEntry = {}
    if (typeof raw.command === "string") entry.command = raw.command
    if (Array.isArray(raw.args)) {
      entry.args = raw.args.filter((a): a is string => typeof a === "string")
    }
    if (isTable(raw.env)) entry.env = stringTable(raw.env)
    if (typeof raw.url === "string") entry.url = raw.url
    const headers: Record<string, string> = {}
    if (isTable(raw.http_headers)) Object.assign(headers, stringTable(raw.http_headers))
    if (isTable(raw.env_http_headers)) {
      for (const [h, v] of Object.entries(raw.env_http_headers)) {
        if (typeof v === "string") headers[h] = `\${${v}}`
      }
    }
    if (typeof raw.bearer_token_env_var === "string") {
      headers.Authorization = `Bearer \${${raw.bearer_token_env_var}}`
    }
    if (Object.keys(headers).length > 0) entry.headers = headers
    out[name] = entry
  }
  return out
}

/** Read + parse a codex config file. Missing file → `{}`; unreadable or
 *  unparseable → throws (the caller decides whether that's fatal). */
export async function readCodexMcpServers(
  path: string
): Promise<Record<string, CodexMcpServerEntry>> {
  let text: string
  try {
    text = await fs.readFile(path, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw err
  }
  return parseCodexMcpServers(text)
}

function isTable(v: TomlValue | undefined): v is TomlTable {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function stringTable(t: TomlTable): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(t)) {
    if (typeof v === "string") out[k] = v
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v)
  }
  return out
}

/** Parse the TOML subset described in the module header. */
export function parseToml(text: string): TomlTable {
  return new TomlParser(text).parse()
}

class TomlParser {
  private pos = 0

  constructor(private readonly src: string) {}

  parse(): TomlTable {
    const root: TomlTable = {}
    // null while inside a skipped `[[array-of-tables]]` block.
    let current: TomlTable | null = root
    for (;;) {
      this.skipWsCommentsNewlines()
      if (this.pos >= this.src.length) return root
      if (this.src[this.pos] === "[") {
        if (this.src[this.pos + 1] === "[") {
          this.pos += 2
          this.parseKeyPath()
          this.expect("]")
          this.expect("]")
          current = null
        } else {
          this.pos += 1
          const path = this.parseKeyPath()
          this.expect("]")
          current = this.descend(root, path)
        }
        this.endOfLine()
        continue
      }
      const path = this.parseKeyPath()
      this.skipInlineWs()
      this.expect("=")
      this.skipInlineWs()
      const value = this.parseValue()
      if (current) this.assign(current, path, value)
      this.endOfLine()
    }
  }

  private descend(table: TomlTable, path: string[]): TomlTable {
    let t = table
    for (const key of path) {
      const next = t[key]
      if (next === undefined) {
        const created: TomlTable = {}
        t[key] = created
        t = created
      } else if (isTable(next)) {
        t = next
      } else {
        throw this.error(`key "${key}" is not a table`)
      }
    }
    return t
  }

  private assign(table: TomlTable, path: string[], value: TomlValue): void {
    const parent = this.descend(table, path.slice(0, -1))
    parent[path[path.length - 1]!] = value
  }

  private parseKeyPath(): string[] {
    const keys: string[] = []
    for (;;) {
      this.skipInlineWs()
      keys.push(this.parseKey())
      this.skipInlineWs()
      if (this.src[this.pos] !== ".") return keys
      this.pos += 1
    }
  }

  private parseKey(): string {
    const ch = this.src[this.pos]
    if (ch === '"') return this.parseBasicString()
    if (ch === "'") return this.parseLiteralString()
    const m = /^[A-Za-z0-9_-]+/.exec(this.src.slice(this.pos))
    if (!m) throw this.error("expected a key")
    this.pos += m[0].length
    return m[0]
  }

  private parseValue(): TomlValue {
    const rest = this.src.slice(this.pos)
    if (rest.startsWith('"""')) return this.parseMultilineBasic()
    if (rest.startsWith("'''")) return this.parseMultilineLiteral()
    const ch = rest[0]
    if (ch === '"') return this.parseBasicString()
    if (ch === "'") return this.parseLiteralString()
    if (ch === "[") return this.parseArray()
    if (ch === "{") return this.parseInlineTable()
    if (rest.startsWith("true")) {
      this.pos += 4
      return true
    }
    if (rest.startsWith("false")) {
      this.pos += 5
      return false
    }
    // Numbers and dates/times: take the bare token; numbers become numbers,
    // anything else (dates) is kept as its source text.
    const m = /^[0-9A-Za-z+\-_.:]+/.exec(rest)
    if (!m) throw this.error("expected a value")
    this.pos += m[0].length
    const n = Number(m[0].replace(/_/g, ""))
    return Number.isNaN(n) ? m[0] : n
  }

  private parseArray(): TomlValue[] {
    this.expect("[")
    const out: TomlValue[] = []
    for (;;) {
      this.skipWsCommentsNewlines()
      if (this.src[this.pos] === "]") {
        this.pos += 1
        return out
      }
      out.push(this.parseValue())
      this.skipWsCommentsNewlines()
      if (this.src[this.pos] === ",") {
        this.pos += 1
        continue
      }
      this.expect("]")
      return out
    }
  }

  private parseInlineTable(): TomlTable {
    this.expect("{")
    const out: TomlTable = {}
    this.skipInlineWs()
    if (this.src[this.pos] === "}") {
      this.pos += 1
      return out
    }
    for (;;) {
      const path = this.parseKeyPath()
      this.skipInlineWs()
      this.expect("=")
      this.skipInlineWs()
      this.assign(out, path, this.parseValue())
      this.skipInlineWs()
      if (this.src[this.pos] === ",") {
        this.pos += 1
        continue
      }
      this.expect("}")
      return out
    }
  }

  private parseBasicString(): string {
    this.expect('"')
    let out = ""
    for (;;) {
      const ch = this.src[this.pos]
      if (ch === undefined || ch === "\n") throw this.error("unterminated string")
      this.pos += 1
      if (ch === '"') return out
      if (ch === "\\") out += this.parseEscape()
      else out += ch
    }
  }

  private parseMultilineBasic(): string {
    this.pos += 3
    if (this.src[this.pos] === "\n") this.pos += 1
    else if (this.src.startsWith("\r\n", this.pos)) this.pos += 2
    let out = ""
    for (;;) {
      if (this.pos >= this.src.length) throw this.error("unterminated string")
      if (this.src.startsWith('"""', this.pos)) {
        this.pos += 3
        return out
      }
      const ch = this.src[this.pos]!
      this.pos += 1
      if (ch !== "\\") {
        out += ch
        continue
      }
      // Line-ending backslash: trim the newline and following whitespace.
      const trail = /^[ \t]*\r?\n[\s]*/.exec(this.src.slice(this.pos))
      if (trail) {
        this.pos += trail[0].length
        continue
      }
      out += this.parseEscape()
    }
  }

  private parseEscape(): string {
    const ch = this.src[this.pos]
    this.pos += 1
    switch (ch) {
      case "b": return "\b"
      case "t": return "\t"
      case "n": return "\n"
      case "f": return "\f"
      case "r": return "\r"
      case '"': return '"'
      case "\\": return "\\"
      case "u":
      case "U": {
        const len = ch === "u" ? 4 : 8
        const hex = this.src.slice(this.pos, this.pos + len)
        if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) {
          throw this.error("bad unicode escape")
        }
        this.pos += len
        return String.fromCodePoint(parseInt(hex, 16))
      }
      default:
        throw this.error(`bad escape "\\${ch ?? ""}"`)
    }
  }

  private parseLiteralString(): string {
    this.expect("'")
    const end = this.src.indexOf("'", this.pos)
    const nl = this.src.indexOf("\n", this.pos)
    if (end < 0 || (nl >= 0 && nl < end)) throw this.error("unterminated string")
    const out = this.src.slice(this.pos, end)
    this.pos = end + 1
    return out
  }

  private parseMultilineLiteral(): string {
    this.pos += 3
    if (this.src[this.pos] === "\n") this.pos += 1
    else if (this.src.startsWith("\r\n", this.pos)) this.pos += 2
    const end = this.src.indexOf("'''", this.pos)
    if (end < 0) throw this.error("unterminated string")
    const out = this.src.slice(this.pos, end)
    this.pos = end + 3
    return out
  }

  private skipInlineWs(): void {
    while (this.src[this.pos] === " " || this.src[this.pos] === "\t") this.pos += 1
  }

  private skipComment(): void {
    if (this.src[this.pos] !== "#") return
    const nl = this.src.indexOf("\n", this.pos)
    this.pos = nl < 0 ? this.src.length : nl
  }

  private skipWsCommentsNewlines(): void {
    for (;;) {
      const ch = this.src[this.pos]
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") this.pos += 1
      else if (ch === "#") this.skipComment()
      else return
    }
  }

  /** After a header or key/value: only whitespace + a comment may follow
   *  before the newline. */
  private endOfLine(): void {
    this.skipInlineWs()
    this.skipComment()
    if (this.src[this.pos] === "\r") this.pos += 1
    if (this.pos >= this.src.length) return
    if (this.src[this.pos] !== "\n") throw this.error("expected end of line")
    this.pos += 1
  }

  private expect(ch: string): void {
    if (this.src[this.pos] !== ch) throw this.error(`expected "${ch}"`)
    this.pos += 1
  }

  private error(msg: string): Error {
    const line = this.src.slice(0, this.pos).split("\n").length
    return new Error(`TOML parse error (line ${line}): ${msg}`)
  }
}
