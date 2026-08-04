// Snapshot-based undo/redo. One entry per gesture.
// Usage from tools:
//   history.beginTransaction();           // pointerdown
//   ...state.mutate(...) many times...    // pointermove
//   history.commit("draw rect");          // pointerup

import { snapshot, replaceRoot } from "./state.js";

const MAX = 200;

const past = [];    // snapshots of root taken BEFORE each gesture
const future = [];  // snapshots of root taken BEFORE undoing (i.e., states we can redo to)

let pending = null;

export function beginTransaction() {
  // If a prior transaction is still open (defensive), drop it — the last committed state is intact.
  pending = snapshot();
}

export function commit(_label) {
  if (pending === null) return;
  past.push(pending);
  if (past.length > MAX) past.shift();
  future.length = 0;
  pending = null;
}

export function abort() {
  pending = null;
}

// Standalone mutations that aren't a drag gesture — e.g., property panel edits, keyboard nudges,
// group/ungroup, delete — snapshot before, then commit after the mutation.
export function record(mutFn) {
  beginTransaction();
  try {
    mutFn();
    commit();
  } catch (e) {
    abort();
    throw e;
  }
}

export function undo() {
  if (past.length === 0) return false;
  future.push(snapshot());
  const prev = past.pop();
  replaceRoot(prev);
  return true;
}

export function redo() {
  if (future.length === 0) return false;
  past.push(snapshot());
  const next = future.pop();
  replaceRoot(next);
  return true;
}

export function canUndo() { return past.length > 0; }
export function canRedo() { return future.length > 0; }
