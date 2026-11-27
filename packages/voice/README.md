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
- `@agentproto/voice/text`: pure spoken-text normalization for any TTS path
  (`src/text/`). `toSpokenText(text, locale?, { stripLabels? })` strips
  markdown, arrows, emojis and URLs and rewrites numbers, dates, times, money,
  percentages, ordinals, abbreviations and units to words (French and
  English); `normalizeWrittenForms`, `splitSpokenText` (sentence-boundary
  split, never mid-sentence), `hasWrittenOnlyContent` (code fences, tables),
  `SPEECH_CHARS_PER_SECOND`, and `spokenTextProcessor({ locale, stripLabels })`, the reference `textOut` transformer named `spoken-text` (holds text to a sentence boundary so a number is never cut between two chunks, passes brain events through). No I/O and no limit policy: label stripping and
  length caps belong to the host.
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

## Playback clock

When the host sends reply audio faster than the client plays it, give the
cascade a view of the client's queue so barge-in and turn settling follow what
the caller actually hears:

```ts
import { createPlaybackClock, startCascade } from "@agentproto/voice"

const playback = createPlaybackClock()
// startCascade({ ..., playback })
// after each audio chunk written to the client:  playback.sent(chunkMs)
// when the client flushes its queue (interrupt):  playback.reset()
```

## Brain callbacks and billing events

`deltasToIterable(run)` adapts a callback-style brain (`run(onDelta)`) to the
`AsyncIterable<string>` the cascade expects; a one-block answer with no delta
is still yielded.

`usageToCatalogEvents(session.getUsage(), { providers })` turns the usage record
into `{ kind, modelId, characters | seconds }` events keyed by a catalog id
(`<prefix>/<normalised model>`). Each provider is described by the host
(catalog prefix, vendor model prefix to strip, optional fallback model per
stage); entries with no mapping or no model are listed in `unbilled`, never
guessed. Pricing stays with the host. `meter.setCredentialSource(label)` tags every usage entry with an opaque host-defined label (for example whose key paid); the label is copied onto each event and the kit never interprets it.

## Processors

A cascade session can run **processors**: small named units that change or
watch what flows through four points (`audioIn`, `transcript`, `textOut`,
`audioOut`). Today the cascade engine runs `textOut` (the reply text, before
sentence splitting and TTS); the other three points are *reserved*: a
processor may be declared there and is validated at mount, but the engine
reports it `bypassed` (reason `reserved-hook`) until two products need it.

- **Transformer**: on the path, one item at a time, in the array order. It
  returns the item (changed or not), several items, or `null` to drop it. It has
  a measured time budget (defaults in `VOICE_DEFAULTS.processors`, overridable
  by `budgetMs`, `0` = none); on an exception, a rejection, an invalid result or
  an overrun the input goes on unchanged and `hooks.onProcessorEvent` is told.
  Five failures in a row bypass it for the rest of the call.
- **Observer**: off the path, never awaited, read-only (it gets a frozen copy of
  what leaves the transformers), bounded queue, can `ctx.publish(data)`.
- Every processor has a unique `name`. A transformer declares the facets it
  `modifies`; two transformers of one point that share a facet are only accepted
  if the later one lists every earlier one in `after`. A bad array makes
  `startCascade` reject with a `ProcessorConfigError` (`code`, `names`, `facet`)
  before any socket opens.
- `ctx.signal` is aborted at barge-in (textOut/audioOut) and on close. Pass it to
  any I/O. A processor that ignores it is reported `abandoned` after
  `stopDeadlineMs`; the engine never waits longer than that to interrupt or close.
- `emit.assistantTranscript` shows the brain's own text; the TTS, and the
  characters counted in the usage record, follow the processed text.
- `session.getProcessorStats()` gives `count / p50Ms / p95Ms / maxMs / overruns`
  per processor.

### Writing an overlay

An overlay is a package of your own that exports factories returning processors,
plus a function that assembles the ordered array for a product. Nothing in the
kit knows your product: word lists, phrases and rules are arguments.

```ts
import { defineTransformer, startCascade } from "@agentproto/voice"

/** Replace words the TTS says badly. The list belongs to the caller. */
export const glossary = (entries: Record<string, string>) =>
  defineTransformer({
    name: "glossary",
    hook: "textOut",
    modifies: ["text:glossary"],
    run: chunk => {
      let text = chunk.text
      for (const [word, spoken] of Object.entries(entries)) text = text.split(word).join(spoken)
      return text === chunk.text ? chunk : { ...chunk, text }
    },
  })

export const processorsFor = (product: { glossary: Record<string, string> }) => [glossary(product.glossary)]

// startCascade({ ..., processors: processorsFor(myProduct) })
```

A gain on outbound audio (a reserved point, run here on the runtime) is in
`src/__tests__/processors-example.test.ts` next to the glossary above; both are
executed by the tests.

### Contract tests

`@agentproto/voice/testing` exports `runProcessorContractSuite({ name,
makeSession })` (and `processorContractCases` for another runner): 13 cases for
the active point and the observers. An overlay runs it on its own processor
arrays in CI, and again on every kit version bump. `makeReferenceProcessorSession`
is the kit's own `makeSession`.

## Spec number

The spec is referred to as AIP-VOICE in this package until it has a number in
the canonical registry (draft: agentproto/agentproto#169). `check-aip-refs`
fails on an AIP number that does not resolve yet; the number goes back in once
the spec merges.
