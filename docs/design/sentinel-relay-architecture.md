# Sentinel relay architecture: plan

Status: proposal for review. No code in this PR; this document only.

## Problem

`packages/sentinel/src/sentinel-triage.ts` decides wake | fyi | drop per event. It currently classifies by two mechanisms: the generic rules (`terminal`, `failure`, `coalesced-repeat`, `default`) and a verdict lookup that reads `data.conclusion` / `data.state` (GitHub check suites, workflow runs, statuses, reviews). PR agentproto/ts#2444 (branch `fix/sentinel-triage-github-table`) went further and hard-coded a `SENTINEL_GITHUB_TRIAGE_RULE_TABLE` of GitHub event classes (`github.check_suite.completed`, `github.pull_request_review.submitted`, ...) directly inside that core file. The owner rejected this: the sentinel core must not know GitHub.

Also relevant: GitHub-shaped rules already exist in two more core files. `sentinel-coalesce.ts` registers default coalesce rules `github-ci` and `github-push` keyed on GitHub event types, and `sentinel-providers/local-gh.ts` (a provider, which is allowed to know GitHub) imports `GITHUB_DEFAULT_PR_TYPES` from `sentinel-github-normalize.ts`. This plan moves triage GitHub knowledge out of the core; the coalesce defaults get the same treatment in a follow-up PR listed below.

## Target picture

```
provider (local-gh | webhook | agentpush | session)
   |
   |  SentinelEvent (normalized, provider-specific `type`)
   v
classifier registry  <-- registered at startup by provider packages
   |  (maps a provider event -> generic level 3/2/1/0)
   v
relay core (sentinel-triage + relay routing)
   |  reads only generic fields: level hint, terminal, repeat key, subject
   v
targets (session | routine | webhook) -> ledger (applied: false)
```

The core is a relay: it receives normalized events and routes them to targets. It never inspects `data.conclusion`, `data.state`, `data.actor`, or any `github.*` type string.

## The generic event contract

The core may read exactly these fields. They sit beside the existing `SentinelEvent` (`sentinel-providers/types.ts:32`), either as new optional extensions on it or as a projection object the classifier output supplies. Exact shape:

```ts
/** Generic level, mapped to delivery behavior. */
export type SentinelLevel =
  | 3 // blocking  -> wake (must act now)
  | 2 // actionable -> wake (actor or human needed)
  | 1 // info      -> fyi
  | 0 // noise     -> drop

/** Extension the relay core reads. Providers stamp it; classifiers default it. */
export interface SentinelRelayFields {
  /** Ends the subject's lifecycle. Already exists on SentinelEvent as
   *  `terminal: boolean`. */
  readonly terminal?: boolean
  /** Level hint from the provider or a classifier. Absent = the relay
   *  applies its own generic defaults. */
  readonly level?: SentinelLevel
  /** Coalescing / repeat key. Same string the coalesce stage uses. */
  readonly repeatKey?: string
  /** Primary subject, e.g. "github:acme/widgets#42". Already exists. */
  readonly subject: string
}
```

Rules:

