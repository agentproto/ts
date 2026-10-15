/**
 * Provider config for `cloudflare-managed`: the zone list, hostname → zone
 * resolution, and API-token references.
 *
 * Stored through `setup_tunnel_provider` in the tunnel creds store
 * (`~/.agentproto/tunnel-creds/cloudflare-managed.json`, 0600) as two
 * string fields:
 *
 *   zones       JSON array, one entry per zone the engine may write to:
 *               [{ "zone": "agentik.net", "accountId": "…", "tokenRef": "env:CF_TOKEN_AGENTIK",
 *                  "zoneId"?: "…", "maxLabels"?: 1 }, …]
 *   zoneTokens  OPTIONAL JSON object of raw tokens, `{ "<key>": "<token>" }`,
 *               referenced from a zone as `tokenRef: "stored:<key>"`. Lives
 *               only in the 0600 creds file; never echoed, never logged.
 *
 * A `tokenRef` is a reference, never the token itself:
 *   env:<VAR>        read from the daemon's environment
 *   file:<path>      read from a file that must be owner-only (no group/other bits)
 *   keychain:<path>  read from the OS keychain (`@agentproto/auth` KeychainStore)
 *   stored:<key>     read from `zoneTokens` in the 0600 creds file
 */

import { readFile, stat } from "node:fs/promises"
import { KeychainStore, type CredentialStore } from "@agentproto/auth"

export interface ManagedZoneConfig {
  /** Zone apex, e.g. "agentik.net". */
  zone: string
  /** Cloudflare account id the zone (and its tunnels) live in. */
  accountId: string
  /** Token reference — see the module header. Never the raw token. */
  tokenRef: string
  /** Zone id; looked up by name via the API when omitted. */
  zoneId?: string
  /**
   * How many labels under the zone a hostname may have. Default 1: a zone
   * without Advanced Certificate Manager only has an edge certificate for
   * `*.zone`, so `a.b.zone` would fail TLS at the edge.
   */
  maxLabels?: number
}

export const DEFAULT_MAX_LABELS = 1

const TOKEN_REF_RE = /^(env|file|keychain|stored):.+$/

/** Parse + validate the `zones` setup field. Throws with a precise message. */
export function parseManagedZones(raw: string | undefined | null): ManagedZoneConfig[] {
  if (raw === undefined || raw === null || raw.trim() === "") {
    throw new Error(
      "cloudflare-managed is not configured: run setup_tunnel_provider with " +
        '`zones` (JSON array of { zone, accountId, tokenRef, maxLabels? })',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("cloudflare-managed: `zones` must be a JSON array")
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("cloudflare-managed: `zones` must be a non-empty JSON array")
  }
  const seen = new Set<string>()
  return parsed.map((z, i): ManagedZoneConfig => {
    const at = `cloudflare-managed: zones[${i}]`
    if (!z || typeof z !== "object") throw new Error(`${at} must be an object`)
    const o = z as Record<string, unknown>
    const zone = typeof o.zone === "string" ? normalizeHost(o.zone) : ""
    if (!zone || !zone.includes(".")) throw new Error(`${at}.zone must be a domain (e.g. "example.com")`)
    if (seen.has(zone)) throw new Error(`${at}: zone "${zone}" is listed twice`)
    seen.add(zone)
    if (typeof o.accountId !== "string" || o.accountId.length === 0) {
      throw new Error(`${at}.accountId is required`)
    }
    if (typeof o.tokenRef !== "string" || !TOKEN_REF_RE.test(o.tokenRef)) {
      throw new Error(
        `${at}.tokenRef must be a reference (env:<VAR> | file:<path> | keychain:<path> | stored:<key>), not a raw token`,
      )
    }
    if (o.zoneId !== undefined && (typeof o.zoneId !== "string" || o.zoneId.length === 0)) {
      throw new Error(`${at}.zoneId must be a non-empty string when set`)
    }
    if (
      o.maxLabels !== undefined &&
      (typeof o.maxLabels !== "number" || !Number.isInteger(o.maxLabels) || o.maxLabels < 1)
    ) {
      throw new Error(`${at}.maxLabels must be an integer >= 1`)
    }
    return {
      zone,
      accountId: o.accountId,
      tokenRef: o.tokenRef,
      ...(typeof o.zoneId === "string" ? { zoneId: o.zoneId } : {}),
      ...(typeof o.maxLabels === "number" ? { maxLabels: o.maxLabels } : {}),
    }
  })
}

/** Parse the optional `zoneTokens` field. Errors never include a value. */
export function parseStoredTokens(raw: string | undefined | null): Record<string, string> {
  if (raw === undefined || raw === null || raw.trim() === "") return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("cloudflare-managed: `zoneTokens` must be a JSON object of { key: token }")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("cloudflare-managed: `zoneTokens` must be a JSON object of { key: token }")
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`cloudflare-managed: zoneTokens["${k}"] must be a non-empty string`)
    }
    out[k] = v
  }
  return out
}

