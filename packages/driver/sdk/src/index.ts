/**
 * @agentproto/sdk — AIP-33 SDK provider specialisation.
 *
 * In-process providers: load an npm / pip / cargo package and dispatch
 * contract calls to its named functions. No subprocess, no network hop
 * (beyond what the SDK itself does).
 *
 * Spec: https://agentproto.sh/docs/aip-33
 */

import {
  defineDriver,
  type ExecuteFn,
  type ImplementsEntry,
  type DriverDefinition,
  type DriverHandle,
} from "@agentproto/driver"

export interface SdkDriverDefinition
  extends Omit<DriverDefinition, "kind" | "execute"> {
  kind?: "sdk"
  /** Package name (`openai`, `anthropic`, `@host/sdxl-runner`). */
  package: string
  /** Package manager. Drives the install block default; runtime uses for typing only. */
  packageManager: "npm" | "pnpm" | "yarn" | "pip" | "poetry" | "cargo" | "go" | "local"
  /** Optional pinned version. */
  packageVersion?: string
  /** Module load convention. Default "esm". */
  importStyle?: "esm" | "cjs" | "python" | "rust-crate" | "go-module"
  /** Streaming hint. */
  streaming?: { mode: "async-iterator" | "callback" }

  /**
   * Optional behavioural adapter for module loading. Default: `await import(package)`.
   * Override when the module needs custom resolution (vendored paths, alias).
   */
  loadModule?: (args: { package: string; driverCtx: { secrets: Record<string, string> } }) => Promise<unknown>

  /**
   * Optional behavioural adapter for arg construction when args_template
   * isn't enough (positional args, conditional fields).
   */
  buildArgs?: (args: BuildArgsArgs) => unknown[] | Promise<unknown[]>
}

export interface BuildArgsArgs {
  toolId: string
  input: Record<string, unknown>
  context: Record<string, unknown>
  driverCtx: { secrets: Record<string, string>; module: unknown }
  signal: AbortSignal
}

/**
 * Define an SDK provider — sugar over defineDriver with kind: sdk
 * and an auto-synthesised execute map keyed by tool id when explicit
 * `execute` isn't provided.
 */
export function defineSdkDriver(definition: SdkDriverDefinition): DriverHandle {
  // Module is loaded lazily on first call (memoised) so module-load I/O
  // stays out of `defineSdkDriver`.
  let modulePromise: Promise<unknown> | undefined
  const loadModule = async (driverCtx: { secrets: Record<string, string> }) => {
    if (!modulePromise) {
      modulePromise = definition.loadModule
        ? definition.loadModule({ package: definition.package, driverCtx })
        : import(definition.package).then(m => (m as { default?: unknown }).default ?? m)
    }
    return modulePromise
  }

  const execute: Record<string, ExecuteFn> = {}
  for (const entry of definition.implements) {
    const toolId = normalizeToolId(entry.tool)
    execute[toolId] = createExecuteFn({
      toolId,
      entry,
      loadModule,
      buildArgs: definition.buildArgs,
    })
  }

  return defineDriver({
    ...definition,
    kind: "sdk",
    execute,
    metadata: {
      ...(definition.metadata ?? {}),
      sdk: {
        package: definition.package,
        packageManager: definition.packageManager,
        packageVersion: definition.packageVersion,
        importStyle: definition.importStyle ?? "esm",
        streaming: definition.streaming,
      },
    },
  })
}

function createExecuteFn(args: {
  toolId: string
  entry: ImplementsEntry
  loadModule: (driverCtx: { secrets: Record<string, string> }) => Promise<unknown>
  buildArgs?: SdkDriverDefinition["buildArgs"]
}): ExecuteFn {
  const meta = (args.entry.metadata ?? {}) as { sdk?: PerToolSdk }
  const sdkMeta = meta.sdk ?? {}

  return async ({ input, context, driverCtx, signal }) => {
    const inputObj = (input ?? {}) as Record<string, unknown>
    const ctxObj = context as Record<string, unknown>
    const provCtx = driverCtx as { secrets: Record<string, string>; [k: string]: unknown }

    const mod = await args.loadModule({ secrets: provCtx.secrets ?? {} })
    const fn = resolveFunctionRef(mod, sdkMeta.functionRef ?? "default")
    if (typeof fn !== "function") {
      throw new SdkDriverError(
        "function_ref_unresolvable",
        `function_ref '${sdkMeta.functionRef ?? "default"}' did not resolve to a function`
      )
    }

    let callArgs: unknown[]
    if (args.buildArgs) {
      callArgs = await args.buildArgs({
        toolId: args.toolId,
        input: inputObj,
        context: ctxObj,
        driverCtx: { secrets: provCtx.secrets ?? {}, module: mod },
        signal,
      })
    } else if (sdkMeta.argsTemplate) {
      callArgs = templateToArgs(sdkMeta.argsTemplate, {
        input: inputObj,
        secrets: provCtx.secrets ?? {},
        context: ctxObj,
      })
    } else {
      // Default: pass input as the function's first argument.
      callArgs = [inputObj]
    }

    const result = await Promise.resolve((fn as (...a: unknown[]) => unknown)(...callArgs))
    const path = sdkMeta.resultExtract ?? "$"
    return path === "$" ? result : extractPath(result, path)
  }
}

