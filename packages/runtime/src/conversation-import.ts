/**
 * Universal conversation importer: adopt an EXTERNAL native conversation (one
 * agentproto never started) into the live sessions tree by reattaching to it.
 *
 * The read/export side is already universal (`CONVERSATION_STORES`, #566). This
 * is the import (reattach-as-session) side, generalised the same way: a
 * conversation is importable only if its store declares a native reattach argv
 * (`ConversationStore.attachArgv`). Today that is **claude-code** and
 * **hermes** — codex / opencode / mastracode / pi expose no `--resume`, so they
 * remain read/export-only (their CLIs cannot reattach by id). That ceiling is
 * the harness's, not ours.
 *
 * Discovery differs per store: claude-code carries its launch cwd inside each
 * jsonl, so it is scanned GLOBALLY (via {@link listClaudeConversationCandidates}).
 * Every other store's `discover` is cwd-scoped, so we run it across the caller's
 * known workspace cwds. Pure aggregation — the stores + claude scanner are
 * injectable so this is unit-testable without touching disk.
 */

import { listClaudeConversationCandidates } from "./claude-conversation-import.js"
import { CONVERSATION_STORES, type ConversationStore } from "./conversation-store.js"

/** A discovered conversation that CAN be reattached as a live session. */
export interface ImportCandidate {
  /** The `CONVERSATION_STORES` key it came from (its adapter slug). */
  adapterSlug: string
  /** Human-facing harness name for the picker. */
  harnessLabel: string
  /** Provider-native conversation id. */
  conversationId: string
  /** The PTY argv that reattaches to it (`ConversationStore.attachArgv`). */
  attachArgv: string[]
  /** Launch cwd, when known (claude derives it from the jsonl; a cwd-scoped
   *  store's candidate inherits the cwd it was discovered under). Absent ⇒ the
   *  caller must prompt before reattaching. */
  cwd?: string
  preview?: string
  startedAt?: string
  lastActivityAt?: string
  messageCount?: number
  /** claude-code only: the jsonl path, a disambiguation aid in the picker. */
  filePath?: string
}

export interface ListImportCandidatesDeps {
  /** Defaults to the real registry; injected in tests. */
  stores?: Record<string, ConversationStore>
  /** Defaults to the real global claude scanner; injected in tests. */
  scanClaude?: typeof listClaudeConversationCandidates
}

const HARNESS_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  hermes: "Hermes",
}

function labelFor(slug: string): string {
  return HARNESS_LABELS[slug] ?? slug
}

function recencyKey(c: ImportCandidate): string {
  return c.lastActivityAt ?? c.startedAt ?? ""
}

/**
 * List every EXTERNAL conversation that can be imported (reattached) as a live
 * session, newest first, across every store that declares a native reattach
 * path. `cwds` are the caller's known workspace directories — the search space
 * for cwd-scoped stores (claude-code ignores them, it scans globally).
 */
export async function listImportCandidates(
  opts: { cwds?: readonly string[] } = {},
  deps: ListImportCandidatesDeps = {},
): Promise<ImportCandidate[]> {
  const stores = deps.stores ?? CONVERSATION_STORES
  const scanClaude = deps.scanClaude ?? listClaudeConversationCandidates
  const out: ImportCandidate[] = []

  // claude-code: GLOBAL scan (each jsonl carries its own launch cwd).
  const claudeStore = stores["claude-code"]
  if (claudeStore?.attachArgv) {
    for (const c of await scanClaude()) {
      out.push({
        adapterSlug: "claude-code",
        harnessLabel: labelFor("claude-code"),
        conversationId: c.conversationId,
        attachArgv: claudeStore.attachArgv(c.conversationId),
        ...(c.cwd ? { cwd: c.cwd } : {}),
        ...(c.preview ? { preview: c.preview } : {}),
        ...(c.firstContentAt ? { startedAt: c.firstContentAt } : {}),
        ...(c.filePath ? { filePath: c.filePath } : {}),
      })
    }
  }

  // Every OTHER reattachable store (hermes, …): cwd-scoped discover across the
  // caller's known workspace cwds. A store without `attachArgv` is read-only
  // (codex/opencode/mastracode/pi) and is skipped — it cannot be reattached.
  const cwds = [...new Set(opts.cwds ?? [])]
  for (const [slug, store] of Object.entries(stores)) {
    if (slug === "claude-code" || !store.attachArgv) continue
    for (const cwd of cwds) {
      let found
      try {
        found = await store.discover({ cwd })
      } catch {
        continue // an unreadable store for one cwd never sinks the whole list
      }
      for (const c of found) {
        out.push({
          adapterSlug: slug,
          harnessLabel: labelFor(slug),
          conversationId: c.conversationId,
          attachArgv: store.attachArgv(c.conversationId),
          cwd,
          ...(c.preview ? { preview: c.preview } : {}),
          ...(c.startedAt ? { startedAt: c.startedAt } : {}),
          ...(c.lastActivityAt ? { lastActivityAt: c.lastActivityAt } : {}),
          ...(c.messageCount !== undefined ? { messageCount: c.messageCount } : {}),
        })
      }
    }
  }

  // Dedupe by (slug, id) — a cwd-scoped store can surface the same chat under
  // several cwds; keep the first hit.
  const seen = new Set<string>()
  const deduped = out.filter(c => {
    const k = `${c.adapterSlug}:${c.conversationId}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  deduped.sort((a, b) => recencyKey(b).localeCompare(recencyKey(a)))
  return deduped
}
