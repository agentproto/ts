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
 * always resolve to `null` (status "supported") until one ships. Their
 * repeated import misses (and every other third-party import here) go
 * through the shared bounded probe in `../provider-probes.ts`, which proves
 * them missing synchronously instead of loading them on every MCP request.
 */

import type { SetupField } from "@agentproto/provider-kit"
import type { SandboxProvider } from "@agentproto/sandbox"

import {
  sharedProviderProbe,
  type ProviderProbe,
} from "../provider-probes.js"
import { createAutoSandboxProviderHandle, type AutoConcreteProvider } from "./auto.js"
import { localSandboxProvider } from "./local.js"
import type { SandboxProviderCapabilities, SandboxProviderHandle } from "./types.js"

/** Per-slug credentials, as stored by the creds store / setup tool. */
export type SandboxCreds = Record<string, string>

/** Factory for a built-in sandbox provider handle. */
export type SandboxProviderFactory = (
  creds?: SandboxCreds | null,
) => SandboxProviderHandle

const LOCAL_SLUG = "local"

/** Composite slug handled BEFORE the catalog: it composes the existing
 *  `computer` and `e2b` handles rather than importing a package of its own. */
export const AUTO_SANDBOX_SLUG = "auto"

/** Capabilities every provider exposes today — identical across the built-in
 *  local passthrough and the third-party (e2b) wrapper until they diverge. */
const CAPABILITIES_TODAY: SandboxProviderCapabilities = {
  networkEgress: true,
  mounts: false,
  lifecyclePause: false,
  readOnly: false,
  exec: false,
  sharedSessions: false,
}

/** e2b and Box can both pause/reconnect (e2b: `Sandbox.pause()` +
 *  `Sandbox.connect()`; Box: `box stop` snapshots, `box resume` restores) —
 *  the `local` passthrough tears down its temp workspace on `stop()`, and
 *  `modal`/`daytona` are unpublished catalog placeholders. */
const E2B_CAPABILITIES: SandboxProviderCapabilities = {
  ...CAPABILITIES_TODAY,
  lifecyclePause: true,
  // `BootedSandbox.exec` shells through `sandbox.commands.run` — the seam
  // the `sandbox_exec` MCP tool uses. Box's provider hasn't implemented it.
  exec: true,
}

/** Box's `box stop` snapshots the box for later `box resume`/`box fork` —
 *  InstaBox supports exec (`POST /machines/{id}/exec`) but NOT manual pause
 *  (a manually suspended machine never wakes on its own), so its provider
 *  deliberately omits `pause()` and the lifecycle stays kill-only. */
const BOX_CAPABILITIES: SandboxProviderCapabilities = {
  ...CAPABILITIES_TODAY,
  lifecyclePause: true,
}

const INSTABOX_CAPABILITIES: SandboxProviderCapabilities = {
  ...CAPABILITIES_TODAY,
  // `BootedSandbox.exec` shells through the exec API — the seam the
  // `sandbox_exec` MCP tool uses.
  exec: true,
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
    capabilities: CAPABILITIES_TODAY,
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
  /** Env var the provider's SDK reads its control-plane API key from
   *  (e.g. `BOX_API_KEY`, `E2B_API_KEY`). When the stored `apiKey` cred is
   *  present and this var is unset in the process env, the resolver fills it
   *  so `setup_sandbox_provider` actually authenticates `boot()` — see
   *  `importThirdPartyProvider`. */
  credEnvVar?: string
  /** Additional setup fields (name → env var) a provider's package reads
   *  from the stored creds alongside `credEnvVar`'s implicit `apiKey` —
   *  filled when the process env is unset (same override rule). */
  credentialEnvVars?: ReadonlyArray<{ name: string; envVar: string }>
  /** Forwarded onto the resolved handle as `SandboxProviderHandle.defaultCwd`
   *  — see that field's doc. Both e2b and Box boot their workstation image
   *  logged in as `user` with home `/home/user` (`DEFAULT_WORKSPACE` in each
   *  package's own provider.ts). */
  defaultCwd?: string
}

