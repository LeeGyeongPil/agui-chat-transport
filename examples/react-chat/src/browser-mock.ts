import type { RunAgentInput } from '@ag-ui/core';
import { SCENARIOS } from '../../../src/testing/scenarios.js';

/** Fake endpoint address that the in-page practice agent answers to. */
export const BROWSER_MOCK_URL = 'http://agui-practice.invalid/agent';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Static-build practice mode: replaces `fetch` for BROWSER_MOCK_URL with a scripted
 * AG-UI event stream (real SSE text, no network, no model), so the built page works
 * when opened straight from disk. Other requests go to the original `fetch`.
 */
export function installBrowserMock(delayMs = 120): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== BROWSER_MOCK_URL) return realFetch(input, init);
    const body = JSON.parse(String(init?.body ?? '{}')) as RunAgentInput;
    const events = SCENARIOS.weather(body);
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for await (const e of events as AsyncIterable<unknown>) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
          await sleep(delayMs);
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}
