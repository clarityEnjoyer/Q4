import {
  AppState,
  ConcurrentTaskValue,
  FocusSession,
  LogicalClock,
  TaskItem,
} from './types';

/**
 * ============================================================================
 * CS MODULE: State-Based CRDT (CvRDT) & Join-Semilattice
 * ============================================================================
 *
 * Structures `AppState` as a Bounded Join-Semilattice (S, ⊔):
 *   1. `Tasks` is a map of ID -> MV/LWW-Element with Tombstones (Edit-Wins on tied Lamport)
 *   2. `FocusSessions` is a G-Set (Grow-Only Set of immutable session records)
 *
 * Satisfies for all states A, B, C:
 *   - Commutativity:  A ⊔ B = B ⊔ A
 *   - Associativity:  (A ⊔ B) ⊔ C = A ⊔ (B ⊔ C)
 *   - Idempotence:    A ⊔ A = A
 */

export function compareClocks(a: LogicalClock, b: LogicalClock): number {
  if (a.lamport !== b.lamport) {
    return a.lamport - b.lamport;
  }
  if (a.wallTime !== b.wallTime) {
    return a.wallTime - b.wallTime;
  }
  return a.nodeId.localeCompare(b.nodeId);
}

export function nextClock(state: AppState, now: number = Date.now()): LogicalClock {
  const nextLamport = state.maxLamport + 1;
  return {
    lamport: nextLamport,
    wallTime: now,
    nodeId: state.nodeId,
  };
}

function toConcurrentValue(t: TaskItem): ConcurrentTaskValue {
  return {
    title: t.title,
    notes: t.notes,
    quadrant: t.quadrant,
    completed: t.completed,
    dueDate: t.dueDate,
    estimatedMinutes: t.estimatedMinutes,
    tags: [...(t.tags || [])].sort(),
    clock: t.clock,
  };
}

function contentSignature(v: ConcurrentTaskValue): string {
  const tagsStr = [...(v.tags || [])].sort().join(',');
  return `${v.title}|${v.notes || ''}|${v.quadrant}|${v.completed}|${v.dueDate || ''}|${v.estimatedMinutes || ''}|${tagsStr}`;
}

function concurrentValueSignature(v: ConcurrentTaskValue): string {
  return `${v.clock.lamport}|${v.clock.wallTime}|${v.clock.nodeId}|${contentSignature(v)}`;
}

function normalizeTaskConflicts(t: TaskItem): TaskItem {
  if (!t.concurrentConflicts || t.concurrentConflicts.length === 0) {
    return t.concurrentConflicts === undefined ? t : { ...t, concurrentConflicts: undefined };
  }
  const winSig = contentSignature(toConcurrentValue(t));
  const valid = t.concurrentConflicts.filter(
    (c) => c.clock.lamport === t.clock.lamport && contentSignature(c) !== winSig
  );
  return {
    ...t,
    concurrentConflicts: valid.length > 0 ? valid : undefined,
  };
}

/**
 * Merges two versions of the same TaskItem:
 * 1. Higher `lamport` strictly wins.
 * 2. On tied `lamport`:
 *    - Edit-Wins over Tombstone (`!deleted` beats `deleted: true` at same Lamport).
 *    - Deterministic tie-break via `compareClocks`.
 *    - Preserves distinct concurrent live edits in `concurrentConflicts` (MV-Register).
 */
export function mergeTaskItem(rawA: TaskItem, rawB: TaskItem): TaskItem {
  const a = normalizeTaskConflicts(rawA);
  const b = normalizeTaskConflicts(rawB);

  if (a.clock.lamport > b.clock.lamport) {
    return a;
  }
  if (b.clock.lamport > a.clock.lamport) {
    return b;
  }

  // Tied Lamport clock: Edit-Wins over Delete
  const aDeleted = Boolean(a.deleted);
  const bDeleted = Boolean(b.deleted);
  if (aDeleted !== bDeleted) {
    return aDeleted ? b : a;
  }

  const cmp = compareClocks(a.clock, b.clock);
  const winner = cmp >= 0 ? a : b;

  // If both are tombstones, no concurrent conflicts needed
  if (winner.deleted) {
    return { ...winner, concurrentConflicts: undefined };
  }

  const winnerSnap = toConcurrentValue(winner);
  const winnerContentSig = contentSignature(winnerSnap);

  const candidateMap = new Map<string, ConcurrentTaskValue>();
  const allCandidates: ConcurrentTaskValue[] = [
    ...(a.deleted ? [] : [toConcurrentValue(a)]),
    ...(b.deleted ? [] : [toConcurrentValue(b)]),
    ...(a.concurrentConflicts || []),
    ...(b.concurrentConflicts || []),
  ];

  for (const cand of allCandidates) {
    if (cand.clock.lamport !== winner.clock.lamport) continue;
    if (contentSignature(cand) !== winnerContentSig) {
      candidateMap.set(concurrentValueSignature(cand), cand);
    }
  }

  const mergedConflicts = Array.from(candidateMap.values()).sort((x, y) =>
    compareClocks(x.clock, y.clock)
  );

  return {
    ...winner,
    concurrentConflicts: mergedConflicts.length > 0 ? mergedConflicts : undefined,
  };
}

