/**
 * Loader for an app's bundled AIP-14 TOOL.md contracts and AIP-30 DRIVER.md
 * implementations — the deterministic-step half of WORKFLOW.md `tool` steps
 * (yt-dlp, an STT HTTP call, a PDF render, …), as opposed to `agent` steps.
 *
 * Neither AIP-53 (app, still Draft with no scaffolded spec) nor AIP-14/30
 * declare a bundle location for these, so this is a convention this loader
 * defines: `<dir>/.agentproto/tools/<id>/TOOL.md` and
 * `<dir>/.agentproto/drivers/<id>/DRIVER.md`, one manifest per `<id>`
 * subdirectory, discovered by listing — not declared as APP.md frontmatter
 * refs like `agents`/`workflows` are. An absent `tools`/`drivers` directory
 * is not an error (most apps have neither); a subdirectory that exists but
 * fails to parse, or is missing its TOOL.md/DRIVER.md, fails the whole load
 * — `loadAppHandle` never silently drops a broken tool/driver bundle.
 *
 * Only `kind: cli` and `kind: http` drivers dispatch (the two
 * `@agentproto/driver-cli` / `@agentproto/driver-http` sugars this package
 * already depends on). Any other `kind` (`mcp`, `sdk`, `builtin`) still
 * loads — a malformed manifest still fails the app load — but its execute
 * body refuses clearly instead of silently no-oping or crashing on a
 * dispatch mechanism this host doesn't implement yet.
 *
 * A `kind: cli` driver's subprocess `cwd` defaults to the app root (`dir`,
 * the directory containing `.agentproto/`) rather than the host process's
 * own cwd — relative paths in an app-bundled cli driver (DRIVER.md argv,
 * `--out-dir`-style flags, …) resolve against the app root. A DRIVER.md can
 * override this with `metadata.cli.cwd`; a relative value there is itself
 * resolved against the app root, and a value that escapes the app root
 * (`../..`) is a load error, not a silent escape.
 */

import { readdir, readFile } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import {
  parseToolManifest,
  toolFromManifestOnly,
  type ToolHandle,
} from "@agentproto/tool"
import {
  driverFromManifest,
  driverDefinitionFromManifest,
  parseDriverManifest,
  type DriverManifest,
} from "@agentproto/driver/manifest"
import { normalizeToolId, type DriverHandle, type ExecuteFn } from "@agentproto/driver"
import { defineCliDriver, type CliDriverDefinition } from "@agentproto/driver-cli"
import { defineHttpDriver, type HttpDriverDefinition } from "@agentproto/driver-http"
import { AppLoadError } from "./errors.js"

/** List `<id>` subdirectory names under `base`, sorted. Missing `base` (the
 *  common case — most apps ship neither tools nor drivers) is not an error. */
async function listBundleIds(base: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function loadToolEntry(id: string, toolPath: string): Promise<ToolHandle> {
  let source: string
  try {
    source = await readFile(toolPath, "utf8")
  } catch (err) {
    throw new AppLoadError(`tool '${id}': cannot read '${toolPath}': ${errMsg(err)}`)
  }
  try {
    return toolFromManifestOnly(parseToolManifest(source))
  } catch (err) {
    throw new AppLoadError(`tool '${id}' at '${toolPath}': ${errMsg(err)}`)
  }
}

/** Env var names DRIVER.md declares as required secrets — `auth.state.env`,
 *  the existing AIP-30 field for "env var names this provider's auth needs".
 *  Loosely typed at the manifest layer (`auth: z.unknown()`), so this reads
 *  defensively rather than trusting a shape. */
function requiredSecretNames(fm: DriverManifest["frontmatter"]): readonly string[] {
  const auth = fm.auth as { state?: { env?: unknown } } | undefined
  const env = auth?.state?.env
  return Array.isArray(env) ? env.filter((e): e is string => typeof e === "string") : []
}

/**
 * Wrap every execute body so a declared-but-unresolved secret fails the
 * STEP with a clear `driver-error` naming the secret — never at app
 * install (secrets are resolved lazily, only when the tool actually
 * dispatches). Resolved values are merged into `driverCtx.secrets` ahead of
 * whatever the caller already put there (a workflow tool step's compiled
 * `secrets` is empty today — see BRIEF-D — so this is the only source for
 * an app-bundled driver), letting `${secrets.X}` templating in
 * `defineCliDriver`/`defineHttpDriver` resolve as authors expect.
 */
function wrapExecuteWithSecretCheck(
  driverId: string,
  execute: Record<string, ExecuteFn>,
  secretNames: readonly string[],
): Record<string, ExecuteFn> {
  if (secretNames.length === 0) return execute
  const wrapped: Record<string, ExecuteFn> = {}
  for (const [toolId, fn] of Object.entries(execute)) {
    wrapped[toolId] = async (args) => {
      const resolved: Record<string, string> = {}
      for (const name of secretNames) {
        const value = process.env[name]
        if (!value) {
          throw new Error(
            `driver '${driverId}': missing required secret '${name}' (declared in DRIVER.md 'auth.state.env').`,
          )
        }
        resolved[name] = value
      }
      const priorSecrets = (args.driverCtx as { secrets?: Record<string, string> }).secrets ?? {}
      return fn({ ...args, driverCtx: { ...args.driverCtx, secrets: { ...resolved, ...priorSecrets } } })
    }
  }
  return wrapped
}

/**
 * Resolve a kind:cli DRIVER.md's working directory. Relative paths in an
 * app-bundled cli driver resolve against the app root (the dir containing
 * `.agentproto/`) — not the daemon's own cwd, which is what `runSubprocess`
 * fell back to before this existed and is almost never what a DRIVER.md
 * author means (see `@agentproto/driver-cli`'s README). Defaults to the app
 * root itself when `metadata.cli.cwd` is unset; an explicit value — relative
 * or absolute — that resolves outside the app root is a load error rather
 * than silently escaping the bundle.
 */
function resolveCliCwd(appRoot: string, driverId: string, cwd: unknown): string {
  const absoluteAppRoot = resolve(appRoot)
  if (cwd === undefined) return absoluteAppRoot
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new Error(`driver '${driverId}': 'metadata.cli.cwd' must be a non-empty string.`)
  }
  const resolved = isAbsolute(cwd) ? resolve(cwd) : resolve(absoluteAppRoot, cwd)
  const rel = relative(absoluteAppRoot, resolved)
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new Error(
      `driver '${driverId}': 'metadata.cli.cwd' (${cwd}) resolves to '${resolved}', outside the app root '${absoluteAppRoot}'.`,
    )
  }
  return resolved
}

