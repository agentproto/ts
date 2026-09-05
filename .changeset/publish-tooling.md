---
"@agentproto/tooling": patch
---

Publish to npm. Previously ignored by changesets and marked `private`, so
consumers outside this monorepo's pnpm workspace (e.g. `@agstudio/footprint`
in agentik-studio) could depend on it only via `workspace:*`, which doesn't
resolve across separate git repos. It is a pure config package (TypeScript
`tsconfig` bases + a tsup config factory, no runtime code), so publishing it
carries no runtime surface to maintain.
