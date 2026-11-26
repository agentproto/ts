import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import matter from "gray-matter"
import {
  collectionSpec,
  parseCollectionManifest,
  type CollectionVerbParams,
} from "@agentproto/collection"
import { driverSpec } from "@agentproto/driver"
import { parseDriverManifest } from "@agentproto/driver/manifest"
import { updateManifestSet, type ManifestOp } from "@agentproto/manifest"
import { parseRoutineManifest } from "@agentproto/routine"
import { parseToolManifest, toolSpec } from "@agentproto/tool"
import {
  MetricSourceSpec,
  type MetricDescriptor,
  type MetricSourceSpecInput,
  type MetricTransportSpec,
} from "./schema.js"

/**
 * Canonical AIP-18 `metric-sample` collection schema.
 */
export const METRIC_SAMPLE_COLLECTION: CollectionVerbParams = {
  schema: "collection.schema/v1",
  name: "metric-sample",
  title: "Metric sample",
  description: "One dated observation of one metric, read from one declared source.",
  version: "1.0.0",
  fields: [
    { name: "metric", type: "string", required: true },
    { name: "value", type: "number", required: true },
    {
      name: "unit",
      type: "enum",
      enum: ["eur", "usd", "count", "percent", "credits", "ms", "boolean"],
      required: true,
    },
    {
      name: "periodKind",
      type: "enum",
      enum: ["point", "day", "week", "month", "total"],
      required: true,
    },
    { name: "periodStart", type: "datetime", required: true },
    { name: "periodEnd", type: "datetime", required: true },
    { name: "observedAt", type: "datetime", required: true },
    { name: "source", type: "string", required: true },
    { name: "idempotencyKey", type: "string", required: true },
    { name: "runId", type: "string", required: false },
    { name: "proof", type: "string", required: false },
  ],
  identity: {
    slugSource: "idempotencyKey",
  },
}

export interface SourceManifestBundle {
  toolMd: string
  driverMd: string
  routineMd: string
  collectionMd?: string
}

export interface SourceToManifestsOptions {
  includeCollection?: boolean
}

export interface ManifestsToSourceResult {
  spec: MetricSourceSpec
  warnings: string[]
}

export interface SourceBundlePaths {
  toolPath: string
  driverPath: string
  routinePath: string
  collectionPath?: string
}

/** Deterministic driver id convention: `<spec.id>-<transportSuffix>`. */
export function driverIdForSource(id: string, kind: MetricTransportSpec["kind"]): string {
  const suffix = kind === "http" ? "http" : kind === "mcp-imported" ? "mcp" : "sql"
  return `${id}-${suffix}`
}

/** Default raw tool id when `spec.toolId` is omitted. */
export function defaultToolIdForSource(id: string): string {
  return `${id}.read`
}

/** Default routine id when `spec.routineId` is omitted. */
export function defaultRoutineIdForSource(id: string): string {
  return `collect-${id}`
}

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefinedDeep)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = stripUndefinedDeep(v)
    }
    return out
  }
  return value
}

function driverKindForTransport(kind: MetricTransportSpec["kind"]): "http" | "mcp" | "sdk" {
  if (kind === "http") return "http"
  if (kind === "mcp-imported") return "mcp"
  return "sdk"
}

function sourceIdFromDriverId(driverId: string, transportKind: MetricTransportSpec["kind"]): string {
  const suffix = transportKind === "http" ? "-http" : transportKind === "mcp-imported" ? "-mcp" : "-sql"
  return driverId.endsWith(suffix) ? driverId.slice(0, -suffix.length) : driverId
}

/**
 * Pure conversion: validated `MetricSourceSpec` -> standard AIP manifest bundle.
 * Every field is emitted in its single canonical place; no sidecar JSON file is produced.
 */
