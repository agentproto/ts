/**
 * Attestation signing — the daemon host side of the review primitive's
 * frozen "who signs" design (see `.plans/review-primitive/PLAN-step1.6-signing.md`):
 * only the daemon signs, with ONE ed25519 keypair per daemon install at
 * `~/.agentproto/keys/review_ed25519` (+ `.pub`), generated on first use.
 * Owner/session/model/presets stay claims inside the attestation payload —
 * they are never signers.
 *
 * Deliberately shells out to `ssh-keygen -Y sign` / `-Y verify` rather than
 * vendoring ed25519 + the SSHSIG envelope format: the signature an operator
 * gets is the same shape `git commit -S` and `ssh -Y sign` already produce
 * (an allowed_signers file, `ssh-keygen -Y verify`), so nothing here is a
 * bespoke format a reviewer has to learn.
 *
 * A signing failure (no `ssh-keygen` on PATH, an unreadable/unwritable key)
 * must NEVER fail the review — {@link signAttestation} always resolves,
 * returning `{ error }` instead of a signature for the caller to record as
 * an unsigned attestation + a reason (never thrown).
 */

import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { homedir, hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { canonicalAttestationBytes, type Attestation, type Attestor } from "@agentproto/review"

/** The `-n <namespace>` every sign/verify call is scoped to — distinct from
 *  any other SSHSIG use of the same key (git commit signing, SSH auth). */
export const SIGN_NAMESPACE = "agentproto-review"

export const defaultReviewKeysDir = (): string => join(homedir(), ".agentproto", "keys")

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const isNotFound = (err: unknown): boolean => (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT"

function execFileP(
  bin: string,
  args: readonly string[],
  opts: { input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      bin,
      [...args],
      { env: opts.env ?? process.env, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(Object.assign(err, { stdout: String(stdout), stderr: String(stderr) }))
          return
        }
        resolvePromise({ stdout: String(stdout), stderr: String(stderr) })
      },
    )
    if (opts.input !== undefined) child.stdin?.end(opts.input)
    else child.stdin?.end()
  })
}

export interface ReviewSigningKey {
  privateKeyPath: string
  publicKeyPath: string
  /** `ssh-keygen -lf` fingerprint, e.g. `SHA256:xxxx`. */
  fingerprint: string
  /** Raw contents of the `.pub` file (`ssh-ed25519 AAAA... comment`). */
  publicKeyLine: string
}

/** Ensure the daemon's review signing keypair exists at `dir` (default
 *  `~/.agentproto/keys`), generating it with `ssh-keygen -t ed25519` on
 *  first use. The private key is always left/made mode 0600. Throws if
 *  `ssh-keygen` is unavailable or the directory isn't writable — callers
 *  that must not fail the review catch this (see `signAttestation`). */
