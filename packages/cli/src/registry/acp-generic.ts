/**
 * Generic ACP agents — connect any ACP-speaking CLI with zero adapter code.
 *
 * Our ACP protocol arm (`createAcpProtocolArm`) is fully adapter-agnostic:
 * it performs the standard `initialize` / `session/new` handshake over stdio
 * JSON-RPC and streams turns, regardless of which binary is on the other end.
 * So any CLI that already speaks the Agent Client Protocol doesn't need a
 * bespoke `@agentproto/adapter-*` package — it just needs a spawn recipe.
 *
 * `acpHandleFromSpec` mints a runnable `AgentCliHandle` from a plain
 * `AcpAgentSpec` (bin + args + env + a few flags). Two sources feed it:
 *   - `ACP_CATALOG` — a conservative, curated list of known ACP CLIs.
 *   - `config.acpAgents` — user-defined entries in `~/.agentproto/config.json`.
 * User entries shadow the catalog on slug collision.
 *
 * `resolveAdapter` (see ./resolve.ts) tries npm first, then these; so a real
 * adapter package always wins over a generic spec of the same slug.
 */

import { promises as fs, constants as fsConstants } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import {
  defineAgentCli,
  type AgentCliHandle,
} from "@agentproto/driver-agent-cli"
import {
  loadConfig,
  type AcpAgentConfigEntry,
  type AgentprotoConfig,
} from "@agentproto/runtime/config"
import type { AdapterInfo } from "./resolve.js"

/**
 * A generic ACP agent's spawn recipe. The config-file form
 * (`AcpAgentConfigEntry`, keyed by slug in `acpAgents`) plus the slug
 * itself. Kept in sync with the runtime config type by extension so the
 * two never drift.
 */
export interface AcpAgentSpec extends AcpAgentConfigEntry {
  /** Adapter slug, e.g. "gemini-cli". Lower-kebab, ≥3 chars (AIP-45 id). */
  slug: string
}

/** Where generic handles point their AIP-45 `acp` + `sandbox` refs — the
 *  shared, agent-neutral ACP contract shipped alongside this module.
 *  A doc ref only: the driver never reads the file, so a package-relative
 *  string (as native adapters use) is the right form. */
const GENERIC_ACP_REF = "./GENERIC.ACP.md"

/** Distinguishes where a resolved generic handle came from. */
export type AcpSpecSource = "acp-config" | "acp-catalog"

/**
 * Mint a runnable `AgentCliHandle` from a plain spec by routing every
 * field through `defineAgentCli` with `protocol: "acp"`. The result is a
 * fully-validated AIP-45 handle — schema-identical to a hand-authored
 * native ACP adapter, just without the npm package.
 *
 * The AIP-45 schema requires `install` / `version_check` / `sandbox`
 * even though a generic agent is bring-your-own-binary: we synthesize
 * truthful, minimal values (a `vendored` install pointing at the bin so
 * `agentproto install` correctly treats it as pre-provided, a
 * conventional `<bin> --version` check, and the shared GENERIC.ACP.md as
 * both the `acp` wire ref and the `sandbox` ref). This keeps the existing
 * schema unchanged — no fighting it.
 */
export function acpHandleFromSpec(spec: AcpAgentSpec): AgentCliHandle {
  const resumable = spec.resumable === true
  const description =
    spec.description ??
    `Generic ACP agent '${spec.slug}' — spawns \`${[spec.bin, ...(spec.bin_args ?? [])].join(" ")}\` and drives it over the Agent Client Protocol.`

  return defineAgentCli({
    name: spec.name ?? spec.slug,
    id: spec.slug,
    description,
    version: "0.1.0",
    bin: spec.bin,
    ...(spec.bin_args && spec.bin_args.length > 0
      ? { bin_args: [...spec.bin_args] }
      : {}),
    ...(spec.env && Object.keys(spec.env).length > 0
      ? { env: { ...spec.env } }
      : {}),
    // BYO binary: `vendored` tells `agentproto install` the bin is
    // user-provided (it skips vendored steps), and `install_hint` carries
    // the human "how to get it" line surfaced by `agentproto acp ls`.
    install: [{ method: "vendored", path: spec.bin }],
    version_check: {
      cmd: `${spec.bin} --version`,
      parse: "(\\d+\\.\\d+\\.\\d+)",
      range: ">=0.0.0",
      timeout_ms: 5000,
    },
    sandbox: GENERIC_ACP_REF,
    protocol: "acp",
    acp: GENERIC_ACP_REF,
    session: {
      mode: resumable ? "resumable" : "persistent",
      context_carryover: true,
    },
    ...(spec.models
      ? {
          models: {
            ...(spec.models.default ? { default: spec.models.default } : {}),
            ...(spec.models.allowed && spec.models.allowed.length > 0
              ? { allowed: [...spec.models.allowed] }
              : {}),
          },
        }
      : {}),
    capabilities: {
      streaming: true,
      tool_calls: true,
      file_io: true,
      resumable,
    },
    ...(resumable
      ? {
          continuation: {
            default: "native-resume" as const,
            supported: ["native-resume", "pinned-session", "none"] as const,
          },
        }
      : {}),
    tags: ["acp", "generic", spec.slug],
    metadata: {
      // Provenance + fields with no first-class manifest home, kept so the
      // handle round-trips the spec faithfully. `cwd_flag` is recorded here
      // because ACP passes the working directory over the wire (session/new
      // `cwd`) — the flag is a hint for CLIs that additionally want it on
      // argv, not something the generic arm needs to spawn correctly.
      acpGeneric: {
        ...(spec.cwd_flag ? { cwd_flag: spec.cwd_flag } : {}),
        ...(spec.install_hint ? { install_hint: spec.install_hint } : {}),
      },
    },
  })
}

