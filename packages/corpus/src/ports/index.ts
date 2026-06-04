/**
 * @agentproto/corpus/ports — runtime ports injected by the host.
 *
 * The kit is pure: it never touches a filesystem, network socket, or
 * sandbox directly. Hosts (agstudio adapter for cloud topology,
 * @agstudio/corpus-cli for local topology) supply concrete
 * implementations of these interfaces at construction time.
 */

export type { FsPort, FsStat, FsLockHandle } from "./fs.port.js"
export type { ClockPort } from "./clock.port.js"
export { systemClock } from "./clock.port.js"
export type { IdentityPort, CallerIdentity } from "./identity.port.js"
export type {
  FetcherPort,
  FetchedSource,
  FetchedSourceKind,
} from "./fetcher.port.js"

export type {
  EvaluatorPort,
  EvalInputPort,
  EvalResultPort,
  EvalRubricPort,
  EvalContextPort,
} from "./evaluator.port.js"

// Reserved for later milestones:
//   ExecutorPort  — playbook.ts runner (workflow exec sandbox)