export async function ensureReviewSigningKey(
  opts: { dir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ReviewSigningKey> {
  const dir = opts.dir ?? defaultReviewKeysDir()
  await mkdir(dir, { recursive: true })
  const privateKeyPath = join(dir, "review_ed25519")
  const publicKeyPath = `${privateKeyPath}.pub`
  const exists = await stat(privateKeyPath)
    .then(() => true)
    .catch(() => false)
  if (!exists) {
    await execFileP(
      "ssh-keygen",
      ["-t", "ed25519", "-N", "", "-C", `agentproto-review@${hostname()}`, "-f", privateKeyPath],
      { env: opts.env },
    )
  }
  await chmod(privateKeyPath, 0o600)
  const publicKeyLine = (await readFile(publicKeyPath, "utf8")).trim()
  const fingerprint = await fingerprintOf(publicKeyPath, opts.env)
  return { privateKeyPath, publicKeyPath, fingerprint, publicKeyLine }
}

async function fingerprintOf(publicKeyPath: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileP("ssh-keygen", ["-lf", publicKeyPath], { env })
  // "256 SHA256:xxxx comment (ED25519)" — the fingerprint is the 2nd field.
  const fp = stdout.trim().split(/\s+/)[1]
  if (!fp) throw new Error(`could not parse a fingerprint from: ${stdout.trim()}`)
  return fp
}

/** The ready-to-paste `allowed_signers` line for `principal` + this key —
 *  what `agentproto review key show` prints. */
export function allowedSignersLine(principal: string, publicKeyLine: string): string {
  const [algo, key] = publicKeyLine.trim().split(/\s+/)
  if (!algo || !key) throw new Error(`malformed public key line: ${publicKeyLine}`)
  return `${principal} namespaces="${SIGN_NAMESPACE}" ${algo} ${key}`
}

/** `principal` = the owner identity a signature claims: an explicitly
 *  configured value if the caller has one, else `git config user.email` of
 *  the reviewed repo, else a host-derived fallback so signing never blocks
 *  on an unconfigured git identity. */
export async function resolvePrincipal(opts: { repoRoot: string; configuredPrincipal?: string }): Promise<string> {
  if (opts.configuredPrincipal) return opts.configuredPrincipal
  const email = await new Promise<string | undefined>((resolvePromise) => {
    execFile("git", ["config", "user.email"], { cwd: opts.repoRoot }, (err, stdout) => {
      resolvePromise(err ? undefined : stdout.trim() || undefined)
    })
  })
  return email ?? `agentproto-review@${hostname()}`
}

export type ReviewSignature = NonNullable<Attestor["signature"]>

/**
 * Sign `att` with the daemon's review key, generating it on first use.
 * NEVER throws — a signing failure (no `ssh-keygen`, unreadable key, …)
 * resolves `{ error }` so the caller can write the attestation unsigned
 * with the reason recorded, rather than failing the review.
 */
export async function signAttestation(
  att: Attestation,
  opts: { principal: string; keysDir?: string; env?: NodeJS.ProcessEnv },
): Promise<{ signature?: ReviewSignature; error?: string }> {
  let key: ReviewSigningKey
  try {
    key = await ensureReviewSigningKey({ dir: opts.keysDir, env: opts.env })
  } catch (err) {
    return { error: `could not prepare the review signing key: ${errMessage(err)}` }
  }
  const tmpDir = await mkdtemp(join(tmpdir(), "agentproto-review-sign-"))
  try {
    const payloadPath = join(tmpDir, "attestation.json")
    await writeFile(payloadPath, canonicalAttestationBytes(att), "utf8")
    await execFileP("ssh-keygen", ["-Y", "sign", "-f", key.privateKeyPath, "-n", SIGN_NAMESPACE, payloadPath], {
      env: opts.env,
    })
    const sig = await readFile(`${payloadPath}.sig`, "utf8")
    return {
      signature: {
        alg: "ssh-ed25519",
        keyFingerprint: key.fingerprint,
        principal: opts.principal,
        signedAt: new Date().toISOString(),
        sig,
      },
    }
  } catch (err) {
    return { error: `could not sign the attestation: ${isNotFound(err) ? "ssh-keygen not found on PATH" : errMessage(err)}` }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export interface VerifySignedAttestationResult {
  ok: boolean
  problems: string[]
}

/**
 * Verify `att.attestor.signature` against `allowedSignersPath`: the claimed
 * principal must map (per the allowed_signers file) to the signing key
 * (`ssh-keygen -Y find-principals`), and the signature must verify over the
 * canonical bytes recomputed from `att` right now (`ssh-keygen -Y verify`) —
 * so ANY tamper (verdict, a lane, the principal claim itself) breaks it.
 * Never throws; every failure mode (missing signature, missing/unreadable
 * allowed_signers, key not recognized, bad signature, no `ssh-keygen`)
 * comes back as a `problems` entry.
 */
export async function verifySignedAttestation(
  att: Attestation,
  opts: { allowedSignersPath: string; env?: NodeJS.ProcessEnv },
): Promise<VerifySignedAttestationResult> {
  const sig = att.attestor.signature
  if (!sig) return { ok: false, problems: ["attestation is not signed"] }

  let allowedSignersReadable = true
  try {
    await stat(opts.allowedSignersPath)
  } catch {
    allowedSignersReadable = false
  }
  if (!allowedSignersReadable) {
    return { ok: false, problems: [`allowed_signers file not found: ${opts.allowedSignersPath}`] }
  }

  const tmpDir = await mkdtemp(join(tmpdir(), "agentproto-review-verify-"))
  try {
    const payload = canonicalAttestationBytes(att)
    const payloadPath = join(tmpDir, "attestation.json")
    const sigPath = `${payloadPath}.sig`
    await writeFile(payloadPath, payload, "utf8")
    await writeFile(sigPath, sig.sig.endsWith("\n") ? sig.sig : `${sig.sig}\n`, "utf8")

    let principals: string[]
    try {
      const { stdout } = await execFileP(
        "ssh-keygen",
        ["-Y", "find-principals", "-f", opts.allowedSignersPath, "-s", sigPath],
        { env: opts.env },
      )
      principals = stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
    } catch (err) {
      if (isNotFound(err)) return { ok: false, problems: ["ssh-keygen is not available — cannot verify signatures"] }
      // A non-zero exit with no matching principal prints nothing useful on
      // stdout; treat it the same as "no principal maps to this key".
      principals = []
    }
    if (!principals.includes(sig.principal)) {
      return {
        ok: false,
        problems: [`no principal '${sig.principal}' maps to the signing key (${sig.keyFingerprint}) in ${opts.allowedSignersPath}`],
      }
    }

    try {
      await execFileP(
        "ssh-keygen",
        ["-Y", "verify", "-f", opts.allowedSignersPath, "-I", sig.principal, "-n", SIGN_NAMESPACE, "-s", sigPath],
        { input: payload, env: opts.env },
      )
    } catch (err) {
      if (isNotFound(err)) return { ok: false, problems: ["ssh-keygen is not available — cannot verify signatures"] }
      return { ok: false, problems: [`signature does not verify: ${errMessage(err)}`] }
    }
    return { ok: true, problems: [] }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Small helper so callers (the CLI's `review verify`) can resolve a default
 *  `.agentproto/allowed_signers` without their own `existsSync` import. */
export async function fileExists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false)
}
