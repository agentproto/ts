import type {
  AgentSideConnection,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk"
import type { AgentControllerEvent } from "@mastra/core/agent-controller"
import { describe, expect, it } from "vitest"
import {
  MastraAcpAgent,
  promptContent,
  type ControllerLike,
  type ControllerSessionLike,
  type PromptFile,
  type ThreadMessageLike,
} from "../acp-host.js"

/** Let the microtask queue (floating bridge promises, config relays) drain. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

/** Capture the `update` payloads the host pushes via sessionUpdate, and
 *  optionally script the client's answer to session/request_permission. */
function fakeConn(
  sink: unknown[],
  opts: {
    permissionRequests?: RequestPermissionRequest[]
    respondPermission?: (
      params: RequestPermissionRequest,
    ) => Promise<RequestPermissionResponse>
  } = {},
): AgentSideConnection {
  return {
    sessionUpdate: async (p: { update: unknown }) => {
      sink.push(p.update)
    },
    requestPermission: async (params: RequestPermissionRequest) => {
      opts.permissionRequests?.push(params)
      if (!opts.respondPermission) throw new Error("no permission handler scripted")
      return opts.respondPermission(params)
    },
  } as unknown as AgentSideConnection
}

/** A minimal assistant message for scripted `message_update` events. */
function assistantMessage(id: string, text: string) {
  return {
    id,
    role: "assistant",
    createdAt: new Date(0),
    content: { format: 2, parts: [{ type: "text", text }] },
  } as Extract<AgentControllerEvent, { type: "message_update" }>["message"]
}

interface ScriptedSession extends ControllerSessionLike {
  aborted: boolean
  sent: Array<{ content: string; files?: PromptFile[] }>
  steered: string[]
  approvals: Array<{ decision: string; toolCallId?: string }>
  resumes: Array<{ resumeData: unknown; toolCallId?: string }>
  modelSwitches: string[]
  modeSwitches: string[]
  modelId: string
  threadMessages: ThreadMessageLike[]
  /** Dispatch an event to every live subscriber (as the run engine does). */
  emit(event: AgentControllerEvent): void
}

/**
 * A controller session that replays a scripted event sequence to its
 * subscribers when `sendMessage` runs (as the real run engine does), then
 * lets `sendMessage` resolve — mirroring "resolves on agent_end". Individual
 * tests override members (sendMessage, steer, respondToToolApproval, …) to
 * script richer run shapes.
 */
function scriptedSession(events: AgentControllerEvent[] = []): ScriptedSession {
  const listeners = new Set<(event: AgentControllerEvent) => void | Promise<void>>()
  const session: ScriptedSession = {
    aborted: false,
    sent: [],
    steered: [],
    approvals: [],
    resumes: [],
    modelSwitches: [],
    modeSwitches: [],
    modelId: "",
    threadMessages: [],
    emit(event) {
      for (const listener of listeners) void listener(event)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async sendMessage(input) {
      session.sent.push(input)
      for (const event of events) session.emit(event)
    },
    async steer({ content }) {
      session.steered.push(content)
    },
    abort() {
      session.aborted = true
    },
    respondToToolApproval(input) {
      session.approvals.push(input)
    },
    async respondToToolSuspension(input) {
      session.resumes.push(input)
    },
    model: {
      get: () => session.modelId,
      switch: async ({ modelId }) => {
        session.modelId = modelId
        session.modelSwitches.push(modelId)
      },
    },
    mode: {
      switch: async ({ modeId }) => {
        session.modeSwitches.push(modeId)
      },
    },
    thread: {
      listMessages: async () => session.threadMessages,
    },
  }
  return session
}

function controllerOf(
  session: ControllerSessionLike,
  createSessionCalls: unknown[] = [],
): ControllerLike {
  return {
    init: async () => {},
    createSession: async (opts) => {
      createSessionCalls.push(opts)
      return session
    },
  }
}

describe("MastraAcpAgent — controller event relay", () => {
  it("forwards text deltas + tool_call + tool_call_update to the client", async () => {
    const updates: Array<Record<string, unknown>> = []
    const session = scriptedSession([
      { type: "agent_start" },
      { type: "message_update", message: assistantMessage("m1", "let me run that") },
      {
        type: "tool_start",
        toolCallId: "tc1",
        toolName: "run_command",
        args: { command: "ls" },
      },
      {
        type: "tool_end",
        toolCallId: "tc1",
        result: { stdout: "a\nb", exitCode: 0 },
        isError: false,
      },
      { type: "message_update", message: assistantMessage("m1", "let me run thatdone") },
      { type: "agent_end", reason: "complete" },
    ])
    const host = new MastraAcpAgent(fakeConn(updates), async () => ({
      controller: controllerOf(session),
    }))

    const { sessionId } = await host.newSession({} as never)
    const res = await host.prompt({
      sessionId,
      prompt: [{ type: "text", text: "list files" }],
    } as never)

    expect(res.stopReason).toBe("end_turn")
    expect(updates.map((u) => u.sessionUpdate)).toEqual([
      "agent_message_chunk",
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
    ])
    expect((updates[0]!.content as { text: string }).text).toBe("let me run that")
    expect(updates[1]).toMatchObject({
      toolCallId: "tc1",
      kind: "execute",
      status: "in_progress",
    })
    expect(updates[2]).toMatchObject({ toolCallId: "tc1", status: "completed" })
    expect((updates[3]!.content as { text: string }).text).toBe("done")
  })

  it("creates the controller session keyed to the ACP session (thread + scope)", async () => {
    const calls: unknown[] = []
    const session = scriptedSession([{ type: "agent_end", reason: "complete" }])
    const host = new MastraAcpAgent(fakeConn([]), async () => ({
      controller: controllerOf(session, calls),
    }))

    const { sessionId } = await host.newSession({} as never)
    await host.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] } as never)
    await host.prompt({ sessionId, prompt: [{ type: "text", text: "again" }] } as never)

    // One controller session per ACP session, created on the first prompt.
    expect(calls).toEqual([
      { resourceId: "mastra-agent", scope: sessionId, threadId: sessionId },
    ])
  })

  it("surfaces a run that ends in error as an error chunk + refusal", async () => {
    const updates: Array<Record<string, unknown>> = []
    const session = scriptedSession([
      { type: "error", error: new Error("model exploded") },
      { type: "agent_end", reason: "error" },
    ])
    const host = new MastraAcpAgent(fakeConn(updates), async () => ({
      controller: controllerOf(session),
    }))

    const { sessionId } = await host.newSession({} as never)
    const res = await host.prompt({
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never)

    expect(res.stopReason).toBe("refusal")
    expect(updates).toHaveLength(1)
    expect((updates[0]!.content as { text: string }).text).toContain(
      "[mastra-agent error] model exploded",
    )
  })

  it("surfaces a controller build failure as an error chunk + refusal", async () => {
    const updates: Array<Record<string, unknown>> = []
    const host = new MastraAcpAgent(fakeConn(updates), async () => {
      throw new Error("no API key")
    })

    const { sessionId } = await host.newSession({} as never)
    const res = await host.prompt({
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never)

    expect(res.stopReason).toBe("refusal")
    expect((updates[0]!.content as { text: string }).text).toContain(
      "[mastra-agent error] no API key",
    )
  })

  it("reports an aborted run as cancelled", async () => {
    const session = scriptedSession([
      { type: "message_update", message: assistantMessage("m1", "partial") },
      { type: "agent_end", reason: "aborted" },
    ])
    const host = new MastraAcpAgent(fakeConn([]), async () => ({
      controller: controllerOf(session),
    }))

    const { sessionId } = await host.newSession({} as never)
    const res = await host.prompt({
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never)
    expect(res.stopReason).toBe("cancelled")
  })

  it("cancel aborts the live controller session", async () => {
    const session = scriptedSession([{ type: "agent_end", reason: "complete" }])
    const host = new MastraAcpAgent(fakeConn([]), async () => ({
      controller: controllerOf(session),
    }))

    const { sessionId } = await host.newSession({} as never)
    await host.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] } as never)
    await host.cancel({ sessionId } as never)
    expect(session.aborted).toBe(true)
  })

  it("rejects prompts for unknown sessions", async () => {
    const host = new MastraAcpAgent(fakeConn([]), async () => ({
      controller: controllerOf(scriptedSession([])),
    }))
    await expect(
      host.prompt({ sessionId: "nope", prompt: [] } as never),
    ).rejects.toThrow(/unknown session/)
  })
})

