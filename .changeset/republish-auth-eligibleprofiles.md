---
"@agentproto/auth": minor
---

Republish `@agentproto/auth` so npm carries the `eligibleProfiles` export
(added in #470) that `@agentproto/cli` already consumes.

`auth@0.1.1` was published on npm before `eligibleProfiles` existed; #470 added
the export to the source but no changeset bumped `@agentproto/auth`, so it was
never republished — while `cli@0.9.0` shipped importing it. Every
`npm i -g @agentproto/cli@latest` (as the e2b reviewer sandbox does on boot)
then crashed with `SyntaxError: … does not provide an export named
'eligibleProfiles'`, silently downgrading the PR reviewer to the legacy api-key
fallback. This bump republishes auth (and cascades a cli republish via
`updateInternalDependencies`) so the pair is consistent again.
