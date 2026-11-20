# @agentproto/voice-elevenlabs

ElevenLabs provider for `@agentproto/voice` (AIP-VOICE, draft
agentproto/agentproto#169). It is the default provider of the kit.

**Private for now** (`"private": true`): publishable at the publication step of
the kits work.

| Stage | What it uses |
|---|---|
| `tts` | `stream-input` WebSocket (streaming, `flush`, `end`, `cancel`) and the HTTP `stream` endpoint (file). PCM16 only. |
| `stt` | Scribe realtime WebSocket with manual commit (streaming, partials) and `speech-to-text` over HTTP (file). Stock subtitle-credit hallucinations are dropped (the final is delivered blank); turn off with `filterHallucinations: false`. |
| `realtime` | The hosted speech-to-speech agent (`VOICE_PROVIDER=elevenlabs-s2s`). |

It talks to ElevenLabs directly (`ws` and `fetch`); no agent framework.

## Configuration

- Key: `ELEVENLABS_API_KEY`, read at each call (or pass `apiKey`).
- Tuning lives in `@agentproto/voice/defaults` (`providers.elevenlabs`), each
  value with its origin. Override per call site through the config objects.
- The hosted agent is an object of **your** ElevenLabs account. Pass it as the
  opaque `provider` option of `VoiceStartOptions`: `{ agentId }` (needs the key)
  or `{ signedUrl }`. No account identifier lives in this package or in its
  fixtures.
- `VOICE_STT_PROVIDER=scribe` is a historical value that selects this provider.

## Tests and fixtures

`src/__tests__/fixtures/*.json` are real exchanges recorded against the API
(a few cents), redacted: audio cut, identifiers replaced, no key, no
authorization header. The test scans every fixture for credentials and for the
live key when it is in the environment. Provider tests replay them through the
`@agentproto/voice/testing` replay socket and `fetch`, and run the AIP
conformance cases. Re-record with `scripts/record.mjs` (needs
`ELEVENLABS_API_KEY`).

The hosted agent has no recording (it needs an agent of your own account;
set `ELEVENLABS_RECORD_AGENT_ID` to record one). Its tests are scripted from the
wire protocol the studio runs in production, and say so.
