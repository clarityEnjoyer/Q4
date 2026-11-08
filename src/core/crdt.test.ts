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
import { AppState } from './types';
import { THEME_REGISTRY } from '../visuals/themes';
import { loadVisualPrefs } from '../sync/storage';
import { ANALYTICS_WIDGET_REGISTRY } from '../visuals/analyticsWidgets';

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

  it('verifies warm-paper theme is removed and theme preferences sanitize to boron-dark', () => {
    // warm-paper must not exist in THEME_REGISTRY
    expect(THEME_REGISTRY.some((t) => t.id === 'warm-paper')).toBe(false);
    expect(THEME_REGISTRY.map((t) => t.id)).toEqual([
      'boron-dark',
      'oled-midnight',
      'nord-frost',
    ]);

    // Test sanitization of stale warm-paper preference
    const storageMock: Record<string, string> = {
      boron_q4_visual_prefs_v1: JSON.stringify({
        themeId: 'warm-paper',
        density: 'comfortable',
      }),
    };
    const originalLocalStorage = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (key: string) => storageMock[key] ?? null,
      setItem: (key: string, val: string) => {
        storageMock[key] = val;
      },
      removeItem: (key: string) => {
        delete storageMock[key];
      },
      clear: () => {
        Object.keys(storageMock).forEach((k) => delete storageMock[k]);
      },
      key: () => null,
      length: 0,
    } as any;

    try {
      const prefs = loadVisualPrefs();
      // Must fallback to boron-dark
      expect(prefs.themeId).toBe('boron-dark');
      expect(prefs.density).toBe('comfortable');

      // Valid theme persists
      storageMock.boron_q4_visual_prefs_v1 = JSON.stringify({
        themeId: 'oled-midnight',
        density: 'compact',
      });
      const validPrefs = loadVisualPrefs();
      expect(validPrefs.themeId).toBe('oled-midnight');
      expect(validPrefs.density).toBe('compact');
    } finally {
      globalThis.localStorage = originalLocalStorage;
    }
  });

  it('verifies quadrant-distribution widget is removed from registry', () => {
    // quadrant-distribution must not exist in ANALYTICS_WIDGET_REGISTRY
    expect(
      ANALYTICS_WIDGET_REGISTRY.some((w) => w.id === 'quadrant-distribution')
    ).toBe(false);
    expect(ANALYTICS_WIDGET_REGISTRY.map((w) => w.id)).toEqual([
      'boron-index-trend',
      'morning-streak',
      'crisis-prevention',
    ]);
  });

  it('computes Boron Index factoring in completed task estimated minutes additively with focus sessions', () => {
    const base = createStarterState('node_boron_calc');
    const now = new Date('2026-11-08T14:00:00Z');
    const todayMs = now.getTime();

    // Setup tasks:
    // - completed Q2 task with 60 estimated minutes completed today
    // - completed Q1 task with 30 estimated minutes completed today
    // - uncompleted Q1 task with 90 estimated minutes (must NOT be counted)
    // - completed INBOX task with 120 estimated minutes (must NOT be counted in quadrant focus)
    // - deleted completed Q2 task with 50 estimated minutes (must NOT be counted)
    let state: AppState = {
      ...base,
      tasks: {
        t_q2_comp: {
          id: 't_q2_comp',
          title: 'Deep Q2 task',
          quadrant: 'Q2',
          completed: true,
          completedAt: todayMs,
          createdAt: todayMs - 3600_000,
          estimatedMinutes: 60,
          focusMinutesLogged: 0,
          clock: { lamport: 2, wallTime: todayMs, nodeId: 'node_boron_calc' },
        },
        t_q1_comp: {
          id: 't_q1_comp',
          title: 'Urgent Q1 crisis completed',
          quadrant: 'Q1',
          completed: true,
          completedAt: todayMs,
          createdAt: todayMs - 1800_000,
          estimatedMinutes: 30,
          focusMinutesLogged: 0,
          clock: { lamport: 3, wallTime: todayMs, nodeId: 'node_boron_calc' },
        },
        t_q1_uncompleted: {
          id: 't_q1_uncompleted',
          title: 'Active Q1 task',
          quadrant: 'Q1',
          completed: false,
          createdAt: todayMs - 1000,
          estimatedMinutes: 90,
          focusMinutesLogged: 0,
          clock: { lamport: 4, wallTime: todayMs, nodeId: 'node_boron_calc' },
        },
        t_inbox_comp: {
          id: 't_inbox_comp',
          title: 'Completed Inbox item',
          quadrant: 'INBOX',
          completed: true,
          completedAt: todayMs,
          createdAt: todayMs - 1000,
          estimatedMinutes: 120,
          focusMinutesLogged: 0,
          clock: { lamport: 5, wallTime: todayMs, nodeId: 'node_boron_calc' },
        },
        t_deleted_q2: {
          id: 't_deleted_q2',
          title: 'Deleted Q2 task',
          quadrant: 'Q2',
          completed: true,
          completedAt: todayMs,
          createdAt: todayMs - 1000,
          estimatedMinutes: 50,
          focusMinutesLogged: 0,
          deleted: true,
          clock: { lamport: 6, wallTime: todayMs, nodeId: 'node_boron_calc' },
        },
      },
    };

    const analyticsBeforeSession = computeBoronAnalytics(state, now);
    const todayHistory = analyticsBeforeSession.history30d?.[29];
    expect(todayHistory).toBeDefined();
    expect(todayHistory?.q2Minutes).toBe(60);
    expect(todayHistory?.q1Minutes).toBe(30);
    expect(todayHistory?.q3Minutes).toBe(0);
    expect(todayHistory?.q4Minutes).toBe(0);
    // Boron Index: 60 / (30 + 60) = 66.666...% -> 67%
    expect(todayHistory?.boronIndex).toBe(67);
    expect(analyticsBeforeSession.todayQ2Minutes).toBe(60);

    // Now add a focus session in Q2 for 30 minutes
    state = {
      ...state,
      focusSessions: {
        s_focus_q2: {
          id: 's_focus_q2',
          quadrant: 'Q2',
          durationMinutes: 30,
          startedAt: todayMs - 30 * 60_000,
          endedAt: todayMs,
          nodeId: 'node_boron_calc',
        },
      },
    };

    const analyticsAfterSession = computeBoronAnalytics(state, now);
    const todayCombined = analyticsAfterSession.history30d?.[29];
    // Q2 should now be 60 (completed task) + 30 (session) = 90 min
    expect(todayCombined?.q2Minutes).toBe(90);
    expect(todayCombined?.q1Minutes).toBe(30);
    // Boron Index: 90 / (30 + 90) = 75%
    expect(todayCombined?.boronIndex).toBe(75);
    expect(analyticsAfterSession.todayQ2Minutes).toBe(90);
  });
});