export function mergeAppState(local: AppState, remote: AppState): AppState {
  const mergedTasks: Record<string, TaskItem> = {};
  const allTaskIds = new Set([
    ...Object.keys(local.tasks),
    ...Object.keys(remote.tasks),
  ]);

  let highestLamport = Math.max(local.maxLamport || 0, remote.maxLamport || 0);

  for (const id of allTaskIds) {
    const tLocal = local.tasks[id];
    const tRemote = remote.tasks[id];

    let winner: TaskItem;
    if (tLocal && tRemote) {
      winner = mergeTaskItem(tLocal, tRemote);
    } else {
      winner = normalizeTaskConflicts((tLocal || tRemote)!);
    }

    mergedTasks[id] = winner;
    if (winner.clock.lamport > highestLamport) {
      highestLamport = winner.clock.lamport;
    }
  }

  const mergedSessions: Record<string, FocusSession> = {};
  const allSessionIds = new Set([
    ...Object.keys(local.focusSessions || {}),
    ...Object.keys(remote.focusSessions || {}),
  ]);

  for (const sId of allSessionIds) {
    const sLocal = local.focusSessions?.[sId];
    const sRemote = remote.focusSessions?.[sId];
    mergedSessions[sId] = sLocal || sRemote!;
  }

  const sessionMinutesByTask: Record<string, number> = {};
  for (const session of Object.values(mergedSessions)) {
    if (session.taskId) {
      sessionMinutesByTask[session.taskId] =
        (sessionMinutesByTask[session.taskId] || 0) + session.durationMinutes;
    }
  }

  for (const id of Object.keys(mergedTasks)) {
    const task = mergedTasks[id];
    const loggedFromSessions = sessionMinutesByTask[id] || 0;
    if (loggedFromSessions > task.focusMinutesLogged) {
      mergedTasks[id] = {
        ...task,
        focusMinutesLogged: loggedFromSessions,
      };
    }
  }

  return {
    schemaVersion: 1,
    nodeId: local.nodeId,
    maxLamport: highestLamport,
    tasks: mergedTasks,
    focusSessions: mergedSessions,
    lastSyncedAt: Math.max(local.lastSyncedAt || 0, remote.lastSyncedAt || 0) || undefined,
  };
}

export function canonicalStateSignature(state: AppState): string {
  const sortedTaskIds = Object.keys(state.tasks).sort();
  const sortedSessionIds = Object.keys(state.focusSessions).sort();

  return JSON.stringify({
    maxLamport: state.maxLamport,
    tasks: sortedTaskIds.map((id) => state.tasks[id]),
    focusSessions: sortedSessionIds.map((id) => state.focusSessions[id]),
  });
}

export interface SemilatticeVerificationResult {
  idempotent: boolean;
  commutative: boolean;
  associative: boolean;
  details: string[];
}

export function verifySemilatticeLaws(
  replicaA: AppState,
  replicaB: AppState,
  replicaC: AppState
): SemilatticeVerificationResult {
  const aa = mergeAppState(replicaA, replicaA);
  const idempotent =
    canonicalStateSignature(aa) === canonicalStateSignature(replicaA);

  const ab = mergeAppState(replicaA, replicaB);
  const ba = mergeAppState(replicaB, replicaA);
  const commutative =
    canonicalStateSignature(ab) === canonicalStateSignature(ba);

  const ab_c = mergeAppState(ab, replicaC);
  const bc = mergeAppState(replicaB, replicaC);
  const a_bc = mergeAppState(replicaA, bc);
  const associative =
    canonicalStateSignature(ab_c) === canonicalStateSignature(a_bc);

  return {
    idempotent,
    commutative,
    associative,
    details: [
      `Idempotence (A ⊔ A = A): ${idempotent ? 'PASS ✓' : 'FAIL ✗'}`,
      `Commutativity (A ⊔ B = B ⊔ A): ${commutative ? 'PASS ✓' : 'FAIL ✗'}`,
      `Associativity ((A ⊔ B) ⊔ C = A ⊔ (B ⊔ C)): ${associative ? 'PASS ✓' : 'FAIL ✗'}`,
    ],
  };
}
