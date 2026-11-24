import { EventType, type BaseEvent } from '@ag-ui/core';
import type { UIMessageChunk } from 'ai';
import { StateTracker } from './state.js';
import { passthroughKind, type UnmappedReason, type UnmappedReport } from './report.js';
import type { ConverterOptions } from './types.js';

/** Loosely typed view of an AG-UI event; the protocol package validates shapes upstream. */
type Ev = BaseEvent & Record<string, any>;

export const STATE_PART_ID = 'agui-state';
export const INTERRUPT_PART_ID = 'agui-interrupt';

export interface AgUiChunkConverter {
  /** Convert one event into zero or more UIMessage chunks. */
  push(event: BaseEvent): UIMessageChunk[];
  /** Flush at end of stream: close open parts and finish the message if the run did not. */
  finish(): UIMessageChunk[];
  /** Close open parts and emit an `error` chunk (used for transport failures). */
  fail(errorText: string): UIMessageChunk[];
}

type Meta = Record<string, Record<string, any>>;

/**
 * Create a stateful converter from AG-UI events to AI SDK UIMessage chunks.
 * It is framework independent: use it directly on the server or inside a stream.
 */
export function createAgUiChunkConverter(options: ConverterOptions = {}): AgUiChunkConverter {
  const generateId = options.generateId ?? (() => crypto.randomUUID());
  const passthrough = new Set<string>(options.passthrough ?? []);
  const clientTools = options.clientToolNames ? new Set(options.clientToolNames) : undefined;
  const tracker = new StateTracker(options.initialState);

  let started = false;
  let finished = false;
  const openText = new Set<string>();
  const openReasoning = new Set<string>();
  const tools = new Map<
    string,
    { name: string; args: string; parentMessageId?: string; ended: boolean; providerExecuted?: boolean }
  >();
  // Which kind of *_CHUNK event is currently expanded into START/CONTENT/END.
  let chunkText: string | undefined;
  let chunkReasoning: string | undefined;
  let chunkTool: string | undefined;

  const report = (
    out: UIMessageChunk[],
    event: Ev,
    reason: UnmappedReason,
    detail?: string,
  ): void => {
    const r: UnmappedReport = { eventType: String(event.type), reason, event, ...(detail ? { detail } : {}) };
    try {
      options.onUnmapped?.(r);
    } catch {
      // A throwing user callback must not break the stream.
    }
    if (options.emitUnmapped) {
      out.push({ type: 'data-agui-unmapped', data: r, transient: true } as UIMessageChunk);
    }
  };

  const ensureStarted = (out: UIMessageChunk[], event?: Ev): void => {
    if (started) return;
    started = true;
    const metadata = event && event.type === EventType.RUN_STARTED ? { runId: event.runId, threadId: event.threadId } : undefined;
    out.push({ type: 'start', messageId: options.messageId ?? generateId(), ...(metadata ? { messageMetadata: metadata } : {}) });
    out.push({ type: 'start-step' });
  };

  const meta = (agui: Record<string, any>): { providerMetadata: Meta } => ({ providerMetadata: { agui } });

  const closeText = (out: UIMessageChunk[], id: string): void => {
    if (openText.delete(id)) out.push({ type: 'text-end', id });
  };
  const closeReasoning = (out: UIMessageChunk[], id: string): void => {
    if (openReasoning.delete(id)) out.push({ type: 'reasoning-end', id });
  };
  const toolProviderExecuted = (name: string, known?: boolean): boolean | undefined => {
    if (known) return true;
    if (clientTools) return clientTools.has(name) ? undefined : true;
    return undefined;
  };
  const endTool = (out: UIMessageChunk[], id: string, event: Ev): void => {
    const t = tools.get(id);
    if (!t || t.ended) return;
    t.ended = true;
    const raw = t.args.trim() === '' ? '{}' : t.args;
    const providerExecuted = toolProviderExecuted(t.name, t.providerExecuted);
    const common = {
      toolCallId: id,
      toolName: t.name,
      dynamic: true as const,
      ...(providerExecuted ? { providerExecuted } : {}),
      ...meta({ ...(t.parentMessageId ? { parentMessageId: t.parentMessageId } : {}) }),
    };
    try {
      out.push({ type: 'tool-input-available', ...common, input: JSON.parse(raw) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      out.push({ type: 'tool-input-error', ...common, input: raw, errorText: `Invalid tool arguments JSON: ${msg}` });
      report(out, event, 'invalid-tool-args', `tool ${t.name} (${id}): ${msg}`);
    }
  };

  const closeChunkModes = (out: UIMessageChunk[], keep?: 'text' | 'reasoning' | 'tool', event?: Ev): void => {
    if (keep !== 'text' && chunkText) {
      closeText(out, chunkText);
      chunkText = undefined;
    }
    if (keep !== 'reasoning' && chunkReasoning) {
      closeReasoning(out, chunkReasoning);
      chunkReasoning = undefined;
    }
    if (keep !== 'tool' && chunkTool) {
      endTool(out, chunkTool, event ?? ({ type: EventType.TOOL_CALL_END } as Ev));
      chunkTool = undefined;
    }
  };

  const closeAll = (out: UIMessageChunk[], event: Ev): void => {
    closeChunkModes(out, undefined, event);
    // A tool call that never got TOOL_CALL_END is closed and reported, not left half open.
    for (const [id, t] of tools) {
      if (t.ended) continue;
      report(out, event, 'orphan-event', `tool call ${t.name} (${id}) never received TOOL_CALL_END; closed at end of run`);
      endTool(out, id, event);
    }
    for (const id of [...openText]) closeText(out, id);
    for (const id of [...openReasoning]) closeReasoning(out, id);
  };

  const statePart = (out: UIMessageChunk[]): void => {
    out.push({ type: 'data-agui-state', id: STATE_PART_ID, data: tracker.state } as UIMessageChunk);
  };

  const passOrReport = (out: UIMessageChunk[], event: Ev): void => {
    if (passthrough.has(String(event.type))) {
      out.push({ type: `data-agui-${passthroughKind(String(event.type))}`, data: event } as UIMessageChunk);
      return;
    }
    report(out, event, 'no-mapping');
  };

  const openTextPart = (out: UIMessageChunk[], id: string, role?: string): void => {
    if (openText.has(id)) return;
    openText.add(id);
    out.push({ type: 'text-start', id, ...meta({ messageId: id, ...(role ? { role } : {}) }) });
  };
  const openReasoningPart = (out: UIMessageChunk[], id: string): void => {
    if (openReasoning.has(id)) return;
    openReasoning.add(id);
    out.push({ type: 'reasoning-start', id, ...meta({ messageId: id }) });
  };
  const startTool = (out: UIMessageChunk[], id: string, name: string, parent?: string): void => {
    if (tools.has(id)) return;
    tools.set(id, { name, args: '', parentMessageId: parent, ended: false });
    const providerExecuted = toolProviderExecuted(name);
    out.push({
      type: 'tool-input-start',
      toolCallId: id,
      toolName: name,
      dynamic: true,
      ...(providerExecuted ? { providerExecuted } : {}),
      ...meta({ ...(parent ? { parentMessageId: parent } : {}) }),
    });
  };

  const push = (raw: BaseEvent): UIMessageChunk[] => {
    const event = raw as Ev;
    const out: UIMessageChunk[] = [];
    const type = event.type as EventType;

    // Nothing may follow the terminal chunk (`finish` or `error`).
    if (finished) {
      report([], event, 'orphan-event', 'event arrived after the terminal event (finish or error); ignored');
      return out;
    }

    // Leaving a *_CHUNK sequence closes what the chunks opened.
    if (type !== EventType.TEXT_MESSAGE_CHUNK && type !== EventType.REASONING_MESSAGE_CHUNK && type !== EventType.TOOL_CALL_CHUNK) {
      closeChunkModes(out, undefined, event);
    }

    switch (type) {
      case EventType.RUN_STARTED:
        ensureStarted(out, event);
        break;

      case EventType.RUN_FINISHED: {
        ensureStarted(out, event);
        closeAll(out, event);
        const outcome = event.outcome as { type?: string; interrupts?: unknown[] } | undefined;
        if (outcome?.type === 'interrupt') {
          out.push({
            type: 'data-agui-interrupt',
            id: INTERRUPT_PART_ID,
            data: { outcome: 'interrupt', interrupts: outcome.interrupts ?? [] },
          } as UIMessageChunk);
        }
        out.push({ type: 'finish-step' });
        out.push({ type: 'finish', finishReason: outcome?.type === 'cancelled' ? 'other' : 'stop' });
        finished = true;
        break;
      }

      case EventType.RUN_ERROR:
        out.push(...failInternal(String(event.message ?? 'Agent run failed'), event));
        break;

      case EventType.STEP_STARTED:
      case EventType.STEP_FINISHED:
        ensureStarted(out);
        out.push({
          type: 'data-agui-step',
          data: { name: event.stepName, status: type === EventType.STEP_STARTED ? 'started' : 'finished' },
          transient: true,
        } as UIMessageChunk);
        break;

      case EventType.TEXT_MESSAGE_START:
        ensureStarted(out);
        openTextPart(out, String(event.messageId), event.role);
        break;
      case EventType.TEXT_MESSAGE_CONTENT: {
        ensureStarted(out);
        const id = String(event.messageId);
        if (!openText.has(id)) {
          report(out, event, 'orphan-event', 'TEXT_MESSAGE_CONTENT without TEXT_MESSAGE_START; started the message implicitly');
          openTextPart(out, id);
        }
        if (event.delta) out.push({ type: 'text-delta', id, delta: String(event.delta) });
        break;
      }
      case EventType.TEXT_MESSAGE_END: {
        const id = String(event.messageId);
        if (!openText.has(id)) report(out, event, 'orphan-event', 'TEXT_MESSAGE_END for a message that is not open');
        closeText(out, id);
        break;
      }
      case EventType.TEXT_MESSAGE_CHUNK: {
        ensureStarted(out);
        closeChunkModes(out, 'text', event);
        const id = String(event.messageId ?? chunkText ?? generateId());
        if (chunkText && chunkText !== id) closeText(out, chunkText);
        chunkText = id;
        openTextPart(out, id, event.role);
        if (event.delta) out.push({ type: 'text-delta', id, delta: String(event.delta) });
        break;
      }

      case EventType.REASONING_START:
      case EventType.REASONING_END:
        // Containers only; the reasoning text travels in the MESSAGE_* events.
        ensureStarted(out);
        break;
      case EventType.REASONING_MESSAGE_START:
        ensureStarted(out);
        openReasoningPart(out, String(event.messageId));
        break;
      case EventType.REASONING_MESSAGE_CONTENT: {
        ensureStarted(out);
        const id = String(event.messageId);
        if (!openReasoning.has(id)) {
          report(out, event, 'orphan-event', 'REASONING_MESSAGE_CONTENT without REASONING_MESSAGE_START; started implicitly');
          openReasoningPart(out, id);
        }
        if (event.delta) out.push({ type: 'reasoning-delta', id, delta: String(event.delta) });
        break;
      }
      case EventType.REASONING_MESSAGE_END: {
        const id = String(event.messageId);
        if (!openReasoning.has(id)) report(out, event, 'orphan-event', 'REASONING_MESSAGE_END for a message that is not open');
        closeReasoning(out, id);
        break;
      }
      case EventType.REASONING_MESSAGE_CHUNK: {
        ensureStarted(out);
        closeChunkModes(out, 'reasoning', event);
        const id = String(event.messageId ?? chunkReasoning ?? generateId());
        if (chunkReasoning && chunkReasoning !== id) closeReasoning(out, chunkReasoning);
        chunkReasoning = id;
        openReasoningPart(out, id);
        if (event.delta) out.push({ type: 'reasoning-delta', id, delta: String(event.delta) });
        break;
      }

      case EventType.TOOL_CALL_START:
        ensureStarted(out);
        startTool(out, String(event.toolCallId), String(event.toolCallName), event.parentMessageId);
        break;
      case EventType.TOOL_CALL_ARGS: {
        const id = String(event.toolCallId);
        const t = tools.get(id);
        if (!t) {
          report(out, event, 'orphan-event', 'TOOL_CALL_ARGS for an unknown tool call');
          break;
        }
        const delta = String(event.delta ?? '');
        t.args += delta;
        if (delta) out.push({ type: 'tool-input-delta', toolCallId: id, inputTextDelta: delta });
        break;
      }
      case EventType.TOOL_CALL_END: {
        const id = String(event.toolCallId);
        if (!tools.has(id)) {
          report(out, event, 'orphan-event', 'TOOL_CALL_END for an unknown tool call');
          break;
        }
        endTool(out, id, event);
        break;
      }
      case EventType.TOOL_CALL_CHUNK: {
        ensureStarted(out);
        closeChunkModes(out, 'tool', event);
        const id = String(event.toolCallId ?? chunkTool ?? '');
        if (!id) {
          report(out, event, 'orphan-event', 'TOOL_CALL_CHUNK without a toolCallId');
          break;
        }
        if (chunkTool && chunkTool !== id) endTool(out, chunkTool, event);
        chunkTool = id;
        if (!tools.has(id)) {
          if (!event.toolCallName) {
            report(out, event, 'orphan-event', 'First TOOL_CALL_CHUNK of a call must carry toolCallName');
            break;
          }
          startTool(out, id, String(event.toolCallName), event.parentMessageId);
        }
        const delta = String(event.delta ?? '');
        if (delta) {
          tools.get(id)!.args += delta;
          out.push({ type: 'tool-input-delta', toolCallId: id, inputTextDelta: delta });
        }
        break;
      }
      case EventType.TOOL_CALL_RESULT: {
        const id = String(event.toolCallId);
        const t = tools.get(id);
        if (!t) {
          report(out, event, 'orphan-event', 'TOOL_CALL_RESULT for an unknown tool call');
          break;
        }
        // A result from the server means the server ran this tool.
        t.providerExecuted = true;
        if (!t.ended) endTool(out, id, event);
        const content = event.content;
        let output: unknown = content;
        if (typeof content === 'string') {
          try {
            output = JSON.parse(content);
          } catch {
            output = content;
          }
        }
        out.push({
          type: 'tool-output-available',
          toolCallId: id,
          output,
          providerExecuted: true,
          dynamic: true,
          ...(event.messageId ? meta({ resultMessageId: event.messageId }) : {}),
        });
        break;
      }

      case EventType.STATE_SNAPSHOT:
        ensureStarted(out);
        tracker.snapshot(event.snapshot);
        statePart(out);
        break;
      case EventType.STATE_DELTA: {
        ensureStarted(out);
        const result = tracker.delta(event.delta);
        if (result.ok) statePart(out);
        else report(out, event, 'patch-failed', result.error);
        break;
      }

      default:
        // MESSAGES_SNAPSHOT, ACTIVITY_*, SUBAGENT_*, RAW, CUSTOM, REASONING_ENCRYPTED_VALUE and
        // anything a newer protocol version adds: pass through or report, never drop silently.
        ensureStarted(out);
        passOrReport(out, event);
        break;
    }
    return out;
  };

  const failInternal = (errorText: string, event?: Ev): UIMessageChunk[] => {
    const out: UIMessageChunk[] = [];
    if (finished) return out;
    ensureStarted(out);
    closeAll(out, event ?? ({ type: EventType.RUN_ERROR } as Ev));
    out.push({ type: 'error', errorText });
    finished = true;
    return out;
  };

  return {
    push,
    fail: (errorText) => failInternal(errorText),
    finish(): UIMessageChunk[] {
      const out: UIMessageChunk[] = [];
      if (finished) return out;
      ensureStarted(out);
      closeAll(out, { type: EventType.RUN_FINISHED } as Ev);
      out.push({ type: 'finish-step' });
      out.push({ type: 'finish', finishReason: 'stop' });
      finished = true;
      return out;
    },
  };
}

/** Stream form of {@link createAgUiChunkConverter}: events in, UIMessage chunks out. */
export function aguiEventsToUIMessageChunks(options: ConverterOptions = {}): TransformStream<BaseEvent, UIMessageChunk> {
  const converter = createAgUiChunkConverter(options);
  return new TransformStream<BaseEvent, UIMessageChunk>({
    transform(event, controller) {
      for (const chunk of converter.push(event)) controller.enqueue(chunk);
    },
    flush(controller) {
      for (const chunk of converter.finish()) controller.enqueue(chunk);
    },
  });
}
