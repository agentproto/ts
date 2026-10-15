/**
 * agentproto-secrets — a small CLI over the seal primitive + provision flow.
 *
 *   agentproto-secrets keygen                          mint a sealing keypair (JSON)
 *   agentproto-secrets seal     --pubkey <b64> [src]   seal a value -> sealed blob
 *   agentproto-secrets unseal   --privkey <b64> [blob] open a sealed blob -> plaintext
 *   agentproto-secrets provision --provider P --method M \
 *       --seal-key-url URL --install-url URL [--header 'K: V']... [src]
 *                                                       seal a local credential and
 *                                                       install it into a vault,
 *                                                       carrying only ciphertext
 *
 *   credential source [src]: --from-file <path> [--json-path a.b.c] | --from-env <VAR>
 *
 * Vendor-neutral: `provision` takes the server's URLs + auth headers as flags.
 * The plaintext credential is read, sealed, and sent — it is never printed.
 * When `--header` is omitted and `--provider` names an auth provider
 * registered in `@agentproto/auth`, the Authorization header is instead
 * resolved via `CredentialBroker` (this is the only file in this package
 * that imports `@agentproto/auth` — see `ProvisionAuthDeps` below).
 */

import { CredentialBroker, KeychainStore, getAuthProvider } from "@agentproto/auth"
import {
  generateSealKeyPair,
  sealKeyId,
  seal,
  unseal,
} from "./seal/index.js"
import {
  provisionSealed,
  httpTarget,
  resolveCredential,
  type CredentialSource,
} from "./provision/index.js"
import {
  resolveRecipeMethod,
  resolveSourceSpec,
  listRecipeIds,
  readRecipeOauthJson,
} from "./provision/recipe/index.js"

interface Args {
  positionals: string[]
  flags: Record<string, string>
  headers: string[]
}

function parse(argv: string[]): Args {
  const positionals: string[] = []
  const flags: Record<string, string> = {}
  const headers: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      let key: string
      let val: string
      if (eq !== -1) {
        key = a.slice(2, eq)
        val = a.slice(eq + 1)
      } else {
        key = a.slice(2)
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith("--")) {
          val = next
          i++
        } else {
          val = "true"
        }
      }
      if (key === "header") headers.push(val)
      else flags[key] = val
    } else {
      positionals.push(a)
    }
  }
  return { positionals, flags, headers }
}

function credentialSource(args: Args): CredentialSource {
  return {
    ...(args.flags["from-env"] ? { fromEnv: args.flags["from-env"] } : {}),
    ...(args.flags["from-file"] ? { fromFile: args.flags["from-file"] } : {}),
    ...(args.flags["json-path"] ? { jsonPath: args.flags["json-path"] } : {}),
  }
}

/** Read a value for seal: a positional, or a credential source. */
async function readValue(args: Args): Promise<string> {
  if (args.positionals[0]) return args.positionals[0]
  return resolveCredential(credentialSource(args))
}

/** Read one line from stdin (for a recipe's `prompt` credential source). */
async function promptStdin(prompt: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises")
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return (await rl.question(`${prompt}: `)).trim()
  } finally {
    rl.close()
  }
}

/**
 * Resolve the {methodId, credential, label} a provision installs. A recipe
 * (`--provider <id>`) supplies the auth-method id + where the credential lives,
 * so no source flags are needed; explicit `--from-file/--from-env` override the
 * recipe for ad-hoc / unknown providers (then `--method` is required).
 */
async function resolveProvision(
  args: Args,
): Promise<{ methodId: string; credential: string; label?: string }> {
  const provider = args.flags.provider!
  const explicit = args.flags["from-file"] || args.flags["from-env"]
  if (explicit) {
    const methodId = args.flags.method
    if (!methodId)
      throw new Error(
        "--method is required when passing an explicit --from-file/--from-env source",
      )
    return {
      methodId,
      credential: await resolveCredential(credentialSource(args)),
      ...(args.flags.label ? { label: args.flags.label } : {}),
    }
  }
  const { recipe, method } = resolveRecipeMethod(provider, args.flags.method)
  const credential = await resolveSourceSpec(method.source, {
    promptImpl: promptStdin,
  })
  const label = args.flags.label ?? method.label ?? recipe.label
  return { methodId: method.id, credential, ...(label ? { label } : {}) }
}