interface PerToolSdk {
  functionRef?: string
  argsTemplate?: Record<string, unknown> | unknown[]
  resultExtract?: string
  streaming?: { mode: "async-iterator" | "callback" }
}

class SdkDriverError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "SdkDriverError"
    this.code = code
  }
}

/**
 * Resolve a dot-notation function ref against a loaded module.
 * Examples:
 *  - "default"        → mod (assumed callable when default export is the function)
 *  - "createImage"    → mod.createImage
 *  - "images.create"  → mod.images.create
 *  - "Client.images.create" → new mod.Client(...).images.create
 *
 * The class-instantiation pattern (capitalised first segment) is
 * implemented via a marker — callers receive a wrapper that
 * instantiates on each call. v1: simple property walk; class
 * instantiation deferred to caller's buildArgs / a future runtime
 * extension.
 */
export function resolveFunctionRef(mod: unknown, ref: string): unknown {
  if (ref === "default") {
    // Prefer explicit `default` export when present (ESM convention);
    // otherwise the module itself IS the callable (CJS / pre-ESM).
    if (mod && typeof mod === "object" && "default" in mod) {
      const fn = (mod as { default: unknown }).default
      if (fn !== undefined) return fn
    }
    return mod
  }
  return ref.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key]
    if (typeof acc === "function") return (acc as unknown as Record<string, unknown>)[key]
    return undefined
  }, mod)
}

function templateToArgs(
  template: Record<string, unknown> | unknown[],
  vars: { input: Record<string, unknown>; secrets: Record<string, string>; context: Record<string, unknown> }
): unknown[] {
  // Positional args via _0/_1/... keys.
  if (!Array.isArray(template) && Object.keys(template).every(k => /^_\d+$/.test(k))) {
    const indices = Object.keys(template)
      .map(k => Number.parseInt(k.slice(1), 10))
      .sort((a, b) => a - b)
    return indices.map(i => expandTemplate((template as Record<string, unknown>)[`_${i}`], vars))
  }
  // Object-arg: template is the single argument.
  return [expandTemplate(template, vars)]
}

function expandTemplate(
  value: unknown,
  vars: { input: Record<string, unknown>; secrets: Record<string, string>; context: Record<string, unknown> }
): unknown {
  if (typeof value === "string") return substituteString(value, vars)
  if (Array.isArray(value)) return value.map(v => expandTemplate(v, vars))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandTemplate(v, vars)
    }
    return out
  }
  return value
}

const TEMPLATE_RE = /\$\{(input|secrets|context)\.([\w.]+)(?:\s*\|\s*default\(([^)]*)\))?\}/g

function substituteString(
  template: string,
  vars: { input: Record<string, unknown>; secrets: Record<string, string>; context: Record<string, unknown> }
): unknown {
  const single = template.match(/^\$\{(input|secrets|context)\.([\w.]+)\}$/)
  if (single) {
    const [, scope, path] = single
    return resolvePath(vars[scope as "input" | "secrets" | "context"], path!)
  }
  return template.replace(TEMPLATE_RE, (_match, scope: string, path: string, fallbackRaw?: string) => {
    const resolved = resolvePath(vars[scope as "input" | "secrets" | "context"], path)
    if (resolved === undefined || resolved === null) {
      if (fallbackRaw !== undefined) {
        const trimmed = fallbackRaw.trim()
        return trimmed.startsWith("'") || trimmed.startsWith('"') ? trimmed.slice(1, -1) : trimmed
      }
      return ""
    }
    return typeof resolved === "string" ? resolved : JSON.stringify(resolved)
  })
}

function resolvePath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key]
    return undefined
  }, obj)
}

function extractPath(value: unknown, path: string): unknown {
  if (path === "$") return value
  let s = path.replace(/^\$/, "")
  const re = /\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g
  let current: unknown = value
  let match: RegExpExecArray | null
  while ((match = re.exec(s)) !== null) {
    if (current == null) return undefined
    if (match[1]) current = (current as Record<string, unknown>)[match[1]]
    else if (match[2]) current = (current as unknown[])[Number.parseInt(match[2], 10)]
  }
  return current
}

function normalizeToolId(ref: string): string {
  let s = ref.trim()
  if (s.startsWith("./")) s = s.slice(2)
  if (s.endsWith("/TOOL.md")) s = s.slice(0, -"/TOOL.md".length)
  if (s.startsWith("tools/")) s = s.slice("tools/".length)
  const lastSlash = s.lastIndexOf("/")
  return lastSlash === -1 ? s : s.slice(lastSlash + 1)
}

export { SdkDriverError }
