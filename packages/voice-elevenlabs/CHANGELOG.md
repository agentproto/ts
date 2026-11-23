# @agentproto/voice-elevenlabs

## 0.1.0

### Minor Changes

- 4a1f0b5: Add `@agentproto/voice-elevenlabs`, the ElevenLabs voice provider for `@agentproto/voice`: TTS (HTTP + WebSocket), Scribe file streaming STT and the S2S conversational agent over WebSocket, plus hallucination detection. The package ships its built `dist/` (`files: dist, README.md, LICENSE`), talks to ElevenLabs directly, and registers in the `voice` registry's provider catalog. First npm release: `0.0.0` → `0.1.0` (minor changeset; publish decision owner + second opinion, 2026-11-21).

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
