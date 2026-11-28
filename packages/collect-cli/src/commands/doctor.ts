import { type ExitCode, type Io, out, outJson, table } from "../io"
import { parse, positional } from "../args"
import { loadConnectors, loadRecipe, secretNameOf } from "../load"
import { CONNECTOR_OPTION } from "./connectors"

type Availability = { available: boolean; note?: string }

export async function runDoctor(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, { ...CONNECTOR_OPTION, source: { type: "string", multiple: true } })
  if (positionals.length > 1) positional(positionals, "recipe", 1)
  const modules = [...(values.connector ?? [])]
  let wanted = values.source ?? []
  if (positionals[0]) {
    const loaded = await loadRecipe(positionals[0], io.cwd)
    modules.push(...loaded.connectors)
    if (wanted.length === 0) wanted = [...new Set(loaded.recipe.sources.map((s) => s.connector))]
  }
  const { registry } = await loadConnectors(modules, io.cwd)
  const ids = wanted.length > 0 ? wanted : registry.list().map((c) => c.id)

  let unusable = 0
  const reports = ids.map((id) => {
    const c = registry.get(id)
    if (!c) {
      unusable++
      return { id, registered: false, usable: false, problems: [`connector "${id}" is not registered`] }
    }
    const secret = secretNameOf(c)
    const secretPresent = secret ? Boolean(io.env[secret]) : undefined
    const transports: Record<string, Availability> = {}
    for (const t of c.transports) {
      if (t === "http") transports[t] = { available: true }
      else if (t === "api") transports[t] = secret ? { available: Boolean(secretPresent), note: secretPresent ? undefined : `${secret} is not set` } : { available: false, note: "the connector declares no secret" }
      else transports[t] = { available: false, note: "not available in this version" }
    }
    const problems: string[] = []
    if (secret && !secretPresent) problems.push(`secret ${secret} is not set`)
    if (c.access.level === "session") problems.push(`needs a logged-in session on ${c.access.site} (browser transport not available in this version)`)
    const usable = problems.length === 0 && Object.values(transports).some((t) => t.available)
    if (!usable && problems.length === 0) problems.push("no usable transport")
    if (!usable) unusable++
    return { id, registered: true, version: c.version, access: c.access, secret, secretPresent, transports, usable, problems }
  })

  if (values.json) outJson(io, { connectors: reports, ok: unusable === 0 })
  else if (reports.length === 0) out(io, "no connectors to check")
  else {
    const rows = [["connector", "access", "secret", "transports", "usable"]]
    for (const r of reports) {
      if (!r.registered) {
        rows.push([r.id, "-", "-", "-", "no (not registered)"])
        continue
      }
      const t = Object.entries(r.transports!).map(([n, a]) => `${n}:${a.available ? "yes" : `no${a.note ? ` (${a.note})` : ""}`}`).join(" ")
      const secret = r.secret ? `${r.secret}: ${r.secretPresent ? "set" : "missing"}` : "-"
      rows.push([r.id, r.access!.level, secret, t, r.usable ? "yes" : "no"])
    }
    out(io, table(rows))
    for (const r of reports) for (const p of r.problems) out(io, `${r.id}: ${p}`)
  }
  return unusable > 0 ? 1 : 0
}
