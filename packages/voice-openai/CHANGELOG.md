# @agentproto/voice-openai

## 0.2.0

### Minor Changes

- 1601a5a: STT usage entries now carry the vendor model that transcribed the utterance. `SttProvider` gains an optional `models: { stream?, file? }` (the realtime stream and file transcription run different models) and the cascade copies the one that produced each utterance onto the usage entry, as it already does for TTS. The ElevenLabs, OpenAI and AssemblyAI providers report theirs.

### Patch Changes

- Updated dependencies [bc39e63]
- Updated dependencies [83b3c87]
- Updated dependencies [0364992]
- Updated dependencies [fa96d71]
- Updated dependencies [797624c]
- Updated dependencies [615cb30]
- Updated dependencies [1601a5a]
- Updated dependencies [f670111]
  - @agentproto/voice@0.2.0

## 0.1.1

### Patch Changes

- 8e61d2f: Weekly dependency refresh (minor-patch).

## 0.1.0

### Minor Changes

- 1bd0a31: Add `@agentproto/voice-openai`, the OpenAI voice provider: Whisper file-based STT, HTTP TTS, and a GA Realtime WebSocket session (audio in/out, barge-in interruption, function-calling, usage metering). The provider registers under `openai` with a `whisper` STT value alias, ships recorded wire fixtures that the test suite secret-scans, and is declared in the `voice` registry's provider catalog.

  Also fix the voice cascade pipeline's `onTurnEnd` precedence: it no longer fires after `close()`, even when the turn ended voluntarily.

  `@agentproto/voice` becomes publishable (drops `"private": true`), so this release is its first publish (0.0.0 to 0.1.0).

### Patch Changes

- 5b792bc: Remove private product and repository names from comments, docs, examples and tests.

  `@agentproto/auth` no longer ships a vendor provider: the `acmeAuthProvider`-style builtin export is removed and `BUILTIN_AUTH_PROVIDERS` is empty, so the registry starts empty. A host declares its own provider with `parseAuthProviderManifest` (or `defineAuthProvider`) and `registerAuthProvider`, which already existed. Breaking for code that imported the old export or looked the old id up without registering it.

  `@agentproto/role-catalog`: the legacy role map export is now `LEGACY_OPERATOR_ROLE_MAP`.

  `@agentproto/apps` (session-steward): new `extraClosableOrigins` input appended to the closable origin list in force. The generic default roots are `orchestrator` and `orchestrator:*`; a host that stamps its own root label adds it with `extraClosableOrigins`.

  The private Replicate fine-tune entry is dropped from the model catalog.

- 23a5c2c: The TTS usage entry now carries the vendor model that ran. `TtsProvider` gets an optional `model`, the cascade passes it to the usage meter (which already accepted one but was never given it), and the ElevenLabs and OpenAI providers report theirs. Without it a host could only guess which model to price the characters against.
- Updated dependencies [1bd0a31]
- Updated dependencies [fdb4d55]
- Updated dependencies [5b792bc]
- Updated dependencies [81b8e59]
- Updated dependencies [23a5c2c]
  - @agentproto/voice@0.1.0
