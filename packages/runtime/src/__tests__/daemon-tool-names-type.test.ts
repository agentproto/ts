/**
 * Type-level tests for `DaemonToolName` (T2a): the union derived from
 * `DAEMON_TOOL_NAMES` must refuse a name absent from the list.
 *
 * Mechanism, not content: any name not in the list must fail to typecheck as
 * a `DaemonToolName`. The `@ts-expect-error` below is the refusal: remove it
 * and `pnpm --filter @agentproto/runtime check-types` goes red.
 */

import { describe, expectTypeOf, it } from "vitest"
import type { DaemonToolName } from "../daemon-tool-names.generated.js"

describe("DaemonToolName", () => {
  it("contains a registered daemon tool", () => {
    expectTypeOf<"session_list">().toExtend<DaemonToolName>()
  })

  it("refuses a name absent from the list", () => {
    // @ts-expect-error a name not registered by a daemon gateway is refused
    expectTypeOf<"absolutely_not_a_daemon_tool_name">().toExtend<DaemonToolName>()
  })
})
