/**
 * Transcript webview panel — a live chat/output view for a single session.
 *
 * Implements the WP4 contract:
 *   - One WebviewPanel per session id (viewType `agentproto.transcript`).
 *   - Theme-aware HTML using VS Code's CSS variables.
 *   - Initial transcript rendered from `exportSession("markdown")` with a
 *     `preview(200)` fallback.
 *   - Live output streamed via `SessionStore.focusOutput()`.
 *   - Send / interrupt-send wired to the daemon client. NOT kill: that lives
 *     in the sessions tree (`agentproto.killSession`), not under the user's
 *     eyes as a permanently-red slab beside the thing they type into.
 *   - Clean disposal of subscriptions when the panel closes.
 */

import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor } from "../client/types.js"
import type { SessionStore } from "../services/sessionStore.js"

import { registerOutputDocuments, type OutputDocuments } from "../services/outputDocument.js"
import { activityFor, TREE_REPAINT_INTERVAL_MS, type SessionActivity } from "../views/sessionsTree.logic.js"
import { TAB_ICON_DIR, tabIconFor } from "./tabIcon.logic.js"
import { adapterLogoFor } from "./adapterIcon.logic.js"
import {
  ATTACHMENT_COUNT_CAP,
  MAX_ATTACHMENT_BYTES,
  WARN_ATTACHMENT_BYTES,
  parseUriList,
} from "./attachments.logic.js"
import { mentionQueryAt } from "./mentions.logic.js"
import { recallHistory, pushHistoryEntry } from "./history.logic.js"
import { accessIdentity, contextGauge, contextRingLevel, defaultPostureLabel, formatCostShort, harnessGlyph, postureLabel, projectPlan, titleStatusState } from "./panelChrome.logic.js"
import { TOOL_IO_MAX_LINES } from "./conversation.js"
import {
  ASK_LONG_CHARS,
  TITLE_MAX_CHARS,
  activityFailed,
  askOf,
  buildBook,
  chapterDurationMs,
  chapterTitle,
  clampTitle,
  fillChapter,
  firstSentence,
  formatChapterDuration,
  htmlToText,
  newChapter,
  pad2,
} from "./conversationBook.logic.js"
import type { SeenTracker } from "../services/seen.js"
import { formatTitle, describePromptSource } from "./transcript.logic.js"
import { isWebviewMessage, type ExtMessage, type WebviewMessage } from "./protocol.js"
import { TranscriptPanelController } from "./transcriptPanelController.js"
import { runChangeModelFlow } from "../commands/changeModel.js"

export interface TranscriptPanels {
  open(session: SessionDescriptor): void
  /**
   * Session id of the currently focused transcript panel tab, if any. Lets
   * `agentproto.openTerminal`'s editor-title-bar entry point (WP5) target
   * "this" session without an explicit arg — a plain `editor/title` menu
   * command receives none, unlike a tree item's `view/item/context` command.
   */
  activeSessionId(): string | undefined
}

export function registerTranscriptPanels(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
  seen: SeenTracker,
): TranscriptPanels {
  const panels = new Map<string, vscode.WebviewPanel>()
  let activeId: string | undefined
  // One provider for every panel: the scheme is registered once per
  // extension activation, and each document's URI is already unique per
  // session/segment/field.
  const outputDocs = registerOutputDocuments(ctx)

  /** What each tab's icon was last painted for — assigning iconPath makes VS
   *  Code re-render the tab, so only a real CHANGE should do it. Keyed on
   *  activity AND unread: they're two axes, and a session going from unread to
   *  read never changes its activity, so an activity-only key would swallow
   *  exactly the repaint that clears the dot. */
  const painted = new Map<string, string>()

  const paintTabIcon = (panel: vscode.WebviewPanel, session: SessionDescriptor): void => {
    const activity = activityFor(session, Date.now())
    const unread = seen.isUnread(session)
    const key = `${activity}:${unread}`
    if (painted.get(session.id) === key) return
    painted.set(session.id, key)
    const icon = tabIconFor(activity, unread)
    panel.iconPath = {
      light: vscode.Uri.joinPath(ctx.extensionUri, ...TAB_ICON_DIR, icon.light),
      dark: vscode.Uri.joinPath(ctx.extensionUri, ...TAB_ICON_DIR, icon.dark),
    }
  }

  // Repaint every open tab on a clock as well as on change. `stalled` is a
  // function of elapsed silence, so the one state a wedged tab needs to reach
  // is the one no event will ever announce — same reasoning, same interval, as
  // the sessions tree.
  const repaintTabs = (): void => {
    for (const [id, panel] of panels) {
      const session = store.sessions.find(s => s.id === id)
      if (session) paintTabIcon(panel, session)
    }
  }

  const repaintTimer = setInterval(repaintTabs, TREE_REPAINT_INTERVAL_MS)
  ctx.subscriptions.push(new vscode.Disposable(() => clearInterval(repaintTimer)))

  // A receipt changing is a repaint like any other. Without this, reading one
  // transcript would clear its dot in the tree while its own tab kept the
  // filled one until some unrelated event happened by — the two disagreeing
  // about the same session, which is the thing this is supposed to fix.
  ctx.subscriptions.push(seen.onDidChange(repaintTabs))

  /**
   * The operator has eyes on this session — clear its unread dot. Re-read from
   * the store rather than trusting a captured descriptor: the receipt is
   * compared against `lastOutputAt`, so a stale copy would mark output read
   * that arrived after it was captured.
   */
  const markSeenNow = (id: string): void => {
    const session = store.sessions.find(s => s.id === id)
    if (session) seen.markSeen(session)
  }

  return {
    open(session: SessionDescriptor): void {
      const existing = panels.get(session.id)
      if (existing) {
        existing.reveal(vscode.ViewColumn.One, false)
        activeId = session.id
        markSeenNow(session.id)
        return
      }

      const panel = vscode.window.createWebviewPanel(
        "agentproto.transcript",
        formatTitle(session),
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        },
      )
      panels.set(session.id, panel)
      activeId = session.id
      // The tab wears the session's state, and keeps wearing it: without this
      // a transcript was a generic document glyph, indistinguishable from
      // every other open editor — and these tabs stay open for hours while
      // the thing behind them changes.
      paintTabIcon(panel, session)
      markSeenNow(session.id)

      const nonce = randomNonce()

      const disposables: vscode.Disposable[] = []

      const controller = new TranscriptPanelController({
        sessionId: session.id,
        initialSession: session,
        client,
        store,
        messenger: panel.webview,
      })
      disposables.push(controller)

      // Live session updates (cost, status, tokens).
      disposables.push(
        store.onDidChange(() => {
          const updated = store.sessions.find(s => s.id === session.id)
          if (!updated) return
          controller.onSessionUpdate(updated)
          // FIX A: the tab caption was set ONCE at createWebviewPanel and never
          // reassigned, so a tab opened before the title derived (or before a
          // rename) stayed frozen on the raw session id. Reassign it here on
          // every store change — cheap, and idempotent when the name is
          // unchanged — so the tab tracks the derived title and live renames.
          panel.title = formatTitle(updated)
          paintTabIcon(panel, updated)
          // Watching output arrive IS reading it — while this tab is the
          // focused one, new output must never mark the session unread behind
          // the operator's back. A hidden or background tab gets no such
          // credit: that output really is unread.
          if (activeId === session.id) seen.markSeen(updated)
        }),
      )

      // Message handling from the webview. Register before setting HTML so the
      // handler is in place if the webview posts `ready` synchronously.
      disposables.push(
        panel.webview.onDidReceiveMessage(async (raw: unknown) => {
          if (!isWebviewMessage(raw)) return
          try {
            await handleWebviewMessage(raw, panel, controller, outputDocs, client)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            void vscode.window.showErrorMessage(`agentproto: ${message}`)
          }
        }),
      )

      // Track focus so activeSessionId() reflects whichever transcript tab
      // the user is actually looking at (switching tabs doesn't re-run open()).
      disposables.push(
        panel.onDidChangeViewState(e => {
          if (e.webviewPanel.active) {
            activeId = session.id
            // Switching TO a tab is the commonest way of looking at a session
            // — open() only runs the first time.
            markSeenNow(session.id)
          } else if (activeId === session.id) activeId = undefined
        }),
      )

      // Cleanup on close.
      panel.onDidDispose(() => {
        for (const d of disposables) d.dispose()
        panels.delete(session.id)
        // Forget the painted state too: a reopened tab is a fresh panel with
        // no icon, so a stale entry here would suppress its first paint and
        // leave it wearing VS Code's generic glyph.
        painted.delete(session.id)
        if (activeId === session.id) activeId = undefined
      })

      // Set HTML only after the controller and message listener are wired up.
      panel.webview.html = buildHtml(nonce, {
        xtermJs: readDistFile(ctx, ["dist", "webview", "xterm.iife.js"]),
        xtermCss: readDistFile(ctx, ["dist", "webview", "xterm.css"]),
        headerIconSvg: readAdapterIconSvg(ctx, session.adapterSlug),
      })
    },
    activeSessionId(): string | undefined {
      return activeId
    },
  }
}

export async function handleWebviewMessage(
  msg: WebviewMessage,
  panel: vscode.WebviewPanel,
  controller: TranscriptPanelController,
  outputDocs: OutputDocuments,
  client: DaemonClient,
): Promise<void> {
  switch (msg.type) {
    case "ready":
      await controller.onReady()
      return
    case "changeModel":
      await runChangeModelFlow(controller, client)
      return
    case "changeEffort":
      // Per-axis picker: switches in place via POST /sessions/:id/effort, or
      // routes to the restart-confirm flow if the value needs a restart.
      await vscode.commands.executeCommand("agentproto.configureSessionAxis", {
        sessionId: controller.session.id,
        axis: "effort",
      })
      return
    case "changeRoute":
      // Restart-bound: configureSessionAxis runs the confirm → restart-with-
      // override → rebind → resume-badge flow.
      await vscode.commands.executeCommand("agentproto.configureSessionAxis", {
        sessionId: controller.session.id,
        axis: "route",
      })
      return
    case "changePosture":
      await vscode.commands.executeCommand("agentproto.configureSessionAxis", {
        sessionId: controller.session.id,
        axis: "posture",
      })
      return
    case "changeAccess":
      // Wallet — restart-bound; the per-axis flow runs the confirm → restart →
      // rebind → resume-badge path.
      await vscode.commands.executeCommand("agentproto.configureSessionAxis", {
        sessionId: controller.session.id,
        axis: "access",
      })
      return
    case "send":
      await controller.onSend(msg.text, false)
      return
    case "interruptSend":
      await controller.onSend(msg.text, true)
      return
    case "stop":
      await controller.onStop()
      return
    case "restart":
      await controller.onRestart()
      return
    case "restartAsTerminal":
      await vscode.commands.executeCommand("agentproto.restartAsTerminal", controller.session.id)
      return
    case "openTerminal":
      await vscode.commands.executeCommand("agentproto.openTerminal", controller.session.id)
      return
    case "setView":
      await controller.onSetView(msg.view)
      panel.reveal(vscode.ViewColumn.One, false)
      return
    case "rename":
      await controller.onRename(msg.name)
      return
    case "ptyInput":
      controller.onPtyInput(msg.text)
      return
    case "ptyResize":
      controller.onPtyResize(msg.cols, msg.rows)
      return
    case "attachImage":
      await controller.onAttachImage(msg.bytes, msg.mime)
      return
    case "attachFile":
      await controller.onAttachFile(msg.bytes, msg.mime, msg.name)
      return
    case "requestMentions":
      await controller.onRequestMentions(msg.query)
      return
    case "openToolIo": {
      const doc = controller.resolveToolIo(msg.segmentId, msg.field)
      if (!doc) {
        // The only way here is a call whose result hasn't landed yet — say
        // that, rather than opening a blank tab and looking broken.
        void vscode.window.showInformationMessage(
          `agentproto: this tool call has no ${msg.field} yet.`,
        )
        return
      }
      await outputDocs.show(doc.name, doc.text)
      return
    }
    case "openBlock":
      // A book narration block (table / code) the user popped out. The text is
      // the webview's own rendered prose, so it opens directly — no host-side
      // re-derivation, same read-only editor tab as a tool value.
      await outputDocs.show(msg.name, msg.text)
      return
    case "openLink":
      // A URL or file path in the transcript prose was clicked. External URLs
      // hand off to the OS browser; file paths open in the editor, positioned
      // at the cited line. Both validated defensively — a hostile/broken target
      // is dropped quietly rather than thrown.
      await openLinkTarget(msg.kind, msg.target, msg.line, controller)
      return
  }
}

/**
 * Open a transcript link. `external` → the OS browser (http/https/file only);
 * `file` → an editor tab at `line` (1-based). File-path resolution:
 *   - absolute path → itself
 *   - `~/…`         → against the home dir
 *   - relative      → against the session cwd, then each workspace folder,
 *                     preferring the first that actually exists on disk
 * A missing file surfaces a gentle notice, never an exception.
 */
export async function openLinkTarget(
  kind: "external" | "file",
  target: string,
  line: number | undefined,
  controller: TranscriptPanelController,
): Promise<void> {
  if (kind === "external") {
    let uri: vscode.Uri
    try {
      uri = vscode.Uri.parse(target, true)
    } catch {
      return
    }
    // Belt-and-braces: the renderer only emits http/https/file, but never hand
    // an arbitrary scheme to openExternal.
    if (!["http", "https", "file"].includes(uri.scheme.toLowerCase())) return
    await vscode.env.openExternal(uri)
    return
  }

  const uri = await resolveFileTarget(target, controller)
  if (!uri) {
    void vscode.window.showInformationMessage(`agentproto: couldn't find "${target}".`)
    return
  }
  try {
    const doc = await vscode.workspace.openTextDocument(uri)
    const selection =
      line != null && line > 0
        ? new vscode.Range(line - 1, 0, line - 1, 0)
        : undefined
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
      preserveFocus: false,
      selection,
    })
  } catch {
    // openTextDocument only handles text: an image or other binary (a pasted
    // screenshot attachment, a PDF) throws here. Hand it to VS Code's generic
    // `vscode.open`, which routes each type to its real editor — the image
    // preview for a PNG — so a clicked attachment opens instead of erroring.
    try {
      await vscode.commands.executeCommand("vscode.open", uri, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: true,
      })
    } catch {
      void vscode.window.showInformationMessage(`agentproto: couldn't open "${target}".`)
    }
  }
}

/** Directories never worth searching when a link doesn't resolve directly. */
const LINK_SEARCH_EXCLUDES = "**/{node_modules,dist,out,.git,.turbo,.next,coverage}/**"

/**
 * Strip the decorations a rendered link often carries so a path resolves:
 * surrounding quotes/backticks/brackets, a truncation ellipsis (the render
 * clamps long paths), a trailing `:line[:col]`, and trailing sentence
 * punctuation. Returns the cleaned path (trimmed), possibly unchanged. Pure —
 * exported for unit tests.
 */
