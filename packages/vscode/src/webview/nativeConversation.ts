/**
 * Native conversation bridge for PTY Claude/Hermes sessions.
 *
 * A terminal session that is actually attached to a native provider
 * conversation can be reloaded from the provider's own persistence and
 * projected into synthetic structured records. The transcript panel then
 * reuses its existing structured reducer instead of falling back to the raw
 * flattened stream.
 */

import type { SessionDescriptor, SessionEventRecord } from "../client/types.js"
import type { ExportedSession } from "../../../runtime/src/transcript-export.js"
import { CONVERSATION_STORES } from "../../../runtime/src/conversation-store.js"

const BINARY_TO_STORE_KEY: Record<string, string> = {
  claude: "claude-code",
  hermes: "hermes",
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/")
  return idx === -1 ? path : path.slice(idx + 1)
}

function knownStoreKey(desc: Pick<SessionDescriptor, "adapterSlug" | "argv">): string | undefined {
  const key = desc.adapterSlug ?? (desc.argv?.[0] ? BINARY_TO_STORE_KEY[basename(desc.argv[0])] : undefined)
  return key !== undefined && CONVERSATION_STORES[key] ? key : undefined
}

function parseResumeArgv(argv: SessionDescriptor["argv"]): string | undefined {
  if (!argv) return undefined
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "--resume" || argv[i] === "-r") return argv[i + 1]
  }
  return undefined
}

function deriveAttachmentMode(desc: Pick<SessionDescriptor, "kind" | "pty">): "native" | "acp" | undefined {
  if (desc.kind === "terminal" && desc.pty) return "native"
  if (desc.kind === "agent-cli") return "acp"
  return undefined
}

function toIso(ts: number | undefined, seq: number): string {
  if (typeof ts === "number" && Number.isFinite(ts)) return new Date(ts).toISOString()
  return new Date(seq * 1000).toISOString()
}

function parseResultText(text: string | undefined): unknown {
  if (text === undefined) return ""
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function projectNativeSession(session: ExportedSession, sessionId: string): SessionEventRecord[] {
  const records: SessionEventRecord[] = []
  let seq = 0
  let pendingToolCallIds: string[] = []

  const push = (record: Omit<SessionEventRecord, "seq" | "ts"> & { ts?: number }): void => {
    seq += 1
    records.push({
      ...record,
      seq,
      ts: toIso(record.ts, seq),
      sessionId,
    })
  }

  session.messages.forEach((message, messageIndex) => {
    if (message.role === "user") {
      pendingToolCallIds = []
      push({
        kind: "user-prompt",
        text: message.text ?? "",
        ts: message.ts,
      })
      return
    }

    if (message.role === "tool") {
      const toolCallId = pendingToolCallIds.shift()
      push({
        kind: "tool-result",
        ...(toolCallId ? { toolCallId } : {}),
        result: parseResultText(message.text),
        isError: Boolean(message.text?.startsWith("[error]")),
        ts: message.ts,
      })
      return
    }

    if (message.role !== "assistant") {
      if (message.text?.trim()) {
        push({
          kind: "text-delta",
          text: message.text.trim(),
          ts: message.ts,
        })
      }
      return
    }

    if (message.reasoning?.trim()) {
      push({
        kind: "thought",
        text: message.reasoning.trim(),
        ts: message.ts,
      })
    }

    if (message.text?.trim()) {
      push({
        kind: "text-delta",
        text: message.text.trim(),
        ts: message.ts,
      })
    }

    if (message.toolCalls?.length) {
      pendingToolCallIds = message.toolCalls.map((_call, toolIndex) => `native-${messageIndex}-${toolIndex}`)
      message.toolCalls.forEach((call, toolIndex) => {
        push({
          kind: "tool-call",
          toolCallId: pendingToolCallIds[toolIndex],
          toolName: call.name,
          arguments: parseResultText(call.args),
          ts: message.ts,
        })
      })
    }
  })

  if (session.meta && Object.keys(session.meta).length > 0) {
    const meta = session.meta
    const usage: Omit<SessionEventRecord, "seq" | "ts"> = {
      kind: "usage_snapshot",
      ...(meta.model ? { model: meta.model } : {}),
      ...(meta.costUsd !== undefined ? { costUsd: meta.costUsd } : {}),
      ...(meta.tokens?.input !== undefined ? { tokensIn: meta.tokens.input } : {}),
      ...(meta.tokens?.output !== undefined ? { tokensOut: meta.tokens.output } : {}),
      ...(meta.tokens?.contextSize !== undefined ? { contextSize: meta.tokens.contextSize } : {}),
      ...(meta.tokens?.contextUsed !== undefined ? { contextUsed: meta.tokens.contextUsed } : {}),
      ...(meta.source ? { source: meta.source } : {}),
    }
    if (Object.keys(usage).length > 1) {
      push({ ...usage, ts: session.meta.startedAt ? Date.parse(session.meta.startedAt) || undefined : undefined })
    }
  }

  return records
}

async function discoverNativeConversationId(desc: SessionDescriptor): Promise<string | undefined> {
  const storeKey = knownStoreKey(desc)
  if (!storeKey) return undefined
  const store = CONVERSATION_STORES[storeKey]
  if (!store || !desc.cwd) return undefined

  const attachmentMode = deriveAttachmentMode(desc)
  const candidates = await store.discover({
    cwd: desc.cwd,
    since: desc.startedAt,
    ...(desc.endedAt ? { until: desc.endedAt } : {}),
    ...(attachmentMode ? { attachmentMode } : {}),
  })
  return candidates.length === 1 ? candidates[0]!.conversationId : undefined
}

async function readNativeSession(desc: SessionDescriptor): Promise<ExportedSession | null> {
  if (desc.kind !== "terminal" || !desc.pty) return null
  const storeKey = knownStoreKey(desc)
  if (!storeKey) return null
  const store = CONVERSATION_STORES[storeKey]
  if (!store) return null

  const conversationId = desc.adapterSessionId ?? parseResumeArgv(desc.argv) ?? (await discoverNativeConversationId(desc))
  if (!conversationId) return null

  try {
    return await store.read(conversationId, desc.cwd)
  } catch {
    return null
  }
}

/** True when this descriptor looks like a terminal PTY attached to a
 *  native conversation store we know how to read. */
export function isNativeConversationSession(desc: Pick<SessionDescriptor, "kind" | "pty" | "adapterSlug" | "argv">): boolean {
  return desc.kind === "terminal" && desc.pty === true && knownStoreKey(desc) !== undefined
}

/**
 * Load the provider-native conversation for a PTY Claude/Hermes session and
 * project it into the shared structured record model.
 *
 * Returns `[]` when the session is not a known native conversation attachment
 * or when the native store cannot be resolved/read. That keeps the caller's
 * raw fallback path intact.
 */
export async function loadNativeConversation(session: SessionDescriptor): Promise<SessionEventRecord[]> {
  const native = await readNativeSession(session)
  if (!native) return []
  return projectNativeSession(native, session.id)
}
