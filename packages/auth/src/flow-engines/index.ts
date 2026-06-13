/**
 * Flow engine registry — dispatch by `provider.auth.flow`.
 *
 * Add a new engine:
 *   1. Implement `FlowEngine` in a sibling file
 *   2. Add it here — no if/switch chains at call sites
 */

import type { FlowEngine } from "../types.js"
import { patFlowEngine } from "./pat.js"
import { serviceAuthFlowEngine } from "./service-auth.js"

export const FLOW_ENGINES: Readonly<Record<string, FlowEngine>> = {
  [patFlowEngine.id]: patFlowEngine,
  [serviceAuthFlowEngine.id]: serviceAuthFlowEngine,
}