describe("MastraAcpAgent — session/load (resume)", () => {
  it("advertises loadSession + multimodal prompt capabilities", async () => {
    const host = new MastraAcpAgent(fakeConn([]), async () => ({
      controller: controllerOf(scriptedSession()),
    }))
    const res = await host.initialize({} as never)
    expect(res.agentCapabilities?.loadSession).toBe(true)
    expect(res.agentCapabilities?.promptCapabilities).toEqual({
      image: true,
      audio: true,
      embeddedContext: true,
    })
  })

  it("reconnects the controller session on the loaded id and replays history", async () => {
    const updates: Array<Record<string, unknown>> = []
    const calls: unknown[] = []
    const session = scriptedSession([{ type: "agent_end", reason: "complete" }])
    session.threadMessages = [
      { role: "user", content: { parts: [{ type: "text", text: "hi" }] } },
      { role: "assistant", content: { parts: [{ type: "text", text: "hello" }] } },
      // Non-conversation roles and empty messages don't replay.
      { role: "system", content: { parts: [{ type: "text", text: "reminder" }] } },
      { role: "assistant", content: { parts: [] } },
    ]
    const host = new MastraAcpAgent(fakeConn(updates), async () => ({
      controller: controllerOf(session, calls),
    }))

    const res = await host.loadSession({
      sessionId: "sess-1",
      cwd: "/",
      mcpServers: [],
    } as never)

    expect(calls).toEqual([
      { resourceId: "mastra-agent", scope: "sess-1", threadId: "sess-1" },
    ])
    expect(updates).toEqual([
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "hi" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
    ])
    // The load reports the model config option up front.
    expect(res.configOptions?.[0]).toMatchObject({
      id: "model",
      type: "select",
      category: "model",
    })

    // A follow-up prompt reuses the reconnected controller session.
    await host.prompt({
      sessionId: "sess-1",
      prompt: [{ type: "text", text: "go on" }],
    } as never)
    expect(calls).toHaveLength(1)
    expect(session.sent).toEqual([{ content: "go on" }])
  })
})

