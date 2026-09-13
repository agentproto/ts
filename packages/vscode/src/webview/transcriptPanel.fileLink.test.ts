import { describe, expect, it, vi, beforeEach } from "vitest"

// A vscode surface just wide enough for resolveFileTarget's resolution ladder:
// direct stat, workspace search, and the multi-hit QuickPick.
vi.mock("vscode", () => {
  const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 }
  return {
    Uri: { file: (p: string) => ({ fsPath: p, path: p, scheme: "file" }) },
    FileType,
    ViewColumn: { One: 1, Beside: 2 },
    window: {
      showQuickPick: vi.fn(),
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
    },
    commands: { executeCommand: vi.fn().mockResolvedValue(undefined) },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      fs: { stat: vi.fn() },
      findFiles: vi.fn(),
      asRelativePath: (u: { fsPath: string }) => u.fsPath.replace(/^\/ws\//, ""),
    },
  }
})

import * as vscode from "vscode"
import { resolveFileTarget, sanitizeLinkTarget } from "./transcriptPanel.js"
import type { TranscriptPanelController } from "./transcriptPanelController.js"

const controller = { session: { cwd: "/ws" } } as unknown as TranscriptPanelController

/** Make fs.stat resolve File for exactly `existing`, reject otherwise. */
function statOnly(existing: Set<string>): void {
  vi.mocked(vscode.workspace.fs.stat).mockImplementation(async (uri: { fsPath: string }) => {
    if (existing.has(uri.fsPath)) return { type: vscode.FileType.File } as never
    throw new Error("ENOENT")
  })
}

describe("sanitizeLinkTarget", () => {
  it("strips a trailing :line and :line:col", () => {
    expect(sanitizeLinkTarget("src/foo.ts:42")).toBe("src/foo.ts")
    expect(sanitizeLinkTarget("src/foo.ts:42:7")).toBe("src/foo.ts")
  })
  it("strips wrappers, a truncation ellipsis, and trailing punctuation", () => {
    expect(sanitizeLinkTarget("`src/foo.ts`")).toBe("src/foo.ts")
    expect(sanitizeLinkTarget("(src/foo.ts)")).toBe("src/foo.ts")
    expect(sanitizeLinkTarget("src/foo.ts…")).toBe("src/foo.ts")
    expect(sanitizeLinkTarget("src/foo.ts...")).toBe("src/foo.ts")
    expect(sanitizeLinkTarget("see src/foo.ts.".replace(/^see /, ""))).toBe("src/foo.ts")
  })
  it("leaves a clean path unchanged", () => {
    expect(sanitizeLinkTarget("src/foo.ts")).toBe("src/foo.ts")
  })
})

describe("resolveFileTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([])
  })

  it("returns a direct on-disk candidate without searching", async () => {
    statOnly(new Set(["/ws/src/foo.ts"]))
    const uri = await resolveFileTarget("src/foo.ts", controller)
    expect(uri?.fsPath).toBe("/ws/src/foo.ts")
    expect(vscode.workspace.findFiles).not.toHaveBeenCalled()
  })

  it("retries after sanitizing a trailing :line", async () => {
    statOnly(new Set(["/ws/src/foo.ts"])) // the :42 variant does not exist
    const uri = await resolveFileTarget("src/foo.ts:42", controller)
    expect(uri?.fsPath).toBe("/ws/src/foo.ts")
  })

  it("resolves a bare basename by workspace search (Jeremy's authProfilesWebviewPanel.ts case)", async () => {
    statOnly(new Set()) // nothing resolves directly
    const found = vscode.Uri.file("/ws/packages/vscode/src/webview/authProfilesWebviewPanel.ts")
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([found] as never)

    const uri = await resolveFileTarget("authProfilesWebviewPanel.ts", controller)
    expect(uri?.fsPath).toBe(found.fsPath)
    expect(vscode.workspace.findFiles).toHaveBeenCalledWith(
      "**/authProfilesWebviewPanel.ts",
      expect.any(String),
      expect.any(Number),
    )
  })

  it("recovers a stale absolute path (removed worktree) via a path-suffix search", async () => {
    statOnly(new Set()) // the old absolute path is gone
    const found = vscode.Uri.file("/ws/src/webview/authProfilesWebviewPanel.ts")
    vi.mocked(vscode.workspace.findFiles).mockImplementation(async (glob: unknown) =>
      glob === "**/src/webview/authProfilesWebviewPanel.ts" ? ([found] as never) : ([] as never),
    )

    const uri = await resolveFileTarget(
      "/removed/worktree/packages/vscode/src/webview/authProfilesWebviewPanel.ts",
      controller,
    )
    expect(uri?.fsPath).toBe(found.fsPath)
  })

  it("offers a QuickPick when several files match, returning the chosen one", async () => {
    statOnly(new Set())
    const a = vscode.Uri.file("/ws/a/index.ts")
    const b = vscode.Uri.file("/ws/b/index.ts")
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([a, b] as never)
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: "b/index.ts", uri: b } as never)

    const uri = await resolveFileTarget("index.ts", controller)
    expect(vscode.window.showQuickPick).toHaveBeenCalled()
    expect(uri?.fsPath).toBe(b.fsPath)
  })

  it("returns undefined when nothing matches anywhere", async () => {
    statOnly(new Set())
    const uri = await resolveFileTarget("does-not-exist.ts", controller)
    expect(uri).toBeUndefined()
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled()
  })
})
