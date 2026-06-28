---
"@agentproto/corpus-cli": minor
"@agentproto/corpus": patch
---

Caption-first video ingestion in `import-web`: a new `YtDlpCaptionsFetcher` FetcherPort pulls a video's subtitles/auto-captions via yt-dlp (no STT, no API key) and returns them as a transcript, wired ahead of the Whisper tier so captioned videos import for free. Adds a `--no-captions` flag; `--lang` drives `--sub-langs`. `corpus` gets a host.ts type annotation fix that unblocks its `.d.ts` build.
