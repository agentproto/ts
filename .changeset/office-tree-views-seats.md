---
"@agentproto/office": minor
---

Follow AIP-22 "An office spans a company tree". The frontmatter schema is regenerated from the vendored `OFFICE.schema.json`: `extends` now names an `OFFICE.md` (`../OFFICE.md` from a child node; it demanded `COMPANY.md` before, so no view could parse) and `executor` also accepts the AIP-54 compact `operator:<slug>[@<owner>/<slug>]` form. New `analyzeOfficeTree` checks what the schema cannot: one workspace-root office per tree (`office_tree_second_root`), views whose `extends` stays in the tree, seats whose containment `parent` is an allowed item or a `workspace:` view of the same tree under the reserved kind `view` (`office_seat_parent_outside`, per item), `reportsTo` resolving inside the office, holders as `operator:`/`user:` compact refs or `ws://operators/<slug>` (`office_holder_unresolvable` warning), the node of a seat, and the executor lens of a node. `readOfficeTree` (in `@agentproto/office/manifest`) loads the input from a folder.
