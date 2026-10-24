/**
 * Validation + defaulting for the APP.md placement/requires/exposes/accepts
 * keys. Shared by `defineApp` (throws `AppDefinitionError`) and
 * `loadAppHandle` (throws `AppLoadError`) through the `fail` factory, so a
 * hand-edited APP.md and a bad `defineApp({...})` call get the same diagnostic.
 */

import type {
  AppAccepts,
  AppExposes,
  AppPlacement,
  AppRequirement,
  AppRequirements,
  AppService,
  AppSetupCheck,
  AppSetupOption,
  AppSetupPersist,
  AppSetupSkipIf,
  AppSetupStep,
  AppSetupVendorStep,
  AppSetupWhen,
} from "./types.js"
import { parseVersionRange } from "./version-range.js"

export const APP_PLACEMENTS: readonly AppPlacement[] = ["local", "box", "any", "split"]

export interface ManifestFieldsInput {
  readonly placement?: unknown
  readonly requires?: unknown
  readonly exposes?: unknown
  readonly accepts?: unknown
  readonly services?: unknown
  readonly setup?: unknown
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
  /** `setup[]` — AIP-53 post-install steps. undefined when absent. */
  readonly setup: readonly AppSetupStep[] | undefined
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
 *
 * Throws a PLAIN `Error` (no `fail`): the caller wraps it once with the
 * shared "invalid services declaration" phrase, so the message is composed
 * exactly once by the caller's `fail` factory.
 */
function serviceList(v: unknown, key: string): readonly AppService[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) {
    throw new Error(`'${key}' must be an array of { name, entry, port? } objects.`)
  }
  if (v.length < 1) {
    throw new Error(`'${key}' must declare at least one service.`)
  }
  const seen = new Set<string>()
  return v.map((entry, i) => {
    const path = `${key}[${i}]`
    if (!isRecord(entry)) {
      throw new Error(`'${path}' must be an object { name, entry, port? }.`)
    }
    const extra = Object.keys(entry).filter(
      k => k !== "name" && k !== "entry" && k !== "command" && k !== "args" && k !== "cwd" && k !== "port",
    )
    if (extra.length > 0) {
      throw new Error(`'${path}.${extra[0]}' is not a supported service field (expected name, entry, command, args, cwd, port).`)
    }
    const name = entry.name
    if (typeof name !== "string" || !SERVICE_NAME_RE.test(name)) {
      throw new Error(
        `'${path}.name' must be a kebab-case slug matching /^[a-z][a-z0-9-]*$/, got ${JSON.stringify(name)}.`,
      )
    }
    if (seen.has(name)) {
      throw new Error(`two services named '${name}' — service names must be unique.`)
    }
    seen.add(name)
    const hasEntry = entry.entry !== undefined
    const hasCommand = entry.command !== undefined
    if (hasEntry && hasCommand) {
      throw new Error(`'${path}' must declare exactly one of 'entry' (legacy shell string) / 'command' (structured argv).`)
    }
    if (!hasEntry && !hasCommand) {
      throw new Error(`'${path}' must declare exactly one of 'entry' (legacy shell string) / 'command' (structured argv).`)
    }
    const command = entry.entry
    if (hasEntry && (typeof command !== "string" || command.trim() === "")) {
      throw new Error(`'${path}.entry' must be a non-empty shell command string.`)
    }
    const structuredCommand = entry.command
    if (hasCommand && (typeof structuredCommand !== "string" || structuredCommand.trim() === "")) {
      throw new Error(`'${path}.command' must be a non-empty command string.`)
    }
    const args = entry.args
    if (args !== undefined) {
      if (
        !Array.isArray(args) ||
        args.length === 0 ||
        !args.every((a): a is string => typeof a === "string")
      ) {
        throw new Error(`'${path}.args' must be a non-empty array of strings.`)
      }
      if (hasEntry) {
        throw new Error(`'${path}.args' requires a structured 'command' — not valid alongside legacy 'entry'.`)
      }
    }
    const cwd = entry.cwd
    if (cwd !== undefined && (typeof cwd !== "string" || cwd.trim() === "")) {
      throw new Error(`'${path}.cwd' must be a non-empty directory path string.`)
    }
    const port = entry.port
    if (port !== undefined) {
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`'${path}.port' must be an integer between 1 and 65535.`)
      }
    }
    return hasCommand
      ? {
          name,
          command: structuredCommand as string,
          ...(args !== undefined ? { args } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          ...(port !== undefined ? { port } : {}),
        }
      : {
          name,
          entry: command as string,
          ...(cwd !== undefined ? { cwd } : {}),
          ...(port !== undefined ? { port } : {}),
        }
  })
}

