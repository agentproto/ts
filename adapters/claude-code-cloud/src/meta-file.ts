/**
 * AIP-66 §5/§8 — how this relay REPORTS the learned vendor session
 * identity to the host.
 *
 * The host (the runtime's `session-spawn.ts` + `cloud-vendors.ts`) hands
 * the relay the path of a file inside the session's isolated config dir via
 * `AGENTPROTO_CLOUD_SESSION_META_FILE`. Once the vendor has returned a
 * session id — after `claude --cloud` prints it, or when `session/load`
 * adopts the id persisted on `meta.cloud.sessionId` — the relay writes
 * exactly the three §5 fields `{ vendor, sessionId, url }` there, and the
 * host polls that file (`watchCloudSessionMeta`) to stamp
 * `meta.cloud = { vendor, sessionId, url }` onto the descriptor.
 *
 * ONLY those three fields are ever written: the vendor's OAuth credential
 * never enters this file, logs or events (AIP-66 §8). The write is
 * best-effort and atomic (temp file + rename), so a failed side-file write
 * can never sink the turn that learned the id — the host's poll simply
 * keeps watching.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

/** Env var carrying the absolute path of the meta file. Mirrors the
 *  runtime's `CLOUD_SESSION_META_FILE_ENV` (cloud-vendors.ts) — the two
 *  must stay byte-identical or the relay writes where nobody reads. */
export const CLOUD_SESSION_META_FILE_ENV = "AGENTPROTO_CLOUD_SESSION_META_FILE"

/** The vendor slug this adapter relays to (AIP-66 §2 `CloudVendor.slug`,
 *  registry entry `anthropic` → adapter `claude-code-cloud`). */
export const CLOUD_VENDOR_SLUG = "anthropic"

/** The §5 mapping the relay reports. NEVER carries a credential. */
export interface CloudSessionMetaReport {
  vendor: string
  /** Vendor session id — CLI spelling (`session_<id>`). */
  sessionId: string
  /** Session URL when known (the start path prints it; a re-attach may
   *  inherit it from the file already on disk). */
  url?: string
}

/** Read + parse a previously written meta file. Returns undefined for
 *  absent/garbage — never throws (this is a side file, not a contract). */
async function readExisting(path: string): Promise<CloudSessionMetaReport | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    const p = parsed as Record<string, unknown>
    if (typeof p["vendor"] !== "string" || p["vendor"].length === 0) return undefined
    if (typeof p["sessionId"] !== "string" || p["sessionId"].length === 0) return undefined
    return {
      vendor: p["vendor"],
      sessionId: p["sessionId"],
      ...(typeof p["url"] === "string" && p["url"].length > 0 ? { url: p["url"] } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * Write `{ vendor, sessionId, url }` to the meta file the host named in
 * `AGENTPROTO_CLOUD_SESSION_META_FILE`. Returns the path written, or null
 * when the env var is unset or the write failed (best-effort: the host's
 * poll retries, and a cloud turn must never fail over a side file).
 *
 * A re-attach (`session/load`) carries no URL — when the id on disk matches
 * the one being reported, the existing `url` is preserved so the host's
 * later read keeps the full §5 mapping.
 */
export async function writeCloudSessionMeta(
  meta: CloudSessionMetaReport,
  opts: { env?: Record<string, string | undefined> } = {},
): Promise<string | null> {
  const env = opts.env ?? process.env
  const path = env[CLOUD_SESSION_META_FILE_ENV]
  if (!path) return null
  try {
    const existing = await readExisting(path)
    const url =
      meta.url ??
      (existing?.sessionId === meta.sessionId ? existing.url : undefined)
    const payload = JSON.stringify({
      vendor: meta.vendor,
      sessionId: meta.sessionId,
      ...(url !== undefined ? { url } : {}),
    })
    await mkdir(dirname(path), { recursive: true })
    // Temp + rename: the host polls this file, and a torn read must never
    // be observed (parse failures would just stall the learn, but atomicity
    // costs nothing here).
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, payload, "utf8")
    await rename(tmp, path)
    return path
  } catch (err) {
    process.stderr.write(
      `[claude-code-cloud] could not write the cloud session meta file ` +
        `(${CLOUD_SESSION_META_FILE_ENV}): ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return null
  }
}
