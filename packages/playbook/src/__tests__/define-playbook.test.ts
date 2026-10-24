import { describe, it, expect } from "vitest"
import { definePlaybook } from "../define-playbook.js"
import { parsePlaybookManifest } from "../manifest/index.js"

describe("definePlaybook (AIP-12)", () => {
  // The AIP-12 doctype uses 'slug' + 'title' instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof definePlaybook).toBe("function")
  })

  // TODO: spec-12 tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.

  const doc = (tag: string) => `---
schema: ${tag}
slug: warm-openers
title: Warm openers
evidence:
  - kind: run
    ref: run:42
---
`

  it("parses a PLAYBOOK.md carrying the canonical playbook/v1 tag", () => {
    expect(parsePlaybookManifest(doc("playbook/v1")).frontmatter.schema).toBe("playbook/v1")
  })

  it("still parses the legacy playbooks/v1 tag", () => {
    expect(parsePlaybookManifest(doc("playbooks/v1")).frontmatter.schema).toBe("playbooks/v1")
  })
})
