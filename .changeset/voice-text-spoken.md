---
"@agentproto/voice": minor
---

Add `@agentproto/voice/text`: deterministic spoken-text normalization (`toSpokenText`, `normalizeWrittenForms`, `splitSpokenText`, `hasWrittenOnlyContent`, `SPEECH_CHARS_PER_SECOND`). Strips chat formatting and rewrites numbers, dates, times, money, percentages, ordinals, abbreviations and units to words in French and English. Host-specific labels to drop are passed with `stripLabels`; no length limit or environment variable is read.
