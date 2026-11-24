import { EventType, type BaseEvent } from '@ag-ui/core';

/** Why an AG-UI event could not be (fully) represented as UIMessage chunks. */
export type UnmappedReason = 'no-mapping' | 'patch-failed' | 'invalid-tool-args' | 'orphan-event';

/** Delivered to `onUnmapped` (and optionally as a `data-agui-unmapped` chunk). */
export interface UnmappedReport {
  eventType: string;
  reason: UnmappedReason;
  event: BaseEvent;
  /** Human readable detail (English), for example the JSON Patch error. */
  detail?: string;
}

/** `mapped`: turned into chunks. `reported`: no UIMessage equivalent, reported unless passed through. */
export type EventClass = 'mapped' | 'reported';

/**
 * Single source of truth for how every one of the 31 AG-UI event types is
 * handled. A test asserts that this table covers `EventType` completely.
 */
export const EVENT_CLASSIFICATION: Record<EventType, EventClass> = {
  [EventType.RUN_STARTED]: 'mapped',
  [EventType.RUN_FINISHED]: 'mapped',
  [EventType.RUN_ERROR]: 'mapped',
  [EventType.STEP_STARTED]: 'mapped',
  [EventType.STEP_FINISHED]: 'mapped',
  [EventType.TEXT_MESSAGE_START]: 'mapped',
  [EventType.TEXT_MESSAGE_CONTENT]: 'mapped',
  [EventType.TEXT_MESSAGE_END]: 'mapped',
  [EventType.TEXT_MESSAGE_CHUNK]: 'mapped',
  [EventType.REASONING_START]: 'mapped',
  [EventType.REASONING_MESSAGE_START]: 'mapped',
  [EventType.REASONING_MESSAGE_CONTENT]: 'mapped',
  [EventType.REASONING_MESSAGE_END]: 'mapped',
  [EventType.REASONING_MESSAGE_CHUNK]: 'mapped',
  [EventType.REASONING_END]: 'mapped',
  [EventType.TOOL_CALL_START]: 'mapped',
  [EventType.TOOL_CALL_ARGS]: 'mapped',
  [EventType.TOOL_CALL_END]: 'mapped',
  [EventType.TOOL_CALL_CHUNK]: 'mapped',
  [EventType.TOOL_CALL_RESULT]: 'mapped',
  [EventType.STATE_SNAPSHOT]: 'mapped',
  [EventType.STATE_DELTA]: 'mapped',
  [EventType.MESSAGES_SNAPSHOT]: 'reported',
  [EventType.ACTIVITY_SNAPSHOT]: 'reported',
  [EventType.ACTIVITY_DELTA]: 'reported',
  [EventType.RAW]: 'reported',
  [EventType.CUSTOM]: 'reported',
  [EventType.REASONING_ENCRYPTED_VALUE]: 'reported',
  [EventType.SUBAGENT_STARTED]: 'reported',
  [EventType.SUBAGENT_FINISHED]: 'reported',
  [EventType.SUBAGENT_ERROR]: 'reported',
};

/** Event types that are reported by default (everything not mapped). */
export const REPORTED_EVENT_TYPES: EventType[] = (Object.keys(EVENT_CLASSIFICATION) as EventType[]).filter(
  (t) => EVENT_CLASSIFICATION[t] === 'reported',
);

/** `data-agui-<kind>` suffix used when a reported event is passed through. */
export function passthroughKind(type: string): string {
  return type.toLowerCase().replace(/_/g, '-');
}
