/**
 * `CredentialsJsonStore` — an `@agentproto/auth` `CredentialStore` backend
 * over `~/.agentproto/credentials.json`.
 *
 * Bridges the AIP-50 flow engine to the CLI's existing per-host credentials
 * file so `serve`/`auth status`/`auth logout` keep reading it through the
 * CLI's `./credentials.ts` helpers (0600 write, empty-file unlink, …)
 * unchanged. `StoreRef.account` is the normalised host URL — the `hosts` key
 * in the file — not `StoreRef.path` (the flow engine's audience-prefixed
 * keychain-service name, meaningless here since one file already holds every
 * host). `StoredCredential.metadata` carries everything `HostCredential` has
 * beyond `token`/`tokenType`/`expiresAt`.
 */

import type { CredentialStore, StoreRef, StoredCredential } from "./types.js"
import { mkdir, readFile, writeFile, chmod, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { z } from "zod"

const hostCredentialSchema = z.object({
  token: z.string(),
  tokenType: z.literal("Bearer"),
  expiresAt: z.string().optional(),
  refreshToken: z.string().optional(),
  scope: z.string().optional(),
  subject: z.string().optional(),
  obtainedAt: z.string(),
  deviceLabel: z.string().optional(),
  revocationId: z.string().optional(),
})

const credentialsFileSchema = z.object({
  version: z.literal(1),
  hosts: z.record(z.string(), hostCredentialSchema),
})

type CredentialsFile = z.infer<typeof credentialsFileSchema>
type HostCredential = z.infer<typeof hostCredentialSchema>

const FILE_VERSION = 1 as const

export function credentialsJsonPath(): string {
  const base = process.env["AGENTPROTO_HOME"] ?? join(homedir(), ".agentproto")
  return join(base, "credentials.json")
}

export function normaliseHost(host: string): string {
  return host.replace(/\/+$/, "")
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    Reflect.get(err, "code") === "ENOENT"
  )
}

async function loadCredentials(): Promise<CredentialsFile> {
  const path = credentialsJsonPath()
  try {
    const raw = await readFile(path, "utf8")
    const parsed: unknown = JSON.parse(raw)
    return credentialsFileSchema.parse(parsed)
  } catch (err) {
    if (isEnoent(err)) {
      return { version: FILE_VERSION, hosts: {} }
    }
    throw err
  }
}

async function saveCredentials(file: CredentialsFile): Promise<void> {
  const path = credentialsJsonPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(file, null, 2))
  await chmod(path, 0o600).catch(() => {
    // Windows + some sandboxed FSes don't honour chmod. The file lives under
    // the user profile, which is already user-private.
  })
}

async function readHost(host: string): Promise<HostCredential | null> {
  const file = await loadCredentials()
  return file.hosts[normaliseHost(host)] ?? null
}

async function writeHost(host: string, cred: HostCredential): Promise<void> {
  const file = await loadCredentials()
  file.hosts[normaliseHost(host)] = cred
  await saveCredentials(file)
}

async function deleteHost(host: string): Promise<HostCredential | null> {
  const file = await loadCredentials()
  const key = normaliseHost(host)
  const prev = file.hosts[key] ?? null
  if (prev) {
    delete file.hosts[key]
    if (Object.keys(file.hosts).length === 0) {
      await unlink(credentialsJsonPath()).catch(() => {})
    } else {
      await saveCredentials(file)
    }
  }
  return prev
}

function hostOf(ref: StoreRef): string {
  return normaliseHost(ref.account ?? ref.path)
}

function metaString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key]
  return typeof value === "string" ? value : undefined
}

function toStoredCredential(cred: HostCredential): StoredCredential {
  const metadata: Record<string, unknown> = {
    obtainedAt: cred.obtainedAt,
  }
  if (cred.refreshToken) metadata.refreshToken = cred.refreshToken
  if (cred.scope) metadata.scope = cred.scope
  if (cred.subject) metadata.subject = cred.subject
  if (cred.deviceLabel) metadata.deviceLabel = cred.deviceLabel
  if (cred.revocationId) metadata.revocationId = cred.revocationId

  return {
    value: cred.token,
    kind: "daemon",
    ...(cred.expiresAt ? { expiresAt: cred.expiresAt } : {}),
    metadata,
  }
}

function toHostCredential(cred: StoredCredential): HostCredential {
  const metadata = cred.metadata ?? {}
  const refreshToken = metaString(metadata, "refreshToken")
  const scope = metaString(metadata, "scope")
  const subject = metaString(metadata, "subject")
  const deviceLabel = metaString(metadata, "deviceLabel")
  const revocationId = metaString(metadata, "revocationId")
  const obtainedAt =
    metaString(metadata, "obtainedAt") ?? new Date().toISOString()

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
