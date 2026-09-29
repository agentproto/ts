/**
 * The reference blocks of AIP-62's EXAMPLES.md, verbatim (patterns 1-5). The
 * conformance test parses every one of them through the shipped code.
 */

export const EXAMPLE_PUSH_GATE = `---
kind: review
id: agentik-studio
name: agentik-studio push gate
description: >-
  What \`git push\` (scripts/gate.mjs) asks the local agentproto daemon to attest:
  advisory turbo/structure lanes plus one blocking agentic review.
target: { kind: git-range, base: origin/main }
checks:
  # Advisory — the monorepo carries pre-existing type/test red, so these are
  # recorded on the attestation but never move the verdict. {changed} is the
  # turbo git-range filter: packages whose own files changed in the range.
  - id: types
    kind: command
    run:
      "pnpm turbo run check-types --output-logs=errors-only --filter={changed}"
    blocking: false
  - id: test
    kind: command
    run: "pnpm turbo run test --output-logs=errors-only --filter={changed}"
    blocking: false
  # Whole-tree ratchet against scripts/structure-baseline.json: fails only on
  # findings the baseline doesn't list.
  - id: structure
    kind: command
    run: "node scripts/structure-doctor.mjs --check-baseline"
    blocking: false
    timeoutMs: 120000
  # The gate's own tests. Hermetic (node builtins + a fake daemon on a loopback
  # port, no install), so unlike the turbo lanes it runs green in any worktree
  # and can block: a broken gate.mjs must not ship.
  - id: gate
    kind: command
    run: "node --test scripts/gate.test.mjs"
    timeoutMs: 60000
  # The always-on gate: blocks only on a high-severity finding.
  - id: correctness
    kind: agent
    preset: cc-subs-agentik
    rubric: ./scripts/review/rubrics/correctness.md
    blockOn: high
    timeoutMs: 900000
bindings:
  local: { on: pre-push, checks: [types, test, structure, gate, correctness] }
---

# agentik-studio review manifest

\`scripts/gate.mjs\` (the pre-push hook, \`pnpm gate\`, \`pnpm gate:push\`) is a thin
client: it resolves the pushed range and calls the daemon's \`review_run\` with
\`binding: local\`. The daemon runs the lanes above, folds the verdict
(\`pass | block | incomplete\`) and records it in its ledger
(\`~/.agentproto/reviews/\`), which is also the verdict cache — a range that
already has a clean verdict under this exact manifest and rubric is served back
as \`cached\`.

There is no \`prepare\` phase: the gate never mutates the tree before review.

Advisory lanes (\`types\`, \`test\`, \`structure\`) run in a git worktree too, but
turbo aborts workspace discovery there when \`projects/agentproto/*\` is a symlink
out of the repo root; that shows up as a failed advisory lane, never as a block.
`

export const EXAMPLE_TWO_BINDINGS = `---
kind: review
id: agentproto-ts
name: agentproto/ts review
target: git-range
checks:
  - id: types
    kind: command
    run: pnpm check-types
  - id: changeset
    kind: command
    run: pnpm changeset:auto
    effects: true
  - id: build
    kind: command
    run: pnpm build
    timeoutMs: 1200000
  - id: correctness
    kind: agent
    preset: kimi
    rubric: ./rubrics/correctness.md
    blockOn: high
bindings:
  local:
    on: pre-push
    prepare: [changeset]
    checks: [types, correctness]
  ci:
    on: pr
    checks: [build, correctness]
verdict:
  exportDir: .reviews
---

# agentproto/ts review manifest

The \`local\` binding runs on the developer's machine before push. The \`ci\`
binding runs in CI, where \`pnpm review verify --if-exported\` gates the merge on
the committed export.
`

export const EXAMPLE_PACK = `---
kind: review-pack
id: core
version: 1.0.0
description: Correctness and security rubrics shared across repositories.
checks:
  - id: correctness
    kind: agent
    rubric: ./rubrics/correctness.md
    blockOn: high
  - id: security
    kind: agent
    rubric: ./rubrics/security.md
    blockOn: high
    timeoutMs: 900000
---

# core review pack

Import with \`uses: [{ pack: "@agentproto/review-pack-core", as: core }]\`.
`

