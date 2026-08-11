# jcode adapter

AIP-45 adapter for [1jehuang/jcode](https://github.com/1jehuang/jcode) — a
RAM-efficient Rust coding agent with semantic memory, multi-agent swarm
coordination, and broad provider support.

## Protocol

`print` — spawns `jcode run "<prompt>"` per turn. No ACP or structured JSON
streaming mode is currently documented; stdout is captured as raw text.

## Installation

```bash
# Homebrew (macOS)
brew tap 1jehuang/jcode && brew install jcode

# curl (Linux/macOS)
curl -fsSL https://jcode.sh/install | bash

# From source
git clone https://github.com/1jehuang/jcode.git && cargo build --release
```

## Authentication

jcode reads provider API keys from the environment:

| Provider   | Env var              |
|------------|----------------------|
| Anthropic  | `ANTHROPIC_API_KEY`  |
| OpenAI     | `OPENAI_API_KEY`     |
| OpenRouter | `OPENROUTER_API_KEY` |
| Google     | `GOOGLE_API_KEY`     |
| DeepSeek   | `DEEPSEEK_API_KEY`   |
| Groq       | `GROQ_API_KEY`       |
| Mistral    | `MISTRAL_API_KEY`    |

Interactive login is also available: `jcode login --provider <name>`.

## Capabilities

- Multi-provider model routing via `--model` / `--provider`
- Semantic vector memory (ambient recall without explicit tool calls)
- Multi-agent swarm with conflict detection and inter-agent messaging
- MCP server support (`~/.jcode/mcp.json` and `.jcode/mcp.json`)
- Session resume via `--resume <name>`
- Voice input via `jcode dictate`

## Known gaps

- No ACP mode — adapter uses print/headless arm
- No structured JSON streaming output — events are raw text
- Swarm coordination not yet wired into the adapter
- Browser tool (Firefox Agent Bridge) not exposed
