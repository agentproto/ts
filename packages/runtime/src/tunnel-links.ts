/**
 * Pure tunnel-link helpers.
 *
 * A tunnel exposes a local port behind a public HTTPS origin (`desc.url`, or
 * `desc.publicUrl` for a `public:true` tunnel). The Telegram session-chat
 * miniapp (studio repo `services/telegram-session-chat-miniapp/src/server.ts`)
 * serves a per-session route at `/s/<sessionId>` on that origin, so the link
 * to hand a user is simply the tunnel URL with that path appended.
 *
 * Kept free of any I/O so it is trivially unit-testable and reusable from both
 * the daemon (the `app_tunnel` MCP tool) and the CLI.
 */

/**
 * Build the miniapp deep link for a session off a tunnel URL:
 * `<tunnelUrl>/s/<sessionId>`.
 *
 * - A trailing slash on `tunnelUrl` is stripped so the result never contains
 *   a doubled `//`.
 * - A query string / hash already on `tunnelUrl` (e.g. the access guard's
 *   `?t=<token>`) is preserved, and the `/s/<sessionId>` path is inserted
 *   before it — the guarded URL stays usable.
 * - Throws for an empty `sessionId` or a `tunnelUrl` that is empty, not a
 *   URL, or not `https:` — the miniapp route only exists on the HTTPS origin.
 */
export function buildSessionLink(tunnelUrl: string, sessionId: string): string {
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    throw new Error("buildSessionLink: sessionId is required")
  }
  const trimmed = typeof tunnelUrl === "string" ? tunnelUrl.trim() : ""
  if (trimmed === "") {
    throw new Error("buildSessionLink: tunnelUrl is required")
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`buildSessionLink: invalid tunnel URL "${tunnelUrl}"`)
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `buildSessionLink: tunnel URL must be https, got "${url.protocol.replace(/:$/, "")}"`,
    )
  }

  const base = url.pathname.replace(/\/+$/, "")
  url.pathname = `${base}/s/${encodeURIComponent(sessionId)}`
  return url.toString()
}
