import { adapterDeprecation } from "@agentproto/runtime"

/**
 * `--harness` is the canonical flag, `--adapter` its deprecated alias: it
 * still works and prints one dated deprecation line on stderr. Resolution is
 * `--harness ?? --adapter`. `command` names the verb in the stderr line
 * (e.g. "agentproto cron add").
 */
export function harnessFlag(
  values: { harness?: unknown; adapter?: unknown },
  command: string,
  stderr: Pick<NodeJS.WriteStream, "write"> = process.stderr,
): string | undefined {
  const harness = typeof values.harness === "string" && values.harness.length > 0 ? values.harness : undefined
  const adapter = typeof values.adapter === "string" && values.adapter.length > 0 ? values.adapter : undefined
  if (adapter !== undefined) warnAdapterFlag(command, stderr)
  return harness ?? adapter
}

/** Same as {@link harnessFlag} for a repeatable flag (`multiple: true`). */
export function harnessFlags(
  values: { harness?: unknown; adapter?: unknown },
  command: string,
  stderr: Pick<NodeJS.WriteStream, "write"> = process.stderr,
): string[] {
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.length > 0)
      : typeof v === "string" && v.length > 0 ? [v] : []
  const harnesses = list(values.harness)
  const adapters = list(values.adapter)
  if (adapters.length > 0) warnAdapterFlag(command, stderr)
  return [...harnesses, ...adapters]
}

/** The stderr deprecation line for a `--adapter` flag. */
export function warnAdapterFlag(command: string, stderr: Pick<NodeJS.WriteStream, "write"> = process.stderr): void {
  stderr.write(`${command}: ${adapterDeprecation("--adapter", "--harness")}\n`)
}
