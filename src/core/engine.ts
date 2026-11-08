import { nextClock } from './crdt';
import {
  AppState,
  FocusSession,
  Quadrant,
  QuadrantMeta,
  SubtaskItem,
  TaskItem,
} from './types';

export const QUADRANT_META: Record<Exclude<Quadrant, 'INBOX'>, QuadrantMeta> = {
  Q2: {
    id: 'Q2',
    title: 'Q2 • Important, Not Urgent',
    subtitle: 'Deep Work & Growth',
    important: true,
    urgent: false,
    boronAdvice:
      'Everything you do in Q2 helps avoid having to do so much in Q1.',
    accentColor: '#10b981',
  },
  Q1: {
    id: 'Q1',
    title: 'Q1 • Urgent & Important',
    subtitle: 'Crises & Deadlines',
    important: true,
    urgent: true,
    boronAdvice:
      'Handle fires fast, then create a Q2 system so they do not recur.',
    accentColor: '#ef4444',
  },
  Q3: {
    id: 'Q3',
    title: 'Q3 • Urgent, Not Important',
    subtitle: 'Interruptions & Chores',
    important: false,
    urgent: true,
    boronAdvice: 'Batch quickly after Q2 is done.',
    accentColor: '#f59e0b',
  },
  Q4: {
    id: 'Q4',
    title: 'Q4 • Not Urgent, Not Important',
    subtitle: 'Rest & Leisure',
    important: false,
    urgent: false,
    boronAdvice: 'Guilt-free rest after daily Q2 work.',
    accentColor: '#64748b',
  },
};

export function resolveQuadrant(
  important: boolean,
  urgent: boolean
): Exclude<Quadrant, 'INBOX'> {
  if (important && !urgent) return 'Q2';
  if (important && urgent) return 'Q1';
  if (!important && urgent) return 'Q3';
  return 'Q4';
}

export function isValidISODate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return (
    dt.getFullYear() === y &&
    dt.getMonth() === m - 1 &&
    dt.getDate() === d
  );
}

export interface ParsedQuickInput {
  cleanTitle: string;
  quadrant?: Quadrant;
  tags: string[];
  dueDate?: string;
  estimatedMinutes?: number;
}

export function parseQuickInput(raw: string, _now: Date = new Date()): ParsedQuickInput {
  let text = raw.trim();
  let estimatedMinutes: number | undefined;

  // Match ~30m or ~2h
  text = text.replace(/(?:^|\s)~(\d+)(m|h)\b/gi, (fullMatch, num: string, unit: string) => {
    const val = parseInt(num, 10);
    if (val <= 0) return fullMatch;
    estimatedMinutes = unit.toLowerCase() === 'h' ? val * 60 : val;
    return ' ';
  });

  return {
    cleanTitle: text.replace(/\s+/g, ' ').trim(),
    quadrant: undefined,
    tags: [],
    dueDate: undefined,
    estimatedMinutes,
  };
}

