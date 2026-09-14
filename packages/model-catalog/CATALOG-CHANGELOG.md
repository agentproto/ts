# Catalog Changelog

Human-readable log of model additions/removals detected by
`@agentproto/catalog-sync` runs — NOT `CHANGELOG.md` next to it (that one is
changesets-driven package-version history). A dated section is appended
automatically here whenever a sync run adds or removes model ids; sections
are appended at the END of the file (newest last). Pricing-only drift (no id
added/removed) is not logged here — see the generated files' own git history
for that.

## 2026-08-30

### llm:requesty
- Added: alibaba/qwen3.8-flash, alibaba/qwen3.8-max, bedrock/gpt-5.6-luna@us-east-1, bedrock/gpt-5.6-luna@us-east-2, bedrock/gpt-5.6-luna@us-west-2, bedrock/gpt-5.6-sol@us-east-1, bedrock/gpt-5.6-sol@us-east-2, bedrock/gpt-5.6-terra@us-east-1, bedrock/gpt-5.6-terra@us-east-2, bedrock/gpt-5.6-terra@us-west-2, deepinfra/Qwen/Qwen3-235B-A22B-Thinking-2507:flex, deepinfra/Qwen/Qwen3-32B:flex, deepinfra/Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo:flex, deepinfra/Qwen/Qwen3.5-27B:flex, deepinfra/Qwen/Qwen3.5-35B-A3B:flex, deepinfra/Qwen/Qwen3.5-397B-A17B:flex, deepinfra/XiaomiMiMo/MiMo-V2.5-Pro:flex, deepinfra/XiaomiMiMo/MiMo-V2.5:flex, deepinfra/deepseek-ai/DeepSeek-V3.1:flex, deepinfra/deepseek-ai/DeepSeek-V3:flex, deepinfra/deepseek-v4-flash-0424, deepinfra/deepseek-v4-flash-0424:flex, deepinfra/deepseek-v4-flash-0731, deepinfra/deepseek-v4-flash-0731:flex, deepinfra/deepseek-v4-pro-0424, deepinfra/deepseek-v4-pro-0424:flex, deepinfra/deepseek-v4-pro-0813, deepinfra/glm-5.2, deepinfra/glm-5.2:flex, deepinfra/glm-5.3, deepinfra/glm-5.3-flash, deepinfra/google/gemma-4-26B-A4B-it:flex, deepinfra/google/gemma-4-31B-it:flex, deepinfra/meta-llama/Llama-3.3-70B-Instruct-Turbo:flex, deepinfra/microsoft/phi-4:flex, deepinfra/moonshotai/Kimi-K2.6:flex, deepinfra/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B:flex, deepinfra/nvidia/Nemotron-3-Nano-30B-A3B:flex, deepinfra/qwen3.8, deepinfra/zai-org/GLM-5.1:flex, deepseek/deepseek-v4-flash-0731, deepseek/deepseek-v4-pro-0813, doubleword/deepseek-v4-flash-0424, doubleword/deepseek-v4-flash-0424:flex, doubleword/deepseek-v4-pro-0424, doubleword/deepseek-v4-pro-0424:flex, fireworks/deepseek-v4-flash-0731, fireworks/deepseek-v4-pro-0813, fireworks/glm-5.3, fireworks/kimi-k3, fireworks/muse-glimmer-30b, fireworks/nemotron-lightning-3.5-30b-a3b, fireworks/qwen3.8-max, google/gemini-2.5-flash-image, google/gemini-2.5-flash-lite:flex, google/gemini-2.5-flash:flex, google/gemini-2.5-pro:flex, google/gemini-3-flash-preview:flex, google/gemini-3-pro-image, google/gemini-3-pro-preview:flex, google/gemini-3.1-flash-lite:flex, google/gemini-3.1-pro-preview:flex, google/gemini-3.5-flash, google/gemini-3.5-flash-lite, google/gemini-3.5-flash-lite:flex, google/gemini-3.5-flash:flex, google/gemini-3.6-flash, google/gemini-3.6-flash:flex, minimaxi/minimax-m2, minimaxi/minimax-m2.5, minimaxi/minimax-m2.5-highspeed, minimaxi/minimax-m2.7, minimaxi/minimax-m2.7-highspeed, mistral/glm-5-2, nebius/deepseek-v4-pro-0424, nebius/kimi-k3, novita/deepseek/deepseek-v4-flash-0424, novita/deepseek/deepseek-v4-flash-0731, novita/glm-5.3-flash, novita/qwen/qwen3.8-max, novita/sao10k/l3-8b-stheno-v3.2, openai-responses/gpt-5.1:flex, openai-responses/gpt-5.2:flex, openai-responses/gpt-5.4-mini:flex, openai-responses/gpt-5.4-nano:flex, openai-responses/gpt-5.4:flex, openai-responses/gpt-5.5:flex, openai-responses/gpt-5.6-luna:flex, openai-responses/gpt-5.6-sol:flex, openai-responses/gpt-5.6-terra:flex, openai/gpt-5.1:flex, openai/gpt-5.2:flex, openai/gpt-5.4-mini:flex, openai/gpt-5.4-nano:flex, openai/gpt-5.4:flex, openai/gpt-5.5:flex, openai/gpt-5.6-luna:flex, openai/gpt-5.6-sol:flex, openai/gpt-5.6-terra:flex, parasail/deepseek-v4-flash-0424, parasail/gemma3-27b-it, relace/deepseek-v4-flash-0731, relace/glm-5.2, relace/glm-5.3-flash, relace/kimi-k3, runware/deepseek-v4-flash-0731, runware/glm-5.2, runware/glm-5.3-flash, runware/gpt-oss-120b, runware/qwen3.5-4b, runware/qwen3.5-9b, sail/deepseek-v4-flash-0731, sail/gemma-4-31b-it, sail/gemma-4-31b-it-nvfp4, sail/glm-5.2, sail/gpt-oss-120b, sail/kimi-k2.6, scaleway/deepseek-v4-flash-0731, scaleway/glm-5.2, scaleway/gpt-oss-120b, sference/deepseek-v4-flash-0731, sference/glm-5.3, sference/kimi-k3, tensorx/deepseek-v4-flash-0731, tensorx/deepseek-v4-pro-0424, tensorx/glm-5.3, tensorx/kimi-k3, tensorx/qwen3.8, tensorx/qwen3.8-2.4t-a95b, vertex/gemini-3-pro-image:flex, vertex/gemini-3.1-flash-image:flex, vertex/gemini-3.1-flash-lite:flex, vertex/gemini-3.5-flash-lite:flex, vertex/gemini-3.5-flash:flex, vertex/gemini-3.6-flash:flex, vertex/gemini-3.7-flash, vertex/gemini-3.7-flash@eu, xai/grok-4.6, zai/glm-5.3, zai/glm-5.3-flash
- Removed: anthropic/claude-opus-4-1, bedrock/claude-opus-5@ap-northeast-1, deepinfra/deepseek-ai/DeepSeek-V4-Flash, deepinfra/deepseek-ai/DeepSeek-V4-Pro, deepseek/deepseek-v4-flash, deepseek/deepseek-v4-pro, doubleword/deepseek-v4-flash, doubleword/deepseek-v4-flash:flex, doubleword/deepseek-v4-pro, doubleword/deepseek-v4-pro:flex, fireworks/deepseek-v4-flash, fireworks/deepseek-v4-pro, fireworks/minimax-m2.7, minimaxi/MiniMax-M2, minimaxi/MiniMax-M2.5, minimaxi/MiniMax-M2.5-highspeed, minimaxi/MiniMax-M2.7, minimaxi/MiniMax-M2.7-highspeed, nebius/deepseek-ai/deepseek-v4-pro, nebius/nvidia/nemotron-3-super-120b-a12b, novita/Sao10K/L3-8B-Stheno-v3.2, novita/deepseek/deepseek-v4-flash, openai-responses/gpt-5.1-codex, openai-responses/gpt-5.2-codex, openai-responses/gpt-5.3-chat, openai/gpt-5.1-chat, openai/gpt-5.2-chat, openai/gpt-5.3-chat, parasail/kimi-k2.7-code, parasail/parasail-deepseek-v4-flash, parasail/parasail-gemma3-27b-it, sference/deepseek-v4-flash, tensorx/deepseek-v4-flash, tensorx/deepseek-v4-pro

