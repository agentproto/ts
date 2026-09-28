/**
 * Session inference binding — resolve `agent_start`'s `inference` field
 * (`{endpoint}` / `{endpoint, model}` / `{model: "<model>@<device|endpoint>"}`)
 * into a concrete local/LAN endpoint + model, run the harness fit check
 * against its loaded ctx BEFORE spawn, and project the result into the
 * ordinary `model`/`route`/`access`/`auth`/`deferredTools` fields the rest of
 * `session-spawn.ts`'s pipeline already understands — see
 * `.plans/agentproto-onboarding/SESSION-INFERENCE-BINDING.md`.
 *
 * A configured endpoint's ctx/model list comes from
 * `@agentproto/llm-endpoint`'s connectors (`connectorById(...).listModels`) —
 * the SAME probe `agentproto llm endpoints test`/`doctor` already use, never
 * reimplemented per-runtime here. A `<endpointId>@<device>` reference (a
 * paired host's own shared endpoint, DEVICES-PLAN item 2) is resolved through
 * an injected device probe (real implementation: `HostRegistry.forwardHttp`
 * against `/devices/:id/exec-stream/device-inference/v1/models`) — that route
 * only ever returns model IDS, never loaded ctx (the gateway's aggregate
 * `/v1/models` merges named-endpoint models by id only — see
 * `packages/llm-endpoint/src/index.ts`'s `probeFileEndpointModels`), so a
 * device-routed harness's fit check is always `unknown` (warn, never block)
 * — an OFFLINE/unreachable device is a distinct, harder failure (the
 * endpoint can't be resolved at all), surfaced as `ok:false`.
 */

import {
  checkHarnessFit,
  connectorById,
  getConfiguredEndpoints as defaultGetConfiguredEndpoints,
  type ConnectorId,
  type ConnectorModel,
  type EndpointConfig,
  type FitCheckResult,
} from "@agentproto/llm-endpoint"

export interface InferenceBindingRequest {
  /** A configured endpoint id, or `<endpointId>@<device>` for a paired
   *  host's own shared endpoint. */
  endpoint?: string
  /** A bare model id (paired with `endpoint`), or — when `endpoint` is
   *  omitted — the shorthand `"<modelId>@<device|endpoint>"`. */
  model?: string
  /** Skip the fit-check refusal (still runs the check, still warns). */
  force?: boolean
  /** Overrides {@link DEFAULT_HEADROOM_RATIO} from `@agentproto/llm-endpoint`. */
  headroomRatio?: number
}

/** Outcome of probing a paired device for its own shared inference models —
 *  the daemon-to-daemon leg of a `<endpointId>@<device>` / `<model>@<device>`
 *  reference. Never throws; a network/pairing failure resolves `reachable:false`. */
export type DeviceProbeResult =
  | { reachable: true; endpointId: string; modelIds: string[] }
  | { reachable: false; message: string }

export interface ResolveInferenceBindingDeps {
  getConfiguredEndpoints?: () => EndpointConfig[]
  /** Defaults to the endpoint's own declared connector's `listModels`. */
  listModels?: (endpoint: EndpointConfig) => Promise<ConnectorModel[]>
  /** Probe a paired device's shared endpoint for `modelId`. Required only
   *  when a device-qualified reference is actually resolved — omitted in
   *  tests/contexts that never exercise that path. */
  probeDevice?: (device: string, modelId: string) => Promise<DeviceProbeResult>
}

export type ResolvedInferenceTarget =
  | {
      kind: "local"
      endpointId: string
      modelId: string
      loadedCtx: number | undefined
      connector: ConnectorId
      baseUrl: string
    }
  | {
      kind: "device"
      /** The FAR side's own endpoint id serving this model, e.g. "ollama". */
      remoteEndpointId: string
      device: string
      modelId: string
      /** Always `undefined` — see this module's doc comment. */
      loadedCtx: undefined
    }

export interface InferenceBindingError {
  ok: false
  message: string
}

export interface InferenceBindingOk {
  ok: true
  target: ResolvedInferenceTarget
  /** The gateway-wire model string: `<endpointId>/<modelId>` (local) or
   *  `<remoteEndpointId>@<device>/<modelId>` (device) — see
   *  `packages/llm-endpoint/src/index.ts`'s `DEVICE_PROVIDER_RE`. */
  gatewayModelId: string
  /** A human label for error/doctor messages, e.g. `"lmstudio"` or `"ollama@work-mac"`. */
  label: string
}

const LAST_AT_RE = /^(.+)@([^@]+)$/

function splitOnLastAt(value: string): { head: string; tail: string } | null {
  const m = LAST_AT_RE.exec(value)
  return m ? { head: m[1]!, tail: m[2]! } : null
}

/** Pick the single loaded model off a connector's live listing — used when
 *  the caller named an endpoint but not a model. Errors (rather than
 *  guessing) when zero or more than one model is loaded. */
function pickSoleLoadedModel(
  models: readonly ConnectorModel[],
): { ok: true; model: ConnectorModel } | { ok: false; message: string } {
  const loaded = models.filter(m => m.state === "loaded")
  if (loaded.length === 1) return { ok: true, model: loaded[0]! }
  if (loaded.length === 0) {
    return { ok: false, message: "no model is currently loaded on this endpoint — load one first, or pass `inference.model` explicitly." }
  }
  return {
    ok: false,
    message:
      `${loaded.length} models are loaded on this endpoint (${loaded.map(m => m.id).join(", ")}) — pass \`inference.model\` to pick one.`,
  }
}

