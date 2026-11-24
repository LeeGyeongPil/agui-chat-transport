import { HttpAgent, type AbstractAgent } from '@ag-ui/client';
import type { BaseEvent } from '@ag-ui/core';
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { createAgUiChunkConverter } from './events-to-chunks.js';
import { AgUiTransportConfigError } from './errors.js';
import { lastAguiState, uiMessagesToRunAgentInput } from './messages-to-input.js';
import type { AgUiChatTransportOptions } from './types.js';

type SendOptions = Parameters<ChatTransport<UIMessage>['sendMessages']>[0];

function headersToRecord(h: Record<string, string> | Headers | undefined): Record<string, string> {
  if (!h) return {};
  if (typeof Headers !== 'undefined' && h instanceof Headers) return Object.fromEntries(h.entries());
  return { ...(h as Record<string, string>) };
}

interface HeaderLeases {
  base: Record<string, string>;
  layers: Array<Record<string, string>>;
}
const headerLeases = new WeakMap<object, HeaderLeases>();

/**
 * Apply per-request headers to a shared agent for one run. Overlapping runs keep their own layer;
 * when a run ends only its layer is removed, and the original headers return after the last one.
 */
function applyRunHeaders(target: HttpAgent, headers: Record<string, string>): () => void {
  let lease = headerLeases.get(target);
  if (!lease) {
    lease = { base: target.headers, layers: [] };
    headerLeases.set(target, lease);
  }
  const current = lease;
  current.layers.push(headers);
  target.headers = Object.assign({}, current.base, ...current.layers);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    current.layers.splice(current.layers.indexOf(headers), 1);
    if (current.layers.length === 0) {
      target.headers = current.base;
      headerLeases.delete(target);
    } else {
      target.headers = Object.assign({}, current.base, ...current.layers);
    }
  };
}

/**
 * AI SDK `ChatTransport` that talks to an AG-UI agent server.
 *
 * ```ts
 * const { messages } = useChat({ transport: new AgUiChatTransport({ url }) });
 * ```
 */
export class AgUiChatTransport<UI_MESSAGE extends UIMessage = UIMessage> implements ChatTransport<UI_MESSAGE> {
  private readonly options: AgUiChatTransportOptions;

  constructor(options: AgUiChatTransportOptions) {
    if (!options || (!options.url && !options.agent)) {
      throw new AgUiTransportConfigError(
        'AgUiChatTransport needs `url` (the AG-UI endpoint) or `agent` (an HttpAgent / AbstractAgent). Example: new AgUiChatTransport({ url: "http://localhost:8000/agent" }).',
      );
    }
    if (options.url && options.agent) {
      throw new AgUiTransportConfigError('Pass either `url` or `agent` to AgUiChatTransport, not both.');
    }
    this.options = options;
  }

  async sendMessages(opts: SendOptions & { messages: UI_MESSAGE[] }): Promise<ReadableStream<UIMessageChunk>> {
    const o = this.options;
    const generateId = o.generateId ?? (() => crypto.randomUUID());
    const threadId = (o.threadId ?? ((id: string) => id))(opts.chatId);
    const state = o.stateFromMessages ? o.stateFromMessages(opts.messages) : lastAguiState(opts.messages);

    const input = uiMessagesToRunAgentInput(opts.messages, {
      threadId,
      runId: generateId(),
      tools: o.tools,
      context: o.context,
      state,
      forwardedProps: opts.body ?? {},
    });

    // A run that continues the last assistant message (browser tool result) must write to the same id.
    const last = opts.messages.at(-1);
    const converter = createAgUiChunkConverter({
      generateId,
      ...(last?.role === 'assistant' ? { messageId: last.id } : {}),
      onUnmapped: o.onUnmapped,
      emitUnmapped: o.emitUnmapped,
      passthrough: o.passthrough,
      clientToolNames: o.tools?.map((t) => t.name),
      initialState: state,
    });

    let agent: AbstractAgent;
    let restoreHeaders: (() => void) | undefined;
    let events$: ReturnType<AbstractAgent['run']>;
    try {
      const configured = typeof o.headers === 'function' ? await o.headers() : o.headers;
      const headers = { ...headersToRecord(configured), ...headersToRecord(opts.headers) };
      agent = o.url
        ? new HttpAgent({ url: o.url, headers, threadId })
        : typeof o.agent === 'function'
          ? o.agent()
          : o.agent!;
      if (!o.url && Object.keys(headers).length && 'headers' in agent) {
        // Per-request headers are applied for this run only and restored afterwards.
        restoreHeaders = applyRunHeaders(agent as HttpAgent, headers);
      }
      events$ = agent.run(input);
    } catch (err) {
      return singleErrorStream(err);
    }

    let subscription: { unsubscribe(): void } | undefined;
    let closed = false;
    const stop = (): void => {
      restoreHeaders?.();
      subscription?.unsubscribe();
      try {
        agent.abortRun();
      } catch {
        // Custom agents may not support aborting; unsubscribing is enough for them.
      }
    };

    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        const emit = (chunks: UIMessageChunk[]): void => {
          if (closed) return;
          for (const c of chunks) controller.enqueue(c);
        };
        // eslint-disable-next-line prefer-const
        let onAbort: () => void = () => undefined;
        const end = (): void => {
          if (closed) return;
          closed = true;
          restoreHeaders?.();
          opts.abortSignal?.removeEventListener('abort', onAbort);
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
        onAbort = (): void => {
          if (closed) return;
          stop();
          emit(converter.finish());
          end();
        };

        if (opts.abortSignal?.aborted) {
          // Never contacted the server.
          end();
          return;
        }
        subscription = events$.subscribe({
          next(event: BaseEvent) {
            try {
              emit(converter.push(event));
            } catch (err) {
              emit(converter.fail(err instanceof Error ? err.message : String(err)));
              stop();
              end();
            }
          },
          error(err: unknown) {
            emit(converter.fail(describeError(err, o.url ?? (agent as { url?: string }).url)));
            end();
          },
          complete() {
            emit(converter.finish());
            end();
          },
        });
        opts.abortSignal?.addEventListener('abort', onAbort, { once: true });
      },
      cancel() {
        closed = true;
        stop();
      },
    });
  }

  /** AG-UI has no standard way to re-attach to a running stream. */
  async reconnectToStream(): Promise<null> {
    return null;
  }
}

/** Add the URL and a fix hint to network-level failures (server down, wrong URL, CORS). */
function describeError(err: unknown, url: string | undefined): string {
  const message = err instanceof Error ? err.message : String(err);
  const networkLevel =
    err instanceof TypeError || /fetch failed|failed to fetch|networkerror|load failed|econnrefused/i.test(message);
  if (!networkLevel) return message;
  return `Could not reach the AG-UI server${url ? ` at ${url}` : ''} (${message}). Is the agent server running and is the url correct? In a browser, CORS must also allow this origin.`;
}

function singleErrorStream(err: unknown): ReadableStream<UIMessageChunk> {
  const errorText = err instanceof Error ? err.message : String(err);
  const converter = createAgUiChunkConverter();
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const c of converter.fail(errorText)) controller.enqueue(c);
      controller.close();
    },
  });
}