/**
 * Curated catalog of known, publicly-documented ACP-speaking CLIs that do
 * NOT ship a native `@agentproto/adapter-*` package. Conservative on
 * purpose: every entry's ACP invocation is drawn from the agent's own
 * public docs — no invented flags. Agents that already have a native
 * adapter in `CATALOG` (claude-code, opencode, codex, hermes, …) are
 * excluded; a native adapter always wins in `resolveAdapter` anyway.
 *
 * The `--experimental-acp` flag family below is the well-documented ACP
 * entry point popularised by Gemini CLI and reused verbatim by its
 * public forks.
 */
export const ACP_CATALOG: readonly AcpAgentSpec[] = [
  {
    slug: "gemini-cli",
    name: "Gemini CLI",
    description:
      "Google's Gemini CLI in ACP mode (`gemini --experimental-acp`). Open-source terminal agent; drives Gemini models over the Agent Client Protocol.",
    bin: "gemini",
    bin_args: ["--experimental-acp"],
    provider: "google",
    install_hint: "npm install -g @google/gemini-cli",
  },
  {
    slug: "qwen-code",
    name: "Qwen Code",
    description:
      "Alibaba's Qwen Code CLI (a Gemini-CLI fork) in ACP mode (`qwen --experimental-acp`). Drives Qwen models over the Agent Client Protocol.",
    bin: "qwen",
    bin_args: ["--experimental-acp"],
    install_hint: "npm install -g @qwen-code/qwen-code",
  },
  {
    slug: "iflow-cli",
    name: "iFlow CLI",
    description:
      "iFlow CLI (a Gemini-CLI-derived terminal agent) in ACP mode (`iflow --experimental-acp`), driven over the Agent Client Protocol.",
    bin: "iflow",
    bin_args: ["--experimental-acp"],
    install_hint: "npm install -g @iflow-ai/iflow-cli",
  },
  {
    slug: "mistral-vibe",
    name: "Mistral Vibe",
    description:
      "Mistral AI's Vibe coding CLI, driven over the Agent Client Protocol via its bundled `vibe-acp` binary. Auth via MISTRAL_API_KEY (`vibe --setup`).",
    bin: "vibe-acp",
    provider: "mistral",
    install_hint: "uv tool install mistral-vibe",
  },
  {
    slug: "kimi-cli",
    name: "Kimi CLI",
    description:
      "Moonshot AI's Kimi CLI in ACP server mode (`kimi acp`), driven over the Agent Client Protocol. Requires `kimi login` once beforehand.",
    bin: "kimi",
    bin_args: ["acp"],
    provider: "moonshot",
    models: {
      default: "kimi-k3",
      allowed: [
        "kimi-k3",
        "kimi-k2.7-code",
        "kimi-k2.6",
        "kimi-k2.5",
        "kimi-k2-thinking",
        "kimi-k2-thinking-turbo",
        "kimi-k2-turbo-preview",
        "kimi-k2-0905-preview",
      ],
    },
    install_hint: "uv tool install --python 3.13 kimi-cli",
  },
] as const

/**
 * Resolve a slug to a generic ACP spec: user config first (shadowing),
 * then the curated catalog. Returns the matched spec + its source, or
 * `null` when neither has the slug. Pass `config` to avoid a disk read
 * (e.g. when the caller already loaded it); otherwise it's read lazily.
 */
export async function resolveAcpSpec(
  slug: string,
  config?: AgentprotoConfig,
): Promise<{ spec: AcpAgentSpec; source: AcpSpecSource } | null> {
  const cfg = config ?? (await loadConfig())
  const userEntry = cfg.acpAgents?.[slug]
  if (userEntry) {
    return { spec: { ...userEntry, slug }, source: "acp-config" }
  }
  const catalogEntry = ACP_CATALOG.find((e) => e.slug === slug)
  if (catalogEntry) {
    return { spec: catalogEntry, source: "acp-catalog" }
  }
  return null
}

/**
 * Well-known install directories for the package managers `install-hint.ts`
 * recognizes (uv/pipx/pip --user, cargo, go, brew) — checked as a FALLBACK
 * when a bare bin isn't found on `process.env.PATH`. Exists because the
 * daemon is a long-running process: it inherits PATH once at boot, and a
 * `uv tool install`/`cargo install`/… run afterward (e.g. via the
 * `adapter_install` route) drops its binary into one of these directories,
 * which is commonly NOT yet on PATH on a machine's first install of that
 * tool (the tool itself prints a "restart your shell" hint) — so a
 * genuinely-installed adapter kept reporting "supported" (not installed)
 * until the daemon itself was restarted. Checking these literal paths is
 * PATH-independent, so a fresh install is visible on the very next listing
 * without requiring a daemon restart.
 */