## 2026-08-31

### llm:huggingface
- Removed: nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16

### llm:context-windows
- Removed: kimi-k2.5, moonshot-v1-128k, moonshot-v1-128k-vision-preview, moonshot-v1-32k, moonshot-v1-32k-vision-preview, moonshot-v1-8k, moonshot-v1-8k-vision-preview, moonshot-v1-auto

### image:replicate
- Added: flux, flux-1.1-pro-ultra, flux-2-dev, flux-kontext-max, flux-kontext-pro, gpt-image-1, ideogram-v3, minimax, nano-banana, nano-banana-2, nano-banana-pro, recraft, seedream-4

### llm:context-windows
- Added: claude-haiku-4-5, claude-opus-4-5, claude-sonnet-4-5

## 2026-09-01

### llm:openrouter
- Added: anthropic/claude-fable-5.1, ibm-granite/granite-4.2-8b, inception/mercury-2.5-preview, openai/gpt-3.5-turbo:batch, openai/gpt-4-turbo:batch, openai/gpt-4.1-mini:batch, openai/gpt-4.1-nano:batch, openai/gpt-4.1:batch, openai/gpt-4o-mini:batch, openai/gpt-4o:batch, openai/gpt-5-mini:batch, openai/gpt-5-nano:batch, openai/gpt-5-pro:batch, openai/gpt-5.1:batch, openai/gpt-5.2-pro:batch, openai/gpt-5.2:batch, openai/gpt-5.4-mini:batch, openai/gpt-5.4-nano:batch, openai/gpt-5.4-pro:batch, openai/gpt-5.4:batch, openai/gpt-5.5-pro:batch, openai/gpt-5.5:batch, openai/gpt-5.6-luna-pro:batch, openai/gpt-5.6-luna:batch, openai/gpt-5.6-sol-pro:batch, openai/gpt-5.6-sol:batch, openai/gpt-5.6-terra-pro:batch, openai/gpt-5.6-terra:batch, openai/gpt-5:batch, openai/o3-mini:batch, openai/o3:batch, openai/o4-mini:batch
- Removed: anthropic/claude-opus-4.7-fast, anthropic/claude-opus-4.8-fast, anthropic/claude-opus-5-fast, kwaipilot/kat-coder-air-v2.5, mistralai/codestral-2508:batch, mistralai/ministral-8b-2512:batch, mistralai/mistral-large-2512:batch, mistralai/mistral-medium-3.1:batch, mistralai/mistral-small-2603:batch

