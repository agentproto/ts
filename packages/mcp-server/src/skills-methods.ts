/**
 * Native MCP Skills methods (extension `io.modelcontextprotocol/skills`, beta).
 *
 * Two native JSON-RPC methods, `skills/list` and `skills/get`, plus a
 * `skill://{name}/{+path}` resource template so files are read through the
 * ordinary `resources/read`. The extension requires the `resources` capability,
 * which registering the template announces.
 *
 * This module owns only the TRANSPORT mechanism. The catalog (what is served,
 * manifests, digests, path confinement) lives in `@agentproto/runtime` and is
 * injected: the transport package must not depend on runtime.
 *
 * The extension is announced under `capabilities.extensions`. `directoryRead`
 * is not declared: `resources/directory/read` is not implemented.
 */

import { z } from "zod"
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js"

/** Extension identifier, as it appears under `capabilities.extensions`. */
export const MCP_SKILLS_EXTENSION = "io.modelcontextprotocol/skills"

/** URI template of a skill file. The first segment is the skill name, never a display alias. */
export const SKILL_URI_TEMPLATE = "skill://{name}/{+path}"

const LooseParams = z.object({}).loose()

export const SkillsListRequestSchema = z.object({
  method: z.literal("skills/list"),
  params: LooseParams.optional(),
})

export const SkillsGetRequestSchema = z.object({
  method: z.literal("skills/get"),
  params: LooseParams.optional(),
})

/** One file read through `resources/read`: text, or base64 for a binary file. */
export type SkillFileContent =
  | { uri: string; mimeType: string; text: string }
  | { uri: string; mimeType: string; blob: string }

export interface SkillsMethodsHandlers {
  list(params: Record<string, unknown>): Promise<Record<string, unknown>>
  get(params: Record<string, unknown>): Promise<Record<string, unknown>>
  /** Read one `skill://` file. Throws an `McpError` (-32602) for a path that is not served. */
  read(uri: URL): Promise<SkillFileContent>
}

/**
 * Register the two native methods, the `skill://` template and the extension
 * declaration. Must be called before the server is connected to a transport.
 */
export function registerSkillsMethods(server: McpServer, handlers: SkillsMethodsHandlers): void {
  server.server.registerCapabilities({
    extensions: { [MCP_SKILLS_EXTENSION]: {} },
  } as unknown as ServerCapabilities)

  server.server.setRequestHandler(SkillsListRequestSchema, async (request) =>
    handlers.list((request.params ?? {}) as Record<string, unknown>),
  )
  server.server.setRequestHandler(SkillsGetRequestSchema, async (request) =>
    handlers.get((request.params ?? {}) as Record<string, unknown>),
  )

  server.registerResource(
    "skill-file",
    new ResourceTemplate(SKILL_URI_TEMPLATE, { list: undefined }),
    { description: "A file of a served skill (SKILL.md or any file listed in its manifest)." },
    async (uri) => ({ contents: [await handlers.read(uri)] }),
  )
}
