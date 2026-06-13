/**
 * @agentproto/secrets/provision — seal a secret and install it into a remote
 * vault, carrying only ciphertext.
 *
 * The flow is: resolve a credential → fetch the target's sealing public key →
 * seal to it → hand the sealed blob to the target's install. The plaintext
 * exists only on the origin machine and, transiently, inside the target's
 * unseal boundary — never in whatever drives this (an agent, a relay, a log).
 *
 * The target is an INJECTED PORT: this module knows nothing about any specific
 * server. A caller provides a `SealedInstallTarget` — `httpTarget()` builds a
 * generic one from a seal-key URL + install URL + headers; a host-specific
 * caller (e.g. a product that knows its own server's paths and auth) injects
 * its own. No vendor names leak into this package.
 */

import { seal } from "../seal/index.js"

/** Public sealing material a target advertises so a sender can seal to it. */
export interface SealKeyInfo {
  keyId: string
  alg: string
  publicKey: string
}

/** The sealed payload handed to a target's install. `value` is already a
 *  sealed envelope (opaque); `keyId` lets the target reject a value sealed
 *  against a rotated key. */
export interface SealedInstallInput {
  provider: string
  methodId: string
  value: string
  keyId: string
  label?: string
}

/**
 * A server that can receive a sealed credential. The two halves a provision
 * needs: advertise the sealing key, and accept the sealed install. Implement
 * this for any concrete server; the provision flow is agnostic to how.
 */
export interface SealedInstallTarget {
  fetchSealKey(): Promise<SealKeyInfo>
  installSealed(input: SealedInstallInput): Promise<{ secretId?: string }>
}

export interface ProvisionSealedInput {
  target: SealedInstallTarget
  provider: string
  methodId: string
  /** The plaintext credential. Resolve it (e.g. via `resolveCredential`) right
   *  before calling so it lives as briefly as possible; it is sealed here and
   *  never returned or logged. */
  credential: string
  label?: string
}

/**
 * Seal `credential` to the target's current key and install it. Returns the
 * target's result plus the keyId used. The plaintext is consumed here and
 * never leaves.
 */
export async function provisionSealed(
  input: ProvisionSealedInput
): Promise<{ secretId?: string; keyId: string }> {
  const key = await input.target.fetchSealKey()
  const sealedValue = seal(input.credential, key.publicKey)
  const result = await input.target.installSealed({
    provider: input.provider,
    methodId: input.methodId,
    value: sealedValue,
    keyId: key.keyId,
    ...(input.label ? { label: input.label } : {}),
  })
  return { ...result, keyId: key.keyId }
}

/**
 * Build a generic HTTP target from a seal-key URL, an install URL, and
 * optional headers (auth). Vendor-neutral — the URLs and headers are the
 * caller's to supply. The install POSTs `{ ...input, sealed: true }` as JSON.
 */
export function httpTarget(config: {
  sealKeyUrl: string
  installUrl: string
  headers?: Record<string, string>
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}): SealedInstallTarget {
  const doFetch = config.fetchImpl ?? fetch
  return {
    async fetchSealKey() {
      const res = await doFetch(config.sealKeyUrl, {
        headers: config.headers,
      })
      if (res.status === 404) {
        throw new Error("target has no sealing key configured")
      }
      if (!res.ok) {
        throw new Error(`seal-key fetch failed: HTTP ${res.status}`)
      }
      return (await res.json()) as SealKeyInfo
    },
    async installSealed(installInput) {
      const res = await doFetch(config.installUrl, {
        method: "POST",
        headers: { ...config.headers, "content-type": "application/json" },
        body: JSON.stringify({ ...installInput, sealed: true }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`install failed: HTTP ${res.status} ${text}`)
      }
      return (await res.json()) as { secretId?: string }
    },
  }
}

// ── Credential resolution (local sources) ──────────────────────────────
// A small convenience for CLI / origin-machine callers. Reads a credential
// from an env var or a file (optionally extracting a JSON field). The result
// is sensitive — seal it immediately, never print it.

export interface CredentialSource {
  /** Read from this process env var. */
  fromEnv?: string
  /** Read from this file path (`~` expands to the home dir). */
  fromFile?: string
  /** Dot-path to extract a string from the file's JSON (else whole file). */
  jsonPath?: string
}

function expandHome(p: string): string {
  if (p === "~") return homeDir()
  if (p.startsWith("~/")) return joinPath(homeDir(), p.slice(2))
  return p
}

// Lazily reach for node built-ins so the module stays importable in any
// runtime; resolveCredential is only called by origin-machine callers.
function homeDir(): string {
  return (
    process.env.HOME ?? process.env.USERPROFILE ?? "~"
  )
}
function joinPath(a: string, b: string): string {
  return a.replace(/\/$/, "") + "/" + b.replace(/^\//, "")
}

export function extractJsonPath(raw: string, path: string): string {
  let cur: unknown = JSON.parse(raw)
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") {
      throw new Error(`credential field '${path}' not found in file`)
    }
    cur = (cur as Record<string, unknown>)[part]
  }
  if (typeof cur !== "string" || cur.length === 0) {
    throw new Error(`credential field '${path}' is not a non-empty string`)
  }
  return cur
}

/**
 * Resolve a plaintext credential from a local source. Sensitive — callers
 * seal the result immediately and never print it. Uses a dynamic `fs` import
 * so the module has no hard Node filesystem dependency at import time.
 */
export async function resolveCredential(
  source: CredentialSource
): Promise<string> {
  if (source.fromEnv) {
    const v = process.env[source.fromEnv]
    if (!v) throw new Error(`env var ${source.fromEnv} is empty / unset`)
    return v
  }
  if (!source.fromFile) {
    throw new Error("no credential source — set fromFile or fromEnv")
  }
  const { readFileSync } = await import("node:fs")
  const raw = readFileSync(expandHome(source.fromFile), "utf8")
  return source.jsonPath ? extractJsonPath(raw, source.jsonPath) : raw.trim()
}
