# @agentproto/voice

Reference implementation of AIP-VOICE ([agentproto/agentproto#169](https://github.com/agentproto/agentproto/pull/169),
`voice/v1`, Draft): three provider contracts, one voice session with two
engines, and the variables that choose them.

**Public.** This package is published to npm as `@agentproto/voice`, the base
that provider packages such as `@agentproto/voice-openai` depend on.

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

`src/cascade/pipeline.ts` and `src/cascade/speak-turn.ts` hold the call pipeline; the headers say what is left out on purpose and why.

## Defaults

The default engine is the cascade with ElevenLabs on both stages. OpenAI,
AssemblyAI and Gemini are providers selected by slug. A deployment that wants
OpenAI file transcription sets `VOICE_STT_PROVIDER=whisper`: the kit default
changes, no existing value changes meaning.

Also in `src/defaults.ts` (each value with its origin): the turn-level TTS
mode (`ttsMode`, `http-sentence` by default, `ws-continuous` opt-in, the
studio `VOICE_TTS_MODE` spellings accepted and read by `ttsModeFromEnv`), the
per-sentence TTS transport (`ttsTransport`, the provider's streaming socket by
default, `http` to opt out — `ttsTransportFromEnv`), the session mic-idle
close (`idleMicMs`, 60 s by default: vendors that bill the open socket per
second do not keep a forgotten session alive; 0 disables it;
`hooks.onMicIdle` is notified), the three-guard STT dedup (`sttDedup`, on by
default: identical transcripts inside 5 s and echoes of the assistant inside
10 s at 60 % token overlap never start a turn; `false` disables it), the
PCM16 even-chunk guarantee (`Pcm16ChunkAligner`, applied on every emitted
audio frame), and the data-only WebRTC/Opus transport values and per-vendor
billing model ids for future consumers.

Echo guard caveat: the STT dedup also drops a short genuine reply whose tokens
mostly appear in the assistant's last utterance within 10 s (answering "yes"
right after the assistant said "...say yes..."). Tune the thresholds or set
`sttDedup: false` if your prompts invite that kind of reply.

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

## Usage sink

Pass `onUsage(usage)` in the start options to receive the final `VoiceUsage`
once when the session closes (cascade or realtime). A sink that throws or
rejects is ignored; it never interrupts audio or fails the close.

## Spec number

The spec is referred to as AIP-VOICE in this package until it has a number in
the canonical registry (draft: agentproto/agentproto#169). `check-aip-refs`
fails on an AIP number that does not resolve yet; the number goes back in once
the spec merges.
