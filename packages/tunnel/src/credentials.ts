/**
 * The on-disk credential store for tunnel providers.
 *
 * One flat JSON object per slug under `<agentproto home>/tunnel-creds/`,
 * written `0600` inside a `0700` directory. Secrets (api keys, tokens) live
 * here and nowhere in the repo.
 */

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** Slug rule shared with provider discovery: safe as a filename segment. */
export const TUNNEL_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

export interface TunnelCredsStoreOptions {
  /** Override the agentproto home root (defaults to `AGENTPROTO_HOME` or `~/.agentproto`). */
  home?: string
  /** Override the entire credentials directory. Wins over `home`. */
  dir?: string
}

/** `<agentproto home>/tunnel-creds` - the directory holding every provider's creds. */
export function tunnelCredsDir(options: TunnelCredsStoreOptions = {}): string {
  if (options.dir) return options.dir
  const home = options.home ?? process.env["AGENTPROTO_HOME"] ?? join(homedir(), ".agentproto")
  return join(home, "tunnel-creds")
}

/** Absolute path of one provider's credential file. */
export function tunnelCredsPath(slug: string, options: TunnelCredsStoreOptions = {}): string {
  if (!TUNNEL_SLUG_PATTERN.test(slug)) {
    throw new Error(
      `tunnel credentials: invalid provider slug "${slug}" (expected ${TUNNEL_SLUG_PATTERN})`,
    )
  }
  return join(tunnelCredsDir(options), `${slug}.json`)
}

/**
 * Read a provider's stored setup fields. A missing or unreadable file is
 * `null` - never an error, matching "not configured yet".
 */
export async function readTunnelCredentials(
  slug: string,
  options: TunnelCredsStoreOptions = {},
): Promise<Record<string, string> | null> {
  let raw: string
  try {
    raw = await readFile(tunnelCredsPath(slug, options), "utf8")
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value
    }
    return out
  } catch {
    return null
  }
}

/**
 * Write (or replace) a provider's setup fields with `0600` permissions and
 * return the file path. Parent directories are created `0700`.
 */
export async function writeTunnelCredentials(
  slug: string,
  credentials: Record<string, string>,
  options: TunnelCredsStoreOptions = {},
): Promise<string> {
  const path = tunnelCredsPath(slug, options)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600).catch(() => {})
  return path
}

/** Remove a provider's credential file. Idempotent. */
export async function deleteTunnelCredentials(
  slug: string,
  options: TunnelCredsStoreOptions = {},
): Promise<void> {
  await rm(tunnelCredsPath(slug, options), { force: true })
}
