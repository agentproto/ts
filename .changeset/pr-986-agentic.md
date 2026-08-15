---
"@agentproto/adapter-jcode": patch
"@agentproto/cli": patch
"@agentproto/provider-presets": patch
---

Documentation updates for CLI enhancements, adapter protocol changes, and provider preset expansion.

- **@agentproto/adapter-jcode**: Updated protocol documentation to reflect NDJSON streaming support and added exit code semantics for setup requiring TTY (code 78).
- **@agentproto/cli**: Documented new session commands (`prompt`, `pin`, `unpin`), daemon capabilities (PATH self-healing, version reporting in `/health`), file upload endpoint for `app serve`, and added grok-cli adapter reference.
- **@agentproto/provider-presets**: Added documentation for new provider presets: OpenAI, Mistral, Groq, Nebius, Hugging Face, and DeepInfra.