describe("MastraAcpAgent — tool approval bridge", () => {
  /** Run one prompt whose run parks on a tool approval gate; the scripted
   *  client answers `respond`, and the run finishes once the host feeds a
   *  decision back (as the real engine does). */
  async function runApprovalTurn(respond: RequestPermissionResponse) {
    const permissionRequests: RequestPermissionRequest[] = []
    const session = scriptedSession()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    session.sendMessage = async () => {
      session.emit({
        type: "tool_approval_required",
        toolCallId: "tc1",
        toolName: "write_file",
        args: { path: "a.ts" },
      })
      await gate
      session.emit({ type: "agent_end", reason: "complete" })
    }
    session.respondToToolApproval = (input) => {
      session.approvals.push(input)
      release()
    }
    const host = new MastraAcpAgent(
      fakeConn([], { permissionRequests, respondPermission: async () => respond }),
      async () => ({ controller: controllerOf(session) }),
    )
    const { sessionId } = await host.newSession({} as never)
    const res = await host.prompt({
      sessionId,
      prompt: [{ type: "text", text: "write it" }],
    } as never)
    return { res, session, permissionRequests, sessionId }
  }

  it("requests permission with approve/always-category/decline options", async () => {
    const { res, session, permissionRequests, sessionId } = await runApprovalTurn({
      outcome: { outcome: "selected", optionId: "approve" },
    })
    expect(res.stopReason).toBe("end_turn")
    expect(session.approvals).toEqual([{ decision: "approve", toolCallId: "tc1" }])
    expect(permissionRequests).toHaveLength(1)
    expect(permissionRequests[0]).toMatchObject({
      sessionId,
      toolCall: {
        toolCallId: "tc1",
        kind: "edit",
        status: "pending",
        rawInput: { path: "a.ts" },
      },
    })
    expect(permissionRequests[0]!.options.map((o) => o.kind)).toEqual([
      "allow_once",
      "allow_always",
      "reject_once",
    ])
  })

  it("maps always-allow to always_allow_category", async () => {
    const { session } = await runApprovalTurn({
      outcome: { outcome: "selected", optionId: "always_allow_category" },
    })
    expect(session.approvals).toEqual([
      { decision: "always_allow_category", toolCallId: "tc1" },
    ])
  })

  it("maps a rejection to decline", async () => {
    const { session } = await runApprovalTurn({
      outcome: { outcome: "selected", optionId: "decline" },
    })
    expect(session.approvals).toEqual([{ decision: "decline", toolCallId: "tc1" }])
  })

  it("declines when the client cancels the permission request", async () => {
    const { session } = await runApprovalTurn({ outcome: { outcome: "cancelled" } })
    expect(session.approvals).toEqual([{ decision: "decline", toolCallId: "tc1" }])
  })
})

