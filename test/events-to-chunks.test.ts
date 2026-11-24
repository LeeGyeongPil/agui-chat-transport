import { describe, expect, it } from 'vitest';
import { EventType, type BaseEvent } from '@ag-ui/core';
import type { UIMessageChunk } from 'ai';
import { aguiEventsToUIMessageChunks, createAgUiChunkConverter, type UnmappedReport } from '../src/index.js';
import { collect, validateChunks } from './helpers.js';

const E = (e: Record<string, unknown>) => e as unknown as BaseEvent;

function run(events: BaseEvent[], opts = {}): { chunks: UIMessageChunk[]; reports: UnmappedReport[] } {
  const reports: UnmappedReport[] = [];
  const c = createAgUiChunkConverter({ generateId: () => 'gen-id', onUnmapped: (r) => reports.push(r), ...opts });
  const chunks = [...events.flatMap((e) => c.push(e)), ...c.finish()];
  return { chunks, reports };
}

const streamOf = (chunks: UIMessageChunk[]) =>
  new ReadableStream<UIMessageChunk>({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(c);
      ctrl.close();
    },
  });

async function partsOf(events: BaseEvent[], opts = {}) {
  const { chunks } = run(events, opts);
  const { message, schemaFailures } = await collect(streamOf(chunks));
  expect(schemaFailures).toEqual([]);
  return (message!.parts as Array<Record<string, any>>).map(({ providerMetadata: _p, callProviderMetadata: _c, ...rest }) => rest);
}

const started = E({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' });
const finished = E({ type: EventType.RUN_FINISHED, threadId: 't', runId: 'r' });

describe('AC-5 chunk expansion', () => {
  it('*_CHUNK events build the same parts as START/CONTENT/END', async () => {
    const expanded = [
      started,
      E({ type: EventType.REASONING_MESSAGE_START, messageId: 'r1', role: 'reasoning' }),
      E({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'r1', delta: 'thinking' }),
      E({ type: EventType.REASONING_MESSAGE_END, messageId: 'r1' }),
      E({ type: EventType.TEXT_MESSAGE_START, messageId: 'm1', role: 'assistant' }),
      E({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'Hel' }),
      E({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'lo' }),
      E({ type: EventType.TEXT_MESSAGE_END, messageId: 'm1' }),
      E({ type: EventType.TOOL_CALL_START, toolCallId: 't1', toolCallName: 'getWeather', parentMessageId: 'm1' }),
      E({ type: EventType.TOOL_CALL_ARGS, toolCallId: 't1', delta: '{"city":' }),
      E({ type: EventType.TOOL_CALL_ARGS, toolCallId: 't1', delta: '"Busan"}' }),
      E({ type: EventType.TOOL_CALL_END, toolCallId: 't1' }),
      finished,
    ];
    const chunked = [
      started,
      E({ type: EventType.REASONING_MESSAGE_CHUNK, messageId: 'r1', delta: 'thinking' }),
      E({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'm1', role: 'assistant', delta: 'Hel' }),
      E({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'm1', delta: 'lo' }),
      E({ type: EventType.TOOL_CALL_CHUNK, toolCallId: 't1', toolCallName: 'getWeather', parentMessageId: 'm1', delta: '{"city":' }),
      E({ type: EventType.TOOL_CALL_CHUNK, toolCallId: 't1', delta: '"Busan"}' }),
      finished,
    ];
    const a = await partsOf(expanded);
    const b = await partsOf(chunked);
    expect(b).toEqual(a);
    expect(b.map((p) => p.type)).toEqual(['step-start', 'reasoning', 'text', 'dynamic-tool']);
    expect(b[2]!.text).toBe('Hello');
    expect(b[3]).toMatchObject({ toolName: 'getWeather', input: { city: 'Busan' }, state: 'input-available' });
  });

  it('a chunk with a new messageId closes the previous text part', () => {
    const { chunks } = run([
      started,
      E({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'a', delta: '1' }),
      E({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'b', delta: '2' }),
      finished,
    ]);
    expect(chunks.filter((c) => c.type === 'text-end').map((c) => (c as { id: string }).id)).toEqual(['a', 'b']);
  });
});

describe('AC-5 tool handling', () => {
  it('broken argument JSON becomes tool-input-error plus an invalid-tool-args report', async () => {
    const events = [
      started,
      E({ type: EventType.TOOL_CALL_START, toolCallId: 't1', toolCallName: 'x' }),
      E({ type: EventType.TOOL_CALL_ARGS, toolCallId: 't1', delta: '{"city":' }),
      E({ type: EventType.TOOL_CALL_END, toolCallId: 't1' }),
      finished,
    ];
    const { chunks, reports } = run(events);
    expect(chunks.some((c) => c.type === 'tool-input-error')).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ eventType: 'TOOL_CALL_END', reason: 'invalid-tool-args' });
    expect(await validateChunks(chunks)).toEqual([]);
  });

  it('TOOL_CALL_RESULT becomes tool-output-available (JSON parsed) and marks the tool providerExecuted', async () => {
    const events = [
      started,
      E({ type: EventType.TOOL_CALL_START, toolCallId: 't1', toolCallName: 'search' }),
      E({ type: EventType.TOOL_CALL_ARGS, toolCallId: 't1', delta: '{"q":"a"}' }),
      E({ type: EventType.TOOL_CALL_END, toolCallId: 't1' }),
      E({ type: EventType.TOOL_CALL_RESULT, messageId: 'tm', toolCallId: 't1', content: '{"hits":2}' }),
      E({ type: EventType.TOOL_CALL_START, toolCallId: 't2', toolCallName: 'plain' }),
      E({ type: EventType.TOOL_CALL_END, toolCallId: 't2' }),
      E({ type: EventType.TOOL_CALL_RESULT, messageId: 'tm2', toolCallId: 't2', content: 'just text' }),
      finished,
    ];
    const { chunks } = run(events);
    const outs = chunks.filter((c) => c.type === 'tool-output-available') as Array<{ output: unknown; providerExecuted?: boolean }>;
    expect(outs.map((o) => o.output)).toEqual([{ hits: 2 }, 'just text']);
    expect(outs.every((o) => o.providerExecuted === true)).toBe(true);
    const parts = await partsOf(events);
    expect(parts.filter((p) => p.type === 'dynamic-tool').map((p) => [p.state, p.providerExecuted])).toEqual([
      ['output-available', true],
      ['output-available', true],
    ]);
  });

  it('clientToolNames marks every other tool as server executed from the start', () => {
    const { chunks } = run(
      [
        started,
        E({ type: EventType.TOOL_CALL_START, toolCallId: 'a', toolCallName: 'browserTool' }),
        E({ type: EventType.TOOL_CALL_END, toolCallId: 'a' }),
        E({ type: EventType.TOOL_CALL_START, toolCallId: 'b', toolCallName: 'serverTool' }),
        E({ type: EventType.TOOL_CALL_END, toolCallId: 'b' }),
        finished,
      ],
      { clientToolNames: ['browserTool'] },
    );
    const byId = Object.fromEntries(
      (chunks.filter((c) => c.type === 'tool-input-available') as Array<{ toolCallId: string; providerExecuted?: boolean }>).map((c) => [
        c.toolCallId,
        c.providerExecuted,
      ]),
    );
    expect(byId).toEqual({ a: undefined, b: true });
  });

  it('tool name from TOOL_CALL_START is remembered for TOOL_CALL_END', () => {
    const { chunks } = run([
      started,
      E({ type: EventType.TOOL_CALL_START, toolCallId: 'a', toolCallName: 'remember' }),
      E({ type: EventType.TOOL_CALL_END, toolCallId: 'a' }),
      finished,
    ]);
    expect(chunks.find((c) => c.type === 'tool-input-available')).toMatchObject({ toolName: 'remember', input: {} });
  });
});

