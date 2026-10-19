# @agentproto/pr-outcome

## 0.1.1

### Patch Changes

- Updated dependencies [6d8a531]
- Updated dependencies [8ea3ce4]
- Updated dependencies [9a90833]
- Updated dependencies [4c5f6e4]
- Updated dependencies [57ae214]
- Updated dependencies [13390f0]
- Updated dependencies [22ab84f]
- Updated dependencies [9a90833]
- Updated dependencies [22ab84f]
- Updated dependencies [ca9dc5e]
- Updated dependencies [4c5f6e4]
- Updated dependencies [13390f0]
  - @agentproto/runtime@5.27.0

## 0.1.0

### Minor Changes

- 99dae4c: New private package `@agentproto/pr-outcome`: an observation-only collector that joins merged-PR outcomes (reviews, bot vs human comments, commits after first review, CI failures, revert detection) with the `@agentproto-bot` provenance footer parsed back via `@agentproto/pr-outcome`'s `parseFooter`. These records are anecdotal — `basis: "observed"`, unobservable fields left `undefined` — and are never an input to routing rules or quotas. The package is `private: true` and does not reach the npm surface.

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- Updated dependencies [e9e2cb5]
- Updated dependencies [46244e2]
- Updated dependencies [743fa74]
- Updated dependencies [78a3983]
- Updated dependencies [80f0060]
- Updated dependencies [e736c7c]
- Updated dependencies [01ea248]
- Updated dependencies [629e42c]
- Updated dependencies [b324f0e]
- Updated dependencies [70d533f]
- Updated dependencies [7e5ffd8]
- Updated dependencies [f2205fd]
- Updated dependencies [ef1c877]
- Updated dependencies [11f986f]
- Updated dependencies [c30bf32]
- Updated dependencies [239fe1f]
- Updated dependencies [e9e2cb5]
- Updated dependencies [3c30cda]
- Updated dependencies [9b99d62]
- Updated dependencies [74f982c]
- Updated dependencies [2d61d46]
- Updated dependencies [9b836b4]
- Updated dependencies [743fa74]
- Updated dependencies [f1d0c95]
- Updated dependencies [0b43b1f]
- Updated dependencies [7e5ffd8]
- Updated dependencies [11f986f]
- Updated dependencies [f915069]
- Updated dependencies [629e42c]
- Updated dependencies [3a50c3d]
- Updated dependencies [2d61d46]
- Updated dependencies [f1d0c95]
- Updated dependencies [3c30cda]
- Updated dependencies [0b43b1f]
- Updated dependencies [9b836b4]
- Updated dependencies [239fe1f]
- Updated dependencies [c30bf32]
- Updated dependencies [7d7aaf9]
- Updated dependencies [9b99d62]
- Updated dependencies [ef1c877]
- Updated dependencies [70d533f]
- Updated dependencies [74f982c]
- Updated dependencies [f2205fd]
  - @agentproto/runtime@5.26.0
