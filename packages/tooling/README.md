# @agentproto/tooling

Shared development tooling for agentproto-org packages: TypeScript configs
and a tsup config factory. Pure config — no runtime code, dev-time only.

## TypeScript configs

```json
{
  "extends": "@agentproto/tooling/typescript/bundler.json"
}
```

- `typescript/base.json` — shared compiler options for `tsc --noEmit`
  type-checking.
- `typescript/bundler.json` — for packages built with a bundler (tsup);
  extends `base.json`.
- `typescript/node-library.json` — for packages that emit their own
  declarations via `tsc` instead of a bundler.

## tsup config

```ts
import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  entry: { index: "src/index.ts" },
})
```

`createTsupConfig` returns a `tsup.defineConfig` result with the workspace's
shared defaults (ESM output, `.mjs`/`.d.ts` emission, `es2022` target,
sourcemaps) — pass any `tsup.Options` to override or extend them.

## Peer dependencies

Consumers bring their own `tsup` (`^8.5.0`) and `typescript` (`^5.0.0`).
