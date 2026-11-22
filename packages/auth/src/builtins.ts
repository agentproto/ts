/**
 * Builtin auth-provider manifests — shipped as TS literals so they bundle
 * into the tsup output with zero filesystem reads at runtime. A host adds more
 * by parsing its own `.md` with `parseAuthProviderManifest` and registering
 * the result via `registerAuthProvider`.
 */

import { defineAuthProvider } from "./define-auth-provider.js"
import type { AuthProviderHandle } from "./types.js"

/** Acme AI company platform.
 *
 *  Authenticates via the AIP-50 service-auth claim ceremony: browser opens,
 *  user clicks Approve, bureau stores the oat_* access token.
 *  Discovery from /.well-known/oauth-protected-resource supplies live endpoints;
 *  the static fields below are the offline fallback. */
export const acmeAuthProvider = defineAuthProvider({
  id: "acme",
  description:
    "Acme AI company platform. Authenticate via a browser-approve flow — no key to paste.",
  apiBase: "https://api.example.com",
  audience: "api",
  auth: {
    flow: "service-auth",
    clientId: "agentproto-cli",
    tokenStore: {
      keychain: "bureau-acme",
      account: "{server}",
    },
  },
  install: {
    sealKey: "/acme/api/v1/connectors/seal-key",
    secretBacked: "/acme/api/v1/guilds/{guildId}/connectors/secret-backed",
  },
})

export const BUILTIN_AUTH_PROVIDERS: readonly AuthProviderHandle[] = [
  acmeAuthProvider,
]
