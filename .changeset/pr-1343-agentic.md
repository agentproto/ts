---
"@agentproto/corpus-cli": minor
---

Add structured speaker utterances from diarized transcription: `SttPort`'s `Transcript` gains an optional `utterances` field (`Utterance[]` with speaker, text, and optional second-based start/end), populated by AssemblyAI and time-shifted to absolute offsets by `ChunkedStt`; `YtDlpWhisperFetcher` now emits `via: "diarized-transcription"` with `metadata.speech` (diarized flag, engine, distinct speaker count) when utterances are present.