/** `parseServiceList`'s return shape — accumulated services + a fail-fast
 *  (single-element) error list, mirroring the runtime install-time caller's
 *  expected `{ services, errors }` shape. */
export interface ServiceListResult {
  readonly services: readonly AppService[]
  readonly errors: readonly string[]
}

/**
 * Public, non-throwing wrapper around `serviceList` for callers outside the
 * `normalizeManifestFields` throw-based flow (e.g. the runtime's install-time
 * `services:` validation). `undefined` AND `null` are both the no-op case
 * (`serviceList` itself only treats `undefined` as absent); any validation
 * problem is caught and surfaced as the sole entry of `errors`, matching
 * `serviceList`'s fail-fast-on-first-bad-entry behavior.
 */
export function parseServiceList(raw: unknown, key = "services"): ServiceListResult {
  if (raw === undefined || raw === null) return { services: [], errors: [] }
  try {
    return { services: serviceList(raw, key) ?? [], errors: [] }
  } catch (err) {
    return { services: [], errors: [err instanceof Error ? err.message : String(err)] }
  }
}

const STEP_ID_RE = /^[a-z][a-z0-9-]*$/
const VENDOR_STEP_KIND_RE = /^x-[a-z0-9-]+$/
const SETUP_ENV_RE = /^[A-Z_][A-Z0-9_]*$/
const SETUP_PROMPT_TYPES = ["text", "select", "boolean", "secret"] as const
const SETUP_PAIRING_DISPLAYS = ["qr", "link", "code"] as const
const SETUP_CHECK_SEVERITIES = ["required", "warn"] as const
const SETUP_STEP_KINDS = new Set([
  "cmd",
  "prompt",
  "oauth",
  "external",
  "choice",
  "auth-profile",
  "pairing",
  "check",
])
const SETUP_COMMON_STEP_KEYS = new Set(["id", "kind", "title", "description", "optional", "when"])
/** Kind-specific keys, on top of {@link SETUP_COMMON_STEP_KEYS}
 *  (`additionalProperties: false` per kind in `$defs.setupStep`). */
const SETUP_KIND_KEYS: Readonly<Record<string, readonly string[]>> = {
  cmd: ["cmd", "skip_if", "persist"],
  prompt: ["type", "prompt", "default", "options", "skip_if", "persist"],
  choice: ["prompt", "options", "default", "persist"],
  "auth-profile": ["min", "harnesses"],
  pairing: ["channel", "display", "timeout_sec", "persist"],
  oauth: ["secret_slug"],
  external: ["url", "persist"],
  check: ["check", "severity"],
}

function setupWhen(raw: unknown, path: string, fail: Fail): AppSetupWhen {
  if (!isRecord(raw)) throw fail(`'${path}' must be an object { step, equals } or { step, done }.`)
  const extra = Object.keys(raw).filter(k => k !== "step" && k !== "equals" && k !== "done")
  if (extra.length > 0) {
    throw fail(`'${path}.${extra[0]}' is not a supported when field (expected step, equals, done).`)
  }
  const step = raw.step
  if (typeof step !== "string" || step.trim() === "") {
    throw fail(`'${path}.step' must be a non-empty step id.`)
  }
  const hasEquals = raw.equals !== undefined
  const hasDone = raw.done !== undefined
  if (hasEquals === hasDone) {
    throw fail(`'${path}' must declare exactly one of 'equals' / 'done'.`)
  }
  if (hasDone && typeof raw.done !== "boolean") {
    throw fail(`'${path}.done' must be a boolean.`)
  }
  return {
    step,
    ...(hasEquals ? { equals: raw.equals } : {}),
    ...(hasDone ? { done: raw.done as boolean } : {}),
  }
}

