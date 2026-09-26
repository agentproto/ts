/**
 * @agentproto/secrets/identity — the daemon's persistent cryptographic
 * identity for E2E pairing (design: PAIRING / DESIGN §1).
 *
 * A daemon that accepts pairings needs a stable identity a client can pin:
 *   - an **X25519** keypair for key agreement (the client seals its hello to
 *     this key, and it is one of the two ECDH inputs to the session key), and
 *   - an **Ed25519** keypair for authenticity (the daemon signs the handshake
 *     transcript so the client — who learned the public halves out-of-band via
 *     the offer URL — can prove it is really talking to the daemon it scanned,
 *     not an evil rendezvous in the middle).
 *
 * Both keypairs are stored base64-DER (SPKI public / PKCS8 private), the exact
 * shape `@agentproto/secrets/seal` already uses, so the identity file travels
 * as plain JSON and the seal box can consume the X25519 public half verbatim.
 *
 * The crypto (X25519, Ed25519, SHA-256) lives once in ./core.ts against a
 * `CryptoProvider`; this Node entry defaults to `node:crypto` and adds the
 * file-backed store. Everything is async (WebCrypto is) and takes an optional
 * trailing `crypto` to override the provider. The private halves never leave
 * the identity file (mode 0600) and are never logged.
 */

import { mkdir, readFile, writeFile, chmod, rename } from "node:fs/promises"
import { dirname, join, basename } from "node:path"
import { nodeCryptoProvider } from "../crypto/node.js"
import type { CryptoProvider } from "../crypto/types.js"
import * as core from "./core.js"
import { IDENTITY_VERSION, IdentityError, type DaemonIdentity } from "./core.js"

export {
  IDENTITY_VERSION,
  IdentityError,
  type IdentityKeyPair,
  type DaemonIdentity,
} from "./core.js"
export type { CryptoProvider } from "../crypto/types.js"

/**
 * Mint a fresh daemon identity: one X25519 keypair (encryption) and one
 * Ed25519 keypair (signing). Called lazily on first `pair offer`.
 */
export function generateIdentity(crypto: CryptoProvider = nodeCryptoProvider): Promise<DaemonIdentity> {
  return core.generateIdentity(crypto)
}

/**
 * Stable short identifier for a daemon, derived from its X25519 public key —
 * the same construction as `sealKeyId` in `@agentproto/secrets/seal` (first 16
 * hex of `sha256(pub DER)`). Displayed everywhere a human confirms identity
 * (offer QR, `pair accept`, `pair ls`). Not a secret.
 */
export function identityFingerprint(x25519Pub: string, crypto: CryptoProvider = nodeCryptoProvider): Promise<string> {
  return core.identityFingerprint(x25519Pub, crypto)
}

/** True for a filesystem "no such file" error, without an unchecked cast. */
function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === "ENOENT"
  )
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null
}

function isKeyPair(kp: unknown): boolean {
  return isRecord(kp) && typeof kp["pub"] === "string" && typeof kp["priv"] === "string"
}

function isDaemonIdentity(value: unknown): value is DaemonIdentity {
  if (!isRecord(value)) return false
  if (value["v"] !== IDENTITY_VERSION) return false
  if (typeof value["createdAt"] !== "string") return false
  return isKeyPair(value["x25519"]) && isKeyPair(value["ed25519"])
}

/**
 * Load the daemon identity from `filePath`, creating it on first use. The
 * caller supplies the path (typically `~/.agentproto/identity.json`) so this
 * module stays free of any home-dir policy.
 *
 * The private halves are secret, so a freshly created file is written 0600 and
 * atomically (temp file in the same directory + `rename`, so a crash mid-write
 * can never leave a half-written identity or a world-readable window). A
 * malformed existing file is a hard error — never silently overwritten, since
 * that would rotate the daemon's identity and orphan every existing pairing.
 */
export async function loadOrCreateIdentity(
  filePath: string
): Promise<DaemonIdentity> {
  try {
    const raw = await readFile(filePath, "utf8")
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new IdentityError(
        `identity file ${filePath} is not valid JSON — refusing to overwrite; ` +
          `move it aside to regenerate`
      )
    }
    if (!isDaemonIdentity(parsed)) {
      throw new IdentityError(
        `identity file ${filePath} is malformed or an unsupported version — ` +
          `refusing to overwrite; move it aside to regenerate`
      )
    }
    return parsed
  } catch (err) {
    if (!isEnoent(err)) throw err
    // ENOENT → first run; fall through to lazy creation below.
  }

  const identity = await generateIdentity()
  await persistIdentity(filePath, identity)
  return identity
}

/** Atomic 0600 write: serialize to a sibling temp file, chmod it before it
 *  holds any secret bytes, then rename over the target. */
async function persistIdentity(
  filePath: string,
  identity: DaemonIdentity
): Promise<void> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${basename(filePath)}.tmp-${process.pid}`)
  await writeFile(tmp, JSON.stringify(identity, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  })
  // Belt-and-suspenders: writeFile's mode is subject to umask on some
  // platforms, so tighten explicitly before the file is visible at its
  // final name. Windows / mounts that ignore chmod fall back to the
  // already-private user profile dir.
  await chmod(tmp, 0o600).catch(() => {})
  await rename(tmp, filePath)
}

/**
 * Sign a handshake transcript with the daemon's Ed25519 private key. Resolves
 * to a base64 signature. `transcript` is the exact bytes both sides agree on
 * (`sha256(e_pub ‖ ct₀ ‖ d_e_pub)`); signing it — not the raw messages — is
 * what binds the daemon's authenticity to the whole exchange.
 */
export function signTranscript(
  ed25519Priv: string,
  transcript: Uint8Array,
  crypto: CryptoProvider = nodeCryptoProvider,
): Promise<string> {
  return core.signTranscript(ed25519Priv, transcript, crypto)
}

/**
 * Verify a transcript signature against a daemon's Ed25519 public key. Resolves
 * to a boolean — never rejects on a bad signature (only on a structurally
 * invalid key), so callers branch on the result rather than an exception.
 */
export function verifyTranscript(
  ed25519Pub: string,
  transcript: Uint8Array,
  signature: string,
  crypto: CryptoProvider = nodeCryptoProvider,
): Promise<boolean> {
  return core.verifyTranscript(ed25519Pub, transcript, signature, crypto)
}
