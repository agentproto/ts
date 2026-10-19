# STATUS.md — package tiers

A generated, read-only snapshot of every agentproto/ts workspace package (*156 packages), classified into four tiers.

## Classification rule

Every workspace package (the `package.json` files under the globs in
`pnpm-workspace.yaml`) lands in exactly one tier, decided in this order:

1. **archived** — explicitly dead packages (`scripts/gen-status.mjs`
   `ARCHIVED_OVERRIDES`). An override is only applied if the package really
   is dead, i.e. no other workspace package depends on its name; if it turns
   out not to be dead it keeps its natural tier instead.
2. **adapters** — package path under `adapters/**`: bindings for external
   agent/CLI/browser/knowledge backends.
3. **spec-reference** — `packages/*` spec-only/doctype packages: AIP
   reference implementations, open file-format standards, and meta-doctype
   helpers (AIP-54 REF, manifest verbs, etc.), detected from the package
   name/description.
4. **core** — the runtime/cli/driver/sandbox/auth/model-catalog family pinned
   by rule, plus every other `packages/*` package that is none of the above
   (default tier: runtime infra, binaries, UI shells, providers, tooling).

Rows are grouped by tier, sorted by path. One row per package — no package
appears twice. Regenerate with `node scripts/gen-status.mjs`; validate with
`node scripts/gen-status.mjs --check`.

## Tier counts

| tier | count |
| --- | --- |
| `core` | 77 |
| `adapters` | 25 |
| `spec-reference` | 44 |
| `archived` | 10 |

## Packages