export function formatDateISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function generateId(prefix = 't'): string {
  const rand = Math.random().toString(36).substring(2, 9);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

export function addTask(
  state: AppState,
  rawInput: string,
  defaultQuadrant: Quadrant = 'INBOX',
  extra?: Partial<
    Pick<
      TaskItem,
      | 'id'
      | 'dueDate'
      | 'preventsTaskId'
      | 'notes'
      | 'completed'
      | 'completedAt'
      | 'estimatedMinutes'
      | 'tags'
      | 'checklist'
    >
  >
): AppState {
  const parsed = parseQuickInput(rawInput);
  if (!parsed.cleanTitle) return state;

  const clock = nextClock(state);
  const id = extra?.id || generateId('task');
  const completed = Boolean(extra?.completed);
  const mergedTags = Array.from(new Set([...(parsed.tags || []), ...(extra?.tags || [])]));

  const task: TaskItem = {
    id,
    title: parsed.cleanTitle,
    notes: extra?.notes,
    quadrant: parsed.quadrant || defaultQuadrant,
    completed,
    completedAt: completed ? extra?.completedAt || clock.wallTime : undefined,
    createdAt: clock.wallTime,
    dueDate: extra?.dueDate || parsed.dueDate,
    estimatedMinutes: extra?.estimatedMinutes ?? parsed.estimatedMinutes,
    focusMinutesLogged: 0,
    preventsTaskId: extra?.preventsTaskId,
    tags: mergedTags,
    checklist: extra?.checklist ? extra.checklist.map((s) => ({ ...s })) : undefined,
    clock,
  };

  return {
    ...state,
    maxLamport: clock.lamport,
    tasks: {
      ...state.tasks,
      [id]: task,
    },
  };
}

export function triageTask(
  state: AppState,
  taskId: string,
  important: boolean,
  urgent: boolean
): AppState {
  const target = resolveQuadrant(important, urgent);
  return moveTask(state, taskId, target);
}

export function moveTask(
  state: AppState,
  taskId: string,
  quadrant: Quadrant
): AppState {
  const existing = state.tasks[taskId];
  if (!existing || existing.deleted) return state;

  const clock = nextClock(state);
  return {
    ...state,
    maxLamport: clock.lamport,
    tasks: {
      ...state.tasks,
      [taskId]: {
        ...existing,
        quadrant,
        concurrentConflicts: undefined,
        clock,
      },
    },
  };
}

export function updateTaskDetails(
  state: AppState,
  taskId: string,
  patch: Partial<
    Pick<
      TaskItem,
      'title' | 'dueDate' | 'estimatedMinutes' | 'notes' | 'tags' | 'checklist'
    >
  >
): AppState {
  const existing = state.tasks[taskId];
  if (!existing || existing.deleted) return state;

  const cleanTitle = patch.title !== undefined ? patch.title.trim() : existing.title;
  if (!cleanTitle) return state;

  const clock = nextClock(state);
  return {
    ...state,
    maxLamport: clock.lamport,
    tasks: {
      ...state.tasks,
      [taskId]: {
        ...existing,
        ...patch,
        title: cleanTitle,
        concurrentConflicts: undefined,
        clock,
      },
    },
  };
}

export function toggleTaskCompleted(state: AppState, taskId: string): AppState {
  const existing = state.tasks[taskId];
  if (!existing || existing.deleted) return state;

  const clock = nextClock(state);
  const completed = !existing.completed;
  return {
    ...state,
    maxLamport: clock.lamport,
    tasks: {
      ...state.tasks,
      [taskId]: {
        ...existing,
        completed,
        completedAt: completed ? clock.wallTime : undefined,
        concurrentConflicts: undefined,
        clock,
      },
    },
  };
}

/**
 * Resolves a Multi-Value CRDT concurrent overlap (`concurrentConflicts`) on a task:
 * - 'KEEP_PRIMARY': keeps the primary task state and clears `concurrentConflicts` at `lamport + 1`.
 * - 'FORK_OVERLAP': spawns each overlapping alternate version with a deterministic ID so both exist!
 */
export function resolveTaskConflict(
  state: AppState,
  taskId: string,
  strategy: 'KEEP_PRIMARY' | 'FORK_OVERLAP'
): AppState {
  const existing = state.tasks[taskId];
  if (!existing || !existing.concurrentConflicts?.length) return state;

  const clock = nextClock(state);
  let nextState: AppState = {
    ...state,
    maxLamport: clock.lamport,
    tasks: {
      ...state.tasks,
      [taskId]: {
        ...existing,
        concurrentConflicts: undefined,
        clock,
      },
    },
  };

  if (strategy === 'FORK_OVERLAP') {
    for (const alt of existing.concurrentConflicts) {
      const deterministicForkId = `${taskId}_fork_${alt.clock.nodeId}_${alt.clock.lamport}`;
      nextState = addTask(
        nextState,
        `${alt.title} (${alt.clock.nodeId})`,
        alt.quadrant,
        {
          id: deterministicForkId,
          dueDate: alt.dueDate,
          notes: alt.notes,
          completed: alt.completed,
          estimatedMinutes: alt.estimatedMinutes,
          tags: alt.tags,
          checklist: alt.checklist,
        }
      );
    }
  }

  return nextState;
}

export function deleteTask(state: AppState, taskId: string): AppState {
  const existing = state.tasks[taskId];
  if (!existing || existing.deleted) return state;

  const clock = nextClock(state);
  return {
    ...state,
    maxLamport: clock.lamport,
    tasks: {
      ...state.tasks,
      [taskId]: {
        ...existing,
        deleted: true,
        concurrentConflicts: undefined,
        clock,
      },
    },
  };
}

export function addSubtask(
  state: AppState,
  taskId: string,
  text: string
): AppState {
  const existing = state.tasks[taskId];
  if (!existing || existing.deleted) return state;

  const cleanText = text.trim();
  if (!cleanText) return state;

  const clock = nextClock(state);
  const newSubtask: SubtaskItem = {
    id: generateId('sub'),
    text: cleanText,
    done: false,
  };

  const checklist: SubtaskItem[] = [
    ...(existing.checklist || []).map((s) => ({ ...s })),
    newSubtask,
  ];

  return {
    ...state,
    maxLamport: clock.lamport,
    tasks: {
      ...state.tasks,
      [taskId]: {
        ...existing,
        checklist,
        concurrentConflicts: undefined,
        clock,
      },
    },
  };
}

export function toggleSubtask(
  state: AppState,
  taskId: string,
  subtaskId: string
): AppState {
  const existing = state.tasks[taskId];
  if (!existing || existing.deleted || !existing.checklist) return state;

  const found = existing.checklist.some((s) => s.id === subtaskId);
  if (!found) return state;

  const clock = nextClock(state);
  const checklist = existing.checklist.map((s) =>
    s.id === subtaskId ? { ...s, done: !s.done } : { ...s }
  );

  return {
    ...state,
    maxLamport: clock.lamport,
    tasks: {
      ...state.tasks,
      [taskId]: {
        ...existing,
        checklist,
        concurrentConflicts: undefined,
        clock,
      },
    },
  };
}

export function deleteSubtask(
  state: AppState,
  taskId: string,
  subtaskId: string
): AppState {
  const existing = state.tasks[taskId];
  if (!existing || existing.deleted || !existing.checklist) return state;

  const filtered = existing.checklist.filter((s) => s.id !== subtaskId);
  if (filtered.length === existing.checklist.length) return state;

  const clock = nextClock(state);
  return {
    ...state,
    maxLamport: clock.lamport,
    tasks: {
      ...state.tasks,
      [taskId]: {
        ...existing,
        checklist: filtered.map((s) => ({ ...s })),
        concurrentConflicts: undefined,
        clock,
      },
    },
  };
}

export function logFocusSession(
  state: AppState,
  quadrant: Exclude<Quadrant, 'INBOX'>,
  durationMinutes: number,
  taskId?: string
): AppState {
  const now = Date.now();
  const clock = nextClock(state, now);
  const sessionId = generateId('focus');
  const session: FocusSession = {
    id: sessionId,
    taskId,
    quadrant,
    durationMinutes,
    startedAt: now - durationMinutes * 60_000,
    endedAt: now,
    nodeId: state.nodeId,
  };

  let nextState: AppState = {
    ...state,
    maxLamport: clock.lamport,
    focusSessions: {
      ...state.focusSessions,
      [sessionId]: session,
    },
  };

  if (taskId && nextState.tasks[taskId]) {
    const existing = nextState.tasks[taskId];
    nextState = {
      ...nextState,
      tasks: {
        ...nextState.tasks,
        [taskId]: {
          ...existing,
          focusMinutesLogged: (existing.focusMinutesLogged || 0) + durationMinutes,
          concurrentConflicts: undefined,
          clock,
        },
      },
    };
  }

  return nextState;
}

export function getHoursUntilDue(dueDate?: string, nowMs: number = Date.now()): number | null {
  if (!dueDate || !isValidISODate(dueDate)) return null;
  const target = new Date(`${dueDate}T23:59:59`).getTime();
  if (Number.isNaN(target)) return null;
  return (target - nowMs) / (1000 * 60 * 60);
}

export function escalateNeglectedQ2Tasks(
  state: AppState,
  nowMs: number = Date.now()
): { state: AppState; escalatedCount: number } {
  let current = state;
  let escalatedCount = 0;

  for (const task of Object.values(state.tasks)) {
    if (task.deleted || task.completed) continue;
    if (task.quadrant === 'Q2' && task.dueDate) {
      const hoursLeft = getHoursUntilDue(task.dueDate, nowMs);
      if (hoursLeft !== null && hoursLeft <= 36) {
        const clock = nextClock(current, nowMs);
        current = {
          ...current,
          maxLamport: clock.lamport,
          tasks: {
            ...current.tasks,
            [task.id]: {
              ...task,
              quadrant: 'Q1',
              escalatedFromQ2: true,
              concurrentConflicts: undefined,
              clock,
            },
          },
        };
        escalatedCount++;
      }
    }
  }

  return { state: current, escalatedCount };
}

export interface BoronHistoryPoint {
  date: string;
  q1Minutes: number;
  q2Minutes: number;
  q3Minutes: number;
  q4Minutes: number;
  boronIndex: number;
  completedQ2Count: number;
}

export interface BoronAnalytics {
  activeByQuadrant: Record<Quadrant, number>;
  completedByQuadrant: Record<Exclude<Quadrant, 'INBOX'>, number>;
  focusMinutesByQuadrant: Record<Exclude<Quadrant, 'INBOX'>, number>;
  q2CompletionRatio: number;
  q2FocusRatio: number;
  escalatedCrisesCount: number;
  preventiveQ2Count: number;
  didQ2Today: boolean;
  todayQ2Minutes: number;
  history30d?: BoronHistoryPoint[];
  morningStreakDays?: number;
}

export function computeBoronAnalytics(
  state: AppState,
  now: Date = new Date()
): BoronAnalytics {
  const activeByQuadrant: Record<Quadrant, number> = {
    INBOX: 0,
    Q1: 0,
    Q2: 0,
    Q3: 0,
    Q4: 0,
  };
  const completedByQuadrant: Record<Exclude<Quadrant, 'INBOX'>, number> = {
    Q1: 0,
    Q2: 0,
    Q3: 0,
    Q4: 0,
  };
  const focusMinutesByQuadrant: Record<Exclude<Quadrant, 'INBOX'>, number> = {
    Q1: 0,
    Q2: 0,
    Q3: 0,
    Q4: 0,
  };

  let escalatedCrisesCount = 0;
  let preventiveQ2Count = 0;
  const todayStr = formatDateISO(now);
  let didQ2Today = false;
  let todayQ2Minutes = 0;

  const dailyFocus = new Map<string, { q1: number; q2: number; q3: number; q4: number }>();
  const dailyCompletedQ2 = new Map<string, number>();
  const activeQ2Dates = new Set<string>();

  for (const task of Object.values(state.tasks)) {
    if (task.deleted) continue;
    if (task.escalatedFromQ2) escalatedCrisesCount++;
    if (task.preventsTaskId) preventiveQ2Count++;

    if (task.completed) {
      if (task.quadrant !== 'INBOX') {
        completedByQuadrant[task.quadrant]++;
      }
      if (task.completedAt) {
        const completedDateStr = formatDateISO(new Date(task.completedAt));
        if (task.quadrant === 'Q2') {
          dailyCompletedQ2.set(
            completedDateStr,
            (dailyCompletedQ2.get(completedDateStr) || 0) + 1
          );
          activeQ2Dates.add(completedDateStr);
          if (completedDateStr === todayStr) {
            didQ2Today = true;
          }
        }
      }
    } else {
      activeByQuadrant[task.quadrant]++;
    }
  }

  for (const session of Object.values(state.focusSessions || {})) {
    focusMinutesByQuadrant[session.quadrant] =
      (focusMinutesByQuadrant[session.quadrant] || 0) + session.durationMinutes;

    const sessionDateStr = formatDateISO(new Date(session.endedAt));
    const dayEntry = dailyFocus.get(sessionDateStr) || { q1: 0, q2: 0, q3: 0, q4: 0 };
    if (session.quadrant === 'Q1') dayEntry.q1 += session.durationMinutes;
    else if (session.quadrant === 'Q2') dayEntry.q2 += session.durationMinutes;
    else if (session.quadrant === 'Q3') dayEntry.q3 += session.durationMinutes;
    else if (session.quadrant === 'Q4') dayEntry.q4 += session.durationMinutes;
    dailyFocus.set(sessionDateStr, dayEntry);

    if (session.quadrant === 'Q2') {
      activeQ2Dates.add(sessionDateStr);
      if (sessionDateStr === todayStr) {
        didQ2Today = true;
        todayQ2Minutes += session.durationMinutes;
      }
    }
  }

  const totalCompleted =
    completedByQuadrant.Q1 +
    completedByQuadrant.Q2 +
    completedByQuadrant.Q3 +
    completedByQuadrant.Q4;
  const totalFocus =
    focusMinutesByQuadrant.Q1 +
    focusMinutesByQuadrant.Q2 +
    focusMinutesByQuadrant.Q3 +
    focusMinutesByQuadrant.Q4;

  const q2CompletionRatio =
    totalCompleted > 0
      ? Math.round((completedByQuadrant.Q2 / totalCompleted) * 100)
      : 0;
  const q2FocusRatio =
    totalFocus > 0
      ? Math.round((focusMinutesByQuadrant.Q2 / totalFocus) * 100)
      : 0;

  // History 30d (oldest first, 30 calendar days ending at now)
  const history30d: BoronHistoryPoint[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const dateStr = formatDateISO(d);
    const dayFocus = dailyFocus.get(dateStr) || { q1: 0, q2: 0, q3: 0, q4: 0 };
    const completedQ2Count = dailyCompletedQ2.get(dateStr) || 0;

    let q1Sum = 0;
    let q2Sum = 0;
    for (let offset = 0; offset < 7; offset++) {
      const windowDate = new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset);
      const windowDateStr = formatDateISO(windowDate);
      const wFocus = dailyFocus.get(windowDateStr);
      if (wFocus) {
        q1Sum += wFocus.q1;
        q2Sum += wFocus.q2;
      }
    }

    const boronIndex =
      q1Sum + q2Sum === 0
        ? completedQ2Count > 0
          ? 100
          : 0
        : Math.round((q2Sum / (q1Sum + q2Sum)) * 100);

    history30d.push({
      date: dateStr,
      q1Minutes: dayFocus.q1,
      q2Minutes: dayFocus.q2,
      q3Minutes: dayFocus.q3,
      q4Minutes: dayFocus.q4,
      boronIndex,
      completedQ2Count,
    });
  }

  // Morning Streak: count consecutive days ending today (or yesterday if today is not yet active)
  // where the user logged a Q2 focus session or completed a Q2 task.
  let streakCheckDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!activeQ2Dates.has(todayStr)) {
    streakCheckDate.setDate(streakCheckDate.getDate() - 1);
  }

  let morningStreakDays = 0;
  while (activeQ2Dates.has(formatDateISO(streakCheckDate))) {
    morningStreakDays++;
    streakCheckDate.setDate(streakCheckDate.getDate() - 1);
  }

  return {
    activeByQuadrant,
    completedByQuadrant,
    focusMinutesByQuadrant,
    q2CompletionRatio,
    q2FocusRatio,
    escalatedCrisesCount,
    preventiveQ2Count,
    didQ2Today,
    todayQ2Minutes,
    history30d,
    morningStreakDays,
  };
}