function setupSkipIf(raw: unknown, path: string, fail: Fail): AppSetupSkipIf {
  if (!isRecord(raw)) throw fail(`'${path}' must be an object { cmd, exit_code? }.`)
  const extra = Object.keys(raw).filter(k => k !== "cmd" && k !== "exit_code")
  if (extra.length > 0) {
    throw fail(`'${path}.${extra[0]}' is not a supported skip_if field (expected cmd, exit_code).`)
  }
  const cmd = raw.cmd
  if (typeof cmd !== "string" || cmd.trim() === "") {
    throw fail(`'${path}.cmd' must be a non-empty string.`)
  }
  const exitCode = raw.exit_code
  if (exitCode !== undefined && (typeof exitCode !== "number" || !Number.isInteger(exitCode))) {
    throw fail(`'${path}.exit_code' must be an integer.`)
  }
  return { cmd, ...(exitCode !== undefined ? { exit_code: exitCode } : {}) }
}

function setupPersist(raw: unknown, path: string, fail: Fail): AppSetupPersist {
  if (!isRecord(raw)) {
    throw fail(`'${path}' must be an object with exactly one of env, secret_slug, cmd, answer.`)
  }
  const extra = Object.keys(raw).filter(k => k !== "env" && k !== "secret_slug" && k !== "cmd" && k !== "answer")
  if (extra.length > 0) {
    throw fail(`'${path}.${extra[0]}' is not a supported persist slot (expected env, secret_slug, cmd, answer).`)
  }
  const env = raw.env
  if (env !== undefined && (typeof env !== "string" || !SETUP_ENV_RE.test(env))) {
    throw fail(`'${path}.env' must be a string matching /^[A-Z_][A-Z0-9_]*$/ (e.g. "MY_TOKEN").`)
  }
  const out: Record<string, string> = {}
  if (env !== undefined) out.env = env
  for (const slot of ["secret_slug", "cmd", "answer"] as const) {
    const v = raw[slot]
    if (v !== undefined) {
      if (typeof v !== "string" || v.trim() === "") {
        throw fail(`'${path}.${slot}' must be a non-empty string.`)
      }
      out[slot] = v
    }
  }
  return out as AppSetupPersist
}

function setupOption(raw: unknown, path: string, fail: Fail): AppSetupOption {
  if (!isRecord(raw)) throw fail(`'${path}' must be an object { value, label, description? }.`)
  const extra = Object.keys(raw).filter(k => k !== "value" && k !== "label" && k !== "description")
  if (extra.length > 0) {
    throw fail(`'${path}.${extra[0]}' is not a supported option field (expected value, label, description).`)
  }
  const value = raw.value
  if (typeof value !== "string" || value.trim() === "") {
    throw fail(`'${path}.value' must be a non-empty string.`)
  }
  const label = raw.label
  if (typeof label !== "string" || label.trim() === "") {
    throw fail(`'${path}.label' must be a non-empty string.`)
  }
  const description = raw.description
  if (description !== undefined && typeof description !== "string") {
    throw fail(`'${path}.description' must be a string.`)
  }
  return { value, label, ...(description !== undefined ? { description } : {}) }
}

function setupOptionList(
  raw: unknown,
  path: string,
  fail: Fail,
  minItems: number,
): readonly AppSetupOption[] {
  if (!Array.isArray(raw)) throw fail(`'${path}' must be an array of { value, label } objects.`)
  if (raw.length < minItems) {
    throw fail(`'${path}' must contain at least ${minItems} option${minItems === 1 ? "" : "s"}.`)
  }
  return raw.map((o, i) => setupOption(o, `${path}[${i}]`, fail))
}

