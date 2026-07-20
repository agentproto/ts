import { describe, expect, it, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({
  EventEmitter: class <T> {
    event = vi.fn()
    fire = vi.fn()
    dispose = vi.fn()
  },
  window: {
    createTerminal: vi.fn(),
    activeTerminal: undefined as unknown as import("vscode").Terminal | undefined,
    onDidCloseTerminal: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeActiveTerminal: vi.fn(() => ({ dispose: vi.fn() })),
    showInformationMessage: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn(),
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
  },
  ViewColumn: {
    Beside: -2,
    One: 1,
  },
  Disposable: class {
    constructor(public dispose: () => void = () => {}) {}
  },
}))

import * as vscode from "vscode"
import { registerTerminalSwitch, type TerminalSwitch } from "./terminalSwitch.js"
import type { SessionDescriptor } from "../client/types.js"
import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionStore } from "../services/sessionStore.js"

function session(over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "s1",
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "cmd",
    pid: 1,
    status: "running",
    startedAt: "2026-01-01T00:00:00Z",
    ...over,
  }
}

function createMocks() {
  const mockTerminal = {
    show: vi.fn(),
    dispose: vi.fn(),
  } as unknown as vscode.Terminal

  const createTerminal = vi.spyOn(vscode.window, "createTerminal").mockReturnValue(mockTerminal)
  const executeCommand = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined)
  const showInformationMessage = vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined)
  const subscriptions: vscode.Disposable[] = []

  const store = {
    focusOutput: vi.fn(() => ({ dispose: vi.fn() })),
  } as unknown as SessionStore

  const client = {
    url: "http://127.0.0.1:18790",
  } as unknown as DaemonClient

  const ctx = {
    subscriptions,
    extensionUri: { scheme: "file", path: "/ext" } as vscode.Uri,
    workspaceState: {
      get: vi.fn(),
      update: vi.fn(),
    },
  } as unknown as vscode.ExtensionContext

  return {
    mockTerminal,
    createTerminal,
    executeCommand,
    showInformationMessage,
    subscriptions,
    store,
    client,
    ctx,
  }
}

describe("registerTerminalSwitch", () => {
  let terminalSwitch: TerminalSwitch
  let mocks: ReturnType<typeof createMocks>

  beforeEach(() => {
    vi.clearAllMocks()
    mocks = createMocks()
    terminalSwitch = registerTerminalSwitch(mocks.ctx, mocks.client, mocks.store)
  })

  describe("WP1: open()", () => {
    it("creates a terminal in the editor area beside the current panel", () => {
      terminalSwitch.open(session())
      expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
      expect(mocks.createTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          location: { viewColumn: vscode.ViewColumn.Beside },
        }),
      )
    })

    it("reuses the existing terminal for the same session", () => {
      terminalSwitch.open(session())
      terminalSwitch.open(session())
      expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
      expect(mocks.mockTerminal.show).toHaveBeenCalled()
    })
  })

  describe("WP2: moveLocation()", () => {
    it("moves an editor-area terminal to the panel", async () => {
      terminalSwitch.open(session())
      Object.defineProperty(vscode.window, "activeTerminal", {
        value: mocks.mockTerminal,
        configurable: true,
      })

      await terminalSwitch.moveLocation()
      expect(mocks.executeCommand).toHaveBeenCalledWith("workbench.action.terminal.moveToPanel")
      expect(mocks.executeCommand).not.toHaveBeenCalledWith("workbench.action.terminal.moveToEditor")
    })

    it("moves a panel terminal back to the editor area", async () => {
      terminalSwitch.open(session())
      Object.defineProperty(vscode.window, "activeTerminal", {
        value: mocks.mockTerminal,
        configurable: true,
      })

      await terminalSwitch.moveLocation()
      vi.clearAllMocks()
      await terminalSwitch.moveLocation()
      expect(mocks.executeCommand).toHaveBeenCalledWith("workbench.action.terminal.moveToEditor")
      expect(mocks.executeCommand).not.toHaveBeenCalledWith("workbench.action.terminal.moveToPanel")
    })

    it("no-ops with a notice when the active terminal is not an agentproto terminal", async () => {
      const otherTerminal = { show: vi.fn() } as unknown as vscode.Terminal
      Object.defineProperty(vscode.window, "activeTerminal", {
        value: otherTerminal,
        configurable: true,
      })

      await terminalSwitch.moveLocation()
      expect(mocks.executeCommand).not.toHaveBeenCalled()
      expect(mocks.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining("not an agentproto terminal"),
      )
    })

    it("no-ops with a notice when there is no active terminal", async () => {
      Object.defineProperty(vscode.window, "activeTerminal", {
        value: undefined,
        configurable: true,
      })

      await terminalSwitch.moveLocation()
      expect(mocks.executeCommand).not.toHaveBeenCalled()
      expect(mocks.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("no active terminal"))
    })
  })
})
