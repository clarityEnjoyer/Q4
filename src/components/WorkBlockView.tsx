import { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  formatClock24h,
  formatMinutesAsDecimalHours,
  parseDecimalHours,
  sortTasksInBlock,
} from '../core/engine';
import { AppState, Quadrant, SubtaskItem, TaskItem } from '../core/types';
import {
  autoPlanWorkBlock,
  computeWorkBlockSchedule,
  formatCountdown,
  formatDurationHours,
  getItemDurationMinutes,
  moveWorkBlockItem,
  reconcileBreaks,
  resolveLogQuadrant,
  SCOPE_DESCRIPTIONS,
  SCOPE_QUADRANTS,
  WorkBlockDebrief,
  WorkBlockItem,
  WorkBlockScope,
} from '../core/workBlock';

export interface WorkBlockViewProps {
  state: AppState;
  focusRequestTaskId: string | null;
  onClearFocusRequest: () => void;
  onLogFocusSession: (
    quadrant: Exclude<Quadrant, 'INBOX'>,
    durationMinutes: number,
    taskId?: string
  ) => void;
  onRequestCompleteFromWorkBlock: (
    task: TaskItem,
    suggestedMinutes: number | undefined,
    onCompleted: (actualMinutes?: number) => void
  ) => void;
  onAddSubtask: (taskId: string, text: string, estimatedMinutes?: number) => void;
  onToggleSubtask: (taskId: string, subtaskId: string) => void;
  onUpdateSubtask: (
    taskId: string,
    subtaskId: string,
    patch: Partial<Pick<SubtaskItem, 'text' | 'estimatedMinutes'>>
  ) => void;
  onReorderSubtask: (taskId: string, fromIndex: number, toIndex: number) => void;
  onGoMatrix: () => void;
}

type WorkBlockPhase = 'PLAN' | 'FOCUS' | 'DEBRIEF';
type PickerTab = 'Q2' | 'Q1' | 'All';

interface PersistedWorkBlockPlan {
  queue: WorkBlockItem[];
  budgetMinutes: number;
  scope: WorkBlockScope;
  includeBreaks: boolean;
  soundEnabled: boolean;
}

const STORAGE_KEY = 'boron_work_block_plan_v2';
const DEFAULT_DOC_TITLE = 'Boron Q4 — Focus on Q2 First';
const BUDGET_PRESETS: Array<{ label: string; minutes: number }> = [
  { label: '45m', minutes: 45 },
  { label: '1.5h', minutes: 90 },
  { label: '2h', minutes: 120 },
  { label: '3h', minutes: 180 },
];
const SCOPE_OPTIONS: Array<{ value: WorkBlockScope; label: string }> = [
  { value: 'Q2_FIRST', label: 'Q2 First' },
  { value: 'Q2_ONLY', label: 'Q2 Only' },
  { value: 'Q1_Q2', label: 'Q1 → Q2' },
];

function createEmptyDebrief(): WorkBlockDebrief {
  return {
    loggedMinutes: 0,
    q2LoggedMinutes: 0,
    completedTaskIds: [],
    estimatedMinutesTotal: 0,
    actualMinutesTotal: 0,
  };
}

function isValidWorkBlockItem(raw: unknown): raw is WorkBlockItem {
  if (!raw || typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !obj.id) return false;
  if (obj.type === 'task') {
    return typeof obj.taskId === 'string' && obj.taskId.length > 0;
  }
  if (obj.type === 'rest') {
    return (
      typeof obj.durationMinutes === 'number' &&
      Number.isFinite(obj.durationMinutes) &&
      obj.durationMinutes > 0
    );
  }
  return false;
}

function loadPersistedPlan(): PersistedWorkBlockPlan {
  const defaults: PersistedWorkBlockPlan = {
    queue: [],
    budgetMinutes: 90,
    scope: 'Q2_FIRST',
    includeBreaks: true,
    soundEnabled: true,
  };

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<PersistedWorkBlockPlan>;
    if (!parsed || typeof parsed !== 'object') return defaults;

    const queue = Array.isArray(parsed.queue)
      ? parsed.queue.filter(isValidWorkBlockItem)
      : defaults.queue;
    const budgetMinutes =
      typeof parsed.budgetMinutes === 'number' &&
      Number.isFinite(parsed.budgetMinutes) &&
      parsed.budgetMinutes > 0
        ? Math.round(parsed.budgetMinutes)
        : defaults.budgetMinutes;
    const scope: WorkBlockScope =
      parsed.scope === 'Q2_FIRST' ||
      parsed.scope === 'Q2_ONLY' ||
      parsed.scope === 'Q1_Q2'
        ? parsed.scope
        : defaults.scope;
    const includeBreaks =
      typeof parsed.includeBreaks === 'boolean'
        ? parsed.includeBreaks
        : defaults.includeBreaks;
    const soundEnabled =
      typeof parsed.soundEnabled === 'boolean'
        ? parsed.soundEnabled
        : defaults.soundEnabled;

    return { queue, budgetMinutes, scope, includeBreaks, soundEnabled };
  } catch {
    return defaults;
  }
}

function savePersistedPlan(plan: PersistedWorkBlockPlan): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(plan));
  } catch {
    // Ignore storage quota or private mode errors
  }
}

function nextRestDuration(currentMinutes: number): number {
  if (currentMinutes === 3) return 5;
  if (currentMinutes === 5) return 10;
  return 3;
}

