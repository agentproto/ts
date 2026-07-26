import { describe, expect, it, vi, beforeEach, type MockInstance } from "vitest"

vi.mock("vscode", () => ({
  window: {
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
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

  it("changePosture routes to the unified agentproto.configureSession picker", async () => {
    await handleWebviewMessage(
      { type: "changePosture" },
      panel,
      controller,
      outputDocs,
      client,
    )
    expect(executeCommand).toHaveBeenCalledWith("agentproto.configureSession", "session-abc")
  })

  it("changeAccess routes to the unified agentproto.configureSession picker", async () => {
    await handleWebviewMessage(
      { type: "changeAccess" },
      panel,
      controller,
      outputDocs,
      client,
    )
    expect(executeCommand).toHaveBeenCalledWith("agentproto.configureSession", "session-abc")
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
})
