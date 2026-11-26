import { describe, it, expect } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import {
  parseCollectionManifest,
  collectionFromManifest,
} from "@agentproto/collection/manifest"
import {
  parseDriverManifest,
  driverDefinitionFromManifest,
  driverFromManifest,
} from "@agentproto/driver/manifest"
import {
  parseToolManifest,
  toolFromManifestOnly,
  validateInput,
} from "@agentproto/tool"
import {
  parseRoutineManifest,
  routineFromManifest,
} from "@agentproto/routine"
import {
  defineMetricSource,
  MetricSample,
  MetricSourceSpec,
  sourceToManifests,
  manifestsToSource,
  renderSourceTs,
  writeSourceBundle,
  loadSource,
  computeIdempotencyKey,
  resolveClosedUtcWindow,
  zodToInlineJsonSchema,
  jsonSchemaToZod,
  type MetricSourceSpecInput,
} from "../index.js"

const HERE = dirname(fileURLToPath(import.meta.url))

const HTTP_FIXTURE: MetricSourceSpecInput = {
  schema: "metric-source/v1",
  id: "billing",
  toolId: "billing.read-transactions",
  routineId: "collect-billing-daily",
  description: "Read billing balance transactions with a restricted read-only key.",
  transport: {
    kind: "http",
    baseUrl: "https://api.billing.example",
    readOnly: true,
    auth: {
      secretRef: "BILLING_RESTRICTED_KEY",
      headerName: "Authorization",
      prefix: "Bearer ",
    },
    defaultHeaders: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    request: {
      endpoint: "/v1/balance_transactions",
      queryTemplate: {
        "created[gte]": "${input.periodStartUnix}",
        "created[lt]": "${input.periodEndUnix}",
        limit: "100",
      },
      responseExtract: "$.data",
    },
  },
  inputs: {
    type: "object",
    required: ["periodStartUnix", "periodEndUnix"],
    properties: {
      periodStartUnix: { type: "integer" },
      periodEndUnix: { type: "integer" },
    },
  },
  rawOutput: {
    type: "array",
    items: {
      type: "object",
      properties: {
        amount: { type: "integer" },
        currency: { type: "string" },
        created: { type: "integer" },
        status: { type: "string" },
      },
    },
  },
  metrics: [
    {
      id: "gross-volume",
      label: "Gross volume",
      unit: "eur",
      scale: 0.01,
      currency: "eur",
      supportedPeriods: ["day", "week", "month"],
      aggregation: "sum",
      valueField: "amount",
      pagination: {
        kind: "cursor",
        cursorField: "starting_after",
        hasMoreField: "has_more",
        itemsPath: "$.data",
      },
    },
  ],
  schedule: {
    kind: "cron",
    cron: "15 1 * * *",
    windowKind: "day",
    windowAnchor: "previous-closed-day",
    targetTool: "metrics_collect",
    metricIds: ["gross-volume"],
  },
  destination: {
    collection: "metric-sample",
    emitTo: "crm:measure",
  },
}

const MCP_FIXTURE: MetricSourceSpecInput = {
  schema: "metric-source/v1",
  id: "crm-pipeline",
  description: "Read pipeline deal counts through an imported MCP server.",
  transport: {
    kind: "mcp-imported",
    alias: "crm",
    tool: "group_records",
    readOnly: true,
  },
  inputs: {
    type: "object",
    required: ["objectName"],
    properties: { objectName: { type: "string" } },
  },
  rawOutput: {
    type: "object",
    properties: { groups: { type: "array" } },
  },
  metrics: [
    {
      id: "active-opportunities",
      label: "Active opportunities",
      unit: "count",
      scale: 1,
      supportedPeriods: ["day", "week", "month"],
      aggregation: "last",
      valueField: "count",
      pagination: { kind: "none" },
    },
  ],
  schedule: {
    kind: "cron",
    cron: "0 * * * *",
    timezone: "UTC",
    windowKind: "point",
    windowAnchor: "previous-closed-hour",
    targetTool: "metrics_collect",
  },
  destination: {
    collection: "metric-sample",
    emitTo: "crm:measure",
  },
}