function parseHeaders(raw: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const h of raw) {
    const idx = h.indexOf(":")
    if (idx === -1) continue
    out[h.slice(0, idx).trim()] = h.slice(idx + 1).trim()
  }
  return out
}

// ── capture: local OAuth login -> encrypted vault entry ─────────────────

/** Guidance per provider for the "CLI hasn't logged in yet" case — the command
 *  POINTS at the CLI's own login rather than spawning it (the OAuth flows open
 *  a browser and need the user's presence; automated invocation would be a
 *  second, unofficial client). */
const LOGIN_GUIDANCE: Record<string, string> = {
  "claude-code-oauth": "run the CLI's own `claude login` in your terminal",
  codex: "run the CLI's own `codex login` in your terminal",
}

/** Default local vault dir for capture entries + their sealing key. */
export const DEFAULT_VAULT_DIR = "~/.agentproto/secrets-vault"

/** The capability pointer a captured vault entry answers with — no token
 *  values, just where to resolve it from. Shape mirrors the pair/endpoint
 *  model: an opaque, shareable address carrying only a provider, a method and
 *  the vault's key id. */
export function capabilityPointer(
  provider: string,
  methodId: string,
  keyId: string,
): string {
  return `agentproto-secrets://vault/${provider}?method=${encodeURIComponent(methodId)}&key=${keyId}`
}

export interface CaptureResult {
  pointer: string
  /** Vault file written, as a path (never its content). */
  entryPath: string
  provider: string
  methodId: string
}

/** `~` expansion for vault paths (same convention as resolveCredential). */
function expandHome(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (!home) return p
  if (p === "~") return home
  return p.startsWith("~/") ? `${home}/${p.slice(2)}` : p
}

/**
 * Capture a CLI subscription OAuth login as a FULL AIP-19 oauth value.
 * Resolves the builtin recipe's `oauth` field map against the local login
 * document, seals it to the vault's own local keypair (minted once, 0600), and
 * writes `entries/<provider>.json` (0600). Every path is local-safe: the
 * token values are read only to seal them and never appear in a log, a
 * stdout write or the entry file.
 *
 * Throws the resolver's original "no login file" error when the CLI has not
 * logged in yet — `captureCommand` turns that into login guidance + exit 1.
 */
export async function capture(args: {
  provider?: string
  method?: string
  vaultDir?: string
}): Promise<CaptureResult> {
  const provider = args.provider ?? "claude-code-oauth"
  const vaultDir = expandHome(args.vaultDir ?? DEFAULT_VAULT_DIR)
  const fs = await import("node:fs/promises")

  const value = await readRecipeOauthJson(provider, args.method)
  const { method } = resolveRecipeMethod(provider, args.method)

  await fs.mkdir(vaultDir, { recursive: true, mode: 0o700 })
  const keyPath = `${vaultDir}/key.json`
  const readKey = async (): Promise<{
    keyId: string
    publicKey: string
    privateKey: string
  } | undefined> => {
    try {
      return JSON.parse(await fs.readFile(keyPath, "utf8")) as {
        keyId: string
        publicKey: string
        privateKey: string
      }
    } catch {
      return undefined
    }
  }
  let keyPair = await readKey()
  if (!keyPair) {
    // Mint exclusively so two concurrent captures can't clobber each other's
    // key (and orphan the entries sealed under the loser). The loser re-reads
    // the winner's key instead.
    const kp = await generateSealKeyPair()
    const candidateKey = {
      keyId: await sealKeyId(kp.publicKey),
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
    }
    try {
      await fs.writeFile(keyPath, JSON.stringify(candidateKey), {
        mode: 0o600,
        flag: "wx",
      })
      await fs.chmod(keyPath, 0o600)
      keyPair = candidateKey
    } catch {
      keyPair = await readKey()
    }
  }
  if (!keyPair) throw new Error(`vault key at ${keyPath} is unreadable`)

  const blob = await seal(value, keyPair.publicKey)
  const entry = {
    provider,
    methodId: method.id,
    kind: "oauth" as const,
    keyId: keyPair.keyId,
    sealed: blob,
    capturedAt: new Date().toISOString(),
  }
  const entryPath = `${vaultDir}/entries/${provider}.json`
  await fs.mkdir(`${vaultDir}/entries`, { recursive: true, mode: 0o700 })
  await fs.writeFile(entryPath, JSON.stringify(entry), { mode: 0o600 })
  await fs.chmod(entryPath, 0o600)

  return {
    pointer: capabilityPointer(provider, method.id, keyPair.keyId),
    entryPath,
    provider,
    methodId: method.id,
  }
}