/** Login home both e2b and Box's workstation images boot into — mirrors
 *  each provider package's own `DEFAULT_WORKSPACE` constant (used for their
 *  `--workspace` boot flag). Kept as a registry-local literal rather than an
 *  import so this package never depends on the third-party provider
 *  packages beyond the existing dynamic `import()`. */
const REMOTE_WORKSTATION_HOME = "/home/user"

const COMPUTER_CONTROLLER_URL_ENV = "COMPUTER_CONTROLLER_URL"
/** The self-hosted microVM "computer" provider: pause/resume via the
 *  controller's suspend/restore (which MAY rebuild the box under a new id —
 *  the package's `connect()` handles that), exec/file-seam implemented in
 *  the package, and several agentproto sessions sharing one computer. */
const COMPUTER_CAPABILITIES: SandboxProviderCapabilities = {
  ...CAPABILITIES_TODAY,
  lifecyclePause: true,
  exec: true,
  sharedSessions: true,
}

const THIRD_PARTY_SANDBOX_PROVIDERS: Record<string, ThirdPartySandboxDescriptor> = {
  computer: {
    packageName: "@agentproto/sandbox-computer",
    exportName: "computerSandboxProvider",
    name: "Computer",
    description:
      "Runs the agentproto daemon on a self-hosted microVM computer via its controller API (suspend/resume shared sessions).",
    capabilities: COMPUTER_CAPABILITIES,
    // The token is the controller's bearer service token; the controller
    // base URL is plain configuration (read by the package from
    // `COMPUTER_CONTROLLER_URL` or manifest config).
    credEnvVar: "COMPUTER_CONTROLLER_TOKEN",
    defaultCwd: REMOTE_WORKSTATION_HOME,
    setupFields: [
      {
        name: "apiKey",
        description: "Controller service token (stored, injected as COMPUTER_CONTROLLER_TOKEN).",
        required: true,
        sensitive: true,
      },
      {
        name: "controllerUrl",
        description:
          "Controller base URL (e.g. http://host:7110), injected as COMPUTER_CONTROLLER_URL.",
        required: true,
        sensitive: false,
      },
      {
        name: "tenantId",
        description:
          "Controller tenant the computers are created under (default \"agentproto\"), injected as COMPUTER_TENANT_ID.",
        required: false,
        sensitive: false,
      },
      {
        name: "gatewayUrl",
        description:
          "URL template for reaching a computer's daemon from this host (placeholders {port}, {id}, {hostPort}), injected as COMPUTER_GATEWAY_URL. Optional: not needed when daemonRoute is enabled (the two are mutually exclusive), and needed for the daemon to re-attach after a restart, which carries no per-spawn config.",
        required: false,
        sensitive: false,
      },
      {
        name: "daemonRoute",
        description:
          "Set to \"1\" to reach each computer's daemon through the controller (<controllerUrl>/v1/computers/{id}/daemon) instead of a per-port gatewayUrl, injected as COMPUTER_DAEMON_ROUTE. gatewayUrl is not required in this mode and is mutually exclusive with it; supplying both is rejected as a conflicting configuration.",
        required: false,
        sensitive: false,
      },
      {
        name: "accessClientId",
        description:
          "Edge access service-token id sent as CF-Access-Client-Id on controller calls, injected as COMPUTER_ACCESS_CLIENT_ID.",
        required: false,
        sensitive: false,
      },
      {
        name: "accessClientSecret",
        description:
          "Edge access service-token secret sent as CF-Access-Client-Secret on controller calls (stored, injected as COMPUTER_ACCESS_CLIENT_SECRET).",
        required: false,
        sensitive: true,
      },
    ],
    /** Setup-field name → env var the provider package reads it from —
     *  filled in `importThirdPartyProvider` when the process env is unset. */
    credentialEnvVars: [
      { name: "apiKey", envVar: "COMPUTER_CONTROLLER_TOKEN" },
      { name: "controllerUrl", envVar: "COMPUTER_CONTROLLER_URL" },
      { name: "tenantId", envVar: "COMPUTER_TENANT_ID" },
      { name: "gatewayUrl", envVar: "COMPUTER_GATEWAY_URL" },
      { name: "daemonRoute", envVar: "COMPUTER_DAEMON_ROUTE" },
      { name: "accessClientId", envVar: "COMPUTER_ACCESS_CLIENT_ID" },
      { name: "accessClientSecret", envVar: "COMPUTER_ACCESS_CLIENT_SECRET" },
    ],
  },
  e2b: {
    packageName: "@agentproto/sandbox-e2b",
    exportName: "e2bSandboxProvider",
    name: "e2b",
    description:
      /* sync-templates:start */
      "Runs the agentproto daemon inside an e2b Firecracker microVM (agentproto-workstation template, baked @agentproto/cli 1.20.0).",
      /* sync-templates:end */
    capabilities: E2B_CAPABILITIES,
    credEnvVar: "E2B_API_KEY",
    defaultCwd: REMOTE_WORKSTATION_HOME,
    setupFields: [
      {
        name: "apiKey",
        description: "e2b API key (from e2b.dev/dashboard).",
        required: true,
        sensitive: true,
      },
    ],
  },
  box: {
    packageName: "@agentproto/sandbox-box",
    exportName: "boxSandboxProvider",
    name: "Box",
    description:
      "Runs the agentproto daemon on an ascii.dev Box cloud computer, behind an always-on systemd unit.",
    capabilities: BOX_CAPABILITIES,
    credEnvVar: "BOX_API_KEY",
    defaultCwd: REMOTE_WORKSTATION_HOME,
    setupFields: [
      {
        name: "apiKey",
        description: "Box API key (BOX_API_KEY, from ascii.dev).",
        required: true,
        sensitive: true,
      },
    ],
  },
  instabox: {
    packageName: "@agentproto/sandbox-instabox",
    exportName: "instaboxSandboxProvider",
    name: "InstaBox",
    description:
      "Runs the agentproto daemon inside an InstaBox VM, behind an always-on systemd unit on the account's public edge.",
    capabilities: INSTABOX_CAPABILITIES,
    credEnvVar: "INSTABOX_API_KEY",
    // InstaBox's image homes its user under /data (provider DEFAULT_WORKSPACE).
    defaultCwd: "/data/home",
    setupFields: [
      {
        name: "apiKey",
        description: "InstaBox API key (INSTABOX_API_KEY, from instabox.sh).",
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
 *
 * By default the import runs through the shared bounded probe cache
 * (`provider-probes.ts`): `@agentproto/sandbox-modal` / `-daytona` are
 * catalog placeholders with no published package, and every MCP POST used to
 * push both through Node's async loader only to collect
 * `ERR_MODULE_NOT_FOUND`. The sync preflight now answers those without
 * loading, and a resolved module is reused across requests while the handle
 * built here stays per-request (its `check()` closes over THIS call's creds).
 * An injected `importPackage` (test/host seam) bypasses the cache entirely.
 */
async function importThirdPartyProvider(
  descriptor: ThirdPartySandboxDescriptor,
  slug: string,
  creds: SandboxCreds | null,
  opts: {
    importPackage?: (packageName: string) => Promise<Record<string, unknown>>
    probe?: ProviderProbe
  },
): Promise<SandboxProviderHandle | null> {
  let mod: Record<string, unknown> | null
  if (opts.importPackage) {
    try {
      mod = await opts.importPackage(descriptor.packageName)
    } catch {
      mod = null
    }
  } else {
    mod = await (opts.probe ?? sharedProviderProbe).probe(descriptor.packageName)
  }
  if (!mod) return null
  const candidate = mod[descriptor.exportName]
  if (!isSandboxProvider(candidate)) return null

  // Make `setup_sandbox_provider` actually authenticate `boot()`. These
  // providers' SDKs read their control-plane API key straight from
  // `process.env[credEnvVar]` (mirroring how e2b reads `E2B_API_KEY`), but a
  // key configured via `setup_sandbox_provider` lives in the creds store, not
  // the daemon's env — so without this, a "ready"/"available" provider still
  // 401s on the first real boot (observed live with Box: the launchd daemon
  // had no `BOX_API_KEY`). Fill the env from the stored `apiKey` cred, but
  // only when unset, so an explicit process-env key still wins.
  if (descriptor.credEnvVar && creds?.apiKey && !process.env[descriptor.credEnvVar]) {
    process.env[descriptor.credEnvVar] = creds.apiKey
  }
  // Same fill rule for the provider's other setup fields (e.g. a base URL):
  // stored creds win only where the process env is empty, an explicit env
  // var always overrides a stored value.
  for (const { name, envVar } of descriptor.credentialEnvVars ?? []) {
    const value = (creds as Record<string, unknown> | null)?.[name]
    if (typeof value === "string" && value.length > 0 && !process.env[envVar]) {
      process.env[envVar] = value
    }
  }

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
    ...(descriptor.defaultCwd ? { defaultCwd: descriptor.defaultCwd } : {}),
    async check(): Promise<boolean> {
      return creds !== null
    },
  }
}

export interface ResolveSandboxProviderOpts {
  /** Stored creds for the slug (descriptor-only listing passes null). */
  creds?: SandboxCreds | null
  /** Injectable for tests — a one-shot importer that bypasses the shared
   *  probe cache (the registries' original seam; keep for callers that need
   *  a scripted module). Prefer `probe` to exercise the cached path. */
  importPackage?: (packageName: string) => Promise<Record<string, unknown>>
  /** Injectable for tests — defaults to the shared import-probe cache. */
  probe?: ProviderProbe
  /** Resolve a nested provider's OWN stored creds. `auto` composes
   *  `computer`/`e2b`, and each of those has its own creds row — without
   *  this, `auto` could only ever see the daemon env. */
  credsFor?: (slug: string) => Promise<SandboxCreds | null>
}

/**
 * Resolve a slug to a concrete sandbox provider handle. Built-ins first (no
 * import), then the fixed third-party catalog (`e2b`/`box`/`modal`/`daytona`).
 * Returns null when the slug is unknown, or a catalog third-party package
 * isn't installed — the kit's "supported but unavailable" signal.
 */
export async function resolveSandboxProvider(
  slug: string,
  opts?: ResolveSandboxProviderOpts,
): Promise<SandboxProviderHandle | null> {
  if (slug === AUTO_SANDBOX_SLUG) {
    return createAutoSandboxProviderHandle({
      resolveProvider: async (nested: AutoConcreteProvider) => {
        const creds = opts?.credsFor ? await opts.credsFor(nested) : null
        return resolveSandboxProvider(nested, {
          creds,
          ...(opts?.credsFor ? { credsFor: opts.credsFor } : {}),
          ...(opts?.importPackage ? { importPackage: opts.importPackage } : {}),
          ...(opts?.probe ? { probe: opts.probe } : {}),
        })
      },
    })
  }

  const builtin = BUILTIN_SANDBOX_PROVIDERS[slug]
  if (builtin) return builtin(opts?.creds ?? null)

  const descriptor = THIRD_PARTY_SANDBOX_PROVIDERS[slug]
  if (!descriptor) return null
  return importThirdPartyProvider(descriptor, slug, opts?.creds ?? null, {
    ...(opts?.importPackage ? { importPackage: opts.importPackage } : {}),
    ...(opts?.probe ? { probe: opts.probe } : {}),
  })
}
