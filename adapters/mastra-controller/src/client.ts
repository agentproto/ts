/**
 * `AgentCliClient` for a Mastra `AgentController`: SHAPE ONLY in this
 * release.
 *
 * E48 PR 2 fills this in: `connect()` reads the session's
 * `mastra.agent-controller/v1` manifest (see `./manifest.ts`), resolves its
 * host references, builds the controller and opens a session; `send()` /
 * `events()` drive a turn and map controller events through
 * `mapMastraEvent`; `setSessionMode()` switches between the manifest's
 * modes. Until then every call that needs a live controller throws
 * {@link NotImplementedYetError} instead of pretending to work.
 */

import type { AgentController } from "@mastra/core/agent-controller"
import type {
  AgentCliClient,
  AgentCliConnectOptions,
  AgentCliHandle,
  StreamEvent,
} from "@agentproto/harness"

/** What PR 2's client holds once connected; declared so the shape is fixed now. */
export interface MastraControllerSessionState {
  controller: AgentController
  /** Mode the session is in, one of the manifest's `modes[].id`. */
  modeId: string
}

export class NotImplementedYetError extends Error {
  constructor(operation: string) {
    super(
      `mastra-controller: ${operation}() is not implemented yet (E48 PR 2). ` +
        "This release ships the mastra.agent-controller/v1 manifest schema only; " +
        "it cannot run a live AgentController.",
    )
    this.name = "NotImplementedYetError"
  }
}

export function createAgentCliClient(_definition: AgentCliHandle): AgentCliClient {
  return {
    get sessionId(): string | undefined {
      return undefined
    },

    async connect(_opts: AgentCliConnectOptions): Promise<void> {
      throw new NotImplementedYetError("connect")
    },

    async send(_turnId: string, _message: unknown): Promise<void> {
      throw new NotImplementedYetError("send")
    },

    // eslint-disable-next-line require-yield
    async *events(): AsyncIterable<StreamEvent> {
      throw new NotImplementedYetError("events")
    },

    async cancel(_turnId: string): Promise<void> {
      throw new NotImplementedYetError("cancel")
    },

    async close(): Promise<void> {
      // Nothing was opened, so there is nothing to release.
    },
  }
}