/**
 * CLI wiring for `capture`: shared error-shaping for the not-logged-in case.
 * A "no login file" / keychain miss means the CLI's own login has not run yet;
 * the correct next step is the USER runs `claude login` / `codex login`, not
 * this command spawning a second login client.
 */
export async function captureCommand(args: {
  provider?: string
  method?: string
  vaultDir?: string
}): Promise<number> {
  const provider = args.provider ?? "claude-code-oauth"
  try {
    const { pointer, entryPath } = await capture(args)
    process.stdout.write(
      `captured ${provider} -> ${entryPath}\n` +
        `pointer: ${pointer}\n` +
        `the oauth value (access + refresh + expiry) is encrypted in the vault entry; it was never printed.\n`,
    )
    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const notLoggedIn =
      msg.includes("no login file") || msg.includes("keychain item")
    if (notLoggedIn) {
      process.stderr.write(
        `no ${provider} login found on this machine — ${
          LOGIN_GUIDANCE[provider] ?? "run the CLI's own login flow in your terminal"
        }, then capture again.\n`,
      )
      return 1
    }
    process.stderr.write(`capture failed: ${msg}\n`)
    return 1
  }
}

/** Structural shape `CredentialBroker` satisfies — kept local (rather than
 *  importing the class as a type) so tests can inject a fake without touching
 *  Keychain or the network. */
export interface AuthHeaderResolver {
  resolveHeaders(o: {
    path: string
    audience?: string
    server?: string
    signal?: AbortSignal
  }): Promise<Record<string, string>>
}

export interface ProvisionAuthDeps {
  /** Whether `providerId` is a known `@agentproto/auth` auth provider. */
  isRegistered(providerId: string): boolean
  resolver: AuthHeaderResolver
}

function defaultProvisionAuthDeps(): ProvisionAuthDeps {
  return {
    isRegistered: id => getAuthProvider(id) !== undefined,
    resolver: new CredentialBroker({
      store: new KeychainStore(),
      getProvider: getAuthProvider,
    }),
  }
}

/**
 * Resolve the Authorization (etc.) headers a provision request carries.
 * `--header` is an explicit override — when present, the broker is never
 * consulted. Otherwise, a `--provider` registered in `@agentproto/auth`
 * resolves its headers via the broker; an unregistered provider degrades to
 * `explicitHeaders` (empty when none were passed) rather than failing.
 */
export async function resolveProvisionHeaders(
  provider: string,
  explicitHeaders: string[],
  deps?: ProvisionAuthDeps,
): Promise<Record<string, string>> {
  const parsed = parseHeaders(explicitHeaders)
  if (explicitHeaders.length > 0) return parsed
  const { isRegistered, resolver } = deps ?? defaultProvisionAuthDeps()
  if (!isRegistered(provider)) return parsed
  const brokered = await resolver.resolveHeaders({ path: provider, audience: "api" })
  return { ...brokered, ...parsed }
}