export function normalizeHost(h: string): string {
  return h.trim().toLowerCase().replace(/\.$/, "")
}

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/**
 * Pick the zone that serves `hostname` (longest suffix wins, so a delegated
 * `eu.example.com` zone beats `example.com`) and check the hostname depth
 * against that zone's `maxLabels`. Throws a message naming the configured
 * zones when nothing matches.
 */
export function resolveZoneForHostname(
  zones: readonly ManagedZoneConfig[],
  hostnameRaw: string,
): ManagedZoneConfig {
  const hostname = normalizeHost(hostnameRaw)
  const labels = hostname.split(".")
  if (labels.length < 2 || !labels.every(l => LABEL_RE.test(l))) {
    throw new Error(`cloudflare-managed: "${hostnameRaw}" is not a valid hostname`)
  }
  const match = [...zones]
    .filter(z => hostname.endsWith(`.${z.zone}`) || hostname === z.zone)
    .sort((a, b) => b.zone.length - a.zone.length)[0]
  if (!match) {
    throw new Error(
      `cloudflare-managed: no configured zone serves "${hostname}" ` +
        `(configured: ${zones.map(z => z.zone).join(", ") || "none"}). ` +
        "Add the zone via setup_tunnel_provider.",
    )
  }
  if (hostname === match.zone) {
    throw new Error(
      `cloudflare-managed: refusing to route the zone apex "${hostname}" — use a subdomain`,
    )
  }
  const depth = hostname.slice(0, -(match.zone.length + 1)).split(".").length
  const max = match.maxLabels ?? DEFAULT_MAX_LABELS
  if (depth > max) {
    throw new Error(
      `cloudflare-managed: "${hostname}" is ${depth} labels deep under zone "${match.zone}", ` +
        `which only serves ${max} (maxLabels). Without Advanced Certificate Manager the edge ` +
        `certificate only covers *.${match.zone} — use e.g. "${labels[0]}.${match.zone}", ` +
        "or raise maxLabels for this zone once ACM covers the deeper name.",
    )
  }
  return match
}

export type TokenResolver = (ref: string) => Promise<string>

export interface TokenResolverOptions {
  storedTokens?: Record<string, string>
  env?: NodeJS.ProcessEnv
  /** Keychain backend; defaults to the OS keychain. Injectable for tests. */
  keychain?: Pick<CredentialStore, "read">
  /** Platform override for the file-permission check (tests). */
  platform?: NodeJS.Platform
}

/**
 * Build the resolver that turns a `tokenRef` into the token. Errors name the
 * reference, never a value.
 */
export function makeTokenResolver(opts: TokenResolverOptions = {}): TokenResolver {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  return async (ref: string): Promise<string> => {
    const idx = ref.indexOf(":")
    const scheme = ref.slice(0, idx)
    const rest = ref.slice(idx + 1)
    let value: string | undefined
    switch (scheme) {
      case "env":
        value = env[rest]
        break
      case "stored":
        value = opts.storedTokens?.[rest]
        break
      case "file": {
        let st
        try {
          st = await stat(rest)
        } catch {
          throw new Error(`cloudflare-managed: token file for tokenRef "${ref}" not found`)
        }
        if (platform !== "win32" && (st.mode & 0o077) !== 0) {
          throw new Error(
            `cloudflare-managed: token file for tokenRef "${ref}" is readable by group/other — chmod 600 it`,
          )
        }
        value = (await readFile(rest, "utf8")).trim()
        break
      }
      case "keychain": {
        const store = opts.keychain ?? new KeychainStore()
        const stored = await store.read({ path: rest })
        value = stored?.value
        break
      }
      default:
        throw new Error(`cloudflare-managed: unsupported tokenRef scheme in "${ref}"`)
    }
    if (!value) {
      throw new Error(`cloudflare-managed: tokenRef "${ref}" resolved to nothing`)
    }
    return value
  }
}