describe("MastraAcpAgent — suspended tool bridge", () => {
  /** Run one prompt whose run parks on a tool suspension. */
  async function runSuspensionTurn(opts: {
    respond: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>
    cancelSuspensionBeforeEnd?: boolean
  }) {
    const permissionRequests: RequestPermissionRequest[] = []
    const session = scriptedSession()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    session.sendMessage = async () => {
      session.emit({
        type: "tool_suspended",
        toolCallId: "tc9",
        toolName: "submit_plan",
        args: { plan: "do things" },
        suspendPayload: { plan: "do things" },
        resumeSchema: '{"type":"object"}',
      })
      if (opts.cancelSuspensionBeforeEnd) {
        session.emit({
          type: "tool_suspension_cancelled",
          toolCallId: "tc9",
          toolName: "submit_plan",
          reason: "aborted",
        })
        session.emit({ type: "agent_end", reason: "aborted" })
        return
      }
      await gate
      session.emit({ type: "agent_end", reason: "complete" })
    }
    session.respondToToolSuspension = async (input) => {
      session.resumes.push(input)
      release()
    }
    const host = new MastraAcpAgent(
      fakeConn([], { permissionRequests, respondPermission: opts.respond }),
      async () => ({ controller: controllerOf(session) }),
    )
    const { sessionId } = await host.newSession({} as never)
    const res = await host.prompt({
      sessionId,
      prompt: [{ type: "text", text: "plan it" }],
    } as never)
    return { res, session, permissionRequests }
  }

  it("surfaces the suspend payload and resumes with {approved:true} on Continue", async () => {
    const { session, permissionRequests } = await runSuspensionTurn({
      respond: async () => ({ outcome: { outcome: "selected", optionId: "approve" } }),
    })
    expect(permissionRequests[0]!.toolCall._meta).toEqual({
      "mastra-agent/suspendPayload": { plan: "do things" },
      "mastra-agent/resumeSchema": '{"type":"object"}',
    })
    expect(permissionRequests[0]!.options.map((o) => o.optionId)).toEqual([
      "approve",
      "decline",
    ])
    expect(session.resumes).toEqual([
      { resumeData: { approved: true }, toolCallId: "tc9" },
    ])
  })

  it("resumes with {approved:false} on Cancel", async () => {
    const { session } = await runSuspensionTurn({
      respond: async () => ({ outcome: { outcome: "selected", optionId: "decline" } }),
    })
    expect(session.resumes).toEqual([
      { resumeData: { approved: false }, toolCallId: "tc9" },
    ])
  })

  it("passes client-provided resumeData from the outcome _meta through", async () => {
    const { session } = await runSuspensionTurn({
      respond: async () => ({
        outcome: {
          outcome: "selected",
          optionId: "approve",
          _meta: { "mastra-agent/resumeData": { feedback: "ship it" } },
        },
      }),
    })
    expect(session.resumes).toEqual([
      { resumeData: { feedback: "ship it" }, toolCallId: "tc9" },
    ])
  })

  it("voids the permission answer once the suspension is cancelled", async () => {
    let respondLate!: (r: RequestPermissionResponse) => void
    const lateAnswer = new Promise<RequestPermissionResponse>((resolve) => {
      respondLate = resolve
    })
    const { res, session } = await runSuspensionTurn({
      respond: () => lateAnswer,
      cancelSuspensionBeforeEnd: true,
    })
    expect(res.stopReason).toBe("cancelled")
    // The client answers only after the suspension was cancelled — no resume.
    respondLate({ outcome: { outcome: "selected", optionId: "approve" } })
    await flush()
    expect(session.resumes).toEqual([])
  })
})

