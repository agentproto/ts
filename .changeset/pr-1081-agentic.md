---
"@agentproto/corpus": minor
"@agentproto/corpus-cli": minor
---

Add bibliography content-SHA verification to prevent citations from silently mismatching when packs are regenerated mid-run. New exports: `bibliographySha`, `bibShaMarker`, `recordedBibSha`, `stripBibShaMarker`. New optional parameters: `bibSha` in `AssembleOptions`, `bibSha` and `checkBibSha` in `ApplyEditsOptions`/`CollectSectionsOptions`. Enhanced CLI output and error handling.
