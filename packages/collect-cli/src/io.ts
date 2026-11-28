export interface Io {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  env: Record<string, string | undefined>
  cwd: string
  /** Aborted when the user interrupts: running work stops cleanly and stays resumable. */
  signal?: AbortSignal
}

/** Exit codes: 0 success, 1 partial failure, 2 usage error, 3 store locked or unreadable. */
export type ExitCode = 0 | 1 | 2 | 3

/** Bad arguments or an invalid recipe. */
export class UsageError extends Error {
  readonly code = "USAGE"
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

export function out(io: Io, text: string): void {
  io.stdout.write(text.endsWith("\n") ? text : `${text}\n`)
}

export function err(io: Io, text: string): void {
  io.stderr.write(text.endsWith("\n") ? text : `${text}\n`)
}

/** Machine output: one JSON document on stdout. */
export function outJson(io: Io, value: unknown): void {
  out(io, JSON.stringify(value))
}

/** Plain text table with left-aligned columns. */
export function table(rows: string[][]): string {
  if (rows.length === 0) return ""
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)))
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd()).join("\n")
}
