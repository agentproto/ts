---
"@agentproto/app-config": minor
---

v0.3: consumer-portable schema surface, shipped declarations, richer verify.

- **Zod-version-portable generics.** `defineAppConfig` / `AppKitDefinition` /
  `AppKit` no longer constrain on `z.ZodObject<z.ZodRawShape>` (which leaked
  zod internals like `$ZodType`/`exactPartial` and rejected consumers whose
  zod minor differed from the kit's). They now constrain on the kit-owned
  structural `SchemaLike<Out>` (`{ parse(value: unknown): Out }`), and
  `AppKit<AOut, IOut>` is parameterized by the schemas' **output** types.
  A consumer pinning zod 4.4.3 compiles against a kit tree on 4.5.4 with no
  cast and no pin bump (proved by the `test-fixtures/consumer` fixture).
- **Declarations ship.** `pnpm build` emits `dist/*.d.ts`, so importing the
  kit gives types without running a second build step.
- **Richer scopes and gates.** `ScopeFn` may be async and receives a
  `ScopeContext` with `readArtifact` (same rootDir-escape guard as gate
  rules), so one umbrella scope can read artifacts while emitting
  error/warn/skipped findings at per-finding levels; sync single-argument
  scopes keep working. Gate findings may carry their own `level`, overriding
  the rule's per finding.
- **`project()` output survives.** The projected object is exposed verbatim
  on `ResolvedItem.projected` (pre-parse), so derived fields the item schema
  does not declare are no longer stripped by `item.parse`.
