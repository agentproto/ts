/**
 * Slug-keyed sandbox provider registry — the sandbox family's counterpart to
 * `remote-providers/registry.ts`. `local` resolves in-process; everything
 * else is a dynamic import of `@agentproto/sandbox-<slug>` (e.g.
 * `@agentproto/sandbox-e2b`), wrapped with this registry's own capability/
 * setup metadata because those packages export a bare `@agentproto/sandbox`
 * `SandboxProvider` (just `boot()`) rather than a self-describing
 * adapter-kit handle the way the tunnel family's third-party packages do.
 *
 * `modal` and `daytona` are catalog placeholders — AIP-36 day-1 provider
 * ids with no published `@agentproto/sandbox-<slug>` package yet, so they
 * always resolve to `null` (status "supported") until one ships.
 */

import type { SetupField } from "@agentproto/provider-kit"
import type { SandboxProvider } from "@agentproto/sandbox"

import { localSandboxProvider } from "./local.js"
import type { SandboxProviderCapabilities, SandboxProviderHandle } from "./types.js"

/** Per-slug credentials, as stored by the creds store / setup tool. */
export type SandboxCreds = Record<string, string>

/** Factory for a built-in sandbox provider handle. */
export type SandboxProviderFactory = (
  creds?: SandboxCreds | null,
) => SandboxProviderHandle

const LOCAL_SLUG = "local"

const LOCAL_CAPABILITIES: SandboxProviderCapabilities = {
  networkEgress: true,
  mounts: false,
  lifecyclePause: false,
  readOnly: false,
}

/** Built-in sandbox providers keyed by canonical slug — resolve without any import. */
export const BUILTIN_SANDBOX_PROVIDERS: Record<string, SandboxProviderFactory> = {
  [LOCAL_SLUG]: () => ({
    provider: localSandboxProvider,
    slug: LOCAL_SLUG,
    name: "Local",
    // In-process provider — no npm package version to report.
    version: "builtin",
    description:
      "Boots a real agentproto daemon on 127.0.0.1 in a fresh temp workspace — no cloud credentials needed.",
    requiresSetup: false,
    capabilities: LOCAL_CAPABILITIES,
    async check(): Promise<boolean> {
      return true
    },
  }),
}

/** Everything the registry needs to wrap a bare third-party `SandboxProvider`
 *  into a full adapter-kit handle. */
interface ThirdPartySandboxDescriptor {
  packageName: string
  /** Named export the package exposes its `SandboxProvider` under. */
  exportName: string
  name: string
  description: string
  capabilities: SandboxProviderCapabilities
  setupFields: readonly SetupField[]
}

const CAPABILITIES_TODAY: SandboxProviderCapabilities = {
  networkEgress: true,
  mounts: false,
  lifecyclePause: false,
  readOnly: false,
}

const THIRD_PARTY_SANDBOX_PROVIDERS: Record<string, ThirdPartySandboxDescriptor> = {
  e2b: {
    packageName: "@agentproto/sandbox-e2b",
    exportName: "e2bSandboxProvider",
    name: "e2b",
    description:
      "Runs the agentproto daemon inside an e2b Firecracker microVM (agentproto-workstation template).",
    capabilities: CAPABILITIES_TODAY,
    setupFields: [
      {
        name: "apiKey",
        description: "e2b API key (from e2b.dev/dashboard).",
        required: true,
        sensitive: true,
      },
    ],
  },
  modal: {
    packageName: "@agentproto/sandbox-modal",
    exportName: "modalSandboxProvider",
    name: "Modal",
    description: "Modal sandbox backend — catalog placeholder, no package published yet.",
    capabilities: CAPABILITIES_TODAY,
    setupFields: [],
  },
  daytona: {
    packageName: "@agentproto/sandbox-daytona",
    exportName: "daytonaSandboxProvider",
    name: "Daytona",
    description: "Daytona sandbox backend — catalog placeholder, no package published yet.",
    capabilities: CAPABILITIES_TODAY,
    setupFields: [],
  },
}

/** Duck-type a dynamically-imported value as a bare `@agentproto/sandbox` provider. */
function isSandboxProvider(x: unknown): x is SandboxProvider {
  if (!x || typeof x !== "object") return false
  return typeof (x as Record<string, unknown>).boot === "function"
}

/**
 * Import a third-party sandbox package and wrap its bare `SandboxProvider`
 * (just `boot()`) into a full adapter-kit handle using this registry's own
 * capability/setup metadata. Returns null on any failure (not importable /
 * wrong shape) — same "supported but not installed" signal the tunnel
 * family's resolver produces.
 */
async function importThirdPartyProvider(
  descriptor: ThirdPartySandboxDescriptor,
  slug: string,
  creds: SandboxCreds | null,
  importPackage: (packageName: string) => Promise<Record<string, unknown>>,
): Promise<SandboxProviderHandle | null> {
  let mod: Record<string, unknown>
  try {
    mod = await importPackage(descriptor.packageName)
  } catch {
    return null
  }
  const candidate = mod[descriptor.exportName]
  if (!isSandboxProvider(candidate)) return null

  return {
    provider: candidate,
    slug,
    name: descriptor.name,
    // No self-declared handle to read a real version off of — the wrapped
    // package only exports a bare SandboxProvider. "installed" distinguishes
    // a resolved third-party handle from the catalog's "not installed".
    version: "installed",
    description: descriptor.description,
    requiresSetup: descriptor.setupFields.length > 0,
    capabilities: descriptor.capabilities,
    setupFields: descriptor.setupFields,
    async check(): Promise<boolean> {
      return creds !== null
    },
  }
}

const defaultImportPackage = (
  packageName: string,
): Promise<Record<string, unknown>> => import(packageName)

export interface ResolveSandboxProviderOpts {
  /** Stored creds for the slug (descriptor-only listing passes null). */
  creds?: SandboxCreds | null
  /** Injectable for tests — defaults to a real dynamic `import()`. */
  importPackage?: (packageName: string) => Promise<Record<string, unknown>>
}

/**
 * Resolve a slug to a concrete sandbox provider handle. Built-ins first (no
 * import), then the fixed third-party catalog (`e2b`/`modal`/`daytona`).
 * Returns null when the slug is unknown, or a catalog third-party package
 * isn't installed — the kit's "supported but unavailable" signal.
 */
export async function resolveSandboxProvider(
  slug: string,
  opts?: ResolveSandboxProviderOpts,
): Promise<SandboxProviderHandle | null> {
  const builtin = BUILTIN_SANDBOX_PROVIDERS[slug]
  if (builtin) return builtin(opts?.creds ?? null)

  const descriptor = THIRD_PARTY_SANDBOX_PROVIDERS[slug]
  if (!descriptor) return null
  return importThirdPartyProvider(
    descriptor,
    slug,
    opts?.creds ?? null,
    opts?.importPackage ?? defaultImportPackage,
  )
}
