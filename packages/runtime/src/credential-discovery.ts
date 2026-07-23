/**
 * Read-only DISCOVERY SCANNER — `auth_discover_credentials`.
 *
 * Probes the well-known local locations where the CLIs and gateways this host
 * knows about write their credentials (Claude Code's OAuth item, Codex/Gemini
 * login files, `~/.hermes/config.yaml`, and the provider API-key env vars) and
 * reports what it FINDS — so onboarding can offer to import a credential the
 * user already has, instead of making them paste it again.
 *
 * It is a scanner, not a resolver. Two invariants make it money-safe, and the
 * suite in `__tests__/credential-discovery.test.ts` is written against both:
 *
 *  1. NEVER return (or log) a discovered secret's VALUE. Every probe answers a
 *     BOOLEAN "is a non-empty credential present here?" via {@link jsonFieldPresent}
 *     / a presence check — the value is never bound into a result, only a
 *     non-secret `hint` locator ("OPENROUTER_API_KEY in ~/.hermes/config.yaml").
 *     This mirrors `verifyLocalLoginPresent`'s discard-the-value discipline in
 *     `claude-code-oauth-source.ts`, taken one step further: we never hold the
 *     plaintext at all.
 *
 *  2. NEVER throw on a malformed/unreadable source. A single corrupt file must
 *     not sink the whole scan — each probe is wrapped so a parse error / bad
 *     permission becomes a per-source `warn`+skip (same "malformed → empty, not
 *     fatal" spirit as `loadProviders`). A MISSING file is normal "not found",
 *     not even a warning.
 *
 * The source recipes (Keychain service name, file paths, jsonPaths) mirror the
 * builtin provision recipes in
 * `@agentproto/secrets/provision/recipe` (`claudeCodeOauthRecipe`,
 * `codexRecipe`, `geminiRecipe`) so discovery and provisioning agree on where a
 * credential lives.
 *
 * PHASE 1 (this file) is pure discovery: it reports EVERYTHING it finds, with
 * provenance. Cross-referencing against already-imported profiles (the
 * "found-but-not-*imported*" filter, keyed on a future AuthProfile `origin`
 * field) is Phase 2 and is deliberately not done here.
 */

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

/** Where a discovered credential came from. Stable, non-secret provenance. */
export type CredentialOrigin =
  | "claude-code"
  | "hermes-config"
  | "env"
  | "codex"
  | "gemini"

/** One found-but-not-imported credential. Carries provenance and a non-secret
 *  locator only — NEVER the credential value. */
export interface DiscoveredCredential {
  /** Billing endpoint / vendor the credential is for (anthropic, openai, …). */
  endpoint: string
  /** Auth method the credential installs as. */
  method: "oauth-bearer" | "api-key"
  /** Where it was found. */
  origin: CredentialOrigin
  /** Non-secret human locator — e.g. "OPENROUTER_API_KEY in ~/.hermes/config.yaml".
   *  Says WHERE the secret is, never WHAT it is. */
  hint: string
}

/**
 * Injectable I/O so the scanner is unit-testable without touching the real
 * home dir / Keychain. Defaults reach for the real host.
 */
export interface CredentialDiscoveryDeps {
  /** Home directory (`~` expands to this). Default: `os.homedir()`. */
  homeDir?: string
  /** Process env to probe. Default: `process.env`. */
  env?: Record<string, string | undefined>
  /** Read a file's text. MUST throw a Node-style error with `.code === "ENOENT"`
   *  for a missing file (the default `readFileSync` does). Default: real fs. */
  readFile?: (path: string) => string
  /** Look up a macOS Keychain generic-password by service, returning its raw
   *  value; MUST throw when the item is absent. Default: `security find-generic-password`
   *  on darwin, always-throws elsewhere. */
  keychainLookup?: (service: string) => string
  /** Platform gate for the Keychain probe. Default: `process.platform`. */
  platform?: NodeJS.Platform
  /** Non-secret warning sink for a malformed/unreadable source. Default: no-op. */
  warn?: (message: string) => void
}

interface ResolvedDeps {
  homeDir: string
  env: Record<string, string | undefined>
  readFile: (path: string) => string
  keychainLookup: (service: string) => string
  platform: NodeJS.Platform
  warn: (message: string) => void
}

/** A Node fs error for a file that does not exist — a normal "not found", not a
 *  malformed-source warning. */
function isMissingFile(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  )
}

function expandHome(homeDir: string, p: string): string {
  if (p === "~") return homeDir
  if (p.startsWith("~/")) return homeDir.replace(/\/$/, "") + "/" + p.slice(2)
  return p
}

