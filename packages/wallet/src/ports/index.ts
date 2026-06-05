/**
 * @agentproto/wallet/ports — runtime ports injected by the host.
 *
 * The kit is pure: it never touches a database, network socket, or payment rail
 * directly. Hosts (the agstudio Postgres + settlement adapters for cloud, an
 * in-memory pair for tests) supply concrete implementations at construction.
 */

export type { ClockPort } from "./clock.port.js"
export { systemClock } from "./clock.port.js"
export type { StoragePort } from "./storage.port.js"
export type { RatePort } from "./rate.port.js"
export type {
  SettlementPort,
  SettlementResult,
} from "./settlement.port.js"