export function sourceToManifests(
  input: MetricSourceSpecInput,
  opts: SourceToManifestsOptions = {},
): SourceManifestBundle {
  const spec = MetricSourceSpec.parse(input)
  const toolId = spec.toolId ?? defaultToolIdForSource(spec.id)
  const driverId = driverIdForSource(spec.id, spec.transport.kind)
  const routineId = spec.routineId ?? defaultRoutineIdForSource(spec.id)

  // 1. TOOL.md (AIP-14)
  const requires: { network?: string[]; secrets?: string[] } = {}
  if (spec.transport.kind === "http") {
    const host = new URL(spec.transport.baseUrl).hostname
    requires.network = [host]
    requires.secrets = [spec.transport.auth.secretRef]
  } else if (spec.transport.kind === "sql-ro") {
    requires.secrets = [spec.transport.connectionRef]
  }

  const toolFrontmatter = toolSpec.toFrontmatter!({
    id: toolId,
    name: toolId,
    description: spec.description,
    version: "1.0.0",
    inputs: spec.inputs,
    outputs: spec.rawOutput,
    mutates: [],
    approval: "auto",
    riskLevel: 0,
    idempotent: true,
    ...(Object.keys(requires).length > 0 ? { requires } : {}),
  })
  const toolMd = matter.stringify(`# ${toolId}\n`, stripUndefinedDeep(toolFrontmatter) as Record<string, unknown>)

  // 2. DRIVER.md (AIP-30) — single pivot for non-AIP fields under `metadata.metricSource`
  const driverMetadata: Record<string, unknown> = {}
  const metricSourceMeta: Record<string, unknown> = {
    readOnly: true,
    destination: spec.destination,
    metrics: spec.metrics,
  }

  let authBlock: Record<string, unknown> | undefined
  let implementsEntryMeta: Record<string, unknown> | undefined

  if (spec.transport.kind === "http") {
    const httpTransport = spec.transport
    authBlock = { state: { env: [httpTransport.auth.secretRef] } }
    // Never duplicate `auth.headerName` inside `defaultHeaders`: the collector
    // composes the authentication header from `auth.state.env[0]` + `metadata.metricSource.auth`.
    const cleanHeaders = httpTransport.defaultHeaders
      ? Object.fromEntries(
          Object.entries(httpTransport.defaultHeaders).filter(
            ([k]) => k.toLowerCase() !== httpTransport.auth.headerName.toLowerCase(),
          ),
        )
      : undefined
    driverMetadata.http = {
      baseUrl: httpTransport.baseUrl,
      ...(cleanHeaders && Object.keys(cleanHeaders).length > 0 ? { defaultHeaders: cleanHeaders } : {}),
    }
    metricSourceMeta.auth = {
      headerName: httpTransport.auth.headerName,
      prefix: httpTransport.auth.prefix,
    }
    implementsEntryMeta = {
      http: {
        endpoint: httpTransport.request.endpoint,
        method: "GET",
        ...(httpTransport.request.queryTemplate ? { queryTemplate: httpTransport.request.queryTemplate } : {}),
        ...(httpTransport.request.responseExtract ? { responseExtract: httpTransport.request.responseExtract } : {}),
      },
    }
  } else if (spec.transport.kind === "mcp-imported") {
    driverMetadata.mcp = {
      alias: spec.transport.alias,
      tool: spec.transport.tool,
    }
    metricSourceMeta.transportKind = "mcp-imported"
  } else {
    authBlock = { state: { env: [spec.transport.connectionRef] } }
    driverMetadata.sql = {
      query: spec.transport.query,
    }
    metricSourceMeta.transportKind = "sql-ro"
  }

  driverMetadata.metricSource = metricSourceMeta

  const driverFrontmatter = driverSpec.toFrontmatter!({
    id: driverId,
    name: driverId,
    description: spec.description,
    version: "1.0.0",
    kind: driverKindForTransport(spec.transport.kind),
    ...(authBlock ? { auth: authBlock as never } : {}),
    metadata: driverMetadata,
    implements: [
      {
        tool: toolId,
        version: "1.0.0",
        ...(implementsEntryMeta ? { metadata: implementsEntryMeta } : {}),
      },
    ],
  })
  const driverMd = matter.stringify(
    `# ${driverId}\n`,
    stripUndefinedDeep(driverFrontmatter) as Record<string, unknown>,
  )

  // 3. ROUTINE.md (AIP-41)
  const routineFrontmatter: Record<string, unknown> = {
    schema: "routine/v1",
    id: routineId,
    description: spec.description,
    version: "1.0.0",
    schedule: {
      kind: "cron",
      cron: spec.schedule.cron,
      ...(spec.schedule.timezone ? { timezone: spec.schedule.timezone } : {}),
    },
    target: {
      tool: spec.schedule.targetTool,
      inputs: {
        sourceId: spec.id,
        ...(spec.schedule.metricIds ? { metricIds: spec.schedule.metricIds } : {}),
        windowKind: spec.schedule.windowKind,
        windowAnchor: spec.schedule.windowAnchor,
      },
    },
    enabled: true,
  }
  const routineMd = matter.stringify(
    `# ${routineId}\n`,
    stripUndefinedDeep(routineFrontmatter) as Record<string, unknown>,
  )

  // 4. Optional COLLECTION.md (AIP-18)
  let collectionMd: string | undefined
  if (opts.includeCollection) {
    const colFm = collectionSpec.toFrontmatter!(METRIC_SAMPLE_COLLECTION)
    collectionMd = matter.stringify(
      "# metric-sample\n",
      stripUndefinedDeep(colFm) as Record<string, unknown>,
    )
  }

  return {
    toolMd,
    driverMd,
    routineMd,
    ...(collectionMd !== undefined ? { collectionMd } : {}),
  }
}

