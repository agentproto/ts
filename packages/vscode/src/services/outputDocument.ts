/**
 * Read-only virtual documents for values too big to sit inline in a webview
 * — today, a tool call's full input/output (see the transcript's 3-line
 * clamp in webview/conversation.ts).
 *
 * A TextDocumentContentProvider is the right primitive rather than a temp
 * file on disk: the content is already in memory, VS Code makes any custom
 * scheme read-only for free (no accidental "save" of an agent's output over
 * a real file), and the document evaporates with the window instead of
 * littering /tmp. The tab is a real editor, so search, folding, word-wrap and
 * syntax highlighting all come along for nothing — which is the entire point
 * of opening rather than expanding in place.
 *
 * Keyed by URI path, which callers derive from stable ids (toolIoDocumentName)
 * so re-opening the same value reveals its existing tab instead of stacking
 * duplicates.
 */

import * as vscode from "vscode"

export const OUTPUT_SCHEME = "agentproto-output"

class OutputDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>()
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>()
  readonly onDidChange = this._onDidChange.event

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.path) ?? ""
  }

  /** Register (or replace) a document's content and return its URI. */
  put(name: string, text: string): vscode.Uri {
    const path = name.startsWith("/") ? name : `/${name}`
    const uri = vscode.Uri.parse(`${OUTPUT_SCHEME}:${path}`)
    const previous = this.contents.get(path)
    this.contents.set(path, text)
    // A pending tool call can be opened, then re-opened once its result
    // lands. Same id, new content — fire so an already-open tab updates
    // rather than showing the stale value it was opened with.
    if (previous !== undefined && previous !== text) this._onDidChange.fire(uri)
    return uri
  }

  dispose(): void {
    this.contents.clear()
    this._onDidChange.dispose()
  }
}

export interface OutputDocuments {
  /** Open `text` in a read-only editor tab named `name`, beside the panel. */
  show(name: string, text: string): Promise<void>
}

export function registerOutputDocuments(ctx: vscode.ExtensionContext): OutputDocuments {
  const provider = new OutputDocumentProvider()
  ctx.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(OUTPUT_SCHEME, provider),
    provider,
  )

  return {
    async show(name: string, text: string): Promise<void> {
      const uri = provider.put(name, text)
      const doc = await vscode.workspace.openTextDocument(uri)
      await vscode.window.showTextDocument(doc, {
        // Beside, so the transcript the user was reading stays visible — the
        // value is context for the conversation, not a replacement for it.
        viewColumn: vscode.ViewColumn.Beside,
        preview: true,
        preserveFocus: false,
      })
    },
  }
}