### llm:huggingface
- Added: Qwen/Qwen2.5-7B-Instruct, nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16

### llm:context-windows
- Added: claude-fable-5-1

### image:replicate
- Added: flux, flux-1.1-pro-ultra, flux-2-dev, flux-kontext-max, flux-kontext-pro, gpt-image-1, ideogram-v3, minimax, nano-banana, nano-banana-2, nano-banana-pro, recraft, seedream-4

## 2026-09-05

### llm:openrouter
- Added: anthropic/claude-fable-5.1:batch, google/gemini-3.8-flash, google/gemini-3.8-flash:batch, inclusionai/ling-3.0-flash-fin, meta/muse-spark-1.3, meta/muse-spark-1.3-contributor, nvidia/nemotron-3.5-content-safety, openai/gpt-6-astra, openai/gpt-6-astra-pro, openai/gpt-6-astra-pro:batch, openai/gpt-6-astra:batch, qwen/qwen3.8-max-0902, x-ai/grok-4.3:batch, ~z-ai/glm-flash-latest
- Removed: ibm-granite/granite-4.1-8b, nvidia/nemotron-3-ultra-550b-a55b:batch, qwen/qwen3.8-max

### llm:huggingface
- Added: deepseek-ai/DeepSeek-V4-Flash-Vision-Exp, inclusionAI/Ling-3.0-flash-Fin
- Removed: Qwen/Qwen2.5-7B-Instruct, alpindale/WizardLM-2-8x22B

