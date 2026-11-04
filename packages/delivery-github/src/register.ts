import type { Classifier, Envelope } from "@agentproto/delivery"

import {
  GITHUB_CLASSIFIERS,
  GITHUB_COALESCE_RULES,
  githubRepeatKeyFor,
  type GithubCoalesceRule,
} from "./github.js"

export interface GithubDeliveryRegistration {
  registerClassifier(classifier: Classifier): () => void
  registerCoalesceRule(rule: GithubCoalesceRule): () => void
  registerRepeatKey?(resolver: (event: Envelope) => string | undefined): () => void
}

/** Register the GitHub producer's classifiers, coalesce rules and repeat-key
 *  resolver into a delivery producer's registries. Returns one undo handle
 *  for tests and for producer shutdown. */
export function registerGithubDeliveryModule(registry: GithubDeliveryRegistration): () => void {
  const undo: Array<() => void> = []
  for (const classifier of GITHUB_CLASSIFIERS) undo.push(registry.registerClassifier(classifier))
  for (const rule of GITHUB_COALESCE_RULES) undo.push(registry.registerCoalesceRule(rule))
  if (registry.registerRepeatKey) undo.push(registry.registerRepeatKey(githubRepeatKeyFor))
  return () => {
    while (undo.length > 0) undo.pop()?.()
  }
}

export const registerGithubDeliveryRules = registerGithubDeliveryModule
