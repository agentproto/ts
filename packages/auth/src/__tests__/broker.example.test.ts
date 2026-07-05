/**
 * COPY-PASTE INTEGRATION EXAMPLE — the whole broker wire-up in one file.
 *
 * Unlike `broker.test.ts` (which mocks `runAuthFlow` to exercise every
 * branch), this file mocks NOTHING. It is the minimal, deterministic
 * "here's literally all you write to resolve an auth header" that an
 * external host can copy. It stays on the cached-credential path — a
 * credential with no expiry is fresh, so no flow engine, Keychain, or
 * network is touched, and the example is fully self-contained.
 *
 * The four moving parts, top to bottom:
 *   1. an auth provider   — declares WHERE/HOW a server authenticates
 *   2. a CredentialStore  — WHERE the credential lives (any backend)
 *   3. a CredentialBroker — path -> fresh Authorization header
 *   4. resolveHeaders()   — call it at connect-time, per request
 */
import { describe, it, expect } from "vitest"
import {
  CredentialBroker,
  MemoryStore,
  resolveStoreRef,
  type AuthProviderHandle,
} from "../index.js"

describe("CredentialBroker — integration example", () => {
  it("resolves a stored credential into an Authorization header, unmocked", async () => {
    // 1. A provider. Author it as a TS literal (`defineAuthProvider`) or an
    //    `.md` manifest, then `registerAuthProvider(provider)` so the broker
    //    can find it by id. Here we resolve it inline to keep the example
    //    free of module-global registry state.
    const provider: AuthProviderHandle = {
      id: "example-service",
      description: "Example API — personal access token.",
      apiBase: "https://api.example.com",
      auth: { flow: "pat", tokenStore: { keychain: "example-svc", account: "{server}" } },
    }

    // 2. A store. Swap MemoryStore for KeychainStore / FileStore / your own
    //    vault-backed CredentialStore — the broker doesn't care which.
    const store = new MemoryStore()

    // Seed the credential under the SAME ref the broker will read. In a real
    // host this is written once by your login/onboarding flow; the broker
    // reads it fresh on every subsequent (headless) run.
    const ref = resolveStoreRef(provider.auth.tokenStore, provider.apiBase)
    await store.write(ref, { value: "tok_live_123", kind: "pat" })

    // 3. The broker. `getProvider` is your registry lookup — in a real host,
    //    `getProvider: getAuthProvider` after `registerAuthProvider(provider)`.
    const broker = new CredentialBroker({
      store,
      getProvider: id => (id === provider.id ? provider : undefined),
    })

    // 4. Resolve at connect-time. `path` = "<providerId>" (or
    //    "<providerId>/<account>"). Returns a FRESH header every call.
    const headers = await broker.resolveHeaders({ path: "example-service" })

    expect(headers).toEqual({ Authorization: "Bearer tok_live_123" })
    // Feed `headers` straight onto your outbound request / MCP transport.
  })
})