### image:replicate
- Added: flux, flux-1.1-pro-ultra, flux-2-dev, flux-kontext-max, flux-kontext-pro, gpt-image-1, ideogram-v3, minimax, nano-banana, nano-banana-2, nano-banana-pro, recraft, seedream-4

## 2026-09-07

### llm:huggingface
- Added: Qwen/Qwen2.5-7B-Instruct, alpindale/WizardLM-2-8x22B
- Removed: zai-org/GLM-5.1

### image:replicate
- Added: flux, flux-1.1-pro-ultra, flux-2-dev, flux-kontext-max, flux-kontext-pro, gpt-image-1, ideogram-v3, minimax, nano-banana, nano-banana-2, nano-banana-pro, recraft, seedream-4

## 2026-09-08

### llm:openrouter
- Added: deepseek/deepseek-v4-flash-vision-exp:batch, inception/mercury-2.5, z-ai/glm-5.2:batch, z-ai/glm-5.3:batch
- Removed: inception/mercury-2.5-preview, nex-agi/nex-n2-mini, nex-agi/nex-n2-pro

### llm:huggingface
- Added: zai-org/GLM-5.1

### image:replicate
- Added: flux, flux-1.1-pro-ultra, flux-2-dev, flux-kontext-max, flux-kontext-pro, gpt-image-1, ideogram-v3, minimax, nano-banana, nano-banana-2, nano-banana-pro, recraft, seedream-4

## 2026-09-13

### llm:opencode-go
- Added: opencode-go/deepseek-v4-flash, opencode-go/deepseek-v4-flash-vision-exp, opencode-go/deepseek-v4-pro, opencode-go/deepseek-v4.1-flash, opencode-go/glm-5, opencode-go/glm-5.1, opencode-go/glm-5.2, opencode-go/glm-5.3, opencode-go/glm-5.3-flash, opencode-go/gpt-5.6-luna, opencode-go/grok-4.5, opencode-go/grok-4.6, opencode-go/hy3, opencode-go/hy4-preview, opencode-go/kimi-k2.5, opencode-go/kimi-k2.6, opencode-go/kimi-k2.7-code, opencode-go/kimi-k3, opencode-go/longcat-2.0, opencode-go/mimo-v2-omni, opencode-go/mimo-v2-pro, opencode-go/mimo-v2.5, opencode-go/mimo-v2.5-pro, opencode-go/minimax-m2.5, opencode-go/minimax-m2.7, opencode-go/minimax-m3, opencode-go/muse-spark-1.2-contributor, opencode-go/muse-spark-1.3-contributor, opencode-go/omen-alpha, opencode-go/ox-alpha-free, opencode-go/qwen3.5-plus, opencode-go/qwen3.6-plus, opencode-go/qwen3.7-max, opencode-go/qwen3.7-plus, opencode-go/qwen3.8-flash, opencode-go/qwen3.8-max