const USAGE = `agentproto-secrets — seal secrets and install them into a vault

  keygen                                   mint a sealing keypair (JSON to stdout)
  seal     --pubkey <b64> [value|src]      seal a value -> sealed blob (stdout)
  unseal   --privkey <b64> [blob|src]      open a sealed blob -> plaintext (stdout)
  capture  [--provider P] [--method M] [--vault-dir D]
                                           capture the FULL local OAuth login of a
                                           CLI ({accessToken, refreshToken,
                                           expiresAt}) from its builtin recipe,
                                           encrypt it into a local vault entry,
                                           and print a capability pointer. The
                                           token values are never printed. If the
                                           CLI has not logged in yet, exit 1 and
                                           say so — run the CLI's own
                                           'claude login' / 'codex login' first.
  provision --provider P --seal-key-url URL --install-url URL \\
            [--method M] [--header 'K: V']... [src]
                                           seal a local credential and install it,
                                           carrying only ciphertext. A known
                                           --provider resolves its method + source
                                           from a builtin recipe; --method picks a
                                           flavor; an explicit src overrides.

  src: --from-file <path> [--json-path a.b.c] | --from-env <VAR>
  builtin providers: ${listRecipeIds().join(", ")}`

export async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2)
  const args = parse(rest)

  switch (cmd) {
    case "keygen": {
      const kp = await generateSealKeyPair()
      process.stdout.write(
        JSON.stringify(
          { keyId: await sealKeyId(kp.publicKey), publicKey: kp.publicKey, privateKey: kp.privateKey },
          null,
          2
        ) + "\n"
      )
      return 0
    }

    case "seal": {
      const pubkey = args.flags.pubkey
      if (!pubkey) return fail("seal: --pubkey <b64> required")
      const value = await readValue(args)
      process.stdout.write(await seal(value, pubkey))
      return 0
    }

    case "unseal": {
      const privkey = args.flags.privkey
      if (!privkey) return fail("unseal: --privkey <b64> required")
      const blob =
        args.positionals[0] ?? (await resolveCredential(credentialSource(args)))
      process.stdout.write(await unseal(blob, privkey))
      return 0
    }

    case "capture":
      return captureCommand({
        ...(args.flags.provider ? { provider: args.flags.provider } : {}),
        ...(args.flags.method ? { method: args.flags.method } : {}),
        ...(args.flags["vault-dir"] ? { vaultDir: args.flags["vault-dir"] } : {}),
      })

    case "provision": {
      const provider = args.flags.provider
      const sealKeyUrl = args.flags["seal-key-url"]
      const installUrl = args.flags["install-url"]
      if (!provider) return fail("provision: --provider required")
      if (!sealKeyUrl || !installUrl)
        return fail("provision: --seal-key-url and --install-url required")

      let methodId: string
      let credential: string
      let label: string | undefined
      try {
        ;({ methodId, credential, label } = await resolveProvision(args))
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }

      let headers: Record<string, string>
      try {
        headers = await resolveProvisionHeaders(provider, args.headers)
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }

      const target = httpTarget({ sealKeyUrl, installUrl, headers })
      try {
        const out = await provisionSealed({
          target,
          provider,
          methodId,
          credential,
          ...(label ? { label } : {}),
        })
        process.stdout.write(
          `sealed + installed ${provider} (${methodId})` +
            (out.secretId ? ` — secret ${out.secretId.slice(0, 8)}` : "") +
            ` [key ${out.keyId.slice(0, 8)}]\n` +
            `the plaintext never left this machine; the server unsealed it.\n`
        )
        return 0
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }

    case "-h":
    case "--help":
    case "help":
    case undefined:
      process.stdout.write(USAGE + "\n")
      return cmd ? 0 : 1

    default:
      return fail(`unknown command '${cmd}'\n\n${USAGE}`)
  }
}

function fail(message: string): number {
  process.stderr.write(`agentproto-secrets: ${message}\n`)
  return 1
}
