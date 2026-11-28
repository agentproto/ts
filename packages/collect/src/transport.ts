/**
 * Transport contracts: what the engine hands to a connector's `fetch`.
 * Types only, plus the typed error every transport throws. The shipped
 * implementations live in the Node entry.
 */

export type TransportName = "api" | "http" | "browser"

/** Why a transport could not give usable content. */
export type TransportErrorCause = "blocked" | "empty" | "network" | "challenge" | "http"

export interface TransportErrorOptions {
  /** HTTP status when the failure came from a response. */
  status?: number
  /** Final URL of the failed request, when known. */
  url?: string
  /** Body of the failed response, kept as a raw when present. */
  body?: Uint8Array
  /** File extension of `body` (without the dot). */
  ext?: string
  /** The underlying error, when there is one. */
  origin?: unknown
}

export class TransportError extends Error {
  readonly code = "TRANSPORT_ERROR"
  readonly status?: number
  readonly url?: string
  readonly body?: Uint8Array
  readonly ext?: string
  readonly origin?: unknown
  constructor(
    /** Why the transport gave no usable content. */
    override readonly cause: TransportErrorCause,
    message: string,
    options: TransportErrorOptions = {},
  ) {
    super(message)
    this.origin = options.origin
    this.name = "TransportError"
    this.status = options.status
    this.url = options.url
    this.body = options.body
    this.ext = options.ext
  }
}

/**
 * Thrown by an auth-adding transport when the secret it needs is not
 * available. The engine records the task as `skipped` with this reason; it is
 * not a failure and does not fall back. The message names the secret, never
 * its value.
 */
export class MissingSecretError extends Error {
  readonly code = "MISSING_SECRET"
  constructor(readonly secret: string) {
    super(`missing secret "${secret}"`)
    this.name = "MissingSecretError"
  }
}

export interface HttpRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
  timeoutMs?: number
  signal?: AbortSignal
  /**
   * Lower-case names of headers that carry credentials. A transport that
   * follows redirects drops them when a hop leaves the origin.
   */
  credentialHeaders?: string[]
  /**
   * The URL itself carries a credential (a query parameter). A transport that
   * follows redirects refuses any hop that leaves the origin, with a `blocked`
   * error.
   */
  urlCredential?: boolean
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: Uint8Array
  /** Final URL, after redirects. */
  url: string
}

/** Used for both the `http` and the `api` transport (the latter adds auth headers from a `SecretsPort`). */
export interface HttpTransport {
  request(request: HttpRequest): Promise<HttpResponse>
}

/** Handle of a page the browser transport opened. Only pages it opened are ever touched. */
export interface BrowserPage {
  id: string
  url?: string
}

export interface BrowserWaitOptions {
  /** CSS selector to wait for. */
  selector?: string
  /** Script that returns true when the page is ready. */
  predicate?: string
  timeoutMs?: number
}

export interface BrowserScrollOptions {
  /** Number of scroll steps. */
  steps?: number
  pixels?: number
}

export interface BrowserTransport {
  /** Open a new background page on `url`. */
  open(url: string): Promise<BrowserPage>
  /** Run a script in the page and return its JSON-serialisable result. */
  evaluate<T = unknown>(page: BrowserPage, script: string): Promise<T>
  /** Same-origin fetch from inside the page. */
  fetchInPage(page: BrowserPage, request: HttpRequest): Promise<HttpResponse>
  scroll(page: BrowserPage, options?: BrowserScrollOptions): Promise<void>
  waitFor(page: BrowserPage, options: BrowserWaitOptions): Promise<void>
  close(page: BrowserPage): Promise<void>
}

/** Where secrets come from. The engine never logs or stores a secret value. */
export interface SecretsPort {
  get(name: string): Promise<string | undefined>
}

/** The transports a collector can use, by name. A missing entry means that transport is not available. */
export interface TransportSet {
  api?: HttpTransport
  http?: HttpTransport
  browser?: BrowserTransport
}

/** What a connector's `fetch` receives: the chosen transport, with its name. */
export type FetchTransport =
  | { name: "api" | "http"; http: HttpTransport }
  | { name: "browser"; browser: BrowserTransport }
