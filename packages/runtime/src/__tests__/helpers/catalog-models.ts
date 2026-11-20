/**
 * Models for tests, read from the catalog at test time.
 *
 * A test must never name a real model id: the weekly Catalog Sync adds and
 * retires ids (opencode/glm-5.3-flash-free vanished on 2026-11-20 and took a
 * dozen tests with it). Tests that need "some free model" import FREE_MODEL;
 * tests that only pass a model string through use any id from here too.
 */

import { DEFAULT_ROTATION_LIST_ID, SEED_MODEL_LISTS } from "../../model-list-store.js"
import { formatModelRef, listRouterLlmRoutes } from "@agentproto/model-catalog/route-identity"

function zeroPricedOpencodeIds(): string[] {
  return listRouterLlmRoutes("opencode")
    .filter(r => r.pricing.inputPer1M === 0 && r.pricing.outputPer1M === 0)
    .map(r => formatModelRef(r.ref))
}

const FREE_IDS = zeroPricedOpencodeIds()
if (FREE_IDS.length < 2) {
  throw new Error("the opencode route table needs at least two zero-priced models for the tests")
}

/** A zero-priced OpenCode id from the live catalog. */
export const FREE_MODEL: string = FREE_IDS[0]!
/** A second, different zero-priced id (for "another model" cases). */
export const OTHER_FREE_MODEL: string = FREE_IDS[1]!

/** The shipped default-rotation list, read from the seed, never copied. */
export const ROTATION_IDS: readonly string[] =
  SEED_MODEL_LISTS.find(l => l.id === DEFAULT_ROTATION_LIST_ID)?.ids ?? []
/**
 * Two different members of default-rotation on the SAME route (same provider
 * prefix): a live model switch inside one route is applied in place, across
 * routes it needs a restart, and the policy tests care about the former.
 */
const [ROTATION_MODEL_, OTHER_ROTATION_MODEL_] = (() => {
  const byRoute = new Map<string, string[]>()
  for (const id of ROTATION_IDS) {
    const route = id.split("/")[0]!
    byRoute.set(route, [...(byRoute.get(route) ?? []), id])
  }
  const pair = [...byRoute.values()].find(ids => ids.length >= 2)
  if (!pair) throw new Error("default-rotation needs two members on one route for the tests")
  return [pair[1]!, pair[0]!] as const
})()
export const ROTATION_MODEL: string = ROTATION_MODEL_
export const OTHER_ROTATION_MODEL: string = OTHER_ROTATION_MODEL_

/** A priced (paid) cataloged id that is not in default-rotation. */
export const PAID_MODEL: string = (() => {
  const route = listRouterLlmRoutes("opencode").find(
    r =>
      r.pricing.inputPer1M > 0 &&
      !ROTATION_IDS.includes(formatModelRef(r.ref)),
  )
  if (!route) throw new Error("the opencode route table needs a priced model for the tests")
  return formatModelRef(route.ref)
})()
