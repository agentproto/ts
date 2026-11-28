import { readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  type Connector,
  type ConnectorRegistry,
  type SecretsPort,
  type TransportSet,
  Recipe,
  createConnectorRegistry,
  listConnectors,
} from "@agentproto/collect"
import { type ApiAuth, createApiTransport, createHttpTransport } from "@agentproto/collect/node"
import { parse as parseYaml } from "yaml"
import { type Io, UsageError } from "./io"

function looksLikeConnector(v: unknown): v is Connector {
  if (!v || typeof v !== "object") return false
  const c = v as Record<string, unknown>
  return (
    typeof c.id === "string" &&
    typeof c.version === "string" &&
    Array.isArray(c.transports) &&
    typeof c.plan === "function" &&
    typeof c.fetch === "function" &&
    typeof c.parse === "function"
  )
}

export interface LoadedConnectors {
  registry: ConnectorRegistry
  /** Auth scheme of the `api` transport, by connector id, when a module exports `apiAuth`. */
  apiAuth: Map<string, ApiAuth>
}

/**
 * Connectors come from the process-wide registry plus the given module
 * paths. A module exports a connector (default or named), an array of
 * connectors, and optionally `apiAuth` describing how its secret is sent.
 */
export async function loadConnectors(paths: string[], cwd: string): Promise<LoadedConnectors> {
  const found = new Map<string, Connector>()
  const apiAuth = new Map<string, ApiAuth>()
  const add = (c: Connector) => {
    const existing = found.get(c.id)
    if (existing && existing !== c) throw new UsageError(`connector "${c.id}" is defined twice`)
    found.set(c.id, c)
  }
  for (const p of paths) {
    const file = resolve(cwd, p)
    let mod: Record<string, unknown>
    try {
      mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>
    } catch (e) {
      throw new UsageError(`cannot load connector module ${p}: ${e instanceof Error ? e.message : String(e)}`)
    }
    const here: Connector[] = []
    for (const [name, value] of Object.entries(mod)) {
      if (name === "apiAuth") continue
      for (const v of Array.isArray(value) ? value : [value]) if (looksLikeConnector(v)) here.push(v)
    }
    if (here.length === 0) throw new UsageError(`connector module ${p} exports no connector`)
    for (const c of here) {
      add(c)
      if (mod.apiAuth && typeof mod.apiAuth === "object") apiAuth.set(c.id, mod.apiAuth as ApiAuth)
    }
  }
  // After the modules: one that registers itself on import is also in the global registry.
  for (const c of listConnectors()) add(c)
  return { registry: createConnectorRegistry([...found.values()]), apiAuth }
}

export function envSecrets(env: Record<string, string | undefined>): SecretsPort {
  return { get: async (name) => env[name] || undefined }
}

export function secretNameOf(c: Connector): string | undefined {
  return c.access.level === "key" ? c.access.secret : undefined
}

/**
 * The transports the CLI provides: `http`, and `api` when a selected
 * connector needs a key. The browser transport is not available yet.
 * One `api` transport carries one credential, so a single run may use
 * connectors with one secret name only.
 */
export function buildTransports(
  connectors: Connector[],
  loaded: LoadedConnectors,
  env: Record<string, string | undefined>,
  rateMs?: number,
): TransportSet {
  const http = createHttpTransport(rateMs === undefined ? {} : { minIntervalMs: rateMs })
  const keyed = connectors.filter((c) => c.access.level === "key")
  const names = new Set(keyed.map((c) => secretNameOf(c)))
  if (names.size > 1) {
    throw new UsageError(`one run supports one API secret, but the selected connectors need: ${[...names].join(", ")}; run them separately`)
  }
  if (keyed.length === 0) return { http }
  const first = keyed[0]!
  const secret = secretNameOf(first)!
  const auth = loaded.apiAuth.get(first.id) ?? { type: "bearer" as const, secret }
  return { http, api: createApiTransport({ http, secrets: envSecrets(env), auth: { ...auth, secret } }) }
}

export interface LoadedRecipe {
  recipe: Recipe
  /** Absolute paths of the connector modules the recipe lists. */
  connectors: string[]
}

function issuePath(path: ReadonlyArray<PropertyKey>): string {
  return path.map((p, i) => (typeof p === "number" ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`)).join("") || "(root)"
}

/** Read and validate a recipe file. Problems are usage errors naming the path of each issue. */
export async function loadRecipe(file: string, cwd: string): Promise<LoadedRecipe> {
  const abs = resolve(cwd, file)
  let text: string
  try {
    text = await readFile(abs, "utf8")
  } catch {
    throw new UsageError(`cannot read recipe ${file}`)
  }
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch (e) {
    throw new UsageError(`invalid YAML in ${file}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new UsageError(`${file}: the recipe must be a mapping`)
  const { connectors, ...rest } = doc as Record<string, unknown>
  if (connectors !== undefined && (!Array.isArray(connectors) || connectors.some((c) => typeof c !== "string"))) {
    throw new UsageError(`${file}: connectors: must be a list of module paths`)
  }
  const parsed = Recipe.safeParse(rest)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${issuePath(i.path)}: ${i.message}`)
    throw new UsageError(`invalid recipe ${file}:\n${lines.join("\n")}`)
  }
  return { recipe: parsed.data, connectors: ((connectors as string[] | undefined) ?? []).map((c) => resolve(dirname(abs), c)) }
}

const SIDECAR = "cli.json"

/** Remember which connector modules a run used, so `resume` can load them again. */
export async function writeRunSidecar(storePath: string, runId: string, modules: string[]): Promise<void> {
  if (modules.length === 0) return
  await writeFile(resolve(storePath, "runs", runId, SIDECAR), `${JSON.stringify({ connectors: modules })}\n`)
}

export async function readRunSidecar(storePath: string, runId: string): Promise<string[]> {
  try {
    const v = JSON.parse(await readFile(resolve(storePath, "runs", runId, SIDECAR), "utf8")) as { connectors?: unknown }
    return Array.isArray(v.connectors) ? v.connectors.filter((c): c is string => typeof c === "string") : []
  } catch {
    return []
  }
}

export function storePathOf(io: Io, option: string | undefined): string {
  return resolve(io.cwd, option ?? io.env.COLLECT_STORE ?? "collect-store")
}
