/**
 * @agentproto/delivery-github: the GitHub producer's delivery knowledge.
 *
 * Kept out of `@agentproto/delivery` (pure kernel) and
 * `@agentproto/sentinel` (producer-agnostic runtime): verdict classes, the
 * explicit triage table, coalesce keys and repeat keys all live here.
 */

export {
  FAILURE_VERDICTS,
  GITHUB_CLASSIFIERS,
  GITHUB_COALESCE_RULES,
  GITHUB_TRIAGE_RULE_TABLE,
  githubCoalesceKeyFor,
  githubRepeatKeyFor,
  isFailureEvent,
  verdictOf,
} from "./github.js"
export type {
  GithubCoalesceRule,
  GithubTriageDecision,
  GithubTriageEventClass,
  GithubTriageRuleRow,
} from "./github.js"
export {
  registerGithubDeliveryModule,
  registerGithubDeliveryRules,
} from "./register.js"
export type { GithubDeliveryRegistration } from "./register.js"
