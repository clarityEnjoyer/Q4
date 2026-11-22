import { formatMinutesAsDecimalHours, sortTasksInBlock } from './engine';
import { Quadrant, TaskItem } from './types';

export type WorkBlockItem =
  | { id: string; type: 'task'; taskId: string }
  | { id: string; type: 'rest'; durationMinutes: number };

export type WorkBlockScope = 'Q2_FIRST' | 'Q2_ONLY' | 'Q1_Q2';

export interface WorkBlockScheduleSlot {
  item: WorkBlockItem;
  index: number;
  durationMinutes: number;
  startMs: number;
  endMs: number;
  quadrant?: Quadrant;
  title: string;
}

export interface WorkBlockSchedule {
  slots: WorkBlockScheduleSlot[];
  totalMinutes: number;
  workMinutes: number;
  restMinutes: number;
  q2WorkMinutes: number;
  q2SharePct: number;
  endMs: number;
}

export interface WorkBlockDebrief {
  loggedMinutes: number;
  q2LoggedMinutes: number;
  completedTaskIds: string[];
  estimatedMinutesTotal: number;
  actualMinutesTotal: number;
}

export function getSmartRestDuration(taskMinutes?: number): number {
  const mins =
    taskMinutes !== undefined && Number.isFinite(taskMinutes) && taskMinutes > 0
      ? taskMinutes
      : 25;
  if (mins >= 45) return 10;
  if (mins >= 30) return 5;
  return 3;
}

export function getItemDurationMinutes(
  item: WorkBlockItem,
  tasks: Record<string, TaskItem>
): number {
  if (item.type === 'rest') {
    return Math.max(1, Math.round(item.durationMinutes || 3));
  }
  const task = tasks[item.taskId];
  if (task && task.estimatedMinutes && task.estimatedMinutes > 0) {
    return Math.round(task.estimatedMinutes);
  }
  return 25;
}

export function resolveLogQuadrant(
  task?: TaskItem | null
): Exclude<Quadrant, 'INBOX'> {
  if (!task || !task.quadrant || task.quadrant === 'INBOX') {
    return 'Q2';
  }
  return task.quadrant;
}

export function reconcileBreaks(
  queue: WorkBlockItem[],
  tasks: Record<string, TaskItem>,
  includeBreaks: boolean
): WorkBlockItem[] {
  const taskItems = queue.filter((item): item is Extract<WorkBlockItem, { type: 'task' }> => {
    if (item.type !== 'task') return false;
    const task = tasks[item.taskId];
    return Boolean(task && !task.deleted);
  });

  if (!includeBreaks || taskItems.length === 0) {
    return taskItems;
  }

  const result: WorkBlockItem[] = [];
  taskItems.forEach((item, idx) => {
    result.push(item);
    if (idx < taskItems.length - 1) {
      const taskDuration = getItemDurationMinutes(item, tasks);
      result.push({
        id: `wb-rest-${idx}-${item.taskId}`,
        type: 'rest',
        durationMinutes: getSmartRestDuration(taskDuration),
      });
    }
  });
  return result;
}

const SCOPE_QUADRANTS: Record<WorkBlockScope, Quadrant[]> = {
  Q2_ONLY: ['Q2'],
  Q2_FIRST: ['Q2', 'Q1', 'Q3', 'Q4'],
  Q1_Q2: ['Q2', 'Q1'],
};

export function autoPlanWorkBlock(
  tasks: TaskItem[],
  budgetMinutes: number,
  options: { scope: WorkBlockScope; includeBreaks: boolean }
): WorkBlockItem[] {
  const safeBudget = Math.max(1, Math.round(budgetMinutes));
  const allowedQuadrants = SCOPE_QUADRANTS[options.scope];
  const active = tasks.filter((t) => !t.deleted && !t.completed);

  const candidates: TaskItem[] = [];
  for (const quad of allowedQuadrants) {
    const inQuad = sortTasksInBlock(active.filter((t) => t.quadrant === quad));
    candidates.push(...inQuad);
  }

  if (candidates.length === 0) {
    return [];
  }

  const taskMap: Record<string, TaskItem> = {};
  for (const t of candidates) {
    taskMap[t.id] = t;
  }

  const selected: TaskItem[] = [];
  let usedMinutes = 0;

  for (const cand of candidates) {
    const dur =
      cand.estimatedMinutes && cand.estimatedMinutes > 0
        ? Math.round(cand.estimatedMinutes)
        : 25;
    const restCost =
      selected.length > 0 && options.includeBreaks
        ? getSmartRestDuration(selected[selected.length - 1].estimatedMinutes)
        : 0;
    if (usedMinutes + restCost + dur <= safeBudget) {
      selected.push(cand);
      usedMinutes += restCost + dur;
    }
  }

  if (selected.length === 0) {
    selected.push(candidates[0]);
  }

  const rawItems: WorkBlockItem[] = selected.map((t, i) => ({
    id: `wb-task-${t.id}-${i}`,
    type: 'task',
    taskId: t.id,
  }));

  return reconcileBreaks(rawItems, taskMap, options.includeBreaks);
}

export function computeWorkBlockSchedule(
  queue: WorkBlockItem[],
  tasks: Record<string, TaskItem>,
  startMs: number = Date.now()
): WorkBlockSchedule {
  let cursorMs = startMs;
  let workMinutes = 0;
  let restMinutes = 0;
  let q2WorkMinutes = 0;
  const slots: WorkBlockScheduleSlot[] = [];

  queue.forEach((item, index) => {
    const durationMinutes = getItemDurationMinutes(item, tasks);
    const slotStart = cursorMs;
    const slotEnd = cursorMs + durationMinutes * 60_000;
    cursorMs = slotEnd;

    if (item.type === 'rest') {
      restMinutes += durationMinutes;
      slots.push({
        item,
        index,
        durationMinutes,
        startMs: slotStart,
        endMs: slotEnd,
        title: `Rest Break (${durationMinutes}m)`,
      });
    } else {
      const task = tasks[item.taskId];
      const quadrant: Quadrant = task?.quadrant || 'Q2';
      workMinutes += durationMinutes;
      if (quadrant === 'Q2') {
        q2WorkMinutes += durationMinutes;
      }
      slots.push({
        item,
        index,
        durationMinutes,
        startMs: slotStart,
        endMs: slotEnd,
        quadrant,
        title: task?.title || '(Missing task)',
      });
    }
  });

  const totalMinutes = workMinutes + restMinutes;
  const q2SharePct =
    workMinutes > 0 ? Math.round((q2WorkMinutes / workMinutes) * 100) : 0;

  return {
    slots,
    totalMinutes,
    workMinutes,
    restMinutes,
    q2WorkMinutes,
    q2SharePct,
    endMs: cursorMs,
  };
}

export function moveWorkBlockItem(
  queue: WorkBlockItem[],
  fromIndex: number,
  toIndex: number
): WorkBlockItem[] {
  if (
    fromIndex < 0 ||
    fromIndex >= queue.length ||
    toIndex < 0 ||
    toIndex >= queue.length ||
    fromIndex === toIndex
  ) {
    return queue;
  }
  const copy = [...queue];
  const [moved] = copy.splice(fromIndex, 1);
  copy.splice(toIndex, 0, moved);
  return copy;
}

export function formatDurationHours(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0h';
  return `${formatMinutesAsDecimalHours(minutes)}h`;
}

export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = String(Math.floor(safe / 60)).padStart(2, '0');
  const s = String(safe % 60).padStart(2, '0');
  return `${m}:${s}`;
}