### llm:opencode-zen
- Added: opencode/big-pickle, opencode/claude-3-5-haiku, opencode/claude-fable-5, opencode/claude-fable-5-1, opencode/claude-haiku-4-5, opencode/claude-opus-4-1, opencode/claude-opus-4-5, opencode/claude-opus-4-6, opencode/claude-opus-4-7, opencode/claude-opus-4-8, opencode/claude-opus-5, opencode/claude-sonnet-4, opencode/claude-sonnet-4-5, opencode/claude-sonnet-4-6, opencode/claude-sonnet-5, opencode/deepseek-v4-flash, opencode/deepseek-v4-flash-free, opencode/deepseek-v4-flash-vision-exp, opencode/deepseek-v4-pro, opencode/gemini-3-flash, opencode/gemini-3-pro, opencode/gemini-3.1-pro, opencode/gemini-3.5-flash, opencode/gemini-3.5-flash-lite, opencode/gemini-3.6-flash, opencode/gemini-3.7-flash, opencode/gemini-3.8-flash, opencode/glm-4.6, opencode/glm-4.7, opencode/glm-4.7-free, opencode/glm-5, opencode/glm-5-free, opencode/glm-5.1, opencode/glm-5.2, opencode/glm-5.3, opencode/glm-5.3-flash, opencode/gpt-5, opencode/gpt-5-codex, opencode/gpt-5-nano, opencode/gpt-5.1, opencode/gpt-5.1-codex, opencode/gpt-5.1-codex-max, opencode/gpt-5.1-codex-mini, opencode/gpt-5.2, opencode/gpt-5.2-codex, opencode/gpt-5.3-codex, opencode/gpt-5.3-codex-spark, opencode/gpt-5.4, opencode/gpt-5.4-mini, opencode/gpt-5.4-nano, opencode/gpt-5.4-pro, opencode/gpt-5.5, opencode/gpt-5.5-pro, opencode/gpt-5.6-luna, opencode/gpt-5.6-sol, opencode/gpt-5.6-terra, opencode/gpt-6-astra, opencode/grok-4.5, opencode/grok-4.6, opencode/grok-build-0.1, opencode/grok-code, opencode/hy3-free, opencode/hy3-preview-free, opencode/kimi-k2, opencode/kimi-k2-thinking, opencode/kimi-k2.5, opencode/kimi-k2.5-free, opencode/kimi-k2.6, opencode/kimi-k2.7-code, opencode/kimi-k3, opencode/laguna-s-2.1-free, opencode/ling-2.6-flash-free, opencode/ling-3.0-flash-fin-free, opencode/ling-3.0-flash-free, opencode/ling-3.0-tiny-free, opencode/longcat-2.0-free, opencode/mimo-v2-flash-free, opencode/mimo-v2-omni-free, opencode/mimo-v2-pro-free, opencode/mimo-v2.5-free, opencode/minimax-m2.1, opencode/minimax-m2.1-free, opencode/minimax-m2.5, opencode/minimax-m2.5-free, opencode/minimax-m2.7, opencode/minimax-m3, opencode/minimax-m3-free, opencode/muse-spark-1.2, opencode/muse-spark-1.2-contributor-free, opencode/muse-spark-1.3, opencode/muse-spark-1.3-contributor-free, opencode/nemotron-3-super-free, opencode/nemotron-3-ultra-free, opencode/nemotron-3.5-lightning-free, opencode/north-mini-code-free, opencode/qwen3-coder, opencode/qwen3.5-plus, opencode/qwen3.6-plus, opencode/qwen3.6-plus-free, opencode/ring-2.6-1t-free, opencode/trinity-large-preview-free, opencode/x-preview-f-free

## 2026-09-13

### llm:openrouter
- Added: deepseek/deepseek-v4.1-flash, inclusionai/ling-3.0-flash-vl, inference-net/schematron-v2-small, inference-net/schematron-v2-turbo, mistralai/codestral-2508:batch, mistralai/ministral-8b-2512:batch, mistralai/mistral-large-2512:batch, mistralai/mistral-medium-3.1:batch, mistralai/mistral-small-2603:batch, sakana/fugu-max, sakana/fugu-ultra-v2, ~openai/gpt-astra-latest, ~openai/gpt-luna-latest, ~openai/gpt-sol-latest, ~openai/gpt-terra-latest
- Removed: nousresearch/hermes-4-70b, ~openai/gpt-latest

### llm:huggingface
- Added: CohereLabs/command-a-plus-05-2026-bf16, CohereLabs/command-a-plus-05-2026-fp8, CohereLabs/command-a-plus-05-2026-w4a4, CohereLabs/command-a-vision-07-2025, deepseek-ai/DeepSeek-V4.1-Flash, google/gemma-3n-E4B-it, inclusionAI/Ling-3.0-flash-VL
- Removed: swiss-ai/Apertus-70B-Instruct-2509

### image:replicate
- Added: flux, flux-1.1-pro-ultra, flux-2-dev, flux-kontext-max, flux-kontext-pro, gpt-image-1, ideogram-v3, minimax, nano-banana, nano-banana-2, nano-banana-pro, recraft, seedream-4
