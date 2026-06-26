/**
 * @agentproto/harness — coding context types + rendering.
 *
 * Extract of the coder preset's `CoderContext` shape and its prompt renderer,
 * so both the harness and the supervisor can reference them without a circular
 * import through the harness file.
 */

import type { CoderContext } from "./types.js"

export type { CoderContext }

/**
 * Renders a `CoderContext` into an agent-facing instruction block.
 *
 * Produces a short markdown block with stack, conventions, and gate commands
 * the agent should verify before declaring a task done.
 */
export function renderCoderPrompt(ctx: CoderContext): string {
  const parts: string[] = ["## Coding context"]
  if (ctx.stack) parts.push(`**Stack:** ${ctx.stack}`)
  if (ctx.conventions) parts.push(`**Conventions:** ${ctx.conventions}`)
  if (ctx.gateCmds?.length) {
    parts.push(
      `**Gate:** ${ctx.gateCmds.map((c) => `\`${c}\``).join(" · ")}`,
    )
  }
  if (ctx.extra) parts.push(ctx.extra)
  return parts.join("\n")
}