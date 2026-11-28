import { resolve } from "node:path"
import { type Connector, CollectTask, Recipe, type RecipeSource } from "@agentproto/collect"
import { type ExitCode, type Io, UsageError, out, outJson, table } from "../io"
import { intOption, parse, positional } from "../args"
import { loadConnectors, loadRecipe, readRunSidecar, storePathOf } from "../load"
import { CONNECTOR_OPTION } from "./connectors"
import { execute, open } from "./shared"

const RUN_OPTIONS = {
  ...CONNECTOR_OPTION,
  store: { type: "string" },
  "rate-ms": { type: "string" },
} as const

function rateOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) throw new UsageError(`--rate-ms must be a non-negative integer, got "${value}"`)
  return Number(value)
}

function connectorsOf(recipe: Recipe, registry: { get(id: string): Connector | undefined }): Connector[] {
  const ids = [...new Set(recipe.sources.map((s) => s.connector))]
  return ids.map((id) => registry.get(id)).filter((c): c is Connector => c !== undefined)
}

export async function runRun(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, {
    ...RUN_OPTIONS,
    source: { type: "string", multiple: true },
    query: { type: "string", multiple: true },
    subject: { type: "string" },
    max: { type: "string" },
    "dry-run": { type: "boolean" },
  })
  if (positionals.length > 1) positional(positionals, "recipe", 1)
  const max = intOption("max", values.max)
  const rateMs = rateOf(values["rate-ms"])
  const modules = [...(values.connector ?? [])]
  let recipe: Recipe

  if (positionals[0]) {
    const loaded = await loadRecipe(positionals[0], io.cwd)
    modules.push(...loaded.connectors)
    recipe = loaded.recipe
    if (values.source?.length) {
      const unknown = values.source.filter((s) => !recipe.sources.some((r) => r.connector === s))
      if (unknown.length) throw new UsageError(`--source ${unknown.join(", ")} is not in the recipe`)
      recipe = { ...recipe, sources: recipe.sources.filter((s) => values.source!.includes(s.connector)) }
    }
    if (values.query?.length) {
      if (!values.subject) throw new UsageError("--query needs --subject")
      const queries = values.query.map((text) => ({ text, subject: values.subject! }))
      recipe = { ...recipe, sources: recipe.sources.map((s) => ({ ...s, queries })) }
    }
  } else {
    if (!values.source?.length) throw new UsageError("give a recipe file, or --source <connector> for a trial run")
    if (values.query?.length && !values.subject) throw new UsageError("--query needs --subject")
    const queries = (values.query ?? []).map((text) => ({ text, subject: values.subject! }))
    recipe = Recipe.parse({ name: "trial", sources: values.source.map((connector) => ({ connector, queries })) })
  }
  if (max !== undefined) recipe = { ...recipe, caps: { ...recipe.caps, total: max } }

  const loadedConnectors = await loadConnectors(modules, io.cwd)
  const connectors = connectorsOf(recipe, loadedConnectors.registry)

  if (values["dry-run"]) {
    const tasks: Array<{ connector: string; id: string; kind?: string; params: Record<string, unknown> }> = []
    const seen = new Set<string>()
    for (const id of new Set(recipe.sources.map((s) => s.connector))) {
      const c = loadedConnectors.registry.get(id)
      if (!c) throw new UsageError(`connector "${id}" is not registered (load it with --connector <module>)`)
      const sources: RecipeSource[] = recipe.sources.filter((s) => s.connector === id)
      for (const t of c.plan(recipe, sources)) {
        const task = CollectTask.parse(t)
        if (seen.has(`${id}/${task.id}`)) continue
        seen.add(`${id}/${task.id}`)
        tasks.push({ connector: id, id: task.id, ...(task.kind ? { kind: task.kind } : {}), params: task.params })
      }
    }
    if (values.json) outJson(io, { dryRun: true, tasks })
    else {
      out(io, `dry run: ${tasks.length} planned task${tasks.length === 1 ? "" : "s"}, nothing fetched or written`)
      if (tasks.length) out(io, table(tasks.map((t) => [t.connector, t.id, t.kind ?? "", JSON.stringify(t.params)])))
    }
    return 0
  }

  return execute(io, {
    storePath: storePathOf(io, values.store),
    json: Boolean(values.json),
    quiet: Boolean(values.quiet),
    connectors,
    loaded: loadedConnectors,
    modules: modules.map((m) => resolve(io.cwd, m)),
    rateMs,
    start: (collector, onEvent) => collector.run(recipe, { signal: io.signal, onEvent }),
  })
}

export async function runResume(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, RUN_OPTIONS)
  const [runId] = positional(positionals, "runId")
  const rateMs = rateOf(values["rate-ms"])
  const storePath = storePathOf(io, values.store)
  const run = await (await open(storePath)).getRun(runId!)
  if (!run) throw new UsageError(`unknown run ${runId}`)
  const modules = [...(await readRunSidecar(storePath, runId!)), ...(values.connector ?? []).map((m) => resolve(io.cwd, m))]
  const loaded = await loadConnectors([...new Set(modules)], io.cwd)
  return execute(io, {
    storePath,
    json: Boolean(values.json),
    quiet: Boolean(values.quiet),
    connectors: connectorsOf(run.recipe, loaded.registry),
    loaded,
    modules: [...new Set(modules)],
    rateMs,
    start: (collector, onEvent) => collector.resume(runId!, { signal: io.signal, onEvent }),
  })
}
