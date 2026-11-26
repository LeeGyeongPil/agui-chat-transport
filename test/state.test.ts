import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { StateTracker } from '../src/state.js';
import { createAgUiChunkConverter, type UnmappedReport } from '../src/index.js';
import { assertMatch } from './helpers.js';

describe('AC-6 STATE_DELTA', () => {
  const base = () => ({ a: 1, list: [1, 2], nested: { x: 'y' }, gone: true });

  const cases: Array<[string, unknown[], unknown]> = [
    ['add', [{ op: 'add', path: '/list/-', value: 3 }], { a: 1, list: [1, 2, 3], nested: { x: 'y' }, gone: true }],
    ['remove', [{ op: 'remove', path: '/gone' }], { a: 1, list: [1, 2], nested: { x: 'y' } }],
    ['replace', [{ op: 'replace', path: '/a', value: 9 }], { a: 9, list: [1, 2], nested: { x: 'y' }, gone: true }],
    ['move', [{ op: 'move', from: '/nested/x', path: '/moved' }], { a: 1, list: [1, 2], nested: {}, gone: true, moved: 'y' }],
    ['copy', [{ op: 'copy', from: '/a', path: '/b' }], { a: 1, b: 1, list: [1, 2], nested: { x: 'y' }, gone: true }],
    ['test', [{ op: 'test', path: '/a', value: 1 }, { op: 'replace', path: '/a', value: 2 }], { a: 2, list: [1, 2], nested: { x: 'y' }, gone: true }],
  ];
  // One test per operation (same as vitest's it.each).
  for (const [name, ops, expected] of cases) {
    it(`applies ${name} without mutating the snapshot`, () => {
      const snapshot = base();
      const t = new StateTracker();
      t.snapshot(snapshot);
      const r = t.delta(ops);
      assert.equal(r.ok, true);
      assert.deepStrictEqual(t.state, expected);
      // The input snapshot object is unchanged.
      assert.deepStrictEqual(snapshot, base());
    });
  }

  it('a failing test op keeps the previous state', () => {
    const t = new StateTracker({ a: 1 });
    const r = t.delta([{ op: 'replace', path: '/a', value: 2 }, { op: 'test', path: '/a', value: 'nope' }]);
    assert.equal(r.ok, false);
    assert.deepStrictEqual(t.state, { a: 1 });
  });

  it('a missing path keeps the previous state', () => {
    const t = new StateTracker({ a: 1 });
    assert.equal(t.delta([{ op: 'remove', path: '/nothing/here' }]).ok, false);
    assert.deepStrictEqual(t.state, { a: 1 });
  });

  it('a non-array delta is rejected', () => {
    assert.equal(new StateTracker({}).delta({ op: 'add' }).ok, false);
  });

  it('the converter reports patch-failed and keeps streaming', () => {
    const reports: UnmappedReport[] = [];
    const c = createAgUiChunkConverter({ generateId: () => 'id', onUnmapped: (r) => reports.push(r) });
    const E = (e: Record<string, unknown>) => e as unknown as BaseEvent;
    c.push(E({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' }));
    c.push(E({ type: EventType.STATE_SNAPSHOT, snapshot: { a: 1 } }));
    const bad = c.push(E({ type: EventType.STATE_DELTA, delta: [{ op: 'test', path: '/a', value: 5 }] }));
    assert.deepStrictEqual(bad, []);
    assert.equal(reports.length, 1);
    assertMatch(reports[0], { eventType: 'STATE_DELTA', reason: 'patch-failed' });
    const good = c.push(E({ type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/a', value: 2 }] }));
    assert.deepStrictEqual(good, [{ type: 'data-agui-state', id: 'agui-state', data: { a: 2 } }]);
  });

  it('applies a delta on top of the initial state when no snapshot arrived', () => {
    const c = createAgUiChunkConverter({ generateId: () => 'id', initialState: { n: 1 } });
    const E = (e: Record<string, unknown>) => e as unknown as BaseEvent;
    const out = c.push(E({ type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/n', value: 2 }] }));
    assert.deepStrictEqual(out.at(-1), { type: 'data-agui-state', id: 'agui-state', data: { n: 2 } });
  });
});
