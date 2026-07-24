/**
 * `@agentproto/knowledge-engine/cli` — AIP-29 CLI surface projection for the
 * `kb_query` + `kb_ingest` contracts.
 *
 * A later adapter calls {@link defineKnowledgeEngineCliDriver} with the `bin`
 * (and per-tool argv templates) to obtain a conformant provider that serves
 * both tools by shelling out to a retrieval CLI. Projection wiring only — no
 * backend, no subprocess is spawned at import time. The concrete argv /
 * subcommand vocabulary (engine-specific) is supplied by the caller, keeping
 * this pure package idiom-free. Mirrors code-brain's `cli/index.ts`
 * (`packages/code-brain/src/cli/index.ts`).
 */

import { defineCliDriver, type CliDriverDefinition } from "@agentproto/driver-cli"
import type { DriverHandle } from "@agentproto/driver"
import { kbQueryTool } from "../tools/kb-query.tool.js"
import { kbIngestTool } from "../tools/kb-ingest.tool.js"

export interface KnowledgeEngineCliProjectionOptions {
  /** Binary on $PATH (or workspace-relative path) the backend exposes. */
  readonly bin: string
  /** Default argv prefix injected before the per-tool argv. */
  readonly binArgs?: readonly string[]
  /** argv template for `kb_query`. Backend-specific — supplied by the caller. */
  readonly queryArgv?: readonly string[]
  /** argv template for `kb_ingest`. Backend-specific — supplied by the caller. */
  readonly ingestArgv?: readonly string[]
  /** Output parsing convention. */
  readonly output?: CliDriverDefinition["output"]
  /** Provider id override. Default `knowledge-engine-cli`. */
  readonly id?: string
}

/**
 * Build an AIP-29 CLI provider for the knowledge-engine contracts. Thin
 * sugar over `defineCliDriver` that pins `implements` to the two contracts
 * this package owns.
 */
export function defineKnowledgeEngineCliDriver(
  options: KnowledgeEngineCliProjectionOptions,
): DriverHandle {
  return defineCliDriver({
    id: options.id ?? "knowledge-engine-cli",
    name: "Knowledge Engine (CLI projection)",
    description:
      "AIP-29 CLI projection of the kb_query / kb_ingest contracts — " +
      "dispatches the tools by shelling out to a retrieval binary supplied " +
      "by the caller.",
    version: "0.1.0",
    bin: options.bin,
    ...(options.binArgs !== undefined ? { binArgs: options.binArgs } : {}),
    ...(options.output !== undefined ? { output: options.output } : {}),
    implements: [
      {
        tool: kbQueryTool.id,
        version: kbQueryTool.version ?? "0.1.0",
        ...(options.queryArgv !== undefined
          ? { metadata: { cli: { argv: options.queryArgv } } }
          : {}),
      },
      {
        tool: kbIngestTool.id,
        version: kbIngestTool.version ?? "0.1.0",
        ...(options.ingestArgv !== undefined
          ? { metadata: { cli: { argv: options.ingestArgv } } }
          : {}),
      },
    ],
  })
}