- The core classifies by `level`, `terminal`, `repeatKey` and `subject` only. It never inspects `event.type` against provider names and never reads `event.data`.
- Generic defaults when no classifier fires: `terminal` -> level 3 (wake); an explicit level is honored; otherwise level 2 (wake, today's `default` rule).
- level 0 (`noise`) is the first mechanism the core has ever had to say "do not deliver". While triage stays observation-only, a level-0 classification is written to the ledger with `applied: false` and delivery still happens.

## The classifier interface and registry

A classifier maps one provider event family to a generic level. Same registry pattern as the existing provider registry (`sentinel-providers/registry.ts`) and the existing rule registry in `sentinel-coalesce.ts`.

```ts
/** One classifier = one event family. */
export interface SentinelClassifier {
  /** Stable rule id, recorded in the ledger. */
  readonly id: string
  /** Event type patterns this classifier covers. Provider-specific
   *  globs, e.g. "github.check_suite.*". Exact or trailing `*` prefix,
   *  same semantics as matchesType in sentinel-coalesce.ts. */
  readonly types: readonly string[]
  /** Return a level, or undefined to decline (fall through). */
  classify(event: SentinelEvent): SentinelLevel | undefined
}

/** Register a classifier. Returns an unregister handle for tests. */
export function registerSentinelClassifier(c: SentinelClassifier): () => void

/** List registered classifiers, registration order. */
export function listSentinelClassifiers(): readonly SentinelClassifier[]
```

Semantics:

- Ordering: first match wins, registration order. Default classifiers register at their module's import; provider packages register at startup, the same point where `BUILTIN_SENTINEL_PROVIDERS` is wired.
- Conflict rule: if two classifiers cover the same `type` pattern, the earlier-registered one wins silently. A duplicate registration with the same `id` replaces its earlier entry in place (keeps the original position). A dev-time `log` warning is emitted on an overlapping pattern; it is never a throw.
- No classifier matches: the classifier registry yields no level for that event. The relay core then applies the generic defaults above (terminal -> 3, else 2). The ledger records the rule `relay-default` (see Ledger section). The event is still delivered; an unclassified event never blocks or drops.
- Registry is process-global on construction, same tradeoff `sentinel-coalesce.ts:43` already makes; it is passed into the relay core as constructor state instead of a module singleton where testability requires it.

## Where GitHub lives

New package (or module inside packages/sentinel if a separate package is premature; owner to confirm):

```
packages/sentinel-github/   (suggested name: @agentproto/sentinel-github)
```

- Exports `registerSentinelGithubClassifiers()` plus the table as data (`SENTINEL_GITHUB_CLASSIFIERS`). The table is exactly the rows from PR #2444's `SENTINEL_GITHUB_TRIAGE_RULE_TABLE`, re-expressed as levels: failing check suite / workflow run / `changes_requested` review / non-bot comment -> 3; success / neutral / skipped / approved / commented / merged-close / bot comment / `synchronize` -> 1; unmerged close -> 1. The `verdictOf` helper (`data.conclusion` / `data.state`, lowercased) and the `[bot]` actor check move here.
- The core never imports this package. It is enabled by default at the daemon wiring site (where `BUILTIN_SENTINEL_PROVIDERS` is installed and `configureSessionSentinelProvider` is called), by calling `registerSentinelGithubClassifiers()` once at startup. A test gateway or embedding that skips the wiring simply has no GitHub knowledge.
- The GitHub provider `local-gh.ts` stays a provider (providers may know GitHub). Its `defaultTypes` stays as is.
- The coalesce defaults `github-ci` and `github-push` in `sentinel-coalesce.ts` move into the same GitHub package, registered by the same setup call (follow-up; see Migration step 5).

## Migration steps

Small ordered PRs, each independently mergeable, each branched from main. Branch names are suggestions.

1. **Classifier registry core** (branch `feat/sentinel-classifier-registry`). Add `SentinelLevel`, `SentinelClassifier`, `registerSentinelClassifier`, `listSentinelClassifiers` in a new `sentinel-classifiers.ts`. No behavior change; nothing consumes it yet. Test that must fail on old code: import the new module, register a classifier, assert `listSentinelClassifiers()` ordering and the unregister handle. Old code has no such module, so the test file does not exist until this PR.

2. **Relay core behind the registry** (branch `feat/sentinel-relay-classify`). Rewrite `classifySentinelEvent` in `sentinel-triage.ts` to: (a) ask the classifier registry for a level, (b) restore today's verdict-based rules ONLY as a temporary bootstrap classifier registered from `sentinel-triage.ts` itself (so behavior is byte-identical), (c) map levels to decisions. The `verdictOf`-based `FAILURE_VERDICTS` logic moves into that bootstrap classifier. Ledger `rule` values gain `classifier:<id>` / `relay-default`. Test that must fail on old code: `packages/sentinel/src/__tests__/sentinel-triage.test.ts` gains a case "a registered classifier overrides the default rule" that calls `registerSentinelClassifier` with a synthetic type (not a `github.*` type, so it stays GitHub-free) and asserts its level decides the outcome. Today's core ignores classifiers, so this fails on the pre-PR tree.

3. **GitHub package** (branch `feat/sentinel-github-package`). Create the GitHub module, implement `registerSentinelGithubClassifiers` with the #2444 table as data. Delete the bootstrap classifier's GitHub rows (not the registry itself). Wire the registration at the daemon startup site. `SentinelTriageRule` union drops `github-triage-table` and gains `classifier:<id>`; ledger consumers only read the string, so this is additive. Tests that must fail on old code plus assertion on old shapes:
   - `packages/sentinel/src/__tests__/sentinel-triage.test.ts`: a `github.check_suite.completed` failure event still classifies wake (imports the GitHub package to register before classify). On old code the core has no files from the GitHub package, so the import fails.
   - New `packages/sentinel-github/src/*.test.ts` asserting the same verdict mapping as PR #2444.

4. **Drop the #2444 direction** (branch `chore/no-github-in-core`). If #2444 ever lands, revert its table from `sentinel-triage.ts`; this PR is the reconciliation. A guard test greps `sentinel-triage.ts` and `sentinel-classifiers.ts` source text and fails if `github.` or `data.conclusion` / `data.state` / `data.actor` appear outside a comment block. Must fail while the table exists in the core.

5. **Coalesce defaults move out** (branch `chore/github-coalesce-out-of-core`, follow-up). Move the `github-ci` and `github-push` default rules from `sentinel-coalesce.ts` into the GitHub package, registered by the same startup call. Test that must fail on old code: a unit test asserting `listSentinelCoalesceRules()` is empty right after import of `sentinel-coalesce.ts` (defaults registered only by the GitHub package). Old code registers defaults at import, so the import-time-empty assertion fails.

## Ledger and compatibility

Rule names in the ledger after migration:

| Stage | `rule` values |
|---|---|
| Today | `terminal`, `failure`, `coalesced-repeat`, `default` |
| Step 2 adds | `classifier:<id>`, `relay-default` |
| Step 3 removes | `github-triage-table` (never landed on main; only if #2444 merged first) |

Level mapping to decisions, recorded in the ledger's `decision` field: 3 -> `wake`, 2 -> `wake`, 1 -> `fyi`, 0 -> `drop`. Suggestion for owner: if a 0 and a 2 landing in the same review disagree, we may also want level names in the ledger to make the mapping auditable.

Existing consumers of the `sentinel-triage` exports (checked by grep over the repo, excluding `node_modules`):

- `packages/sentinel/src/sentinel-runtime.ts` (imports `RecentKeys`, `classifySentinelEvent`, `recordSentinelTriageKey`, `sentinelTriageKeyFor`, `writeSentinelTriageLedger`; sets the triage-run/record calls in `deliverEvent`, constructs `recentTriageKeys`, takes `triagePath` in `SentinelRuntimeOptions`).
- `packages/sentinel/src/__tests__/sentinel-triage.test.ts` (imports `DEFAULT_RECENT_KEYS_CAP`, `RecentKeys`, `SENTINEL_TRIAGE_REPEAT_WINDOW_MS`, `classifySentinelEvent`, `recordSentinelTriageKey`, `writeSentinelTriageLedger`).

No other file imports `sentinel-triage.ts`: `packages/sentinel/src/index.ts`, `sentinel-tools.ts`, and the providers do not import it, so the public API is the runtime call site plus the unit tests. Both keep working: the exported function names and the `TriageDecision` values stay the same.

## Open questions for the owner

1. Separate package (`@agentproto/sentinel-github`, discovered like third-party packages via `sentinelPlatform().discovery.discover()`) or an in-repo module registered at the daemon wiring site? The plan assumes the latter for step 3 and flags the former as a step-6 candidate.
2. Is level 0 (`noise`/drop) in scope for the first cut, or only logged once `applied` triage exists? Deciding now avoids a second meaning change later.
3. Where does `applied` triage get its gate? Today delivery still happens behind classification (observation only). A candidate gate point is `deliverEvent` in `sentinel-runtime.ts:649`, before `sendMessage`, keyed on a config flag. Is there a target package or feature for that stage?
4. Registry startup ordering: classifiers must register before the first event lands. Is the wiring site after platform init but before `createSentinelRuntime().start()` the accepted single hook, and is registration idempotency (registering twice logs but does not duplicate) acceptable?
5. Level model naming: persist levels in the ledger as numbers, names (`blocking`/`actionable`/`info`/`noise`), or both? Consumers of the JSONL ledger today read only `decision`; any level addition is additive.
