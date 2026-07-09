/**
 * Map an MCP `tools/call` result → pi's `AgentToolResult` shape.
 *
 * MCP returns `{ content: ContentBlock[], isError? }` where a block is text,
 * image, audio, resource_link, or embedded resource. Pi tool results carry text
 * (and image) content; to stay lossless-for-the-model without guessing pi's
 * image field names, we map text blocks directly and STRINGIFY every non-text
 * block into a text block (a documented limitation — see MCP-BRIDGE.md). An
 * `isError: true` result is surfaced as text the model can read and recover
 * from (MCP's tool-error convention), with `details.isError` set for logs.
 *
 * Input is `unknown` so we never depend on a specific `@modelcontextprotocol/sdk`
 * result type — guards narrow it, so the mapper is trivially unit-testable.
 */

import { isRecord, type PiTextContent, type PiToolResult } from "./types.js"

interface ExtractedBlock {
  isText: boolean
  text: string
}

function extractTextBlock(block: unknown): ExtractedBlock {
  if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
    return { isText: true, text: block.text }
  }
  // Non-text (image/audio/resource/…) or malformed → stringify for the model.
  return { isText: false, text: safeStringify(block) }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Convert an MCP call result into a pi tool result. `server`/`tool` are recorded
 * in `details` (and used in fallback messages).
 */
export function mapMcpResultToPiResult(
  result: unknown,
  server: string,
  tool: string,
): PiToolResult {
  const isError = isRecord(result) && result.isError === true
  const rawContent = isRecord(result) ? result.content : undefined
  const blocks = Array.isArray(rawContent) ? rawContent : []

  const content: PiTextContent[] = []
  for (const block of blocks) {
    const extracted = extractTextBlock(block)
    content.push({
      type: "text",
      text: extracted.isText ? extracted.text : `[non-text MCP content] ${extracted.text}`,
    })
  }

  if (content.length === 0) {
    content.push({
      type: "text",
      text: isError
        ? `MCP tool ${tool} on ${server} returned an error with no content.`
        : `MCP tool ${tool} on ${server} returned no content.`,
    })
  }

  if (isError) {
    const first = content[0]
    if (first) first.text = `MCP tool error (${server}/${tool}): ${first.text}`
  }

  return { content, details: { server, tool, isError } }
}