describe("MastraAcpAgent — prompt delivery semantics", () => {
  it("a mid-turn prompt steers (abort + send) and cancels the active turn", async () => {
    const session = scriptedSession()
    let releaseFirst!: () => void
    session.sendMessage = async (input) => {
      session.sent.push(input)
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
    }
    session.steer = async ({ content }) => {
      session.steered.push(content)
      // steer aborts the active run: the first sendMessage resolves…
      releaseFirst()
      // …and the new run ends cleanly.
      session.emit({ type: "agent_end", reason: "complete" })
    }
    const host = new MastraAcpAgent(fakeConn([]), async () => ({
      controller: controllerOf(session),
    }))

    const { sessionId } = await host.newSession({} as never)
    const first = host.prompt({
      sessionId,
      prompt: [{ type: "text", text: "one" }],
    } as never)
    await flush() // let the first prompt reach sendMessage
    const second = await host.prompt({
      sessionId,
      prompt: [{ type: "text", text: "two" }],
    } as never)

    expect(session.steered).toEqual(["two"])
    expect(second.stopReason).toBe("end_turn")
    expect((await first).stopReason).toBe("cancelled")
  })

  it("a mid-turn prompt with files falls back to abort + sendMessage", async () => {
    const session = scriptedSession()
    let firstCall = true
    let releaseFirst!: () => void
    session.sendMessage = async (input) => {
      session.sent.push(input)
      if (firstCall) {
        firstCall = false
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
        return
      }
      session.emit({ type: "agent_end", reason: "complete" })
    }
    session.abort = () => {
      session.aborted = true
      releaseFirst()
    }
    const host = new MastraAcpAgent(fakeConn([]), async () => ({
      controller: controllerOf(session),
    }))

    const { sessionId } = await host.newSession({} as never)
    const first = host.prompt({
      sessionId,
      prompt: [{ type: "text", text: "one" }],
    } as never)
    await flush()
    const second = await host.prompt({
      sessionId,
      prompt: [
        { type: "text", text: "look" },
        { type: "image", data: "QUJD", mimeType: "image/png" },
      ],
    } as never)

    expect(session.aborted).toBe(true)
    expect(session.steered).toEqual([])
    expect(session.sent[1]).toEqual({
      content: "look",
      files: [{ data: "QUJD", mediaType: "image/png" }],
    })
    expect(second.stopReason).toBe("end_turn")
    expect((await first).stopReason).toBe("cancelled")
  })
})

describe("MastraAcpAgent — multimodal prompts", () => {
  it("passes image/audio/resource blocks to sendMessage as files", async () => {
    const session = scriptedSession([{ type: "agent_end", reason: "complete" }])
    const host = new MastraAcpAgent(fakeConn([]), async () => ({
      controller: controllerOf(session),
    }))

    const { sessionId } = await host.newSession({} as never)
    await host.prompt({
      sessionId,
      prompt: [
        { type: "text", text: "describe " },
        { type: "image", data: "SU1H", mimeType: "image/png", uri: "file:///shots/a.png" },
        { type: "audio", data: "QVVE", mimeType: "audio/wav" },
        {
          type: "resource",
          resource: { uri: "file:///src/a.ts", text: "const a = 1", mimeType: "text/x-typescript" },
        },
        {
          type: "resource",
          resource: { uri: "file:///bin/blob.bin", blob: "QkxPQg==" },
        },
        { type: "text", text: "these" },
      ],
    } as never)

    expect(session.sent).toEqual([
      {
        content: "describe these",
        files: [
          { data: "SU1H", mediaType: "image/png", filename: "a.png" },
          { data: "QVVE", mediaType: "audio/wav" },
          { data: "const a = 1", mediaType: "text/x-typescript", filename: "a.ts" },
          { data: "QkxPQg==", mediaType: "application/octet-stream", filename: "blob.bin" },
        ],
      },
    ])
  })

  it("text-only prompts send exactly {content} — byte-identical to before", async () => {
    const session = scriptedSession([{ type: "agent_end", reason: "complete" }])
    const host = new MastraAcpAgent(fakeConn([]), async () => ({
      controller: controllerOf(session),
    }))

    const { sessionId } = await host.newSession({} as never)
    await host.prompt({
      sessionId,
      prompt: [{ type: "text", text: " hi there " }],
    } as never)

    expect(session.sent).toEqual([{ content: "hi there" }])
    expect(Object.keys(session.sent[0]!)).toEqual(["content"])
  })

  it("promptContent coerces embedded text resources to a text media type", () => {
    const { files } = promptContent({
      sessionId: "s",
      prompt: [
        {
          type: "resource",
          resource: { uri: "file:///x/notes", text: "plain", mimeType: "application/x-notes" },
        },
      ],
    } as never)
    expect(files).toEqual([
      { data: "plain", mediaType: "text/plain", filename: "notes" },
    ])
  })
})

