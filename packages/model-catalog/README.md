# @agentproto/model-catalog

A dependency-light (**zod-only**) unified model catalog for LLM, image, video,
audio and voice models — with a cost dispatcher, curation, pricing, and a
picker.

This is the OSS core. Downstream consumers layer their own policy on top:
`@agstudio/model-catalog` adds billing / access / BYOK; the `agentproto` CLI
adds a provider-key store and the `agentproto models` picker.

## Install

```bash
npm add @agentproto/model-catalog
```

## Subpaths

| Import | What |
| --- | --- |
| `@agentproto/model-catalog` | everything re-exported |
| `…/schema` | zod schemas + shared types (incl. `BillingUnit`, `CostMultipliers`) |
| `…/llm` · `…/image` · `…/video` · `…/audio` · `…/voice` | per-modality catalogs |
| `…/cost` · `…/pricing` | cost dispatcher + pricing helpers |
| `…/curation` · `…/picker` | surfacing + selection helpers |
| `…/route-identity` | `parseModelRef`, `resolveLlmModelRoute`, `listRouterLlmRoutes` — vendor/product[@route] grammar and router enumeration |
| `…/byok` · `…/access` | policy hooks (debit decision, access evaluation) |

```ts
import { LLM_PRICING_CATALOG } from "@agentproto/model-catalog/llm"

const p = LLM_PRICING_CATALOG["claude-opus-4-8"]
//    → { inputPer1M, outputPer1M, provider, … }
```

## License

MIT
