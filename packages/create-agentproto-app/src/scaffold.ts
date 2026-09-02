/**
 * Core scaffold operation: validate the target directory, derive
 * id/name/slug, and copy `templates/<template>/` into it with token
 * substitution. Pure filesystem + no argv parsing / process I/O, so it's
 * directly unit-testable against a tmp dir.
 */

import { mkdir, readdir } from "node:fs/promises"
import { createRequire } from "node:module"
import { basename, resolve, join } from "node:path"
import { fileURLToPath } from "node:url"

import { copyTemplateDir } from "./template.js"
import type { TemplateTokens } from "./template.js"
import { slugify, titleCase } from "./slug.js"

// `../templates` relative to THIS module — resolves to the package root's
// `templates/` whether running from `src/` (vitest) or `dist/` (built bin),
// since both sit one level below the package root.
const TEMPLATES_ROOT = fileURLToPath(new URL("../templates", import.meta.url))

const FALLBACK_APP_CLIENT_VERSION = "0.1.0"

function hasVersionField(value: unknown): value is { version: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).version === "string"
  )
}

/**
 * The scaffolder depends on `@agentproto/app-client` itself (see
 * `package.json`), so its installed `package.json` is always resolvable
 * next to this module — reading its `version` keeps the stamped
 * `ui/package.json` dependency in lockstep with whatever app-client this
 * scaffolder shipped with, with no manual bump. Falls back only if
 * resolution throws (e.g. a broken install).
 */
function resolveAppClientVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    const pkg: unknown = require("@agentproto/app-client/package.json")
    return hasVersionField(pkg) ? pkg.version : FALLBACK_APP_CLIENT_VERSION
  } catch {
    return FALLBACK_APP_CLIENT_VERSION
  }
}

export type ScaffoldTemplate = "react-ts" | "vanilla" | "book"

export interface ScaffoldOptions {
  readonly targetDir: string
  readonly id?: string
  readonly name?: string
  readonly template?: string
}

export interface ScaffoldResult {
  readonly appDir: string
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly template: ScaffoldTemplate
  readonly fileCount: number
}

export type ScaffoldFailureReason = "target-not-empty" | "unknown-template"

export interface ScaffoldFailure {
  readonly ok: false
  readonly reason: ScaffoldFailureReason
  readonly message: string
}

export interface ScaffoldSuccess {
  readonly ok: true
  readonly result: ScaffoldResult
}

export type ScaffoldOutcome = ScaffoldSuccess | ScaffoldFailure

function isScaffoldTemplate(value: string): value is ScaffoldTemplate {
  return value === "react-ts" || value === "vanilla" || value === "book"
}

export async function scaffoldApp(options: ScaffoldOptions): Promise<ScaffoldOutcome> {
  const templateArg = options.template ?? "react-ts"
  if (!isScaffoldTemplate(templateArg)) {
    return {
      ok: false,
      reason: "unknown-template",
      message: `unknown template '${templateArg}' (available: react-ts, vanilla, book).`,
    }
  }
  const template = templateArg

  const appDir = resolve(options.targetDir)
  if (await isNonEmptyDir(appDir)) {
    return {
      ok: false,
      reason: "target-not-empty",
      message: `${appDir} already exists and is not empty.`,
    }
  }

  const slug = slugify(basename(appDir))
  const id = options.id !== undefined && options.id.length > 0 ? options.id : slug
  const name = options.name !== undefined && options.name.length > 0 ? options.name : titleCase(slug)

  const tokens: TemplateTokens = {
    __APP_ID__: id,
    __APP_NAME__: name,
    __APP_SLUG__: slug,
    __APP_CLIENT_VERSION__: resolveAppClientVersion(),
  }

  await mkdir(appDir, { recursive: true })
  const templateDir = join(TEMPLATES_ROOT, template)
  const fileCount = await copyTemplateDir(templateDir, appDir, tokens)

  return {
    ok: true,
    result: { appDir, id, name, slug, template, fileCount },
  }
}

async function isNonEmptyDir(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir)
    return entries.length > 0
  } catch (err) {
    if (isEnoent(err)) return false
    throw err
  }
}

function isEnoent(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  return (err as Record<string, unknown>).code === "ENOENT"
}
