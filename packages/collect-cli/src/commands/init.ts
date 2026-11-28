import { resolve } from "node:path"
import { initStore } from "@agentproto/collect/node"
import { type ExitCode, type Io, out, outJson } from "../io"
import { parse, positional } from "../args"

export async function runInit(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, {})
  const [path] = positional(positionals, "store")
  const root = resolve(io.cwd, path!)
  const store = await initStore(root)
  const schemaVersion = await store.schemaVersion()
  if (values.json) outJson(io, { store: root, schemaVersion })
  else out(io, `store ready at ${root} (schema version ${schemaVersion})`)
  return 0
}
