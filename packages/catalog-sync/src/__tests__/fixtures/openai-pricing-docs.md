# Pricing

> Trimmed excerpt of https://platform.openai.com/docs/pricing.md, captured
> 2026-09-25. Rows and prose are verbatim; whole sections are dropped for
> size. Every structural trap the live page contains is kept, because those
> are the point of the fixture:
>
>   - the Standard / Batch / Flex / Fast tier split, where the same ids repeat
>     at different rates under generically-titled headings
>   - a "Grouped Pricing Table data" heading whose tier comes from a bare
>     label line above it, not from the heading
>   - parenthetical qualifiers in the Model cell (`(<272K context length)`,
>     `(legacy)`, `(data sharing)`)
>   - the FINE-TUNING tables, which reuse base-model ids at fine-tuned rates
>     and are told apart only by their `Training` column
>   - the realtime table, told apart only by its `Modality` column
>   - non-dollar cells: `-`, `Free`, `$100.00 / hour`, `$10.00 / 1k calls`

FedRAMP endpoints are charged a 10% uplift over the corresponding standard model
rates.

Flagship models

Prices per 1M tokens.

Standard

### Standard pricing data

| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-6-astra | $10.00 | $1.00 | $12.50 | $50.00 | $20.00 | $2.00 | $25.00 | $75.00 |
| gpt-6-sol | $2.00 | $0.20 | $2.50 | $10.00 | $4.00 | $0.40 | $5.00 | $15.00 |
| gpt-5.6-sol | $4.00 | $0.40 | $5.00 | $20.00 | $8.00 | $0.80 | $10.00 | $30.00 |
| gpt-5.5 (<272K context length) | $5.00 | $0.50 | - | $30.00 | $10.00 | $1.00 | - | $45.00 |
| gpt-5 | $1.25 | $0.125 | - | $10.00 | - | - | - | - |
| gpt-5-mini | $0.25 | $0.025 | - | $2.00 | - | - | - | - |
| gpt-4.1 | $2.00 | $0.50 | - | $8.00 | - | - | - | - |
| gpt-4o | $2.50 | $1.25 | - | $10.00 | - | - | - | - |
| o3 | $2.00 | $0.50 | - | $8.00 | - | - | - | - |
| gpt-3.5-turbo | $0.50 | - | - | $1.50 | - | - | - | - |
| davinci-002 | $2.00 | - | - | $2.00 | - | - | - | - |
| babbage-002 | $0.40 | - | - | $0.40 | - | - | - | - |

GPT-5.6 Sol's promotional pricing is available at least through November 21, 2026.

Batch

### Batch pricing data

| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-6-sol | $1.00 | $0.10 | $1.25 | $5.00 | $2.00 | $0.20 | $2.50 | $7.50 |
| gpt-5 | $0.625 | $0.0625 | - | $5.00 | - | - | - | - |
| gpt-5-mini | $0.125 | $0.0125 | - | $1.00 | - | - | - | - |
| gpt-4.1 | $1.00 | $0.25 | - | $4.00 | - | - | - | - |

Flex

### Flex pricing data

| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-5 | $0.625 | $0.0625 | - | $5.00 | - | - | - | - |

Fast

### Fast pricing data

| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-5 | $2.50 | $0.25 | - | $20.00 | - | - | - | - |
| gpt-4o | $4.25 | $2.125 | - | $17.00 | - | - | - | - |

Built-in tools

### Pricing Table data

| Tool | Detail | Cost |
| --- | --- | --- |
| Web search | Web search (all models) | $10.00 / 1k calls + Search content tokens billed at model rates. |

GPT-Live sessions

### Pricing Table data

| Model | Price per minute |
| --- | --- |
| gpt-live-1 | $0.05 |

Realtime and audio generation models

Prices per 1M tokens unless noted.

### Grouped Pricing Table data

| Model | Modality | Input | Cached input | Output / cost |
| --- | --- | --- | --- | --- |
| gpt-realtime-2.1 | Audio | $32.00 | $0.40 | $64.00 |
| gpt-realtime-2.1 | Text | $4.00 | $0.40 | $24.00 |

Specialized models

Prices per 1M tokens.

Standard

### Grouped Pricing Table data

| Category | Model | Input | Cached input | Output |
| --- | --- | --- | --- | --- |
| ChatGPT | chat-latest | $5.00 | $0.50 | $30.00 |
| Codex | gpt-5.3-codex | $1.75 | $0.175 | $14.00 |
| Search | gpt-5-search-api | $1.25 | $0.125 | $10.00 |
| Embedding | text-embedding-3-small | $0.02 | - | - |
| Moderation | omni-moderation-latest | Free | - | - |

Fast mode

### Grouped Pricing Table data

| Category | Model | Input | Cached input | Output |
| --- | --- | --- | --- | --- |
| Codex | gpt-5.3-codex | $3.50 | $0.35 | $28.00 |

Fine-tuning

Standard

### Pricing Table data

| Model | Training | Input | Cached input | Output |
| --- | --- | --- | --- | --- |
| o4-mini-2025-04-16 | $100.00 / hour | $4.00 | $1.00 | $16.00 |
| o4-mini-2025-04-16 (data sharing) | $100.00 / hour | $2.00 | $0.50 | $8.00 |
| gpt-4.1 | $25.00 | $3.00 | $0.75 | $12.00 |
| gpt-4o | $25.00 | $3.75 | $1.875 | $15.00 |
| gpt-3.5-turbo (legacy) | $8.00 | $3.00 | - | $6.00 |

Batch

### Pricing Table data

| Model | Training | Input | Cached input | Output |
| --- | --- | --- | --- | --- |
| gpt-4.1 | $25.00 | $1.50 | $0.50 | $6.00 |
| gpt-4o | $25.00 | $2.225 | $0.90 | $12.50 |
