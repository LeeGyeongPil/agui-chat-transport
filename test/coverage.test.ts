import { afterEach, describe, expect, it } from 'vitest';
import { EventType } from '@ag-ui/core';
import { AgUiChatTransport, EVENT_CLASSIFICATION, REPORTED_EVENT_TYPES, type UnmappedReport } from '../src/index.js';
import { startMockAgUiServer, SCENARIOS, type MockAgUiServer } from '../src/testing/index.js';
import { collect, user } from './helpers.js';

let server: MockAgUiServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const send = (t: AgUiChatTransport) =>
  t.sendMessages({ trigger: 'submit-message', chatId: 'c', messageId: undefined, messages: [user('go')], abortSignal: undefined });

describe('AC-4 every event type is mapped or reported', () => {
  it('classifies all 31 EventType values', () => {
    const all = Object.values(EventType);
    expect(all).toHaveLength(31);
    for (const t of all) expect(['mapped', 'reported']).toContain(EVENT_CLASSIFICATION[t]);
    expect(Object.keys(EVENT_CLASSIFICATION).sort()).toEqual([...all].sort());
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
    expect([...types].sort()).toEqual(Object.values(EventType).sort());
  });

  it('reports each unmapped event exactly once and finishes cleanly', async () => {
    server = await startMockAgUiServer({ scenario: 'all-events' });
    const reports: UnmappedReport[] = [];
    const transport = new AgUiChatTransport({ url: server.url, onUnmapped: (r) => reports.push(r) });
    const { chunks, message, schemaFailures } = await collect(await send(transport));
    expect(schemaFailures).toEqual([]);
    expect(chunks.at(-1)!.type).toBe('finish');
    expect(chunks.some((c) => c.type === 'error')).toBe(false);
    expect(message).toBeDefined();

    expect(reports.map((r) => r.eventType).sort()).toEqual([...REPORTED_EVENT_TYPES].sort());
    for (const r of reports) expect(r.reason).toBe('no-mapping');
    expect(REPORTED_EVENT_TYPES).toHaveLength(9);
  });

  it('emitUnmapped adds transient data-agui-unmapped chunks that never become parts', async () => {
    server = await startMockAgUiServer({ scenario: 'all-events' });
    const transport = new AgUiChatTransport({ url: server.url, emitUnmapped: true });
    const { chunks, message, schemaFailures } = await collect(await send(transport));
    expect(schemaFailures).toEqual([]);
    const unmapped = chunks.filter((c) => c.type === 'data-agui-unmapped') as Array<{ transient?: boolean; data: UnmappedReport }>;
    expect(unmapped).toHaveLength(9);
    expect(unmapped.every((c) => c.transient === true)).toBe(true);
    expect((message!.parts as Array<{ type: string }>).some((p) => p.type === 'data-agui-unmapped')).toBe(false);
  });

  it('passthrough turns CUSTOM into a data-agui-custom part and removes its report', async () => {
    server = await startMockAgUiServer({ scenario: 'all-events' });
    const reports: UnmappedReport[] = [];
    const transport = new AgUiChatTransport({ url: server.url, passthrough: [EventType.CUSTOM], onUnmapped: (r) => reports.push(r) });
    const { message, schemaFailures } = await collect(await send(transport));
    expect(schemaFailures).toEqual([]);
    const custom = (message!.parts as Array<Record<string, any>>).filter((p) => p.type === 'data-agui-custom');
    expect(custom).toHaveLength(1);
    expect(custom[0]!.data).toMatchObject({ type: 'CUSTOM', name: 'progress' });
    expect(reports.some((r) => r.eventType === 'CUSTOM')).toBe(false);
    expect(reports).toHaveLength(8);
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
    expect(schemaFailures).toEqual([]);
    const part = (message!.parts as Array<Record<string, any>>).find((p) => p.type === 'data-agui-interrupt')!;
    expect(part.data.interrupts[0]).toMatchObject({ id: 'int1', reason: 'approval', toolCallId: 'tc9' });
  });
});
