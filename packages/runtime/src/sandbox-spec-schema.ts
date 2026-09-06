/**
 * The canonical inline-sandbox-spec schema shared by every spawn surface —
 * the MCP `agent_start` tool (`agent-tools.ts`) and the HTTP
 * `POST /sessions/agent` mapper (`http-server.ts`). Extracted to this leaf
 * module so BOTH paths validate against the exact same object: a drift here
 * silently dropped `extraPorts`/`env` on the HTTP path (a box booted with no
 * ports and no secrets) while the MCP path forwarded them — the #1150
 * regression this module exists to prevent.
 */

import { z } from "zod"
import { SandboxSpecSchema } from "@agentproto/sandbox"

/** `SandboxSpecSchema` plus the PR3 reuse field — `{ provider, reuse: "<sandboxId>" }`
 *  reconnects to an existing box (via `SandboxProvider.connect`) instead of
 *  booting a fresh one. Built from the same shape (rather than `.extend()`)
 *  so it stays a plain `.strict()` object independent of that schema's own
 *  extend semantics. */
export const sandboxSpecWithReuseSchema = z
  .object({
    ...SandboxSpecSchema.shape,
    reuse: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Existing sandbox id (a prior session's `sandboxId`) to reconnect to instead of " +
          "booting a new box. Requires the provider to support reconnect (e.g. e2b); " +
          "omit to boot fresh (default)."
      ),
  })
  .strict()