/**
 * Pure inverse conversion: AIP manifest bundle -> validated `MetricSourceSpec`.
 * Parses through the real AIP parsers; never drops information silently (emits
 * explicit `warnings` whenever a hand-written bundle omits `metadata.metricSource`
 * or duplicates an auth header).
 */
export function manifestsToSource(bundle: SourceManifestBundle): ManifestsToSourceResult {
  const warnings: string[] = []

  const parsedTool = parseToolManifest(bundle.toolMd)
  const parsedDriver = parseDriverManifest(bundle.driverMd)
  const parsedRoutine = parseRoutineManifest(bundle.routineMd)
  if (bundle.collectionMd !== undefined) {
    parseCollectionManifest(bundle.collectionMd)
  }

  const tfm = parsedTool.frontmatter
  const dfm = parsedDriver.frontmatter
  const rfm = parsedRoutine.frontmatter

  const driverMeta = (dfm.metadata ?? {}) as Record<string, unknown>
  const msMeta = driverMeta.metricSource as Record<string, unknown> | undefined
  if (!msMeta) {
    warnings.push(
      `DRIVER.md '${dfm.id}' omits metadata.metricSource; inferred default metrics, auth and destination.`,
    )
  }

  const target = rfm.target as { tool?: string; inputs?: Record<string, unknown> }
  const targetInputs = (target.inputs ?? {}) as Record<string, unknown>

  // Determine transport kind
  const explicitKind = msMeta?.transportKind
  let transportKind: MetricTransportSpec["kind"]
  if (explicitKind === "mcp-imported" || dfm.kind === "mcp") {
    transportKind = "mcp-imported"
  } else if (explicitKind === "sql-ro" || driverMeta.sql !== undefined) {
    transportKind = "sql-ro"
  } else {
    transportKind = "http"
  }

  // Reconstruct canonical source id: prefer routine target.inputs.sourceId, fallback to driver.id convention
  const sourceId =
    typeof targetInputs.sourceId === "string" && targetInputs.sourceId.length > 0
      ? targetInputs.sourceId
      : sourceIdFromDriverId(dfm.id, transportKind)

  const toolId = tfm.id
  const routineId = rfm.id

  let transport: MetricTransportSpec
  if (transportKind === "http") {
    const httpDriverMeta = (driverMeta.http ?? {}) as Record<string, unknown>
    const baseUrl = httpDriverMeta.baseUrl ?? httpDriverMeta.base_url
    if (typeof baseUrl !== "string" || !baseUrl) {
      throw new Error(`manifestsToSource: HTTP DRIVER.md '${dfm.id}' is missing metadata.http.baseUrl.`)
    }

    const authEnv = (dfm.auth as { state?: { env?: unknown } } | undefined)?.state?.env
    const secretRef =
      Array.isArray(authEnv) && typeof authEnv[0] === "string" && authEnv[0].length > 0
        ? authEnv[0]
        : `${sourceId.toUpperCase().replace(/-/g, "_")}_API_KEY`
    if (!(Array.isArray(authEnv) && typeof authEnv[0] === "string" && authEnv[0].length > 0)) {
      warnings.push(
        `DRIVER.md '${dfm.id}' omits auth.state.env[0]; inferred secretRef '${secretRef}'.`,
      )
    }

    const authMeta = (msMeta?.auth ?? {}) as Record<string, unknown>
    const headerName =
      typeof authMeta.headerName === "string" && authMeta.headerName.length > 0
        ? authMeta.headerName
        : "Authorization"
    const prefix = typeof authMeta.prefix === "string" ? authMeta.prefix : "Bearer "

    const rawHeaders = (httpDriverMeta.defaultHeaders ?? httpDriverMeta.default_headers) as
      | Record<string, string>
      | undefined
    let defaultHeaders: Record<string, string> | undefined
    if (rawHeaders && typeof rawHeaders === "object") {
      const filtered: Record<string, string> = {}
      for (const [k, v] of Object.entries(rawHeaders)) {
        if (k.toLowerCase() === headerName.toLowerCase()) {
          warnings.push(
            `DRIVER.md '${dfm.id}' duplicates auth header '${k}' in metadata.http.defaultHeaders; stripped in favor of transport.auth.`,
          )
          continue
        }
        filtered[k] = String(v)
      }
      if (Object.keys(filtered).length > 0) defaultHeaders = filtered
    }

    const implEntry = dfm.implements.find((e) => e.tool === toolId) ?? dfm.implements[0]
    const implHttp = ((implEntry?.metadata ?? {}) as { http?: Record<string, unknown> }).http ?? {}
    const endpoint = typeof implHttp.endpoint === "string" ? implHttp.endpoint : "/"
    const queryTemplate = (implHttp.queryTemplate ?? implHttp.query_template) as
      | Record<string, string>
      | undefined
    const responseExtract = (implHttp.responseExtract ?? implHttp.response_extract) as
      | string
      | undefined

    transport = {
      kind: "http",
      baseUrl,
      readOnly: true,
      auth: { secretRef, headerName, prefix },
      ...(defaultHeaders ? { defaultHeaders } : {}),
      request: {
        endpoint,
        ...(queryTemplate && Object.keys(queryTemplate).length > 0 ? { queryTemplate } : {}),
        ...(responseExtract !== undefined ? { responseExtract } : {}),
      },
    }
  } else if (transportKind === "mcp-imported") {
    const mcpMeta = (driverMeta.mcp ?? {}) as Record<string, unknown>
    if (typeof mcpMeta.alias !== "string" || typeof mcpMeta.tool !== "string") {
      throw new Error(
        `manifestsToSource: MCP DRIVER.md '${dfm.id}' requires metadata.mcp.alias and metadata.mcp.tool.`,
      )
    }
    transport = {
      kind: "mcp-imported",
      alias: mcpMeta.alias,
      tool: mcpMeta.tool,
      readOnly: true,
    }
  } else {
    const sqlMeta = (driverMeta.sql ?? {}) as Record<string, unknown>
    const authEnv = (dfm.auth as { state?: { env?: unknown } } | undefined)?.state?.env
    const connectionRef =
      Array.isArray(authEnv) && typeof authEnv[0] === "string" && authEnv[0].length > 0
        ? authEnv[0]
        : typeof sqlMeta.connectionRef === "string"
          ? sqlMeta.connectionRef
          : ""
    if (!connectionRef || typeof sqlMeta.query !== "string") {
      throw new Error(
        `manifestsToSource: SQL DRIVER.md '${dfm.id}' requires auth.state.env[0] and metadata.sql.query.`,
      )
    }
    transport = {
      kind: "sql-ro",
      connectionRef,
      query: sqlMeta.query,
      readOnly: true,
    }
  }

  let metrics: MetricDescriptor[]
  if (Array.isArray(msMeta?.metrics) && msMeta.metrics.length > 0) {
    metrics = msMeta.metrics as MetricDescriptor[]
  } else {
    warnings.push(
      `DRIVER.md '${dfm.id}' omits metadata.metricSource.metrics; inferred fallback count metric '${sourceId}-value'.`,
    )
    metrics = [
      {
        id: `${sourceId}-value`,
        label: sourceId,
        unit: "count",
        scale: 1,
        supportedPeriods: ["day"],
        aggregation: "last",
        pagination: { kind: "none" },
      },
    ]
  }

  const destinationRaw = msMeta?.destination as { collection?: string; emitTo?: string } | undefined
  const destination =
    destinationRaw &&
    destinationRaw.collection === "metric-sample" &&
    typeof destinationRaw.emitTo === "string"
      ? { collection: "metric-sample" as const, emitTo: destinationRaw.emitTo }
      : (() => {
          warnings.push(
            `DRIVER.md '${dfm.id}' omits metadata.metricSource.destination; inferred emitTo 'local:metric-sample'.`,
          )
          return { collection: "metric-sample" as const, emitTo: "local:metric-sample" }
        })()

  const sched = rfm.schedule as { kind?: string; cron?: string; timezone?: string }
  if (sched.kind !== "cron" || typeof sched.cron !== "string") {
    throw new Error(`manifestsToSource: ROUTINE.md '${rfm.id}' must use a cron schedule.`)
  }

  const rawSpec: MetricSourceSpecInput = {
    schema: "metric-source/v1",
    id: sourceId,
    ...(toolId !== defaultToolIdForSource(sourceId) ? { toolId } : {}),
    ...(routineId !== defaultRoutineIdForSource(sourceId) ? { routineId } : {}),
    description: dfm.description,
    transport,
    inputs: tfm.inputs ?? { type: "object", properties: {} },
    rawOutput: tfm.outputs ?? { type: "object" },
    metrics: metrics as [MetricDescriptor, ...MetricDescriptor[]],
    schedule: {
      kind: "cron",
      cron: sched.cron,
      ...(typeof sched.timezone === "string" ? { timezone: sched.timezone } : {}),
      ...(typeof targetInputs.windowKind === "string"
        ? { windowKind: targetInputs.windowKind as "point" | "day" | "week" | "month" }
        : {}),
      ...(typeof targetInputs.windowAnchor === "string"
        ? { windowAnchor: targetInputs.windowAnchor }
        : {}),
      ...(typeof target.tool === "string" ? { targetTool: target.tool } : {}),
      ...(Array.isArray(targetInputs.metricIds)
        ? { metricIds: targetInputs.metricIds.map(String) }
        : {}),
    },
    destination,
  }

  return {
    spec: MetricSourceSpec.parse(rawSpec),
    warnings,
  }
}

