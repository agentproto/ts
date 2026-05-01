# @agentproto/ref

Reference implementation of
[**AIP-27 — REF.md (agentref/v1)**](https://agentik.net/docs/aip-27).

A composable reference primitive: typed, registry-extensible discriminated union
over kinds, with a canonical compact string form.

```ts
import { defineRef } from "@agentproto/ref"

const r = defineRef("github:agentik/studio@main:packages/ref")
r.kind // "github"
r.value // { kind: "github", owner: "agentik", repo: "studio", ref: "main", path: "packages/ref" }
r.compact // "github:agentik/studio@main:packages/ref"
r.resolvable // true
```

## Base kinds (v1)

| Kind       | Compact form                             | Resolvable          |
| ---------- | ---------------------------------------- | ------------------- |
| `local`    | `local:<path>` (`#sha256=…` optional)    | yes                 |
| `url`      | `url:<href>` (`#sha256=…` optional)      | yes                 |
| `git`      | `git:<pct-encoded-url>@<ref>[:<path>]`   | yes                 |
| `github`   | `github:<owner>/<repo>[@<ref>][:<path>]` | yes                 |
| `ipfs`     | `ipfs:<cid>[:<path>]`                    | yes                 |
| `email`    | `email:<address>`                        | no                  |
| `operator` | `operator:<slug>[@<workspace>]`          | yes (via registry)  |
| `user`     | `user:<id>[@<workspace>]`                | yes (via registry)  |
| `persona`  | `persona:<id>`                           | yes (via registry)  |
| `eth_tx`   | `eth_tx:<chainId>:<txHash>`              | no                  |
| `ots`      | `ots:<inner-compact-ref>`                | yes (proxies inner) |

## Extension

```ts
declare module "@agentproto/ref" {
  interface RefKindRegistry {
    youtube_video: { kind: "youtube_video"; videoId: string; t?: number }
  }
}

import { registerRefKind } from "@agentproto/ref"
import { z } from "zod"

registerRefKind({
  kind: "youtube_video",
  schema: z.object({
    kind: z.literal("youtube_video"),
    videoId: z.string(),
    t: z.number().int().nonnegative().optional(),
  }),
  parse: body => {
    const [videoId, query] = body.split("?")
    const t = query?.startsWith("t=") ? Number(query.slice(2)) : undefined
    return { kind: "youtube_video", videoId, ...(t ? { t } : {}) }
  },
  serialize: v => `${v.videoId}${v.t ? `?t=${v.t}` : ""}`,
})
```

## Spec

See [AIP-27](https://agentik.net/docs/aip-27) for the canonical specification.
