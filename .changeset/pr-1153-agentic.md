---
"@agentproto/runtime": minor
"agentproto-desktop": minor
---

Add structured-question support. Sessions awaiting a structured question (e.g., context-continuity's continue-fresh/keep-going prompt) now display question text and clickable option buttons in a dedicated banner. Answer dispatch is wired into all prompt-turn seams (sendPrompt, enqueuePrompt, dispatchQueuedPrompt), intercepting exact option matches (case-insensitive) and routing them to their registered handlers. Unmatched prompts fall through to normal turn execution, preserving fallback behavior for unsupported or conversational replies. Context-continuity ask mode now tracks the acknowledgment percentage to suppress re-asking until context grows further. Desktop shell renders the QuestionBanner above the composer and displays question hints in the session rail with full text in tooltip.