export const EXAMPLE_CONSUMER = `---
kind: review
id: web-app
target: { kind: git-range, base: origin/main }
checks:
  - id: types
    kind: command
    run: pnpm check-types
uses:
  - pack: "@agentproto/review-pack-core"
    as: core
    checks: [correctness, security]
    preset: cc-subs-agentik
    overrides:
      security:
        blockOn: medium
        timeoutMs: 600000
  - pack: "git+https://github.com/example/review-pack-a11y#0123456789abcdef0123456789abcdef01234567"
    as: a11y
    preset: cc-subs-agentik
    allowCommands: false
bindings:
  local:
    on: pre-push
    checks: [types, core/correctness, core/security]
  ci:
    on: pr
    checks: [types, core/correctness, core/security, a11y/contrast]
---

# web-app review manifest
`

export const EXAMPLE_ATTESTATION = `{
  "schema": "agentproto.review.attestation/v1",
  "runId": "review-6f0b9a52-3f43-4c1c-a4d5-0f3f6c1f5a10",
  "reviewId": "web-app",
  "manifestSha": "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
  "binding": "local",
  "target": {
    "repoRemote": "github.com/example/web-app",
    "baseSha": "1111111111111111111111111111111111111111",
    "headSha": "2222222222222222222222222222222222222222"
  },
  "rangeSha": "709ea9c102cd11ed178afc5f0d3bef72b86e55ec7de29a6fb125fb100ef166a8",
  "lanes": [
    {
      "id": "types",
      "kind": "command",
      "status": "pass",
      "blocking": true,
      "findings": [],
      "durationMs": 41250,
      "exitCode": 0
    },
    {
      "id": "core/correctness",
      "kind": "agent",
      "status": "pass",
      "blocking": true,
      "findings": [
        {
          "severity": "low",
          "title": "Unused import",
          "detail": "The helper is imported but never called.",
          "file": "src/util.ts",
          "line": 3
        }
      ],
      "durationMs": 212480,
      "sessionId": "sess_7d2c19",
      "preset": "cc-subs-agentik",
      "summary": "One low-severity nit in the delta; nothing blocking.",
      "model": "claude-sonnet-5",
      "composedFrom": {
        "rangeSha": "b52e1f9a6a0c4f1d8b2c7d5e3a9f0c1b6d4e8a7f2c3b5d9e0a1f4c6b8d2e7a3f",
        "headSha": "1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a",
        "attestationSha256": "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00"
      }
    },
    {
      "id": "core/security",
      "kind": "agent",
      "status": "pass",
      "blocking": true,
      "findings": [],
      "durationMs": 305100,
      "sessionId": "sess_7d2c1a",
      "preset": "cc-subs-agentik",
      "summary": "No security findings.",
      "model": "claude-sonnet-5"
    }
  ],
  "verdict": "pass",
  "attestor": {
    "daemon": "agentproto-daemon@builder-1",
    "presets": ["cc-subs-agentik"],
    "signature": {
      "alg": "ssh-ed25519",
      "keyFingerprint": "SHA256:Zk3a0v3s1kqQ2x9m0nX8bT0mYf2t0p5g1k7sJc4d8eA",
      "principal": "dev@example.com",
      "signedAt": "2026-09-29T10:15:31.000Z",
      "sig": "-----BEGIN SSH SIGNATURE-----\\nU1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAg...\\n-----END SSH SIGNATURE-----\\n"
    }
  },
  "rubrics": [
    {
      "check": "core/correctness",
      "path": "./rubrics/correctness.md",
      "sha256": "3c1d98d1ff2816d52bf2e03c3e46c3220107999b2a26f0811b5cde42d9bfe042"
    },
    {
      "check": "core/security",
      "path": "./rubrics/security.md",
      "sha256": "5f8f0a3d2b1c4e6a7d9b0c1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a"
    }
  ],
  "packs": [
    {
      "ref": "@agentproto/review-pack-core",
      "id": "core",
      "version": "1.0.0",
      "alg": "agentproto-pack-digest/v1",
      "sha256": "fe060a88f5bb7f3fdc86d883b1681665cd633d5a8cc5bcdb6d0b32112ed173a7"
    },
    {
      "ref": "git+https://github.com/example/review-pack-a11y#0123456789abcdef0123456789abcdef01234567",
      "id": "a11y",
      "version": "0.3.0",
      "alg": "agentproto-pack-digest/v1",
      "sha256": "9a8b7c6d5e4f30211203f4e5d6c7b8a99a8b7c6d5e4f30211203f4e5d6c7b8a9"
    }
  ],
  "requester": {
    "sessionId": "sess_4b19aa",
    "gitAuthor": { "name": "Dev Example", "email": "dev@example.com" }
  },
  "pr": {
    "provider": "github",
    "repo": "example/web-app",
    "number": 42,
    "url": "https://github.com/example/web-app/pull/42"
  },
  "createdAt": "2026-09-29T10:15:30.000Z"
}
`