| package | path | version | tier | reason |
| --- | --- | --- | --- | --- |
| @agentproto/a2a | packages/a2a | 0.2.2 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/agencies-engine | packages/agencies/engine | 0.1.13 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/agencies-mastra | packages/agencies/mastra | 0.1.6 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/agent-runtime | packages/agent-runtime | 0.1.6 | core | default: packages/* runtime/infra example or tooling package |
| agentproto | packages/agentproto-placeholder | 0.0.1 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/app-client | packages/app-client | 0.4.2 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/app-config | packages/app-config | 0.3.2 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/app-kit | packages/app-kit | 2.1.0 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/apps | packages/apps | 0.23.6 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/auth | packages/auth | 1.3.1 | core | core family (runtime/cli/driver/sandbox/auth/model-catalog) |
| @agentproto/batch | packages/batch | 0.2.3 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/browser-process | packages/browser-process | 0.2.1 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/browser-profiles | packages/browser-profiles | 0.2.4 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/catalog-sync | packages/catalog-sync | 0.8.8 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/cli | packages/cli | 1.27.0 | core | core family (runtime/cli/driver/sandbox/auth/model-catalog) |
| @agentproto/cli-exec | packages/cli-exec | 0.1.2 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/code-brain | packages/code-brain | 0.3.9 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/command-sandbox | packages/command-sandbox | 0.3.1 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/computer-api | packages/computer-api | 0.2.0 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/connector | packages/connector | 0.1.22 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/corpus | packages/corpus | 0.8.3 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/corpus-cli | packages/corpus-cli | 0.11.1 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/corpus-presets | packages/corpus-presets | 0.2.15 | core | default: packages/* runtime/infra example or tooling package |
| create-agentproto-app | packages/create-agentproto-app | 0.3.6 | core | default: packages/* runtime/infra example or tooling package |
| agentproto-desktop | packages/desktop | 0.3.5 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/driver-browser | packages/driver/browser | 0.3.1 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/driver-cli | packages/driver/cli | 0.2.5 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/driver | packages/driver/core | 0.3.3 | core | core family (runtime/cli/driver/sandbox/auth/model-catalog) |
| @agentproto/driver-http | packages/driver/http | 0.1.13 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/driver-mcp | packages/driver/mcp | 0.1.13 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/eval | packages/eval | 0.3.12 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/eval-reporters | packages/eval-reporters | 0.2.26 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/events-channel | packages/events-channel | 0.1.1 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/harness | packages/harness | 0.6.0 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/knowledge-cascade | packages/knowledge-cascade | 0.2.6 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/knowledge-engine | packages/knowledge-engine | 0.3.3 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/llm-endpoint | packages/llm-endpoint | 0.11.13 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/mcp-app-host | packages/mcp-app-host | 0.1.4 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/model-catalog | packages/model-catalog | 0.13.0 | core | core family (runtime/cli/driver/sandbox/auth/model-catalog) |
| @agentproto/model-intel | packages/model-intel | 0.1.0 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/pair-client | packages/pair-client | 1.0.4 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/pair-page | packages/pair-page | 0.0.13 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/pairing-host | packages/pairing-host | 0.2.9 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/plugin-local-browser | packages/plugin-local-browser | 0.3.6 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/pr-outcome | packages/pr-outcome | 0.1.0 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/provider-kit | packages/provider-kit | 0.4.7 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/provider-presets | packages/provider-presets | 0.7.1 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/providers-store | packages/providers-store | 0.3.31 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/redaction | packages/redaction | 0.2.4 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/relay | packages/relay | 0.1.6 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/rendezvous | packages/rendezvous | 0.2.4 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/review | packages/review | 0.6.2 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/review-pack-core | packages/review-pack-core | 0.1.0 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/runtime | packages/runtime | 5.26.0 | core | core family (runtime/cli/driver/sandbox/auth/model-catalog) |
| @agentproto/runtime-profile-standard | packages/runtime-profile-standard | 0.1.4 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/sandbox | packages/sandbox | 0.12.0 | core | core family (runtime/cli/driver/sandbox/auth/model-catalog) |
| @agentproto/sandbox-box | packages/sandbox-box | 0.2.33 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/sandbox-computer | packages/sandbox-computer | 0.2.0 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/sandbox-e2b | packages/sandbox-e2b | 0.8.3 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/sandbox-instabox | packages/sandbox-instabox | 0.2.0 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/skill-pack-agentproto | packages/skill-pack-agentproto | 0.8.9 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/skill-pack-agentpush | packages/skill-pack-agentpush | 0.2.2 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/skill-pack-bureau | packages/skill-pack-bureau | 0.3.2 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/storage-github | packages/storage-github | 0.2.1 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/telemetry | packages/telemetry | 0.2.4 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/telemetry-langfuse | packages/telemetry-langfuse | 0.2.24 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/tool-cli | packages/tool-cli | 0.2.10 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/tooling | packages/tooling | 0.1.0 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/transcript-fixtures | packages/transcript-fixtures | 0.3.1 | core | default: packages/* runtime/infra example or tooling package |
| agentproto-vscode | packages/vscode | 0.24.0 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/wallet | packages/wallet | 0.2.0 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/workflow-loader | packages/workflow-loader | 0.2.9 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/workflow-mastra | packages/workflow-mastra | 0.2.10 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/workflow-runtime | packages/workflow-runtime | 0.19.1 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/workspace-brain | packages/workspace-brain | 0.5.3 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/worktree | packages/worktree | 0.16.0 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/worktree-agent-example | packages/worktree-agent-example | 0.0.34 | core | default: packages/* runtime/infra example or tooling package |
| @agentproto/adapter-antigravity | adapters/antigravity | 0.3.7 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-browser | adapters/browser | 0.8.0 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-browser-camofox | adapters/browser-camofox | 0.2.4 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-browser-chrome | adapters/browser-chrome | 0.7.0 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-browser-chromium | adapters/browser-chromium | 0.2.4 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-claude-code | adapters/claude-code | 2.5.12 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-claude-code-cloud | adapters/claude-code-cloud | 0.2.3 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-claude-sdk | adapters/claude-sdk | 0.7.27 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-code-brain-gbrain | adapters/code-brain-gbrain | 0.2.12 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-codex | adapters/codex | 2.0.28 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-copilot-cli | adapters/copilot-cli | 0.3.7 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-gemini | adapters/gemini | 0.2.29 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-grok-cli | adapters/grok-cli | 0.2.23 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-hermes | adapters/hermes | 0.5.3 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-jcode | adapters/jcode | 0.4.0 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-knowledge-corpus | adapters/knowledge-corpus | 0.4.3 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-knowledge-files | adapters/knowledge-files | 0.3.3 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-knowledge-gbrain-doc | adapters/knowledge-gbrain-doc | 0.3.3 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-knowledge-qdrant | adapters/knowledge-qdrant | 0.3.3 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-mastra-agent | adapters/mastra-agent | 0.7.40 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-mastracode | adapters/mastracode | 0.4.0 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-mastracode-inprocess | adapters/mastracode-inprocess | 0.5.0 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-openclaw | adapters/openclaw | 0.1.35 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-opencode | adapters/opencode | 1.9.0 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/adapter-pi | adapters/pi | 0.5.0 | adapters | adapters/** binding for an external agent/CLI/browser/knowledge backend |
| @agentproto/acp | packages/acp | 0.11.2 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/action | packages/action | 0.1.7 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/agencies | packages/agencies/core | 0.1.6 | spec-reference | spec-only/doctype package (matches "file-format") |
| @agentproto/agency-v2 | packages/agency-v2 | 0.1.5 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/agent | packages/agent | 0.4.1 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/assembly | packages/assembly | 0.1.5 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/canvakit | packages/canvakit | 0.1.5 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/code | packages/code | 0.1.5 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/collection | packages/collection | 0.1.5 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/company | packages/company | 0.1.5 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/define-doctype | packages/define-doctype | 0.1.4 | spec-reference | spec-only/doctype package (matches "doctype") |
| @agentproto/design | packages/design | 0.1.5 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/driver-agent-cli | packages/driver/agent-cli | 2.13.2 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/extension | packages/extension | 0.2.4 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/governance | packages/governance/core | 0.1.6 | spec-reference | spec-only/doctype package (matches "doctype") |
| @agentproto/governance-engine | packages/governance/engine | 0.1.13 | spec-reference | spec-only/doctype package (matches "doctype") |
| @agentproto/intent | packages/intent | 0.1.5 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/io | packages/io | 0.1.5 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/knowledge | packages/knowledge | 0.1.5 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/lesson | packages/lesson | 0.1.5 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/manifest | packages/manifest | 0.2.4 | spec-reference | spec-only/doctype package (matches "doctype") |
| @agentproto/mastra | packages/mastra | 0.2.19 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/mcp-server | packages/mcp-server | 0.7.0 | spec-reference | spec-only/doctype package (matches "doctype") |
| @agentproto/model-routing | packages/model-routing | 0.3.1 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/office | packages/office | 0.1.5 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/operator | packages/operator | 0.1.5 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/pack | packages/pack | 0.2.6 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/persona | packages/persona | 0.1.5 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/playbook | packages/playbook | 0.1.5 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/plugin | packages/plugin | 0.2.3 | spec-reference | spec-only/doctype package (matches "cross-vendor plugin format") |
| @agentproto/policy | packages/policy | 0.1.5 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/product | packages/product | 1.0.4 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/ref | packages/ref | 0.2.3 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/registry | packages/registry | 0.1.2 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/role | packages/role | 0.1.5 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/routine | packages/routine | 0.3.2 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/runner | packages/runner | 0.1.5 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/secrets | packages/secrets | 2.1.1 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/skill | packages/skill | 0.2.5 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/storage | packages/storage | 0.3.1 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/tool | packages/tool | 0.5.2 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/work | packages/work | 0.2.0 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/workflow | packages/workflow | 0.7.2 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/workspace | packages/workspace | 1.0.1 | spec-reference | spec-only/doctype package (matches "reference implementation") |
| @agentproto/adapter-ai-sdk | adapters/ai-sdk | 0.1.14 | archived | dormant Vercel AI SDK tool adapter; 0 workspace dependents |
| @agentproto/adapter-mastra | adapters/mastra | 0.1.16 | archived | dormant generic Mastra tool adapter; 0 workspace dependents |
| @agentproto/adapter-kit | packages/adapter-kit | 0.3.10 | archived | DEPRECATED stub re-exporting @agentproto/provider-kit; 0 workspace dependents |
| @agentproto/catalog | packages/catalog | 0.1.2 | archived | dormant agentcatalog/v1 catalog prototype; 0 workspace dependents |
| @agentproto/driver-sdk | packages/driver/sdk | 0.1.13 | archived | deprecated AIP-33 SDK provider specialisation; 0 workspace dependents |
| @agentproto/egress | packages/egress | 0.1.18 | archived | dormant egress-control prototype; 0 workspace dependents |
| @agentproto/identity | packages/identity | 0.1.5 | archived | dormant AIP-23 identity doctype, superseded by persona/role; 0 workspace dependents |
| @agentproto/lifecycle | packages/lifecycle | 0.1.2 | archived | dormant AIP-37 lifecycle vocabulary prototype; 0 workspace dependents |
| @agentproto/role-catalog | packages/role-catalog | 0.1.5 | archived | dormant AIP-47 builtin role catalogue; 0 workspace dependents |
| @agentproto/workflow-ai-sdk | packages/workflow-ai-sdk | 0.1.20 | archived | dormant Vercel AI SDK projection of AIP-15 workflows; 0 workspace dependents |
