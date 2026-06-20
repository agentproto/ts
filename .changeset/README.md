# Release process

## How releases work

This repo uses [Changesets](https://github.com/changesets/changesets) for
automated versioning and npm publishing.

### Automated flow (CI)

1. **Feature branch** — develop and test your changes.
2. **Add a changeset** before opening a PR:
   ```bash
   pnpm changeset
   # pick affected packages, bump type (patch/minor/major), write a description
   ```
   This creates a `.changeset/<random-slug>.md` file. Commit it with your code.
3. **Open a PR** — CI validates the changeset is present.
4. **Merge to `main`** — `release.yml` runs and does one of two things:
   - **Pending changesets exist** → opens/updates a "Version Packages" PR that
     bumps all affected package versions and updates CHANGELOGs.
   - **No pending changesets** (i.e. the "Version Packages" PR was just merged)
     → publishes every changed package to npm and creates GitHub releases.

### Manual publish (emergency / first publish of a new package)

```bash
# Dry-run first
scripts/publish-packages.sh --dry-run

# Publish with NPM_TOKEN in env
NPM_TOKEN=<token> scripts/publish-packages.sh

# Or let it prompt for TOTP
scripts/publish-packages.sh
```

## Secrets required

| Secret | Where | Notes |
|---|---|---|
| `NPM_TOKEN` | GitHub repo → Settings → Secrets | Granular access token for the `@agentproto` npm org. See note below on auth options. |
| `GITHUB_TOKEN` | Automatic | Provided by GitHub Actions; needs `contents: write` + `pull-requests: write` (set in `release.yml`). |

### NPM auth options (pick one)

**A. OIDC Trusted Publishing** — zero secrets, best security. Requires `id-token: write` permission in
`release.yml` and manually configuring a "Trusted Publisher" on npm.com for each published package
(Package settings → Access → Trusted Publishers → add the GitHub repo + workflow name). Not practical
with 50+ packages unless you script the npm API.

**B. Granular access token with "Bypass 2FA"** — what `release.yml` uses by default. "Bypass 2FA" is
npm's official CI publishing feature (not a security bypass): it lets a token perform write operations
without an OTP code, which is required for any unattended publish job. Create the token at
[npmjs.com/settings/agentiknet/tokens](https://www.npmjs.com/settings/agentiknet/tokens): choose
"Granular Access Token" → select the `@agentproto` packages → check "Bypass 2FA" → expiry ≤ 1 year.

If you later move to OIDC, remove `NODE_AUTH_TOKEN` from `release.yml` and add
`id-token: write` to the `permissions` block — provenance attestation is automatic.

## Bump type guide

| Bump | When |
|---|---|
| `patch` | Bug fix, docs, internal refactor — no API change. |
| `minor` | New export, new field, new optional method — backward-compatible. |
| `major` | Breaking change: removed export, changed signature, renamed type. |

During `0.x.y-alpha` pre-release, `minor` is appropriate for most new features.

## Adding a new package

1. Create the package under `packages/<name>/` with standard `package.json` + `tsup.config.ts`.
2. Add it to the PACKAGES list in `scripts/publish-packages.sh` at the right dependency layer.
3. First publish is manual (`scripts/publish-packages.sh`) — changesets doesn't publish packages
   that have never been on npm before.
4. Subsequent releases are fully automated via the changeset flow above.