/**
 * Render a standalone TypeScript `SOURCE.ts` declaration from a `MetricSourceSpec`.
 */
export function renderSourceTs(input: MetricSourceSpecInput): string {
  const spec = MetricSourceSpec.parse(input)
  const serialized = JSON.stringify(spec, null, 2)
  return [
    'import { defineMetricSource } from "@agentproto/metric-source"',
    "",
    `export const source = defineMetricSource(${serialized})`,
    "",
    "export default source",
    "",
  ].join("\n")
}

/**
 * Compute standard runtime paths for a source's manifests under `dir`.
 */
export function sourceBundlePaths(
  input: MetricSourceSpecInput,
  dir: string,
  opts: SourceToManifestsOptions = {},
): SourceBundlePaths {
  const spec = MetricSourceSpec.parse(input)
  const toolId = spec.toolId ?? defaultToolIdForSource(spec.id)
  const driverId = driverIdForSource(spec.id, spec.transport.kind)
  const routineId = spec.routineId ?? defaultRoutineIdForSource(spec.id)
  return {
    toolPath: join(dir, ".agentproto", "tools", toolId, "TOOL.md"),
    driverPath: join(dir, ".agentproto", "drivers", driverId, "DRIVER.md"),
    routinePath: join(dir, ".routines", routineId, "ROUTINE.md"),
    ...(opts.includeCollection
      ? { collectionPath: join(dir, "collections", "metric-sample", "COLLECTION.md") }
      : {}),
  }
}

