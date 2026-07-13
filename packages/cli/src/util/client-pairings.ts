/**
 * Client-side pairing store — the paired-daemon half of `agentproto pair`.
 *
 * `~/.agentproto/pair-credentials.json` (mode 0600). Kept as a dedicated file
 * rather than folded into `credentials.json` (whose shape is strictly
 * host→bearer, `credentials.ts`): a pairing credential is a different beast —
 * daemon fingerprint, pinned static keys, rendezvous URL, and the long-term
 * `pairRoot` secret from which reconnect routing tokens derive. Same on-disk
 * conventions as `credentials.ts` (atomic 0600 write, empty-file unlink,
 * `$AGENTPROTO_HOME` override), so it reads as a sibling of the auth store.
 *
 * DESIGN §4 names `credentials.json`; we split it out to avoid entangling the
 * auth-token store's shape/validation with pairing records — a deliberate,
 * documented deviation. `pair ls` reads this file when no daemon is reachable.
 */

import { mkdir, readFile, writeFile, chmod, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join, dirname } from "node:path"

export interface ClientPairing {
  /** Daemon identity fingerprint (16 hex) — the pin. */
  fingerprint: string
  /** Human label the user gave this pairing (defaults to the daemon fingerprint). */
  name: string
  /** Daemon static X25519 public key (base64 SPKI DER) — pinned; used to re-seal
   *  on reconnect + as the ECDH input. */
  daemonX25519Pub: string
  /** Daemon static Ed25519 public key (base64 SPKI DER) — pinned; verifies the
   *  daemon's transcript signature on every (re)connect. */
  daemonEd25519Pub: string
  /** Rendezvous endpoint to reconnect through. */
  rendezvousUrl: string
  /** Long-term shared secret (base64) — derives the epoch routing tokens. */
  pairRoot: string
  /** ISO-8601 when this pairing was first accepted. */
  createdAt: string
  /** ISO-8601 of the most recent (re)connect. */
  lastSeen: string
}

interface ClientPairingsFile {
  version: 1
  pairings: ClientPairing[]
}

const FILE_VERSION = 1 as const

export function clientPairingsPath(): string {
  const base = process.env["AGENTPROTO_HOME"] ?? join(homedir(), ".agentproto")
  return join(base, "pair-credentials.json")
}

export async function loadClientPairings(): Promise<ClientPairingsFile> {
  const path = clientPairingsPath()
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as ClientPairingsFile
    if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.pairings)) {
      throw new Error(
        `${path}: unexpected shape (version ${parsed.version}). ` +
          `Move it aside and re-run \`agentproto pair accept\`.`,
      )
    }
    return parsed
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: FILE_VERSION, pairings: [] }
    }
    throw err
  }
}

async function saveClientPairings(file: ClientPairingsFile): Promise<void> {
  const path = clientPairingsPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(file, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
  await chmod(path, 0o600).catch(() => {
    // Windows / some mounts ignore chmod; the profile dir is already private.
  })
}

/** Insert or replace a pairing (keyed by fingerprint). */
export async function upsertClientPairing(pairing: ClientPairing): Promise<void> {
  const file = await loadClientPairings()
  const idx = file.pairings.findIndex(p => p.fingerprint === pairing.fingerprint)
  if (idx >= 0) file.pairings[idx] = pairing
  else file.pairings.push(pairing)
  await saveClientPairings(file)
}

/** Resolve a pairing by fingerprint or name. */
export async function findClientPairing(
  idOrName: string,
): Promise<ClientPairing | undefined> {
  const file = await loadClientPairings()
  return (
    file.pairings.find(p => p.fingerprint === idOrName) ??
    file.pairings.find(p => p.name === idOrName)
  )
}

/** Remove a pairing by fingerprint or name. Returns the removed record. */
export async function removeClientPairing(
  idOrName: string,
): Promise<ClientPairing | null> {
  const file = await loadClientPairings()
  const idx = file.pairings.findIndex(p => p.fingerprint === idOrName || p.name === idOrName)
  if (idx < 0) return null
  const [removed] = file.pairings.splice(idx, 1)
  if (file.pairings.length === 0) {
    await unlink(clientPairingsPath()).catch(() => {})
  } else {
    await saveClientPairings(file)
  }
  return removed ?? null
}
