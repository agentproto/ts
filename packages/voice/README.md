# @agentproto/voice

Reference implementation of AIP-VOICE ([agentproto/agentproto#169](https://github.com/agentproto/agentproto/pull/169),
`voice/v1`, Draft): three provider contracts, one voice session with two
engines, and the variables that choose them.

**Private for now.** This package is not published (`"private": true`). It
becomes publishable at the publication step of the kits work, not before.

## What is here

- `SttProvider`, `TtsProvider`, `RealtimeProvider` and `defineVoiceProvider`
  (`src/types.ts`, `src/define.ts`).
- The provider registry, mounted with `makeProviderFamily()` from
  `@agentproto/provider-kit` (`src/registry.ts`): a slug resolves to an
  in-process provider or to a dynamic import of `@agentproto/voice-<slug>`.
- `VoiceSession` and its two engines: `startRealtime(provider, opts)` and
  `startCascade(opts)` (`src/realtime.ts`, `src/cascade/`).
- The `VOICE_PROVIDER` / `VOICE_STT_PROVIDER` / `VOICE_TTS_PROVIDER` /
  `VOICE_ID` priority rule (`src/selection.ts`).
- One defaults file, `src/defaults.ts`, every value with its origin.
- `@agentproto/voice/testing`: fake providers and AIP-VOICE conformance cases.

No provider lives here (they are `@agentproto/voice-<slug>` packages) and no
agent framework is imported.

## The cascade

`startCascade` runs the local part of a cascaded conversation: a silence VAD,
barge-in (abort the brain and cancel TTS first, then purge, then emit
`interrupt`), a bounded outbound queue, streaming STT with a fallback to file
transcription, and brain guards. The brain yields reply text; the engine owns
synthesis. `vad: false` is a manual mode (push-to-talk): `commit()` ends the
utterance.

`src/cascade/pipeline.ts` and `src/cascade/speak-turn.ts` are ported from the
studio call pipeline; the headers say what was removed on purpose and why.

## Defaults

The default engine is the cascade with ElevenLabs on both stages. OpenAI,
AssemblyAI and Gemini are providers selected by slug. A deployment that wants
OpenAI file transcription sets `VOICE_STT_PROVIDER=whisper`: the kit default
changes, no existing value changes meaning.

## Usage

```ts
import { makeVoiceRegistry, resolveVoiceSelection, startCascade } from "@agentproto/voice"

const registry = makeVoiceRegistry()
const sel = await resolveVoiceSelection(process.env, registry)
if (sel.engine === "cascade") {
  const session = await startCascade({
    emit, hooks,
    stt: await registry.stt(sel.stt!),
    tts: await registry.tts(sel.tts!),
    ...(sel.voiceId ? { voiceId: sel.voiceId } : {}),
    brain: ({ text, signal }) => myBrain(text, signal), // AsyncIterable<string>
  })
}
```

## Spec number

The spec is referred to as AIP-VOICE in this package until it has a number in
the canonical registry (draft: agentproto/agentproto#169). `check-aip-refs`
fails on an AIP number that does not resolve yet; the number goes back in once
the spec merges.
