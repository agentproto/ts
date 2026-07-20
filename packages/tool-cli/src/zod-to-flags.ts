import type { ZodRawShape, ZodType } from "zod"

export type CliFlagKind = "string" | "number" | "boolean" | "enum" | "json"

export interface CliFlag {
  /** Public spelling, without the `--` prefix. */
  flag: string
  /** Original object key returned in the parsed input. */
  key: string
  kind: CliFlagKind
  required: boolean
  repeatable: boolean
  choices?: readonly string[]
  description?: string
}

export type CliInputShape =
  | { kind: "object"; flags: readonly CliFlag[] }
  | { kind: "positional"; schema: ZodType | undefined }

type ZodDef = {
  type?: string
  innerType?: ZodType
  element?: ZodType
  entries?: Record<string, string>
}

function defOf(schema: ZodType): ZodDef {
  return (schema as unknown as { def?: ZodDef; _def?: ZodDef }).def
    ?? (schema as unknown as { _def?: ZodDef })._def
    ?? {}
}

function objectShape(schema: ZodType): ZodRawShape | undefined {
  const shape = (schema as unknown as { shape?: unknown }).shape
  return shape && typeof shape === "object" ? shape as ZodRawShape : undefined
}

function kebabCase(key: string): string {
  return key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)
}

/** Translate the useful Zod-object subset to a stable flag description. The
 * schema still performs the final validation, so unknown/refined fields are
 * represented as JSON rather than guessed at. */
export function zodToFlags(schema: ZodType | undefined): CliInputShape {
  if (!schema) return { kind: "positional", schema: undefined }
  const shape = objectShape(schema)
  if (!shape) return { kind: "positional", schema }

  const flags: CliFlag[] = []
  for (const [key, field] of Object.entries(shape)) {
    let current = field as ZodType
    let required = true
    let repeatable = false
    for (;;) {
      const def = defOf(current)
      if (def.type === "optional" || def.type === "nullable" || def.type === "default") {
        required = false
        if (!def.innerType) break
        current = def.innerType
        continue
      }
      if (def.type === "array") {
        repeatable = true
        current = def.element ?? current
      }
      break
    }

    const def = defOf(current)
    const kind: CliFlagKind = def.type === "string"
      ? "string"
      : def.type === "number" || def.type === "int"
        ? "number"
        : def.type === "boolean"
          ? "boolean"
          : def.type === "enum"
            ? "enum"
            : "json"
    const flag: CliFlag = {
      flag: kebabCase(key),
      key,
      kind,
      required,
      repeatable,
      ...(kind === "enum" && def.entries ? { choices: Object.keys(def.entries) } : {}),
      ...((field as ZodType & { description?: string }).description
        ? { description: (field as ZodType & { description?: string }).description }
        : {}),
    }
    flags.push(flag)
  }
  return { kind: "object", flags }
}

/** Parse argv against a contract schema. This intentionally only accepts a
 * narrow, shell-friendly grammar; Zod remains the source of truth for all
 * semantic validation in `runTool`. */
export function parseToolArgv(schema: ZodType | undefined, argv: readonly string[]): unknown {
  const projection = zodToFlags(schema)
  if (projection.kind === "positional") {
    if (argv.length === 0 && !schema) return {}
    if (argv.length !== 1 || argv[0]?.startsWith("--")) {
      throw new Error("expected exactly one JSON positional input")
    }
    return parseJson(argv[0]!, "input")
  }

  const byFlag = new Map(projection.flags.map(flag => [flag.flag, flag]))
  const input: Record<string, unknown> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith("--")) throw new Error(`unexpected positional argument '${token}'`)
    const negated = token.startsWith("--no-")
    const flagName = token.slice(negated ? 5 : 2)
    const flag = byFlag.get(flagName)
    if (!flag) throw new Error(`unknown flag '${token}'`)
    if (flag.kind === "boolean") {
      input[flag.key] = !negated
      continue
    }
    if (negated) throw new Error(`'${token}' is only valid for a boolean flag`)
    const raw = argv[index + 1]
    if (raw === undefined || raw.startsWith("--")) throw new Error(`flag '--${flag.flag}' requires a value`)
    index += 1
    const value = parseFlagValue(flag, raw)
    if (flag.repeatable) {
      const values = input[flag.key] as unknown[] | undefined
      input[flag.key] = [...(values ?? []), value]
    } else if (flag.key in input) {
      throw new Error(`flag '--${flag.flag}' may only be provided once`)
    } else {
      input[flag.key] = value
    }
  }
  return input
}

function parseFlagValue(flag: CliFlag, raw: string): unknown {
  if (flag.kind === "number") {
    const value = Number(raw)
    if (!Number.isFinite(value)) throw new Error(`'--${flag.flag}' expects a number`)
    return value
  }
  if (flag.kind === "enum") {
    if (!flag.choices?.includes(raw)) {
      throw new Error(`'--${flag.flag}' expects one of: ${flag.choices?.join(", ")}`)
    }
    return raw
  }
  if (flag.kind === "json") return parseJson(raw, `--${flag.flag}`)
  return raw
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`${label} expects valid JSON`)
  }
}
