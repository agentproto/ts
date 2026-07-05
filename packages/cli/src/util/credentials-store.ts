/**
 * `CredentialsJsonStore` — an `@agentproto/auth` `CredentialStore` backend
 * over `~/.agentproto/credentials.json`.
 *
 * Bridges the AIP-50 `device-code` flow engine to the CLI's existing
 * per-host credentials file so `serve`/`auth status`/`auth logout` keep
 * reading it through `./credentials.ts`'s helpers (0600 write, empty-file
 * unlink, …) unchanged. `StoreRef.account` is the normalised tunnel host URL
 * — the `hosts` key in the file — not `StoreRef.path` (the flow engine's
 * audience-prefixed keychain-service name, meaningless here since one file
 * already holds every host). `StoredCredential.metadata` carries everything
 * `HostCredential` has beyond `token`/`tokenType`/`expiresAt`.
 */

import type {
  CredentialStore,
  StoreRef,
  StoredCredential,
} from "@agentproto/auth"
import {
  deleteHost,
  normaliseHost,
  readHost,
  writeHost,
  type HostCredential,
} from "./credentials.js"

function metaString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const v = metadata?.[key]
  return typeof v === "string" ? v : undefined
}

function toStoredCredential(cred: HostCredential): StoredCredential {
  const metadata: Record<string, unknown> = {
    obtainedAt: cred.obtainedAt,
    ...(cred.refreshToken ? { refreshToken: cred.refreshToken } : {}),
    ...(cred.scope ? { scope: cred.scope } : {}),
    ...(cred.subject ? { subject: cred.subject } : {}),
    ...(cred.deviceLabel ? { deviceLabel: cred.deviceLabel } : {}),
    ...(cred.revocationId ? { revocationId: cred.revocationId } : {}),
  }
  return {
    value: cred.token,
    kind: "daemon",
    ...(cred.expiresAt ? { expiresAt: cred.expiresAt } : {}),
    metadata,
  }
}

function toHostCredential(cred: StoredCredential): HostCredential {
  const refreshToken = metaString(cred.metadata, "refreshToken")
  const scope = metaString(cred.metadata, "scope")
  const subject = metaString(cred.metadata, "subject")
  const deviceLabel = metaString(cred.metadata, "deviceLabel")
  const revocationId = metaString(cred.metadata, "revocationId")
  const obtainedAt =
    metaString(cred.metadata, "obtainedAt") ?? new Date().toISOString()
  return {
    token: cred.value,
    tokenType: "Bearer",
    ...(cred.expiresAt ? { expiresAt: cred.expiresAt } : {}),
    obtainedAt,
    ...(refreshToken ? { refreshToken } : {}),
    ...(scope ? { scope } : {}),
    ...(subject ? { subject } : {}),
    ...(deviceLabel ? { deviceLabel } : {}),
    ...(revocationId ? { revocationId } : {}),
  }
}

function hostOf(ref: StoreRef): string {
  return normaliseHost(ref.account ?? ref.path)
}

export class CredentialsJsonStore implements CredentialStore {
  async read(ref: StoreRef): Promise<StoredCredential | undefined> {
    const cred = await readHost(hostOf(ref))
    return cred ? toStoredCredential(cred) : undefined
  }

  async write(ref: StoreRef, cred: StoredCredential): Promise<void> {
    await writeHost(hostOf(ref), toHostCredential(cred))
  }

  async delete(ref: StoreRef): Promise<void> {
    await deleteHost(hostOf(ref))
  }
}