export function sanitizeLinkTarget(target: string): string {
  let t = target.trim()
  t = t.replace(/^[`'"(<[]+/, "").replace(/[`'")>\]]+$/, "")
  t = t.replace(/(?:…|\.\.\.)$/, "")
  t = t.replace(/:\d+(?::\d+)?$/, "")
  t = t.replace(/[.,;:]+$/, "")
  return t.trim()
}

/** The direct on-disk candidates for a link target — home / absolute / the
 *  session cwd + each workspace folder for a relative path. */
function buildFileCandidates(target: string, controller: TranscriptPanelController): string[] {
  const candidates: string[] = []
  if (target.startsWith("~/") || target === "~") {
    candidates.push(join(homedir(), target.slice(1)))
  } else if (isAbsolute(target)) {
    candidates.push(target)
  } else {
    const rel = target.replace(/^\.\//, "")
    const cwd = controller.session.cwd
    if (cwd) candidates.push(join(cwd, rel))
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      candidates.push(join(folder.uri.fsPath, rel))
    }
  }
  return candidates
}

/** First candidate that exists on disk as a file, or undefined. Never throws. */
async function firstExistingFile(candidates: string[]): Promise<vscode.Uri | undefined> {
  for (const fsPath of candidates) {
    const uri = vscode.Uri.file(fsPath)
    try {
      const stat = await vscode.workspace.fs.stat(uri)
      if (stat.type === vscode.FileType.File) return uri
    } catch {
      // Not there — try the next candidate.
    }
  }
  return undefined
}

/** Present multiple search hits and return the chosen file, or undefined if the
 *  user dismissed the picker. Labels are workspace-relative for readability. */
async function pickFileFromHits(
  hits: readonly vscode.Uri[],
  target: string,
): Promise<vscode.Uri | undefined> {
  const items = hits.map(uri => ({ label: vscode.workspace.asRelativePath(uri), uri }))
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Multiple files match "${target}" — pick one to open`,
    matchOnDescription: true,
  })
  return picked?.uri
}

/**
 * Resolve a file-path link target to an on-disk Uri, or undefined. Never throws.
 *
 * A rendered transcript link is often NOT a live, valid path from here: it can
 * be a bare basename ("authProfilesWebviewPanel.ts"), a stale absolute path
 * (a removed worktree), or clamped/decorated by the renderer. So the direct
 * candidates are only the first rung — on a miss we sanitize, then search the
 * workspace by progressively shorter path suffixes, then by basename, opening
 * a unique hit outright and offering a QuickPick when several match.
 */
export async function resolveFileTarget(
  target: string,
  controller: TranscriptPanelController,
): Promise<vscode.Uri | undefined> {
  // 1. Direct candidates — the common, exact case.
  const direct = await firstExistingFile(buildFileCandidates(target, controller))
  if (direct) return direct

  // 2. Sanitize (trailing :line, punctuation, ellipsis, wrappers) and retry.
  const cleaned = sanitizeLinkTarget(target)
  if (cleaned && cleaned !== target) {
    const viaClean = await firstExistingFile(buildFileCandidates(cleaned, controller))
    if (viaClean) return viaClean
  }

  const searchPath = cleaned || target
  const segments = searchPath.split(/[\\/]/).filter(Boolean)
  if (segments.length === 0) return undefined

  // 3. Suffix-match: the last 3, then last 2 path segments — specific enough
  //    that a single hit is almost always the file the link meant.
  for (const n of [3, 2]) {
    if (segments.length < n) continue
    const suffix = segments.slice(-n).join("/")
    const hits = await vscode.workspace.findFiles(`**/${suffix}`, LINK_SEARCH_EXCLUDES, 8)
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) return pickFileFromHits(hits, target)
  }

  // 4. Basename search — last resort. Exactly one hit opens; several prompt;
  //    zero falls through to the caller's "couldn't find" notice.
  const basename = segments[segments.length - 1]!
  const hits = await vscode.workspace.findFiles(`**/${basename}`, LINK_SEARCH_EXCLUDES, 20)
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) return pickFileFromHits(hits, target)

  return undefined
}

function randomNonce(): string {
  // CSP nonce — must be unguessable, so use a CSPRNG, not Math.random().
  return randomBytes(16).toString("hex")
}

/** Read a file from the extension's dist/ directory. Returns empty string if
 *  the file is missing (e.g. in a test environment without a build). */
function readDistFile(ctx: vscode.ExtensionContext, segments: string[]): string {
  try {
    return readFileSync(join(ctx.extensionUri.fsPath, ...segments), "utf8")
  } catch {
    return ""
  }
}

/** Read the SVG content for an adapter's header icon, if an icon asset exists.
 *  Lettermarks are not inlined — the unicode glyph fallback is used instead. */
function readAdapterIconSvg(ctx: vscode.ExtensionContext, adapterSlug: string | undefined): string {
  if (!adapterSlug) return ""
  const logo = adapterLogoFor(adapterSlug)
  if (logo.kind !== "icon") return ""
  try {
    return readFileSync(join(ctx.extensionUri.fsPath, "media", "icons", "adapters", logo.file), "utf8")
  } catch {
    return ""
  }
}

/**
 * Exported so transcriptPanel.dom.test.ts can build the EXACT HTML/script the
 * extension ships and execute it in jsdom — the reconciliation logic in the
 * inline script is the load-bearing part of this module and has no other
 * way to get automated coverage without a real webview host.
 */
export function buildHtml(
  nonce: string,
  bundles: { xtermJs: string; xtermCss: string; headerIconSvg?: string } = { xtermJs: "", xtermCss: "", headerIconSvg: "" },
): string {
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join("; ")

  // Two pure helpers must run INSIDE the webview (caret detection for @mentions,
  // uri-list parsing for drops). The webview script is a string with no import
  // mechanism, so rather than hand-copy them — and risk a copy that silently
  // drifts from the tested source — we inject them BY VALUE from the very
  // functions the logic-module unit tests pin. Safe because both are
  // self-contained (no module-scope references) and the build isn't minified,
  // so `.toString()` yields a clean, named, hoistable declaration.
  const injectedHelpers = [
    mentionQueryAt,
    parseUriList,
    recallHistory,
    pushHistoryEntry,
    harnessGlyph,
    accessIdentity,
    postureLabel,
    defaultPostureLabel,
    contextGauge,
    // Conversation-chrome pure helpers (#conversation-chrome) — same by-value
    // injection so the webview runs the tested source.
    contextRingLevel,
    formatCostShort,
    titleStatusState,
    projectPlan,
    // Book (chapter) segmentation — injected by value so the webview runs the
    // SAME tested pure functions the logic module's unit tests pin. buildBook
    // calls the rest by name, so every one it touches must ride along as a
    // sibling declaration; ASK_LONG_CHARS/TITLE_MAX_CHARS are interpolated as
    // literals in the script below.
    buildBook,
    newChapter,
    askOf,
    fillChapter,
    activityFailed,
    chapterTitle,
    firstSentence,
    clampTitle,
    htmlToText,
    chapterDurationMs,
    formatChapterDuration,
    pad2,
    // Cross-session visibility (E2): describePromptSource formats the "⇄ from
    // <id>" badge on an agent-injected user turn — injected by value so the
    // webview runs the tested source, same as the helpers above.
    describePromptSource,
  ]
    .map(fn => fn.toString())
    .join("\n      ")

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>agentproto transcript</title>
  <style>
    :root {
      color: var(--vscode-editor-foreground);
      background-color: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    body {
      display: flex;
      flex-direction: column;
    }
    /* One row: the conversation's name on the left, two detail buttons on
       the right. Everything this used to carry (status chip, blocked-on
       chip, token totals) either repeats the tab icon or is a number you
       consult in a popover, not one you monitor in a strip. */
    #header {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 14px;
      border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, rgba(128,128,128,0.3)));
      background-color: var(--vscode-sideBar-background);
    }
    #header-left {
      flex: 1 1 auto;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    #header-title-block {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    #header-title {
      font-weight: 600;
      font-size: 1.1em;
      color: var(--vscode-sideBarTitle-foreground);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      /* Click-to-edit (FIX B): the title doubles as a rename affordance. */
      cursor: text;
    }
    #header-subtitle {
      font-size: 0.78em;
      color: var(--vscode-descriptionForeground);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #header-subtitle:empty { display: none; }
    #header-title:hover { color: var(--vscode-foreground); }
    /* The inline rename box that replaces the title text while editing —
       sized to fill the same slot so the header doesn't reflow. */
    #header-title input {
      width: 100%;
      font: inherit;
      font-weight: 600;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-focusBorder, var(--vscode-panel-border));
      border-radius: 4px;
      padding: 1px 4px;
    }
    #header-actions {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .header-action { position: relative; }
    .header-btn { font-size: 0.85em; }
    .header-btn:empty { display: none; }
    /* Merged metrics pill (#conversation-chrome): cost · context ring in one
       bordered capsule, so the two figures read as one glance. The inner
       buttons shed their own chrome. */
    .metrics-pill {
      display: inline-flex; align-items: center; gap: 5px;
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
      border-radius: 999px; padding: 1px 9px;
    }
    .metrics-pill .header-btn { border: none; background: none; padding: 0; }
    .metrics-pill .metrics-sep { color: var(--vscode-descriptionForeground); opacity: 0.6; }
    .metrics-pill #context-btn[hidden] { display: none; }
    .metrics-pill #context-btn[hidden] + #context-popover { display: none; }
    /* When there's no context figure yet, the trailing separator would dangle. */
    .metrics-pill:has(#context-btn[hidden]) .metrics-sep { display: none; }
    /* View segmented control — shows WHERE YOU ARE, active segment filled. */
    .segmented { display: inline-flex; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35)); border-radius: 6px; overflow: hidden; }
    .segmented[hidden] { display: none; }
    .segmented button {
      font: inherit; font-size: 0.82em; padding: 2px 9px; border: none; cursor: pointer;
      background: transparent; color: var(--vscode-descriptionForeground);
    }
    .segmented button + button { border-left: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35)); }
    .segmented button.on { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); color: var(--vscode-foreground); }
    .segmented button:hover:not(.on) { color: var(--vscode-foreground); }
    /* Title status dot — the visibility state at a glance (#session-visibility). */
    .tstatus { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; display: inline-block; }
    .tstatus:empty, .tstatus.quiet { background: transparent; border: 1px solid var(--vscode-descriptionForeground); }
    .tstatus.busy { background: var(--vscode-charts-green, #4caf50); }
    .tstatus.delegating { background: transparent; border: 2px solid var(--vscode-charts-green, #4caf50); }
    .tstatus.awaiting { background: var(--vscode-charts-yellow, #d7a600); }
    .tstatus.parked { background: var(--vscode-descriptionForeground); }
    /* The harness/adapter mark, sitting left of the session name so a glance at
       any transcript tab says which agent answers there. A quiet glyph, not a
       chip — colour comes from the surrounding title row. Empty (no adapter
       reported yet) collapses to nothing. */
    #header-icon {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      font-size: 1.05em;
      line-height: 1;
      color: var(--vscode-descriptionForeground);
    }
    #header-icon svg {
      width: 100%;
      height: 100%;
      fill: currentColor;
    }
    #header-icon:empty { display: none; }
    /* Dimmed harness watermark, bottom-left of the panel — a subtle,
       always-visible reminder of which harness runs this session, distinct
       from the crisp #header-icon. Fixed to the viewport (not the scrolling
       transcript) so it never drifts with scroll; the composer's own z-index
       keeps it from ever painting over the input box. Empty (lettermark-only
       adapter, no SVG asset) collapses to nothing — no glyph fallback here,
       a watermark is decoration, not information. */
    #harness-watermark {
      position: fixed;
      left: 14px;
      bottom: 14px;
      width: 30px;
      height: 30px;
      opacity: 0.35;
      pointer-events: none;
      z-index: 1;
      color: var(--vscode-descriptionForeground);
    }
    #harness-watermark svg { width: 100%; height: 100%; fill: currentColor; }
    #harness-watermark:empty { display: none; }
    /* Background-task chip strip (#background-tasks-ux) — one small rounded
       chip per still-running run_in_background tool call, click to jump to
       its card. Amber/brown, matching the sessions panel's bg-task tell. */
    #bg-chips {
      flex: 0 0 auto;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 6px 14px 0;
    }
    #bg-chips[hidden] { display: none; }
    .bgchip {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border: 1px solid rgba(181, 133, 75, 0.4);
      border-radius: 10px;
      background: rgba(181, 133, 75, 0.14);
      color: #b5854b;
      font: inherit;
      font-size: 0.82em;
      cursor: pointer;
    }
    .bgchip:hover { background: rgba(181, 133, 75, 0.26); }
    /* Brief highlight on the segment a chip click scrolled to, so "click to
       view" has an obvious landing even in a long transcript. */
    .seg-flash { outline: 2px solid #b5854b; outline-offset: 2px; transition: outline-color 1.1s ease; }
    /* A single Terminal button that opens the terminal view (FIX 2) — replaces
       the old Conversation⇄Terminal segmented control, which was too heavy for
       what is a one-way jump to the raw view. Reuses the openTerminal command.
       Hidden via [hidden] when the session has no terminal representation. */
    .term-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 0.8em;
      padding: 2px 8px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: 5px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
    }
    .term-btn[hidden] { display: none; }
    .term-btn:hover:not(:disabled) {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2));
    }
    .term-glyph {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.9em;
      opacity: 0.8;
    }
    /* Context-window fill as a compact ring gauge (FIX 5) — replaces the plain
       "ctx N%" text with a 14px ring plus a small percent, so it reads at a
       glance and costs less horizontal space. The ring's colour tracks the
       fill level (calm → warning). Still the button that opens the raw-counts
       popover. */
    .ctx-gauge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 4px;
    }
    .ctx-gauge[hidden] { display: none; }
    .ctx-ring { flex: 0 0 auto; }
    .ctx-track { stroke: var(--vscode-panel-border, rgba(128,128,128,0.35)); }
    /* Grey until warnAtPct, amber to compactAtPct, red past it (#conversation-chrome). */
    .ctx-arc { stroke: var(--vscode-descriptionForeground); transition: stroke-dasharray 0.2s ease, stroke 0.2s ease; }
    .ctx-arc.amber { stroke: var(--vscode-charts-yellow, #d7a600); }
    .ctx-arc.red { stroke: var(--vscode-charts-red, #e51400); }
    .ctx-pct {
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
      font-variant-numeric: tabular-nums;
    }
    /* A webview has no VS Code popover API — this is our own
       absolutely-positioned element, anchored to its button so it never
       reflows the transcript underneath it. */
    .popover {
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      z-index: 30;
      min-width: 200px;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.3)));
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      font-size: 0.85em;
    }
    .popover[hidden] { display: none; }
    .popover-row {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      padding: 2px 0;
    }
    .popover-label { color: var(--vscode-descriptionForeground); }
    /* Delayed and low-key on purpose — see BLOCKED_NOTE_DELAY_MS in the
       script. Sits in the conversation body, next to the tool call it
       describes, not the header: the tab icon already carries the states
       that deserve a permanent glyph. */
    /* Neutral on purpose: a long-running block (usually "command") is normal
       supervision behavior, not an error — warning-yellow reads as one. The
       dismiss ✕ below stays low-key. */
    #blocked-note {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 14px 0;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      opacity: 0.85;
    }
    #blocked-note-text { flex: 1 1 auto; min-width: 0; }
    /* The dismiss X is deliberately low-key — the note is itself low-key. */
    #blocked-note-dismiss {
      flex: 0 0 auto;
      background: none;
      border: none;
      color: inherit;
      cursor: pointer;
      padding: 0 2px;
      font-size: inherit;
      opacity: 0.7;
    }
    #blocked-note-dismiss:hover { opacity: 1; }
    #blocked-note[hidden] { display: none; }
    /* Resume-chain history — a restarted session's ancestor transcripts,
       rendered ONCE at init as the FIRST content INSIDE #transcript (see the
       'init' handler + paintResumeChain), not a separate scroll pane above
       it: one continuous conversation, oldest ancestor turn to newest live
       one, governed by #transcript's single scroll region. Empty (no
       resumedFrom) collapses to nothing via :empty — no border, no gap. */
    #resume-history {
      padding-bottom: 6px;
      margin-bottom: 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    #resume-history:empty { display: none; padding: 0; margin: 0; border: none; }
    .resume-divider {
      text-align: center;
      font-size: 0.78em;
      color: var(--vscode-descriptionForeground);
      margin: 10px 0;
      opacity: 0.8;
    }
    .resume-unavailable {
      font-size: 0.85em;
      font-style: italic;
      color: var(--vscode-descriptionForeground);
      padding: 4px 0 10px;
    }
    #transcript {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 12px 14px;
      line-height: 1.5;
    }
    #transcript p { margin: 0 0 10px; }
    #transcript h1, #transcript h2, #transcript h3, #transcript h4, #transcript h5, #transcript h6 {
      margin: 12px 0 6px;
      color: var(--vscode-editor-foreground);
    }
    #transcript pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 10px;
      border-radius: 4px;
      overflow-x: auto;
    }
    #transcript code {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.95em;
    }
    #transcript blockquote {
      margin: 0 0 10px;
      padding-left: 12px;
      border-left: 3px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
    }
    #transcript ul, #transcript ol { margin: 0 0 10px 18px; padding: 0; }
    #transcript li { margin-bottom: 2px; }
    /* GFM pipe tables: quiet hairline grid, a slightly emphasized header, and
       no zebra loudness. display:block + width:max-content lets a wide table
       scroll horizontally at panel width instead of squashing its columns. */
    #transcript table {
      display: block;
      width: max-content;
      max-width: 100%;
      overflow-x: auto;
      border-collapse: collapse;
      margin: 0 0 10px;
      font-size: 0.95em;
    }
    #transcript th, #transcript td {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      padding: 4px 10px;
      text-align: left;
    }
    #transcript th {
      font-weight: 600;
      background: var(--vscode-textCodeBlock-background);
    }
    .line {
      font-family: var(--vscode-editor-font-family);
      white-space: pre-wrap;
      word-break: break-word;
      margin-bottom: 2px;
    }
    .line-stderr { color: var(--vscode-errorForeground); }
    /* ── Structured chat timeline ─────────────────────────────────── */
    .turn { margin: 0 0 14px; }
    .turn .role {
      font-size: 0.78em;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }
    .turn-user .bubble, .turn-assistant .bubble { border-radius: 6px; padding: 8px 12px; }
    .turn-user .bubble {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    }
    .turn-assistant .bubble { background: transparent; }
    .seg { margin: 0 0 8px; }
    .seg:last-child { margin-bottom: 0; }
    .seg.text > :first-child { margin-top: 0; }
    .seg.text > :last-child { margin-bottom: 0; }
    /* A GROUP is a box (it contains things). A STEP is a row. Nesting a
       bordered card inside a bordered group drew two frames around one fact
       and left no quiet surface to read. */
    details.activity {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: 5px;
      background: var(--vscode-textCodeBlock-background);
      padding: 3px 8px;
    }
    details.reasoning, details.tool {
      border-radius: 4px;
      padding: 1px 4px;
    }
    /* A top-level step still needs an edge to sit against the chat bubbles;
       inside a group the tree line already does that job. */
    .turn > details.reasoning, .turn > details.tool {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      padding: 3px 8px;
      background: var(--vscode-textCodeBlock-background);
    }
    .reasoning-body {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    /* ── One disclosure row: status ─ name ─────────────── chevron ── */
    details.reasoning > summary, details.tool > summary, details.activity > summary {
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
      /* The native triangle is stuck on the left, where it fights the status
         glyph for the first thing the eye lands on. */
      list-style: none;
    }
    details > summary::-webkit-details-marker { display: none; }
    details.reasoning[open] > summary,
    details.tool[open] > summary,
    details.activity[open] > summary { margin-bottom: 6px; }
    details.tool > summary { font-family: var(--vscode-editor-font-family); }
    .seg-badge {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1em;
    }
    /* The cross IS the failure report — the container stays quiet. */
    .seg-badge.badge-error { color: var(--vscode-errorForeground); }
    .seg-badge.badge-ok { opacity: 0.55; }
    /* The live step: a pulsing dot, so the eye finds the one thing happening
       now without reading a word. */
    .seg-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--vscode-editorWarning-foreground);
      animation: agentproto-pulse 1.1s ease-in-out infinite;
    }
    .seg-label {
      font-family: var(--vscode-editor-font-family);
      color: var(--vscode-editor-foreground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .seg-elapsed {
      flex: 0 0 auto;
      color: var(--vscode-editorWarning-foreground);
      font-variant-numeric: tabular-nums;
    }
    .seg-elapsed:empty { display: none; }
    /* Faint on purpose: it's an affordance, not information. It only has to
       be findable once you're already looking at the row. */
    .seg-chev {
      flex: 0 0 auto;
      margin-left: auto;
      padding-left: 8px;
      opacity: 0.32;
      transition: transform 0.12s ease;
    }
    details[open] > summary > .seg-chev { transform: rotate(90deg); }
    summary:hover > .seg-chev { opacity: 0.7; }
    /* The fold's children indent under the summary so the run reads as a tree. */
    .act-children {
      border-left: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      margin-left: 4px;
      padding-left: 8px;
    }
    /* Consecutive tool segments read as one compact group instead of N
       separately-bordered cards — see markToolRuns() in the script. */
    .seg.tool.tool-run-start, .seg.tool.tool-run-mid { margin-bottom: 0; border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
    .seg.tool.tool-run-mid, .seg.tool.tool-run-end { border-top: none; border-top-left-radius: 0; border-top-right-radius: 0; }
    .tool-field-label {
      font-size: 0.75em;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: var(--vscode-descriptionForeground);
      margin: 4px 0 2px;
    }
    /* Clamped to TOOL_IO_MAX_LINES rows and clipped horizontally — a tool
       card shows what the call was, not what it returned in full. pre
       (not pre-wrap) is deliberate: wrapping one 900-char line would blow
       the whole line budget on a single line, so long lines clip and the
       block opens in an editor on click. */
    .tool-args, .tool-result {
      margin: 0;
      background: var(--vscode-editor-background);
      padding: 6px 8px;
      border-radius: 4px;
      overflow: hidden;
      white-space: pre;
      text-overflow: ellipsis;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      line-height: 1.4;
      cursor: pointer;
    }
    .tool-args:hover, .tool-result:hover {
      outline: 1px solid var(--vscode-focusBorder);
    }
    /* "Cut here" — a dashed edge, not a fade. The preview is exactly
       MAX_IO_LINES tall, so a gradient mask would dissolve the last line the
       user can actually read in exchange for saying what the link below
       already says outright. */
    .tool-io-clamped {
      border-bottom: 1px dashed var(--vscode-panel-border, rgba(128,128,128,0.4));
      border-bottom-left-radius: 0;
      border-bottom-right-radius: 0;
    }
    .tool-io-open {
      display: inline-block;
      margin: 2px 0 4px;
      font-size: 0.8em;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      user-select: none;
    }
    .tool-io-open:hover { text-decoration: underline; }
    @keyframes agentproto-pulse {
      0%, 100% { opacity: 0.35; transform: scale(0.85); }
      50% { opacity: 1; transform: scale(1); }
    }
    /* A step that has outrun the stall threshold. Deliberately only weight:
       the elapsed is already warning-coloured while a step runs, so the
       escalation is "this number is now shouting", not another border. */
    .tool-still-running > summary > .seg-elapsed { font-weight: 600; }
    .seg.plan {
      /* Semantic state colours resolved to VS Code theme tokens on the
         timeline. #book re-binds these same vars to the paper palette (see the
         "#book .seg.plan" block near .notices), so the ONE structural ruleset
         below serves both reading surfaces without duplication. */
      --plan-accent: var(--vscode-charts-green, var(--vscode-progressBar-background));
      --plan-muted: var(--vscode-descriptionForeground);
      --plan-faint: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
      --plan-error: var(--vscode-errorForeground);
      --plan-track: var(--vscode-progressBar-background);
      border-left: 3px solid var(--plan-accent);
      padding: 4px 0 4px 10px;
    }
    .plan-head { font-weight: 600; font-size: 0.9em; margin-bottom: 4px; }
    /* Thin done/total track under the head — accent fill over a faint groove. */
    .plan-progress {
      height: 2px; border-radius: 2px; margin: 0 0 6px;
      background: var(--plan-track); opacity: 0.35; overflow: hidden;
    }
    .plan-progress-fill {
      height: 100%; width: 0; border-radius: 2px;
      background: var(--plan-accent); transition: width .2s ease;
    }
    .plan-list { list-style: none; margin: 0; padding: 0; }
    /* Two columns: [marker | text]. A fixed marker column + baseline alignment
       give wrapped lines a hanging indent that lands on the text's left edge,
       not under the glyph. The marker is its own element, never a text prefix. */
    .plan-list li {
      display: grid;
      grid-template-columns: 1.3em 1fr;
      align-items: baseline;
      column-gap: 0.4em;
      font-size: 0.92em;
      line-height: 1.45;
      padding: 3px 0;
    }
    .plan-mark { text-align: center; }
    .plan-text { min-width: 0; }
    .plan-list li.plan-pending { color: var(--plan-faint); }
    .plan-list li.plan-pending .plan-mark { color: var(--plan-faint); }
    .plan-list li.plan-in_progress { font-weight: 600; }
    .plan-list li.plan-in_progress .plan-mark { color: var(--plan-accent); }
    /* Completed steps: muted, NO strikethrough (#conversation-chrome — struck
       rows read as "cancelled", not "done"). Only shown when the summary is
       expanded, indented as sub-rows. */
    .plan-list li.plan-completed { color: var(--plan-muted); }
    .plan-list li.plan-completed .plan-mark { color: var(--plan-accent); }
    .plan-list li.plan-sub { padding-left: 18px; opacity: 0.85; }
    .plan-list li.plan-failed { color: var(--plan-error); }
    .plan-list li.plan-failed .plan-mark { color: var(--plan-error); }
    /* Collapsed "✓ N done" summary + the "+N more" upcoming toggle — both
       clickable, with a faint chevron pushed to the right on the summary. */
    .plan-list li.plan-donesum { cursor: pointer; color: var(--plan-muted); display: flex; align-items: baseline; column-gap: 0.4em; }
    .plan-list li.plan-donesum .plan-mark { color: var(--plan-accent); min-width: 1.3em; text-align: center; }
    .plan-list li.plan-donesum:hover { color: var(--plan-accent); }
    .plan-list li.plan-donesum .plan-chev { margin-left: auto; color: var(--plan-faint); font-size: 0.85em; }
    .plan-list li.plan-more { cursor: pointer; color: var(--plan-faint); }
    .plan-list li.plan-more:hover { color: var(--plan-muted); }
    .seg.question {
      border-left: 3px solid var(--vscode-editorWarning-foreground);
      padding: 4px 0 4px 10px;
    }
    /* Resolved: the ask is already answered — a calmer border than the
       still-pending warning color so the two states read apart at a glance. */
    .seg.question.resolved {
      border-left: 3px solid var(--vscode-descriptionForeground);
      color: var(--vscode-descriptionForeground);
    }
    .seg.error {
      color: var(--vscode-errorForeground);
      border-left: 3px solid var(--vscode-errorForeground);
      padding: 4px 0 4px 10px;
      white-space: pre-wrap;
    }
    #conv-usage { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
    /* ── Working row ──────────────────────────────────────────────────
       The one always-visible answer to "is it doing anything?", sitting
       between the timeline and the composer so it stays put while the
       transcript scrolls. Only shown while a turn is actually in flight. */
    #working {
      flex: 0 0 auto;
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 6px 14px 0;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
    }
    #working[hidden] { display: none; }
    #working-glyph {
      color: var(--vscode-progressBar-background);
      animation: agentproto-spin 1.6s linear infinite;
    }
    /* Stop the spinner: nothing is spinning. */
    #working.stalled { color: var(--vscode-editorWarning-foreground); }
    #working.stalled #working-glyph {
      animation: none;
      color: var(--vscode-editorWarning-foreground);
    }
    @keyframes agentproto-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    /* Honour the OS "reduce motion" setting — this thing spins for minutes. */
    @media (prefers-reduced-motion: reduce) {
      #working-glyph { animation: none; }
      /* The dot stays — solid and warning-coloured it still marks the live
         step; only the pulsing goes. */
      .seg-dot { animation: none; }
      .seg-chev { transition: none; }
    }
    /* ── Composer ─────────────────────────────────────────────────────
       One bordered box that OWNS the textarea and its action row, rather
       than a textarea sitting next to a stack of coloured buttons. Actions
       are ghost-styled and live inside the box on one line: the destructive
       one earns colour on hover only, so a red slab never sits permanently
       under the user's eyes. */
    #input-area {
      /* Locked palette, mirroring #book: the composer is part of the same
         DESIGNED reading surface, not vscode chrome, so it shares the book's
         ink / paper / phosphor instead of the editor theme — which is why it
         used to read as a blue-focused box on a different background. */
      --ink: #1b1b1c; --ink-2: #232324; --edge: #333335;
      --paper: #f4f0e6; --paper-45: rgba(244,240,230,.45); --paper-28: rgba(244,240,230,.28);
      --phosphor: #2f9e63;
      flex: 0 0 auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px 14px 12px;
      background-color: var(--ink);
      color: var(--paper);
      /* Above #harness-watermark (z-index: 1) so the composer's opaque
         background always wins where the two would otherwise overlap. */
      position: relative;
      z-index: 2;
    }
    /* ── Error banner ─────────────────────────────────────────────────
       Errors used to be one line of red text wedged under the buttons,
       clipped mid-sentence — the daemon's actual reason was unreadable. A
       banner above the composer gets the full message, selectable so it can
       be copied into a bug report, and a dismiss. */
    #error-banner {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 12px;
      border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
      background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.1));
      border-radius: 6px;
    }
    #error-banner[hidden] { display: none; }
    #eb-icon { flex: 0 0 auto; color: var(--vscode-errorForeground); }
    #eb-body { flex: 1 1 auto; min-width: 0; }
    #eb-title { font-weight: 600; margin-bottom: 2px; }
    #eb-message {
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family);
      /* The whole reason this exists: never clip the daemon's message. */
      white-space: pre-wrap;
      word-break: break-word;
      user-select: text;
    }
    #eb-dismiss { flex: 0 0 auto; }
    /* ── Info banner (E3) ─────────────────────────────────────────────
       The error banner's informational variant: cross-session "something
       just happened" pings (a watcher attached/detached, a message arrived
       from another session). Same flex/dismiss shape, informational colour. */
    #info-banner {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 8px 12px;
      border: 1px solid var(--vscode-inputValidation-infoBorder, var(--vscode-focusBorder, var(--vscode-panel-border)));
      background: var(--vscode-inputValidation-infoBackground, var(--vscode-editorWidget-background, transparent));
      border-radius: 6px;
    }
    #info-banner[hidden] { display: none; }
    #ib-icon { flex: 0 0 auto; color: var(--vscode-inputValidation-infoForeground, var(--vscode-descriptionForeground)); }
    #ib-body { flex: 1 1 auto; min-width: 0; }
    #ib-text {
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
      white-space: pre-wrap;
      word-break: break-word;
      user-select: text;
    }
    #ib-dismiss { flex: 0 0 auto; }
    /* ── Agent-sourced turn (E2) ──────────────────────────────────────
       A user turn another session injected (agent_prompt) is visibly not
       "you": a left accent + faint tint using theme variables, plus a
       "⇄ from <id>" badge on the header. No hardcoded hex. */
    .turn-agent-sourced .bubble {
      border-left: 3px solid var(--vscode-charts-purple, var(--vscode-focusBorder, var(--vscode-panel-border)));
      background: var(--vscode-editorWidget-background, var(--vscode-input-background));
    }
    .prompt-source-badge {
      display: inline-block;
      margin-left: 6px;
      padding: 0 6px;
      font-size: 0.78em;
      border-radius: 8px;
      vertical-align: middle;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
    }
    /* ── Queued message ───────────────────────────────────────────────
       A prompt typed mid-turn is held here rather than rejected. */
    #queued {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border: 1px dashed var(--vscode-panel-border, rgba(128,128,128,0.4));
      border-radius: 6px;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
    }
    #queued[hidden] { display: none; }
    #queued-label {
      flex: 1 1 auto;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #queued-cancel { flex: 0 0 auto; }
    #composer {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 10px;
      border: 1px solid var(--edge);
      border-radius: 8px;
      background: var(--ink-2);
    }
    #composer:focus-within { border-color: var(--phosphor); }
    #composer.disabled { opacity: 0.6; }
    /* Drop affordance: the composer is the drop target, so it lights up while a
       file is dragged over the panel. */
    #composer.drag-over { border-color: var(--phosphor); border-style: dashed; }
    /* ── Attachment chips ─────────────────────────────────────────────
       A pasted/dragged/mentioned path becomes a removable chip here, not
       raw text in the box — the path still rides along in the sent prompt
       (composePrompt appends it), this is just the editable pre-send view. */
    #composer-attachments {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    #composer-attachments[hidden] { display: none; }
    .attach-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 260px;
      padding: 2px 4px 2px 8px;
      border: 1px solid var(--edge);
      border-radius: 10px;
      background: var(--ink);
      color: var(--paper);
      font-size: 0.85em;
    }
    .attach-chip-label {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .attach-chip-remove {
      flex: 0 0 auto;
      cursor: pointer;
      opacity: 0.6;
      padding: 0 3px;
      border-radius: 4px;
      line-height: 1;
    }
    .attach-chip-remove:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.25)); }
    /* ── @mention popup ───────────────────────────────────────────────
       Floats above the composer; the webview renders it itself (a VS Code
       CompletionProvider isn't available inside a webview). */
    #mention-popup {
      position: absolute;
      left: 8px;
      right: 8px;
      bottom: calc(100% + 4px);
      max-height: 220px;
      overflow-y: auto;
      z-index: 5;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.4));
      border-radius: 6px;
      background: var(--vscode-editorSuggestWidget-background, var(--vscode-input-background));
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    }
    #mention-popup[hidden] { display: none; }
    .mention-item {
      padding: 4px 10px;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      cursor: pointer;
    }
    .mention-item.active,
    .mention-item:hover {
      background: var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground));
      color: var(--vscode-list-activeSelectionForeground, var(--vscode-editor-foreground));
    }
    .mention-empty {
      padding: 4px 10px;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    #input {
      width: 100%;
      resize: none;
      /* Default to ~3 lines of breathing room (auto-grows beyond via autoGrow);
         min-height is the floor even when the inline height goes smaller
         (#conversation-chrome). */
      min-height: 4.2em;
      max-height: 200px;
      overflow-y: auto;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--paper);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.4;
    }
    #input:focus { outline: none; }
    #input::placeholder { color: var(--paper-45); }
    #input:disabled { cursor: not-allowed; }
    #composer-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.85em;
      color: var(--paper-45);
      /* Clear the in-field send/stop button parked at the composer's bottom-right. */
      padding-right: 40px;
    }
    /* Quiet keyboard hint (#conversation-chrome). */
    .send-hint { color: var(--paper-45); opacity: 0.75; white-space: nowrap; font-size: 0.95em; }
    #composer.disabled .send-hint { display: none; }
    /* Which agent/model will answer belongs where you type, not only in the
       header — so the header no longer repeats it. */
    #composer-meta {
      flex: 1 1 auto;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .composer-chip {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .composer-chip:empty { display: none; }
    /* A non-switchable axis (e.g. harness on a live session) reads as present
       but inert — dimmed, with a tooltip explaining why (chip-pickers WP). */
    .composer-chip.dimmed { opacity: 0.5; cursor: default; }
    #composer-harness svg { display: inline-block; color: inherit; }
    /* The model chip is the one clickable chip (click → switch model) — reset
       the generic button rule's chrome so it still reads as plain chip text,
       only gaining an underline + link color on hover as the click affordance. */
    .composer-chip-btn {
      padding: 0;
      border: none;
      border-radius: 3px;
      background: transparent;
      color: inherit;
      font: inherit;
    }
    .composer-chip-btn:hover:not(:disabled) {
      background: transparent;
      color: var(--phosphor);
      text-decoration: underline;
    }
    button {
      padding: 3px 8px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-family: inherit;
      font-size: inherit;
    }
    button:hover:not(:disabled) {
      background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2));
      color: var(--vscode-editor-foreground);
    }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    /* Hidden rather than disabled: interrupting a session that isn't working
       on anything is a no-op, so the affordance shouldn't be there at all. */
    button[hidden] { display: none; }
    #kill:hover:not(:disabled) {
      background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.12));
      color: var(--vscode-errorForeground);
    }
    /* The submit key. Stays quiet until there is actually something to send. */
    /* Send/Stop live at the field's bottom-right corner, inside the box
       (#conversation-chrome), rather than trailing the chip row. */
    #send, #stop { position: absolute; right: 8px; bottom: 7px; z-index: 2; }
    #send {
      flex: 0 0 auto;
      min-width: 26px;
      font-size: 1em;
      line-height: 1;
      padding: 4px 8px;
    }
    #send.has-text {
      background: var(--phosphor);
      color: var(--ink);
    }
    #send.has-text:hover:not(:disabled) {
      background: #37b473;
      color: var(--ink);
    }
    /* Destructive-but-not-alarming: it abandons a turn, not the session, so
       this stops short of the errorForeground/errorBackground pair #kill's
       hover uses. */
    #stop {
      flex: 0 0 auto;
      min-width: 26px;
      font-size: 0.85em;
      line-height: 1;
      padding: 4px 8px;
      background: var(--vscode-inputValidation-warningBackground, rgba(128,128,128,0.2));
      color: var(--vscode-inputValidation-warningForeground, var(--vscode-editor-foreground));
    }
    #stop:hover:not(:disabled) {
      background: var(--vscode-inputValidation-warningBorder, var(--vscode-toolbar-hoverBackground));
    }
    /* Shown only once the session has exited, beside the now-disabled input
       (see refreshComposer) — a session that has exited has exactly one
       useful action left, so it earns the button's primary styling, same
       treatment as #send.has-text. */
    #restart-btn {
      flex: 0 0 auto;
      font-size: 0.85em;
      line-height: 1;
      padding: 4px 8px;
      background: var(--phosphor);
      color: var(--ink);
    }
    #restart-btn:hover:not(:disabled) {
      background: #37b473;
    }
    #send-status {
      flex: 0 0 auto;
      color: var(--vscode-errorForeground);
    }
    #send-status:empty { display: none; }
    #empty {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 20px 0;
    }
    /* PTY-mode xterm.js container. Hidden by default; shown when mode === "pty". */
    #pty-view {
      flex: 1 1 auto;
      display: none;
      overflow: hidden;
      padding: 4px 0 0;
    }
    #pty-view.active { display: block; }
    .xterm-viewport { background-color: transparent !important; }
    .xterm-screen { background-color: transparent !important; }

    /* ── Book view ─────────────────────────────────────────────────────
       A session as a BOOK: chapters split on asks. The palette here is
       DELIBERATELY fixed (not vscode-themed) — same locked posture as the
       sessions revamp — because the book is a designed reading surface, not a
       chrome panel. Prose is a system serif stack (no webfont dependency,
       offline-safe); chrome/steps/kickers are mono. */
    #book {
      --ink: #1b1b1c; --ink-2: #232324; --edge: #333335;
      --paper: #f4f0e6;
      --paper-72: rgba(244,240,230,.72); --paper-45: rgba(244,240,230,.45);
      --paper-28: rgba(244,240,230,.28); --paper-tint: rgba(244,240,230,.055);
      --phosphor: #2f9e63;
      --serif: Charter, 'Iowan Old Style', Georgia, 'Times New Roman', serif;
      --bkmono: ui-monospace, 'SF Mono', Menlo, monospace;
      flex: 1 1 auto;
      overflow-y: auto;
      background: var(--ink);
      color: var(--paper);
      font: 13px/1.6 var(--bkmono);
      padding: 26px 0 40px;
    }
    #book[hidden] { display: none; }
    #book .book-page { max-width: 640px; margin: 0 auto; padding: 0 26px; }
    #book #book-empty { color: var(--paper-45); font-size: 12px; }
    /* Blank-conversation hero — a session-identity card, not a dead placeholder. */
    #book .book-hero {
      border: 1px solid var(--edge); border-radius: 10px;
      background: var(--paper-tint);
      padding: 18px 20px; max-width: 460px; margin: 8px 0;
    }
    #book .book-hero .bh-title { font: 600 17px/1.3 var(--serif); color: var(--paper); }
    #book .book-hero .bh-sub {
      font: 12px/1.6 var(--bkmono); color: var(--paper-45); margin-top: 6px;
    }
    #book .book-hero .bh-facts {
      margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--edge);
      display: flex; flex-direction: column; gap: 7px;
    }
    #book .book-hero .bh-row { display: flex; align-items: baseline; gap: 12px; }
    #book .book-hero .bh-k {
      flex: 0 0 68px; font: 700 9px var(--bkmono); letter-spacing: .13em;
      color: var(--paper-28); text-transform: uppercase; padding-top: 1px;
    }
    #book .book-hero .bh-v { font: 13px var(--bkmono); color: var(--paper-72); }

    #book .chapter { margin-top: 6px; }
    #book .fold {
      display: flex; align-items: baseline; gap: 10px;
      padding: 9px 10px; margin: 0 -10px; border-radius: 8px;
      cursor: pointer; width: calc(100% + 20px);
      background: transparent; border: none; text-align: left; color: inherit;
      font: inherit;
    }
    #book .fold:hover { background: var(--ink-2); }
    #book .fold:focus-visible { outline: 1px solid var(--phosphor); outline-offset: -1px; }
    #book .fold .arrow { font-size: 10px; color: var(--paper-28); transition: transform .13s; flex: 0 0 auto; }
    #book .chapter.openc .fold .arrow { transform: rotate(90deg); }
    #book .fold h2 {
      font: 600 15px var(--serif); color: var(--paper-72);
      flex: 1; min-width: 0; margin: 0;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #book .chapter.openc .fold h2 { color: var(--paper); white-space: normal; }
    #book .fold .who { font-size: 9.5px; color: var(--paper-28); flex-shrink: 0; }
    #book .fold .t { font-size: 10px; color: var(--paper-28); flex-shrink: 0; }

    /* Body sits in the CHEVRON column: the fold bleeds 10px left (margin 0 -10px)
       and pads 10px, so its arrow's left edge lands at the chapter's content
       edge (0). Zeroing the body's left padding lines the ask card / narration /
       steps up under the ▸ rather than under the title. */
    #book .cbody { display: none; padding: 2px 0 16px 0; }
    #book .chapter.openc .cbody, #book .chapter.live .cbody { display: block; }
    /* The live chapter is always open and offers no fold affordance. */
    #book .chapter.live .fold { cursor: default; }
    #book .chapter.live .fold .arrow { visibility: hidden; }

    /* The ask block is the HUMAN turn: a persistent, tinted paper card pinned
       ABOVE its response chapter (not inside the fold), left edge in the chevron
       column. The tint alone marks it as an incoming voice — no colored edge;
       the response chapter builds directly beneath it. */
    #book .ask {
      background: var(--paper-tint); border-radius: 8px;
      padding: 10px 14px; margin: 8px 0 6px;
    }
    #book .ask .alabel { font: 600 9.5px var(--bkmono); letter-spacing: .13em; color: var(--paper-45); }
    #book .ask .atext { font: 14px/1.7 var(--serif); color: var(--paper); margin-top: 4px; }
    #book .ask .atext > :first-child { margin-top: 0; }
    #book .ask .atext > :last-child { margin-bottom: 0; }
    #book .ask.clamped .atext {
      display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden;
    }
    #book .amore {
      font: 10.5px var(--bkmono); color: var(--paper-45); cursor: pointer;
      margin-top: 4px; display: inline-block; background: none; border: none; padding: 0;
    }
    #book .amore:hover { color: var(--paper-72); }

    #book .story { font: 14.5px/1.85 var(--serif); color: var(--paper-72); margin: 10px 0 0; }
    #book .story b, #book .story strong { color: var(--paper); font-weight: 600; }
    #book .story code {
      font: 12px var(--bkmono); background: var(--ink-2); border: 1px solid var(--edge);
      padding: 1px 5px; border-radius: 4px; color: var(--paper);
    }
    #book .story a { color: var(--phosphor); }

    /* Clickable URLs / file paths in transcript prose (renderMarkdown's .tlink
       anchors). Calm by default — phosphor, no underline until hover — with a
       small "open" glyph (.tlink-open) that only fades in on hover so prose
       stays quiet. Styled for both surfaces (#book paper + #transcript). */
    .tlink {
      color: var(--phosphor); text-decoration: none; cursor: pointer;
      border-radius: 3px;
    }
    .tlink:hover { text-decoration: underline; }
    .tlink:focus-visible { outline: 1px solid var(--phosphor); outline-offset: 1px; }
    .tlink-open {
      display: inline-block; opacity: 0; font-size: 0.85em;
      margin-left: 0.15em; vertical-align: baseline;
      transition: opacity 0.12s ease;
    }
    .tlink:hover .tlink-open, .tlink:focus-visible .tlink-open { opacity: 0.8; }

    #book .story > :first-child { margin-top: 0; }
    #book .story > :last-child { margin-bottom: 0; }

    /* Markdown BLOCK structure inside the book's two prose surfaces — narration
       (.story) and the ask card (.ask .atext). renderMarkdown emits real
       <p>/<br>/<ul>/<ol>/<pre>/<blockquote>/<h*>; the book surface is
       deliberately not vscode-themed, so without these rules those blocks fall
       back to inconsistent UA defaults and read as one run-on wall. Style them
       as distinct, spaced blocks so line breaks, lists, and code fences stay
       legible (mirrors what #transcript already does, themed for dark paper). */
    #book .story p, #book .ask .atext p { margin: 0 0 8px; }
    #book .story ul, #book .story ol,
    #book .ask .atext ul, #book .ask .atext ol { margin: 6px 0 8px; padding-left: 20px; }
    #book .story li, #book .ask .atext li { margin: 3px 0; }
    #book .story li::marker, #book .ask .atext li::marker { color: var(--paper-45); }
    #book .story pre, #book .ask .atext pre {
      margin: 8px 0; padding: 10px 12px; border-radius: 6px;
      background: var(--ink-2); border: 1px solid var(--edge);
      overflow-x: auto; white-space: pre;
      font: 12px/1.55 var(--bkmono); color: var(--paper);
    }
    /* A fenced block's <code> must shed the inline-code chip styling above. */
    #book .story pre code, #book .ask .atext pre code {
      background: none; border: 0; padding: 0; border-radius: 0;
      font: inherit; color: inherit;
    }
    #book .story blockquote, #book .ask .atext blockquote {
      margin: 8px 0; padding-left: 12px; color: var(--paper-45);
      border-left: 2px solid var(--edge);
    }
    #book .story h1, #book .story h2, #book .story h3,
    #book .story h4, #book .story h5, #book .story h6,
    #book .ask .atext h1, #book .ask .atext h2, #book .ask .atext h3,
    #book .ask .atext h4, #book .ask .atext h5, #book .ask .atext h6 {
      font: 600 15px/1.35 var(--serif); color: var(--paper); margin: 12px 0 4px;
    }
    /* Tables read as LIGHT horizontal rules on the book surface — a hairline
       between rows and a slightly firmer one under the header, no column grid
       or outer box. display:block + max-content + overflow-x lets a wide table
       scroll horizontally (contained to the book column) instead of squashing
       or wrapping its cells. */
    #book .story table, #book .ask .atext table {
      display: block; width: max-content; max-width: 100%; overflow-x: auto;
      border-collapse: collapse; margin: 10px 0; font: 13px/1.5 var(--bkmono);
    }
    #book .story th, #book .story td,
    #book .ask .atext th, #book .ask .atext td {
      padding: 5px 16px 5px 0; text-align: left; vertical-align: top;
      white-space: nowrap; border-bottom: 1px solid var(--edge);
    }
    #book .story th, #book .ask .atext th {
      color: var(--paper); font-weight: 600; border-bottom: 1px solid var(--paper-28);
    }
    #book .story td, #book .ask .atext td { color: var(--paper-72); }
    #book .story tr:last-child td, #book .ask .atext tr:last-child td { border-bottom: none; }

    #book .details {
      font: 10.5px var(--bkmono); color: var(--paper-45); margin-top: 12px;
      cursor: pointer; display: inline-block; background: none; border: none; padding: 0;
    }
    #book .details:hover { color: var(--paper-72); }
    #book .details::before { content: "$ "; color: var(--phosphor); }
    #book .steps-body { margin-top: 8px; padding-left: 0; }
    #book .steps-body[hidden] { display: none; }
    /* The steps drawer reuses the transcript's own tool/reasoning/activity
       disclosure cards, but on the book surface they must read as QUIET ROWS on
       paper — hairline dividers, mono chrome, a phosphor check — not the boxed
       vscode-themed cards the transcript draws. Everything below re-skins those
       reused nodes for the paper/phosphor palette. */
    #book .steps-body details.tool,
    #book .steps-body details.reasoning {
      background: none; border: none; border-radius: 0;
      border-bottom: 1px solid var(--edge); padding: 5px 2px;
    }
    #book .steps-body > details.tool:last-child,
    #book .steps-body > details.reasoning:last-child,
    #book .steps-body > details.activity:last-child { border-bottom: none; }
    /* A group is the one box that stays — a faint tinted card holding its run of
       steps — so the tree of children reads as one unit. */
    #book .steps-body details.activity {
      background: var(--paper-tint); border: 1px solid var(--edge);
      border-radius: 7px; padding: 4px 10px; margin: 4px 0;
    }
    #book .steps-body details.reasoning > summary,
    #book .steps-body details.tool > summary,
    #book .steps-body details.activity > summary {
      font: 11.5px var(--bkmono); color: var(--paper-45);
    }
    #book .steps-body .seg-label { color: var(--paper-72); font-family: var(--bkmono); }
    #book .steps-body details[open] > summary > .seg-label { color: var(--paper); }
    /* The ✓ is phosphor (a settled step), a failure is a quiet clay ✗. */
    #book .steps-body .seg-badge.badge-ok { color: var(--phosphor); opacity: 1; }
    #book .steps-body .seg-badge.badge-error { color: #cf8b73; }
    /* The live step's dot pulses in phosphor, matching the book's live cursor. */
    #book .steps-body .seg-dot { background: var(--phosphor); }
    #book .steps-body .seg-elapsed { color: var(--paper-45); }
    /* A findable-but-quiet chevron affordance, rotating open like the fold's. */
    #book .steps-body .seg-chev { color: var(--paper-28); opacity: 1; }
    #book .steps-body summary:hover > .seg-chev { color: var(--paper-72); }
    #book .steps-body .act-children { border-left-color: var(--edge); }
    #book .steps-body .reasoning-body { color: var(--paper-45); }
    #book .steps-body .tool-field-label { color: var(--paper-45); }
    #book .steps-body .tool-args,
    #book .steps-body .tool-result {
      background: var(--ink); border: 1px solid var(--edge); border-radius: 5px;
      color: var(--paper-72); font-family: var(--bkmono);
    }
    #book .steps-body .tool-io-open { color: var(--phosphor); }
    #book .steps-body .tool-io-clamped { border-bottom-color: var(--edge); }
    #book .notices { margin-top: 10px; }
    /* The plan notice re-themed for the paper surface: the structural rules
       (grid, hanging indent, progress track) are shared with the timeline —
       only the state colours swap from VS Code tokens to the book palette, by
       re-binding the same --plan-* vars the base .seg.plan rules read. */
    #book .seg.plan {
      --plan-accent: var(--phosphor);
      --plan-muted: var(--paper-45);
      --plan-faint: var(--paper-28);
      --plan-error: #cf8b73;
      --plan-track: var(--paper-45);
    }
    #book .seg.plan .plan-head { color: var(--paper-72); }

    /* Pop-out affordance: a small hover button on a WIDE narration block (table
       or fenced code) to open it in a full read-only editor tab, for content
       too wide for the book column. */
    #book .book-block { position: relative; margin: 8px 0; }
    #book .book-block > pre, #book .book-block > table { margin: 0; }
    #book .block-popout {
      position: absolute; top: 5px; right: 5px; z-index: 1;
      font: 11px/1 var(--bkmono); padding: 3px 6px; border-radius: 5px;
      background: var(--ink-2); border: 1px solid var(--edge); color: var(--paper-45);
      cursor: pointer; opacity: 0; transition: opacity .12s, color .12s, border-color .12s;
    }
    #book .book-block:hover .block-popout,
    #book .block-popout:focus-visible { opacity: 1; }
    #book .block-popout:hover { color: var(--phosphor); border-color: var(--phosphor); }

    /* Live chapter: the blinking phosphor block cursor + the "$ now:" ticker. */
    #book .cursor {
      display: inline-block; width: 8px; height: 15px; border-radius: 2px;
      background: var(--phosphor); vertical-align: -2px; margin-left: 3px;
      animation: agentproto-blink 1.1s steps(1) infinite;
    }
    @keyframes agentproto-blink { 50% { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) {
      #book .cursor { animation: none; }
      #book .under { transition: none; }
    }
    #book .under {
      font: 10.5px var(--bkmono); color: var(--paper-45); margin-top: 12px;
      /* Label swaps fade old -> new instead of snapping (NOW_FADE_MS in the
         script drives the classes; the ticker never re-fades a same label). */
      transition: opacity 220ms ease;
    }
    #book .under::before { content: "$ "; color: var(--phosphor); }
    #book .under b { color: var(--paper-72); font-weight: 500; }
    #book .under.fading-out { opacity: 0; }
    #book .under.fading-in { opacity: 1; }

    /* The pause: the inverted PAPER card when the agent stops to ask. */
    #book .pause {
      margin: 22px 0 4px; background: var(--paper); color: var(--ink);
      border-radius: 10px; padding: 16px 18px;
    }
    #book .pause .phead {
      font: 700 10px var(--bkmono); letter-spacing: .14em;
      display: flex; align-items: center; gap: 8px;
    }
    #book .pause .phead .blk { width: 9px; height: 14px; border-radius: 2px; background: var(--phosphor); }
    #book .pause .pquestion { font: 14px/1.7 var(--serif); margin-top: 8px; }
    /* The pause question is the last rendered assistant narration block.
       Keep its Markdown structure (rather than flattening it to text) while
       adapting the normal paper-surface prose treatment to this light card. */
    #book .pause .pquestion > :first-child { margin-top: 0; }
    #book .pause .pquestion > :last-child { margin-bottom: 0; }
    #book .pause .pquestion p { margin: 0 0 8px; }
    #book .pause .pquestion ul, #book .pause .pquestion ol { margin: 6px 0 8px; padding-left: 20px; }
    #book .pause .pquestion li { margin: 3px 0; }
    #book .pause .pquestion li::marker { color: var(--phosphor); }
    #book .pause .pquestion strong, #book .pause .pquestion b { font-weight: 650; }
    #book .pause .pquestion code {
      font: 12px var(--bkmono); background: var(--ink-2); border: 1px solid var(--edge);
      padding: 1px 5px; border-radius: 4px; color: var(--paper);
    }
    #book .pause .pquestion pre {
      margin: 8px 0; padding: 10px 12px; border-radius: 6px;
      background: var(--ink-2); border: 1px solid var(--edge);
      overflow-x: auto; white-space: pre; font: 12px/1.55 var(--bkmono); color: var(--paper);
    }
    #book .pause .pquestion pre code {
      background: none; border: 0; padding: 0; border-radius: 0; font: inherit; color: inherit;
    }
    #book .pause .pquestion blockquote {
      margin: 8px 0; padding-left: 12px; color: rgba(27,27,28,.72); border-left: 2px solid var(--phosphor);
    }
    #book .pause .pquestion h1, #book .pause .pquestion h2, #book .pause .pquestion h3,
    #book .pause .pquestion h4, #book .pause .pquestion h5, #book .pause .pquestion h6 {
      font: 650 15px/1.35 var(--serif); margin: 12px 0 4px;
    }
    #book .pause .pquestion table {
      display: block; width: max-content; max-width: 100%; overflow-x: auto;
      border-collapse: collapse; margin: 10px 0; font: 13px/1.5 var(--bkmono);
    }
    #book .pause .pquestion th, #book .pause .pquestion td {
      padding: 5px 16px 5px 0; text-align: left; vertical-align: top;
      white-space: nowrap; border-bottom: 1px solid rgba(27,27,28,.16);
    }
    #book .pause .pquestion th { font-weight: 650; border-bottom-color: rgba(27,27,28,.32); }
    #book .pause .pquestion tr:last-child td { border-bottom: none; }
  </style>
  ${bundles.xtermCss ? `<style>${bundles.xtermCss}</style>` : ""}
</head>
<body>
  <span id="harness-watermark" aria-hidden="true"></span>
  <div id="header">
    <div id="header-left">
      <span id="header-icon" title="" aria-hidden="true"></span>
      <span id="title-status" class="tstatus" title=""></span>
      <div id="header-title-block">
        <div id="header-title" title="Click to rename this session"></div>
        <div id="header-subtitle" title=""></div>
      </div>
    </div>
    <div id="header-actions">
      <div id="view-toggle" class="segmented" role="group" aria-label="View" hidden>
        <button type="button" data-view="book" title="Read as a book">Book</button>
        <button type="button" data-view="transcript" title="Read the raw transcript">Transcript</button>
      </div>
      <div class="header-action metrics-pill">
        <button id="cost-btn" class="header-btn" type="button" aria-haspopup="true"></button>
        <span class="metrics-sep" aria-hidden="true">·</span>
        <div id="cost-popover" class="popover" hidden>
          <div class="popover-row"><span class="popover-label">Tokens in</span><span id="popover-tokens-in"></span></div>
          <div class="popover-row"><span class="popover-label">Tokens out</span><span id="popover-tokens-out"></span></div>
          <div class="popover-row"><span class="popover-label">Model</span><span id="popover-model"></span></div>
          <div class="popover-row"><span class="popover-label">Harness</span><span id="popover-harness"></span></div>
          <div class="popover-row"><span class="popover-label">Access</span><span id="popover-auth"></span></div>
        </div>
        <button id="context-btn" class="header-btn ctx-gauge" type="button" aria-haspopup="true" title="Context window usage" hidden>
          <svg class="ctx-ring" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <circle class="ctx-track" cx="8" cy="8" r="6" fill="none" stroke-width="2"></circle>
            <circle id="ctx-arc" class="ctx-arc" cx="8" cy="8" r="6" fill="none" stroke-width="2" stroke-linecap="round" transform="rotate(-90 8 8)" stroke-dasharray="0 100"></circle>
          </svg>
          <span id="ctx-pct" class="ctx-pct"></span>
        </button>
        <div id="context-popover" class="popover" hidden>
          <div class="popover-row"><span class="popover-label">Used</span><span id="popover-context-used"></span></div>
          <div class="popover-row"><span class="popover-label">Size</span><span id="popover-context-size"></span></div>
        </div>
      </div>
      <button id="open-terminal-btn" class="header-action term-btn" type="button" title="Open a real VS Code terminal for this session" hidden>
        <span class="term-glyph" aria-hidden="true">&gt;_</span>Terminal
      </button>
    </div>
  </div>
  <div id="bg-chips" hidden></div>
  <div id="transcript"><div id="empty">Loading transcript…</div></div>
  <div id="book" hidden></div>
  <div id="pty-view"></div>
  <div id="blocked-note" hidden><span id="blocked-note-text"></span><button id="blocked-note-dismiss" title="Dismiss">✕</button></div>
  <div id="working" hidden>
    <span id="working-glyph">✳</span>
    <span id="working-text"></span>
  </div>
  <div id="input-area">
    <div id="error-banner" hidden>
      <span id="eb-icon">&#9888;</span>
      <div id="eb-body">
        <div id="eb-title"></div>
        <div id="eb-message"></div>
      </div>
      <button id="eb-dismiss" title="Dismiss">✕</button>
    </div>
    <div id="info-banner" hidden>
      <span id="ib-icon">&#9432;</span>
      <div id="ib-body">
        <div id="ib-text"></div>
      </div>
      <button id="ib-dismiss" title="Dismiss">✕</button>
    </div>
    <div id="queued" hidden>
      <span id="queued-icon">&#9203;</span>
      <span id="queued-label"></span>
      <button id="queued-cancel" title="Discard the queued message">✕</button>
    </div>
    <div id="composer">
      <div id="mention-popup" hidden></div>
      <div id="composer-attachments" hidden></div>
      <textarea id="input" rows="1" placeholder="Reply to the agent… (paste, drop, or @-mention a file)"></textarea>
      <div id="composer-bar">
        <span id="composer-meta">
          <span id="composer-harness" class="composer-chip dimmed" title="Harness can't be switched on a live session — start a new one to change it"></span>
          <button id="composer-model" class="composer-chip composer-chip-btn" type="button" title="Switch model"></button>
          <button id="composer-effort" class="composer-chip composer-chip-btn" type="button" title="Switch effort"></button>
          <button id="composer-posture" class="composer-chip composer-chip-btn" type="button" title="Switch mode / posture"></button>
          <button id="composer-route" class="composer-chip composer-chip-btn" type="button" title="Switch route (restarts the session — conversation carries over)"></button>
          <button id="composer-auth" class="composer-chip composer-chip-btn" type="button" title="Switch wallet (restarts the session — conversation carries over)"></button>
        </span>
        <span id="send-hint" class="send-hint">⏎ send · ⇧⏎ newline</span>
        <span id="send-status"></span>
        <button id="interrupt-send" hidden title="Interrupt the current turn and send the queued message now">Interrupt &amp; send</button>
        <button id="restart-btn" hidden title="Restart this session — resumes the conversation in a new session">↻ Restart</button>
        <button id="send" title="Send (Enter)">↵</button>
        <button id="stop" hidden title="Stop the current turn">■</button>
      </div>
    </div>
  </div>
  ${bundles.xtermJs ? `<script nonce="${nonce}">${bundles.xtermJs}</script>` : ""}
  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();
      // Interpolated from the host's TOOL_IO_MAX_LINES, which is what actually
      // performs the clamp — the two can never disagree about how many lines
      // are on screen, so "N more" is always arithmetic the user can trust.
      const MAX_IO_LINES = ${TOOL_IO_MAX_LINES};
      // Attachment caps — interpolated from attachments.logic.ts so the webview
      // and the host can never disagree about the limits (same reasoning as
      // MAX_IO_LINES above).
      const MAX_ATTACHMENT_BYTES = ${MAX_ATTACHMENT_BYTES};
      const WARN_ATTACHMENT_BYTES = ${WARN_ATTACHMENT_BYTES};
      const ATTACHMENT_COUNT_CAP = ${ATTACHMENT_COUNT_CAP};
      // Interpolated from conversationBook.logic.ts so the injected buildBook
      // (and its helpers) resolve the SAME literals their unit tests pin.
      const ASK_LONG_CHARS = ${ASK_LONG_CHARS};
      const TITLE_MAX_CHARS = ${TITLE_MAX_CHARS};
      const INITIAL_ICON_SVG = ${JSON.stringify(bundles.headerIconSvg ?? "")};
      // Injected by value from the tested logic modules — see buildHtml.
      ${injectedHelpers}
      const headerIcon = document.getElementById('header-icon');
      const harnessWatermark = document.getElementById('harness-watermark');
      const titleStatus = document.getElementById('title-status');
      const headerTitle = document.getElementById('header-title');
      const headerSubtitle = document.getElementById('header-subtitle');
      const openTerminalBtn = document.getElementById('open-terminal-btn');
      const costBtn = document.getElementById('cost-btn');
      const costPopover = document.getElementById('cost-popover');
      const popoverTokensIn = document.getElementById('popover-tokens-in');
      const popoverTokensOut = document.getElementById('popover-tokens-out');
      const popoverModel = document.getElementById('popover-model');
      const popoverHarness = document.getElementById('popover-harness');
      const popoverAuth = document.getElementById('popover-auth');
      const contextBtn = document.getElementById('context-btn');
      const contextPopover = document.getElementById('context-popover');
      const ctxArc = document.getElementById('ctx-arc');
      const ctxPct = document.getElementById('ctx-pct');
      const popoverContextUsed = document.getElementById('popover-context-used');
      const popoverContextSize = document.getElementById('popover-context-size');
      const blockedNote = document.getElementById('blocked-note');
      const bgChips = document.getElementById('bg-chips');
      const transcript = document.getElementById('transcript');
      const book = document.getElementById('book');
      const viewToggle = document.getElementById('view-toggle');
      const working = document.getElementById('working');
      const workingText = document.getElementById('working-text');
      const composer = document.getElementById('composer');
      const composerHarness = document.getElementById('composer-harness');
      const composerModel = document.getElementById('composer-model');
      const composerEffort = document.getElementById('composer-effort');
      const composerRoute = document.getElementById('composer-route');
      const composerPosture = document.getElementById('composer-posture');
      const composerAuth = document.getElementById('composer-auth');
      const input = document.getElementById('input');
      const sendBtn = document.getElementById('send');
      const stopBtn = document.getElementById('stop');
      const interruptBtn = document.getElementById('interrupt-send');
      const restartBtn = document.getElementById('restart-btn');
      const sendStatus = document.getElementById('send-status');
      const errorBanner = document.getElementById('error-banner');
      const ebTitle = document.getElementById('eb-title');
      const ebMessage = document.getElementById('eb-message');
      const ebDismiss = document.getElementById('eb-dismiss');
      const infoBanner = document.getElementById('info-banner');
      const ibText = document.getElementById('ib-text');
      const ibDismiss = document.getElementById('ib-dismiss');
      const blockedNoteText = document.getElementById('blocked-note-text');
      const blockedNoteDismiss = document.getElementById('blocked-note-dismiss');
      const queuedRow = document.getElementById('queued');
      const queuedLabel = document.getElementById('queued-label');
      const queuedCancel = document.getElementById('queued-cancel');
      const attachmentsRow = document.getElementById('composer-attachments');
      const mentionPopup = document.getElementById('mention-popup');
      const ptyView = document.getElementById('pty-view');

      // Mirrors STALL_AFTER_MS in views/sessionsTree.logic.ts — the tree and
      // this panel must not disagree about whether a session is stalled.
      const STALL_AFTER_MS = 10 * 60 * 1000;
      // A different, much shorter signal — not a replacement for the stall
      // check above. Almost every blocked-on-tool note clears in a second or
      // two, so showing it instantly just flashes; only a block that outlasts
      // this delay is worth a note in the conversation body.
      const BLOCKED_NOTE_DELAY_MS = 20 * 1000;
      // The "$ now:" line's staleness cutoff. A pending step that outlives
      // this has almost certainly never resolved — the agent went quiet,
      // usually because it handed off to a child session (supervising an
      // executor) and stopped emitting its own [tool] markers. Past this age
      // the line stops trusting the transcript's frozen last action and leans
      // on the daemon's own activitySummary (or an explicit supervision label).
      const NOW_STALE_MS = 30 * 1000;
      // Progressive "$ now:" timer thresholds — see nowSuffix/renderNow.
      const NOW_NO_TIME_MS = 5 * 1000;
      const NOW_SECONDS_MS = 60 * 1000;
      const NOW_LONG_RUNNING_MS = 90 * 1000;
      const NOW_DOT_CYCLE_MS = 600; // "Still working…" dot cycle
      // "$ now:" fade-out/in length — see the .under CSS transition.
      const NOW_FADE_MS = 220;
      // Minimum time a given label stays on screen. Rapid sequential tool
      // calls would otherwise strobe the line; this holds the previous label
      // in place until it has been up at least this long.
      const NOW_MIN_DISPLAY_MS = 500;

      // "$ now:" fade/debounce state — see renderNow. shownNowLabel is the
      // label currently ON SCREEN; pendingNowLabel is one whose swap is already
      // scheduled (a mid-window re-render coalesces into it instead of stacking
      // timers); nowSwapToken invalidates stale timers when a "Still working…"
      // state or a hide cancels a pending fade.
      let shownNowLabel = null;
      let shownNowSwapAt = 0;
      let pendingNowLabel = null;
      let nowSwapToken = 0;

      let exited = false;
      let busy = false;
      /** Wall-clock ms when the current turn's blockedOn note started being
       *  true (0 when not currently blocked) — see refreshBlockedNote. */
      let blockedSince = 0;
      /** The (blockedOn, toolCallId) pair the user dismissed — hidden until a
       *  DIFFERENT pair arrives. Cleared when the block clears. */
      let dismissedBlockedKey = null;
      /** Wall-clock ms when the current turn started (0 when idle). */
      let busySince = 0;
      let lastTokensOut;
      /** Latest descriptor — re-read by the 1s ticker so a stall surfaces without a poll. */
      let lastSession;
      /** True while the in-place header rename box is open — see beginTitleEdit.
       *  Guards updateHeader from wiping the input on a mid-edit sessionUpdate. */
      let isEditingTitle = false;
      /**
       * Text typed while the agent was mid-turn. The daemon takes ONE turn at
       * a time and rejects anything else with a 409, so instead of firing that
       * at the user we hold the message here and flush it the moment the turn
       * ends — or immediately, if they choose to interrupt.
       */
      let queuedText = null;
      // PTY-mode state (live xterm.js view fed by the host-side WS bridge).
      let ptyTerm = null;
      let ptyFitAddon = null;
      let ptyExited = false;
      let ptyResizeTimer = null;
      let ptyStatusBanner = null;
      // Prompt history for Up/Down (history.logic.ts). Seeded from init's
      // history field (raw user-prompt texts, oldest to newest); extended
      // locally by send() from then on.
      let historyState = { entries: [], index: null, draft: '' };
      // Pending attachments: { path, label }. Their paths are appended to the
      // prompt by composePrompt() at send time, so the queue keeps storing a
      // plain string and nothing here has to survive a mid-turn queue.
      let attachments = [];
      // Active @mention: { start, end, query, items, active } or null. start/end
      // bracket the @token in the textarea so a selection replaces exactly it;
      // active is the index of the highlighted item.
      let mention = null;
      let isScrolledUp = false;
      let isSending = false;
      /** True from the Stop click until the turn actually settles (busy goes
       *  false) or a stopError comes back — guards against a double-click
       *  firing a second interrupt at an already-cancelling turn. */
      let isStopping = false;
      let isRestarting = false;
      let mode = 'raw';
      // Cached copy of the current session's resume chain (oldest-first, see
      // protocol.ts's init.resumeChain doc) so a full-transcript reset
      // (clearTranscript, below) can repaint the SAME static ancestor block
      // it would otherwise wipe — #resume-history now lives INSIDE
      // #transcript (one continuous scroll region), so a blind
      // transcript.innerHTML reset erases it without this.
      let lastResumeChain = null;
      let lastUsage;
      // Turns/segments are addressed by stable id (data-turn-id/data-seg-id)
      // and patched in place — a live update never tears the DOM down, so
      // expand/collapse state and text selection survive for free.
      // Pending tool/activity rows whose elapsed-time label ticks
      // independently of any patch. Keyed by the DOM NODE, not the seg id, so
      // the same pending step can appear in BOTH the transcript timeline and
      // the book's step drawer at once (they share seg ids) and each node ticks
      // its own label — a seg-id key would let one view clobber the other's
      // ticker. Value: { startedMs, label, node }.
      const pendingTools = new Map();
      // Still-running run_in_background tool calls (#background-tasks-ux) —
      // segId -> { toolName }. Keyed by seg id (not DOM node, unlike
      // pendingTools above) because the chip strip shows ONE chip per
      // background task regardless of whether its segment is currently
      // painted in the transcript, the book's step drawer, or both.
      const bgTasks = new Map();

      // ── Book (chapter) view state ──────────────────────────────────
      // The book is a fold ABOVE the turn/segment timeline: it reuses the
      // SAME presented turns (accumulated here from init + patch) and the SAME
      // step renderer, and only groups them into chapters. It's the default
      // for a structured session; the header 'transcript' toggle flips back to
      // the raw turn rendering (#transcript), which is left fully intact.
      const bookTurns = new Map();      // turnId -> PresentedTurn (insertion order preserved)
      const bookChapterNodes = new Map(); // chapterId -> chapter DOM node
      // The user's explicit fold choices, so a live patch never overrides a
      // chapter they opened/closed by hand. A chapter absent from both keeps
      // the default (newest open, the rest folded).
      const bookOpened = new Set();
      const bookClosed = new Set();
      // Chapter ids whose ask card the user expanded ("$ full message") — so a
      // live re-render doesn't re-clamp a message they chose to read in full.
      const bookAskExpanded = new Set();
      // Plan-block expansion state (#conversation-chrome), keyed by plan segment
      // id so a live re-render keeps whatever the user opened: the collapsed
      // "✓ N done" summary and the "+N more" upcoming tail.
      const planDoneOpen = new Set();
      const planMoreOpen = new Set();
      let bookScrolledUp = false;
      // Book is the default view for a structured session; persisted per panel
      // (webview state is already scoped to this session) so the choice sticks.
      let bookView = true;
      try {
        const st = vscode.getState && vscode.getState();
        if (st && typeof st.bookView === 'boolean') bookView = st.bookView;
      } catch (e) { /* no persisted state yet */ }
      const DEFAULT_PLACEHOLDER = input.getAttribute('placeholder') || '';
      const BOOK_PLACEHOLDER = 'write back — your message opens the next chapter…';

      // Grow with the text instead of forcing the user to drag a resize
      // handle, up to the CSS max-height (then the textarea scrolls).
      function autoGrow() {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 200) + 'px';
      }

      // Single source of truth for every composer affordance. Each control
      // reflects what the session can ACTUALLY do right now: no sending to a
      // dead session, no killing an already-dead one, no interrupting an agent
      // that isn't working.
      function refreshComposer() {
        // An attachment alone is sendable — "here, look at this" with no words.
        const hasText = Boolean(input.value.trim()) || attachments.length > 0;
        const live = !exited && !isSending;
        input.disabled = !live;
        sendBtn.disabled = !live || !hasText;
        sendBtn.classList.toggle('has-text', hasText && live);
        // Send/Stop are mutually exclusive: mid-turn, there is nothing to
        // send (Enter queues instead — see send()), so the button that
        // fires is Stop, not Send.
        sendBtn.hidden = busy && !exited;
        stopBtn.hidden = !busy || exited;
        stopBtn.disabled = isStopping;
        // "Interrupt & send" exists to force a message the agent hasn't taken
        // yet — so it appears only when there IS one waiting, not merely
        // whenever the agent is busy.
        interruptBtn.hidden = queuedText === null || exited;
        interruptBtn.disabled = !live;
        // The one useful action left once a session has exited — shown
        // beside the now-disabled input rather than replacing it, so the
        // last message typed (if any) stays visible instead of vanishing.
        restartBtn.hidden = !exited;
        restartBtn.disabled = isRestarting;
        if (isRestarting) restartBtn.textContent = 'Restarting\\u2026';
        else restartBtn.textContent = '\\u21bb Restart';
        composer.classList.toggle('disabled', exited);
        renderQueued();
      }

      function renderQueued() {
        queuedRow.hidden = queuedText === null;
        if (queuedText === null) return;
        // \\s, not \s: this script lives in a template literal, where an
        // unrecognised escape collapses to its own letter — /\s+/ would ship
        // as /s+/ and blank out every "s" in the user's message.
        const oneLine = queuedText.replace(/\\s+/g, ' ').trim();
        const clipped = oneLine.length > 90 ? oneLine.slice(0, 90) + '…' : oneLine;
        queuedLabel.textContent = 'Queued · ' + clipped;
        queuedRow.title = queuedText;
      }

      function showError(title, message) {
        ebTitle.textContent = title;
        ebMessage.textContent = message;
        errorBanner.hidden = false;
      }

      function clearError() {
        errorBanner.hidden = true;
        ebMessage.textContent = '';
      }

      // ── Cross-session info banner (E3) ─────────────────────────────
      // The transient informational twin of the error banner. One slot:
      // currentInfoBannerId tracks what's up so a same-id message replaces
      // (never stacks) and a dismissInfoBanner only hides a matching id.
      // User-dismissed ids are remembered so a re-post of the SAME id (a
      // still-true state re-announced) doesn't fight the user's choice — but
      // a NEW occurrence carries a new id (the controller mints one per
      // event), which shows again.
      let currentInfoBannerId = null;
      const dismissedInfoBannerIds = new Set();

      function showInfoBanner(id, text, tooltip) {
        if (dismissedInfoBannerIds.has(id) && currentInfoBannerId !== id) return;
        currentInfoBannerId = id;
        ibText.textContent = text;
        if (tooltip) infoBanner.title = tooltip; else infoBanner.removeAttribute('title');
        infoBanner.hidden = false;
      }

      function dismissInfoBanner(id, byUser) {
        if (currentInfoBannerId !== id) return;
        currentInfoBannerId = null;
        infoBanner.hidden = true;
        ibText.textContent = '';
        if (byUser) dismissedInfoBannerIds.add(id);
      }

      /** Hand the queued text to the agent, optionally cutting its turn short. */
      function flushQueued(interrupt) {
        if (queuedText === null) return;
        const text = queuedText;
        queuedText = null;
        renderQueued();
        vscode.postMessage({ type: interrupt ? 'interruptSend' : 'send', text: text });
        refreshComposer();
      }

      // "busy" said nothing: it covered an agent writing a reply and an agent
      // wedged for 20h alike. working/waiting/stalled differ in what the user
      // should DO, so they get three words — this is the only remaining
      // renderer of that vocabulary now that the header's status chip is gone:
      //   working — generating right now. Wait.
      //   waiting — mid-turn but parked on a background command/sub-agent
      //             (blockedOn). It is not the model that is slow.
      //   stalled — mid-turn and silent past STALL_AFTER_MS. Nothing is
      //             coming; the agent stopped emitting without a turn-end and
      //             the daemon is still awaiting a turn that will never end.
      // Plus how long and how much — the three things a user waiting on a
      // reply actually wants, without expanding anything.
      function refreshWorking() {
        // The book view carries the live "Working…" state inside its own live
        // chapter (title + "$ now:" line), so this separate row is pure
        // redundancy there — a second working bar stacked above the composer.
        // Hide it in book view; keep it for the raw transcript, where nothing
        // else narrates the in-flight turn (and its stall warning earns its
        // place). The text is still computed so a view switch shows it current.
        const inBook = bookView && bookApplies();
        working.hidden = !busy || inBook;
        if (!busy) return;
        const now = Date.now();
        const silent = lastSession ? silentForMs(lastSession, now) : undefined;
        const stalled = silent !== undefined && silent > STALL_AFTER_MS;
        // A stalled session must not keep saying "Working…" with a cheerfully
        // climbing counter — that IS the lie the user reported. Name the
        // silence instead and let them judge.
        working.classList.toggle('stalled', stalled);
        if (stalled) {
          workingText.textContent = 'Stalled · no output for ' + formatDuration(silent) +
            ' · the agent may be stuck';
          return;
        }
        const parts = [lastSession && lastSession.blockedOn
          ? 'Waiting on ' + lastSession.blockedOn + '…'
          : 'Working…'];
        if (busySince) parts.push(Math.max(0, Math.round((now - busySince) / 1000)) + 's');
        if (typeof lastTokensOut === 'number') parts.push(lastTokensOut + ' tokens');
        workingText.textContent = parts.join(' · ');
      }

      function applySession(session) {
        lastSession = session;
        updateHeader(session);
        exited = isTerminal(session);
        // A terminal session is never busy, whatever the descriptor says — see
        // isTerminal. Without this a killed session spins the working row forever.
        const nowBusy = !exited && Boolean(session.busy);
        if (nowBusy && !busy) busySince = Date.now();
        if (!nowBusy) busySince = 0;
        const wasBusy = busy;
        busy = nowBusy;
        // The turn is over (however it ended) — Stop's job is done.
        if (wasBusy && !nowBusy) isStopping = false;
        if (typeof session.tokensOut === 'number') lastTokensOut = session.tokensOut;
        refreshComposer();
        refreshWorking();
        refreshBlockedNote();
        // The turn just ended — the daemon will accept a prompt again, so hand
        // over whatever was typed during it. This is the whole point of the
        // queue: the user types when they think of it, not when the agent is ready.
        if (wasBusy && !nowBusy && !exited && queuedText !== null) flushQueued(false);
        // The book's live chapter, pause card, and "$ now:" line derive from
        // session state, so repaint them on any descriptor change.
        renderBook();
      }

      function setSending(sending, note) {
        isSending = sending;
        refreshComposer();
        sendStatus.textContent = sending ? (note || 'Sending…') : '';
      }

      // A terminal session is over: whatever busy/blockedOn still say about an
      // in-flight turn is stale by definition, so status wins over both.
      function isTerminal(session) {
        return ['exited', 'killed', 'error'].indexOf(session.status) !== -1;
      }

      /** ms since the session last did ANYTHING, while mid-turn. */
      function silentForMs(session, now) {
        if (!session.busy || isTerminal(session)) return undefined;
        const iso = session.lastActivityAt || session.lastOutputAt;
        if (!iso) return undefined;
        const last = Date.parse(iso);
        if (isNaN(last)) return undefined;
        return Math.max(0, now - last);
      }

      function formatDuration(ms) {
        const seconds = Math.floor(ms / 1000);
        if (seconds < 60) return seconds + 's';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return minutes + 'min';
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return hours + 'h';
        return Math.floor(hours / 24) + 'd';
      }

      // blockedOn describes an IN-FLIGHT turn, so only claim it while the
      // session is actually taking one. A session killed mid-tool-call keeps
      // a stale blockedOn/busy forever (the daemon clears them in the turn's
      // finally, which never runs for a generator that is never resumed), and
      // rendering that verbatim told the user a dead session was blocked on a
      // command. isTerminal already governs busy/exited elsewhere — this must
      // not contradict it.
      // The book's live "$ now:" line already narrates the in-flight step (in
      // the supervisor case, "Watching executor"), so a separate "blocked on
      // …" note below it is redundant — and a warning-yellow banner for normal
      // long-running command/supervision is exactly the false alarm this commit
      // removes. Suppress the note while that line is visible; it returns when
      // the book is left (raw transcript has no now-line, so the note earns its
      // place there).
      function liveNowLineVisible() {
        if (!bookView || !bookApplies()) return false;
        const live = book.querySelector('.chapter.live .under');
        return Boolean(live && !live.hidden);
      }

      function refreshBlockedNote() {
        const session = lastSession;
        const live = Boolean(session) && !isTerminal(session) && Boolean(session.busy) && Boolean(session.blockedOn);
        if (!live) {
          // The block cleared (or the session exited) — the note hides AND the
          // user's dismissal resets, so the NEXT block shows again.
          blockedSince = 0;
          dismissedBlockedKey = null;
          blockedNote.hidden = true;
          blockedNoteText.textContent = '';
          return;
        }
        if (liveNowLineVisible()) {
          blockedNote.hidden = true;
          blockedNoteText.textContent = '';
          return;
        }
        if (!blockedSince) blockedSince = Date.now();
        // Almost every block clears in a second or two — showing it instantly
        // just flashes and means nothing. Only a block that outlasts the
        // delay is worth a note, and it clears the instant live goes false.
        if (Date.now() - blockedSince < BLOCKED_NOTE_DELAY_MS) {
          blockedNote.hidden = true;
          blockedNoteText.textContent = '';
          return;
        }
        // Dismissal is keyed on the (kind, toolCallId) pair: dismissing hides
        // the note for THIS block, but a different toolCallId (or a different
        // kind) is a new block worth showing again.
        const key = session.blockedOn + ' · ' + (session.pendingToolCallId || '');
        if (dismissedBlockedKey === key) {
          blockedNote.hidden = true;
          return;
        }
        blockedNote.hidden = false;
        blockedNoteText.textContent = 'blocked on ' + session.blockedOn +
          (session.pendingToolCallId ? ' · ' + session.pendingToolCallId.slice(0, 8) : '');
      }

      function renderCostPopover(session) {
        popoverTokensIn.textContent = typeof session.tokensIn === 'number' ? String(session.tokensIn) : '—';
        popoverTokensOut.textContent = typeof session.tokensOut === 'number' ? String(session.tokensOut) : '—';
        popoverModel.textContent = session.model || '—';
        popoverHarness.textContent = session.adapterSlug || '—';
        // The named wallet the session's access axis is bound to (profile
        // label/ref), falling back to the raw auth method — never a secret.
        popoverAuth.textContent = accessIdentity(session);
      }

      // Mirrors sessionDisplayName in client/sessionName.ts — this inline
      // script has no module system to import it from, so the precedence
      // (user-renamed-label, then the derived title, then a spawn label, then a
      // friendly adapter · short-id fallback) is duplicated here (FIX D) and
      // the two must stay in sync. Back-compat: an absent renamedByUser on a
      // labelled session is treated as a user rename (see sessionName.ts).
      function shortSessionId(id) {
        return id && id.length > 8 ? id.slice(-6) : (id || '');
      }
      function displayName(session) {
        const userRenamed = session.renamedByUser ?? session.label !== undefined;
        if (userRenamed && session.label !== undefined) return session.label;
        if (session.title !== undefined) return session.title;
        if (session.label !== undefined) return session.label;
        return (session.adapterSlug || session.kind) + ' · ' + shortSessionId(session.id);
      }

      function updateHeader(session) {
        // Don't stomp the inline rename box mid-edit — a sessionUpdate landing
        // while the user is typing must not wipe what they've entered.
        if (!isEditingTitle) headerTitle.textContent = displayName(session);
        // Subtitle: pid · command/argv for PTY sessions, otherwise hidden.
        if (session.kind === 'terminal' && session.pty === true) {
          const pid = typeof session.pid === 'number' ? session.pid : '—';
          const cmd = session.argv && session.argv.length > 0 ? session.argv.join(' ') : session.command;
          headerSubtitle.textContent = pid + ' · ' + (cmd || '');
          headerSubtitle.title = session.cwd || '';
        } else {
          headerSubtitle.textContent = '';
          headerSubtitle.title = '';
        }
        // The harness mark, left of the name — which agent answers in this
        // tab, at a glance. Prefer the inline SVG icon shipped with the panel;
        // fall back to the unicode glyph when no icon is available.
        if (session.adapterSlug && INITIAL_ICON_SVG) {
          headerIcon.innerHTML = INITIAL_ICON_SVG;
          headerIcon.title = session.adapterSlug;
          harnessWatermark.innerHTML = INITIAL_ICON_SVG;
          harnessWatermark.title = session.adapterSlug;
        } else {
          const mark = harnessGlyph(session.adapterSlug);
          headerIcon.textContent = session.adapterSlug ? mark.glyph : '';
          headerIcon.title = session.adapterSlug ? mark.label : '';
          harnessWatermark.innerHTML = '';
          harnessWatermark.title = '';
        }
        // Plain PTY sessions have no agent model/posture/wallet to configure —
        // hide the composer chips entirely instead of showing "model?" placeholders.
        const isPlainPty = session.kind === 'terminal' && session.pty === true;
        composerHarness.hidden = isPlainPty;
        composerModel.hidden = isPlainPty;
        composerEffort.hidden = isPlainPty;
        composerRoute.hidden = isPlainPty;
        composerPosture.hidden = isPlainPty;
        composerAuth.hidden = isPlainPty;
        if (!isPlainPty) {
          if (session.adapterSlug && INITIAL_ICON_SVG) {
            composerHarness.innerHTML = INITIAL_ICON_SVG;
            var cSvg = composerHarness.querySelector('svg');
            if (cSvg) { cSvg.setAttribute('width', '12'); cSvg.setAttribute('height', '12'); cSvg.style.verticalAlign = 'middle'; }
          } else {
            composerHarness.textContent = session.adapterSlug || '';
          }
          composerHarness.title = session.adapterSlug || '';
          composerModel.textContent = session.model || 'model?';
          // The effort chip only shows when the session carries one — an adapter
          // that has no effort axis leaves the chip empty (:empty hides it).
          composerEffort.textContent = session.effort ? ('effort: ' + session.effort) : '';
          // Route chip only shows when a gateway is pinned (:empty hides it).
          composerRoute.textContent = session.route && session.route.gateway ? ('route: ' + session.route.gateway) : '';
          // Dim when the model has a single valid gateway — nothing to switch to
          // (chip-pickers). Undefined (catalog not loaded yet) leaves it active.
          const routeLocked = session.routeSwitchable === false;
          composerRoute.classList.toggle('dimmed', routeLocked);
          composerRoute.title = routeLocked
            ? 'Only one route is available for this model'
            : 'Switch route (restarts the session — conversation carries over)';
          composerPosture.textContent = defaultPostureLabel(session);
          const auth = accessIdentity(session);
          composerAuth.textContent = auth === '—' ? 'no wallet' : auth;
        }

        // Cost only, on the button — the full in/out breakdown plus what
        // decides the rate (model/harness/auth) lives one click away, in the
        // popover, rather than crowding the header with numbers nobody acts
        // on at a glance.
        // Merged metrics pill (#conversation-chrome): two decimals on the face,
        // full precision on hover.
        costBtn.textContent = formatCostShort(session.costUsd);
        costBtn.title = typeof session.costUsd === 'number' ? '$' + session.costUsd.toFixed(4) : 'No cost recorded yet';
        renderCostPopover(session);
        // Title status dot — the visibility state at a glance.
        if (titleStatus) {
          const st = titleStatusState(session);
          titleStatus.className = 'tstatus ' + st;
          titleStatus.title = st === 'delegating' ? 'Delegating — waiting on its busy subtree'
            : st === 'parked' ? 'Parked — supervised, will be re-prompted'
            : st === 'awaiting' ? 'Awaiting your input'
            : st === 'busy' ? 'Working' : 'Quiet';
        }
      }

      function appendLines(lines) {
        if (!lines || lines.length === 0) return;
        for (const line of lines) {
          const div = document.createElement('div');
          div.className = 'line line-' + (line.stream || 'stdout');
          // Already ANSI-converted and HTML-escaped on the host (webview/ansi.ts).
          // This was textContent, which rendered the daemon's deliberate ANSI
          // colouring as literal escape-code garbage.
          div.innerHTML = line.html || '';
          transcript.appendChild(div);
        }
        if (!isScrolledUp) {
          transcript.scrollTop = transcript.scrollHeight;
        }
      }

      transcript.addEventListener('scroll', function() {
        const threshold = 20;
        isScrolledUp = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop > threshold;
      });

      // ── Structured timeline rendering ──────────────────────────────
      // All html fields are pre-escaped on the extension host; raw daemon
      // text never reaches innerHTML here, and no content is parsed.

      function el(tag, className, text) {
        const e = document.createElement(tag);
        if (className) e.className = className;
        if (text !== undefined) e.textContent = text;
        return e;
      }

      // Minimalist plan block (#conversation-chrome). Rebuilds the node in place
      // from the injected, tested projectPlan: done steps collapse to one
      // "✓ N done" summary (click to expand the completed list); failed steps
      // stay individually visible; upcoming = the current step (bold) + the next
      // few pending, with the rest behind a "+N more". No strikethrough rows.
      function planRow(cls, mark, text) {
        const li = el('li', cls);
        li.appendChild(el('span', 'plan-mark', mark));
        li.appendChild(el('span', 'plan-text', text));
        return li;
      }
      function buildPlan(node, seg) {
        node.innerHTML = '';
        const proj = projectPlan(seg.entries || []);
        const headText = seg.title
          ? 'Plan ' + seg.done + '/' + seg.total + ' — ' + seg.title
          : 'Plan ' + seg.done + '/' + seg.total;
        node.appendChild(el('div', 'plan-head', headText));
        const track = el('div', 'plan-progress');
        const fill = el('div', 'plan-progress-fill');
        const pct = seg.total > 0 ? Math.round((seg.done / seg.total) * 100) : 0;
        fill.style.width = pct + '%';
        track.appendChild(fill);
        node.appendChild(track);
        const ul = el('ul', 'plan-list');

        // Done → one collapsible summary line.
        if (proj.doneCount > 0) {
          const open = planDoneOpen.has(seg.id);
          const sum = el('li', 'plan-donesum');
          sum.appendChild(el('span', 'plan-mark', '✓'));
          sum.appendChild(el('span', 'plan-text', proj.doneCount + ' done'));
          sum.appendChild(el('span', 'plan-chev', open ? '▾' : '▸'));
          sum.addEventListener('click', function() {
            if (open) planDoneOpen.delete(seg.id); else planDoneOpen.add(seg.id);
            buildPlan(node, seg);
          });
          ul.appendChild(sum);
          if (open) for (const d of proj.doneItems) ul.appendChild(planRow('plan-completed plan-sub', '✓', d.content));
        }
        // Failed → always visible, individually.
        for (const f of proj.failed) ul.appendChild(planRow('plan-failed', '✗', f.content));
        // Current step (bold).
        if (proj.current) ul.appendChild(planRow('plan-in_progress', '●', proj.current.content));
        // Next few pending.
        for (const p of proj.upcoming) ul.appendChild(planRow('plan-pending', '○', p.content));
        // The rest of the queue, behind a "+N more" toggle.
        if (proj.moreCount > 0) {
          if (planMoreOpen.has(seg.id)) {
            const restPending = (seg.entries || []).filter(function(e) {
              return e.status !== 'completed' && e.status !== 'failed' && e.status !== 'in_progress';
            }).slice(proj.upcoming.length);
            for (const p of restPending) ul.appendChild(planRow('plan-pending', '○', p.content));
          }
          const more = el('li', 'plan-more');
          more.appendChild(el('span', 'plan-mark', ''));
          more.appendChild(el('span', 'plan-text', planMoreOpen.has(seg.id) ? 'show fewer' : ('+' + proj.moreCount + ' more')));
          more.addEventListener('click', function() {
            if (planMoreOpen.has(seg.id)) planMoreOpen.delete(seg.id); else planMoreOpen.add(seg.id);
            buildPlan(node, seg);
          });
          ul.appendChild(more);
        }
        node.appendChild(ul);
      }

      // Lay out one disclosure row: status on the LEFT, the open/close
      // chevron pushed to the RIGHT and kept faint.
      //
      //   [●|✓|✗]  name .................................  ›
      //
      // Status lives in the GLYPH, never in the container. A failed step used
      // to draw a red border around itself — inside a group that had drawn a
      // red border of its own — so one failure shouted twice in nested boxes
      // while the ✗ that actually says "failed" was uncoloured. Now the cross
      // is red and the box says nothing. Same for a running step: the dot
      // pulses, the border stays quiet.
      //
      // The native <details> triangle is dropped (list-style: none) because it
      // is stuck on the left, where it competes with the status glyph for the
      // one position the eye reads first.
      //
      // Returns the elapsed <span> so a live row can tick it.
      function buildRowSummary(summary, status, label) {
        summary.textContent = '';
        const badge = el('span', 'seg-badge badge-' + status);
        if (status === 'pending') badge.appendChild(el('span', 'seg-dot'));
        else badge.textContent = status === 'error' ? '✗' : '✓';
        summary.appendChild(badge);
        summary.appendChild(el('span', 'seg-label', label));
        const elapsed = el('span', 'seg-elapsed');
        summary.appendChild(elapsed);
        summary.appendChild(el('span', 'seg-chev', '›'));
        return elapsed;
      }

      // One side (input/output) of a tool card: a clamped <pre> that opens
      // the FULL value in a read-only editor tab when clicked.
      //
      // The block is always clickable, not only when clamped: the clamped
      // flag means "lines were dropped", which the host can prove — but a
      // single line 900 chars wide is clipped by CSS and the host has no way
      // to know it. Clicking anywhere therefore always works; the explicit
      // link only appears when we can honestly say how much is hidden.
      function appendToolIo(node, seg, field, className, html, clamped, lines) {
        const pre = el('pre', className + (clamped ? ' tool-io-clamped' : ''));
        pre.innerHTML = html;
        pre.title = 'Click to open the full ' + field + ' in an editor';
        const open = () => vscode.postMessage({ type: 'openToolIo', segmentId: seg.id, field: field });
        pre.addEventListener('click', open);
        node.appendChild(pre);
        if (clamped) {
          const hidden = lines - MAX_IO_LINES;
          const link = el('span', 'tool-io-open',
            '⤢ open ' + lines + ' lines (' + hidden + ' more)');
          link.addEventListener('click', open);
          node.appendChild(link);
        }
      }

      // Cheap content-equality check for a segment: segments are plain,
      // host-built data (ids/strings/numbers) rebuilt fresh on every present,
      // so JSON.stringify is a safe, fast stand-in for a recursive deep-equal
      // here — same reasoning as conversationPatch.ts on the host side.
      function segSig(seg) {
        return JSON.stringify(seg);
      }

      // The addressable shell for a segment kind: for 'reasoning'/'tool' this
      // is a <details> element, so it's built ONCE and then repainted in
      // place — never replaced — which is what keeps <details open> (and any
      // text selection inside it) alive across live updates.
      function buildSegmentShell(seg) {
        if (seg.kind === 'reasoning' || seg.kind === 'tool' || seg.kind === 'activity') {
          const det = document.createElement('details');
          det.appendChild(document.createElement('summary'));
          return det;
        }
        return el('div');
      }

      function paintElapsed(entry) {
        const seconds = Math.max(0, Math.round((Date.now() - entry.startedMs) / 1000));
        const stillRunning = seconds >= 10;
        entry.label.textContent = (stillRunning ? 'still running · ' : 'running · ') + seconds + 's';
        entry.node.classList.toggle('tool-still-running', stillRunning);
      }

      // Rebuilds the bg-task chip strip from the bgTasks map (#background-tasks-ux).
      // Cheap and called on every 'tool' segment repaint, not just the ones that
      // actually change bgTasks — the map is small (a handful of entries at
      // most) so a full rebuild is simpler than diffing it.
      function renderBgChips() {
        bgChips.innerHTML = '';
        bgChips.hidden = bgTasks.size === 0;
        if (bgTasks.size === 0) return;
        const nameCounts = {};
        bgTasks.forEach(entry => {
          nameCounts[entry.toolName] = (nameCounts[entry.toolName] || 0) + 1;
        });
        const seenCounts = {};
        bgTasks.forEach((entry, segId) => {
          let label = entry.toolName;
          if (nameCounts[entry.toolName] > 1) {
            seenCounts[entry.toolName] = (seenCounts[entry.toolName] || 0) + 1;
            label = entry.toolName + ' #' + seenCounts[entry.toolName];
          }
          const chip = el('button', 'bgchip', label);
          chip.type = 'button';
          chip.title = 'Background task running — click to view';
          // Deliberately NOT data-seg-id — that attribute means "I am a
          // segment card" to reconcileSegments/scrollToSegment, and this
          // button is neither; a shared name would make it match its own
          // "find the live segment" query.
          chip.dataset.targetSegId = segId;
          bgChips.appendChild(chip);
        });
      }

      // Scrolls to (and briefly highlights) the live segment node for segId —
      // preferring a currently-visible one (transcript vs. book, whichever
      // view is active) over an off-screen duplicate that shares the id.
      function scrollToSegment(segId) {
        const nodes = document.querySelectorAll('[data-seg-id]');
        let target;
        for (const node of nodes) {
          if (node.dataset.segId !== segId) continue;
          if (node.offsetParent !== null) { target = node; break; }
          if (!target) target = node;
        }
        if (!target) return;
        if (target.tagName === 'DETAILS') target.open = true;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('seg-flash');
        setTimeout(() => target.classList.remove('seg-flash'), 1200);
      }

      bgChips.addEventListener('click', e => {
        const chip = e.target.closest('.bgchip');
        if (chip) scrollToSegment(chip.dataset.targetSegId);
      });

      // Paint a segment's content into an EXISTING shell node. Called both
      // right after buildSegmentShell (new segment) and whenever an existing
      // segment's signature changes (updated segment) — the shell itself is
      // never touched, only its innards.
      function paintSegment(node, seg) {
        switch (seg.kind) {
          case 'user':
          case 'assistant-text':
            node.className = 'seg text';
            node.innerHTML = seg.html || '';
            return;
          case 'reasoning': {
            node.className = 'seg reasoning';
            node.querySelector(':scope > summary').textContent = 'Reasoning';
            let body = node.querySelector(':scope > .reasoning-body');
            if (!body) {
              body = el('div', 'reasoning-body');
              node.appendChild(body);
            }
            body.innerHTML = seg.html || '';
            return;
          }
          case 'tool': {
            node.className = 'seg tool tool-' + seg.status;
            const summary = node.querySelector(':scope > summary');
            const elapsed = buildRowSummary(summary, seg.status, seg.toolName || 'tool');
            // Rebuild everything after <summary> — cheap (a handful of
            // nodes) and simpler than diffing input/pending/output fields
            // individually; the shell (and its open state) is untouched.
            while (summary.nextSibling) node.removeChild(summary.nextSibling);
            if (seg.argsText !== undefined) {
              node.appendChild(el('div', 'tool-field-label', 'input'));
              appendToolIo(node, seg, 'input', 'tool-args', seg.argsText, seg.argsClamped, seg.argsLines);
            }
            if (seg.status === 'pending') {
              // The ticker writes into the SUMMARY, not a row in the body:
              // a running step is the one you most need to read while the
              // card is collapsed, and the body is exactly what's hidden.
              const startedMs = seg.ts ? Date.parse(seg.ts) : NaN;
              const entry = { startedMs: isNaN(startedMs) ? Date.now() : startedMs, label: elapsed, node };
              pendingTools.set(node, entry);
              paintElapsed(entry);
            } else {
              pendingTools.delete(node);
              node.classList.remove('tool-still-running');
            }
            if (seg.resultText !== undefined) {
              node.appendChild(el('div', 'tool-field-label', 'output'));
              appendToolIo(node, seg, 'output', 'tool-result', seg.resultText, seg.resultClamped, seg.resultLines);
            }
            if (seg.background) bgTasks.set(seg.id, { toolName: seg.toolName || 'task' });
            else bgTasks.delete(seg.id);
            renderBgChips();
            return;
          }
          case 'plan': {
            node.className = 'seg plan';
            buildPlan(node, seg);
            return;
          }
          case 'agent-question': {
            node.innerHTML = '';
            if (seg.resolved) {
              const decision = seg.resolved.decision;
              node.className = 'seg question resolved resolved-' + decision;
              const label = decision === 'approve' ? 'Approved'
                : decision === 'deny' ? 'Denied'
                : 'Cancelled';
              const optionLabel = seg.resolved.optionLabel;
              node.appendChild(el('div', undefined, optionLabel ? label + ' — ' + optionLabel : label));
              return;
            }
            node.className = 'seg question';
            node.appendChild(el('div', undefined, 'Awaiting your decision'));
            if (seg.options && seg.options.length) {
              const ul = el('ul');
              for (const opt of seg.options) ul.appendChild(el('li', undefined, opt));
              node.appendChild(ul);
            }
            return;
          }
          case 'error':
            node.className = 'seg error';
            node.innerHTML = seg.text || '';
            return;
          case 'activity': {
            // Collapsed by default (the open attribute is never set): a fold
            // that springs open on every new step would defeat its own purpose.
            // The <details> shell is never replaced, so once the user opens the
            // tree it STAYS open as steps stream in underneath.
            node.className = 'seg activity activity-' + seg.status;
            const summary = node.querySelector(':scope > summary');
            // Same row shape as a tool card — a group is a step that happens
            // to contain steps, so it reads with the same grammar.
            const elapsed = buildRowSummary(summary, seg.status, seg.summary || '');
            let kids = node.querySelector(':scope > .act-children');
            if (!kids) {
              kids = el('div', 'act-children');
              node.appendChild(kids);
            }
            // Recursive reconcile — a child whose signature didn't change is
            // left untouched, so its own expand state survives too.
            reconcileSegments(kids, seg.children || []);
            if (seg.status === 'pending') {
              const startedMs = seg.pendingSince ? Date.parse(seg.pendingSince) : NaN;
              const entry = { startedMs: isNaN(startedMs) ? Date.now() : startedMs, label: elapsed, node };
              pendingTools.set(node, entry);
              paintElapsed(entry);
            } else {
              pendingTools.delete(node);
              node.classList.remove('tool-still-running');
            }
            return;
          }
        }
      }

      // Ticks pending tools' elapsed labels independently of any patch —
      // "started but no answer yet" must keep moving even on a quiet poll.
      setInterval(() => {
        for (const [key, entry] of pendingTools) {
          if (!entry.node.isConnected) { pendingTools.delete(key); continue; }
          paintElapsed(entry);
        }
        // A bg task's segment can vanish from the DOM (turn dropped, resync)
        // without ever repainting through the 'tool' branch above — prune any
        // chip whose backing segment is no longer live, the same safety net
        // pendingTools gets via node.isConnected above.
        if (bgTasks.size > 0) {
          const liveSegIds = new Set();
          document.querySelectorAll('[data-seg-id]').forEach(node => {
            if (node.isConnected) liveSegIds.add(node.dataset.segId);
          });
          let pruned = false;
          for (const segId of bgTasks.keys()) {
            if (!liveSegIds.has(segId)) { bgTasks.delete(segId); pruned = true; }
          }
          if (pruned) renderBgChips();
        }
        // The working row's elapsed must keep moving on a quiet poll too — a
        // frozen counter is exactly what "is it stuck?" looks like.
        refreshWorking();
        // The blocked note's delay must elapse on a quiet poll too — nothing
        // else re-renders it while the session sits unchanged mid-block.
        refreshBlockedNote();
        // The live chapter's "$ now:" line must keep ticking on a quiet poll —
        // a frozen counter is what "is it stuck?" looks like.
        if (bookView && bookApplies()) {
          book.querySelectorAll('.chapter.live .under[data-since]').forEach(renderNow);
        }
      }, 1000);

      // Marks runs of consecutive tool segments so CSS can merge them into
      // one compact group instead of N separately-bordered cards.
      function markToolRuns(bubble) {
        const children = Array.prototype.slice.call(bubble.querySelectorAll(':scope > [data-seg-id]'));
        children.forEach((node, i) => {
          node.classList.remove('tool-run-start', 'tool-run-mid', 'tool-run-end');
          if (!node.classList.contains('tool')) return;
          const prevIsTool = i > 0 && children[i - 1].classList.contains('tool');
          const nextIsTool = i < children.length - 1 && children[i + 1].classList.contains('tool');
          if (prevIsTool && nextIsTool) node.classList.add('tool-run-mid');
          else if (prevIsTool) node.classList.add('tool-run-end');
          else if (nextIsTool) node.classList.add('tool-run-start');
        });
      }

      // Reconcile a turn's segment nodes against the incoming segment list:
      // upsert changed/new ones, remove dropped ones, and — critically —
      // never touch a node whose signature didn't change, which is what
      // keeps <details open> and any in-progress text selection alive.
      function reconcileSegments(bubble, segments) {
        const existing = {};
        bubble.querySelectorAll(':scope > [data-seg-id]').forEach(node => {
          existing[node.dataset.segId] = node;
        });
        const seen = {};
        let anchor = null;
        for (const seg of segments) {
          seen[seg.id] = true;
          const sig = segSig(seg);
          let node = existing[seg.id];
          if (!node) {
            node = buildSegmentShell(seg);
            node.dataset.segId = seg.id;
            paintSegment(node, seg);
            node.dataset.sig = sig;
          } else if (node.dataset.sig !== sig) {
            paintSegment(node, seg);
            node.dataset.sig = sig;
          }
          const inPlace = anchor ? anchor.nextElementSibling === node : bubble.firstElementChild === node;
          if (!inPlace) {
            if (anchor) anchor.after(node);
            else bubble.insertBefore(node, bubble.firstChild);
          }
          anchor = node;
        }
        for (const id in existing) {
          if (!seen[id]) existing[id].remove();
        }
        markToolRuns(bubble);
      }

      // Turn ids are "turn-<seq>" (see reduceConversation in conversation.ts)
      // — host-assigned structural metadata, not daemon content — so the
      // numeric suffix is a safe, cheap ordering key for placing a
      // late-arriving or out-of-order turn without needing the full
      // timeline order in every patch.
      function turnSeq(turnId) {
        const n = Number(String(turnId).slice(String(turnId).lastIndexOf('-') + 1));
        return isNaN(n) ? Number.MAX_SAFE_INTEGER : n;
      }

      function insertTurnInOrder(node) {
        const seq = turnSeq(node.dataset.turnId);
        const siblings = transcript.querySelectorAll('.turn[data-turn-id]');
        for (const sibling of siblings) {
          if (turnSeq(sibling.dataset.turnId) > seq) {
            transcript.insertBefore(node, sibling);
            return;
          }
        }
        transcript.appendChild(node);
      }

      function currentTurnNodes() {
        const nodes = {};
        transcript.querySelectorAll('.turn[data-turn-id]').forEach(node => {
          nodes[node.dataset.turnId] = node;
        });
        return nodes;
      }

      function upsertTurn(turn, nodes) {
        const existing = nodes[turn.id];
        if (existing) {
          reconcileSegments(existing.querySelector(':scope > .bubble'), turn.segments || []);
          return;
        }
        const node = el('div', 'turn turn-' + turn.role);
        node.dataset.turnId = turn.id;
        // "You" labels a user turn; an unlabeled bubble (transparent
        // background, see CSS) reads as the assistant without repeating it
        // on every single turn. A turn another session injected
        // (agent_prompt) additionally carries the "⇄ from <id>" badge and
        // the agent-sourced accent (E2) — same rendering as
        // renderStaticTurn's frozen-history path.
        if (turn.role === 'user') {
          const role = el('div', 'role', 'You');
          const source = describePromptSource(turn.promptSource);
          if (source) {
            node.classList.add('turn-agent-sourced');
            const badge = el('span', 'prompt-source-badge', source.label);
            badge.title = source.tooltip;
            role.appendChild(badge);
          }
          node.appendChild(role);
        }
        const bubble = el('div', 'bubble');
        node.appendChild(bubble);
        reconcileSegments(bubble, turn.segments || []);
        insertTurnInOrder(node);
        nodes[turn.id] = node;
      }

      // The stitched ancestor history (#resume-history, painted by
      // paintResumeChain below) counts as real content: a restarted session
      // with no live turns yet is NOT an empty conversation, it's one whose
      // newest turn happens to be an ancestor's — see the module's Problem-1
      // fix. Only when NEITHER live turns NOR ancestor history exist does
      // "no messages" actually hold.
      function hasResumeHistory() {
        const node = document.getElementById('resume-history');
        return node !== null && node.childNodes.length > 0;
      }

      function syncEmptyState() {
        const hasTurns = transcript.querySelector('.turn[data-turn-id]') !== null;
        const emptyNode = document.getElementById('empty');
        if (hasTurns || hasResumeHistory()) {
          if (emptyNode) emptyNode.remove();
        } else if (!emptyNode) {
          const e = el('div', undefined, 'No messages yet.');
          e.id = 'empty';
          transcript.appendChild(e);
        }
      }

      function renderUsage(usage) {
        // Context fill only — "ctx 206115/1000000" was two numbers the reader
        // had to divide, and the in/out totals that used to trail it merely
        // repeated what the cost button already shows. The raw counts move
        // to the popover — a title= tooltip is not a surface anyone finds.
        const used = usage && typeof usage.contextUsed === 'number' ? usage.contextUsed : usage && usage.used;
        const size = usage && typeof usage.contextSize === 'number' ? usage.contextSize : usage && usage.size;
        // Compact ring gauge (FIX 5) — the arc length is the fill fraction of
        // the ring's circumference, its colour the fill level.
        const gauge = contextGauge(used, size);
        contextBtn.hidden = !gauge;
        if (gauge) {
          const circumference = 2 * Math.PI * 6; // r=6 in the 16×16 viewBox
          ctxArc.setAttribute('stroke-dasharray', (gauge.ratio * circumference) + ' ' + circumference);
          // Colour the ring by the session's contextContinuity thresholds
          // (#conversation-chrome): grey → amber at warnAtPct → red at
          // compactAtPct, rather than the old fixed 70/90 cutoffs.
          const cc = lastSession && lastSession.contextContinuity;
          const level = contextRingLevel(gauge.pct, cc && cc.warnAtPct, cc && cc.compactAtPct);
          ctxArc.classList.remove('amber', 'red');
          if (level !== 'grey') ctxArc.classList.add(level);
          ctxPct.textContent = gauge.pct + '%';
        }
        popoverContextUsed.textContent = typeof used === 'number' ? String(used) : '—';
        popoverContextSize.textContent = typeof size === 'number' ? String(size) : '—';
        // A hidden button has nothing to open a popover onto either.
        if (!gauge) contextPopover.hidden = true;
      }

      // Wipes #transcript back to empty and immediately repaints the static
      // ancestor block (from lastResumeChain) as its first child. A blind
      // transcript.innerHTML reset would otherwise erase #resume-history
      // along with the live timeline, now that both share one scroll region
      // — this is the one place that reset happens, so every full-transcript
      // rebuild (renderFullConversation, and raw mode's init branch) routes
      // through it instead of touching transcript.innerHTML directly.
      function clearTranscript() {
        transcript.innerHTML = '';
        paintResumeChain();
      }

      // Full resync — used by 'init' (and a hypothetical future 'conversation'
      // full-resync message). Everything after this flows as 'patch'.
      function renderFullConversation(conv) {
        const atBottom = !isScrolledUp;
        clearTranscript();
        pendingTools.clear();
        bgTasks.clear();
        const nodes = {};
        if (conv && conv.turns) {
          for (const turn of conv.turns) upsertTurn(turn, nodes);
        }
        syncEmptyState();
        lastUsage = conv && conv.usage;
        renderUsage(lastUsage);
        if (atBottom) transcript.scrollTop = transcript.scrollHeight;
      }

      // Live update — reconciles in place instead of rebuilding the timeline.
      function applyPatch(patch) {
        const atBottom = !isScrolledUp;
        const nodes = currentTurnNodes();
        for (const id of patch.removeTurnIds || []) {
          const node = nodes[id];
          if (node) { node.remove(); delete nodes[id]; }
        }
        for (const turn of patch.upsertTurns || []) upsertTurn(turn, nodes);
        syncEmptyState();
        if (patch.usage !== undefined) {
          lastUsage = patch.usage;
          renderUsage(lastUsage);
        }
        if (atBottom) transcript.scrollTop = transcript.scrollHeight;
      }

      // ── Book view ──────────────────────────────────────────────────
      // The book is a fold ABOVE the SAME presented turns the transcript view
      // renders — grouped into chapters by buildBook (injected, tested). It
      // reuses reconcileSegments/paintSegment verbatim for its step drawer, so
      // tool cards / activity folds behave identically. #transcript is left
      // fully intact as the 'transcript' escape hatch.

      function bookApplies() { return mode === 'structured'; }

      // Keep #book/#transcript visibility, the header toggle, and the composer
      // placeholder in sync with the mode + the user's book/transcript choice.
      function applyViewVisibility() {
        const applies = bookApplies();
        viewToggle.hidden = !applies;
        if (applies) {
          // Segmented control: the active view is highlighted, not the target —
          // it shows WHERE YOU ARE, and each segment switches to its own view.
          const seg = viewToggle.querySelectorAll('button');
          for (const b of seg) {
            const on = (b.getAttribute('data-view') === 'book') === bookView;
            b.classList.toggle('on', on);
            b.setAttribute('aria-pressed', String(on));
          }
          book.hidden = !bookView;
          transcript.hidden = bookView;
          input.placeholder = bookView ? BOOK_PLACEHOLDER : DEFAULT_PLACEHOLDER;
        } else {
          book.hidden = true;
          input.placeholder = DEFAULT_PLACEHOLDER;
        }
        // The working row is suppressed in book view (renderBook's live chapter
        // shows it instead) — re-evaluate on every view change so it appears the
        // moment the user drops to the raw transcript and hides on the way back.
        refreshWorking();
      }

      function setBookView(next) {
        if (bookView === next) return;
        bookView = next;
        try {
          const prev = (vscode.getState && vscode.getState()) || {};
          if (vscode.setState) vscode.setState(Object.assign({}, prev, { bookView: bookView }));
        } catch (e) { /* state persistence best-effort */ }
        applyViewVisibility();
        if (bookView) renderBook();
      }

      function setBookConversation(conv) {
        bookTurns.clear();
        if (conv && conv.turns) for (const t of conv.turns) bookTurns.set(t.id, t);
      }

      function applyBookPatch(patch) {
        for (const id of (patch.removeTurnIds || [])) bookTurns.delete(id);
        for (const t of (patch.upsertTurns || [])) bookTurns.set(t.id, t);
      }

      function clearBookDom() {
        book.textContent = '';
        bookChapterNodes.clear();
      }

      // A patch may deliver a late earlier turn, so order by the seq suffix of
      // the turn id rather than trusting Map insertion order.
      function orderedBookTurns() {
        return Array.from(bookTurns.values())
          .sort(function(a, b) { return turnSeq(a.id) - turnSeq(b.id); });
      }

      // The step actually running now, for a live chapter's "$ now:" line.
      function currentStepInfo(steps) {
        for (const seg of steps) {
          if (seg.kind === 'tool' && seg.status === 'pending') {
            return { label: seg.toolName || 'tool', since: seg.ts };
          }
          if (seg.kind === 'activity' && seg.status === 'pending') {
            const head = (seg.summary || '').split(' · ')[0];
            return { label: head || 'working', since: seg.pendingSince };
          }
        }
        return undefined;
      }

      function buildChapterNode(ch) {
        const node = el('div', 'chapter');
        node.dataset.chapterId = ch.id;

        // Ask block — the HUMAN turn. It lives ABOVE the fold and OUTSIDE the
        // foldable body, so it stays visible (pinned) whether the chapter is
        // open or folded, and never doubles as the chapter title. The agent's
        // response builds as its OWN chapter below, titled by its narration.
        const ask = el('div', 'ask');
        ask.hidden = true;
        ask.appendChild(el('div', 'alabel', 'YOU ASKED'));
        ask.appendChild(el('div', 'atext'));
        const amore = el('button', 'amore', '$ full message');
        amore.type = 'button';
        amore.hidden = true;
        amore.addEventListener('click', function() {
          bookAskExpanded.add(node.dataset.chapterId);
          ask.classList.remove('clamped');
          amore.hidden = true;
        });
        ask.appendChild(amore);
        node.appendChild(ask);

        const fold = el('div', 'fold');
        fold.setAttribute('tabindex', '0');
        fold.setAttribute('role', 'button');
        fold.appendChild(el('span', 'arrow', '▶'));
        fold.appendChild(el('h2'));
        fold.appendChild(el('span', 'who'));
        fold.appendChild(el('span', 't'));
        const toggle = function() {
          // The live chapter never folds.
          if (node.classList.contains('live')) return;
          const id = node.dataset.chapterId;
          const nowOpen = !node.classList.contains('openc');
          node.classList.toggle('openc', nowOpen);
          fold.setAttribute('aria-expanded', String(nowOpen));
          if (nowOpen) { bookOpened.add(id); bookClosed.delete(id); }
          else { bookClosed.add(id); bookOpened.delete(id); }
        };
        fold.addEventListener('click', toggle);
        fold.addEventListener('keydown', function(e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        });
        node.appendChild(fold);

        const cbody = el('div', 'cbody');
        // Narration (the agent's own words).
        cbody.appendChild(el('div', 'narration'));
        // Steps drawer ("$ show N steps").
        const steps = el('div', 'chapter-steps');
        steps.hidden = true;
        const details = el('button', 'details');
        details.type = 'button';
        const stepsBody = el('div', 'steps-body');
        stepsBody.hidden = true;
        details.addEventListener('click', function() {
          const openNow = stepsBody.hidden;
          stepsBody.hidden = !openNow;
          node.classList.toggle('steps-open', openNow);
        });
        steps.appendChild(details);
        steps.appendChild(stepsBody);
        cbody.appendChild(steps);
        // Notices (plans / errors / questions — kept visible, never folded).
        cbody.appendChild(el('div', 'notices'));
        // Live "$ now:" ticker line.
        const under = el('div', 'under');
        under.hidden = true;
        cbody.appendChild(under);

        node.appendChild(cbody);
        return node;
      }

      // Give every WIDE narration block (a table or fenced code block) a hover
      // pop-out button that opens it in a full read-only editor tab — the book
      // column is narrow, and some tables/code simply don't fit. Re-run on each
      // paint: narration html is rebuilt every time, so wrappers stay fresh (the
      // guard just skips a block already wrapped within one paint). The block's
      // own rendered text is what ships to the host (openBlock) — it's the
      // agent's narration, already in the webview, not raw daemon output.
      function enhanceBookBlocks(root) {
        const blocks = root.querySelectorAll('pre, table');
        for (const block of blocks) {
          const parent = block.parentElement;
          if (!parent || parent.classList.contains('book-block')) continue;
          const wrap = el('div', 'book-block');
          parent.insertBefore(wrap, block);
          wrap.appendChild(block);
          const btn = el('button', 'block-popout', '⤢');
          btn.type = 'button';
          btn.title = 'Open in editor';
          btn.setAttribute('aria-label', 'Open this block in an editor');
          btn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            const text = serializeBookBlock(block);
            vscode.postMessage({ type: 'openBlock', text: text, name: bookBlockName(block, text) });
          });
          wrap.appendChild(btn);
        }
      }

      // A <pre> is its own text; a table becomes tab-separated rows so it stays
      // readable and re-pasteable in a plain editor. (fromCharCode, not '\\t' /
      // '\\n' literals — this whole script is emitted from a template literal,
      // where a literal newline inside a quoted string would break parsing.)
      var TAB_CHAR = String.fromCharCode(9);
      var NL_CHAR = String.fromCharCode(10);
      function serializeBookBlock(block) {
        if (block.tagName === 'TABLE') {
          const lines = [];
          const rows = block.querySelectorAll('tr');
          for (const row of rows) {
            const parts = [];
            const cells = row.querySelectorAll('th, td');
            for (const c of cells) parts.push((c.textContent || '').trim());
            lines.push(parts.join(TAB_CHAR));
          }
          return lines.join(NL_CHAR);
        }
        return block.textContent || '';
      }

      function bookBlockName(block, text) {
        const isTable = block.tagName === 'TABLE';
        const first = (text.split(NL_CHAR)[0] || '').replace(/[^\w .-]+/g, ' ').trim().slice(0, 40);
        return (first ? first + ' — ' : '') + (isTable ? 'table.tsv' : 'code.txt');
      }

      function paintChapter(node, ch, index, chapters, isLive) {
        node.classList.toggle('live', isLive);
        // Provenance: a prompt injected by another session (agent_prompt from
        // a supervisor, a parent's spawn prompt) carries source
        // "agent:<sessionId>" — attribute the ask to it instead of "you".
        // NB: this whole script is a template literal — no backticks here.
        const askSource = ch.ask && typeof ch.ask.source === 'string' ? ch.ask.source : '';
        const fromAgent = askSource.indexOf('agent:') === 0;
        const fold = node.querySelector(':scope > .fold');
        fold.querySelector('h2').textContent = ch.title;
        fold.querySelector('.who').textContent =
          ch.origin === 'you' ? (fromAgent ? '◈ supervisor' : '◈ you') : '';
        const dur = chapterDurationMs(chapters, index);
        fold.querySelector('.t').textContent = typeof dur === 'number' ? formatChapterDuration(dur) : '';

        const open = isLive || bookOpened.has(ch.id) ||
          (!bookClosed.has(ch.id) && index === chapters.length - 1);
        node.classList.toggle('openc', open);
        fold.setAttribute('aria-expanded', String(open));

        // Ask block — pinned above the fold, its own persistent human turn.
        const ask = node.querySelector(':scope > .ask');
        if (ch.ask) {
          ask.hidden = false;
          const alabel = ask.querySelector('.alabel');
          alabel.textContent = fromAgent ? 'SUPERVISOR ASKED' : 'YOU ASKED';
          // Full provenance on hover — the injecting session's id.
          if (fromAgent) alabel.title = askSource.slice('agent:'.length);
          else alabel.removeAttribute('title');
          const atext = ask.querySelector('.atext');
          atext.innerHTML = ch.ask.html || '';
          enhanceBookBlocks(atext);
          // Respect an earlier "$ full message" expansion across live re-renders.
          const amore = ask.querySelector('.amore');
          let clamp = Boolean(ch.ask.long) && !bookAskExpanded.has(ch.id);
          ask.classList.toggle('clamped', clamp);
          // The char-count is only a heuristic — trust the actual layout: a
          // message that already fits entirely inside the clamp needs no
          // "$ full message" expander. (clientHeight is 0 before first
          // layout — keep the heuristic's verdict in that case.)
          if (clamp && atext.clientHeight > 0 && atext.scrollHeight <= atext.clientHeight + 1) {
            clamp = false;
            ask.classList.remove('clamped');
          }
          amore.hidden = !clamp;
          // First paint measures clientHeight as 0, so the fit-check above is
          // skipped and a >220-char message that actually wraps to ≤5 lines
          // keeps a spurious expander. Re-measure once layout has settled and
          // drop it if the whole message is already on screen. Guard on the
          // still-clamped class so a user expansion in between isn't undone.
          if (clamp) {
            requestAnimationFrame(function() {
              if (!ask.classList.contains('clamped')) return;
              if (atext.scrollHeight <= atext.clientHeight + 1) {
                ask.classList.remove('clamped');
                amore.hidden = true;
              }
            });
          }
        } else {
          ask.hidden = true;
        }

        // Narration — rebuilt each paint (cheap prose); the live chapter gets
        // the blinking phosphor cursor after its last block.
        const narration = node.querySelector(':scope > .cbody > .narration');
        narration.textContent = '';
        for (const seg of ch.narration) {
          const p = el('div', 'story');
          p.innerHTML = seg.html || '';
          enhanceBookBlocks(p);
          narration.appendChild(p);
        }
        if (isLive) {
          let last = narration.lastElementChild;
          if (!last) { last = el('div', 'story'); narration.appendChild(last); }
          last.appendChild(el('span', 'cursor'));
        }

        // Steps drawer — reuse the transcript's own segment reconciler so tool
        // cards / activity folds render (and keep their open state) identically.
        const steps = node.querySelector(':scope > .cbody > .chapter-steps');
        const stepsBody = steps.querySelector('.steps-body');
        if (ch.steps.segments.length > 0) {
          steps.hidden = false;
          const n = ch.steps.count;
          let label = 'show ' + n + ' step' + (n === 1 ? '' : 's');
          if (ch.steps.failed > 0) label += ' · ' + ch.steps.failed + ' failed';
          steps.querySelector('.details').textContent = label;
          reconcileSegments(stepsBody, ch.steps.segments);
        } else {
          steps.hidden = true;
          reconcileSegments(stepsBody, []);
        }

        // Notices.
        reconcileSegments(node.querySelector(':scope > .cbody > .notices'), ch.notices);

        // Live "$ now:" line.
        paintNowLine(node, ch, isLive);
      }

      function paintNowLine(node, ch, isLive) {
        const under = node.querySelector(':scope > .cbody > .under');
        const info = isLive ? currentStepInfo(ch.steps.segments) : undefined;
        const since = info && info.since ? Date.parse(info.since) : NaN;
        if (!info || isNaN(since)) {
          under.hidden = true;
          under.removeAttribute('data-since');
          under.removeAttribute('data-label');
          under.removeAttribute('data-dotting');
          // Only the LIVE line owns the fade/debounce state. A kept-closed past
          // chapter painting its (empty) line every renderBook must not clobber
          // the live line's pending/fade tracking — that would snap every label
          // change in any multi-chapter book.
          if (isLive) {
            nowSwapToken++;
            shownNowLabel = pendingNowLabel = null;
          }
          return;
        }
        under.hidden = false;
        under.dataset.since = String(since);
        // A pending step that outlives NOW_STALE_MS has almost certainly never
        // resolved — the agent went quiet, usually because it handed off to a
        // child session (supervising an executor) and stopped emitting its own
        // [tool] markers. The transcript's last action then freezes forever, so
        // "now:" stops trusting it and falls back to the daemon's own
        // activitySummary (or an explicit supervision label).
        under.dataset.label =
          Date.now() - since > NOW_STALE_MS ? nowStaleLabel() : info.label;
        renderNow(under);
      }

      // What a >30s-old unresolved step is really doing: supervising a child,
      // or whatever the daemon's activitySummary says. Falls back to the
      // trusty "Working" — never the stale tool name.
      function nowStaleLabel() {
        if (lastSession && lastSession.blockedOn === 'subagent') return 'Watching executor';
        const text = lastSession && lastSession.activitySummary && lastSession.activitySummary.text;
        return text ? clampNowLabel(text) : 'Working';
      }

      // activitySummary.text is a prose sentence, not a terse tool name —
      // cap it so the "$ now:" line stays one short line.
      function clampNowLabel(s) {
        if (s.length <= 48) return s;
        const cut = s.slice(0, 48).replace(/\s+\S*$/, '');
        return (cut.length ? cut : s.slice(0, 48)) + '…';
      }

      function renderNow(under) {
        const since = Number(under.dataset.since);
        const label = under.dataset.label || '';
        const elapsed = Math.max(0, Date.now() - since);
        // > 90s: a counter that climbs into many minutes is exactly the stale
        // look this line exists to avoid — drop the number and the "now:"
        // prefix, replace the whole line with a "Still working…" dot-cycle.
        // Reschedule only while no dot tick is already pending so the 1s
        // quiet-poll ticker doesn't stack. Any pending label fade is moot here.
        if (elapsed > NOW_LONG_RUNNING_MS) {
          nowSwapToken++;
          shownNowLabel = pendingNowLabel = null;
          if (under.dataset.dotting !== '1') {
            under.dataset.dotting = '1';
            window.setTimeout(function () {
              under.removeAttribute('data-dotting');
              renderNow(under);
            }, NOW_DOT_CYCLE_MS);
          }
          const dots = '.'.repeat(1 + Math.floor(Date.now() / NOW_DOT_CYCLE_MS) % 3);
          under.textContent = '';
          under.appendChild(document.createTextNode('Still working' + dots));
          return;
        }
        under.removeAttribute('data-dotting');

        const suffix = nowSuffix(elapsed);
        // First paint for this node: there is no older label to hold against,
        // so paint right away — the line must never sit blank.
        if (shownNowLabel === null && pendingNowLabel === null) {
          shownNowLabel = label;
          paintNowText(under, label, suffix);
          return;
        }
        // Same label already on screen → the seconds ticker just re-paints
        // (no fade). Same label mid-swap → leave the old text in place; the
        // scheduled fade will land it.
        if (label === shownNowLabel) {
          if (under.classList.contains('fading-out')) return;
          paintNowText(under, label, suffix);
          return;
        }
        if (label === pendingNowLabel) return;
        if (pendingNowLabel !== null) {
          // A newer label arrived inside the debounce window — coalesce into
          // the scheduled swap, which reads dataset.label at fire time.
          pendingNowLabel = label;
          return;
        }
        // A real label change: hold the current text >= NOW_MIN_DISPLAY_MS,
        // then fade old -> new.
        pendingNowLabel = label;
        shownNowSwapAt = Math.max(Date.now(), shownNowSwapAt + NOW_MIN_DISPLAY_MS);
        const token = ++nowSwapToken;
        window.setTimeout(function () {
          if (nowSwapToken !== token || pendingNowLabel === null) return;
          under.classList.add('fading-out');
          window.setTimeout(function () {
            if (nowSwapToken !== token || pendingNowLabel === null) return;
            under.classList.remove('fading-out');
            const cur = under.dataset.label || '';
            const curSince = Number(under.dataset.since);
            paintNowText(under, cur, nowSuffix(Math.max(0, Date.now() - curSince)));
            shownNowLabel = cur;
            pendingNowLabel = null;
            under.classList.add('fading-in');
            window.setTimeout(function () {
              if (nowSwapToken === token) under.classList.remove('fading-in');
            }, NOW_FADE_MS);
          }, NOW_FADE_MS);
        }, Math.max(0, shownNowSwapAt - Date.now()));
      }

      function paintNowText(under, label, suffix) {
        under.textContent = '';
        under.appendChild(document.createTextNode('now: '));
        under.appendChild(el('b', undefined, label));
        if (suffix) under.appendChild(document.createTextNode(suffix));
      }

      // Progressive elapsed display for the "$ now:" line.
      //   <5s      — nothing at all ("now" is current; a '· 0s' is noise)
      //   5–60s    — seconds (· 12s)
      //   60–90s   — minutes (· 1 min)
      //   >90s     — handled by renderNow's "Still working…" branch
      function nowSuffix(elapsedMs) {
        if (elapsedMs < NOW_NO_TIME_MS) return '';
        if (elapsedMs < NOW_SECONDS_MS) return ' · ' + Math.round(elapsedMs / 1000) + 's';
        return ' · ' + Math.floor(elapsedMs / 60000) + ' min';
      }

      // Narration is already safe, host-rendered Markdown HTML. Returning that
      // HTML instead of flattening it keeps the agent's question readable:
      // links remain actionable and headings, lists, code and tables retain
      // their structure inside the pause card.
      function pauseQuestionHtml(chapters) {
        const last = chapters[chapters.length - 1];
        if (last && last.narration.length) {
          return last.narration[last.narration.length - 1].html || '';
        }
        return '<p>The agent is waiting for your input.</p>';
      }

      function renderPauseCard(page, awaiting, chapters) {
        let pause = page.querySelector(':scope > .pause');
        if (!awaiting) { if (pause) pause.remove(); return; }
        if (!pause) {
          pause = el('div', 'pause');
          const head = el('div', 'phead');
          head.appendChild(el('span', 'blk'));
          head.appendChild(document.createTextNode('THE AGENT PAUSED TO ASK'));
          pause.appendChild(head);
          pause.appendChild(el('div', 'pquestion'));
          page.appendChild(pause);
          // Focus the composer once, so the user can answer immediately (M0:
          // structured answer buttons are M1).
          if (!exited) input.focus();
        } else {
          page.appendChild(pause); // keep it last
        }
        const question = pause.querySelector('.pquestion');
        question.innerHTML = pauseQuestionHtml(chapters);
        enhanceBookBlocks(question);
      }

      // The blank-conversation view. Rather than a dead "No messages yet."
      // placeholder, introduce WHO is about to answer and on whose dime —
      // harness / model / mode / wallet, the same facts the composer chips
      // carry — so a fresh tab reads as a ready session, not an empty void.
      function buildEmptyHero() {
        const hero = el('div', 'book-hero');
        hero.appendChild(el('div', 'bh-title', 'Ready when you are'));
        const s = lastSession;
        const isPlainPty = s && s.kind === 'terminal' && s.pty === true;
        if (s && !isPlainPty) {
          hero.appendChild(el('div', 'bh-sub', 'Your first message opens the book. This session will answer with:'));
          const facts = el('div', 'bh-facts');
          const row = function(k, v) {
            if (!v) return;
            const r = el('div', 'bh-row');
            r.appendChild(el('span', 'bh-k', k));
            r.appendChild(el('span', 'bh-v', v));
            facts.appendChild(r);
          };
          const auth = accessIdentity(s);
          row('Harness', s.adapterSlug || '');
          row('Model', s.model || 'default');
          row('Mode', defaultPostureLabel(s));
          row('Wallet', auth && auth !== '—' ? auth : 'no wallet');
          hero.appendChild(facts);
        } else {
          hero.appendChild(el('div', 'bh-sub', 'Your first message opens the book.'));
        }
        return hero;
      }

      // Rebuild the book from the accumulated turns. Reconciles chapters by id
      // so fold state survives live updates. A no-op when the book is hidden.
      function renderBook() {
        if (!bookApplies() || !bookView) return;
        const atBottom = !bookScrolledUp;
        const chapters = buildBook(orderedBookTurns());
        let page = book.querySelector(':scope > .book-page');
        if (!page) { page = el('div', 'book-page'); book.appendChild(page); }

        if (chapters.length === 0) {
          page.textContent = '';
          bookChapterNodes.clear();
          page.appendChild(buildEmptyHero());
          return;
        }

        // The chapter reconcile below inserts around existing children, so a
        // hero left over from the empty state would survive it — drop it the
        // moment real content exists.
        const staleHero = page.querySelector(':scope > .book-hero');
        if (staleHero) staleHero.remove();

        const live = !exited && busy;
        const seen = {};
        let anchor = null;
        for (let i = 0; i < chapters.length; i++) {
          const ch = chapters[i];
          const isLive = i === chapters.length - 1 && live;
          seen[ch.id] = true;
          let node = bookChapterNodes.get(ch.id);
          if (!node) { node = buildChapterNode(ch); bookChapterNodes.set(ch.id, node); }
          paintChapter(node, ch, i, chapters, isLive);
          const inPlace = anchor ? anchor.nextElementSibling === node : page.firstElementChild === node;
          if (!inPlace) { if (anchor) anchor.after(node); else page.insertBefore(node, page.firstChild); }
          anchor = node;
        }
        for (const id of Array.from(bookChapterNodes.keys())) {
          if (!seen[id]) {
            const n = bookChapterNodes.get(id);
            if (n) n.remove();
            bookChapterNodes.delete(id);
          }
        }
        // The pause card is ONLY for a genuine end-of-turn wait — never while
        // the agent is actively working. awaitingInput can linger from a prior
        // pause after the user sends and the agent resumes (busy flips back to
        // true before the next poll clears awaitingInput); a genuine awaiting
        // state always carries busy=false (both the awaiting-input and turn-end
        // lifecycle events set busy=false), so gate on !busy. While busy, the
        // live chapter's "Working…" / "$ now:" state carries the moment instead.
        const awaiting = Boolean(lastSession && lastSession.awaitingInput) && !busy && !exited;
        renderPauseCard(page, awaiting, chapters);
        if (atBottom) book.scrollTop = book.scrollHeight;
      }

      book.addEventListener('scroll', function() {
        const threshold = 20;
        bookScrolledUp = book.scrollHeight - book.clientHeight - book.scrollTop > threshold;
      });
      viewToggle.addEventListener('click', function(e) {
        const btn = e.target && e.target.closest ? e.target.closest('button[data-view]') : null;
        if (btn) setBookView(btn.getAttribute('data-view') === 'book');
      });

      // One delegated listener for every clickable link (.tlink) in the prose —
      // book narration, ask cards, and the raw transcript all share it. Reading
      // data-target off the anchor auto-un-escapes the HTML entities back to the
      // real URL/path; the host decides browser-vs-editor from data-open.
      document.addEventListener('click', function(e) {
        const link = e.target && e.target.closest && e.target.closest('.tlink');
        if (!link) return;
        e.preventDefault();
        const kind = link.getAttribute('data-open');
        const target = link.getAttribute('data-target');
        if (!target || (kind !== 'external' && kind !== 'file')) return;
        const rawLine = link.getAttribute('data-line');
        const line = rawLine ? parseInt(rawLine, 10) : undefined;
        vscode.postMessage({ type: 'openLink', kind: kind, target: target, line: line });
      });

      // A resume-chain ancestor's turns are rendered ONCE, statically — they
      // never patch again (the ancestor session is dead history), so this
      // deliberately does NOT go through upsertTurn/insertTurnInOrder (those
      // assume a live, ordered, re-patchable timeline keyed by a single
      // shared turn-id numbering — turn ids from a DIFFERENT session's own
      // reduceConversation aren't ordered against this session's at all).
      // buildSegmentShell/paintSegment are still reused as-is: they only
      // build/paint a segment from its own data, with no reference to the
      // live #transcript, so the same rendering fidelity (tool cards,
      // folded activity runs, plans, …) applies to frozen history for free.
      function renderStaticTurn(turn) {
        const node = el('div', 'turn turn-' + turn.role);
        // Same agent-attribution badge as the live upsertTurn path (E2) — an
        // ancestor turn another session injected is still agent-sourced.
        if (turn.role === 'user') {
          const role = el('div', 'role', 'You');
          const source = describePromptSource(turn.promptSource);
          if (source) {
            node.classList.add('turn-agent-sourced');
            const badge = el('span', 'prompt-source-badge', source.label);
            badge.title = source.tooltip;
            role.appendChild(badge);
          }
          node.appendChild(role);
        }
        const bubble = el('div', 'bubble');
        node.appendChild(bubble);
        for (const seg of turn.segments || []) {
          const segNode = buildSegmentShell(seg);
          segNode.dataset.segId = seg.id;
          paintSegment(segNode, seg);
          bubble.appendChild(segNode);
        }
        markToolRuns(bubble);
        return node;
      }

      // #resume-history is built lazily (never part of the static HTML
      // skeleton) so it can be recreated as the first child of #transcript
      // after any full reset (clearTranscript) — always in front of the live
      // timeline, in the SAME scroll region, never a sibling pane of its own.
      function resumeHistoryContainer() {
        let node = document.getElementById('resume-history');
        if (!node) {
          node = el('div');
          node.id = 'resume-history';
          transcript.insertBefore(node, transcript.firstChild);
        }
        return node;
      }

      // Paints lastResumeChain into #resume-history. Split from
      // renderResumeChain (below) so clearTranscript can repaint the SAME
      // cached chain after a full reset without the caller re-sending it.
      // chain is already oldest-first (host-side reverse — see
      // transcriptPanelController.ts's buildResumeChain): each ancestor's
      // turns (or an "unavailable" note when its transcript couldn't load)
      // are followed by the divider describing HOW the next-more-recent
      // session resumed from it, so the sequence reads top-to-bottom as
      // "what happened, then it restarted, then what happened next" —
      // directly into the transcript's OWN scroll region, not a capped pane
      // above it.
      function paintResumeChain() {
        const container = resumeHistoryContainer();
        container.innerHTML = '';
        for (const entry of lastResumeChain || []) {
          if (entry.conversation && entry.conversation.turns) {
            for (const turn of entry.conversation.turns) {
              container.appendChild(renderStaticTurn(turn));
            }
          } else if (entry.unavailable) {
            container.appendChild(el('div', 'resume-unavailable',
              entry.unavailable === 'no-transcript'
                ? 'Earlier history not available (no structured transcript).'
                : 'Earlier history could not be loaded.'));
          }
          const via = entry.resumeVia ? ' (' + entry.resumeVia + ')' : ' (no continuity)';
          container.appendChild(el('div', 'resume-divider',
            '── restarted · resumed from ' + entry.sessionId + via + ' ──'));
        }
      }

      // Render the FULL resume chain, once, at init — see paintResumeChain
      // for the actual paint. Caching the chain in lastResumeChain is what
      // lets clearTranscript restore it after a later full reset.
      function renderResumeChain(chain) {
        lastResumeChain = chain || null;
        paintResumeChain();
      }

      // The wire prompt is text + every attachment path, space-joined: v1 hands
      // the agent readable PATHS (Decision A), so a chip collapses back into the
      // prompt string here. Keeping it a plain string is what lets the mid-turn
      // queue (which stores one string) carry attachments for free.
      function composePrompt() {
        const parts = [];
        const typed = input.value.trim();
        if (typed) parts.push(typed);
        for (let i = 0; i < attachments.length; i++) parts.push(attachments[i].path);
        return parts.join(' ');
      }

      function send(interrupt) {
        const composed = composePrompt();
        if (!composed) return;
        input.value = '';
        attachments = [];
        renderAttachments();
        closeMention();
        autoGrow();
        clearError();
        // Pushed here, not per-arm below: a queued message IS sent, just
        // later, so it belongs in history the moment the user commits to it.
        historyState = pushHistoryEntry(historyState, composed);
        // Mid-turn and not explicitly interrupting: hold it rather than POST a
        // prompt the daemon will refuse with a 409. It goes out on turn-end.
        if (busy && !interrupt) {
          queuedText = composed;
          refreshComposer();
          return;
        }
        vscode.postMessage({ type: interrupt ? 'interruptSend' : 'send', text: composed });
        refreshComposer();
      }

      // ── Attachment chips ──────────────────────────────────────────────
      function attachmentLabel(path) {
        const parts = path.split(/[\\/]/);
        return parts[parts.length - 1] || path;
      }

      function renderAttachments() {
        attachmentsRow.textContent = '';
        attachmentsRow.hidden = attachments.length === 0;
        for (let i = 0; i < attachments.length; i++) {
          const att = attachments[i];
          const chip = document.createElement('span');
          chip.className = 'attach-chip';
          chip.title = att.path;
          const label = document.createElement('span');
          label.className = 'attach-chip-label';
          label.textContent = att.label;
          chip.appendChild(label);
          const remove = document.createElement('span');
          remove.className = 'attach-chip-remove';
          remove.textContent = '✕';
          remove.title = 'Remove attachment';
          // Bind the path, not the index — the row is rebuilt on every change,
          // so an index would go stale the moment an earlier chip is removed.
          const path = att.path;
          remove.addEventListener('click', function() { removeAttachment(path); });
          chip.appendChild(remove);
          attachmentsRow.appendChild(chip);
        }
      }

      // Add a ready path (already on disk) as a chip. Enforces the count cap and
      // de-dupes, so mentioning or dropping the same file twice is a no-op.
      function addAttachment(path) {
        if (!path) return;
        for (let i = 0; i < attachments.length; i++) {
          if (attachments[i].path === path) { refreshComposer(); return; }
        }
        if (attachments.length >= ATTACHMENT_COUNT_CAP) {
          showError('Too many attachments',
            'Up to ' + ATTACHMENT_COUNT_CAP + ' attachments per message. Remove one to add another.');
          return;
        }
        attachments.push({ path: path, label: attachmentLabel(path) });
        renderAttachments();
        refreshComposer();
        input.focus();
      }

      function removeAttachment(path) {
        attachments = attachments.filter(function(a) { return a.path !== path; });
        renderAttachments();
        refreshComposer();
      }

      // Read a File to bytes and hand it to the host to store. Pre-checks the
      // size so an oversize file is refused HERE with a friendly message rather
      // than eating the route's 413 (Decision G). kind: 'image' (paste, no
      // name) or 'file' (drop, named).
      function uploadFile(file, kind) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          const mib = Math.round(file.size / (1024 * 1024));
          showError('File too large', 'That file is ' + mib + ' MiB — over the 32 MiB limit. It was not attached.');
          return;
        }
        if (file.size > WARN_ATTACHMENT_BYTES) {
          const mib = Math.round(file.size / (1024 * 1024));
          showError('Large attachment', 'That file is ' + mib + ' MiB — large for an attachment, but it was attached.');
        }
        file.arrayBuffer().then(function(buf) {
          if (kind === 'image') {
            vscode.postMessage({ type: 'attachImage', bytes: buf, mime: file.type });
          } else {
            vscode.postMessage({ type: 'attachFile', bytes: buf, mime: file.type, name: file.name || 'file' });
          }
        }).catch(function() {
          showError('Attachment failed', 'Could not read the file.');
        });
      }

      input.addEventListener('keydown', function(e) {
        // While the @mention popup is open it owns the arrow/enter/tab/escape
        // keys — otherwise Enter would send instead of picking a file.
        if (mention && handleMentionKey(e)) return;
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          const noSelection = input.selectionStart === input.selectionEnd;
          // ↑ recalls once the caret is parked at the very start (index 0) —
          // in a multi-line draft it walks up the lines normally first, same
          // as VS Code's own chat — OR, once navigation is already underway,
          // unconditionally: shells and Claude Code both let ↑/↓ own the
          // keys for the rest of the walk, so a second ↑ steps to the NEXT
          // older entry instead of just re-parking the caret it already
          // placed at the end of the first recall. The accepted trade-off:
          // while navigating a recalled MULTI-LINE entry, ↑/↓ step through
          // history instead of moving between that entry's own lines.
          // Typing or clicking into the box is the escape hatch back to
          // normal caret movement (see the input/click listeners below).
          const eligible = e.key === 'ArrowUp'
            ? noSelection && (input.selectionStart === 0 || historyState.index !== null)
            : noSelection && historyState.index !== null;
          if (!eligible) return; // let the browser move the caret normally
          const recalled = recallHistory(historyState, e.key === 'ArrowUp' ? 'prev' : 'next', input.value);
          if (!recalled) return; // hit the end — don't consume the key
          e.preventDefault();
          historyState = recalled.state;
          input.value = recalled.value;
          const len = input.value.length;
          input.setSelectionRange(len, len);
          autoGrow();
          refreshComposer();
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send(false);
        }
      });

      input.addEventListener('input', function() {
        // Setting .value programmatically (a recall) fires no input event, so
        // this only ever runs on REAL typing — the intended escape hatch out
        // of history navigation.
        historyState = { ...historyState, index: null };
        autoGrow();
        refreshComposer();
        updateMention();
      });

      // Clicking elsewhere in the textarea moves the caret out of an @token.
      input.addEventListener('click', function() {
        // A click means "I'm editing this now, not browsing" — exit history
        // navigation, same escape hatch as typing. Only the cursor resets;
        // entries/draft are untouched so history is still there next time.
        historyState = { ...historyState, index: null };
        updateMention();
      });

      // Paste an image → the agent reads it. The webview can't touch disk, so
      // it reads the pasted image to bytes and ships them to the host, which
      // stores the file and posts back a path (see 'attachmentUploaded').
      // preventDefault stops the same binary from ALSO landing as garbage text.
      input.addEventListener('paste', function(e) {
        const data = e.clipboardData;
        if (!data || !data.items) return;
        const images = [];
        for (let i = 0; i < data.items.length; i++) {
          const item = data.items[i];
          if (item.kind === 'file' && item.type && item.type.indexOf('image/') === 0) {
            const file = item.getAsFile();
            if (file) images.push(file);
          }
        }
        if (images.length === 0) return; // no image → let the normal text paste run
        e.preventDefault();
        for (let j = 0; j < images.length; j++) uploadFile(images[j], 'image');
      });

      // ── Drag and drop ─────────────────────────────────────────────────
      // A file dragged from the VS Code Explorer arrives as a uri-list with a
      // REAL on-disk path → attach it directly, no upload (Decision A1). A file
      // dragged from the OS arrives as raw bytes in dataTransfer.files → upload
      // it like a paste (A2).
      composer.addEventListener('dragover', function(e) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        composer.classList.add('drag-over');
      });
      composer.addEventListener('dragleave', function() { composer.classList.remove('drag-over'); });
      composer.addEventListener('drop', function(e) {
        e.preventDefault();
        composer.classList.remove('drag-over');
        const dt = e.dataTransfer;
        if (!dt) return;
        const uriList = (dt.getData && (dt.getData('application/vnd.code.uri-list') || dt.getData('text/uri-list'))) || '';
        const paths = parseUriList(uriList);
        if (paths.length > 0) {
          for (let i = 0; i < paths.length; i++) addAttachment(paths[i]);
          return;
        }
        const files = dt.files;
        if (files && files.length > 0) {
          for (let j = 0; j < files.length; j++) uploadFile(files[j], 'file');
        }
      });

      // ── @mention popup ────────────────────────────────────────────────
      function closeMention() {
        mention = null;
        mentionPopup.hidden = true;
        mentionPopup.textContent = '';
      }

      // Recompute the active @token from the caret; ask the host for candidates.
      function updateMention() {
        const found = mentionQueryAt(input.value, input.selectionStart == null ? input.value.length : input.selectionStart);
        if (!found) { closeMention(); return; }
        // Keep any already-fetched items so the popup doesn't flicker empty
        // between the request and the response; correlate the response by query.
        mention = { start: found.start, end: found.end, query: found.query, items: mention ? mention.items : [], active: 0 };
        renderMention();
        vscode.postMessage({ type: 'requestMentions', query: found.query });
      }

      function renderMention() {
        if (!mention) return;
        mentionPopup.textContent = '';
        if (mention.items.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'mention-empty';
          empty.textContent = 'No matching files';
          mentionPopup.appendChild(empty);
          mentionPopup.hidden = false;
          return;
        }
        for (let i = 0; i < mention.items.length; i++) {
          const item = mention.items[i];
          const row = document.createElement('div');
          row.className = 'mention-item' + (i === mention.active ? ' active' : '');
          row.textContent = item.label;
          row.title = item.path;
          const idx = i;
          row.addEventListener('mousedown', function(ev) {
            // mousedown, not click: click fires after the textarea blurs, which
            // would tear the mention state down before the handler runs.
            ev.preventDefault();
            chooseMention(idx);
          });
          mentionPopup.appendChild(row);
        }
        mentionPopup.hidden = false;
      }

      // Returns true if it consumed the key (popup navigation), false otherwise.
      function handleMentionKey(e) {
        if (!mention) return false;
        if (e.key === 'Escape') { e.preventDefault(); closeMention(); return true; }
        if (mention.items.length === 0) return false;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          mention.active = (mention.active + 1) % mention.items.length;
          renderMention();
          return true;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          mention.active = (mention.active - 1 + mention.items.length) % mention.items.length;
          renderMention();
          return true;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          chooseMention(mention.active);
          return true;
        }
        return false;
      }

      // Replace the @token with the chosen file — as a chip, and the leftover
      // text keeps the caret. The path rides in composePrompt at send time.
      function chooseMention(index) {
        if (!mention || !mention.items[index]) return;
        const chosen = mention.items[index];
        const before = input.value.slice(0, mention.start);
        const after = input.value.slice(mention.end);
        const sep = after.length > 0 && after.charAt(0) !== ' ' ? ' ' : '';
        input.value = before + after.replace(/^\\s*/, sep ? '' : '');
        // Trim a leading space we might have left where the @token was.
        if (before.length === 0) input.value = input.value.replace(/^\\s+/, '');
        closeMention();
        addAttachment(chosen.path);
        autoGrow();
      }

      // ── PTY-mode helpers (live xterm.js view) ─────────────────────────
      function ensurePtyTerm() {
        if (ptyTerm) return;
        // Always activate the PTY container, even if the xterm bundle failed to
        // load — the container must be visible so status banners can render.
        ptyExited = false;
        ptyView.innerHTML = '';
        ptyView.classList.add('active');
        if (!window.AgentprotoXterm) return;
        ptyTerm = new window.AgentprotoXterm.Terminal({
          fontFamily: 'var(--vscode-editor-font-family, monospace)',
          fontSize: 14,
          theme: {
            background: 'transparent',
            foreground: 'var(--vscode-editor-foreground)',
            cursor: 'var(--vscode-editorCursor-foreground)',
            selectionBackground: 'var(--vscode-editor-selectionBackground)',
            black: 'var(--vscode-terminal-ansiBlack)',
            red: 'var(--vscode-terminal-ansiRed)',
            green: 'var(--vscode-terminal-ansiGreen)',
            yellow: 'var(--vscode-terminal-ansiYellow)',
            blue: 'var(--vscode-terminal-ansiBlue)',
            magenta: 'var(--vscode-terminal-ansiMagenta)',
            cyan: 'var(--vscode-terminal-ansiCyan)',
            white: 'var(--vscode-terminal-ansiWhite)',
            brightBlack: 'var(--vscode-terminal-ansiBrightBlack)',
            brightRed: 'var(--vscode-terminal-ansiBrightRed)',
            brightGreen: 'var(--vscode-terminal-ansiBrightGreen)',
            brightYellow: 'var(--vscode-terminal-ansiBrightYellow)',
            brightBlue: 'var(--vscode-terminal-ansiBrightBlue)',
            brightMagenta: 'var(--vscode-terminal-ansiBrightMagenta)',
            brightCyan: 'var(--vscode-terminal-ansiBrightCyan)',
            brightWhite: 'var(--vscode-terminal-ansiBrightWhite)',
          },
          cursorBlink: true,
        });
        ptyFitAddon = new window.AgentprotoXterm.FitAddon();
        ptyTerm.loadAddon(ptyFitAddon);
        ptyTerm.open(ptyView);
        ptyTerm.onData(function(data) {
          if (!ptyExited) vscode.postMessage({ type: 'ptyInput', text: data });
        });
        ptyTerm.onResize(function(size) {
          if (ptyResizeTimer) clearTimeout(ptyResizeTimer);
          ptyResizeTimer = setTimeout(function() {
            if (!ptyExited) vscode.postMessage({ type: 'ptyResize', cols: size.cols, rows: size.rows });
          }, 150);
        });
        const dims = ptyFitAddon.proposeDimensions();
        if (dims) {
          ptyTerm.resize(dims.cols, dims.rows);
          vscode.postMessage({ type: 'ptyResize', cols: dims.cols, rows: dims.rows });
        }
      }

      function disposePtyTerm() {
        if (ptyResizeTimer) { clearTimeout(ptyResizeTimer); ptyResizeTimer = null; }
        if (ptyTerm) { ptyTerm.dispose(); ptyTerm = null; ptyFitAddon = null; }
        if (ptyView) { ptyView.classList.remove('active'); ptyView.innerHTML = ''; }
        ptyExited = false;
        if (ptyStatusBanner) { ptyStatusBanner.remove(); ptyStatusBanner = null; }
      }

      function showPtyStatus(text, kind) {
        if (!ptyView) return;
        if (!ptyStatusBanner) {
          ptyStatusBanner = document.createElement('div');
          ptyStatusBanner.style.cssText = 'padding: 4px 14px; font-size: 0.85em; font-family: var(--vscode-editor-font-family); white-space: pre-wrap;';
          ptyView.appendChild(ptyStatusBanner);
        }
        ptyStatusBanner.textContent = text;
        ptyStatusBanner.style.color = kind === 'error' ? 'var(--vscode-errorForeground)' : 'var(--vscode-descriptionForeground)';
      }

      function decodeB64(b64) {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      }

      function fitPty() {
        if (ptyFitAddon && ptyTerm) ptyFitAddon.fit();
      }

      window.addEventListener('resize', function() {
        if (mode === 'pty') fitPty();
      });

      // Click the model chip → the host fetches this session's adapter
      // listing and shows a native quick-pick (no picker vocabulary lives in
      // the webview — see runChangeModelFlow / changeModel.logic.ts).
      composerModel.addEventListener('click', function() {
        vscode.postMessage({ type: 'changeModel' });
      });
      composerEffort.addEventListener('click', function() {
        vscode.postMessage({ type: 'changeEffort' });
      });
      composerRoute.addEventListener('click', function() {
        // Inert while dimmed — a single-gateway model has nothing to switch to.
        if (composerRoute.classList.contains('dimmed')) return;
        vscode.postMessage({ type: 'changeRoute' });
      });
      // Posture and auth chips route through the same unified config picker
      // (agentproto.configureSession) rather than their own dedicated flow —
      // see handleWebviewMessage's changePosture/changeAccess cases.
      composerPosture.addEventListener('click', function() {
        vscode.postMessage({ type: 'changePosture' });
      });
      composerAuth.addEventListener('click', function() {
        vscode.postMessage({ type: 'changeAccess' });
      });
      sendBtn.addEventListener('click', function() { send(false); });
      // Abandon the in-flight turn, send nothing — distinct from "Interrupt &
      // send" below, which takes the queued message NOW instead of waiting.
      stopBtn.addEventListener('click', function() {
        isStopping = true;
        refreshComposer();
        vscode.postMessage({ type: 'stop' });
      });
      // Interrupt only ever acts on the queued message — it's the only thing
      // waiting, and it's what the button offers to stop waiting for.
      interruptBtn.addEventListener('click', function() { flushQueued(true); });
      // The host resolves which session to restart from the CONTROLLER, not
      // from anything this message carries — see protocol.ts's restart doc.
      restartBtn.addEventListener('click', function() {
        isRestarting = true;
        refreshComposer();
        vscode.postMessage({ type: 'restart' });
      });
      queuedCancel.addEventListener('click', function() {
        queuedText = null;
        refreshComposer();
      });
      ebDismiss.addEventListener('click', clearError);
      // The info banner's X dismisses by user choice (remembered so a same-id
      // re-announce stays hidden — see dismissInfoBanner's byUser arm).
      ibDismiss.addEventListener('click', function() {
        if (currentInfoBannerId !== null) dismissInfoBanner(currentInfoBannerId, true);
      });
      // The blocked-note's X hides the note for the CURRENT (kind, toolCallId)
      // pair only; a different pair re-shows it (see refreshBlockedNote).
      blockedNoteDismiss.addEventListener('click', function() {
        const session = lastSession;
        if (session && session.blockedOn) {
          dismissedBlockedKey = session.blockedOn + ' · ' + (session.pendingToolCallId || '');
        }
        blockedNote.hidden = true;
      });

      // ── Header popovers ─────────────────────────────────────────────
      // A webview has no VS Code popover API, so this is plain DOM: toggle
      // on the button, dismiss on Escape or a click outside, and never more
      // than one open — opening either one closes the other first.
      const popovers = [costPopover, contextPopover];
      function closeAllPopovers() {
        for (const p of popovers) p.hidden = true;
      }
      function togglePopover(popover) {
        const wasOpen = !popover.hidden;
        closeAllPopovers();
        popover.hidden = wasOpen;
      }
      // Terminal button. For plain PTY mode it opens a real VS Code terminal
      // tab alongside the embedded view; for agent-cli/native-conversation
      // sessions it restarts the session as a PTY-native terminal.
      openTerminalBtn.addEventListener('click', function() {
        if (mode === 'pty') {
          vscode.postMessage({ type: 'openTerminal' });
        } else {
          vscode.postMessage({ type: 'restartAsTerminal' });
        }
      });
      // Click-to-edit rename (FIX B). Clicking the header title swaps its text
      // for an inline input prefilled with the CURRENT editable name (label,
      // else derived title — never the adapter·id fallback, which the user
      // shouldn't accidentally commit as a real name). Enter saves, Escape
      // cancels, blur saves. The host writes it as the label and the live
      // session-update repaints the header + tab + tree.
      function beginTitleEdit() {
        if (isEditingTitle || !lastSession) return;
        isEditingTitle = true;
        const input = document.createElement('input');
        input.type = 'text';
        input.setAttribute('aria-label', 'Rename session');
        input.value = lastSession.label ?? lastSession.title ?? '';
        headerTitle.textContent = '';
        headerTitle.appendChild(input);
        input.focus();
        input.select();
        let settled = false;
        const finish = function(save) {
          if (settled) return;
          settled = true;
          isEditingTitle = false;
          const next = input.value.trim();
          if (save) vscode.postMessage({ type: 'rename', name: next });
          // Restore text immediately — optimistic; the sessionUpdate confirms.
          headerTitle.textContent = save && next ? next : displayName(lastSession);
        };
        input.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') { e.preventDefault(); finish(true); }
          else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
          // Keep composer/global key handlers from reacting to typing in here.
          e.stopPropagation();
        });
        input.addEventListener('blur', function() { finish(true); });
      }
      headerTitle.addEventListener('click', beginTitleEdit);
      costBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        togglePopover(costPopover);
      });
      contextBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        togglePopover(contextPopover);
      });
      document.addEventListener('click', function(e) {
        if (!costPopover.contains(e.target) && e.target !== costBtn) costPopover.hidden = true;
        if (!contextPopover.contains(e.target) && e.target !== contextBtn) contextPopover.hidden = true;
      });
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') closeAllPopovers();
      });

      window.addEventListener('message', function(e) {
        const msg = e.data;
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
          case 'init':
            mode = msg.mode || 'raw';
            isScrolledUp = false;
            // Independent of mode — an ancestor's history renders as the
            // FIRST content in the SAME scroll region as the current
            // session's own content (structured OR raw), never a separate
            // capped pane. Cached/painted before the mode branch below so a
            // raw-mode reset (clearTranscript) already has it to repaint.
            // Only ever set here (init runs once per panel), never on
            // 'conversation'/'patch' — see protocol.ts's resumeChain doc.
            renderResumeChain(msg.resumeChain);
            if (mode === 'structured') {
              transcript.hidden = false;
              composer.hidden = false;
              disposePtyTerm();
              renderFullConversation(msg.conversation);
              // Rebuild the book from the same conversation snapshot.
              clearBookDom();
              setBookConversation(msg.conversation);
              renderBook();
            } else if (mode === 'pty') {
              transcript.hidden = true;
              composer.hidden = true;
              working.hidden = true;
              blockedNote.hidden = true;
              disposePtyTerm();
              ensurePtyTerm();
            } else {
              transcript.hidden = false;
              composer.hidden = false;
              disposePtyTerm();
              clearTranscript();
              // Suppress the dead "No transcript available" placeholder
              // when the stitched ancestor history above IS the transcript
              // — only show it when there's genuinely nothing at all (no
              // ancestor history AND no raw content either).
              const raw = msg.initialHtml || (hasResumeHistory() ? '' : '<div id="empty">No transcript available.</div>');
              if (raw) {
                const rawWrap = el('div');
                rawWrap.innerHTML = raw;
                while (rawWrap.firstChild) transcript.appendChild(rawWrap.firstChild);
              }
              transcript.scrollTop = transcript.scrollHeight;
            }
            // A view flip (FIX 2) re-posts 'init' WITHOUT a history field so
            // the accumulated ↑/↓ history survives the switch; the first init
            // always carries one (possibly []), which seeds it.
            historyState = { entries: msg.history || historyState.entries, index: null, draft: '' };
            // The Terminal button is shown for agent-cli sessions (restart as
            // real PTY terminal) and for plain PTY sessions (open the embedded
            // PTY in a real VS Code terminal tab).
            openTerminalBtn.hidden = msg.session.kind !== 'agent-cli' && msg.mode !== 'pty';
            applySession(msg.session);
            // Book is the default view for a structured session; this also
            // hides the book + toggle for raw/pty and sets the placeholder.
            applyViewVisibility();
            break;
          case 'conversation':
            renderFullConversation(msg.conversation);
            clearBookDom();
            setBookConversation(msg.conversation);
            renderBook();
            break;
          case 'patch':
            applyPatch(msg);
            applyBookPatch(msg);
            renderBook();
            break;
          case 'sessionUpdate':
            applySession(msg.session);
            break;
          case 'lines':
            if (mode !== 'structured') appendLines(msg.lines);
            break;
          case 'sending':
            setSending(true, msg.note);
            break;
          case 'sendAck':
            setSending(false);
            break;
          case 'infoBanner':
            showInfoBanner(msg.id, msg.text, msg.tooltip);
            break;
          case 'dismissInfoBanner':
            dismissInfoBanner(msg.id, false);
            break;
          case 'attachmentUploaded':
            addAttachment(msg.path);
            break;
          case 'attachError':
            showError(msg.title || 'Attachment failed', msg.message || '');
            break;
          case 'mentionCandidates':
            // Ignore a response that arrived after the user typed on — only the
            // query currently in the box should paint (see updateMention).
            if (mention && msg.query === mention.query) {
              mention.items = msg.items || [];
              if (mention.active >= mention.items.length) mention.active = 0;
              renderMention();
            }
            break;
          case 'sendError':
            setSending(false);
            if (msg.kind === 'busy') {
              // Lost the race: the turn started between our busy check and the
              // POST. Not an error — re-queue and let turn-end flush it, which
              // is exactly what would have happened had we seen busy in time.
              queuedText = msg.text || queuedText;
              refreshComposer();
              break;
            }
            showError(msg.title || 'Send failed', msg.message || '');
            break;
          case 'stopError':
            isStopping = false;
            refreshComposer();
            showError(msg.title || 'Stop failed', msg.message || '');
            break;
          case 'restartFailed':
            isRestarting = false;
            refreshComposer();
            showError(msg.title || 'Restart failed', msg.message || '');
            break;
          case 'ptyData':
            if (ptyTerm) ptyTerm.write(decodeB64(msg.b64));
            break;
          case 'ptyExit':
            ptyExited = true;
            if (ptyTerm) ptyTerm.options.disableStdin = true;
            showPtyStatus('Session exited (code ' + msg.exitCode + (msg.signal ? ' signal ' + msg.signal : '') + ')', 'info');
            break;
          case 'ptyStatus':
            if (msg.status === 'open') {
              if (ptyStatusBanner) { ptyStatusBanner.remove(); ptyStatusBanner = null; }
            } else if (msg.status === 'reconnected') {
              showPtyStatus('Reconnected', 'info');
              setTimeout(function() { if (ptyStatusBanner) { ptyStatusBanner.remove(); ptyStatusBanner = null; } }, 2000);
            } else if (msg.status === 'reconnecting') {
              showPtyStatus('Disconnected · reconnecting in ' + Math.round(msg.delayMs / 1000) + 's (' + msg.attempt + '/' + msg.max + ')…', 'info');
            } else if (msg.status === 'rejected') {
              showPtyStatus('Connection rejected: HTTP ' + msg.detail, 'error');
              ptyExited = true;
              if (ptyTerm) ptyTerm.options.disableStdin = true;
            } else if (msg.status === 'gave-up') {
              showPtyStatus('Lost connection to the daemon · giving up after retries', 'error');
              ptyExited = true;
              if (ptyTerm) ptyTerm.options.disableStdin = true;
            }
            break;
        }
      });

      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`
}