/**
 * Atomically write a metric source's manifest bundle to disk using `updateManifestSet`.
 */
export async function writeSourceBundle(
  input: MetricSourceSpecInput,
  dir: string,
  opts: SourceToManifestsOptions & { dryRun?: boolean; backup?: boolean } = {},
): Promise<{ paths: SourceBundlePaths; bundle: SourceManifestBundle }> {
  const spec = MetricSourceSpec.parse(input)
  const bundle = sourceToManifests(spec, opts)
  const paths = sourceBundlePaths(spec, dir, opts)

  if (!opts.dryRun) {
    const ops: ManifestOp[] = [
      async () => ({ path: paths.toolPath, rendered: bundle.toolMd }),
      async () => ({ path: paths.driverPath, rendered: bundle.driverMd }),
      async () => ({ path: paths.routinePath, rendered: bundle.routineMd }),
    ]
    if (paths.collectionPath && bundle.collectionMd !== undefined) {
      const colPath = paths.collectionPath
      const colMd = bundle.collectionMd
      ops.push(async () => ({ path: colPath, rendered: colMd }))
    }
    await updateManifestSet(ops, { backup: opts.backup })
  }

  return { paths, bundle }
}

/**
 * Load a metric source bundle from disk by `sourceId` (discovering its matching
 * driver, tool and routine manifests) and convert it back to a validated `MetricSourceSpec`.
 */
