import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readUIMessageStream, uiMessageChunkSchema, type UIMessage, type UIMessageChunk } from 'ai';

/**
 * The repository root (the folder with package.json). Tests are compiled to `.build/test/`,
 * so the path is found by walking up instead of a fixed `..`.
 */
export const repoRoot: string = (() => {
  let dir = import.meta.dirname;
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`package.json not found above ${import.meta.dirname}`);
    dir = parent;
  }
  return dir;
})();

/** Drain a chunk stream: validate each chunk with the AI SDK schema and assemble the message. */
export async function collect(stream: ReadableStream<UIMessageChunk>): Promise<{
  chunks: UIMessageChunk[];
  message: UIMessage | undefined;
  schemaFailures: string[];
}> {
  const [forChunks, forMessage] = stream.tee();
  const chunks: UIMessageChunk[] = [];
  const reading = (async () => {
    const reader = forChunks.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      chunks.push(value);
    }
  })();
  let message: UIMessage | undefined;
  const assembled = (async () => {
    for await (const m of readUIMessageStream({ stream: forMessage, onError: () => undefined })) message = m;
  })();
  await Promise.all([reading, assembled]);
  return { chunks, message, schemaFailures: await validateChunks(chunks) };
}

/** Validate chunks against the AI SDK's own schema; returns human readable failures. */
export async function validateChunks(chunks: UIMessageChunk[]): Promise<string[]> {
  const schema = uiMessageChunkSchema();
  const failures: string[] = [];
  for (const c of chunks) {
    const v = (await schema.validate!(c)) as { success: boolean; error?: { message?: string } };
    if (!v.success) failures.push(`${c.type}: ${v.error?.message ?? 'invalid'}`);
  }
  return failures;
}

export function user(text: string, id = 'u1'): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

/**
 * Partial deep match: every key in `expected` must be in `actual` with a matching value
 * (objects are compared the same way, recursively; arrays must have the same length).
 * Extra keys in `actual` are fine. Same meaning as `expect(actual).toMatchObject(expected)`.
 */
export function assertMatch(actual: unknown, expected: unknown, path = '$'): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path}: expected an array, got ${JSON.stringify(actual)}`);
    assert.equal(actual.length, expected.length, `${path}: array length`);
    expected.forEach((e, i) => assertMatch(actual[i], e, `${path}[${i}]`));
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    assert.ok(actual !== null && typeof actual === 'object', `${path}: expected an object, got ${JSON.stringify(actual)}`);
    for (const [k, v] of Object.entries(expected)) {
      assert.ok(k in (actual as object), `${path}.${k}: missing in ${JSON.stringify(actual)}`);
      assertMatch((actual as Record<string, unknown>)[k], v, `${path}.${k}`);
    }
    return;
  }
  assert.deepStrictEqual(actual, expected, `${path}`);
}
