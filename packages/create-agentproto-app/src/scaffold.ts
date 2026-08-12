/**
 * Core scaffold operation: validate the target directory, derive
 * id/name/slug, and copy `templates/<template>/` into it with token
 * substitution. Pure filesystem + no argv parsing / process I/O, so it's
 * directly unit-testable against a tmp dir.
 */

import { mkdir, readdir } from "node:fs/promises"
import { basename, resolve, join } from "node:path"
import { fileURLToPath } from "node:url"

import { copyTemplateDir } from "./template.js"
import type { TemplateTokens } from "./template.js"
import { slugify, titleCase } from "./slug.js"

// `../templates` relative to THIS module — resolves to the package root's
// `templates/` whether running from `src/` (vitest) or `dist/` (built bin),
// since both sit one level below the package root.
const TEMPLATES_ROOT = fileURLToPath(new URL("../templates", import.meta.url))

export type ScaffoldTemplate = "react-ts"

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
  return value === "react-ts"
}

export async function scaffoldApp(options: ScaffoldOptions): Promise<ScaffoldOutcome> {
  const templateArg = options.template ?? "react-ts"
  if (!isScaffoldTemplate(templateArg)) {
    return {
      ok: false,
      reason: "unknown-template",
      message: `unknown template '${templateArg}' (available: react-ts).`,
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
