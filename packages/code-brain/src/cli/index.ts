/**
 * `@agentproto/code-brain/cli` — AIP-29 CLI surface projection for the
 * `ask_codebase` contract.
 *
 * A later adapter calls {@link defineCodeBrainCliDriver} with the `bin` (and
 * per-tool argv template) to obtain a conformant provider that serves
 * `ask_codebase` by shelling out to a code-intel CLI. Projection wiring only
 * — no backend, no subprocess is spawned at import time. The concrete argv /
 * subcommand vocabulary (which is backend-specific) is supplied by the
 * caller, keeping this pure package idiom-free.
 */

import { defineCliDriver, type CliDriverDefinition } from "@agentproto/driver-cli"
import type { DriverHandle } from "@agentproto/driver"
import { askCodebaseTool } from "../tools/ask-codebase.tool.js"

export interface CodeBrainCliProjectionOptions {
  /** Binary on $PATH (or workspace-relative path) the backend exposes. */
  readonly bin: string
  /** Default argv prefix injected before the per-tool argv. */
  readonly binArgs?: readonly string[]
  /**
   * argv template for `ask_codebase`, e.g. `["${input.mode}", "${input.symbol|optional}"]`.
   * Backend-specific — supplied by the caller so no CLI dialect lives here.
   */
  readonly argv?: readonly string[]
  /** Output parsing convention. */
  readonly output?: CliDriverDefinition["output"]
  /** Provider id override. Default `code-brain-cli`. */
  readonly id?: string
}

/**
 * Build an AIP-29 CLI provider for the `ask_codebase` contract. Thin sugar
 * over `defineCliDriver` that pins `implements` to the single contract this
 * package owns.
 */
export function defineCodeBrainCliDriver(
  options: CodeBrainCliProjectionOptions,
): DriverHandle {
  return defineCliDriver({
    id: options.id ?? "code-brain-cli",
    name: "Code Brain (CLI projection)",
    description:
      "AIP-29 CLI projection of the ask_codebase contract — dispatches the " +
      "tool by shelling out to a code-intel binary supplied by the caller.",
    version: "0.1.0",
    bin: options.bin,
    ...(options.binArgs !== undefined ? { binArgs: options.binArgs } : {}),
    ...(options.output !== undefined ? { output: options.output } : {}),
    implements: [
      {
        tool: askCodebaseTool.id,
        version: askCodebaseTool.version ?? "0.1.0",
        ...(options.argv !== undefined
          ? { metadata: { cli: { argv: options.argv } } }
          : {}),
      },
    ],
  })
}
