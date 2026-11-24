import { describe, expect, it } from 'vitest';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { StateTracker } from '../src/state.js';
import { createAgUiChunkConverter, type UnmappedReport } from '../src/index.js';

describe('AC-6 STATE_DELTA', () => {
  const base = () => ({ a: 1, list: [1, 2], nested: { x: 'y' }, gone: true });

  it.each([
    ['add', [{ op: 'add', path: '/list/-', value: 3 }], { a: 1, list: [1, 2, 3], nested: { x: 'y' }, gone: true }],
    ['remove', [{ op: 'remove', path: '/gone' }], { a: 1, list: [1, 2], nested: { x: 'y' } }],
    ['replace', [{ op: 'replace', path: '/a', value: 9 }], { a: 9, list: [1, 2], nested: { x: 'y' }, gone: true }],
    ['move', [{ op: 'move', from: '/nested/x', path: '/moved' }], { a: 1, list: [1, 2], nested: {}, gone: true, moved: 'y' }],
    ['copy', [{ op: 'copy', from: '/a', path: '/b' }], { a: 1, b: 1, list: [1, 2], nested: { x: 'y' }, gone: true }],
    ['test', [{ op: 'test', path: '/a', value: 1 }, { op: 'replace', path: '/a', value: 2 }], { a: 2, list: [1, 2], nested: { x: 'y' }, gone: true }],
  ])('applies %s without mutating the snapshot', (_name, ops, expected) => {
    const snapshot = base();
    const t = new StateTracker();
    t.snapshot(snapshot);
    const r = t.delta(ops);
    expect(r.ok).toBe(true);
    expect(t.state).toEqual(expected);
    expect(snapshot).toEqual(base());
  });

  it('a failing test op keeps the previous state', () => {
    const t = new StateTracker({ a: 1 });
    const r = t.delta([{ op: 'replace', path: '/a', value: 2 }, { op: 'test', path: '/a', value: 'nope' }]);
    expect(r.ok).toBe(false);
    expect(t.state).toEqual({ a: 1 });
  });

  it('a missing path keeps the previous state', () => {
    const t = new StateTracker({ a: 1 });
    expect(t.delta([{ op: 'remove', path: '/nothing/here' }]).ok).toBe(false);
    expect(t.state).toEqual({ a: 1 });
  });

  it('a non-array delta is rejected', () => {
    expect(new StateTracker({}).delta({ op: 'add' }).ok).toBe(false);
  });

  it('the converter reports patch-failed and keeps streaming', () => {
    const reports: UnmappedReport[] = [];
    const c = createAgUiChunkConverter({ generateId: () => 'id', onUnmapped: (r) => reports.push(r) });
    const E = (e: Record<string, unknown>) => e as unknown as BaseEvent;
    c.push(E({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' }));
    c.push(E({ type: EventType.STATE_SNAPSHOT, snapshot: { a: 1 } }));
    const bad = c.push(E({ type: EventType.STATE_DELTA, delta: [{ op: 'test', path: '/a', value: 5 }] }));
    expect(bad).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ eventType: 'STATE_DELTA', reason: 'patch-failed' });
    const good = c.push(E({ type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/a', value: 2 }] }));
    expect(good).toEqual([{ type: 'data-agui-state', id: 'agui-state', data: { a: 2 } }]);
  });

  it('applies a delta on top of the initial state when no snapshot arrived', () => {
    const c = createAgUiChunkConverter({ generateId: () => 'id', initialState: { n: 1 } });
    const E = (e: Record<string, unknown>) => e as unknown as BaseEvent;
    const out = c.push(E({ type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/n', value: 2 }] }));
    expect(out.at(-1)).toEqual({ type: 'data-agui-state', id: 'agui-state', data: { n: 2 } });
  });
});
