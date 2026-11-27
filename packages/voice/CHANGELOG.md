# @agentproto/voice

## 0.2.0

### Minor Changes

- bc39e63: Add `@agentproto/billing/spend` (`createHolds`: reserve before a metered action, settle at the real cost capped to the reserve, release on failure, sweep the holds a crash left open, all idempotent by key, on the AIP-49 `reserve`/`capture`/`release` verbs) and `guardVoiceCall` in `@agentproto/voice` (authorize before the call opens, poll a balance checkpoint with warn and cutoff, settle in a `finally`).

  Contract tests a host overlay runs on every upgrade are exported: `holdsContractCases` (`@agentproto/billing/contract-tests`) and `voiceBillingGateConformanceCases` (`@agentproto/voice/testing`).

- 83b3c87: Add `deltasToIterable` (callback brain to `AsyncIterable<string>`) and `usageToCatalogEvents` / `catalogModelId` / `normalizeModelId` (usage record to billable events keyed by a catalog model id, per-provider mapping supplied by the host), so hosts stop copying them. Usage entries and catalog events carry an optional, opaque `credentialSource` label, set with `UsageMeter.setCredentialSource`.
- 0364992: Add `VoiceStartOptions.onUsage`: the final usage record is handed to the host once when a cascade or realtime session closes (same content as `getUsage()` after `close()`). A throwing or rejecting sink is swallowed and never affects the session.
- fa96d71: Add `createPlaybackClock`, a server-side estimate of the client's playback queue (`sent`, `reset`, `queuedMs`, `waitBelow`) to pass as `CascadeOptions.playback`, so hosts no longer copy it.
- 797624c: Add a processor pipeline to the cascade engine: `Transformer` (on the path, measured budget, fail-open, circuit breaker) and `Observer` (off the path, read-only, bounded queue), `defineTransformer` / `defineObserver`, `ProcessorConfigError` raised at mount for missing or duplicate names, shared facets without `after`, and bad budgets, `processors` in the start options, `hooks.onProcessorEvent`, `session.getProcessorStats()`, and `BrainEvent` (`activity`, `tool-start`) so a long tool call resets the brain guards. The `textOut` point (reply text before sentence splitting and TTS) is active; `audioIn`, `transcript` and `audioOut` are reserved. `@agentproto/voice/testing` gains `runProcessorContractSuite` and `makeReferenceProcessorSession`.
- 615cb30: Add `spokenTextProcessor({ locale, stripLabels })` to `@agentproto/voice/text`: the reference `textOut` transformer, named `spoken-text`. It buffers streamed reply text up to a sentence boundary (or the end-of-reply chunk) before normalizing it, so numbers and dates are never cut between chunks; brain events pass through untouched.
- 1601a5a: STT usage entries now carry the vendor model that transcribed the utterance. `SttProvider` gains an optional `models: { stream?, file? }` (the realtime stream and file transcription run different models) and the cascade copies the one that produced each utterance onto the usage entry, as it already does for TTS. The ElevenLabs, OpenAI and AssemblyAI providers report theirs.
- f670111: Add `@agentproto/voice/text`: deterministic spoken-text normalization (`toSpokenText`, `normalizeWrittenForms`, `splitSpokenText`, `hasWrittenOnlyContent`, `SPEECH_CHARS_PER_SECOND`). Strips chat formatting and rewrites numbers, dates, times, money, percentages, ordinals, abbreviations and units to words in French and English. Host-specific labels to drop are passed with `stripLabels`; no length limit or environment variable is read.

## 0.1.0

### Minor Changes

- 1bd0a31: Add `@agentproto/voice-openai`, the OpenAI voice provider: Whisper file-based STT, HTTP TTS, and a GA Realtime WebSocket session (audio in/out, barge-in interruption, function-calling, usage metering). The provider registers under `openai` with a `whisper` STT value alias, ships recorded wire fixtures that the test suite secret-scans, and is declared in the `voice` registry's provider catalog.

  Also fix the voice cascade pipeline's `onTurnEnd` precedence: it no longer fires after `close()`, even when the turn ended voluntarily.

  `@agentproto/voice` becomes publishable (drops `"private": true`), so this release is its first publish (0.0.0 to 0.1.0).

- 5b792bc: Voice kit: new voice settings in `@agentproto/voice` defaults. Turn-level TTS mode (`ttsMode`, default `http-sentence`, `VOICE_TTS_MODE` spellings accepted via `ttsModeFromEnv`) and per-sentence transport (`ttsTransport`, streaming by default, `http` opt-out via `ttsTransportFromEnv`). Session mic-idle close (`idleMicMs`, default 60 s, 0 disables, `hooks.onMicIdle` notified). Three-guard STT dedup (`sttDedup`, on by default: duplicate transcripts within 5 s, assistant echo within 10 s at 60 % token overlap; `false` disables). PCM16 even-chunk alignment guarantee (`Pcm16ChunkAligner`, applied to every emitted audio frame). Data-only defaults for a future WebRTC/Opus transport and the per-vendor billing model ids. All existing tests stay green; defaults change, no existing value changes meaning.

### Patch Changes

- fdb4d55: Add `@agentproto/voice-gemini`, a Gemini Live (BidiGenerateContent) realtime provider for `@agentproto/voice`: one WebSocket per session, a single setup frame (bidi model, AUDIO responses, voice, both transcriptions, JSON-Schema tool declarations), base64 PCM16 input with `activityEnd` commits, tool-call round trips, interrupted-turn handling and usage mapping. `refreshTools()` reconnects with a fresh setup because the Live wire freezes tools at setup.

  Update the `gemini` provider defaults comment in `@agentproto/voice` to record that the model catalog's `google/gemini-live` entry now carries the same bidi Live model id.

- 81b8e59: Reopen the realtime transcription stream when it drops after a turn, instead of staying on file transcription (about 0.3 to 0.6 s slower per turn) for the rest of the call. A failed reopen is retried with a backoff and gives up after three attempts, falling back to file transcription as before.
- 23a5c2c: The TTS usage entry now carries the vendor model that ran. `TtsProvider` gets an optional `model`, the cascade passes it to the usage meter (which already accepted one but was never given it), and the ElevenLabs and OpenAI providers report theirs. Without it a host could only guess which model to price the characters against.
- Updated dependencies [765660d]
- Updated dependencies [1741e68]
- Updated dependencies [89258dd]
  - @agentproto/provider-kit@0.7.0