async function resolveLocalEndpoint(
  endpoint: EndpointConfig,
  modelId: string | undefined,
  deps: ResolveInferenceBindingDeps,
): Promise<InferenceBindingOk | InferenceBindingError> {
  const connectorId: ConnectorId = endpoint.connector ?? "openai-compatible"
  const connector = connectorById(connectorId)
  if (!connector) {
    return { ok: false, message: `endpoint "${endpoint.id}" declares unknown connector "${connectorId}".` }
  }
  const listModels = deps.listModels ?? (ep => connector.listModels(ep.baseUrl))
  const models = await listModels(endpoint)

  let resolvedModelId: string
  if (modelId) {
    resolvedModelId = modelId
  } else {
    const sole = pickSoleLoadedModel(models)
    if (!sole.ok) return sole
    resolvedModelId = sole.model.id
  }

  const match = models.find(m => m.id === resolvedModelId)
  const target: ResolvedInferenceTarget = {
    kind: "local",
    endpointId: endpoint.id,
    modelId: resolvedModelId,
    loadedCtx: match?.loadedCtx,
    connector: connectorId,
    baseUrl: endpoint.baseUrl,
  }
  return {
    ok: true,
    target,
    gatewayModelId: `${endpoint.id}/${resolvedModelId}`,
    label: endpoint.id,
  }
}

async function resolveDeviceEndpoint(
  device: string,
  modelId: string,
  deps: ResolveInferenceBindingDeps,
): Promise<InferenceBindingOk | InferenceBindingError> {
  if (!deps.probeDevice) {
    return {
      ok: false,
      message: `"@${device}" needs a device probe (this daemon has no paired-host registry wired) — cannot resolve.`,
    }
  }
  const probe = await deps.probeDevice(device, modelId)
  if (!probe.reachable) {
    return { ok: false, message: `device "${device}" is offline or unreachable — ${probe.message}` }
  }
  if (!probe.modelIds.includes(modelId)) {
    return {
      ok: false,
      message: `device "${device}" is online but has no loaded model "${modelId}" (it has: ${probe.modelIds.join(", ") || "(none loaded)"}).`,
    }
  }
  const target: ResolvedInferenceTarget = {
    kind: "device",
    remoteEndpointId: probe.endpointId,
    device,
    modelId,
    loadedCtx: undefined,
  }
  return {
    ok: true,
    target,
    gatewayModelId: `${probe.endpointId}@${device}/${modelId}`,
    label: `${probe.endpointId}@${device}`,
  }
}

/**
 * Resolve `inference.endpoint`/`inference.model` into a concrete local or
 * device-hosted target. Does NOT run the fit check — see
 * {@link fitCheckForTarget} — resolution and fit-checking are separate steps
 * so a caller can report "which endpoint" before "does it fit".
 */
export async function resolveInferenceTarget(
  req: InferenceBindingRequest,
  deps: ResolveInferenceBindingDeps = {},
): Promise<InferenceBindingOk | InferenceBindingError> {
  const getConfiguredEndpoints = deps.getConfiguredEndpoints ?? defaultGetConfiguredEndpoints

  if (req.endpoint) {
    const deviceRef = splitOnLastAt(req.endpoint)
    // An explicit `endpoint` may itself be device-qualified
    // (`<endpointId>@<device>`) — but only when the head isn't ALSO a known
    // local endpoint id (a local id is never allowed to contain "@" per
    // llm-endpoint's own DEVICE_PROVIDER_RE contract, so this is unambiguous).
    if (deviceRef) {
      if (!req.model) {
        return { ok: false, message: `inference.endpoint "${req.endpoint}" is device-qualified — inference.model is required to pick a model on it.` }
      }
      return resolveDeviceEndpoint(deviceRef.tail, req.model, deps)
    }
    const endpoint = getConfiguredEndpoints().find(e => e.id === req.endpoint)
    if (!endpoint) {
      const known = getConfiguredEndpoints().map(e => e.id)
      return {
        ok: false,
        message: `inference.endpoint "${req.endpoint}" is not a configured endpoint (known: ${known.length > 0 ? known.join(", ") : "(none configured)"}). Run \`agentproto llm endpoints add\` or \`detect\` first.`,
      }
    }
    return resolveLocalEndpoint(endpoint, req.model, deps)
  }

  if (req.model) {
    const split = splitOnLastAt(req.model)
    if (!split) {
      return {
        ok: false,
        message: `inference.model "${req.model}" has no "@<device|endpoint>" suffix — pass inference.endpoint explicitly, or use the "<model>@<ref>" shorthand.`,
      }
    }
    const { head: modelId, tail: ref } = split
    const asLocalEndpoint = getConfiguredEndpoints().find(e => e.id === ref)
    if (asLocalEndpoint) return resolveLocalEndpoint(asLocalEndpoint, modelId, deps)
    return resolveDeviceEndpoint(ref, modelId, deps)
  }

  return { ok: false, message: "inference requires at least one of `endpoint` or `model`." }
}

export interface FitCheckOptions {
  headroomRatio?: number
  force?: boolean
}

/** Run the harness fit check against an already-resolved target. Never
 *  throws — a `no-fit` verdict without `force` is the caller's cue to refuse
 *  the spawn; `unknown` and `fits` both mean "proceed" (unknown just warns). */
export function fitCheckForTarget(
  harness: string,
  target: ResolvedInferenceTarget,
  label: string,
  opts: FitCheckOptions = {},
): FitCheckResult {
  return checkHarnessFit({
    harness,
    loadedCtx: target.loadedCtx,
    ...(opts.headroomRatio !== undefined ? { headroomRatio: opts.headroomRatio } : {}),
    endpointLabel: label,
  })
}
