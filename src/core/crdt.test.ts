import { describe, expect, it } from 'vitest';
import { mergeAppState, verifySemilatticeLaws } from './crdt';
import {
  addSubtask,
  addTask,
  computeBoronAnalytics,
  createStarterState,
  deleteSubtask,
  deleteTask,
  escalateNeglectedQ2Tasks,
  logFocusSession,
  moveTask,
  parseQuickInput,
  resolveQuadrant,
  resolveTaskConflict,
  toggleSubtask,
  toggleTaskCompleted,
  triageTask,
  updateTaskDetails,
} from './engine';
import { parseMarkdownTaskLines, serializeToMarkdown } from './markdown';

describe('Boron Q4 CRDT Semilattice & Domain Engine', () => {
  it('satisfies Join-Semilattice laws (Idempotence, Commutativity, Associativity) under concurrent offline edits', () => {
    const base = createStarterState('node_base');

    let replicaA = { ...base, nodeId: 'node_laptop' };
    replicaA = addTask(replicaA, 'Implement Raft leader election ~90m', 'Q2');
    const firstId = Object.keys(replicaA.tasks)[0];
    replicaA = toggleTaskCompleted(replicaA, firstId);

    let replicaB = { ...base, nodeId: 'node_phone' };
    const secondId = Object.keys(replicaB.tasks)[1];
    replicaB = triageTask(replicaB, secondId, true, false);
    replicaB = addTask(replicaB, 'Buy coffee filters ~10m', 'Q3');

    let replicaC = { ...base, nodeId: 'node_tablet' };
    replicaC = deleteTask(replicaC, firstId);
    replicaC = addTask(replicaC, 'Watch classic movie', 'Q4');

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

  it('parses shorthand DSL tokens (~90m) safely and leaves unparsed tokens in cleanTitle', () => {
    const parsed = parseQuickInput(
      'Finish compilers lab +1 #q2 +mrjp +mimuw due:2026-11-15 ~90m'
    );
    expect(parsed.cleanTitle).toBe('Finish compilers lab +1 #q2 +mrjp +mimuw due:2026-11-15');
    expect(parsed.quadrant).toBeUndefined();
    expect(parsed.tags).toEqual([]);
    expect(parsed.dueDate).toBeUndefined();
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
    state = addTask(state, 'Prepare exam cheatsheet', 'Q2', { dueDate: '2026-11-08' });

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
    state = addSubtask(state, 'starter_q2_workout', '20 pushups');
    const md = serializeToMarkdown(state);
    expect(md).toContain('# Boron Q4 Matrix');
    expect(md).toContain('## Completed');
    expect(md).toContain('  - [ ] 20 pushups');

    const parsedLines = parseMarkdownTaskLines(md);
    const workoutLine = parsedLines.find((l) => l.title.includes('Morning workout'));
    expect(workoutLine?.completed).toBe(true);
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

  it('supports subtask operations (addSubtask, toggleSubtask, deleteSubtask) and preserves semilattice laws under concurrent edits', () => {
    const base = createStarterState('node_base');
    const taskId = 'starter_inbox_crdt';

    let state = addSubtask(base, taskId, 'Subtask Alpha');
    state = addSubtask(state, taskId, 'Subtask Beta');
    expect(state.tasks[taskId].checklist?.length).toBe(2);
    const subAlphaId = state.tasks[taskId].checklist![0].id;
    const subBetaId = state.tasks[taskId].checklist![1].id;

    state = toggleSubtask(state, taskId, subAlphaId);
    expect(state.tasks[taskId].checklist![0].done).toBe(true);
    expect(state.tasks[taskId].checklist![1].done).toBe(false);

    state = deleteSubtask(state, taskId, subBetaId);
    expect(state.tasks[taskId].checklist?.length).toBe(1);
    expect(state.tasks[taskId].checklist![0].text).toBe('Subtask Alpha');

    let replicaA = { ...state, nodeId: 'node_a' };
    replicaA = addSubtask(replicaA, taskId, 'Subtask from A');

    let replicaB = { ...state, nodeId: 'node_b' };
    replicaB = toggleSubtask(replicaB, taskId, subAlphaId);

    let replicaC = { ...state, nodeId: 'node_c' };
    replicaC = addSubtask(replicaC, taskId, 'Subtask from C');

    const verification = verifySemilatticeLaws(replicaA, replicaB, replicaC);
    expect(verification.idempotent).toBe(true);
    expect(verification.commutative).toBe(true);
    expect(verification.associative).toBe(true);

    const merged = mergeAppState(mergeAppState(replicaA, replicaB), replicaC);
    expect(merged.tasks[taskId]).toBeDefined();
  });

  it('verifies computeBoronAnalytics returns 30 items in history30d and computes morningStreakDays', () => {
    const base = createStarterState('node_streak');
    const now = new Date('2026-11-08T12:00:00Z');

    const initialAnalytics = computeBoronAnalytics(base, now);
    expect(initialAnalytics.history30d?.length).toBe(30);
    expect(initialAnalytics.history30d?.[29].date).toBe('2026-11-08');
    expect(initialAnalytics.morningStreakDays).toBe(0);

    let state = base;
    const dayMs = 24 * 60 * 60 * 1000;
    const timeNov6 = now.getTime() - 2 * dayMs;

    state = {
      ...state,
      focusSessions: {
        ...state.focusSessions,
        s_nov6: {
          id: 's_nov6',
          quadrant: 'Q2',
          durationMinutes: 45,
          startedAt: timeNov6 - 45 * 60_000,
          endedAt: timeNov6,
          nodeId: 'node_streak',
        },
        s_nov7: {
          id: 's_nov7',
          quadrant: 'Q2',
          durationMinutes: 30,
          startedAt: (now.getTime() - dayMs) - 30 * 60_000,
          endedAt: now.getTime() - dayMs,
          nodeId: 'node_streak',
        },
      },
    };

    const streakYesterday = computeBoronAnalytics(state, now);
    expect(streakYesterday.morningStreakDays).toBe(2);

    state = {
      ...state,
      tasks: {
        ...state.tasks,
        t_today_q2: {
          id: 't_today_q2',
          title: 'Daily Q2 task',
          quadrant: 'Q2',
          completed: true,
          completedAt: now.getTime(),
          createdAt: now.getTime() - 60_000,
          focusMinutesLogged: 0,
          tags: [],
          clock: { lamport: 10, wallTime: now.getTime(), nodeId: 'node_streak' },
        },
      },
    };

    const streakToday = computeBoronAnalytics(state, now);
    expect(streakToday.morningStreakDays).toBe(3);
    expect(streakToday.history30d?.[29].completedQ2Count).toBe(1);
    expect(streakToday.history30d?.[29].boronIndex).toBe(100);
  });
});
