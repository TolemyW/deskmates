// Everything `runOnce` touches outside its own process is injected through `SidecarDeps`, so a
// T1 test substitutes the fake SDK from @deskmates/testkit and an in-memory Gateway. The production
// wiring is `real-deps.ts`, the only module that imports the SDK's runtime.

import type {
  Options,
  SDKMessage,
  SDKUserMessage,
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * `query()` as the sidecar uses it: a string prompt (or, for a model job that carries an image,
 * a stream of user messages), full options, an iterable of messages. The real `Query` also
 * answers `getContextUsage`, which the run samples when it is there (`context-usage.ts`).
 */
export type QueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncIterable<SDKMessage> & import("./context-usage.js").ContextUsageSource;

export type ToolFn = typeof tool;

export type CreateSdkMcpServerFn = typeof createSdkMcpServer;

/**
 * The few filesystem operations context assembly, the diary and the screenshot directory need.
 * Paths are absolute.
 */
export interface SidecarFs {
  /** Rejects when the file does not exist. */
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /** Creates parent directories as needed. */
  appendFile(path: string, text: string): Promise<void>;
  /** Replace a file's contents, creating parent directories as needed. */
  writeFile(path: string, text: string): Promise<void>;
  /** Creates the directory and its parents; succeeds when it already exists. */
  mkdir(path: string): Promise<void>;
  /** Removes a directory and everything under it; succeeds when it is not there. */
  rm(path: string): Promise<void>;
}

export interface SidecarDeps {
  saveToolEvidence?: import("./tool-evidence.js").SaveToolEvidence;
  spawnPty?: import("./tty-session.js").PtyFactory;
  observeResources?: () => Promise<import("./resource-observation.js").ResourceObservation>;
  /** Files for the look/OCR and speech tools (ADR-0040); absent means the container itself. */
  operationFiles?: import("./operation-input.js").OperationFiles;
  query: QueryFn;
  tool: ToolFn;
  createSdkMcpServer: CreateSdkMcpServerFn;
  fetch: typeof globalThis.fetch;
  fs: SidecarFs;
  now: () => Date;
  /** Seconds since this OS process started (`process.uptime`); absent in tests that do not care. */
  uptimeSeconds?: () => number;
  /** Process environment as seen by the sidecar; forwarded to the SDK subprocess with overrides. */
  env: Readonly<Record<string, string | undefined>>;
  sleep: (ms: number) => Promise<void>;
}
