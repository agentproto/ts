# @agentproto/computer-api

Versioned public contract for the computer controller's HTTP API
(`POST/GET/DELETE /v1/computers...`): zod schemas plus inferred types for
every request body, response body, the error envelope, computer states and
published ports.

Generic and deployment-independent: no host names, no IPs, no tenant names,
no deployment specifics. Template ids are an OPEN string (any id a
controller has registered); controller error strings are also open.

## Design rules

- MINIMAL: only fields a client actually consumes are declared.
- Passthrough everywhere: a controller adding fields never breaks an
  older client.
- Read-tolerant computer states: unknown future states bucket under
  `"unknown"` instead of throwing.
- Synchronous, no-throw status reads: the state transform is a widening
  map, not an enum validator.

## Versioning

`COMPUTER_API_VERSION` (currently `"v1"`) is the API version the schemas
describe. A major bump of this package is where that constant changes.

## Endpoints covered

| Method | Route                        | Request schema              | Response schema              |
| ------ | ---------------------------- | --------------------------- | ---------------------------- |
| POST   | `/v1/computers`              | `createComputerRequestSchema` | `createComputerResponseSchema` |
| GET    | `/v1/computers/:id`          | -                           | `computerStatusSchema`       |
| POST   | `/v1/computers/:id/exec`     | `execRequestSchema`         | `execResponseSchema`         |
| POST   | `/v1/computers/:id/suspend`  | -                           | `suspendResponseSchema`      |
| POST   | `/v1/computers/:id/resume`   | -                           | `resumeResponseSchema`       |
| POST   | `/v1/computers/:id/attach`   | `attachRequestSchema` (optional body) | `sessionsResponseSchema` |
| POST   | `/v1/computers/:id/detach`   | `attachRequestSchema` (optional body) | `sessionsResponseSchema` |
| DELETE | `/v1/computers/:id`          | - (`?force=true` optional)  | `suspendResponseSchema` shape (all-optional) |
| any    | error body                   | -                           | `errorResponseSchema`        |

## Contract tests

`src/__tests__/fixtures.ts` carries a valid and an invalid fixture per
payload; `contract.test.ts` pins them. The fake controller used by
`@agentproto/sandbox-computer` validates everything it emits against the
same schemas, so the test double cannot drift from the published contract.

## Notes

- Sessions: `maxSessions` on create sizes the computer for that many
  concurrent sessions. `attach` takes a slot (409 at the cap), `detach`
  releases one (floors at 0), and `DELETE` answers 409 while sessions are
  attached unless `?force=true` is passed.
- `resume` MAY rename the computer: the controller can restore the suspend
  snapshot into a fresh computer under a NEW generated id and answer
  `{ id: <new>, state: "running" }`. Callers must treat the old id as gone
  and adopt the returned id.
- Egress is deny-by-default: a computer created without an
  `egress.allow` list has no DNS.