function setupCheck(raw: unknown, path: string, fail: Fail): AppSetupCheck {
  if (!isRecord(raw)) throw fail(`'${path}' must be an object with exactly one of cmd / tool.`)
  const extra = Object.keys(raw).filter(k => k !== "cmd" && k !== "tool")
  if (extra.length > 0) {
    throw fail(`'${path}.${extra[0]}' is not a supported check field (expected cmd, tool).`)
  }
  const hasCmd = raw.cmd !== undefined
  const hasTool = raw.tool !== undefined
  if (hasCmd === hasTool) {
    throw fail(`'${path}' must declare exactly one of 'cmd' / 'tool'.`)
  }
  if (hasCmd) {
    const c = raw.cmd
    if (!isRecord(c)) throw fail(`'${path}.cmd' must be an object { run, exit_code? }.`)
    const cmdExtra = Object.keys(c).filter(k => k !== "run" && k !== "exit_code")
    if (cmdExtra.length > 0) {
      throw fail(`'${path}.cmd.${cmdExtra[0]}' is not a supported check.cmd field (expected run, exit_code).`)
    }
    const run = c.run
    if (typeof run !== "string" || run.trim() === "") {
      throw fail(`'${path}.cmd.run' must be a non-empty string.`)
    }
    const exitCode = c.exit_code
    if (exitCode !== undefined && (typeof exitCode !== "number" || !Number.isInteger(exitCode))) {
      throw fail(`'${path}.cmd.exit_code' must be an integer.`)
    }
    return { cmd: { run, ...(exitCode !== undefined ? { exit_code: exitCode } : {}) } }
  }
  const t = raw.tool
  if (!isRecord(t)) throw fail(`'${path}.tool' must be an object { id, args?, expect? }.`)
  const toolExtra = Object.keys(t).filter(k => k !== "id" && k !== "args" && k !== "expect")
  if (toolExtra.length > 0) {
    throw fail(`'${path}.tool.${toolExtra[0]}' is not a supported check.tool field (expected id, args, expect).`)
  }
  const id = t.id
  if (typeof id !== "string" || id.trim() === "") {
    throw fail(`'${path}.tool.id' must be a non-empty string.`)
  }
  for (const key of ["args", "expect"] as const) {
    const v = t[key]
    if (v !== undefined && !isRecord(v)) {
      throw fail(`'${path}.tool.${key}' must be an object.`)
    }
  }
  return {
    tool: {
      id,
      ...(isRecord(t.args) ? { args: t.args } : {}),
      ...(isRecord(t.expect) ? { expect: t.expect } : {}),
    },
  }
}

/**
 * Parse + validate the AIP-53 `setup[]` array's SHAPE: array-ness, one
 * record per step, the per-kind required/optional keys of
 * `$defs.setupStep` (`additionalProperties: false` everywhere but vendor
 * `x-*` steps), and the `when` / `skip_if` / `persist` / `options` /
 * `check` sub-shapes. The pipeline-wide RULE 10 checks — non-empty,
 * unique step ids, `when.step` naming an EARLIER step, exactly one
 * `persist` slot, `choice.default` among its options, no
 * `persist.answer` on `type: secret` — live in `defineApp`
 * (define-app.ts), which every authoring AND loading path re-runs.
 * Nothing here is ever executed: `cmd`/`check.cmd` are carried as plain
 * strings.
 */
function setupList(v: unknown, key: string, fail: Fail): readonly AppSetupStep[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) {
    throw fail(`'${key}' must be an array of setup step objects.`)
  }
  if (v.length < 1) {
    throw fail(`'${key}' must declare at least one step when present.`)
  }
  return v.map((entry, i) => setupStep(entry, `${key}[${i}]`, fail))
}

