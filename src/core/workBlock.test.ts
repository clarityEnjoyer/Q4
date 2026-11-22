import { describe, expect, it } from 'vitest';
import { addTask, createStarterState, reorderTask } from './engine';
import {
  autoPlanWorkBlock,
  computeWorkBlockSchedule,
  formatCountdown,
  formatDurationHours,
  getSmartRestDuration,
  moveWorkBlockItem,
  reconcileBreaks,
  resolveLogQuadrant,
  SCOPE_DESCRIPTIONS,
  SCOPE_QUADRANTS,
  WorkBlockItem,
} from './workBlock';

describe('Work Block Pure Planner & Schedule Engine', () => {
  it('computes smart break durations across task lengths', () => {
    expect(getSmartRestDuration(undefined)).toBe(3);
    expect(getSmartRestDuration(15)).toBe(3);
    expect(getSmartRestDuration(29)).toBe(3);
    expect(getSmartRestDuration(30)).toBe(5);
    expect(getSmartRestDuration(44)).toBe(5);
    expect(getSmartRestDuration(45)).toBe(10);
    expect(getSmartRestDuration(90)).toBe(10);
  });

  it('auto-plans tasks within time budget respecting custom Matrix order and scopes', () => {
    let state = createStarterState('node_wb');
    state = addTask(state, 'Q2 Top Priority ~30m', 'Q2', { id: 'q2_top', estimatedMinutes: 30 });
    state = reorderTask(state, 'q2_top', 'Q2', 0);

    const allTasks = Object.values(state.tasks);

    // Budget 90m, Q2_ONLY, includeBreaks: true
    // q2_top (30m) + 5m rest + starter_q2_workout (45m) = 80m <= 90m; next is starter_q2_asd (60m) which exceeds
    const q2Only = autoPlanWorkBlock(allTasks, 90, { scope: 'Q2_ONLY', includeBreaks: true });
    expect(q2Only.map((i) => (i.type === 'task' ? i.taskId : `rest:${i.durationMinutes}`))).toEqual([
      'q2_top',
      'rest:5',
      'starter_q2_workout',
    ]);

    // Q2_FIRST with larger budget 240m includes Q2 then Q1 then Q3/Q4
    const q2First = autoPlanWorkBlock(allTasks, 240, { scope: 'Q2_FIRST', includeBreaks: false });
    const q2FirstIds = q2First.map((i) => (i.type === 'task' ? i.taskId : 'rest'));
    expect(q2FirstIds[0]).toBe('q2_top');
    expect(q2FirstIds).toContain('starter_q1_so');
    expect(q2FirstIds).toContain('starter_q3_parcel');

    // Q1_Q2 schedules Q1 urgent tasks strictly before Q2 and excludes Q3/Q4
    const q1q2 = autoPlanWorkBlock(allTasks, 300, { scope: 'Q1_Q2', includeBreaks: false });
    const q1q2Ids = q1q2.map((i) => (i.type === 'task' ? i.taskId : 'rest'));
    expect(q1q2Ids[0]).toBe('starter_q1_so');
    expect(q1q2Ids.indexOf('starter_q1_so')).toBeLessThan(q1q2Ids.indexOf('q2_top'));
    expect(q1q2Ids).toContain('q2_top');
    expect(q1q2Ids).not.toContain('starter_q3_parcel');
    expect(SCOPE_QUADRANTS.Q1_Q2).toEqual(['Q1', 'Q2']);
    expect(SCOPE_DESCRIPTIONS.Q1_Q2).toContain('Q1');

    // Tight budget (10m) still yields at least the top-priority task (non-empty fallback)
    const tight = autoPlanWorkBlock(allTasks, 10, { scope: 'Q2_ONLY', includeBreaks: true });
    expect(tight.length).toBe(1);
    expect(tight[0].type).toBe('task');
  });

  it('reconciles breaks cleanly without leading, trailing, or duplicate breaks', () => {
    const state = createStarterState('node_breaks');
    const messy: WorkBlockItem[] = [
      { id: 'r0', type: 'rest', durationMinutes: 5 },
      { id: 't1', type: 'task', taskId: 'starter_q2_workout' }, // 45m -> 10m break
      { id: 'r1', type: 'rest', durationMinutes: 3 },
      { id: 'r2', type: 'rest', durationMinutes: 3 },
      { id: 't2', type: 'task', taskId: 'starter_q3_parcel' }, // 15m
      { id: 'r3', type: 'rest', durationMinutes: 10 },
      { id: 'ghost', type: 'task', taskId: 'non_existent' },
    ];

    const withBreaks = reconcileBreaks(messy, state.tasks, true);
    expect(withBreaks.map((i) => (i.type === 'task' ? i.taskId : `rest:${i.durationMinutes}`))).toEqual([
      'starter_q2_workout',
      'rest:10',
      'starter_q3_parcel',
    ]);

    const withoutBreaks = reconcileBreaks(withBreaks, state.tasks, false);
    expect(withoutBreaks.map((i) => (i.type === 'task' ? i.taskId : 'rest'))).toEqual([
      'starter_q2_workout',
      'starter_q3_parcel',
    ]);
  });

  it('computes schedule totals, end times, Q2 share, and handles item moves', () => {
    const state = createStarterState('node_sched');
    const startMs = new Date('2026-11-22T09:00:00Z').getTime();
    const queue: WorkBlockItem[] = [
      { id: 'i1', type: 'task', taskId: 'starter_q2_workout' }, // 45m Q2
      { id: 'r1', type: 'rest', durationMinutes: 10 }, // 10m rest
      { id: 'i2', type: 'task', taskId: 'starter_q1_so' }, // 45m Q1
    ];

    const sched = computeWorkBlockSchedule(queue, state.tasks, startMs);
    expect(sched.workMinutes).toBe(90);
    expect(sched.restMinutes).toBe(10);
    expect(sched.totalMinutes).toBe(100);
    expect(sched.q2WorkMinutes).toBe(45);
    expect(sched.q2SharePct).toBe(50);
    expect(sched.endMs).toBe(startMs + 100 * 60_000);
    expect(sched.slots[1].startMs).toBe(startMs + 45 * 60_000);
    expect(sched.slots[1].endMs).toBe(startMs + 55 * 60_000);

    const moved = moveWorkBlockItem(queue, 2, 0);
    expect(moved[0].id).toBe('i2');
    expect(moved[1].id).toBe('i1');
    expect(moveWorkBlockItem(queue, -1, 0)).toBe(queue);
  });

  it('formats durations, countdowns, and resolves log quadrants safely', () => {
    const state = createStarterState('node_fmt');
    expect(resolveLogQuadrant(state.tasks['starter_inbox_crdt'])).toBe('Q2');
    expect(resolveLogQuadrant(state.tasks['starter_q1_so'])).toBe('Q1');
    expect(resolveLogQuadrant(null)).toBe('Q2');

    expect(formatDurationHours(0)).toBe('0h');
    expect(formatDurationHours(90)).toBe('1.5h');
    expect(formatDurationHours(45)).toBe('0.75h');

    expect(formatCountdown(-5)).toBe('00:00');
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(65)).toBe('01:05');
  });
});
