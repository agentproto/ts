# @agentproto/collect

Building blocks for collecting public posts, articles and metrics with
provenance. This first release is the data layer only. It is pure: no
filesystem, no network, one runtime dependency (`zod`).

## What is in it

- **Schemas** (zod, with inferred types): `CollectItem`, `Observation`,
  `Actor` (with audience readings), `Pickup`, `Recipe`, `RunReport`,
  `Coverage`.
- **Ids**: `itemId(source, nativeId)` gives `source:nativeId`;
  `itemIdFromUrl(source, url)` hashes the canonical URL when a platform gives
  no id.
- **`canonicalUrl(url)`**: lowercase host, no fragment, no credentials, no
  default port, tracking parameters removed (`utm_*`, `fbclid`, `gclid`,
  `mc_cid`, `mc_eid`, `ref_src`, `igshid`, `si`, ...), remaining
  parameters sorted, no trailing slash.
- **`textFingerprint(text)`**: SHA-256 of the text after case, whitespace and
  punctuation normalisation. Hashing goes through Web Crypto
  (`crypto.subtle`), so it is async and needs no Node built-in.
- **`STORE_SCHEMA_VERSION`**: version of the stored shapes.

## Rules baked into the schemas

- A counter that is not available is absent from `metrics` and listed in
  `missing` with a reason. It is never zero.
- An item may have no subject and no author audience.
- An unknown audience is a reading with an `unknown` reason, never a zero.
  Karma stays typed `karma`.

```ts
import { CollectItem, canonicalUrl, itemIdFromUrl, textFingerprint } from "@agentproto/collect"

const url = canonicalUrl("https://Example.com/a/?utm_source=x#top") // https://example.com/a
const id = await itemIdFromUrl("web", url)
const contentId = await textFingerprint("Some article text")
CollectItem.parse({ id, source: "web", kind: "article", contentId, firstSeenAt: new Date().toISOString() })
```

## License

Apache-2.0
