/**
 * Shared helpers across CLI commands. Schema bundle loading +
 * common path resolution.
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { AipSchemaBundle } from "@agentproto/corpus"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Resolve the AgentProto specs root. When running from source (vitest,
 * pnpm dev), the specs live a few levels up alongside the TS packages.
 * When running from a published binary, the schemas are bundled next
 * to the CLI under `share/schemas/aip-XX/draft/`. We try both.
 */
function findSpecsRoot(): string {
  const candidates = [
    // source-tree: packages/corpus-cli/src/commands → up to projects/agentproto/agentproto/specs/resources
    path.resolve(__dirname, "../../../../../agentproto/specs/resources"),
    // dist-tree: packages/corpus-cli/dist → up to projects/agentproto/agentproto/specs/resources
    path.resolve(__dirname, "../../../../agentproto/specs/resources"),
    // global install: share/agentproto-specs/resources next to the bin
    path.resolve(__dirname, "../share/agentproto-specs/resources"),
  ]
  for (const c of candidates) {
    try {
      readFileSync(path.join(c, "aip-10", "draft", "KNOWLEDGE.schema.json"))
      return c
    } catch {
      // not this candidate
    }
  }
  throw new Error(
    "corpus-cli: could not locate AgentProto spec schemas. Re-install or set CORPUS_SPECS_ROOT."
  )
}

const SPECS_ROOT = process.env.CORPUS_SPECS_ROOT || findSpecsRoot()

function loadSchema(aip: number, doctype: string): unknown {
  return JSON.parse(
    readFileSync(
      path.join(SPECS_ROOT, `aip-${aip}`, "draft", `${doctype}.schema.json`),
      "utf8"
    )
  )
}

export function loadAipSchemaBundle(): AipSchemaBundle {
  return {
    schemas: {
      knowledge: loadSchema(10, "KNOWLEDGE"),
      collection: loadSchema(18, "COLLECTION"),
      playbook: loadSchema(12, "PLAYBOOK"),
      operator: loadSchema(9, "OPERATOR"),
      workflow: loadSchema(15, "WORKFLOW"),
      routine: loadSchema(41, "ROUTINE"),
    },
    externals: [loadSchema(16, "IO"), loadSchema(17, "RUNNER")],
  }
}

/**
 * Resolve the workspace path argument. Accepts an explicit path or
 * defaults to cwd. Returns absolute path.
 */
export function resolveWorkspacePath(arg: string | undefined): string {
  if (!arg) return process.cwd()
  return path.resolve(process.cwd(), arg)
}

export type ExitCode = 0 | 1 | 2

export function fail(msg: string, code: ExitCode = 1): ExitCode {
  process.stderr.write(`corpus: ${msg}\n`)
  return code
}