const SQL_FIXTURE: MetricSourceSpecInput = {
  schema: "metric-source/v1",
  id: "warehouse",
  description: "Read daily active account counts from a read-only SQL replica.",
  transport: {
    kind: "sql-ro",
    connectionRef: "WAREHOUSE_RO_URL",
    query: "SELECT COUNT(DISTINCT account_id) AS active_accounts FROM events WHERE created_at >= $1 AND created_at < $2",
    readOnly: true,
  },
  inputs: {
    type: "object",
    required: ["periodStart", "periodEnd"],
    properties: {
      periodStart: { type: "string" },
      periodEnd: { type: "string" },
    },
  },
  rawOutput: {
    type: "array",
    items: {
      type: "object",
      properties: { active_accounts: { type: "integer" } },
    },
  },
  metrics: [
    {
      id: "active-accounts",
      label: "Active accounts",
      unit: "count",
      scale: 1,
      supportedPeriods: ["day", "week", "month"],
      aggregation: "last",
      valueField: "active_accounts",
      pagination: { kind: "none" },
    },
  ],
  schedule: {
    kind: "cron",
    cron: "30 2 * * *",
    windowKind: "day",
    windowAnchor: "previous-closed-day",
    targetTool: "metrics_collect",
  },
  destination: {
    collection: "metric-sample",
    emitTo: "crm:measure",
  },
}

const GOLDEN_HANDWRITTEN_TOOL = `---
schema: agentproto/tool/v1
id: billing.read-transactions
name: billing.read-transactions
description: Read billing balance transactions with a restricted read-only key.
version: 1.0.0
inputs:
  type: object
  required: [periodStartUnix, periodEndUnix]
  properties:
    periodStartUnix: { type: integer }
    periodEndUnix: { type: integer }
outputs:
  type: array
  items:
    type: object
    properties:
      amount: { type: integer }
      currency: { type: string }
      created: { type: integer }
      status: { type: string }
mutates: []
approval: auto
risk_level: 0
idempotent: true
requires:
  network: [api.billing.example]
  secrets: [BILLING_RESTRICTED_KEY]
---
# billing.read-transactions
`

const GOLDEN_HANDWRITTEN_DRIVER = `---
schema: agentproto/driver/v1
id: billing-http
name: billing-http
description: Read billing balance transactions with a restricted read-only key.
version: 1.0.0
kind: http
auth:
  state:
    env: [BILLING_RESTRICTED_KEY]
metadata:
  http:
    baseUrl: https://api.billing.example
    defaultHeaders:
      Content-Type: application/x-www-form-urlencoded
  metricSource:
    readOnly: true
    auth:
      headerName: Authorization
      prefix: "Bearer "
    destination:
      collection: metric-sample
      emitTo: "crm:measure"
    metrics:
      - id: gross-volume
        label: Gross volume
        unit: eur
        scale: 0.01
        currency: eur
        supportedPeriods: [day, week, month]
        aggregation: sum
        valueField: amount
        pagination:
          kind: cursor
          cursorField: starting_after
          hasMoreField: has_more
          itemsPath: "$.data"
implements:
  - tool: billing.read-transactions
    version: 1.0.0
    metadata:
      http:
        endpoint: /v1/balance_transactions
        method: GET
        queryTemplate:
          "created[gte]": "\${input.periodStartUnix}"
          "created[lt]": "\${input.periodEndUnix}"
          limit: "100"
        responseExtract: "$.data"
---
# billing-http
`

const GOLDEN_HANDWRITTEN_ROUTINE = `---
schema: routine/v1
id: collect-billing-daily
description: Read billing balance transactions with a restricted read-only key.
version: 1.0.0
schedule:
  kind: cron
  cron: "15 1 * * *"
target:
  tool: metrics_collect
  inputs:
    sourceId: billing
    metricIds: [gross-volume]
    windowKind: day
    windowAnchor: previous-closed-day
enabled: true
---
# collect-billing-daily
`

