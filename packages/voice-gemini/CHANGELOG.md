# @agentproto/voice-gemini

## 0.1.1

### Patch Changes

- 8e61d2f: Weekly dependency refresh (minor-patch).

## 0.1.0

### Minor Changes

- fdb4d55: Add `@agentproto/voice-gemini`, a Gemini Live (BidiGenerateContent) realtime provider for `@agentproto/voice`: one WebSocket per session, a single setup frame (bidi model, AUDIO responses, voice, both transcriptions, JSON-Schema tool declarations), base64 PCM16 input with `activityEnd` commits, tool-call round trips, interrupted-turn handling and usage mapping. `refreshTools()` reconnects with a fresh setup because the Live wire freezes tools at setup.

  Update the `gemini` provider defaults comment in `@agentproto/voice` to record that the model catalog's `google/gemini-live` entry now carries the same bidi Live model id.

### Patch Changes

- 5b792bc: Remove private product and repository names from comments, docs, examples and tests.

  `@agentproto/auth` no longer ships a vendor provider: the `acmeAuthProvider`-style builtin export is removed and `BUILTIN_AUTH_PROVIDERS` is empty, so the registry starts empty. A host declares its own provider with `parseAuthProviderManifest` (or `defineAuthProvider`) and `registerAuthProvider`, which already existed. Breaking for code that imported the old export or looked the old id up without registering it.

  `@agentproto/role-catalog`: the legacy role map export is now `LEGACY_OPERATOR_ROLE_MAP`.

  `@agentproto/apps` (session-steward): new `extraClosableOrigins` input appended to the closable origin list in force. The generic default roots are `orchestrator` and `orchestrator:*`; a host that stamps its own root label adds it with `extraClosableOrigins`.

  The private Replicate fine-tune entry is dropped from the model catalog.

- Updated dependencies [1bd0a31]
- Updated dependencies [fdb4d55]
- Updated dependencies [5b792bc]
- Updated dependencies [81b8e59]
- Updated dependencies [23a5c2c]
  - @agentproto/voice@0.1.0
