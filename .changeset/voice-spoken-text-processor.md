---
"@agentproto/voice": minor
---

Add `spokenTextProcessor({ locale, stripLabels })` to `@agentproto/voice/text`: the reference `textOut` transformer, named `spoken-text`. It buffers streamed reply text up to a sentence boundary (or the end-of-reply chunk) before normalizing it, so numbers and dates are never cut between chunks; brain events pass through untouched.
