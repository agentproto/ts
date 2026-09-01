---
name: pb-build-pack
description: Author an agent pack (company/agency/knowledge) and import it into a guild via the registry, BYO repo, or MCP surface. Trigger for pack work - 'author a company pack', 'import a pack', 'pack init', 'ship capabilities as a pack'.
---

# pb-build-pack — author and import an agent PACK

## Goal

Package capabilities as an agent pack (one folder, one root marker), validate
it, then import it through the right surface — registry, BYO repo, or MCP
tools — and confirm with a re-sync.

Prerequisites (reference by name): `ap-tasks` if you track the work on the
board; the pack machinery itself lives in this repo, not the daemon.

## Steps

### 1. Read the committed SOP first

Read `projects/guilde/docs/PACK-SOP.md` before anything else. It is the
authoritative authoring SOP — folder layout, marker semantics, what each
doctype handler consumes. This playbook sequences the work; the SOP defines
the artifacts.

### 2. Scaffold with the authoring CLI

```
pnpm --filter @guilde/api run pack init <kind> <slug>
```

`kind` is one of `company` | `agency` | `knowledge` — the ROOT MARKER file
decides the doctype: `COMPANY.md`, `AGENCY.md`, or `KNOWLEDGE.md`. Never use
bare `pnpm pack` — that is a reserved pnpm builtin, not this CLI.

### 3. Validate BEFORE importing

```
pack validate <dir>
```

Scaffolds pass `validate` out of the box; fill in your content and re-run
until it passes. Validation is the gate between authoring and import.

### 4. Import through the right surface

- House/external registry: add the source to `PACK_REGISTRY`
  (`apps/api/src/config/pack-registry.ts`) keyed by `kind` — external repos
  of any kind register like the house companies.
- BYO repo onto an EXISTING guild: `connect_pack_repo` (vaults the PAT;
  repo becomes a resolvable source for that guild).
- New guild from a repo: `apply_company_from_repo({repo, kind, ...})`.
- New guild from a registry source: `apply_company({sourceId, entryId})`.
- Existing guild, one operator or corpus: `install_operator` /
  `apply_corpus`.

Underneath, every import path is ONE ingress primitive:

```
applyPackageToScope({ scopeId, userId, pkg, includeHandlers?, installMode? })
```

`installMode`: `append` (default, multi-instance) | `skip-existing` |
`upsert-by-slug` (re-sync). `includeHandlers` filters which doctype handlers
materialize. All three call-sites (guild-create, corpus-apply,
operator-install) route through it.

### 5. Verify with a re-sync

```
resync_pack({ guildId: '<guildId>' })
```

`resyncGuildPackage` re-fetches the source, sha-diffs against the stored
`guild.sourcePackage`, and upserts only on change (no migration; reuses
jsonb). An import that cannot survive a resync was not really installed.

## Gotchas

- Validate BEFORE importing: a bad marker file means a silent doctype
  mismatch — the pack lands as the wrong kind and downstream handlers skip
  it without an error you would notice.
- Re-running install upserts by slug — it does not duplicate. But
  `includeHandlers` decides what materializes: a handler you filter out is
  simply not imported, so check the filter matches what you expect to see.
- PATs for BYO repos are vaulted, not stored in plaintext; re-resolve
  through the guild's `packSources`, never paste tokens into pack files.
- The canonical import types live in `@agstudio/agent-package-import`
  (`materializeAgentPackage`, `computePackageSha`); doctype handlers in
  `@guilde/core/domain/import/handlers.ts` are first-match-wins by path —
  ordering matters when one path could match two handlers.

## Verify

`pack validate <dir>` passes, the MCP surface reports the pack landed
(`apply_company` response or the guild listing shows the expected
operators/corpora), and `resync_pack` reports no unexpected changes (sha
matches, upsert no-op or intended-only delta). A pack whose resync finds a
mismatch has drifted — re-import with `upsert-by-slug`.