describe("bijective TS <-> .md metric source converter (CI invariant)", () => {
  const fixtures: Array<[string, MetricSourceSpecInput]> = [
    ["http", HTTP_FIXTURE],
    ["mcp-imported", MCP_FIXTURE],
    ["sql-ro", SQL_FIXTURE],
  ]

  for (const [label, fixture] of fixtures) {
    it(`round-trips ${label} fixture losslessly across all 4 real AIP parsers`, () => {
      const spec = defineMetricSource(fixture)

      // TS -> .md
      const b1 = sourceToManifests(spec, { includeCollection: true })

      // Verify all 4 real AIP parsers + *FromManifest constructors accept the emitted manifests
      const colManifest = parseCollectionManifest(b1.collectionMd!)
      collectionFromManifest(colManifest)

      const drvManifest = parseDriverManifest(b1.driverMd)
      driverDefinitionFromManifest(drvManifest)
      const toolId = spec.toolId ?? `${spec.id}.read`
      driverFromManifest({ manifest: drvManifest, execute: { [toolId]: async () => [] } })

      const toolManifest = parseToolManifest(b1.toolMd)
      toolFromManifestOnly(toolManifest)

      const routineManifest = parseRoutineManifest(b1.routineMd)
      routineFromManifest(routineManifest)

      // Ensure auth header is NEVER duplicated in defaultHeaders (single source of truth)
      if (spec.transport.kind === "http") {
        const defaultHeaders = (
          drvManifest.frontmatter.metadata as { http?: { defaultHeaders?: Record<string, string> } }
        )?.http?.defaultHeaders
        expect(defaultHeaders?.Authorization).toBeUndefined()
      }

      // .md -> TS
      const back = manifestsToSource(b1)
      expect(back.warnings).toEqual([])
      expect(back.spec).toEqual(spec)

      // .md -> TS -> .md has zero diff
      const b2 = sourceToManifests(back.spec, { includeCollection: true })
      expect(b2).toEqual(b1)

      // renderSourceTs -> re-parse produces exact spec
      const tsCode = renderSourceTs(back.spec)
      expect(tsCode).toContain('import { defineMetricSource } from "@agentproto/metric-source"')
      const match = tsCode.match(/defineMetricSource\((\{[\s\S]*\})\)/)
      expect(match).not.toBeNull()
      const reparsed = MetricSourceSpec.parse(JSON.parse(match![1]!))
      expect(reparsed).toEqual(spec)
    })
  }

  it("loads a handwritten golden .md bundle with zero warnings", () => {
    const res = manifestsToSource({
      toolMd: GOLDEN_HANDWRITTEN_TOOL,
      driverMd: GOLDEN_HANDWRITTEN_DRIVER,
      routineMd: GOLDEN_HANDWRITTEN_ROUTINE,
    })
    expect(res.warnings).toEqual([])
    expect(res.spec).toEqual(defineMetricSource(HTTP_FIXTURE))
  })

  it("rejects duplicate auth header in defineMetricSource and warns+strips if present in handwritten .md", () => {
    expect(() =>
      defineMetricSource({
        ...HTTP_FIXTURE,
        transport: {
          ...(HTTP_FIXTURE.transport as Extract<MetricSourceSpecInput["transport"], { kind: "http" }>),
          defaultHeaders: {
            Authorization: "Bearer ${secrets.BILLING_RESTRICTED_KEY}",
            "Content-Type": "application/x-www-form-urlencoded",
          },
        },
      }),
    ).toThrow(/defaultHeaders must not duplicate auth\.headerName/)

    const duplicatedDriver = GOLDEN_HANDWRITTEN_DRIVER.replace(
      "      Content-Type: application/x-www-form-urlencoded",
      '      Authorization: "Bearer ${secrets.BILLING_RESTRICTED_KEY}"\n      Content-Type: application/x-www-form-urlencoded',
    )
    const res = manifestsToSource({
      toolMd: GOLDEN_HANDWRITTEN_TOOL,
      driverMd: duplicatedDriver,
      routineMd: GOLDEN_HANDWRITTEN_ROUTINE,
    })
    expect(res.warnings.some((w) => w.includes("duplicates auth header"))).toBe(true)
    expect(res.spec).toEqual(defineMetricSource(HTTP_FIXTURE))
  })

  it("loads a handwritten .md bundle without metadata.metricSource and emits explicit warnings", () => {
    const minimalDriver = `---
schema: agentproto/driver/v1
id: minimal-http
name: Minimal HTTP
description: Handwritten driver without metricSource metadata.
version: 1.0.0
kind: http
auth:
  state:
    env: [MINIMAL_KEY]
metadata:
  http:
    baseUrl: https://api.minimal.example
implements:
  - tool: minimal.read
    version: 1.0.0
    metadata:
      http:
        endpoint: /v1/stats
        method: GET
---
`
    const minimalTool = `---
schema: agentproto/tool/v1
id: minimal.read
name: Minimal read
description: Handwritten tool.
version: 1.0.0
inputs:
  type: object
  properties: {}
outputs:
  type: object
---
`
    const minimalRoutine = `---
schema: routine/v1
id: collect-minimal
description: Daily minimal collection.
version: 1.0.0
schedule:
  kind: cron
  cron: "0 2 * * *"
target:
  tool: metrics_collect
  inputs:
    sourceId: minimal
    windowKind: day
    windowAnchor: previous-closed-day
enabled: true
---
`
    const res = manifestsToSource({
      toolMd: minimalTool,
      driverMd: minimalDriver,
      routineMd: minimalRoutine,
    })
    expect(res.spec.id).toBe("minimal")
    expect(res.warnings.length).toBeGreaterThanOrEqual(2)
    expect(res.warnings[0]).toContain("omits metadata.metricSource")
  })

  it("enforces two-level tool separation: raw tool rejects routine inputs and accepts raw period inputs", () => {
    const b = sourceToManifests(HTTP_FIXTURE)
    const rawHandle = toolFromManifestOnly(parseToolManifest(b.toolMd))
    const routineInputs = {
      sourceId: "billing",
      metricIds: ["gross-volume"],
      windowKind: "day",
      windowAnchor: "previous-closed-day",
    }
    expect(validateInput(rawHandle, routineInputs).ok).toBe(false)
    expect(validateInput(rawHandle, { periodStartUnix: 1764028800, periodEndUnix: 1764115200 }).ok).toBe(true)
  })

  it("writes atomically with writeSourceBundle and reloads identically with loadSource", async () => {
    const dir = await mkdtemp(join(HERE, ".tmp-metric-source-"))
    try {
      const spec = defineMetricSource(HTTP_FIXTURE)
      const { paths } = await writeSourceBundle(spec, dir, { includeCollection: true })
      expect(paths.toolPath).toBe(join(dir, ".agentproto", "tools", "billing.read-transactions", "TOOL.md"))
      expect(paths.driverPath).toBe(join(dir, ".agentproto", "drivers", "billing-http", "DRIVER.md"))
      expect(paths.routinePath).toBe(join(dir, ".routines", "collect-billing-daily", "ROUTINE.md"))
      expect(paths.collectionPath).toBe(join(dir, "collections", "metric-sample", "COLLECTION.md"))

      const loaded = await loadSource(dir, "billing")
      expect(loaded.warnings).toEqual([])
      expect(loaded.spec).toEqual(spec)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("round-trips Zod MetricSample via zodToInlineJsonSchema / jsonSchemaToZod and computes valid SHA-256 keys", () => {
    const jsonSchema = zodToInlineJsonSchema(MetricSample)
    expect(jsonSchema.$schema).toBeUndefined()
    const restored = jsonSchemaToZod(jsonSchema)

    const win = resolveClosedUtcWindow("day", "previous-closed-day", new Date("2026-11-26T01:15:00Z"))
    expect(win).toEqual({
      periodKind: "day",
      periodStart: "2026-11-25T00:00:00.000Z",
      periodEnd: "2026-11-26T00:00:00.000Z",
      periodStartUnix: Date.UTC(2026, 10, 25) / 1000,
      periodEndUnix: Date.UTC(2026, 10, 26) / 1000,
    })

    const key = computeIdempotencyKey({
      source: "billing",
      metric: "gross-volume",
      periodKind: win.periodKind,
      periodStart: win.periodStart,
      periodEnd: win.periodEnd,
    })
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    // Valid AIP-18 collection item id regex
    expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9_:-]{0,95}$/)

    const sample = {
      metric: "gross-volume",
      value: 142.5,
      unit: "eur",
      periodKind: "day",
      periodStart: win.periodStart,
      periodEnd: win.periodEnd,
      observedAt: "2026-11-26T01:15:00.000Z",
      source: "billing",
      idempotencyKey: key,
    }
    expect(MetricSample.safeParse(sample).success).toBe(true)
    expect(restored.safeParse(sample).success).toBe(true)

    expect(() => zodToInlineJsonSchema(z.string())).not.toThrow()
    expect(() =>
      jsonSchemaToZod({ $ref: "agentproto://schema/metric-sample" }),
    ).toThrow(/External \$ref/)
  })
})
