import type { AbstractAgent } from '@ag-ui/client';
import type { BaseEvent, Context, EventType, Tool } from '@ag-ui/core';
import type { UIMessage } from 'ai';
import type { UnmappedReport } from './report.js';

/** Options shared by the stand-alone converter and the transport. */
export interface ConverterOptions {
  /** Id generator for the assistant message id and synthesized ids. Default `crypto.randomUUID`. */
  generateId?: () => string;
  /**
   * Id for the assistant message the stream writes to. Set it to the id of the last
   * assistant message when the run continues that message (for example after a browser
   * tool result), so the AI SDK appends to it instead of creating a second message.
   * Default: a generated id.
   */
  messageId?: string;
  /** Called once for every event that could not be fully represented. */
  onUnmapped?: (report: UnmappedReport) => void;
  /** Also emit a transient `data-agui-unmapped` chunk for each report. Default false. */
  emitUnmapped?: boolean;
  /** Event types to pass through as `data-agui-<kind>` parts instead of reporting them. */
  passthrough?: Array<EventType | `${EventType}`>;
  /**
   * Names of tools the browser executes. When given, tool calls with any other
   * name are marked `providerExecuted` (the server runs them). When omitted a
   * call is marked `providerExecuted` only once a `TOOL_CALL_RESULT` arrives.
   */
  clientToolNames?: string[];
  /** State to apply `STATE_DELTA` patches on before the first snapshot arrives. */
  initialState?: unknown;
}

export interface AgUiChatTransportOptions
  extends Omit<ConverterOptions, 'clientToolNames' | 'initialState' | 'messageId'> {
  /** URL of the AG-UI agent endpoint. Provide `url` or `agent`, not both. */
  url?: string;
  /** Your own `HttpAgent` or any `AbstractAgent`, or a factory returning one per request. */
  agent?: AbstractAgent | (() => AbstractAgent);
  /** Static or lazily resolved request headers (for example an auth token). */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /** Tools the browser executes (AG-UI tool definitions with JSON Schema parameters). */
  tools?: Tool[];
  /** Extra context entries sent with every run. */
  context?: Context[];
  /** Maps the useChat chat id to an AG-UI thread id. Default: the chat id itself. */
  threadId?: (chatId: string) => string;
  /** Derive the shared state sent with the next run. Default: the last `data-agui-state` part. */
  stateFromMessages?: (messages: UIMessage[]) => unknown;
}

/** Data parts produced by the converter, for typing `UIMessage<…, AgUiDataParts>`. */
export interface AgUiDataParts {
  [key: string]: unknown;
  'agui-state': unknown;
  'agui-interrupt': { outcome: 'interrupt'; interrupts: unknown[] };
  'agui-unmapped': UnmappedReport;
  'agui-step': { name: string; status: 'started' | 'finished' };
  'agui-custom': BaseEvent;
}
