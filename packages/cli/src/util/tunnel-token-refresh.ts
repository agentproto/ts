/**
 * Silent tunnel-token refresh for `agentproto serve` boot.
 *
 * An expired-but-refreshable credential shouldn't force a headless/unattended
 * `serve` to hang waiting on an interactive device-code ceremony (print code,
 * open browser, poll). This calls `runAuthFlow` with `refreshOnly: true` —
 * the device-code engine's cached/refresh path only, no ceremony fallback —
 * and reports failure (including the engine's `CeremonyRequiredError`) as
 * `null` so the caller can fall back to its own non-interactive behavior.
 */

import { runAuthFlow } from "@agentproto/auth"
import { CredentialsJsonStore } from "./credentials-store.js"
import { buildTunnelAuthProvider, toHttpHost } from "./tunnel-auth-provider.js"
import type { HostCredential } from "./credentials.js"

/** Attempts a silent refresh of an expired tunnel credential. Returns the
 *  refreshed access token on success, or `null` on any failure — most
 *  commonly the engine's `CeremonyRequiredError` (no cached refresh_token, or
 *  the refresh grant itself failed), but any error is treated the same way:
 *  never throws, so the caller can fall back to its own non-interactive
 *  behavior instead of hanging on a ceremony. */
export async function refreshTunnelToken(
  host: string,
  cred: HostCredential,
): Promise<string | null> {
  try {
    const provider = buildTunnelAuthProvider(host, {
      label: cred.deviceLabel ?? "agentproto-cli",
      scope: cred.scope,
    })
    const result = await runAuthFlow(provider, {
      server: toHttpHost(host),
      store: new CredentialsJsonStore(),
      refreshOnly: true,
      quiet: true,
    })
    return result.accessToken ?? null
  } catch {
    return null
  }
}