export function fallbackBinDirs(): readonly string[] {
  const home = homedir()
  return [
    join(home, ".local", "bin"), // uv tool install, pipx, pip install --user
    join(home, ".cargo", "bin"), // cargo install
    join(home, "go", "bin"), // go install (GOPATH unset)
    "/opt/homebrew/bin", // brew, Apple Silicon
    "/usr/local/bin", // brew, Intel mac / generic unix
  ]
}

/**
 * Is `bin` runnable — a path that exists+executable, a bare name found on
 * PATH, or one found in a well-known package-manager install dir PATH
 * hasn't picked up yet (see {@link fallbackBinDirs})? Used to classify
 * generic ACP agents in the listing: `ready` when present, `supported`
 * (install_hint) when not.
 */
export async function binOnPath(bin: string): Promise<boolean> {
  // A path with a separator is checked directly, not walked on PATH.
  if (bin.includes("/") || bin.includes("\\")) {
    return canExecute(bin)
  }
  const pathVar = process.env.PATH ?? ""
  const dirs = [...pathVar.split(delimiter).filter(Boolean), ...fallbackBinDirs()]
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""]
  for (const dir of dirs) {
    for (const ext of exts) {
      if (await canExecute(join(dir, bin + ext))) return true
    }
  }
  return false
}

async function canExecute(path: string): Promise<boolean> {
  try {
    await fs.access(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** A generic ACP entry as surfaced in the adapter listing — the same
 *  UI-safe shape as `listAdaptersWithCatalog` entries, plus provenance. */
export type AcpGenericListEntry = AdapterInfo & {
  status: "supported" | "ready"
  hint?: string
  source: AcpSpecSource
}

/**
 * List the generic ACP agents (curated catalog + user config, config
 * shadowing catalog) with a runtime `status` derived from bin presence:
 * `ready` when the bin is on PATH, `supported` (not installed, shows
 * `install_hint`) otherwise. Config-defined agents are always listed.
 *
 * `ready`, not `available`: in the merged listing's vocabulary
 * (`listAdaptersWithCatalog`), "available" means installed-but-setup/auth-
 * pending — a state a generic spec can never leave, since it declares no
 * setup ledger or auth descriptor for anyone to complete. Reporting it
 * kept UIs offering "Install" forever on an installed CLI (the install
 * re-ran the hint as a no-op) while never offering "Start". A CLI whose
 * own auth is missing (`kimi login`, MISTRAL_API_KEY) now fails at spawn
 * with its real error instead — actionable, where the Install loop was not.
 *
 * `excludeSlugs` drops entries already covered by an npm adapter /
 * native catalog entry, so a generic spec never double-appears next to a
 * real adapter of the same slug in the merged `adapter_list`.
 */
export async function listAcpGenericAdapters(opts?: {
  config?: AgentprotoConfig
  excludeSlugs?: ReadonlySet<string>
}): Promise<AcpGenericListEntry[]> {
  const cfg = opts?.config ?? (await loadConfig())
  const exclude = opts?.excludeSlugs ?? new Set<string>()

  // Merge config (shadowing) over catalog, keyed by slug.
  const bySlug = new Map<string, { spec: AcpAgentSpec; source: AcpSpecSource }>()
  for (const entry of ACP_CATALOG) {
    bySlug.set(entry.slug, { spec: entry, source: "acp-catalog" })
  }
  for (const [slug, entry] of Object.entries(cfg.acpAgents ?? {})) {
    bySlug.set(slug, { spec: { ...entry, slug }, source: "acp-config" })
  }

  const out: AcpGenericListEntry[] = []
  for (const { spec, source } of bySlug.values()) {
    if (exclude.has(spec.slug)) continue
    const present = await binOnPath(spec.bin)
    const handle = acpHandleFromSpec(spec)
    out.push({
      slug: spec.slug,
      name: handle.name,
      version: handle.version,
      description: handle.description,
      protocol: "acp",
      streaming: true,
      packageName: `acp:${spec.bin}`,
      commands: [],
      models: spec.models?.allowed ?? [],
      modes: [],
      // Generic ACP entries declare bare id strings
      // (AcpAgentConfigEntry.models.allowed) with no per-model binding
      // surface; the spec-level `provider` (the endpoint the CLI's own
      // auth bills) is stamped onto each so clients can link the harness
      // to that provider's wallets.
      modelDetails: (spec.models?.allowed ?? []).map((id) => ({
        id,
        ...(spec.provider ? { provider: spec.provider } : {}),
      })),
      ...(spec.provider ? { provider: spec.provider } : {}),
      status: present ? "ready" : "supported",
      source,
      ...(spec.install_hint ? { hint: spec.install_hint } : {}),
    })
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug))
}
