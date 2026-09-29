/**
 * Validation + defaulting for the APP.md placement/requires/exposes/accepts
 * keys. Shared by `defineApp` (throws `AppDefinitionError`) and
 * `loadAppHandle` (throws `AppLoadError`) through the `fail` factory, so a
 * hand-edited APP.md and a bad `defineApp({...})` call get the same diagnostic.
 */

import type { AppAccepts, AppExposes, AppPlacement, AppRequirements } from "./types.js"

export const APP_PLACEMENTS: readonly AppPlacement[] = ["local", "box", "any", "split"]

export interface ManifestFieldsInput {
  readonly placement?: unknown
  readonly requires?: unknown
  readonly exposes?: unknown
  readonly accepts?: unknown
}

export interface DeclaredIds {
  readonly agents: readonly string[]
  readonly workflows: readonly string[]
}

export interface NormalizedManifestFields {
  readonly placement: AppPlacement
  /** Flat app-id list; undefined when `requires` was absent (or an object with no `apps`). */
  readonly requires: readonly string[] | undefined
  readonly requirements: AppRequirements
  readonly exposes: AppExposes
  readonly accepts: AppAccepts
}

type Fail = (message: string) => Error

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function stringList(v: unknown, key: string, fail: Fail): readonly string[] {
  if (v === undefined) return []
  if (!Array.isArray(v) || !v.every(e => typeof e === "string" && e.trim() !== "")) {
    throw fail(`'${key}' must be an array of non-empty strings.`)
  }
  return [...v] as string[]
}

function bool(v: unknown, key: string, fail: Fail): boolean {
  if (v === undefined) return false
  if (typeof v !== "boolean") throw fail(`'${key}' must be a boolean.`)
  return v
}

export function normalizeManifestFields(
  input: ManifestFieldsInput,
  declared: DeclaredIds,
  fail: Fail,
): NormalizedManifestFields {
  let placement: AppPlacement = "any"
  if (input.placement !== undefined) {
    if (typeof input.placement !== "string" || !APP_PLACEMENTS.includes(input.placement as AppPlacement)) {
      throw fail(
        `'placement' must be one of ${APP_PLACEMENTS.map(p => `"${p}"`).join(", ")}, got ${JSON.stringify(input.placement)}.`,
      )
    }
    placement = input.placement as AppPlacement
  }

  let requires: readonly string[] | undefined
  let requirements: AppRequirements = { browser: false, fs: false, gpu: false, secrets: [], apps: [] }
  const r = input.requires
  if (r !== undefined) {
    if (Array.isArray(r)) {
      if (!r.every(e => typeof e === "string")) {
        throw fail("'requires' must be an array of strings or an object { browser, fs, gpu, secrets, apps }.")
      }
      requires = [...r] as string[]
      requirements = { ...requirements, apps: requires }
    } else if (isRecord(r)) {
      const apps = stringList(r.apps, "requires.apps", fail)
      requirements = {
        browser: bool(r.browser, "requires.browser", fail),
        fs: bool(r.fs, "requires.fs", fail),
        gpu: bool(r.gpu, "requires.gpu", fail),
        secrets: stringList(r.secrets, "requires.secrets", fail),
        apps,
      }
      if (apps.length > 0) requires = apps
    } else {
      throw fail("'requires' must be an array of strings or an object { browser, fs, gpu, secrets, apps }.")
    }
  }

  let exposes: AppExposes = { agents: [], workflows: [] }
  if (input.exposes !== undefined) {
    if (!isRecord(input.exposes)) throw fail("'exposes' must be an object { agents, workflows }.")
    const agents = stringList(input.exposes.agents, "exposes.agents", fail)
    const workflows = stringList(input.exposes.workflows, "exposes.workflows", fail)
    for (const id of agents) {
      if (!declared.agents.includes(id)) {
        throw fail(
          `'exposes.agents' names '${id}' but the app declares no such agent. Declared: [${declared.agents.join(", ") || "none"}].`,
        )
      }
    }
    for (const id of workflows) {
      if (!declared.workflows.includes(id)) {
        throw fail(
          `'exposes.workflows' names '${id}' but the app declares no such workflow. Declared: [${declared.workflows.join(", ") || "none"}].`,
        )
      }
    }
    exposes = { agents, workflows }
  }

  let accepts: AppAccepts = { tasks: false }
  if (input.accepts !== undefined) {
    if (!isRecord(input.accepts)) throw fail("'accepts' must be an object { tasks }.")
    accepts = { tasks: bool(input.accepts.tasks, "accepts.tasks", fail) }
  }

  return { placement, requires, requirements, exposes, accepts }
}
