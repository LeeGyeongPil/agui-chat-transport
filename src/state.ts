import jsonpatch from 'fast-json-patch';
import type { Operation } from 'fast-json-patch';

export type PatchResult = { ok: true; state: unknown } | { ok: false; error: string };

/**
 * Holds the shared agent state and applies RFC 6902 patches.
 * Inputs are never mutated: snapshots are cloned on the way in and every patch
 * is applied to a copy, so a failing patch leaves the previous state intact.
 */
export class StateTracker {
  private current: unknown;

  constructor(initial?: unknown) {
    this.current = initial === undefined ? undefined : structuredClone(initial);
  }

  get state(): unknown {
    return this.current;
  }

  snapshot(next: unknown): unknown {
    this.current = structuredClone(next);
    return this.current;
  }

  /** Apply a patch atomically. On failure the state is unchanged. */
  delta(operations: unknown): PatchResult {
    if (!Array.isArray(operations)) {
      return { ok: false, error: 'STATE_DELTA.delta must be an array of JSON Patch operations' };
    }
    try {
      const base = this.current === undefined ? {} : this.current;
      const result = jsonpatch.applyPatch(base, operations as Operation[], true, false);
      this.current = result.newDocument;
      return { ok: true, state: this.current };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
