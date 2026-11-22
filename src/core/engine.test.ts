import { describe, expect, it } from 'vitest';
import {
  addTask,
  calculateOffsetDate,
  completeTaskWithTime,
  computeBoronAnalytics,
  createStarterState,
  escalateNeglectedQ2Tasks,
  formatMinutesAsDecimalHours,
  logFocusSession,
  parseDecimalHours,
  reorderTask,
  sortTasksInBlock,
  toggleTaskCompleted,
} from './engine';
import { parseMarkdownTaskLines, serializeToMarkdown } from './markdown';
import { AppState } from './types';
import { THEME_REGISTRY } from '../visuals/themes';
import { ANALYTICS_WIDGET_REGISTRY } from '../visuals/analyticsWidgets';
import { loadVisualPrefs } from '../sync/storage';

describe('Boron Q4 Engine: Ordering, Capture, Time Tracking & Analytics', () => {
  it('parses and formats decimal hours cleanly', () => {
    expect(parseDecimalHours('0.25')).toBe(15);
    expect(parseDecimalHours('0,5')).toBe(30);
    expect(parseDecimalHours('1.5')).toBe(90);
    expect(parseDecimalHours('0.29')).toBe(17);
    expect(parseDecimalHours('')).toBeUndefined();
    expect(parseDecimalHours('0')).toBeUndefined();
    expect(parseDecimalHours('-1')).toBeUndefined();
    expect(parseDecimalHours('abc')).toBeUndefined();

    expect(formatMinutesAsDecimalHours(15)).toBe('0.25');
    expect(formatMinutesAsDecimalHours(30)).toBe('0.5');
    expect(formatMinutesAsDecimalHours(60)).toBe('1');
    expect(formatMinutesAsDecimalHours(90)).toBe('1.5');
    expect(formatMinutesAsDecimalHours(20)).toBe('0.33');
    expect(formatMinutesAsDecimalHours(0)).toBe('');
    expect(formatMinutesAsDecimalHours(undefined)).toBe('');
  });

  it('calculates DST-safe and leap-year-safe date offsets', () => {
    const base = new Date(2024, 1, 28); // Feb 28 2024 (leap year)
    expect(calculateOffsetDate(1, base).iso).toBe('2024-02-29');
    expect(calculateOffsetDate(2, base).iso).toBe('2024-03-01');
  });

  it('reorders tasks intra-block (top, middle, bottom) and preserves clock on no-op', () => {
    let state = createStarterState('node_order');
    state = addTask(state, 'Task One', 'Q1', { id: 't1' });
    state = addTask(state, 'Task Two', 'Q1', { id: 't2' });
    state = addTask(state, 'Task Three', 'Q1', { id: 't3' });

    const initialQ1 = sortTasksInBlock(
      Object.values(state.tasks).filter((t) => !t.deleted && t.quadrant === 'Q1')
    );
    expect(initialQ1.map((t) => t.id)).toEqual(['starter_q1_so', 't1', 't2', 't3']);

    // Move t3 to top (index 0)
    state = reorderTask(state, 't3', 'Q1', 0);
    let ordered = sortTasksInBlock(
      Object.values(state.tasks).filter((t) => !t.deleted && t.quadrant === 'Q1')
    );
    expect(ordered.map((t) => t.id)).toEqual(['t3', 'starter_q1_so', 't1', 't2']);

    // Move starter_q1_so to bottom (index 3)
    state = reorderTask(state, 'starter_q1_so', 'Q1', 3);
    ordered = sortTasksInBlock(
      Object.values(state.tasks).filter((t) => !t.deleted && t.quadrant === 'Q1')
    );
    expect(ordered.map((t) => t.id)).toEqual(['t3', 't1', 't2', 'starter_q1_so']);

    // Move starter_q1_so to middle (index 1)
    state = reorderTask(state, 'starter_q1_so', 'Q1', 1);
    ordered = sortTasksInBlock(
      Object.values(state.tasks).filter((t) => !t.deleted && t.quadrant === 'Q1')
    );
    expect(ordered.map((t) => t.id)).toEqual(['t3', 'starter_q1_so', 't1', 't2']);

    // No-op drop at current index must not increment Lamport clock
    const lamportBeforeNoOp = state.maxLamport;
    const afterNoOp = reorderTask(state, 'starter_q1_so', 'Q1', 1);
    expect(afterNoOp).toBe(state);
    expect(afterNoOp.maxLamport).toBe(lamportBeforeNoOp);
  });

  it('reorders cross-quadrant at exact slot and rebalances tight gaps or legacy tasks without order', () => {
    let state: AppState = {
      schemaVersion: 1,
      nodeId: 'node_rebal',
      maxLamport: 2,
      tasks: {
        legacy_a: {
          id: 'legacy_a',
          title: 'Legacy A',
          quadrant: 'Q2',
          completed: false,
          createdAt: 1000,
          focusMinutesLogged: 0,
          clock: { lamport: 1, wallTime: 1000, nodeId: 'n' },
        },
        legacy_b: {
          id: 'legacy_b',
          title: 'Legacy B',
          quadrant: 'Q2',
          completed: false,
          createdAt: 2000,
          focusMinutesLogged: 0,
          clock: { lamport: 1, wallTime: 2000, nodeId: 'n' },
        },
        inbox_x: {
          id: 'inbox_x',
          title: 'Inbox X',
          quadrant: 'INBOX',
          completed: false,
          createdAt: 3000,
          focusMinutesLogged: 0,
          order: 1024,
          clock: { lamport: 2, wallTime: 3000, nodeId: 'n' },
        },
      },
      focusSessions: {},
    };

    // Cross-quadrant insert at index 1 between legacy_a and legacy_b triggers clean rebalance
    state = reorderTask(state, 'inbox_x', 'Q2', 1);
    const q2Ordered = sortTasksInBlock(
      Object.values(state.tasks).filter((t) => !t.deleted && t.quadrant === 'Q2')
    );
    expect(q2Ordered.map((t) => t.id)).toEqual(['legacy_a', 'inbox_x', 'legacy_b']);
    expect(q2Ordered.every((t) => typeof t.order === 'number')).toBe(true);

    // Force tiny gap <= 1e-4 and verify rebalance recovers distinct spacing
    state.tasks['legacy_a'].order = 100;
    state.tasks['inbox_x'].order = 100.00005;
    state = reorderTask(state, 'legacy_b', 'Q2', 1);
    const rebalanced = sortTasksInBlock(
      Object.values(state.tasks).filter((t) => !t.deleted && t.quadrant === 'Q2')
    );
    expect(rebalanced.map((t) => t.id)).toEqual(['legacy_a', 'legacy_b', 'inbox_x']);
    expect(rebalanced[1].order! - rebalanced[0].order!).toBe(1024);
  });

  it('completes task with actualMinutes, clears on uncomplete, and prevents double-counting in Boron Index', () => {
    const now = new Date('2026-11-22T10:00:00Z');
    const nowMs = now.getTime();
    let state: AppState = {
      schemaVersion: 1,
      nodeId: 'node_time',
      maxLamport: 0,
      tasks: {},
      focusSessions: {},
    };

    state = addTask(state, 'Deep Architecture ~60m', 'Q2', { id: 'q2_arch', estimatedMinutes: 60 });
    // Log 25m focus session linked to q2_arch
    state = logFocusSession(state, 'Q2', 25, 'q2_arch');
    // Override session endedAt to match test date `now`
    const sId = Object.keys(state.focusSessions)[0];
    state.focusSessions[sId] = { ...state.focusSessions[sId], endedAt: nowMs };

    // Complete task reporting actualMinutes = 40 -> total Q2 minutes must be 40 (25 session + 15 delta), NOT 65 or 85!
    state = completeTaskWithTime(state, 'q2_arch', 40, nowMs);
    expect(state.tasks['q2_arch'].completed).toBe(true);
    expect(state.tasks['q2_arch'].actualMinutes).toBe(40);

    const analytics = computeBoronAnalytics(state, now);
    expect(analytics.todayQ2Minutes).toBe(40);
    expect(analytics.history30d?.[29].q2Minutes).toBe(40);

    // If actualMinutes <= logged session minutes (e.g. 20m vs 25m logged), total stays 25m
    state = completeTaskWithTime(state, 'q2_arch', 20, nowMs);
    expect(computeBoronAnalytics(state, now).todayQ2Minutes).toBe(25);

    // Uncompleting clears actualMinutes and completedAt
    state = toggleTaskCompleted(state, 'q2_arch');
    expect(state.tasks['q2_arch'].completed).toBe(false);
    expect(state.tasks['q2_arch'].actualMinutes).toBeUndefined();
    expect(state.tasks['q2_arch'].completedAt).toBeUndefined();
  });

  it('serializes markdown in custom order with actual minutes and escalates neglected Q2 tasks', () => {
    let state = createStarterState('node_md');
    state = addTask(state, 'First Q2', 'Q2', { id: 'first_q2' });
    state = reorderTask(state, 'first_q2', 'Q2', 0);
    state = completeTaskWithTime(state, 'starter_q1_so', 55, 1700000500000);

    const md = serializeToMarkdown(state);
    const q2PosFirst = md.indexOf('First Q2');
    const q2PosWorkout = md.indexOf('Morning workout');
    expect(q2PosFirst).toBeGreaterThan(-1);
    expect(q2PosFirst).toBeLessThan(q2PosWorkout);
    expect(md).toContain('actual:55m');

    const parsed = parseMarkdownTaskLines(md);
    const completedSo = parsed.find((l) => l.title.includes('Operating Systems'));
    expect(completedSo?.completed).toBe(true);
    expect(completedSo?.title).not.toContain('actual:55m');

    const now = new Date('2026-11-22T12:00:00Z').getTime();
    state = addTask(state, 'Due soon', 'Q2', { id: 'due_q2', dueDate: '2026-11-23' });
    const { escalatedCount, state: escalated } = escalateNeglectedQ2Tasks(state, now);
    expect(escalatedCount).toBe(1);
    expect(escalated.tasks['due_q2'].quadrant).toBe('Q1');
  });

  it('sanitizes theme prefs and maintains cleaned registries', () => {
    expect(THEME_REGISTRY.map((t) => t.id)).toEqual([
      'boron-dark',
      'oled-midnight',
      'nord-frost',
    ]);
    expect(ANALYTICS_WIDGET_REGISTRY.map((w) => w.id)).toEqual([
      'boron-index-trend',
      'morning-streak',
      'crisis-prevention',
    ]);

    const orig = globalThis.localStorage;
    const store: Record<string, string> = {
      boron_q4_visual_prefs_v1: JSON.stringify({ themeId: 'warm-paper', density: 'compact' }),
    };
    globalThis.localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
      clear: () => {},
      key: () => null,
      length: 0,
    } as any;
    try {
      const prefs = loadVisualPrefs();
      expect(prefs.themeId).toBe('boron-dark');
      expect(prefs.density).toBe('compact');
    } finally {
      globalThis.localStorage = orig;
    }
  });
});
