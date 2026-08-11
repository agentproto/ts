---
"@agentproto/adapter-jcode": minor
"@agentproto/cli": patch
---

Add AIP-45 adapter for 1jehuang/jcode — a RAM-efficient Rust coding agent with semantic memory, multi-agent swarm coordination, and multi-provider support (Claude, OpenAI, Gemini, OpenRouter, DeepSeek, Groq, Mistral, Ollama).

Adapter uses `print` protocol (headless mode): spawns `jcode run "<prompt>"` per turn and captures stdout. No ACP mode is currently documented; swarm coordination not yet wired.
