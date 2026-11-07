/**
 * Domain & CRDT Types for Boron Q4 Matrix
 *
 * CS Concept: Algebraic Data Types (ADTs) & Hybrid Logical Clocks (HLC).
 * Every entity carries a logical timestamp (`updatedAt`, `lamport`, `nodeId`)
 * so concurrent offline edits across devices can be merged deterministically
 * without a central coordinating server.
 */

export type Quadrant = 'INBOX' | 'Q1' | 'Q2' | 'Q3' | 'Q4';

export interface QuadrantMeta {
  id: Exclude<Quadrant, 'INBOX'>;
  title: string;
  subtitle: string;
  important: boolean;
  urgent: boolean;
  boronAdvice: string;
  accentColor: string;
}

/**
 * Hybrid Logical Timestamp for Total Ordering across Distributed Devices.
 * When two concurrent edits happen offline:
 * 1. Compare `lamport` counter (logical causality)
 * 2. Tie-break with `wallTime` (physical clock ms)
 * 3. Deterministic tie-break with `nodeId` (lexicographical device ID)
 */
export interface LogicalClock {
  lamport: number;
  wallTime: number;
  nodeId: string;
}

export interface TaskItem {
  id: string;
  title: string;
  notes?: string;
  quadrant: Quadrant;
  completed: boolean;
  completedAt?: number;
  createdAt: number;

  /**
   * Optional deadline (ISO YYYY-MM-DD or timestamp ms).
   * Used for Q2 -> Q1 escalation: if a Q2 task is neglected until
   * within 48h of its deadline, it warns/escalates into a Q1 crisis!
   */
  dueDate?: string;

  /** Estimated or logged deep-work minutes on this task */
  estimatedMinutes?: number;
  focusMinutesLogged: number;

  /** Tracks if this task started in Q2 and escalated to Q1 due to deadline decay */
  escalatedFromQ2?: boolean;

  /** Optional link to the Q1 crisis that inspired this preventive Q2 task */
  preventsTaskId?: string;

  /** Tags like +mimuw, +asd, +health */
  tags: string[];

  /**
   * CRDT Tombstone: instead of deleting rows from the array (which would
   * cause a deleted task to reappear when syncing with an offline device),
   * we mark `deleted: true` and advance the logical clock.
   */
  deleted?: boolean;

  /**
   * Multi-Value CRDT Sibling Set (MV-Register):
   * If two devices edit the same task offline at the exact same `lamport` version,
   * we preserve the alternate overlapping version(s) here instead of silently
   * dropping them. Any subsequent mutation increments `lamport` and clears this set.
   */
  concurrentConflicts?: ConcurrentTaskValue[];

  /** CRDT Version Stamp for Last-Write-Wins (LWW) conflict resolution */
  clock: LogicalClock;
}

export interface ConcurrentTaskValue {
  title: string;
  notes?: string;
  quadrant: Quadrant;
  completed: boolean;
  dueDate?: string;
  estimatedMinutes?: number;
  tags: string[];
  clock: LogicalClock;
}

/**
 * Append-only focus session log (Grow-Only Set / G-Set CRDT).
 * Since completed focus blocks are immutable facts, merging two devices'
 * focus logs is simply the set union by `id`!
 */
export interface FocusSession {
  id: string;
  taskId?: string;
  quadrant: Exclude<Quadrant, 'INBOX'>;
  durationMinutes: number;
  startedAt: number;
  endedAt: number;
  nodeId: string;
}

export interface AppState {
  schemaVersion: number;
  nodeId: string;
  maxLamport: number;
  tasks: Record<string, TaskItem>;
  focusSessions: Record<string, FocusSession>;
  lastSyncedAt?: number;
}

export interface GistSyncConfig {
  token: string;
  gistId: string;
  autoSync: boolean;
}

