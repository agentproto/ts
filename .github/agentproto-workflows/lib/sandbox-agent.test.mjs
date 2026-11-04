import { test } from "node:test"
import assert from "node:assert/strict"

import { CAS_STOP_RULE } from "../../../packages/git-cas/dist/index.mjs"
import { commitDeliveryBlock, restOpenPrBlock } from "./sandbox-agent.mjs"

const SHA = "0123456789abcdef0123456789abcdef01234567"

test("commitDeliveryBlock leases the existing branch head and states the stop rule", () => {
  const text = commitDeliveryBlock({ branch: "feature/x", expectedSha: SHA })
  assert.match(text, /--force-with-lease=refs\/heads\/feature\/x:0123456789abcdef0123456789abcdef01234567/)
  assert.ok(text.includes(CAS_STOP_RULE))
  assert.doesNotMatch(text, /git push origin "HEAD:feature\/x"/)
})

test("commitDeliveryBlock without a head SHA never falls back to a plain push", () => {
  const text = commitDeliveryBlock({ branch: "feature/x" })
  assert.doesNotMatch(text, /git push/)
  assert.ok(text.includes(CAS_STOP_RULE))
  assert.match(text, /reporting `head_moved`/)
})

test("restOpenPrBlock leases an absent branch and states the stop rule", () => {
  const text = restOpenPrBlock({ repo: "o/r", branch: "bot/fix-7", base: "main" })
  assert.match(text, /--force-with-lease=refs\/heads\/bot\/fix-7:(?:\s|$)/m)
  assert.ok(text.includes(CAS_STOP_RULE))
  assert.match(text, /fresh branch name/)
})

test("restOpenPrBlock leases a reused stacked branch on its observed tip", () => {
  const text = restOpenPrBlock({
    repo: "o/r",
    branch: "bot/fix-7",
    base: "main",
    expected: { sha: SHA },
  })
  assert.match(text, /--force-with-lease=refs\/heads\/bot\/fix-7:0123456789abcdef0123456789abcdef01234567/)
  assert.ok(text.includes(CAS_STOP_RULE))
  assert.doesNotMatch(text, /fresh branch name/)
})