function setupStep(entry: unknown, path: string, fail: Fail): AppSetupStep {
  if (!isRecord(entry)) {
    throw fail(`'${path}' must be a setup step object.`)
  }
  const id = entry.id
  if (typeof id !== "string" || !STEP_ID_RE.test(id)) {
    throw fail(
      `'${path}.id' must be a kebab-case slug matching /^[a-z][a-z0-9-]*$/, got ${JSON.stringify(id)}.`,
    )
  }
  const kind = entry.kind
  if (typeof kind !== "string" || (!SETUP_STEP_KINDS.has(kind) && !VENDOR_STEP_KIND_RE.test(kind))) {
    throw fail(
      `'${path}.kind' must be one of ${[...SETUP_STEP_KINDS].map(k => `"${k}"`).join(", ")} or a vendor "x-*" kind, got ${JSON.stringify(kind)}.`,
    )
  }

  const common: {
    id: string
    title?: string
    description?: string
    optional?: boolean
    when?: AppSetupWhen
  } = { id }
  const title = entry.title
  if (title !== undefined && (typeof title !== "string" || title.trim() === "")) {
    throw fail(`'${path}.title' must be a non-empty string.`)
  }
  if (title !== undefined) common.title = title
  const description = entry.description
  if (description !== undefined && typeof description !== "string") {
    throw fail(`'${path}.description' must be a string.`)
  }
  if (description !== undefined) common.description = description
  const optional = entry.optional
  if (optional !== undefined && typeof optional !== "boolean") {
    throw fail(`'${path}.optional' must be a boolean.`)
  }
  if (optional !== undefined) common.optional = optional
  if (entry.when !== undefined) common.when = setupWhen(entry.when, `${path}.when`, fail)

  // Vendor `x-*` steps are the ONE open shape in APP.md — carried
  // verbatim, only `id`/`kind` validated here. A host that does not
  // implement the kind fails closed with `setup_unsupported_step`; that
  // is the SETUP ENGINE's job, never app-kit's (app-kit never runs a
  // step).
  if (!SETUP_STEP_KINDS.has(kind)) {
    return { ...entry, ...common, kind } as AppSetupVendorStep
  }

  const allowed = new Set([...SETUP_COMMON_STEP_KEYS, ...(SETUP_KIND_KEYS[kind] ?? [])])
  const extra = Object.keys(entry).filter(k => !allowed.has(k))
  if (extra.length > 0) {
    throw fail(`'${path}.${extra[0]}' is not a supported '${kind}' setup step field.`)
  }

  switch (kind) {
    case "cmd": {
      const cmd = entry.cmd
      if (typeof cmd !== "string" || cmd.trim() === "") {
        throw fail(`'${path}.cmd' must be a non-empty string.`)
      }
      return {
        ...common,
        kind,
        cmd,
        ...(entry.skip_if !== undefined ? { skip_if: setupSkipIf(entry.skip_if, `${path}.skip_if`, fail) } : {}),
        ...(entry.persist !== undefined ? { persist: setupPersist(entry.persist, `${path}.persist`, fail) } : {}),
      }
    }
    case "prompt": {
      const prompt = entry.prompt
      if (typeof prompt !== "string" || prompt.trim() === "") {
        throw fail(`'${path}.prompt' must be a non-empty string.`)
      }
      const type = entry.type
      if (type !== undefined && !(SETUP_PROMPT_TYPES as readonly unknown[]).includes(type)) {
        throw fail(
          `'${path}.type' must be one of ${SETUP_PROMPT_TYPES.map(t => `"${t}"`).join(", ")}, got ${JSON.stringify(type)}.`,
        )
      }
      return {
        ...common,
        kind,
        prompt,
        ...(type !== undefined ? { type: type as "text" | "select" | "boolean" | "secret" } : {}),
        // `default` is ANY JSON value (schema: `"default": {}`) — carried verbatim.
        ...("default" in entry ? { default: entry.default } : {}),
        ...(entry.options !== undefined
          ? { options: setupOptionList(entry.options, `${path}.options`, fail, 1) }
          : {}),
        ...(entry.skip_if !== undefined ? { skip_if: setupSkipIf(entry.skip_if, `${path}.skip_if`, fail) } : {}),
        ...(entry.persist !== undefined ? { persist: setupPersist(entry.persist, `${path}.persist`, fail) } : {}),
      }
    }
    case "choice": {
      for (const req of ["prompt", "options", "default"] as const) {
        if (entry[req] === undefined) {
          throw fail(`'${path}.${req}' is required on a 'choice' step.`)
        }
      }
      const prompt = entry.prompt
      if (typeof prompt !== "string" || prompt.trim() === "") {
        throw fail(`'${path}.prompt' must be a non-empty string.`)
      }
      const options = setupOptionList(entry.options, `${path}.options`, fail, 2)
      const def = entry.default
      if (typeof def !== "string" || def.trim() === "") {
        throw fail(`'${path}.default' must be a non-empty string (the 'value' of one option).`)
      }
      return {
        ...common,
        kind,
        prompt,
        options,
        default: def,
        ...(entry.persist !== undefined ? { persist: setupPersist(entry.persist, `${path}.persist`, fail) } : {}),
      }
    }
    case "auth-profile": {
      const min = entry.min
      if (min !== undefined && (typeof min !== "number" || !Number.isInteger(min) || min < 1)) {
        throw fail(`'${path}.min' must be an integer of at least 1.`)
      }
      const harnesses = entry.harnesses
      if (
        harnesses !== undefined &&
        (!Array.isArray(harnesses) || !harnesses.every(h => typeof h === "string" && h.trim() !== ""))
      ) {
        throw fail(`'${path}.harnesses' must be an array of non-empty strings.`)
      }
      return {
        ...common,
        kind,
        ...(min !== undefined ? { min } : {}),
        ...(harnesses !== undefined ? { harnesses: [...harnesses] as string[] } : {}),
      }
    }
    case "pairing": {
      for (const req of ["channel"] as const) {
        if (entry[req] === undefined) {
          throw fail(`'${path}.${req}' is required on a 'pairing' step.`)
        }
      }
      const channel = entry.channel
      if (typeof channel !== "string" || channel.trim() === "") {
        throw fail(`'${path}.channel' must be a non-empty string.`)
      }
      const display = entry.display
      if (display !== undefined && !(SETUP_PAIRING_DISPLAYS as readonly unknown[]).includes(display)) {
        throw fail(
          `'${path}.display' must be one of ${SETUP_PAIRING_DISPLAYS.map(d => `"${d}"`).join(", ")}, got ${JSON.stringify(display)}.`,
        )
      }
      const timeout = entry.timeout_sec
      if (timeout !== undefined && (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1)) {
        throw fail(`'${path}.timeout_sec' must be an integer of at least 1.`)
      }
      return {
        ...common,
        kind,
        channel,
        ...(display !== undefined ? { display: display as "qr" | "link" | "code" } : {}),
        ...(timeout !== undefined ? { timeout_sec: timeout } : {}),
        ...(entry.persist !== undefined ? { persist: setupPersist(entry.persist, `${path}.persist`, fail) } : {}),
      }
    }
    case "oauth": {
      const secretSlug = entry.secret_slug
      if (typeof secretSlug !== "string" || secretSlug.trim() === "") {
        throw fail(`'${path}.secret_slug' must be a non-empty string.`)
      }
      return { ...common, kind, secret_slug: secretSlug }
    }
    case "external": {
      const url = entry.url
      if (typeof url !== "string" || !url.startsWith("https://") || url.trim() === "") {
        throw fail(`'${path}.url' must be a non-empty 'https://' URL, got ${JSON.stringify(url)}.`)
      }
      return {
        ...common,
        kind,
        url,
        ...(entry.persist !== undefined ? { persist: setupPersist(entry.persist, `${path}.persist`, fail) } : {}),
      }
    }
    case "check": {
      if (entry.check === undefined) {
        throw fail(`'${path}.check' is required on a 'check' step.`)
      }
      const severity = entry.severity
      if (severity !== undefined && !(SETUP_CHECK_SEVERITIES as readonly unknown[]).includes(severity)) {
        throw fail(
          `'${path}.severity' must be one of ${SETUP_CHECK_SEVERITIES.map(s => `"${s}"`).join(", ")}, got ${JSON.stringify(severity)}.`,
        )
      }
      return {
        ...common,
        kind,
        check: setupCheck(entry.check, `${path}.check`, fail),
        ...(severity !== undefined ? { severity: severity as "required" | "warn" } : {}),
      }
    }
    default:
      throw fail(`'${path}.kind' ${JSON.stringify(kind)} is not implemented.`)
  }
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
    services = serviceList(input.services, "services")
  } catch (err) {
    // serviceList throws a plain Error, so the phrase is composed exactly
    // ONCE here by the shared `fail` factory (no double prefix).
    throw fail(
      `invalid services declaration — ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // `setup[]` shape validation (AIP-53): per-kind keys/types plus the
  // `when`/`skip_if`/`persist`/`options`/`check` sub-shapes. The
  // pipeline-wide rule-10 checks run in `defineApp` (define-app.ts),
  // which every authoring AND loading path re-runs.
  const setup = setupList(input.setup, "setup", fail)

  return { placement, requires, requirements, appRequirements, exposes, accepts, services, setup }
}
