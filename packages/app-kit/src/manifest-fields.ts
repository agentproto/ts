/**
 * Validation + defaulting for the APP.md placement/requires/exposes/accepts
 * keys. Shared by `defineApp` (throws `AppDefinitionError`) and
 * `loadAppHandle` (throws `AppLoadError`) through the `fail` factory, so a
 * hand-edited APP.md and a bad `defineApp({...})` call get the same diagnostic.
 */

import type { AppAccepts, AppExposes, AppPlacement, AppRequirement, AppRequirements, AppService } from "./types.js"
import { parseVersionRange } from "./version-range.js"

export const APP_PLACEMENTS: readonly AppPlacement[] = ["local", "box", "any", "split"]

export interface ManifestFieldsInput {
  readonly placement?: unknown
  readonly requires?: unknown
  readonly exposes?: unknown
  readonly accepts?: unknown
  readonly services?: unknown
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
  /** Every `requires.apps` entry in normalized object form (bare ids become
   *  `{ id }`); empty when no app dependency was declared. */
  readonly appRequirements: readonly AppRequirement[]
  readonly exposes: AppExposes
  readonly accepts: AppAccepts
  /** `services[]` — production hosting entries. undefined when absent. */
  readonly services: readonly AppService[] | undefined
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

/** Parse one `requires.apps` entry — a bare id or an
 *  `{ id, version?, workflows? }` object. Shared by the array element check
 *  and the object form's `apps` list so both accept exactly the same shape. */
function appRequirementEntry(entry: unknown, key: string, fail: Fail): AppRequirement {
  if (typeof entry === "string") {
    if (entry.trim() === "") throw fail(`'${key}' entries must be non-empty strings or objects.`)
    return { id: entry }
  }
  if (!isRecord(entry)) {
    throw fail(`'${key}' entries must be non-empty strings or objects, got ${JSON.stringify(entry)}.`)
  }
  const id = entry.id
  if (typeof id !== "string" || id.trim() === "") {
    throw fail(`'${key}.id' must be a non-empty string.`)
  }
  const version = entry.version
  if (version !== undefined) {
    if (typeof version !== "string" || version.trim() === "") {
      throw fail(`'${key}.version' must be a non-empty string.`)
    }
    try {
      parseVersionRange(version)
    } catch (err) {
      throw fail(`'${key}.version' ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const workflows = entry.workflows
  if (workflows !== undefined) {
    if (!Array.isArray(workflows) || !workflows.every(w => typeof w === "string" && w.trim() !== "")) {
      throw fail(`'${key}.workflows' must be an array of non-empty strings.`)
    }
  }
  const extra = Object.keys(entry).filter(k => k !== "id" && k !== "version" && k !== "workflows")
  if (extra.length > 0) {
    throw fail(`'${key}.${extra[0]}' is not a supported requires.apps entry field (expected id, version, workflows).`)
  }
  return {
    id,
    ...(version !== undefined ? { version } : {}),
    ...(workflows !== undefined ? { workflows: [...workflows] as string[] } : {}),
  }
}

function appRequirementList(v: unknown, key: string, fail: Fail): readonly AppRequirement[] {
  if (v === undefined) return []
  if (!Array.isArray(v)) {
    throw fail(`'${key}' must be an array of non-empty strings or { id, version?, workflows? } objects.`)
  }
  return v.map((e, i) => appRequirementEntry(e, `${key}[${i}]`, fail))
}

const SERVICE_NAME_RE = /^[a-z][a-z0-9-]*$/

/**
 * Parse + validate the AIP-53 `services` array (production hosting surface).
 * One entry = one supervised service process: `name` is a unique kebab-case
 * slug, `entry` a non-empty command line, `port` an optional 1..65535 integer
 * (omitted = a service that does not listen). app-kit NEVER executes `entry`
 * — that is the later install-time service-owner's job (see define-app.ts's
 * NOT-A-LAUNCHER note); this only carries the field through validate/freeze.
 */
function serviceList(v: unknown, key: string, fail: Fail): readonly AppService[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) {
    throw fail(`'${key}' must be an array of { name, entry, port? } objects.`)
  }
  if (v.length < 1) {
    throw fail(`'${key}' must declare at least one service.`)
  }
  const seen = new Set<string>()
  return v.map((entry, i) => {
    const path = `${key}[${i}]`
    if (!isRecord(entry)) {
      throw fail(`'${path}' must be an object { name, entry, port? }.`)
    }
    const extra = Object.keys(entry).filter(k => k !== "name" && k !== "entry" && k !== "port")
    if (extra.length > 0) {
      throw fail(`'${path}.${extra[0]}' is not a supported service field (expected name, entry, port).`)
    }
    const name = entry.name
    if (typeof name !== "string" || !SERVICE_NAME_RE.test(name)) {
      throw fail(
        `'${path}.name' must be a kebab-case slug matching /^[a-z][a-z0-9-]*$/, got ${JSON.stringify(name)}.`,
      )
    }
    if (seen.has(name)) {
      throw fail(`two services named '${name}' — service names must be unique.`)
    }
    seen.add(name)
    const command = entry.entry
    if (typeof command !== "string" || command.trim() === "") {
      throw fail(`'${path}.entry' must be a non-empty shell command string.`)
    }
    const port = entry.port
    if (port !== undefined) {
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw fail(`'${path}.port' must be an integer between 1 and 65535.`)
      }
    }
    return {
      name,
      entry: command,
      ...(port !== undefined ? { port } : {}),
    }
  })
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
  let appRequirements: readonly AppRequirement[] = []
  const r = input.requires
  if (r !== undefined) {
    if (Array.isArray(r)) {
      if (!r.every(e => typeof e === "string")) {
        throw fail("'requires' must be an array of strings or an object { browser, fs, gpu, secrets, apps }.")
      }
      requires = [...r] as string[]
      requirements = { ...requirements, apps: requires }
      appRequirements = appRequirementList(r, "requires", fail)
    } else if (isRecord(r)) {
      const apps = appRequirementList(r.apps, "requires.apps", fail)
      requirements = {
        browser: bool(r.browser, "requires.browser", fail),
        fs: bool(r.fs, "requires.fs", fail),
        gpu: bool(r.gpu, "requires.gpu", fail),
        secrets: stringList(r.secrets, "requires.secrets", fail),
        apps: apps.map(e => e.id),
      }
      appRequirements = apps
      if (apps.length > 0) requires = apps.map(e => e.id)
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

  // `services[]` validation is shared with the install-time launcher
  // (packages/runtime/src/app-tools.ts's parseAppServices), which reports an
  // "invalid services declaration" error. The loader is the FIRST validator
  // on the app_install path, so it carries the same phrase — a malformed
  // block fails the install with ONE recognizable message whichever gate
  // sees it first.
  let services: readonly AppService[] | undefined
  try {
    services = serviceList(input.services, "services", fail)
  } catch (err) {
    throw fail(
      `invalid services declaration — ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  return { placement, requires, requirements, appRequirements, exposes, accepts, services }
}
