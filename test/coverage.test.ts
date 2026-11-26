import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { EventType } from '@ag-ui/core';
import { AgUiChatTransport, EVENT_CLASSIFICATION, REPORTED_EVENT_TYPES, type UnmappedReport } from '../src/index.js';
import { startMockAgUiServer, SCENARIOS, type MockAgUiServer } from '../src/testing/index.js';
import { assertMatch, collect, user } from './helpers.js';

let server: MockAgUiServer | undefined;

const send = (t: AgUiChatTransport) =>
  t.sendMessages({ trigger: 'submit-message', chatId: 'c', messageId: undefined, messages: [user('go')], abortSignal: undefined });

describe('AC-4 every event type is mapped or reported', () => {
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('classifies all 31 EventType values', () => {
    const all = Object.values(EventType);
    assert.equal(all.length, 31);
    for (const t of all) assert.ok(['mapped', 'reported'].includes(EVENT_CLASSIFICATION[t]), t);
    assert.deepStrictEqual(Object.keys(EVENT_CLASSIFICATION).sort(), [...all].sort());
  });

  it('the all-events and run-error scenarios together emit every EventType', async () => {
    const input = { threadId: 't', runId: 'r', messages: [], tools: [], context: [], state: {}, forwardedProps: {} };
    // RUN_ERROR is terminal, so it lives in the run-error scenario; together they cover all 31.
    const types = new Set(
      [
        ...(SCENARIOS['all-events'](input as never) as Iterable<{ type: string }>),
        ...(SCENARIOS['run-error'](input as never) as Iterable<{ type: string }>),
      ].map((e) => e.type),
    );
    assert.deepStrictEqual([...types].sort(), Object.values(EventType).sort());
  });

  it('reports each unmapped event exactly once and finishes cleanly', async () => {
    server = await startMockAgUiServer({ scenario: 'all-events' });
    const reports: UnmappedReport[] = [];
    const transport = new AgUiChatTransport({ url: server.url, onUnmapped: (r) => reports.push(r) });
    const { chunks, message, schemaFailures } = await collect(await send(transport));
    assert.deepStrictEqual(schemaFailures, []);
    assert.equal(chunks.at(-1)!.type, 'finish');
    assert.equal(chunks.some((c) => c.type === 'error'), false);
    assert.notEqual(message, undefined);

    assert.deepStrictEqual(reports.map((r) => r.eventType).sort(), [...REPORTED_EVENT_TYPES].sort());
    for (const r of reports) assert.equal(r.reason, 'no-mapping');
    assert.equal(REPORTED_EVENT_TYPES.length, 9);
  });

  it('emitUnmapped adds transient data-agui-unmapped chunks that never become parts', async () => {
    server = await startMockAgUiServer({ scenario: 'all-events' });
    const transport = new AgUiChatTransport({ url: server.url, emitUnmapped: true });
    const { chunks, message, schemaFailures } = await collect(await send(transport));
    assert.deepStrictEqual(schemaFailures, []);
    const unmapped = chunks.filter((c) => c.type === 'data-agui-unmapped') as Array<{ transient?: boolean; data: UnmappedReport }>;
    assert.equal(unmapped.length, 9);
    assert.equal(unmapped.every((c) => c.transient === true), true);
    assert.equal((message!.parts as Array<{ type: string }>).some((p) => p.type === 'data-agui-unmapped'), false);
  });

  it('passthrough turns CUSTOM into a data-agui-custom part and removes its report', async () => {
    server = await startMockAgUiServer({ scenario: 'all-events' });
    const reports: UnmappedReport[] = [];
    const transport = new AgUiChatTransport({ url: server.url, passthrough: [EventType.CUSTOM], onUnmapped: (r) => reports.push(r) });
    const { message, schemaFailures } = await collect(await send(transport));
    assert.deepStrictEqual(schemaFailures, []);
    const custom = (message!.parts as Array<Record<string, any>>).filter((p) => p.type === 'data-agui-custom');
    assert.equal(custom.length, 1);
    assertMatch(custom[0]!.data, { type: 'CUSTOM', name: 'progress' });
    assert.equal(reports.some((r) => r.eventType === 'CUSTOM'), false);
    assert.equal(reports.length, 8);
  });

  it('keeps interrupt ids in a data-agui-interrupt part', async () => {
    server = await startMockAgUiServer({
      events: ({ threadId, runId }) => [
        { type: EventType.RUN_STARTED, threadId, runId },
        {
          type: EventType.RUN_FINISHED,
          threadId,
          runId,
          outcome: { type: 'interrupt', interrupts: [{ id: 'int1', reason: 'approval', toolCallId: 'tc9' }] },
        },
      ] as never,
    });
    const transport = new AgUiChatTransport({ url: server.url });
    const { message, schemaFailures } = await collect(await send(transport));
    assert.deepStrictEqual(schemaFailures, []);
    const part = (message!.parts as Array<Record<string, any>>).find((p) => p.type === 'data-agui-interrupt')!;
    assertMatch(part.data.interrupts[0], { id: 'int1', reason: 'approval', toolCallId: 'tc9' });
  });
});