describe('lifecycle', () => {
  it('always sets a non-empty start messageId', () => {
    const { chunks } = run([started, finished]);
    expect(chunks[0]).toMatchObject({ type: 'start', messageId: 'gen-id', messageMetadata: { runId: 'r', threadId: 't' } });
  });

  it('orphan events are reported instead of crashing the stream', async () => {
    const events = [
      started,
      E({ type: EventType.TOOL_CALL_ARGS, toolCallId: 'ghost', delta: '{}' }),
      E({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'late', delta: 'x' }),
      finished,
    ];
    const { chunks, reports } = run(events);
    expect(reports.map((r) => r.reason)).toEqual(['orphan-event', 'orphan-event']);
    expect(await validateChunks(chunks)).toEqual([]);
  });

  it('closes open parts and finishes when the stream ends without RUN_FINISHED', async () => {
    const { chunks } = run([started, E({ type: EventType.TEXT_MESSAGE_START, messageId: 'm', role: 'assistant' }), E({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm', delta: 'hi' })]);
    expect(chunks.map((c) => c.type).slice(-3)).toEqual(['text-end', 'finish-step', 'finish']);
  });

  it('nothing follows an error chunk', () => {
    const c = createAgUiChunkConverter({ generateId: () => 'id' });
    c.push(started);
    const err = c.push(E({ type: EventType.RUN_ERROR, message: 'bad' }));
    expect(err.at(-1)).toEqual({ type: 'error', errorText: 'bad' });
    expect(c.push(E({ type: EventType.TEXT_MESSAGE_START, messageId: 'm' }))).toEqual([]);
    expect(c.finish()).toEqual([]);
  });

  it('a throwing onUnmapped callback does not break the stream', () => {
    const c = createAgUiChunkConverter({
      generateId: () => 'id',
      onUnmapped: () => {
        throw new Error('user bug');
      },
    });
    expect(() => c.push(E({ type: EventType.CUSTOM, name: 'n', value: 1 }))).not.toThrow();
  });

  it('works as a TransformStream', async () => {
    const out: UIMessageChunk[] = [];
    const events = new ReadableStream<BaseEvent>({
      start(ctrl) {
        ctrl.enqueue(started);
        ctrl.enqueue(E({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'm', delta: 'ok' }));
        ctrl.close();
      },
    });
    const reader = events.pipeThrough(aguiEventsToUIMessageChunks({ generateId: () => 'id' })).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }
    expect(out.map((c) => c.type)).toEqual(['start', 'start-step', 'text-start', 'text-delta', 'text-end', 'finish-step', 'finish']);
  });
});
