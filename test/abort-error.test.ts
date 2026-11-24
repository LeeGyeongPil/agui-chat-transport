import { afterEach, describe, expect, it } from 'vitest';
import { AgUiChatTransport, AgUiTransportConfigError } from '../src/index.js';
import { startMockAgUiServer, type MockAgUiServer } from '../src/testing/index.js';
import { collect, user } from './helpers.js';

let server: MockAgUiServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const send = (t: AgUiChatTransport, abortSignal?: AbortSignal) =>
  t.sendMessages({ trigger: 'submit-message', chatId: 'c', messageId: undefined, messages: [user('go')], abortSignal });

describe('AC-7 errors and stop()', () => {
  it('RUN_ERROR becomes an error chunk carrying the message', async () => {
    server = await startMockAgUiServer({ scenario: 'run-error' });
    const { chunks, schemaFailures } = await collect(await send(new AgUiChatTransport({ url: server.url })));
    expect(schemaFailures).toEqual([]);
    expect(chunks.at(-1)).toEqual({ type: 'error', errorText: 'model overloaded' });
    // The partial text is closed before the error.
    expect(chunks.some((c) => c.type === 'text-end')).toBe(true);
  });

  it('an HTTP 500 becomes an error chunk', async () => {
    server = await startMockAgUiServer({ httpStatus: 500 });
    const { chunks } = await collect(await send(new AgUiChatTransport({ url: server.url })));
    const err = chunks.find((c) => c.type === 'error') as { errorText: string } | undefined;
    expect(err).toBeDefined();
    expect(err!.errorText).toMatch(/500/);
  });

  it('a refused connection becomes an error chunk, not a throw', async () => {
    const { chunks } = await collect(await send(new AgUiChatTransport({ url: 'http://127.0.0.1:1/agent' })));
    const err = chunks.find((c) => c.type === 'error') as { errorText: string } | undefined;
    expect(err).toBeDefined();
    expect(err!.errorText).toContain('http://127.0.0.1:1/agent');
    expect(err!.errorText).toMatch(/Is the agent server running/);
  });

  it('abortSignal closes the server response within 1 second and ends the stream', async () => {
    server = await startMockAgUiServer({ scenario: 'slow' });
    const controller = new AbortController();
    const stream = await send(new AgUiChatTransport({ url: server.url }), controller.signal);
    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    const t0 = Date.now();
    controller.abort();
    expect(await server.waitForAbort(1000)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
    // Stream terminates (no hang): drain until done.
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  });

  it('cancelling the stream reader also stops the run', async () => {
    server = await startMockAgUiServer({ scenario: 'slow' });
    const reader = (await send(new AgUiChatTransport({ url: server.url }))).getReader();
    await reader.read();
    await reader.cancel();
    expect(await server.waitForAbort(1000)).toBe(true);
  });

  it('an already aborted signal never contacts the server', async () => {
    server = await startMockAgUiServer({ scenario: 'slow' });
    const controller = new AbortController();
    controller.abort();
    const { chunks } = await collect(await send(new AgUiChatTransport({ url: server.url }), controller.signal));
    expect(chunks).toEqual([]);
    expect(server.received).toHaveLength(0);
  });

  it('url or agent is required, and not both', () => {
    expect(() => new AgUiChatTransport({})).toThrow(AgUiTransportConfigError);
    expect(() => new AgUiChatTransport({})).toThrow(/url/);
    expect(() => new AgUiChatTransport({ url: 'http://x', agent: {} as never })).toThrow(AgUiTransportConfigError);
  });

  it('accepts a custom agent factory', async () => {
    server = await startMockAgUiServer({ scenario: 'chunked' });
    const { HttpAgent } = await import('@ag-ui/client');
    const url = server.url;
    const { chunks } = await collect(await send(new AgUiChatTransport({ agent: () => new HttpAgent({ url }) })));
    expect(chunks.at(-1)!.type).toBe('finish');
  });
});
