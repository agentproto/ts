---
"@agentproto/corpus-cli": minor
---

`import-web` now accepts a local audio/video file path or `file://` URI as a `--url` — a new `LocalFileFetcher` tier recognises it's already media on disk, skips the yt-dlp tiers entirely, and feeds it straight to the configured STT (`--diarize` for AssemblyAI, else Whisper). Extracted `isSttAuthError` out of `ytdlp-whisper-fetcher.adapter.ts` into `stt.port.ts` so both fetchers share the same auth-failure classification.
