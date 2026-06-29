---
"@agentproto/model-catalog": minor
"@agentproto/catalog-sync": patch
"@agentproto/cli": minor
---

Live-on-setup catalog overlay. Provider voice mappers (raw → CatalogVoice)
move into `@agentproto/model-catalog/providers` as the single seam shared by
build-time emit and runtime live-fetch (new `./providers` + `./schema/voice`
exports; catalog-sync generators now fetch→map→serialize with byte-identical
output). `agentproto auth provider set <elevenlabs|minimax> <key>` eagerly
fetches the account's live voices and caches them under
`~/.agentproto/catalog/<id>.json` (0600, sha-skip on unchanged refetch); at
`serve` boot the overlay loader folds them over the committed baseline via
`registerCatalogOverlay`. Availability is account-fresh; pricing stays pinned
in the package — billing only ever changes via the reviewed catalog-sync PR.
