import { describe, expect, it, vi, beforeEach, type MockInstance } from "vitest"

vi.mock("vscode", () => ({
  window: {
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn().mockResolvedValue(undefined),
  },
  ViewColumn: {
    One: 1,
  },
}))

import * as vscode from "vscode"
import { handleWebviewMessage } from "./transcriptPanel.js"
import type { TranscriptPanelController } from "./transcriptPanelController.js"
import type { OutputDocuments } from "../services/outputDocument.js"
import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor } from "../client/types.js"

function createPanel(): vscode.WebviewPanel {
  return {
    reveal: vi.fn(),
    webview: { postMessage: vi.fn() },
  } as unknown as vscode.WebviewPanel
}

function createController(sessionId = "s1"): TranscriptPanelController {
  return {
    session: { id: sessionId } as SessionDescriptor,
  } as unknown as TranscriptPanelController
}

describe("handleWebviewMessage", () => {
  let panel: vscode.WebviewPanel
  let controller: TranscriptPanelController
  let outputDocs: OutputDocuments
  let client: DaemonClient
  let executeCommand: MockInstance<(command: string, ...rest: unknown[]) => unknown>

  beforeEach(() => {
    vi.clearAllMocks()
    panel = createPanel()
    controller = createController("session-abc")
    outputDocs = {} as OutputDocuments
    client = {} as DaemonClient
    executeCommand = vi.spyOn(vscode.commands, "executeCommand") as MockInstance<
      (command: string, ...rest: unknown[]) => unknown
    >
  })

  it("WP3: openTerminal invokes agentproto.openTerminal with the controller's session id", async () => {
    await handleWebviewMessage(
      { type: "openTerminal" },
      panel,
      controller,
      outputDocs,
      client,
    )
    expect(executeCommand).toHaveBeenCalledWith("agentproto.openTerminal", "session-abc")
  })

  it("restartAsTerminal invokes agentproto.restartAsTerminal with the controller's session id", async () => {
    await handleWebviewMessage(
      { type: "restartAsTerminal" },
      panel,
      controller,
      outputDocs,
      client,
    )
    expect(executeCommand).toHaveBeenCalledWith("agentproto.restartAsTerminal", "session-abc")
  })

  it("changeEffort routes to the per-axis configureSessionAxis picker for effort (chip-pickers)", async () => {
    await handleWebviewMessage(
      { type: "changeEffort" },
      panel,
      controller,
      outputDocs,
      client,
    )
    expect(executeCommand).toHaveBeenCalledWith("agentproto.configureSessionAxis", {
      sessionId: "session-abc",
      axis: "effort",
    })
  })

  it("changeRoute routes to the per-axis configureSessionAxis picker for route (chip-pickers)", async () => {
    await handleWebviewMessage(
      { type: "changeRoute" },
      panel,
      controller,
      outputDocs,
      client,
    )
    expect(executeCommand).toHaveBeenCalledWith("agentproto.configureSessionAxis", {
      sessionId: "session-abc",
      axis: "route",
    })
  })

  it("changePosture routes to the per-axis configureSessionAxis picker for posture (chip-pickers)", async () => {
    await handleWebviewMessage(
      { type: "changePosture" },
      panel,
      controller,
      outputDocs,
      client,
    )
    expect(executeCommand).toHaveBeenCalledWith("agentproto.configureSessionAxis", {
      sessionId: "session-abc",
      axis: "posture",
    })
  })

  it("changeAccess routes to the per-axis configureSessionAxis picker for access/wallet (chip-pickers)", async () => {
    await handleWebviewMessage(
      { type: "changeAccess" },
      panel,
      controller,
      outputDocs,
      client,
    )
    expect(executeCommand).toHaveBeenCalledWith("agentproto.configureSessionAxis", {
      sessionId: "session-abc",
      axis: "access",
    })
  })

  it("WP3: setView conversation reveals the webview panel", async () => {
    controller.onSetView = vi.fn().mockResolvedValue(undefined)
    await handleWebviewMessage(
      { type: "setView", view: "conversation" },
      panel,
      controller,
      outputDocs,
      client,
    )
    expect(controller.onSetView).toHaveBeenCalledWith("conversation")
    expect(panel.reveal).toHaveBeenCalledWith(vscode.ViewColumn.One, false)
  })

  describe("resolveQuestion", () => {
    it("resolves the pending permission matched by toolCallId via permissions_respond", async () => {
      client.listPermissions = vi
        .fn()
        .mockResolvedValue([
          { id: "perm-db-id", toolCallId: "tc-1" },
          { id: "other", toolCallId: "tc-2" },
        ]) as DaemonClient["listPermissions"]
      client.respondPermission = vi.fn().mockResolvedValue(undefined) as DaemonClient["respondPermission"]

      await handleWebviewMessage(
        { type: "resolveQuestion", toolCallId: "tc-1", decision: "approve", optionId: "allow_once" },
        panel,
        controller,
        outputDocs,
        client,
      )

      expect(client.listPermissions).toHaveBeenCalledWith("session-abc")
      expect(client.respondPermission).toHaveBeenCalledWith("perm-db-id", {
        decision: "approve",
        optionId: "allow_once",
      })
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
    })

    it("warns and does nothing when the message carries no toolCallId", async () => {
      client.listPermissions = vi.fn() as unknown as DaemonClient["listPermissions"]
      client.respondPermission = vi.fn() as unknown as DaemonClient["respondPermission"]

      await handleWebviewMessage(
        { type: "resolveQuestion", decision: "approve", optionId: "allow_once" },
        panel,
        controller,
        outputDocs,
        client,
      )

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("no toolCallId"),
      )
      expect(client.listPermissions).not.toHaveBeenCalled()
      expect(client.respondPermission).not.toHaveBeenCalled()
    })

    it("warns when no pending permission matches the toolCallId (already resolved)", async () => {
      client.listPermissions = vi
        .fn()
        .mockResolvedValue([{ id: "other", toolCallId: "tc-2" }]) as DaemonClient["listPermissions"]
      client.respondPermission = vi.fn() as unknown as DaemonClient["respondPermission"]

      await handleWebviewMessage(
        { type: "resolveQuestion", toolCallId: "tc-gone", decision: "deny", optionId: "deny" },
        panel,
        controller,
        outputDocs,
        client,
      )

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("not found"),
      )
      expect(client.respondPermission).not.toHaveBeenCalled()
    })
  })
})
