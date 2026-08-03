/**
 * @agentproto/corpus-cli/ports — local-topology port implementations.
 *
 * Concrete adapters that satisfy @agentproto/corpus's port interfaces
 * for a single-user, single-machine deployment. Cloud topology
 * (Guilde apps/api/services/corpus-host) ships its own adapters.
 */

export { NodeFsAdapter } from "./local-fs.adapter.js"
export type { NodeFsAdapterOptions } from "./local-fs.adapter.js"

export { OsIdentityAdapter } from "./os-identity.adapter.js"
export type { OsIdentityAdapterOptions } from "./os-identity.adapter.js"

export { BrowserMcpFetcher } from "./browser-fetcher.adapter.js"
export type {
  BrowserMcpLike,
  BrowserMcpFetcherOptions,
} from "./browser-fetcher.adapter.js"

export { ScrapeMcpFetcher } from "./scrape-mcp-fetcher.adapter.js"
export type { ScrapeMcpFetcherOptions } from "./scrape-mcp-fetcher.adapter.js"

export { YtDlpWhisperFetcher } from "./ytdlp-whisper-fetcher.adapter.js"
export type {
  YtDlpWhisperFetcherOptions,
  AudioDownload,
  AudioDownloader,
} from "./ytdlp-whisper-fetcher.adapter.js"

export { OpenAiWhisperStt } from "./stt.port.js"
export type { SttPort, Transcript, OpenAiWhisperSttOptions } from "./stt.port.js"

export { AssemblyAiStt } from "./assemblyai-stt.adapter.js"
export type { AssemblyAiSttOptions } from "./assemblyai-stt.adapter.js"

export { ChunkedStt } from "./chunked-stt.adapter.js"
export type { ChunkedSttOptions, AudioSplitter } from "./chunked-stt.adapter.js"

export { CompositeFetcher } from "./composite-fetcher.js"

export { ThrottleFetcher } from "./throttle-fetcher.adapter.js"
export type { ThrottleFetcherOptions } from "./throttle-fetcher.adapter.js"

export { HttpReadabilityFetcher } from "./http-readability-fetcher.adapter.js"
export type { HttpReadabilityFetcherOptions } from "./http-readability-fetcher.adapter.js"

export { PdfFetcher } from "./pdf-fetcher.adapter.js"
export type {
  PdfFetcherOptions,
  PdfExtractor,
  PdfExtraction,
} from "./pdf-fetcher.adapter.js"

export { GhPrSourceAdapter } from "./gh-pr-source.adapter.js"
export type { GhPrSourceAdapterOptions, GhRunner } from "./gh-pr-source.adapter.js"

export { AnthropicDistiller } from "./anthropic-distiller.js"
export type { AnthropicDistillerOptions } from "./anthropic-distiller.js"

export { CliAgentDistiller } from "./cli-agent-distiller.js"
export type { CliAgentDistillerOptions } from "./cli-agent-distiller.js"

export { CLI_ENGINES } from "./cli-engines.js"
export type { CliEngine } from "./cli-engines.js"

export { buildDistillPrompt, parseItems } from "./distill-prompt.js"

export { connectMcpHttp } from "./mcp-http-client.js"
export type { McpClientLike, ConnectMcpHttpOptions } from "./mcp-http-client.js"
export { McpSink } from "./mcp-sink.adapter.js"
export type { McpSinkConfig } from "./mcp-sink.adapter.js"
