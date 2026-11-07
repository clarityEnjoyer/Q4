import { describe, expect, it } from 'vitest';
import { mergeAppState, verifySemilatticeLaws } from './crdt';
import {
  addTask,
  createStarterState,
  deleteTask,
  escalateNeglectedQ2Tasks,
  logFocusSession,
  moveTask,
  parseQuickInput,
  resolveQuadrant,
  resolveTaskConflict,
  toggleTaskCompleted,
  triageTask,
  updateTaskDetails,
} from './engine';
import { parseMarkdownTaskLines, serializeToMarkdown } from './markdown';

describe('Boron Q4 CRDT Semilattice & Domain Engine', () => {
  it('satisfies Join-Semilattice laws (Idempotence, Commutativity, Associativity) under concurrent offline edits', () => {
    const base = createStarterState('node_base');

    let replicaA = { ...base, nodeId: 'node_laptop' };
    replicaA = addTask(replicaA, 'Implement Raft leader election #q2 +sr ~90m');
    const firstId = Object.keys(replicaA.tasks)[0];
    replicaA = toggleTaskCompleted(replicaA, firstId);

    let replicaB = { ...base, nodeId: 'node_phone' };
    const secondId = Object.keys(replicaB.tasks)[1];
    replicaB = triageTask(replicaB, secondId, true, false);
    replicaB = addTask(replicaB, 'Buy coffee filters #q3 ~10m');

    let replicaC = { ...base, nodeId: 'node_tablet' };
    replicaC = deleteTask(replicaC, firstId);
    replicaC = addTask(replicaC, 'Watch classic movie #q4');

    const verification = verifySemilatticeLaws(replicaA, replicaB, replicaC);
    expect(verification.idempotent).toBe(true);
    expect(verification.commutative).toBe(true);
    expect(verification.associative).toBe(true);

    const allMerged = mergeAppState(mergeAppState(replicaA, replicaB), replicaC);
    const titles = Object.values(allMerged.tasks).map((t) => t.title);
    expect(titles).toContain('Implement Raft leader election');
    expect(titles).toContain('Buy coffee filters');
    expect(titles).toContain('Watch classic movie');
  });

  it('converges starter state across two fresh devices without duplicating tasks', () => {
    const phone = createStarterState('node_phone');
    const laptop = createStarterState('node_laptop');
    const merged = mergeAppState(phone, laptop);
    expect(Object.keys(merged.tasks).length).toBe(7);
  });

  it('correctly routes Rapid 2-Decision Binary Triage (Important x Urgent -> Q1..Q4)', () => {
    expect(resolveQuadrant(true, true)).toBe('Q1');
    expect(resolveQuadrant(true, false)).toBe('Q2');
    expect(resolveQuadrant(false, true)).toBe('Q3');
    expect(resolveQuadrant(false, false)).toBe('Q4');
  });

  it('parses shorthand DSL tokens safely without eating math +1 or invalid due dates', () => {
    const parsed = parseQuickInput(
      'Finish compilers lab +1 #q2 +mrjp +mimuw due:2026-11-15 ~90m'
    );
    expect(parsed.cleanTitle).toBe('Finish compilers lab +1');
    expect(parsed.quadrant).toBe('Q2');
    expect(parsed.tags).toEqual(['mrjp', 'mimuw']);
    expect(parsed.dueDate).toBe('2026-11-15');
    expect(parsed.estimatedMinutes).toBe(90);

    // Invalid calendar date or unparsed token stays in title
    const unparsed = parseQuickInput('Submit assignment due:monday due:2026-99-99');
    expect(unparsed.dueDate).toBeUndefined();
    expect(unparsed.cleanTitle).toContain('due:monday');
    expect(unparsed.cleanTitle).toContain('due:2026-99-99');
  });

  it('escalates neglected Q2 tasks to Q1 when deadline is <= 36h away', () => {
    let state = createStarterState('node_test');
    const now = new Date('2026-11-07T18:00:00Z');
    state = addTask(state, 'Prepare exam cheatsheet #q2 due:2026-11-08');

    const { state: escalated, escalatedCount } = escalateNeglectedQ2Tasks(
      state,
      now.getTime()
    );
    expect(escalatedCount).toBe(1);

    const found = Object.values(escalated.tasks).find((t) =>
      t.title.includes('Prepare exam cheatsheet')
    );
    expect(found?.quadrant).toBe('Q1');
    expect(found?.escalatedFromQ2).toBe(true);
  });

  it('roundtrips Markdown export and import including completed status and quadrant badges', () => {
    let state = createStarterState('node_md');
    state = toggleTaskCompleted(state, 'starter_q2_workout');
    const md = serializeToMarkdown(state);
    expect(md).toContain('# Boron Q4 Matrix');
    expect(md).toContain('## Q2 • Important, Not Urgent');

    const parsedLines = parseMarkdownTaskLines(md);
    const workoutLine = parsedLines.find((l) => l.title.includes('Morning workout'));
    expect(workoutLine?.completed).toBe(true);
    expect(workoutLine?.quadrant).toBe('Q2');
  });

  it('preserves Multi-Value overlap on tied Lamport clocks, lets Edit beat Delete on ties, and forks deterministically', () => {
    const base = createStarterState('node_shared');
    const targetId = 'starter_inbox_crdt';

    const phone = moveTask({ ...base, nodeId: 'node_phone' }, targetId, 'Q2');
    const laptop = updateTaskDetails(
      { ...base, nodeId: 'node_laptop' },
      targetId,
      { title: 'Edited on Laptop', notes: 'Ch. 4' }
    );
    const tablet = deleteTask({ ...base, nodeId: 'z_tablet' }, targetId);

    const laws = verifySemilatticeLaws(phone, laptop, tablet);
    expect(laws.idempotent).toBe(true);
    expect(laws.commutative).toBe(true);
    expect(laws.associative).toBe(true);

    // Edit-Wins over Delete at tied Lamport clock
    const mergedWithDelete = mergeAppState(phone, tablet);
    expect(mergedWithDelete.tasks[targetId].deleted).toBeFalsy();

    // Multi-Value overlap between Phone and Laptop
    const merged = mergeAppState(phone, laptop);
    expect(merged.tasks[targetId].concurrentConflicts?.length).toBe(1);

    // Logging focus session clears stale conflicts and maintains Idempotence
    const afterFocus = logFocusSession(merged, 'Q2', 25, targetId);
    expect(
      verifySemilatticeLaws(afterFocus, phone, laptop).idempotent
    ).toBe(true);

    // Deterministic fork produces identical task ID on both devices
    const forkA = resolveTaskConflict(merged, targetId, 'FORK_OVERLAP');
    const forkB = resolveTaskConflict(merged, targetId, 'FORK_OVERLAP');
    const mergedForks = mergeAppState(forkA, forkB);
    expect(Object.keys(mergedForks.tasks).length).toBe(8);
  });
});
