---
name: Agentproto security audit fixer
id: agentproto-security-fix
description: >
  Reads the weekly pnpm audit artifacts, applies dependency-only remediations
  for high and critical advisories, verifies the workspace, and opens or
  updates one deduplicated security-bump pull request.
version: 0.1.0
entry: ./entry.mjs
inputs:
  repo:
    type: string
    description: GitHub owner/repo slug used by gh.
    default: ""
  baseRef:
    type: string
    description: Base branch for the security-fix pull request.
    default: main
  auditReportPath:
    type: string
    description: Runner-local parsed audit report from the security-audit job.
    default: /tmp/audit-report.md
  auditProdPath:
    type: string
    description: Runner-local raw production pnpm audit JSON.
    default: /tmp/audit-prod.json
  auditFullPath:
    type: string
    description: Runner-local raw full pnpm audit JSON.
    default: /tmp/audit-full.json
  reviewConfig:
    type: object
    description: Parsed .github/agentic-review.json used for the shared adapter convention.
    default: {}
outputs: {}
steps:
  - id: fix-and-pr
    kind: agent
    adapter: claude-code
---

# Agentproto security audit fixer

This workflow is the agentproto-native remediation lane for the weekly
`update-deps.yml` security audit. Its entry module supplies one agent step
that reads the parsed Markdown report and both raw pnpm audit JSON files,
works out dependency-only remediations, updates manifests and the lockfile,
runs the same build/type-check sanity gate as the deterministic dependency
updater, and opens or updates one fixed-title PR.

The runner restores the audit artifacts to `/tmp` before invoking this flow.
The step intentionally runs on the host runner, even when
`reviewerSandbox` is configured: the audit files, checked-out repository,
`pnpm`, and authenticated `gh` CLI must remain in the same filesystem. The
adapter and auth settings still come from `.github/agentic-review.json`.

Only dependency-version changes are in scope. Advisories whose only safe fix
requires a breaking major upgrade plus source changes are reported in the PR
body under **Needs manual triage**; the agent must not guess those code
changes. The fixed branch/title make reruns update the existing open PR.
