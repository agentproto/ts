/**
 * Provider body for the `governance.record-audit-event` TOOL contract.
 * Bound via `implementTool` — typed input/context flow from the
 * contract handle.
 */

import { defineRef } from "@agentproto/ref"
import { ToolError } from "@agentproto/tool"
import { implementTool } from "@agentproto/driver"

import { recordAuditEvent } from "../../audit-chain.js"
import { recordAuditEventTool } from "../../tools/record-audit-event.tool.js"
import { parseLegacyIdentity } from "../helpers.js"

export const recordAuditEventBuiltin = implementTool(
  recordAuditEventTool,
  async ({ input, context }) => {
    if (!context?.governanceConfig) {
      throw new ToolError({
        code: "input_invalid",
        message: "context.governanceConfig is required",
        cause: { field: "context" },
      })
    }

    let actorId: string | null = null
    if (input.actor !== null) {
      actorId = parseLegacyIdentity(input.actor, "actor")
    }
    try {
      defineRef(input.entity)
    } catch (err) {
      throw new ToolError({
        code: "input_invalid",
        message: `entity: ${(err as Error).message}`,
        cause: err,
      })
    }

    const result = await recordAuditEvent(context.governanceConfig, {
      ...(input.scopeDir !== undefined ? { scopeDir: input.scopeDir } : {}),
      actorKind: input.actorKind,
      actorId,
      entityType: input.entityType,
      entityId: input.entity,
      action: input.action,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      ...(input.idempotencyKey !== undefined
        ? { idempotencyKey: input.idempotencyKey }
        : {}),
    })

    return {
      logPath: result.logPath,
      lineIndex: result.lineIndex,
      anchored: result.anchored,
      signature: result.event.signature,
    }
  }
)