/**
 * Is there a non-empty STRING at `path` in this JSON text? Returns a boolean —
 * it deliberately NEVER returns the value, so a discovered secret can't leak
 * through it. Throws only if the text isn't parseable JSON (a malformed
 * source), which the caller turns into a warn+skip.
 */
export function jsonFieldPresent(raw: string, path: string): boolean {
  let cur: unknown = JSON.parse(raw)
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return false
    cur = (cur as Record<string, unknown>)[part]
  }
  return typeof cur === "string" && cur.length > 0
}

/**
 * Does `~/.hermes/config.yaml` carry a non-empty value for `key`? A minimal,
 * dependency-free presence check (no YAML parser pulled in): scan for a
 * top-levelish `KEY: <value>` line whose value isn't blank/empty-quotes.
 * Returns a boolean only — never the value.
 */
export function yamlKeyPresent(raw: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(`^\\s*${escaped}\\s*:\\s*(.*)$`, "m")
  const m = re.exec(raw)
  if (!m) return false
  // Strip surrounding quotes; an empty remainder = no value.
  let value = (m[1] ?? "").trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1)
  }
  return value.length > 0
}

/** claude-code OAuth item, and its file fallback — mirrors `claudeCodeOauthRecipe`. */
const CLAUDE_CODE_KEYCHAIN = "Claude Code-credentials"
const CLAUDE_CODE_JSON_PATH = "claudeAiOauth.accessToken"
const CLAUDE_CODE_FILE = "~/.claude/.credentials.json"

/** File-based OAuth logins — mirror `codexRecipe` / `geminiRecipe`. */
const FILE_OAUTH_PROBES: ReadonlyArray<{
  origin: CredentialOrigin
  endpoint: string
  file: string
  jsonPath: string
}> = [
  { origin: "codex", endpoint: "openai", file: "~/.codex/auth.json", jsonPath: "tokens.access_token" },
  { origin: "gemini", endpoint: "google", file: "~/.gemini/oauth_creds.json", jsonPath: "access_token" },
]

/** `~/.hermes/config.yaml` gateway keys — presence only. */
const HERMES_FILE = "~/.hermes/config.yaml"
const HERMES_KEYS: ReadonlyArray<{ key: string; endpoint: string }> = [
  { key: "OPENROUTER_API_KEY", endpoint: "openrouter" },
  { key: "OPENAI_API_KEY", endpoint: "openai" },
]

/** Provider API-key env vars — presence only. */
const ENV_KEYS: ReadonlyArray<{ env: string; endpoint: string }> = [
  { env: "OPENROUTER_API_KEY", endpoint: "openrouter" },
  { env: "MOONSHOT_API_KEY", endpoint: "moonshot" },
  { env: "OPENAI_API_KEY", endpoint: "openai" },
  { env: "ANTHROPIC_API_KEY", endpoint: "anthropic" },
  { env: "DEEPSEEK_API_KEY", endpoint: "deepseek" },
  { env: "XAI_API_KEY", endpoint: "xai" },
]

function defaultKeychainLookup(service: string): string {
  return execFileSync("security", ["find-generic-password", "-w", "-s", service], {
    encoding: "utf8",
  }).trim()
}

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8")
}

function resolveDeps(deps: CredentialDiscoveryDeps): ResolvedDeps {
  const platform = deps.platform ?? process.platform
  return {
    homeDir: deps.homeDir ?? homedir(),
    env: deps.env ?? process.env,
    readFile: deps.readFile ?? defaultReadFile,
    keychainLookup:
      deps.keychainLookup ??
      (platform === "darwin"
        ? defaultKeychainLookup
        : () => {
            throw new Error("keychain is macOS-only")
          }),
    platform,
    warn: deps.warn ?? (() => {}),
  }
}

/**
 * Scan the known local credential locations and report what's present, with
 * provenance and a non-secret locator. Read-only, and safe against a corrupt
 * or unreadable source (per-source warn+skip). NEVER returns a secret value.
 */
export function discoverCredentials(
  deps: CredentialDiscoveryDeps = {},
): DiscoveredCredential[] {
  const d = resolveDeps(deps)
  const found: DiscoveredCredential[] = []

  probeClaudeCode(d, found)
  for (const probe of FILE_OAUTH_PROBES) probeFileOauth(d, probe, found)
  probeHermes(d, found)
  probeEnv(d, found)

  return found
}

