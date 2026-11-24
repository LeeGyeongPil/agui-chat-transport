import { readUIMessageStream, uiMessageChunkSchema, type UIMessage, type UIMessageChunk } from 'ai';

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
