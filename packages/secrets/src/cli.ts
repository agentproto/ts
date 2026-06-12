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
 */

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

const USAGE = `agentproto-secrets — seal secrets and install them into a vault

  keygen                                   mint a sealing keypair (JSON to stdout)
  seal     --pubkey <b64> [value|src]      seal a value -> sealed blob (stdout)
  unseal   --privkey <b64> [blob|src]      open a sealed blob -> plaintext (stdout)
  provision --provider P --seal-key-url URL --install-url URL \\
            [--method M] [--header 'K: V']... [src]
                                           seal a local credential and install it,
                                           carrying only ciphertext. A known
                                           --provider resolves its method + source
                                           from a builtin recipe; --method picks a
                                           flavor; an explicit src overrides.

  src: --from-file <path> [--json-path a.b.c] | --from-env <VAR>
  builtin providers: ${listRecipeIds().join(", ")}`

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2)
  const args = parse(rest)

  switch (cmd) {
    case "keygen": {
      const kp = generateSealKeyPair()
      process.stdout.write(
        JSON.stringify(
          { keyId: sealKeyId(kp.publicKey), publicKey: kp.publicKey, privateKey: kp.privateKey },
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
      process.stdout.write(seal(value, pubkey))
      return 0
    }

    case "unseal": {
      const privkey = args.flags.privkey
      if (!privkey) return fail("unseal: --privkey <b64> required")
      const blob =
        args.positionals[0] ?? (await resolveCredential(credentialSource(args)))
      process.stdout.write(unseal(blob, privkey))
      return 0
    }

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

      const target = httpTarget({
        sealKeyUrl,
        installUrl,
        headers: parseHeaders(args.headers),
      })
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

main()
  .then(code => {
    process.exitCode = code
  })
  .catch(err => {
    process.stderr.write(
      `agentproto-secrets: ${err instanceof Error ? err.message : String(err)}\n`
    )
    process.exitCode = 1
  })
