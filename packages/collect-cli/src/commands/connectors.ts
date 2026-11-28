import { type ExitCode, type Io, out, outJson, table } from "../io"
import { parse, positional } from "../args"
import { loadConnectors } from "../load"

export const CONNECTOR_OPTION = { connector: { type: "string", multiple: true } } as const

export async function runConnectors(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, CONNECTOR_OPTION)
  positional(positionals, "none", 0)
  const { registry } = await loadConnectors(values.connector ?? [], io.cwd)
  const list = registry.list().map((c) => ({
    id: c.id,
    version: c.version,
    transports: [...c.transports],
    access: c.access,
    capabilities: [...c.capabilities],
  }))
  if (values.json) {
    outJson(io, list)
    return 0
  }
  if (list.length === 0) {
    out(io, "no connectors registered (load one with --connector <module>)")
    return 0
  }
  const rows = [["id", "version", "transports", "access", "capabilities"]]
  for (const c of list) {
    const access = c.access.level === "key" ? `key (${c.access.secret})` : c.access.level === "session" ? `session (${c.access.site})` : "none"
    rows.push([c.id, c.version, c.transports.join(","), access, c.capabilities.join(",")])
  }
  out(io, table(rows))
  return 0
}