function probeClaudeCode(d: ResolvedDeps, out: DiscoveredCredential[]): void {
  // Keychain first (macOS), then the file fallback — first hit wins, reported
  // once. Mirrors the recipe's ordered source chain.
  if (d.platform === "darwin") {
    try {
      const raw = d.keychainLookup(CLAUDE_CODE_KEYCHAIN)
      if (raw && jsonFieldPresent(raw, CLAUDE_CODE_JSON_PATH)) {
        out.push({
          endpoint: "anthropic",
          method: "oauth-bearer",
          origin: "claude-code",
          hint: `Claude Code OAuth token in macOS Keychain ("${CLAUDE_CODE_KEYCHAIN}")`,
        })
        return
      }
    } catch (err) {
      // A missing Keychain item throws too — that's a normal "not logged in",
      // not a malformed source, so don't warn on it. Fall through to the file.
      void err
    }
  }
  try {
    const raw = d.readFile(expandHome(d.homeDir, CLAUDE_CODE_FILE))
    if (jsonFieldPresent(raw, CLAUDE_CODE_JSON_PATH)) {
      out.push({
        endpoint: "anthropic",
        method: "oauth-bearer",
        origin: "claude-code",
        hint: `Claude Code OAuth token in ${CLAUDE_CODE_FILE}`,
      })
    }
  } catch (err) {
    if (!isMissingFile(err)) {
      d.warn(`skipping ${CLAUDE_CODE_FILE}: ${errText(err)}`)
    }
  }
}

function probeFileOauth(
  d: ResolvedDeps,
  probe: { origin: CredentialOrigin; endpoint: string; file: string; jsonPath: string },
  out: DiscoveredCredential[],
): void {
  try {
    const raw = d.readFile(expandHome(d.homeDir, probe.file))
    if (jsonFieldPresent(raw, probe.jsonPath)) {
      out.push({
        endpoint: probe.endpoint,
        method: "oauth-bearer",
        origin: probe.origin,
        hint: `${probe.origin} OAuth token in ${probe.file}`,
      })
    }
  } catch (err) {
    if (!isMissingFile(err)) {
      d.warn(`skipping ${probe.file}: ${errText(err)}`)
    }
  }
}

function probeHermes(d: ResolvedDeps, out: DiscoveredCredential[]): void {
  let raw: string
  try {
    raw = d.readFile(expandHome(d.homeDir, HERMES_FILE))
  } catch (err) {
    if (!isMissingFile(err)) d.warn(`skipping ${HERMES_FILE}: ${errText(err)}`)
    return
  }
  for (const { key, endpoint } of HERMES_KEYS) {
    try {
      if (yamlKeyPresent(raw, key)) {
        out.push({
          endpoint,
          method: "api-key",
          origin: "hermes-config",
          hint: `${key} in ${HERMES_FILE}`,
        })
      }
    } catch (err) {
      d.warn(`skipping ${key} in ${HERMES_FILE}: ${errText(err)}`)
    }
  }
}

function probeEnv(d: ResolvedDeps, out: DiscoveredCredential[]): void {
  for (const { env, endpoint } of ENV_KEYS) {
    const value = d.env[env]
    if (value && value.trim().length > 0) {
      out.push({
        endpoint,
        method: "api-key",
        origin: "env",
        hint: `${env} in the environment`,
      })
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function text(value: string | object): {
  content: Array<{ type: "text"; text: string }>
} {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  }
}

function errorText(message: string): {
  content: Array<{ type: "text"; text: string }>
  isError: true
} {
  return { content: [{ type: "text", text: message }], isError: true }
}

export function registerCredentialDiscoveryTools(server: McpServer): void {
  // ── auth_discover_credentials ─────────────────────────────────
  server.tool(
    "auth_discover_credentials",
    "Read-only scan of the known local credential locations (Claude Code's " +
      "Keychain/OAuth file, Codex/Gemini login files, `~/.hermes/config.yaml`, " +
      "and the provider API-key env vars). Reports which credentials are " +
      "PRESENT and where they came from, so onboarding can offer to import one " +
      "you already have. Returns only non-secret provenance — `{ endpoint, " +
      "method, origin, hint }` — and NEVER the credential value; the `hint` is " +
      "a locator, not the secret. A malformed or unreadable source is skipped, " +
      "never fatal; a missing file is a normal 'not found'.",
    {},
    async () => {
      try {
        const warnings: string[] = []
        const credentials = discoverCredentials({ warn: (m) => warnings.push(m) })
        return text({
          credentials,
          ...(warnings.length ? { warnings } : {}),
        })
      } catch (err) {
        return errorText(`auth_discover_credentials failed: ${errText(err)}`)
      }
    },
  )
}
