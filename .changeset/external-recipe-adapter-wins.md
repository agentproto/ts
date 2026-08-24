---
"@agentproto/runtime": patch
---

External subscription verification resolves the ADAPTER's recipe, never the profile's/config's source. An external surface verifies the adapter CLI's own login file, but `profile.source ?? adapter` let a source naming another CLI's login shadow the adapter recipe — observed live: spawning mastracode with the codex-local profile (`source: "codex"`) resolved the codex recipe and failed with "provider 'codex' has no method 'openai-oauth'" instead of checking mastracode's own auth.json. Both the access-profile path and the config-defaults path now pass the adapter slug; codex-local on the codex adapter is unchanged (source equalled the slug there, which is why the bug hid).
