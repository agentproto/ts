import { parseArgs } from "node:util"
import { UsageError } from "./io"

type OptionSpec = Record<string, { type: "boolean" | "string"; multiple?: boolean; short?: string }>

/** Options every command accepts. */
export const COMMON_OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  quiet: { type: "boolean", short: "q" },
} satisfies OptionSpec

export interface Parsed<O> {
  values: O
  positionals: string[]
}

/** Strict argument parsing: unknown flags and missing values are usage errors. */
type Values<S extends OptionSpec> = {
  [K in keyof S]?: S[K] extends { type: "boolean" } ? boolean : S[K] extends { multiple: true } ? string[] : string
}

export function parse<const S extends OptionSpec>(argv: string[], spec: S): Parsed<Values<S & typeof COMMON_OPTIONS>> {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: { ...COMMON_OPTIONS, ...spec }, allowPositionals: true, strict: true })
    return { values: values as never, positionals }
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e))
  }
}

export function positional(p: string[], name: string, count = 1): string[] {
  if (p.length < count) throw new UsageError(`missing argument <${name}>`)
  if (p.length > count) throw new UsageError(`unexpected argument "${p[count]}"`)
  return p
}

export function intOption(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new UsageError(`--${name} must be a positive integer, got "${value}"`)
  return Number(value)
}
