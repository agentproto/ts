/**
 * makePlaybookOverlayProcessor — portable Mastra InputProcessor factory.
 *
 * Parameterized on a `CorpusHost` and request-context extractors so it
 * can run in any Mastra app without assuming Guilde's request context
 * shape. Guilde's `guildePlaybookOverlayProcessor` can become a thin
 * wrapper: call this factory with extractors that read from
 * `asGuildeRequestContext`.
 *
 * Before each agent turn it:
 *   1. Extracts scopeId + dimensions from the request context.
 *   2. Fetches the PlaybookRegistry for the scope via the host.
 *   3. Resolves active (and deterministically-sampled shadow) overlays
 *      via OperatorOverlayResolver.
 *   4. Prepends them as a system note. Best-effort: any failure skips
 *      injection rather than failing the turn.
 */

import type { InputProcessor, ProcessInputArgs, ProcessInputResult } from "@mastra/core/processors"
import type { MastraDBMessage } from "@mastra/core/agent/message-list"
import { OperatorOverlayResolver, renderOverlays } from "@agentproto/corpus"
import type { CorpusHost, Dimensions } from "@agentproto/corpus"

function systemNote(text: string, id: string): MastraDBMessage {
  return {
    id,
    role: "system",
    createdAt: new Date(),
    content: { format: 2, parts: [{ type: "text", text }], content: text },
  }
}

export interface PlaybookOverlayProcessorOptions {
  /** The corpus host that owns per-scope FsPorts and the StackResolver. */
  readonly host: CorpusHost
  /**
   * Extract a stable scope ID (e.g. guild id, workspace id) from the
   * Mastra request context. Return `undefined` to skip injection for
   * this request.
   */
  readonly getScopeId: (requestContext: unknown) => string | undefined
  /**
   * Extract the operator's dimension bag (identity/role/position/capability
   * + any host-registered axes) from the request context. Used for
   * selector matching. Optional — falls back to operatorSlug-only matching.
   */
  readonly getDimensions?: (requestContext: unknown) => Dimensions | undefined
  /**
   * Extract the operator slug for the resolver's `operatorSlug` field.
   * The slug is used as a fallback when `getDimensions` is absent or
   * returns nothing.
   */
  readonly getOperatorSlug?: (requestContext: unknown) => string | undefined
  /**
   * Extract a stable conversation id for deterministic shadow-traffic
   * sampling. Optional — without it shadow playbooks never fire.
   */
  readonly getConversationId?: (requestContext: unknown) => string | undefined
}

/**
 * Factory that creates a Mastra `InputProcessor` for AIP-12 playbook
 * overlay injection. Wire this into `new Agent({ inputProcessors: [...] })`
 * or add it via Mastra's agent-level processor registry.
 */
export function makePlaybookOverlayProcessor(
  opts: PlaybookOverlayProcessorOptions
): InputProcessor {
  return {
    id: "playbook-overlay",
    name: "PlaybookOverlay",
    description:
      "Splices active AIP-12 playbook overlays bound to the running operator into the prompt as a system note",

    async processInput(args: ProcessInputArgs): Promise<ProcessInputResult> {
      const { requestContext } = args
      const scopeId = opts.getScopeId(requestContext)
      if (!scopeId) return args.messages

      const dimensions = opts.getDimensions?.(requestContext)
      const operatorSlug = opts.getOperatorSlug?.(requestContext) ?? ""
      const conversationId = opts.getConversationId?.(requestContext)

      // If we have no slug and no dimensions, nothing to match against.
      if (!operatorSlug && !dimensions) return args.messages

      try {
        const registry = await opts.host.getPlaybookRegistry(scopeId)
        const result = new OperatorOverlayResolver(registry).resolve({
          operatorSlug,
          ...(dimensions ? { dimensions } : {}),
          ...(conversationId ? { conversationId } : {}),
        })
        const { appendBlock } = renderOverlays(result)
        if (!appendBlock) return args.messages

        const note =
          "Operating playbooks in effect (active SOPs — follow them; " +
          "they override your defaults where they conflict):\n\n" +
          appendBlock
        return [systemNote(note, `playbook-overlay-${Date.now()}`), ...args.messages]
      } catch (error) {
        console.warn(
          "[playbook-overlay] resolve failed; skipping injection:",
          error instanceof Error ? error.message : error
        )
        return args.messages
      }
    },
  }
}