function playGentleChime(): void {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(528, now);
    osc.frequency.exponentialRampToValueAtTime(660, now + 0.35);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.14, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.8);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.85);

    window.setTimeout(() => {
      ctx.close().catch(() => {});
    }, 950);
  } catch {
    // Ignore audio restrictions
  }
}

function getFocusBadgeLabel(
  item: WorkBlockItem | undefined,
  task: TaskItem | undefined
): string {
  if (!item || item.type === 'rest') return '☕ RECOVERY BREAK';
  if (task?.quadrant === 'Q1') return 'Q1 CRISIS';
  return 'Q2 DEEP WORK';
}

export function WorkBlockView(props: WorkBlockViewProps) {
  const {
    state,
    focusRequestTaskId,
    onClearFocusRequest,
    onLogFocusSession,
    onRequestCompleteFromWorkBlock,
    onAddSubtask,
    onToggleSubtask,
    onReorderSubtask,
    onGoMatrix,
  } = props;

  const initialPlan = useMemo(() => loadPersistedPlan(), []);

  const [phase, setPhase] = useState<WorkBlockPhase>('PLAN');
  const [queue, setQueue] = useState<WorkBlockItem[]>(initialPlan.queue);
  const [budgetMinutes, setBudgetMinutes] = useState<number>(
    initialPlan.budgetMinutes
  );
  const [customHoursInput, setCustomHoursInput] = useState<string>(() =>
    formatMinutesAsDecimalHours(initialPlan.budgetMinutes)
  );
  const [scope, setScope] = useState<WorkBlockScope>(initialPlan.scope);
  const [includeBreaks, setIncludeBreaks] = useState<boolean>(
    initialPlan.includeBreaks
  );
  const [soundEnabled, setSoundEnabled] = useState<boolean>(
    initialPlan.soundEnabled
  );

  const [pickerTab, setPickerTab] = useState<PickerTab>('Q2');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [slotDurationMinutes, setSlotDurationMinutes] = useState<number>(25);
  const [timerSecondsLeft, setTimerSecondsLeft] = useState<number>(25 * 60);
  const [timerRunning, setTimerRunning] = useState<boolean>(false);
  const [subtaskDraft, setSubtaskDraft] = useState<string>('');
  const [subtaskHoursDraft, setSubtaskHoursDraft] = useState<string>('');
  const [subDragIndex, setSubDragIndex] = useState<number | null>(null);
  const [subDragOverIndex, setSubDragOverIndex] = useState<number | null>(null);
  const [debrief, setDebrief] = useState<WorkBlockDebrief>(createEmptyDebrief);

  const timerEndTimeRef = useRef<number | null>(null);
  const subtaskTitleRef = useRef<HTMLInputElement | null>(null);
  const subtaskHoursRef = useRef<HTMLInputElement | null>(null);
  const queueRef = useRef(queue);
  const stateRef = useRef(state);
  const currentIndexRef = useRef(currentIndex);
  const includeBreaksRef = useRef(includeBreaks);
  const soundEnabledRef = useRef(soundEnabled);

  queueRef.current = queue;
  stateRef.current = state;
  currentIndexRef.current = currentIndex;
  includeBreaksRef.current = includeBreaks;
  soundEnabledRef.current = soundEnabled;

  // Persist work block plan configuration and queue
  useEffect(() => {
    savePersistedPlan({
      queue,
      budgetMinutes,
      scope,
      includeBreaks,
      soundEnabled,
    });
  }, [queue, budgetMinutes, scope, includeBreaks, soundEnabled]);

  // Prune deleted or completed task items while in PLAN phase
  useEffect(() => {
    if (phase !== 'PLAN') return;
    setQueue((prev) => {
      const hasInvalid = prev.some((item) => {
        if (item.type !== 'task') return false;
        const t = state.tasks[item.taskId];
        return !t || Boolean(t.deleted) || t.completed;
      });
      if (!hasInvalid) return prev;
      const valid = prev.filter((item) => {
        if (item.type !== 'task') return true;
        const t = state.tasks[item.taskId];
        return Boolean(t && !t.deleted && !t.completed);
      });
      return reconcileBreaks(valid, state.tasks, includeBreaks);
    });
  }, [phase, state.tasks, includeBreaks]);

  // Handle direct focus requests from other views
  useEffect(() => {
    if (!focusRequestTaskId) return;
    const tasksMap = stateRef.current.tasks;
    const requestedTask = tasksMap[focusRequestTaskId];
    if (!requestedTask || requestedTask.deleted) {
      onClearFocusRequest();
      return;
    }

    const currQueue = queueRef.current;
    let nextQueue = currQueue;
    let targetIndex = currQueue.findIndex(
      (item) => item.type === 'task' && item.taskId === focusRequestTaskId
    );

    if (targetIndex === -1) {
      const appended: WorkBlockItem[] = [
        ...currQueue,
        {
          id: `wb-task-${focusRequestTaskId}-${Date.now()}`,
          type: 'task',
          taskId: focusRequestTaskId,
        },
      ];
      nextQueue = includeBreaksRef.current
        ? reconcileBreaks(appended, tasksMap, true)
        : appended;
      targetIndex = nextQueue.findIndex(
        (item) => item.type === 'task' && item.taskId === focusRequestTaskId
      );
      setQueue(nextQueue);
    }

    const safeIndex = Math.max(0, targetIndex);
    const durMin = getItemDurationMinutes(nextQueue[safeIndex], tasksMap);

    timerEndTimeRef.current = null;
    setTimerRunning(false);
    setCurrentIndex(safeIndex);
    setSlotDurationMinutes(durMin);
    setTimerSecondsLeft(durMin * 60);
    setDebrief(createEmptyDebrief());
    setPhase('FOCUS');
    onClearFocusRequest();
  }, [focusRequestTaskId, onClearFocusRequest]);

  const schedule = useMemo(
    () => computeWorkBlockSchedule(queue, state.tasks),
    [queue, state.tasks]
  );

  const queuedTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of queue) {
      if (item.type === 'task') {
        ids.add(item.taskId);
      }
    }
    return ids;
  }, [queue]);

  const pickerTasks = useMemo(() => {
    const active = Object.values(state.tasks).filter(
      (t) => !t.deleted && !t.completed
    );
    if (pickerTab === 'Q2') {
      return sortTasksInBlock(active.filter((t) => t.quadrant === 'Q2'));
    }
    if (pickerTab === 'Q1') {
      return sortTasksInBlock(active.filter((t) => t.quadrant === 'Q1'));
    }
    const priorityQuads = SCOPE_QUADRANTS[scope];
    const prioritySet = new Set<Quadrant>(priorityQuads);
    const prioritized = priorityQuads.flatMap((q) =>
      sortTasksInBlock(active.filter((t) => t.quadrant === q))
    );
    const remaining = sortTasksInBlock(
      active.filter((t) => !prioritySet.has(t.quadrant))
    );
    return [...prioritized, ...remaining];
  }, [state.tasks, pickerTab, scope]);

  const activeItem = phase === 'FOCUS' ? queue[currentIndex] : undefined;
  const activeTask =
    activeItem && activeItem.type === 'task'
      ? state.tasks[activeItem.taskId]
      : undefined;

  const activeSlotTitle = useMemo(() => {
    if (!activeItem) return 'Work Block';
    if (activeItem.type === 'rest') {
      return `Rest Break (${slotDurationMinutes}m)`;
    }
    return activeTask?.title || '(Missing task)';
  }, [activeItem, activeTask, slotDurationMinutes]);

  // Wall-clock anchored focus timer
  useEffect(() => {
    if (phase !== 'FOCUS' || !timerRunning) {
      timerEndTimeRef.current = null;
      return;
    }

    if (!timerEndTimeRef.current) {
      timerEndTimeRef.current = Date.now() + timerSecondsLeft * 1000;
    }

    const syncClock = () => {
      if (!timerEndTimeRef.current) return;
      const remaining = Math.max(
        0,
        Math.ceil((timerEndTimeRef.current - Date.now()) / 1000)
      );
      setTimerSecondsLeft(remaining);
    };

    const intervalId = window.setInterval(syncClock, 500);
    document.addEventListener('visibilitychange', syncClock);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', syncClock);
    };
  }, [phase, timerRunning]);

  // Sync document title while timer runs
  useEffect(() => {
    if (phase === 'FOCUS' && timerRunning) {
      document.title = `${formatCountdown(timerSecondsLeft)} • ${activeSlotTitle}`;
    } else {
      document.title = DEFAULT_DOC_TITLE;
    }
  }, [phase, timerRunning, timerSecondsLeft, activeSlotTitle]);

  // Restore document title on unmount
  useEffect(() => {
    return () => {
      document.title = DEFAULT_DOC_TITLE;
    };
  }, []);

  const advanceToSlotOrDebrief = (fromIndex: number, startTimer: boolean) => {
    const latestQueue = queueRef.current;
    const latestTasks = stateRef.current.tasks;
    const nextIdx = fromIndex + 1;

    if (nextIdx < latestQueue.length) {
      const nextItem = latestQueue[nextIdx];
      const nextDur = getItemDurationMinutes(nextItem, latestTasks);
      setCurrentIndex(nextIdx);
      setSlotDurationMinutes(nextDur);
      setTimerSecondsLeft(nextDur * 60);
      setSubtaskDraft('');
      setSubtaskHoursDraft('');
      if (startTimer) {
        timerEndTimeRef.current = Date.now() + nextDur * 60 * 1000;
        setTimerRunning(true);
      } else {
        timerEndTimeRef.current = null;
        setTimerRunning(false);
      }
    } else {
      timerEndTimeRef.current = null;
      setTimerRunning(false);
      setTimerSecondsLeft(0);
      setSubtaskDraft('');
      setSubtaskHoursDraft('');
      setPhase('DEBRIEF');
    }
  };

  // Handle natural block completion when countdown hits zero
  useEffect(() => {
    if (phase !== 'FOCUS' || !timerRunning || timerSecondsLeft !== 0) return;

    timerEndTimeRef.current = null;
    if (soundEnabledRef.current) {
      playGentleChime();
    }

    const idx = currentIndexRef.current;
    const item = queueRef.current[idx];
    if (item && item.type === 'task') {
      const task = stateRef.current.tasks[item.taskId];
      const quad = resolveLogQuadrant(task);
      const loggedMins = Math.max(1, slotDurationMinutes);
      onLogFocusSession(quad, loggedMins, item.taskId);
      setDebrief((prev) => ({
        ...prev,
        loggedMinutes: prev.loggedMinutes + loggedMins,
        q2LoggedMinutes:
          prev.q2LoggedMinutes + (quad === 'Q2' ? loggedMins : 0),
      }));
    }

    advanceToSlotOrDebrief(idx, true);
  }, [phase, timerRunning, timerSecondsLeft, slotDurationMinutes, onLogFocusSession]);

  const handleSelectBudgetPreset = (minutes: number) => {
    setBudgetMinutes(minutes);
    setCustomHoursInput(formatMinutesAsDecimalHours(minutes));
    const planned = autoPlanWorkBlock(
      Object.values(state.tasks),
      minutes,
      { scope, includeBreaks }
    );
    setQueue(planned);
  };

  const handleSelectScope = (nextScope: WorkBlockScope) => {
    setScope(nextScope);
    const planned = autoPlanWorkBlock(
      Object.values(state.tasks),
      budgetMinutes,
      { scope: nextScope, includeBreaks }
    );
    setQueue(planned);
  };

  const handleCustomHoursChange = (
    e: JSX.TargetedEvent<HTMLInputElement>
  ) => {
    const val = e.currentTarget.value;
    setCustomHoursInput(val);
    const parsed = parseDecimalHours(val);
    if (parsed !== undefined && parsed > 0) {
      setBudgetMinutes(parsed);
    }
  };

  const handleToggleSmartBreaks = (
    e: JSX.TargetedEvent<HTMLInputElement>
  ) => {
    const nextVal = e.currentTarget.checked;
    setIncludeBreaks(nextVal);
    setQueue((prev) => reconcileBreaks(prev, state.tasks, nextVal));
  };

  const handleAutoPlan = () => {
    const planned = autoPlanWorkBlock(
      Object.values(state.tasks),
      budgetMinutes,
      { scope, includeBreaks }
    );
    setQueue(planned);
  };

  const handleStartFocusBlock = () => {
    if (schedule.slots.length === 0) return;
    const firstDur = schedule.slots[0].durationMinutes;
    setCurrentIndex(0);
    setSlotDurationMinutes(firstDur);
    setTimerSecondsLeft(firstDur * 60);
    timerEndTimeRef.current = Date.now() + firstDur * 60 * 1000;
    setTimerRunning(true);
    setSubtaskDraft('');
    setSubtaskHoursDraft('');
    setDebrief(createEmptyDebrief());
    setPhase('FOCUS');
  };

  const handleRemoveSlot = (index: number) => {
    setQueue((prev) => {
      const target = prev[index];
      if (!target) return prev;
      const filtered = prev.filter((_, i) => i !== index);
      if (target.type === 'task' && includeBreaks) {
        return reconcileBreaks(filtered, state.tasks, true);
      }
      return filtered;
    });
  };

  const handleCycleRestDuration = (index: number) => {
    setQueue((prev) =>
      prev.map((item, i) => {
        if (i !== index || item.type !== 'rest') return item;
        return {
          ...item,
          durationMinutes: nextRestDuration(item.durationMinutes),
        };
      })
    );
  };

  const handleTogglePickerTask = (task: TaskItem) => {
    setQueue((prev) => {
      const exists = prev.some(
        (item) => item.type === 'task' && item.taskId === task.id
      );
      const updated = exists
        ? prev.filter(
            (item) => !(item.type === 'task' && item.taskId === task.id)
          )
        : [
            ...prev,
            {
              id: `wb-task-${task.id}-${Date.now()}`,
              type: 'task' as const,
              taskId: task.id,
            },
          ];
      return reconcileBreaks(updated, state.tasks, includeBreaks);
    });
  };

  const handleDragStart = (
    index: number,
    e: JSX.TargetedDragEvent<HTMLElement>
  ) => {
    setDragIndex(index);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(index));
    }
  };

  const handleDragOver = (
    index: number,
    e: JSX.TargetedDragEvent<HTMLElement>
  ) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
    if (dragOverIndex !== index) {
      setDragOverIndex(index);
    }
  };

  const handleDrop = (
    toIndex: number,
    e: JSX.TargetedDragEvent<HTMLElement>
  ) => {
    e.preventDefault();
    const rawFrom = e.dataTransfer?.getData('text/plain');
    const parsedFrom = rawFrom ? parseInt(rawFrom, 10) : NaN;
    const fromIndex = Number.isFinite(parsedFrom) ? parsedFrom : dragIndex;

    if (fromIndex !== null && fromIndex !== toIndex) {
      setQueue((prev) => moveWorkBlockItem(prev, fromIndex, toIndex));
    }
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleHandleKeyDown = (
    index: number,
    e: JSX.TargetedKeyboardEvent<HTMLButtonElement>
  ) => {
    const btn = e.currentTarget;
    if (e.key === 'ArrowUp' && index > 0) {
      e.preventDefault();
      setQueue((prev) => moveWorkBlockItem(prev, index, index - 1));
      requestAnimationFrame(() => btn.focus({ preventScroll: true }));
    } else if (e.key === 'ArrowDown' && index < queue.length - 1) {
      e.preventDefault();
      setQueue((prev) => moveWorkBlockItem(prev, index, index + 1));
      requestAnimationFrame(() => btn.focus({ preventScroll: true }));
    }
  };

  const getAccurateSecondsLeft = (): number => {
    if (timerRunning && timerEndTimeRef.current) {
      return Math.max(
        0,
        Math.ceil((timerEndTimeRef.current - Date.now()) / 1000)
      );
    }
    return timerSecondsLeft;
  };

  const handlePauseOrResume = () => {
    if (timerRunning) {
      const remaining = getAccurateSecondsLeft();
      timerEndTimeRef.current = null;
      setTimerRunning(false);
      setTimerSecondsLeft(remaining);
    } else {
      timerEndTimeRef.current = Date.now() + timerSecondsLeft * 1000;
      setTimerRunning(true);
    }
  };

  const handleExtendSlot = () => {
    if (!activeItem) return;
    const extendMinutes = activeItem.type === 'rest' ? 2 : 5;
    setSlotDurationMinutes((prev) => prev + extendMinutes);
    setTimerSecondsLeft((prev) => prev + extendMinutes * 60);
    if (timerEndTimeRef.current) {
      timerEndTimeRef.current += extendMinutes * 60 * 1000;
    }
  };

  const handleFinishTask = () => {
    if (!activeItem || activeItem.type !== 'task' || !activeTask) return;

    const remaining = getAccurateSecondsLeft();
    timerEndTimeRef.current = null;
    setTimerRunning(false);
    setTimerSecondsLeft(remaining);

    const elapsedSec = Math.max(0, slotDurationMinutes * 60 - remaining);
    const elapsedMinutes =
      elapsedSec >= 30 ? Math.max(1, Math.round(elapsedSec / 60)) : undefined;
    const suggestedMinutes = elapsedMinutes ?? activeTask.estimatedMinutes;
    const completingIndex = currentIndex;
    const taskSnapshot = activeTask;

    onRequestCompleteFromWorkBlock(
      taskSnapshot,
      suggestedMinutes,
      (actualMinutes?: number) => {
        const quad = resolveLogQuadrant(taskSnapshot);
        const logged =
          elapsedMinutes !== undefined && elapsedMinutes >= 1
            ? elapsedMinutes
            : 0;

        if (logged > 0) {
          onLogFocusSession(quad, logged, taskSnapshot.id);
        }

        setDebrief((prev) => {
          const alreadyCompleted = prev.completedTaskIds.includes(
            taskSnapshot.id
          );
          const hasActual =
            actualMinutes !== undefined &&
            Number.isFinite(actualMinutes) &&
            actualMinutes > 0;

          return {
            loggedMinutes: prev.loggedMinutes + logged,
            q2LoggedMinutes:
              prev.q2LoggedMinutes + (quad === 'Q2' ? logged : 0),
            completedTaskIds: alreadyCompleted
              ? prev.completedTaskIds
              : [...prev.completedTaskIds, taskSnapshot.id],
            estimatedMinutesTotal:
              prev.estimatedMinutesTotal +
              (hasActual
                ? taskSnapshot.estimatedMinutes ?? slotDurationMinutes
                : 0),
            actualMinutesTotal:
              prev.actualMinutesTotal + (hasActual ? actualMinutes : 0),
          };
        });

        advanceToSlotOrDebrief(completingIndex, true);
      }
    );
  };

  const handleSkipSlot = () => {
    if (!activeItem) return;
    const wasRunning = timerRunning;
    const remaining = getAccurateSecondsLeft();
    const elapsedSec = Math.max(0, slotDurationMinutes * 60 - remaining);
    const elapsedMinutes =
      elapsedSec >= 30 ? Math.max(1, Math.round(elapsedSec / 60)) : 0;

    if (activeItem.type === 'task' && elapsedMinutes >= 1) {
      const quad = resolveLogQuadrant(activeTask);
      onLogFocusSession(quad, elapsedMinutes, activeItem.taskId);
      setDebrief((prev) => ({
        ...prev,
        loggedMinutes: prev.loggedMinutes + elapsedMinutes,
        q2LoggedMinutes:
          prev.q2LoggedMinutes + (quad === 'Q2' ? elapsedMinutes : 0),
      }));
    }

    advanceToSlotOrDebrief(currentIndex, wasRunning);
  };

  const handleBackToPlan = () => {
    const remaining = getAccurateSecondsLeft();
    timerEndTimeRef.current = null;
    setTimerRunning(false);
    setTimerSecondsLeft(remaining);
    setPhase('PLAN');
  };

  const parsedSubtaskMinutes = parseDecimalHours(subtaskHoursDraft);

  const submitSubtaskDraft = () => {
    if (!activeTask) return;
    const trimmed = subtaskDraft.trim();
    if (!trimmed) {
      subtaskTitleRef.current?.focus();
      return;
    }
    const estMinutes = parseDecimalHours(subtaskHoursDraft);
    onAddSubtask(activeTask.id, trimmed, estMinutes);
    setSubtaskDraft('');
    setSubtaskHoursDraft('');
    subtaskTitleRef.current?.focus();
  };

  const handleAddSubtaskSubmit = (e: JSX.TargetedSubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    submitSubtaskDraft();
  };

  const handleSubtaskDragStart = (
    index: number,
    e: JSX.TargetedDragEvent<HTMLElement>
  ) => {
    setSubDragIndex(index);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(index));
    }
  };

  const handleSubtaskDragOver = (
    index: number,
    e: JSX.TargetedDragEvent<HTMLElement>
  ) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
    if (subDragOverIndex !== index) {
      setSubDragOverIndex(index);
    }
  };

  const handleSubtaskDrop = (
    toIndex: number,
    e: JSX.TargetedDragEvent<HTMLElement>
  ) => {
    e.preventDefault();
    if (!activeTask) return;
    const rawFrom = e.dataTransfer?.getData('text/plain');
    const parsedFrom = rawFrom ? parseInt(rawFrom, 10) : NaN;
    const fromIndex = Number.isFinite(parsedFrom) ? parsedFrom : subDragIndex;

    if (fromIndex !== null && fromIndex !== toIndex) {
      onReorderSubtask(activeTask.id, fromIndex, toIndex);
    }
    setSubDragIndex(null);
    setSubDragOverIndex(null);
  };

  const handleSubtaskDragEnd = () => {
    setSubDragIndex(null);
    setSubDragOverIndex(null);
  };

  const handleSubtaskHandleKeyDown = (
    index: number,
    e: JSX.TargetedKeyboardEvent<HTMLButtonElement>
  ) => {
    if (!activeTask || !activeTask.checklist) return;
    const btn = e.currentTarget;
    if (e.key === 'ArrowUp' && index > 0) {
      e.preventDefault();
      onReorderSubtask(activeTask.id, index, index - 1);
      requestAnimationFrame(() => btn.focus({ preventScroll: true }));
    } else if (e.key === 'ArrowDown' && index < activeTask.checklist.length - 1) {
      e.preventDefault();
      onReorderSubtask(activeTask.id, index, index + 1);
      requestAnimationFrame(() => btn.focus({ preventScroll: true }));
    }
  };

  const handlePlanNextBlock = () => {
    timerEndTimeRef.current = null;
    setTimerRunning(false);
    setCurrentIndex(0);
    setDebrief(createEmptyDebrief());
    setPhase('PLAN');
  };

  if (phase === 'FOCUS' && activeItem) {
    const projectedEndMs =
      timerRunning && timerEndTimeRef.current
        ? timerEndTimeRef.current
        : Date.now() + timerSecondsLeft * 1000;
    const nextSlot =
      currentIndex + 1 < schedule.slots.length
        ? schedule.slots[currentIndex + 1]
        : null;
    const isTaskSlot = activeItem.type === 'task';
    const isPausedMidSlot =
      !timerRunning &&
      timerSecondsLeft > 0 &&
      timerSecondsLeft < slotDurationMinutes * 60;

    return (
      <div class="focus-arena work-block-arena">
        <div class="wb-focus-topbar">
          <button
            type="button"
            class="btn btn-sm"
            onClick={handleBackToPlan}
          >
            ← Plan
          </button>

          <span class="mono">
            Slot {currentIndex + 1} of {queue.length}
          </span>

          <progress
            class="wb-focus-progress"
            max={Math.max(1, queue.length)}
            value={currentIndex + 1}
          />

          <button
            type="button"
            class="btn btn-sm btn-icon"
            onClick={() => setSoundEnabled((prev) => !prev)}
            aria-label={soundEnabled ? 'Mute chime' : 'Enable chime'}
            title={soundEnabled ? 'Sound on' : 'Sound muted'}
          >
            {soundEnabled ? '🔔' : '🔕'}
          </button>
        </div>

        <div class={`wb-focus-card ${!isTaskSlot ? 'is-rest' : ''}`}>
          <div class="wb-focus-meta">
            <span
              class={`quadrant-pill ${
                !isTaskSlot
                  ? 'tag-rest'
                  : `pill-${activeTask?.quadrant || 'Q2'}`
              }`}
            >
              {getFocusBadgeLabel(activeItem, activeTask)}
            </span>
            <span class="wb-time-pill mono">Ends {formatClock24h(projectedEndMs)}</span>
          </div>

          <h2 class="wb-focus-title">{activeSlotTitle}</h2>

          <div class="timer-digits mono">{formatCountdown(timerSecondsLeft)}</div>

          {isTaskSlot && activeTask && (
            <div class="wb-task-workspace">
              {activeTask.notes && (
                <p class="wb-task-notes">{activeTask.notes}</p>
              )}

              <form class="subtask-add-form" onSubmit={handleAddSubtaskSubmit}>
                <input
                  ref={subtaskTitleRef}
                  type="text"
                  class="capture-input"
                  enterKeyHint="next"
                  aria-label="Subtask title"
                  placeholder="Subtask title (Enter for hrs)..."
                  value={subtaskDraft}
                  onInput={(e) => setSubtaskDraft(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (!subtaskDraft.trim()) return;
                      subtaskHoursRef.current?.focus();
                      subtaskHoursRef.current?.select();
                    }
                  }}
                />
                <div class="capture-hours-wrapper wb-subtask-hours-wrap">
                  <input
                    ref={subtaskHoursRef}
                    type="number"
                    step="any"
                    min="0"
                    enterKeyHint="done"
                    class="capture-input capture-hours-input wb-hours-input"
                    placeholder="Hours (e.g. 0.25)"
                    aria-label="Subtask estimated hours"
                    value={subtaskHoursDraft}
                    onInput={(e) => setSubtaskHoursDraft(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        subtaskTitleRef.current?.focus();
                        return;
                      }
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        submitSubtaskDraft();
                      }
                    }}
                  />
                  {parsedSubtaskMinutes !== undefined && (
                    <span class="capture-minutes-hint">
                      {parsedSubtaskMinutes}m
                    </span>
                  )}
                </div>
                <button type="submit" class="btn btn-sm btn-primary">
                  + Add
                </button>
              </form>

              {activeTask.checklist && activeTask.checklist.length > 0 && (
                <div class="subtask-list">
                  {activeTask.checklist.map((sub, subIdx) => (
                    <div
                      key={sub.id}
                      class={`subtask-item ${sub.done ? 'done' : ''} ${
                        subDragOverIndex === subIdx ? 'drag-over' : ''
                      } ${subDragIndex === subIdx ? 'dragging' : ''}`}
                      draggable
                      onDragStart={(e) => handleSubtaskDragStart(subIdx, e)}
                      onDragOver={(e) => handleSubtaskDragOver(subIdx, e)}
                      onDragLeave={() => setSubDragOverIndex(null)}
                      onDrop={(e) => handleSubtaskDrop(subIdx, e)}
                      onDragEnd={handleSubtaskDragEnd}
                    >
                      <button
                        type="button"
                        class="drag-handle"
                        aria-label={`Reorder ${sub.text} with ArrowUp or ArrowDown`}
                        onKeyDown={(e) => handleSubtaskHandleKeyDown(subIdx, e)}
                      >
                        ⠿
                      </button>
                      <input
                        id={`wb-sub-${sub.id}`}
                        type="checkbox"
                        checked={sub.done}
                        onChange={() => onToggleSubtask(activeTask.id, sub.id)}
                      />
                      <label for={`wb-sub-${sub.id}`} class="subtask-text">
                        {sub.text}
                      </label>
                      {sub.estimatedMinutes !== undefined &&
                        sub.estimatedMinutes > 0 && (
                          <span class="wb-slot-dur mono">
                            ~{Math.round(sub.estimatedMinutes)}m
                          </span>
                        )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div class="wb-focus-actions">
            <button
              type="button"
              class={`btn ${isTaskSlot ? 'btn-q2' : 'btn-primary'}`}
              onClick={handlePauseOrResume}
            >
              {timerRunning ? 'Pause' : isPausedMidSlot ? 'Resume' : 'Start'}
            </button>

            {isTaskSlot && activeTask && (
              <button
                type="button"
                class="btn btn-primary"
                onClick={handleFinishTask}
              >
                ✓ Finish Task
              </button>
            )}

            <button
              type="button"
              class="btn"
              onClick={handleExtendSlot}
            >
              {isTaskSlot ? '+5m' : '+2m'}
            </button>

            <button
              type="button"
              class="btn"
              onClick={handleSkipSlot}
            >
              Skip →
            </button>
          </div>

          {nextSlot && (
            <div class="wb-up-next">
              <span>Up next:</span>{' '}
              <strong>{nextSlot.title}</strong>{' '}
              <span class="mono">({nextSlot.durationMinutes}m)</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (phase === 'DEBRIEF') {
    const q2SharePct =
      debrief.loggedMinutes > 0
        ? Math.round((debrief.q2LoggedMinutes / debrief.loggedMinutes) * 100)
        : 0;

    return (
      <div class="focus-arena work-block-arena">
        <div class="wb-debrief-card">
          <h2>Work Block Complete</h2>

          <div class="wb-debrief-grid">
            <div class="wb-debrief-kpi">
              <span class="wb-kpi-label">Deep Work Logged</span>
              <strong class="wb-kpi-value mono">{debrief.loggedMinutes}m</strong>
            </div>

            <div class="wb-debrief-kpi">
              <span class="wb-kpi-label">Tasks Completed</span>
              <strong class="wb-kpi-value mono">
                {debrief.completedTaskIds.length}
              </strong>
            </div>

            <div class="wb-debrief-kpi">
              <span class="wb-kpi-label">Q2 Share</span>
              <strong class="wb-kpi-value mono">{q2SharePct}%</strong>
            </div>
          </div>

          {debrief.actualMinutesTotal > 0 && (
            <div class="wb-debrief-est-actual mono">
              Est {debrief.estimatedMinutesTotal}m vs Actual{' '}
              {debrief.actualMinutesTotal}m
            </div>
          )}

          <div class="wb-debrief-actions">
            <button
              type="button"
              class="btn btn-primary"
              onClick={handlePlanNextBlock}
            >
              Plan Next Block
            </button>
            <button
              type="button"
              class="btn"
              onClick={onGoMatrix}
            >
              Back to Matrix
            </button>
          </div>
        </div>
      </div>
    );
  }

  // PLAN phase
  return (
    <div class="focus-arena work-block-arena">
      <div class="wb-plan-toolbar">
        <div class="wb-toolbar-group">
          <span class="wb-toolbar-label">Budget</span>
          <div class="wb-preset-group">
            {BUDGET_PRESETS.map((preset) => (
              <button
                key={preset.minutes}
                type="button"
                class={`btn btn-sm ${
                  budgetMinutes === preset.minutes ? 'btn-primary' : ''
                }`}
                onClick={() => handleSelectBudgetPreset(preset.minutes)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <label for="wb-budget-hours" class="wb-hours-label">
            Hours
            <input
              id="wb-budget-hours"
              type="number"
              step="any"
              min="0.1"
              class="capture-input wb-hours-input"
              value={customHoursInput}
              onInput={handleCustomHoursChange}
            />
          </label>
        </div>

        <div class="wb-toolbar-group">
          <span class="wb-toolbar-label">Scope</span>
          <div class="wb-segmented">
            {SCOPE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                class={`btn btn-sm ${scope === opt.value ? 'btn-q2' : ''}`}
                onClick={() => handleSelectScope(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div class="wb-toolbar-group">
          <label for="wb-smart-breaks" class="wb-checkbox-label">
            <input
              id="wb-smart-breaks"
              type="checkbox"
              checked={includeBreaks}
              onChange={handleToggleSmartBreaks}
            />
            <span>Smart Breaks</span>
          </label>

          <button
            type="button"
            class="btn btn-primary"
            onClick={handleAutoPlan}
          >
            Auto-Plan
          </button>
        </div>

        <div class="wb-scope-hint">{SCOPE_DESCRIPTIONS[scope]}</div>
      </div>

      {schedule.slots.length > 0 && (
        <div class="wb-timeline-card">
          <div class="wb-timeline-bar">
            {schedule.slots.map((slot) => {
              const segClass =
                slot.item.type === 'rest'
                  ? 'wb-seg-rest'
                  : `wb-seg-${slot.quadrant || 'Q2'}`;
              return (
                <div
                  key={slot.item.id}
                  class={`wb-timeline-seg ${segClass}`}
                  style={{ flexGrow: slot.durationMinutes }}
                  title={`${slot.title} (${slot.durationMinutes}m)`}
                />
              );
            })}
          </div>

          <div class="wb-timeline-axis mono">
            <span>{formatClock24h(schedule.slots[0].startMs)}</span>
            <span>{formatClock24h(schedule.endMs)}</span>
          </div>

          <div class="wb-timeline-summary">
            <div class="wb-timeline-metrics mono">
              <span>{formatDurationHours(schedule.totalMinutes)}</span>
              <span>
                {schedule.workMinutes}m work · {schedule.restMinutes}m rest
              </span>
              <span class="wb-time-pill mono">Ends {formatClock24h(schedule.endMs)}</span>
              <span>{schedule.q2SharePct}% Q2</span>
            </div>

            <button
              type="button"
              class="btn btn-q2"
              onClick={handleStartFocusBlock}
            >
              ▶ Start Focus Block
            </button>
          </div>
        </div>
      )}

      <div class="wb-builder-grid">
        <section class="wb-sprint-panel">
          <div class="panel-header-row">
            <h4>Sprint Plan</h4>
            <button
              type="button"
              class="btn btn-sm"
              disabled={queue.length === 0}
              onClick={() => setQueue([])}
            >
              Clear
            </button>
          </div>

          {schedule.slots.length === 0 ? (
            <div class="queue-empty-box">
              <span>No slots queued yet.</span>
              <span>Pick tasks on the right or click Auto-Plan.</span>
            </div>
          ) : (
            <div class="queue-list">
              {schedule.slots.map((slot, idx) => {
                if (slot.item.type === 'rest') {
                  return (
                    <div
                      key={slot.item.id}
                      class={`wb-rest-divider ${
                        dragOverIndex === idx ? 'drag-over' : ''
                      }`}
                      draggable
                      onDragStart={(e) => handleDragStart(idx, e)}
                      onDragOver={(e) => handleDragOver(idx, e)}
                      onDragLeave={() => setDragOverIndex(null)}
                      onDrop={(e) => handleDrop(idx, e)}
                      onDragEnd={handleDragEnd}
                    >
                      <button
                        type="button"
                        class="btn btn-sm tag-rest"
                        onClick={() => handleCycleRestDuration(idx)}
                        title="Click to cycle break duration (3m → 5m → 10m)"
                      >
                        ☕ {slot.durationMinutes}m break
                      </button>
                      <button
                        type="button"
                        class="btn btn-sm btn-icon btn-danger-ghost"
                        aria-label="Remove break"
                        onClick={() => handleRemoveSlot(idx)}
                      >
                        ×
                      </button>
                    </div>
                  );
                }

                const quad = slot.quadrant || 'Q2';
                const timeRange = `${formatClock24h(slot.startMs)}–${formatClock24h(slot.endMs)}`;

                return (
                  <div
                    key={slot.item.id}
                    class={`wb-sprint-card wb-quad-${quad} ${
                      dragOverIndex === idx ? 'drag-over' : ''
                    } ${dragIndex === idx ? 'dragging' : ''}`}
                    draggable
                    onDragStart={(e) => handleDragStart(idx, e)}
                    onDragOver={(e) => handleDragOver(idx, e)}
                    onDragLeave={() => setDragOverIndex(null)}
                    onDrop={(e) => handleDrop(idx, e)}
                    onDragEnd={handleDragEnd}
                  >
                    <button
                      type="button"
                      class="drag-handle"
                      aria-label={`Reorder ${slot.title} with ArrowUp or ArrowDown`}
                      onKeyDown={(e) => handleHandleKeyDown(idx, e)}
                    >
                      ⠿
                    </button>

                    <span class="wb-slot-time mono">{timeRange}</span>

                    <span class={`quadrant-pill pill-${quad}`}>{quad}</span>

                    <span class="wb-slot-title">{slot.title}</span>

                    <span class="wb-slot-dur mono">
                      ~{slot.durationMinutes}m
                    </span>

                    <button
                      type="button"
                      class="btn btn-sm btn-icon btn-danger-ghost"
                      aria-label={`Remove ${slot.title}`}
                      onClick={() => handleRemoveSlot(idx)}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section class="wb-picker-panel">
          <div class="panel-header-row">
            <h4>Task Picker</h4>
            <div class="task-pool-tabs">
              {(['Q2', 'Q1', 'All'] as PickerTab[]).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  class={`pool-tab-btn ${pickerTab === tab ? 'active' : ''} ${
                    tab === 'Q2' && pickerTab === 'Q2' ? 'q2-tab' : ''
                  }`}
                  onClick={() => setPickerTab(tab)}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>

          {pickerTasks.length === 0 ? (
            <div class="queue-empty-box">No active tasks in {pickerTab}.</div>
          ) : (
            <div class="task-pool-list">
              {pickerTasks.map((task) => {
                const isQueued = queuedTaskIds.has(task.id);
                const estMinutes =
                  task.estimatedMinutes && task.estimatedMinutes > 0
                    ? Math.round(task.estimatedMinutes)
                    : 25;

                return (
                  <button
                    key={task.id}
                    type="button"
                    class={`wb-picker-row ${isQueued ? 'queued' : ''}`}
                    onClick={() => handleTogglePickerTask(task)}
                  >
                    <span class={`quadrant-pill pill-${task.quadrant}`}>
                      {task.quadrant}
                    </span>
                    <span class="wb-picker-title">{task.title}</span>
                    <span class="wb-picker-dur mono">~{estMinutes}m</span>
                    <span class="wb-picker-toggle">
                      {isQueued ? '✓' : '+'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