export async function loadSource(
  dir: string,
  sourceId: string,
): Promise<ManifestsToSourceResult & { paths: SourceBundlePaths }> {
  const driversDir = join(dir, ".agentproto", "drivers")
  const candidateDriverIds = [
    driverIdForSource(sourceId, "http"),
    driverIdForSource(sourceId, "mcp-imported"),
    driverIdForSource(sourceId, "sql-ro"),
    sourceId,
  ]

  let driverPath: string | undefined
  let driverMd: string | undefined
  for (const candidate of candidateDriverIds) {
    const p = join(driversDir, candidate, "DRIVER.md")
    try {
      driverMd = await readFile(p, "utf8")
      driverPath = p
      break
    } catch {
      // try next suffix
    }
  }
  if (!driverPath || driverMd === undefined) {
    throw new Error(`loadSource: no DRIVER.md found for source '${sourceId}' under '${driversDir}'.`)
  }

  const parsedDriver = parseDriverManifest(driverMd)
  const toolId = parsedDriver.frontmatter.implements[0]?.tool
  if (!toolId) {
    throw new Error(`loadSource: DRIVER.md '${driverPath}' declares no implements[] entry.`)
  }
  const toolPath = join(dir, ".agentproto", "tools", toolId, "TOOL.md")
  const toolMd = await readFile(toolPath, "utf8")

  // Locate matching routine by scanning `.routines/*/ROUTINE.md` for `target.inputs.sourceId === sourceId`
  const routinesDir = join(dir, ".routines")
  let routinePath: string | undefined
  let routineMd: string | undefined
  const defaultRoutine = join(routinesDir, defaultRoutineIdForSource(sourceId), "ROUTINE.md")
  try {
    routineMd = await readFile(defaultRoutine, "utf8")
    routinePath = defaultRoutine
  } catch {
    const entries = await readdir(routinesDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const p = join(routinesDir, entry.name, "ROUTINE.md")
      try {
        const src = await readFile(p, "utf8")
        const parsed = parseRoutineManifest(src)
        const tgt = parsed.frontmatter.target as { inputs?: { sourceId?: unknown } }
        if (tgt.inputs?.sourceId === sourceId) {
          routinePath = p
          routineMd = src
          break
        }
      } catch {
        // skip unrelated or malformed routines
      }
    }
  }
  if (!routinePath || routineMd === undefined) {
    throw new Error(
      `loadSource: no ROUTINE.md found for source '${sourceId}' under '${routinesDir}'.`,
    )
  }

  const collectionCandidate = join(dir, "collections", "metric-sample", "COLLECTION.md")
  let collectionMd: string | undefined
  let collectionPath: string | undefined
  try {
    collectionMd = await readFile(collectionCandidate, "utf8")
    collectionPath = collectionCandidate
  } catch {
    // optional
  }

  const converted = manifestsToSource({
    toolMd,
    driverMd,
    routineMd,
    ...(collectionMd !== undefined ? { collectionMd } : {}),
  })

  return {
    ...converted,
    paths: {
      toolPath,
      driverPath,
      routinePath,
      ...(collectionPath ? { collectionPath } : {}),
    },
  }
}
