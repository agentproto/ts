/**
 * AIP-30 doctype spec — fed to `@agentproto/manifest.createVerbs`
 * to derive create / load / list / update / resolve / delete in one
 * place, mirroring the pattern in `@agentproto/tool/src/spec.ts`.
 *
 * The spec bridges two naming conventions:
 *  - DRIVER.md frontmatter uses snake_case (policy_tags, schema_narrowing, …)
 *  - DriverDefinition / DriverHandle use camelCase (policyTags, schemaNarrowing, …)
 *
 * `parse()` converts snake → camel so `createVerbs.load/list` hand a
 * proper `DriverDefinition` to `defineDriver`.
 *
 * `toFrontmatter()` converts camel → snake so `createVerbs.create/update`
 * write valid DRIVER.md files. Only the universal AIP-30 fields are mapped;
 * install.* is intentionally omitted until AIP-29 install shapes are stable.
 *
 * `define()` injects stub execute bodies (D3) when neither `execute` nor
 * `implementations` are present, so file-system ops work without a TS
 * dispatch module alongside the DRIVER.md.
 */

import { createVerbs, type DoctypeSpec } from "@agentproto/manifest"
import { defineDriver, normalizeToolId } from "./define-provider.js"
import { parseDriverManifest } from "./manifest/index.js"
import type { DriverDefinition, DriverHandle, ExecuteFn } from "./types.js"

export const driverSpec: DoctypeSpec<DriverDefinition, DriverHandle> = {
  name: "driver",
  aip: 30,
  schemaLiteral: "agentproto/driver/v1",

  pathOf: (h) => `${h.id}/DRIVER.md`,

  define: (params: DriverDefinition): DriverHandle => {
    if (!params.execute && !params.implementations) {
      const stubs: Record<string, ExecuteFn> = {}
      for (const entry of params.implements ?? []) {
        const id = normalizeToolId(entry.tool)
        stubs[id] = (): never => {
          throw new Error(
            `stub: no execute body for '${id}' — ` +
              `use driverFromManifest({ manifest, execute }) for dispatch`,
          )
        }
      }
      return defineDriver({ ...params, execute: stubs })
    }
    return defineDriver(params)
  },

  parse: (source: string) => {
    const m = parseDriverManifest(source)
    const fm = m.frontmatter

    const def: DriverDefinition = {
      id: fm.id,
      name: fm.name,
      description: fm.description,
      kind: fm.kind,
      ...(fm.version !== undefined && { version: fm.version }),
      implements: fm.implements.map((entry) => ({
        tool: entry.tool,
        version: entry.version,
        ...(entry.schema_narrowing && {
          schemaNarrowing: {
            ...(entry.schema_narrowing.drop_inputs?.length && {
              dropInputs: entry.schema_narrowing.drop_inputs,
            }),
            ...(entry.schema_narrowing.drop_outputs?.length && {
              dropOutputs: entry.schema_narrowing.drop_outputs,
            }),
          },
        }),
        ...(entry.mapping && { mapping: entry.mapping }),
        ...(entry.cost_override !== undefined && {
          costOverride: entry.cost_override as DriverDefinition["costOverride"],
        }),
        ...(entry.timeout_override_ms !== undefined && {
          timeoutOverrideMs: entry.timeout_override_ms,
        }),
        ...(entry.retry_override !== undefined && {
          retryOverride: entry.retry_override as DriverDefinition["retryOverride"],
        }),
        ...(entry.metadata && { metadata: entry.metadata }),
      })),
      ...(fm.auth !== undefined && {
        auth: fm.auth as DriverDefinition["auth"],
      }),
      ...(fm.network && { network: fm.network }),
      ...(fm.region?.length && { region: fm.region }),
      ...(fm.policy_tags?.length && { policyTags: fm.policy_tags }),
      ...(fm.cost_override !== undefined && {
        costOverride: fm.cost_override as DriverDefinition["costOverride"],
      }),
      ...(fm.timeout_override_ms !== undefined && {
        timeoutOverrideMs: fm.timeout_override_ms,
      }),
      ...(fm.retry_override !== undefined && {
        retryOverride: fm.retry_override as DriverDefinition["retryOverride"],
      }),
      ...(fm.health_check !== undefined && {
        healthCheck: fm.health_check as DriverDefinition["healthCheck"],
      }),
      ...(fm.version_check !== undefined && {
        versionCheck: fm.version_check as DriverDefinition["versionCheck"],
      }),
      ...(fm.install?.length && {
        install: fm.install as DriverDefinition["install"],
      }),
      ...(fm.tags?.length && { tags: fm.tags }),
      ...(fm.metadata && { metadata: fm.metadata }),
    }

    return {
      frontmatter: def as unknown as Record<string, unknown>,
      body: m.body,
    }
  },

  toFrontmatter: (params: DriverDefinition): Record<string, unknown> => {
    const fm: Record<string, unknown> = {
      schema: "agentproto/driver/v1",
      id: params.id,
      name: params.name,
      description: params.description,
    }
    if (params.version !== undefined) fm.version = params.version
    fm.kind = params.kind
    fm.implements = (params.implements ?? []).map((entry) => {
      const e: Record<string, unknown> = {
        tool: entry.tool,
        version: entry.version,
      }
      if (entry.schemaNarrowing) {
        const sn: Record<string, unknown> = {}
        if (entry.schemaNarrowing.dropInputs?.length)
          sn.drop_inputs = [...entry.schemaNarrowing.dropInputs]
        if (entry.schemaNarrowing.dropOutputs?.length)
          sn.drop_outputs = [...entry.schemaNarrowing.dropOutputs]
        e.schema_narrowing = sn
      }
      if (entry.mapping) e.mapping = entry.mapping
      if (entry.costOverride) e.cost_override = entry.costOverride
      if (entry.timeoutOverrideMs !== undefined)
        e.timeout_override_ms = entry.timeoutOverrideMs
      if (entry.retryOverride) e.retry_override = entry.retryOverride
      if (entry.metadata) e.metadata = entry.metadata
      return e
    })
    if (params.auth) fm.auth = params.auth
    if (params.network) fm.network = params.network
    if (params.region?.length) fm.region = [...params.region]
    if (params.policyTags?.length) fm.policy_tags = [...params.policyTags]
    if (params.costOverride) fm.cost_override = params.costOverride
    if (params.timeoutOverrideMs !== undefined)
      fm.timeout_override_ms = params.timeoutOverrideMs
    if (params.retryOverride) fm.retry_override = params.retryOverride
    if (params.healthCheck) fm.health_check = params.healthCheck
    if (params.versionCheck) fm.version_check = params.versionCheck
    if (params.tags?.length) fm.tags = [...params.tags]
    if (params.metadata && Object.keys(params.metadata).length > 0)
      fm.metadata = { ...params.metadata }
    return fm
  },
}

export const driverVerbs = createVerbs(driverSpec)