/**
 * Generates deterministic starter state so fresh installs on multiple devices
 * converge without duplicating starter tasks upon first sync.
 */
export function createStarterState(nodeId: string): AppState {
  const genesisClock = {
    lamport: 1,
    wallTime: 1700000000000,
    nodeId: 'genesis',
  };

  const starterItems: Array<{
    id: string;
    title: string;
    quadrant: Quadrant;
    tags: string[];
    estimatedMinutes?: number;
  }> = [
    {
      id: 'starter_inbox_crdt',
      title: 'Review lecture notes on CRDTs & Distributed Consensus',
      quadrant: 'INBOX',
      tags: ['mimuw'],
      estimatedMinutes: 30,
    },
    {
      id: 'starter_inbox_chat',
      title: 'Answer non-urgent Discord messages from study group',
      quadrant: 'INBOX',
      tags: ['social'],
      estimatedMinutes: 10,
    },
    {
      id: 'starter_q2_workout',
      title: 'Morning workout / 5km run (prevents health Q1 crises)',
      quadrant: 'Q2',
      tags: ['health'],
      estimatedMinutes: 45,
    },
    {
      id: 'starter_q2_asd',
      title: 'Solve ASD dynamic programming practice set early',
      quadrant: 'Q2',
      tags: ['mimuw'],
      estimatedMinutes: 60,
    },
    {
      id: 'starter_q1_so',
      title: 'Submit Operating Systems (SO) kernel patch before deadline',
      quadrant: 'Q1',
      tags: ['mimuw'],
      estimatedMinutes: 45,
    },
    {
      id: 'starter_q3_parcel',
      title: 'Pick up package before parcel locker expires at 18:00',
      quadrant: 'Q3',
      tags: ['errands'],
      estimatedMinutes: 15,
    },
    {
      id: 'starter_q4_lem',
      title: 'Read a classic sci-fi novel (Stanisław Lem) after Q2 is done',
      quadrant: 'Q4',
      tags: ['leisure'],
    },
  ];

  const tasks: Record<string, TaskItem> = {};
  starterItems.forEach((item, idx) => {
    tasks[item.id] = {
      id: item.id,
      title: item.title,
      quadrant: item.quadrant,
      completed: false,
      createdAt: genesisClock.wallTime + idx,
      estimatedMinutes: item.estimatedMinutes,
      focusMinutesLogged: 0,
      tags: item.tags,
      clock: genesisClock,
    };
  });

  return {
    schemaVersion: 1,
    nodeId,
    maxLamport: 1,
    tasks,
    focusSessions: {},
  };
}
