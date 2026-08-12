/**
 * `create-agentproto-app <dir> [--id ...] [--name ...] [--template react-ts] [--json]`
 *
 * Argv parsing + human/JSON reporting around the pure `scaffoldApp` op.
 */

import { parseArgs } from "node:util"
import { relative } from "node:path"

import { scaffoldApp } from "./scaffold.js"

const USAGE = `create-agentproto-app — scaffold an agentproto agent app

Usage:
  create-agentproto-app <dir> [--id <@scope/app-id>] [--name <display name>]
                              [--template react-ts] [--json]

<dir>:
  Target directory for the new app. Must not exist, or must be empty.

--id <@scope/app-id>:
  App id written to .agentproto/APP.md. Defaults to the target directory's
  slug (no scope).

--name <display name>:
  Human-readable app name. Defaults to a title-cased slug.

--template <name>:
  Scaffold template. Only "react-ts" is available today.

Scaffolds a Vite + TanStack Router + TanStack Query ui/ project alongside a
.agentproto/ shell (APP.md, one agent, one workflow). Next steps:
  cd <dir>
  pnpm install
  agentproto app dev .`

/** `create-agentproto-app <dir> [--id ...] [--name ...] [--template ...] [--json]`. */
export async function runCreateApp(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: false,
    options: {
      id: { type: "string" },
      name: { type: "string" },
      template: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  })

  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const dir = positionals[0]
  if (!dir) {
    process.stderr.write(`create-agentproto-app: <dir> is required.\n${USAGE}\n`)
    return 2
  }

  const outcome = await scaffoldApp({
    targetDir: dir,
    id: typeof values.id === "string" ? values.id : undefined,
    name: typeof values.name === "string" ? values.name : undefined,
    template: typeof values.template === "string" ? values.template : undefined,
  })

  if (!outcome.ok) {
    process.stderr.write(`create-agentproto-app: ${outcome.message}\n`)
    return 2
  }

  const { result } = outcome
  if (values.json) {
    process.stdout.write(
      JSON.stringify(
        {
          appDir: result.appDir,
          id: result.id,
          name: result.name,
          slug: result.slug,
          template: result.template,
          fileCount: result.fileCount,
        },
        null,
        2,
      ) + "\n",
    )
    return 0
  }

  const rel = relative(process.cwd(), result.appDir)
  process.stdout.write(
    `agentproto: scaffolded ${result.name} (${result.id}) -> ${result.appDir}\n` +
      `  ${result.fileCount} file(s) written from template '${result.template}'.\n\n` +
      `Next steps:\n` +
      `  cd ${rel.length > 0 ? rel : "."}\n` +
      `  pnpm install\n` +
      `  agentproto app dev .\n`,
  )
  return 0
}
