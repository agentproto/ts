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
 * Everything here is `node:crypto` — X25519, Ed25519, SHA-256 — so the package
 * keeps its zero-native-dependency footprint. The private halves never leave
 * the identity file (mode 0600) and are never logged.
 */

import {
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  createHash,
  sign as edSign,
  verify as edVerify,
} from "node:crypto"
import { mkdir, readFile, writeFile, chmod, rename } from "node:fs/promises"
import { dirname, join, basename } from "node:path"

/** Current identity-file schema version. */
export const IDENTITY_VERSION = 1 as const

/** Raised for every identity load/generate/sign/verify failure. The message
 *  is safe to surface — it never contains private key material. */
export class IdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "IdentityError"
  }
}

/** One keypair, both halves base64-DER. Public = SPKI, private = PKCS8. */
export interface IdentityKeyPair {
  /** base64 DER (SPKI) public key — publishable. */
  pub: string
  /** base64 DER (PKCS8) private key — secret. */
  priv: string
}

/**
 * A daemon's persistent identity. Serialized verbatim to
 * `~/.agentproto/identity.json` (0600). The `x25519` public half is the key a
 * client seals its hello to; the `ed25519` public half is the key a client
 * verifies the daemon's transcript signature against. Both public halves are
 * carried in the offer URL.
 */
export interface DaemonIdentity {
  v: typeof IDENTITY_VERSION
  /** Encryption / key-agreement keypair. */
  x25519: IdentityKeyPair
  /** Signing / authenticity keypair. */
  ed25519: IdentityKeyPair
  /** ISO-8601 creation timestamp. */
  createdAt: string
}

/**
 * Mint a fresh daemon identity: one X25519 keypair (encryption) and one
 * Ed25519 keypair (signing). Called lazily on first `pair offer`.
 */
export function generateIdentity(): DaemonIdentity {
  const x = generateKeyPairSync("x25519")
  const ed = generateKeyPairSync("ed25519")
  return {
    v: IDENTITY_VERSION,
    x25519: {
      pub: x.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      priv: x.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    },
    ed25519: {
      pub: ed.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      priv: ed.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    },
    createdAt: new Date().toISOString(),
  }
}

/**
 * Stable short identifier for a daemon, derived from its X25519 public key —
 * the same construction as `sealKeyId` in `@agentproto/secrets/seal` (first 16
 * hex of `sha256(pub DER)`). Displayed everywhere a human confirms identity
 * (offer QR, `pair accept`, `pair ls`). Not a secret.
 */
export function identityFingerprint(x25519Pub: string): string {
  return createHash("sha256")
    .update(Buffer.from(x25519Pub, "base64"))
    .digest("hex")
    .slice(0, 16)
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

  const identity = generateIdentity()
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
 * Sign a handshake transcript with the daemon's Ed25519 private key. Returns a
 * base64 signature. `transcript` is the exact bytes both sides agree on
 * (`sha256(e_pub ‖ ct₀ ‖ d_e_pub)`); signing it — not the raw messages — is
 * what binds the daemon's authenticity to the whole exchange.
 */
export function signTranscript(
  ed25519Priv: string,
  transcript: Uint8Array
): string {
  let priv
  try {
    priv = createPrivateKey({
      key: Buffer.from(ed25519Priv, "base64"),
      format: "der",
      type: "pkcs8",
    })
  } catch {
    throw new IdentityError("invalid ed25519 private key")
  }
  // Ed25519 takes a null digest algorithm — it hashes internally.
  return edSign(null, Buffer.from(transcript), priv).toString("base64")
}

/**
 * Verify a transcript signature against a daemon's Ed25519 public key. Returns
 * a boolean — never throws on a bad signature (only on a structurally invalid
 * key), so callers branch on the result rather than a control-flow exception.
 */
export function verifyTranscript(
  ed25519Pub: string,
  transcript: Uint8Array,
  signature: string
): boolean {
  let pub
  try {
    pub = createPublicKey({
      key: Buffer.from(ed25519Pub, "base64"),
      format: "der",
      type: "spki",
    })
  } catch {
    throw new IdentityError("invalid ed25519 public key")
  }
  let sig: Buffer
  try {
    sig = Buffer.from(signature, "base64")
  } catch {
    return false
  }
  try {
    return edVerify(null, Buffer.from(transcript), pub, sig)
  } catch {
    return false
  }
}
