import type { AssistantMessage, Context, Message, ResumeEntry, RunAgentInput, Tool, ToolCall, ToolMessage } from '@ag-ui/core';
import type { UIMessage } from 'ai';
import { STATE_PART_ID } from './events-to-chunks.js';

export interface MessagesToInputOptions {
  threadId: string;
  /** Default: a random UUID. */
  runId?: string;
  tools?: Tool[];
  context?: Context[];
  /** Shared state to send. Default: the last `data-agui-state` part in the history. */
  state?: unknown;
  forwardedProps?: unknown;
  /** Answers to interrupts from the previous run (AG-UI `resume`). */
  resume?: ResumeEntry[];
  /** Also send reasoning parts as `reasoning` messages. Default false. */
  includeReasoning?: boolean;
}

type AnyPart = Record<string, any>;

/** The last `data-agui-state` payload found in the history, or undefined. */
export function lastAguiState(messages: UIMessage[]): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = (messages[i]!.parts ?? []) as AnyPart[];
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j]!;
      if (p.type === `data-${STATE_PART_ID}`) return p.data;
    }
  }
  return undefined;
}

function textOf(parts: AnyPart[]): string {
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text as string)
    .join('');
}

interface Group {
  id: string;
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  results: ToolMessage[];
}

function isToolPart(p: AnyPart): boolean {
  return p.type === 'dynamic-tool' || (typeof p.type === 'string' && p.type.startsWith('tool-'));
}

function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  return JSON.stringify(output ?? null);
}

/**
 * Convert the useChat history into an AG-UI `RunAgentInput`.
 * Assistant messages that the UI merged out of several AG-UI messages are split
 * again using the ids kept in `providerMetadata.agui`, so ids round-trip.
 */
export function uiMessagesToRunAgentInput(messages: UIMessage[], options: MessagesToInputOptions): RunAgentInput {
  const out: Message[] = [];

  for (const m of messages) {
    const parts = (m.parts ?? []) as AnyPart[];
    if (m.role === 'user' || m.role === 'system') {
      const content = textOf(parts);
      out.push({ id: m.id, role: m.role, content } as Message);
      continue;
    }

    const groups: Group[] = [];
    const groupFor = (id: string): Group => {
      let g = groups.find((x) => x.id === id);
      if (!g) {
        g = { id, text: '', reasoning: '', toolCalls: [], results: [] };
        groups.push(g);
      }
      return g;
    };
    let current: Group | undefined;

    for (const p of parts) {
      if (p.type === 'text') {
        const id: string | undefined = p.providerMetadata?.agui?.messageId;
        current = groupFor(id ?? current?.id ?? m.id);
        current.text += p.text as string;
      } else if (p.type === 'reasoning') {
        const id: string | undefined = p.providerMetadata?.agui?.messageId;
        current = groupFor(id ?? current?.id ?? m.id);
        current.reasoning += p.text as string;
      } else if (isToolPart(p)) {
        if (p.state === 'input-streaming') continue; // incomplete call, nothing to send yet
        const parent: string | undefined = p.callProviderMetadata?.agui?.parentMessageId;
        const g = groupFor(parent ?? current?.id ?? m.id);
        current = g;
        const name: string = p.type === 'dynamic-tool' ? p.toolName : (p.type as string).slice('tool-'.length);
        g.toolCalls.push({
          id: p.toolCallId,
          type: 'function',
          function: { name, arguments: JSON.stringify(p.input ?? {}) },
        });
        const resultId: string = p.resultProviderMetadata?.agui?.resultMessageId ?? `${p.toolCallId}-result`;
        if (p.state === 'output-available') {
          g.results.push({ id: resultId, role: 'tool', toolCallId: p.toolCallId, content: stringifyOutput(p.output) });
        } else if (p.state === 'output-error') {
          g.results.push({ id: resultId, role: 'tool', toolCallId: p.toolCallId, content: '', error: String(p.errorText ?? 'Tool failed') });
        } else if (p.state === 'output-denied') {
          g.results.push({ id: resultId, role: 'tool', toolCallId: p.toolCallId, content: '', error: 'Tool call was denied by the user' });
        }
      }
    }

    for (const g of groups) {
      if (options.includeReasoning && g.reasoning) {
        out.push({ id: `${g.id}-reasoning`, role: 'reasoning', content: g.reasoning } as Message);
      }
      if (g.text || g.toolCalls.length) {
        const assistant: AssistantMessage = { id: g.id, role: 'assistant' };
        if (g.text) assistant.content = g.text;
        if (g.toolCalls.length) assistant.toolCalls = g.toolCalls;
        out.push(assistant);
      }
      out.push(...g.results);
    }
  }

  const state = options.state !== undefined ? options.state : lastAguiState(messages);
  const input: RunAgentInput = {
    threadId: options.threadId,
    runId: options.runId ?? crypto.randomUUID(),
    state: state ?? {},
    messages: out,
    tools: options.tools ?? [],
    context: options.context ?? [],
    forwardedProps: options.forwardedProps ?? {},
  };
  if (options.resume?.length) input.resume = options.resume;
  return input;
}
