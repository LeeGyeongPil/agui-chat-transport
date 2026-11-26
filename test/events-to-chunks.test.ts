import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { EventType, type BaseEvent } from '@ag-ui/core';
import type { UIMessageChunk } from 'ai';
import {
  AgUiChatTransport,
  aguiEventsToUIMessageChunks,
  createAgUiChunkConverter,
  type UnmappedReport,
} from '../src/index.js';
import { startMockAgUiServer } from '../src/testing/index.js';
import { assertMatch, collect, repoRoot, user, validateChunks } from './helpers.js';

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
  assert.deepStrictEqual(schemaFailures, []);
  return (message!.parts as Array<Record<string, any>>).map(({ providerMetadata: _p, callProviderMetadata: _c, ...rest }) => rest);
}

/** Parts exactly as the AI SDK assembles them, metadata included. */
async function fullPartsOf(events: BaseEvent[]) {
  const { chunks } = run(events);
  const { message, schemaFailures } = await collect(streamOf(chunks));
  assert.deepStrictEqual(schemaFailures, []);
  return message!.parts;
}

/** test/fixtures/chunked.parts.json: the parts the 'chunked' scenario must produce. */
const GOLDEN_CHUNKED_PARTS = JSON.parse(
  readFileSync(resolve(repoRoot, 'test/fixtures/chunked.parts.json'), 'utf8'),
) as unknown[];

/**
 * The parts as they would be stored or sent as JSON. The AI SDK leaves some keys present
 * with the value `undefined` (`output`, `title`, ...); JSON has no `undefined`, so those
 * keys drop out and the result can be compared strictly with the golden file.
 */
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

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
    assert.deepStrictEqual(b, a);
    assert.deepStrictEqual(
      b.map((p) => p.type),
      ['step-start', 'reasoning', 'text', 'dynamic-tool'],
    );
    assert.equal(b[2]!.text, 'Hello');
    assertMatch(b[3], { toolName: 'getWeather', input: { city: 'Busan' }, state: 'input-available' });

    // Golden file: both forms give exactly the stored parts, AG-UI ids in providerMetadata included.
    assert.deepStrictEqual(asJson(await fullPartsOf(expanded)), GOLDEN_CHUNKED_PARTS);
    assert.deepStrictEqual(asJson(await fullPartsOf(chunked)), GOLDEN_CHUNKED_PARTS);
  });

  it("the mock server's 'chunked' scenario, sent over HTTP through the transport, matches the golden file", async () => {
    const server = await startMockAgUiServer({ scenario: 'chunked' });
    try {
      const transport = new AgUiChatTransport({ url: server.url });
      const { message, schemaFailures } = await collect(
        await transport.sendMessages({
          trigger: 'submit-message',
          chatId: 'c',
          messageId: undefined,
          messages: [user('hi')],
          abortSignal: undefined,
        }),
      );
      assert.deepStrictEqual(schemaFailures, []);
      assert.deepStrictEqual(asJson(message!.parts), GOLDEN_CHUNKED_PARTS);
    } finally {
      await server.close();
    }
  });

  it('a chunk with a new messageId closes the previous text part', () => {
    const { chunks } = run([
      started,
      E({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'a', delta: '1' }),
      E({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'b', delta: '2' }),
      finished,
    ]);
    assert.deepStrictEqual(
      chunks.filter((c) => c.type === 'text-end').map((c) => (c as { id: string }).id),
      ['a', 'b'],
    );
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
    assert.equal(chunks.some((c) => c.type === 'tool-input-error'), true);
    assert.equal(reports.length, 1);
    assertMatch(reports[0], { eventType: 'TOOL_CALL_END', reason: 'invalid-tool-args' });
    assert.deepStrictEqual(await validateChunks(chunks), []);
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
    assert.deepStrictEqual(
      outs.map((o) => o.output),
      [{ hits: 2 }, 'just text'],
    );
    assert.equal(outs.every((o) => o.providerExecuted === true), true);
    const parts = await partsOf(events);
    assert.deepStrictEqual(
      parts.filter((p) => p.type === 'dynamic-tool').map((p) => [p.state, p.providerExecuted]),
      [
        ['output-available', true],
        ['output-available', true],
      ],
    );
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
    // The browser tool has no providerExecuted flag at all; the server tool has it set.
    assert.equal(byId.a, undefined);
    assert.equal(byId.b, true);
    assert.deepStrictEqual(Object.keys(byId).sort(), ['a', 'b']);
  });

  it('tool name from TOOL_CALL_START is remembered for TOOL_CALL_END', () => {
    const { chunks } = run([
      started,
      E({ type: EventType.TOOL_CALL_START, toolCallId: 'a', toolCallName: 'remember' }),
      E({ type: EventType.TOOL_CALL_END, toolCallId: 'a' }),
      finished,
    ]);
    assertMatch(
      chunks.find((c) => c.type === 'tool-input-available'),
      { toolName: 'remember', input: {} },
    );
  });
});

describe('lifecycle', () => {
  it('always sets a non-empty start messageId', () => {
    const { chunks } = run([started, finished]);
    assertMatch(chunks[0], { type: 'start', messageId: 'gen-id', messageMetadata: { runId: 'r', threadId: 't' } });
  });

  it('orphan events are reported instead of crashing the stream', async () => {
    const events = [
      started,
      E({ type: EventType.TOOL_CALL_ARGS, toolCallId: 'ghost', delta: '{}' }),
      E({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'late', delta: 'x' }),
      finished,
    ];
    const { chunks, reports } = run(events);
    assert.deepStrictEqual(
      reports.map((r) => r.reason),
      ['orphan-event', 'orphan-event'],
    );
    assert.deepStrictEqual(await validateChunks(chunks), []);
  });

  it('closes open parts and finishes when the stream ends without RUN_FINISHED', async () => {
    const { chunks } = run([started, E({ type: EventType.TEXT_MESSAGE_START, messageId: 'm', role: 'assistant' }), E({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm', delta: 'hi' })]);
    assert.deepStrictEqual(
      chunks.map((c) => c.type).slice(-3),
      ['text-end', 'finish-step', 'finish'],
    );
  });

  it('nothing follows an error chunk', () => {
    const c = createAgUiChunkConverter({ generateId: () => 'id' });
    c.push(started);
    const err = c.push(E({ type: EventType.RUN_ERROR, message: 'bad' }));
    assert.deepStrictEqual(err.at(-1), { type: 'error', errorText: 'bad' });
    assert.deepStrictEqual(c.push(E({ type: EventType.TEXT_MESSAGE_START, messageId: 'm' })), []);
    assert.deepStrictEqual(c.finish(), []);
  });

  it('a throwing onUnmapped callback does not break the stream', () => {
    const c = createAgUiChunkConverter({
      generateId: () => 'id',
      onUnmapped: () => {
        throw new Error('user bug');
      },
    });
    assert.doesNotThrow(() => c.push(E({ type: EventType.CUSTOM, name: 'n', value: 1 })));
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
    assert.deepStrictEqual(
      out.map((c) => c.type),
      ['start', 'start-step', 'text-start', 'text-delta', 'text-end', 'finish-step', 'finish'],
    );
  });
});