describe("MastraAcpAgent — model + mode switching", () => {
  it("setSessionConfigOption('model') switches the live session model", async () => {
    const session = scriptedSession([{ type: "agent_end", reason: "complete" }])
    const host = new MastraAcpAgent(fakeConn([]), async () => ({
      controller: controllerOf(session),
    }))

    const { sessionId } = await host.newSession({} as never)
    await host.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] } as never)
    const res = await host.setSessionConfigOption({
      sessionId,
      configId: "model",
      value: "openai/gpt-5",
    } as never)

    expect(session.modelSwitches).toEqual(["openai/gpt-5"])
    expect(res.configOptions[0]).toMatchObject({
      id: "model",
      type: "select",
      category: "model",
      currentValue: "openai/gpt-5",
    })
  })

  it("applies a model chosen before the first prompt when the session is created", async () => {
    const session = scriptedSession([{ type: "agent_end", reason: "complete" }])
    const host = new MastraAcpAgent(fakeConn([]), async () => ({
      controller: controllerOf(session),
    }))

    const { sessionId } = await host.newSession({} as never)
    const res = await host.setSessionConfigOption({
      sessionId,
      configId: "model",
      value: "openrouter/deepseek/deepseek-v4-pro",
    } as never)
    // Reported as current even though the controller session doesn't exist yet.
    expect(res.configOptions[0]).toMatchObject({
      currentValue: "openrouter/deepseek/deepseek-v4-pro",
    })
    expect(session.modelSwitches).toEqual([])

    await host.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] } as never)
    expect(session.modelSwitches).toEqual(["openrouter/deepseek/deepseek-v4-pro"])
  })

  it("reports a free-form current model as an extra select option", async () => {
    const host = new MastraAcpAgent(fakeConn([]), async () => ({
      controller: controllerOf(scriptedSession()),
    }))
    const { sessionId } = await host.newSession({} as never)
    const res = await host.setSessionConfigOption({
      sessionId,
      configId: "model",
      value: "openrouter/custom/exotic-model",
    } as never)
    const option = res.configOptions[0] as { currentValue: string; options: Array<{ value: string }> }
    expect(option.currentValue).toBe("openrouter/custom/exotic-model")
    expect(option.options.map((o) => o.value)).toContain("openrouter/custom/exotic-model")
  })

  it("setSessionMode switches the controller session mode (pending until created)", async () => {
    const session = scriptedSession([{ type: "agent_end", reason: "complete" }])
    const host = new MastraAcpAgent(fakeConn([]), async () => ({
      controller: controllerOf(session),
    }))

    const { sessionId } = await host.newSession({} as never)
    await host.setSessionMode({ sessionId, modeId: "build" } as never)
    expect(session.modeSwitches).toEqual([])

    await host.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] } as never)
    expect(session.modeSwitches).toEqual(["build"])

    await host.setSessionMode({ sessionId, modeId: "review" } as never)
    expect(session.modeSwitches).toEqual(["build", "review"])
  })

  it("relays mode_changed / model_changed events as session updates", async () => {
    const updates: Array<Record<string, unknown>> = []
    const session = scriptedSession([{ type: "agent_end", reason: "complete" }])
    const host = new MastraAcpAgent(fakeConn(updates), async () => ({
      controller: controllerOf(session),
    }))

    const { sessionId } = await host.newSession({} as never)
    await host.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] } as never)
    updates.length = 0

    // Fired outside any prompt turn (e.g. an autonomous mode transition).
    session.emit({ type: "mode_changed", modeId: "build", previousModeId: "plan" })
    session.modelId = "openai/gpt-5"
    session.emit({ type: "model_changed", modelId: "openai/gpt-5" })
    await flush()

    expect(updates[0]).toEqual({
      sessionUpdate: "current_mode_update",
      currentModeId: "build",
    })
    expect(updates[1]).toMatchObject({ sessionUpdate: "config_option_update" })
    expect(
      (updates[1] as { configOptions: Array<{ currentValue: string }> }).configOptions[0],
    ).toMatchObject({ currentValue: "openai/gpt-5" })
  })
})
