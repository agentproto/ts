---
"@agentproto/model-catalog": minor
"@agentproto/adapter-claude-sdk": patch
"@agentproto/runtime": patch
---

Router-aware LLM model enumeration for Requesty and HuggingFace.

Introduces `listRouterLlmRoutes` to systematically enumerate all models a router serves, and enhances `getModelsByProvider` to fold these router tables into provider queries while deduplicating against OpenRouter's existing bare-id surface. Requesty and HuggingFace models now enumerate from their generated route tables as `vendor/product@router` ids. Claude SDK adapter adds Requesty model curation to its allowed list.
