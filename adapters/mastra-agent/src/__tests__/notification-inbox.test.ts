/**
 * WP-7 — the notification inbox against the REAL LibSQL notifications domain
 * (`store.getStore("notifications")`, same store class `makeAgentFactory`
 * shares between memory, controller storage, and the inbox tool): a
 * notification filed the way the signal provider files it (same shape +
 * dedupeKey) is listable, readable, and dismissable through
 * `createNotificationInboxTool`'s execute, and dedupeKey replay coalesces
 * instead of duplicating.
 */
import { createNotificationInboxTool } from "@mastra/core/notifications"
import type { NotificationRecord, NotificationsStorage } from "@mastra/core/notifications"
import { describe, expect, it } from "vitest"
import { buildSqliteStore } from "../memory.js"

async function makeInbox(): Promise<{
  storage: NotificationsStorage
  tool: ReturnType<typeof createNotificationInboxTool>
}> {
  const store = buildSqliteStore({ AGENTPROTO_MASTRA_MEMORY_DB: ":memory:" })
  await store.init()
  const storage = await store.getStore("notifications")
  if (!storage) throw new Error("LibSQL store has no notifications domain")
  return { storage, tool: createNotificationInboxTool({ storage }) }
}

/** The provider-shaped notification (see signal-provider.ts's notify calls). */
function daemonNotification(overrides: Partial<Parameters<NotificationsStorage["createNotification"]>[0]> = {}) {
  return {
    threadId: "thread-1",
    source: "agentproto-daemon",
    kind: "turn-end",
    priority: "medium" as const,
    summary: "Session sess-1 (builder): turn-end",
    payload: { seq: 7, kind: "turn-end" },
    dedupeKey: "agentproto-daemon:sess-1:7",
    ...overrides,
  }
}

function callTool(tool: { execute?: unknown }, input: unknown, context: unknown = {}): Promise<unknown> {
  return (tool.execute as (input: unknown, context: unknown) => Promise<unknown>)(input, context)
}

describe("notification inbox tool over LibSQL", () => {
  it("lists a filed notification, resolving threadId from the tool execution context", async () => {
    const { storage, tool } = await makeInbox()
    await storage.createNotification(daemonNotification())

    const result = (await callTool(
      tool,
      { action: "list" },
      { agent: { threadId: "thread-1" } },
    )) as { notifications: NotificationRecord[] }

    expect(result.notifications).toHaveLength(1)
    expect(result.notifications[0]).toMatchObject({
      source: "agentproto-daemon",
      kind: "turn-end",
      priority: "medium",
      status: "pending",
      summary: "Session sess-1 (builder): turn-end",
      dedupeKey: "agentproto-daemon:sess-1:7",
    })
  })

  it("read by id returns delivery accounting (no in-process agent → counted unavailable, not an error)", async () => {
    const { storage, tool } = await makeInbox()
    const record = await storage.createNotification(daemonNotification())

    const result = (await callTool(
      tool,
      { action: "read", id: record.id },
      { agent: { threadId: "thread-1" } },
    )) as Record<string, unknown>

    expect(result).toMatchObject({ delivered: 0, unavailable: 1, alreadyRead: 0 })
  })

  it("dismiss flips status; the default pending view no longer shows it", async () => {
    const { storage, tool } = await makeInbox()
    const record = await storage.createNotification(daemonNotification())
    const context = { agent: { threadId: "thread-1" } }

    const dismissed = (await callTool(tool, { action: "dismiss", id: record.id }, context)) as {
      notification: NotificationRecord
    }
    expect(dismissed.notification.status).toBe("dismissed")

    const pending = (await callTool(tool, { action: "list", status: "pending" }, context)) as {
      notifications: NotificationRecord[]
    }
    expect(pending.notifications).toHaveLength(0)
  })

  it("replaying the same dedupeKey coalesces into one record (what makes provider replay harmless)", async () => {
    const { storage, tool } = await makeInbox()
    await storage.createNotification(daemonNotification())
    await storage.createNotification(daemonNotification())

    const result = (await callTool(
      tool,
      { action: "list" },
      { agent: { threadId: "thread-1" } },
    )) as { notifications: NotificationRecord[] }

    expect(result.notifications).toHaveLength(1)
    expect(result.notifications[0]!.coalescedCount).toBe(2)
  })

  it("requires a threadId from somewhere — input override works, nothing at all fails clearly", async () => {
    const { storage, tool } = await makeInbox()
    await storage.createNotification(daemonNotification({ threadId: "other-thread" }))

    const viaInput = (await callTool(tool, { action: "list", threadId: "other-thread" })) as {
      notifications: NotificationRecord[]
    }
    expect(viaInput.notifications).toHaveLength(1)

    await expect(callTool(tool, { action: "list" })).rejects.toThrow(/requires a threadId/)
  })
})
