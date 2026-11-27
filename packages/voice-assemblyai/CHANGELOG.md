# @agentproto/voice-assemblyai

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

- 692dd3b: Publish `@agentproto/billing` and `@agentproto/voice-assemblyai` to npm at 0.1.0: drop `"private": true` and add the standard `publishConfig.access: "public"` that every published `@agentproto/*` package carries. (`@agentproto/voice` was already made publishable in #2806.) Both ship their built `dist/` (`files: dist, README.md, LICENSE`), and their workspace dependencies (`@agentproto/provider-kit`, `@agentproto/doctype`, `@agentproto/product`, `@agentproto/wallet`) are already on npm, so `workspace:*` resolves at publish. First release for the two names; changesets bump `0.0.0` → `0.1.0` (minor).

### Patch Changes

- Updated dependencies [1bd0a31]
- Updated dependencies [fdb4d55]
- Updated dependencies [5b792bc]
- Updated dependencies [81b8e59]
- Updated dependencies [23a5c2c]
  - @agentproto/voice@0.1.0