/** Build a working {@link DriverHandle} from a parsed DRIVER.md, dispatching
 *  on `kind`. Throws a plain `Error` (wrapped in `AppLoadError` by the
 *  caller, which has the file path) on a `cli`/`http` manifest missing its
 *  dispatch config. */
function driverHandleFromManifest(manifest: DriverManifest, appRoot: string): DriverHandle {
  const fm = manifest.frontmatter
  const secretNames = requiredSecretNames(fm)

  if (fm.kind === "cli") {
    const cliMeta = (fm.metadata?.cli ?? {}) as Partial<CliDriverDefinition> & { cwd?: unknown }
    if (typeof cliMeta.bin !== "string" || cliMeta.bin.trim() === "") {
      throw new Error(
        "kind:cli DRIVER.md requires a non-empty 'metadata.cli.bin' frontmatter field naming the binary.",
      )
    }
    const handle = defineCliDriver({
      ...driverDefinitionFromManifest(manifest),
      bin: cliMeta.bin,
      binArgs: cliMeta.binArgs,
      output: cliMeta.output,
      tty: cliMeta.tty,
      sandbox: cliMeta.sandbox,
      cwd: resolveCliCwd(appRoot, fm.id, cliMeta.cwd),
    })
    return { ...handle, execute: wrapExecuteWithSecretCheck(fm.id, handle.execute, secretNames) }
  }

  if (fm.kind === "http") {
    const httpMeta = (fm.metadata?.http ?? {}) as Partial<HttpDriverDefinition>
    if (typeof httpMeta.baseUrl !== "string" || httpMeta.baseUrl.trim() === "") {
      throw new Error("kind:http DRIVER.md requires a non-empty 'metadata.http.baseUrl' frontmatter field.")
    }
    const handle = defineHttpDriver({
      ...driverDefinitionFromManifest(manifest),
      baseUrl: httpMeta.baseUrl,
      defaultHeaders: httpMeta.defaultHeaders,
      defaultMethod: httpMeta.defaultMethod,
      streaming: httpMeta.streaming,
    })
    return { ...handle, execute: wrapExecuteWithSecretCheck(fm.id, handle.execute, secretNames) }
  }

  // mcp / sdk / builtin: load (so a malformed manifest still fails the app
  // load), but refuse at resolve/dispatch — every implements[] entry gets
  // an execute body that fails with a clear message instead of silently
  // no-oping or throwing an opaque "no dispatch mechanism" error.
  const execute: Record<string, ExecuteFn> = {}
  for (const entry of fm.implements) {
    const toolId = normalizeToolId(entry.tool)
    execute[toolId] = async () => {
      throw new Error(
        `driver '${fm.id}': kind '${fm.kind}' is not supported by this host — only 'cli' and 'http' drivers dispatch.`,
      )
    }
  }
  return driverFromManifest({ manifest, execute })
}

async function loadDriverEntry(id: string, driverPath: string, appRoot: string): Promise<DriverHandle> {
  let source: string
  try {
    source = await readFile(driverPath, "utf8")
  } catch (err) {
    throw new AppLoadError(`driver '${id}': cannot read '${driverPath}': ${errMsg(err)}`)
  }
  try {
    return driverHandleFromManifest(parseDriverManifest(source), appRoot)
  } catch (err) {
    throw new AppLoadError(`driver '${id}' at '${driverPath}': ${errMsg(err)}`)
  }
}

/**
 * Scan `<dir>/.agentproto/tools/*` and `<dir>/.agentproto/drivers/*` for
 * TOOL.md / DRIVER.md bundles and load them into live handles. Used by
 * `loadAppHandle` (install-time validation, via `defineApp`) and reusable
 * directly by a host that needs an already-installed app's tools/drivers
 * without re-walking its agents/workflows (see `@agentproto/runtime`'s
 * workflow `compileWorkflow` seam).
 */
export async function loadAppBundledTools(
  dir: string,
): Promise<{ tools: ToolHandle[]; drivers: DriverHandle[] }> {
  const toolsDir = join(dir, ".agentproto", "tools")
  const driversDir = join(dir, ".agentproto", "drivers")

  const tools: ToolHandle[] = []
  for (const id of await listBundleIds(toolsDir)) {
    tools.push(await loadToolEntry(id, join(toolsDir, id, "TOOL.md")))
  }

  const drivers: DriverHandle[] = []
  for (const id of await listBundleIds(driversDir)) {
    drivers.push(await loadDriverEntry(id, join(driversDir, id, "DRIVER.md"), dir))
  }

  return { tools, drivers }
}
