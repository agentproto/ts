# Conversation "book" view — M0 spec (validated 2026-08-08)

Design record: `conversation-revamp-mock-v8-asks.html` (THE reference — open it),
lineage v5→v8 in this directory. Design language: `vscode-design-language.html`
(five rules apply: labeled buttons, dots are state not controls, muted status
trio, failures render a state, clay destructive / moss-tint primary).

## The model

A session renders as a BOOK, not a chat log:

- **Chapters split on asks.** Every user prompt closes the previous chapter and
  opens a new one, with the user's message as the chapter's opening "ask card".
  A turn-end with no follow-up prompt also closes the open chapter.
  (M0 boundaries = user-prompt + turn-end ONLY. No mid-turn inference.)
- **Past chapters are FOLDED to one line**: outcome title (serif) + tiny `◈ you`
  origin mark when user-opened + faint duration. Click/Enter unfolds.
- **Unfolded chapter anatomy**: ask card (user's words, upright serif, tinted
  paper block, `$ full message` if truncated) OR nothing for turn-end-split
  chapters in M0 → narrative paragraphs → `$ show N steps` line.
- **Narrative = the agent's own narration lines** (assistant text blocks),
  verbatim, tool noise stripped. NO LLM rewriting in M0. Title of a folded
  chapter = first narration sentence of the chapter, trimmed to ~70 chars.
- **Steps layer**: the existing step-group segmentation (the `✓ N steps ·
  1 failed` data) renders behind `$ show N steps` per chapter — reuse the
  current grouping logic verbatim, restyled per mock (tool · what · duration;
  failed = strikethrough + recovery note when a subsequent step succeeded).
- **Live chapter never folds**: streaming narration exactly as today, ending
  with a blinking phosphor block cursor (respect prefers-reduced-motion); a
  mono `$ now: <current tool/cmd> · elapsed` line beneath while a tool runs.
- **The pause**: when the session hits awaiting-input with a question, render
  the inverted PAPER card (light on dark, phosphor block marker, serif
  question). M0: render the card + focus the composer; structured answer
  buttons are M1.
- **Composer unchanged functionally**; placeholder becomes
  "write back — your message opens the next chapter…".
- **Escape hatch (mandatory)**: a `transcript` toggle in the header switches to
  the CURRENT raw rendering. Book is default; toggle persists per session.

## Typography & palette (fixed, not vscode-themed — same posture as the
sessions revamp's locked palette)

- ink `#1b1b1c` bg · ink-2 `#232324` · edge `#333335` · paper `#f4f0e6` at
  100/72/45/28% tiers · phosphor `#2f9e63` accent only.
- Prose: `Charter,'Iowan Old Style',Georgia,serif` 14.5px/1.85 (NO webfont
  dependency — system stack, offline-safe). Chrome/steps/kickers:
  `ui-monospace,'SF Mono',Menlo,monospace`. Titles serif 600.

## Implementation constraints

- **Extension-only. Zero daemon changes, zero protocol changes.** Everything
  derives from data the webview already receives (conversation events, step
  groups, prompts, turn boundaries).
- Pure logic first: chapter segmentation as tested pure functions in a
  `.logic.ts` module (input: ordered conversation events; output: chapters[]
  {ask?, narrationBlocks, stepGroups, title, durationMs, origin}) + fold-state
  handling. DOM tests per the existing `.dom.test.ts` conventions.
- Do NOT commit this spec or any design/*.html mock. No AI attribution
  (no Co-authored-by, no Generated-with). Conventional commits.
- Keyboard: fold rows tabindex=0, Enter toggles; toggle + links are real
  <button>/<a>.

## Definition of done

typecheck + package tests + build green from the worktree root · branch pushed ·
PR titled `feat(vscode): conversation book view — chapters split on asks (M0)`
describing the model (ask→work→outcome→proof), the M0 boundaries, the
no-daemon-changes note, and the transcript escape hatch.
