/**
 * `daemon.frameAncestors`: extra `frame-ancestors` CSP sources for the app
 * page `GET /apps/:appId/ui`, validated before they reach the server.
 *
 * An entry is kept only if a hostile page cannot forge it: an exact
 * `https://host[:port]` origin (plain `http://` only on loopback), or a custom
 * URI scheme such as `vscode-webview:` that only a native host can register.
 * Everything else is dropped with one warning line naming that entry, and a
 * dropped entry never widens anything: the page injects the tool-call bridge,
 * so a framer we cannot pin down could drive it.
 */

export interface FrameAncestorRejection {
  entry: unknown
  reason: string
}

export interface FrameAncestorsResult {
  accepted: string[]
  rejected: FrameAncestorRejection[]
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])
// Schemes a web page can mint or navigate to, so they pin nothing down.
const WEB_MINTABLE_SCHEMES = new Set([
  "http", "https", "ws", "wss", "data", "blob", "filesystem", "file", "javascript", "about",
])
const SCHEME_SOURCE = /^[a-z][a-z0-9+.-]*:$/
const HTTP_ORIGIN = /^https?:\/\/[^/?#@\\]+$/i

function checkEntry(raw: unknown): { ok: string } | { reason: string } {
  if (typeof raw !== "string") return { reason: "not a string" }
  const entry = raw.trim()
  if (entry === "") return { reason: "empty" }
  if (/\s/.test(entry)) return { reason: "contains whitespace" }
  if (/[;,]/.test(entry)) return { reason: "contains ; or ," }
  if (entry.includes("*")) return { reason: "wildcards are not allowed" }
  if (/['"]/.test(entry)) return { reason: "keywords and quotes are not allowed" }

  const lower = entry.toLowerCase()
  if (SCHEME_SOURCE.test(lower)) {
    return WEB_MINTABLE_SCHEMES.has(lower.slice(0, -1))
      ? { reason: "a bare web scheme matches any page; list an exact origin" }
      : { ok: lower }
  }

  if (!HTTP_ORIGIN.test(entry)) return { reason: "not an exact https://host[:port] origin or a custom scheme" }
  let url: URL
  try {
    url = new URL(entry)
  } catch {
    return { reason: "not a valid origin" }
  }
  if (url.username !== "" || url.password !== "") return { reason: "userinfo is not allowed" }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    return { reason: "http:// is only accepted for loopback hosts" }
  }
  return { ok: url.origin }
}

export function validateFrameAncestors(entries: readonly unknown[]): FrameAncestorsResult {
  const accepted = new Set<string>()
  const rejected: FrameAncestorRejection[] = []
  for (const entry of entries) {
    const verdict = checkEntry(entry)
    if ("ok" in verdict) accepted.add(verdict.ok)
    else rejected.push({ entry, reason: verdict.reason })
  }
  return { accepted: [...accepted], rejected }
}

function describeEntry(entry: unknown): string {
  const text = typeof entry === "string" ? JSON.stringify(entry) : `a ${typeof entry} value`
  return text.length > 80 ? `${text.slice(0, 77)}...` : text
}

/**
 * Read `daemon.frameAncestors` (an array, or one comma-separated string as
 * `agentproto config set` can store it) into the list to hand to the server.
 * Returns `undefined` when nothing usable is configured, which keeps the
 * built-in defaults untouched.
 */
export function resolveServeFrameAncestors(
  raw: unknown,
  warn: (line: string) => void,
): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  let entries: unknown[]
  if (typeof raw === "string") entries = raw.split(",").filter(part => part.trim() !== "")
  else if (Array.isArray(raw)) entries = raw
  else {
    warn("agentproto serve: ignoring daemon.frameAncestors, expected a list of origins\n")
    return undefined
  }
  const { accepted, rejected } = validateFrameAncestors(entries)
  for (const { entry, reason } of rejected) {
    warn(`agentproto serve: ignoring daemon.frameAncestors entry ${describeEntry(entry)}: ${reason}\n`)
  }
  return accepted.length > 0 ? accepted : undefined
}
