import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { verifySemilatticeLaws } from './core/crdt';
import {
  addSubtask,
  addTask,
  computeBoronAnalytics,
  deleteSubtask,
  deleteTask,
  escalateNeglectedQ2Tasks,
  formatDateISO,
  getHoursUntilDue,
  logFocusSession,
  moveTask,
  QUADRANT_META,
  resolveQuadrant,
  resolveTaskConflict,
  toggleSubtask,
  toggleTaskCompleted,
  triageTask,
  updateTaskDetails,
} from './core/engine';
import { parseMarkdownTaskLines, serializeToMarkdown } from './core/markdown';
import { AppState, GistSyncConfig, Quadrant, TaskItem } from './core/types';
import { createNewSecretGist, syncWithGitHubGist } from './sync/gistSync';
import {
  clearGistToken,
  downloadTextFile,
  loadGistConfig,
  loadLocalState,
  loadVisualPrefs,
  saveGistConfig,
  saveLocalState,
  saveVisualPrefs,
} from './sync/storage';
import { ANALYTICS_WIDGET_REGISTRY } from './visuals/analyticsWidgets';
import { applyVisualTheme, DensityMode, THEME_REGISTRY } from './visuals/themes';

export type ViewMode = 'MATRIX' | 'TRIAGE' | 'MORNING_Q2' | 'FOCUS' | 'ANALYTICS' | 'SYNC_LAB';

export type WorkBlockQueueItem =
  | { id: string; type: 'task'; taskId: string }
  | { id: string; type: 'rest'; durationMinutes: number; label?: string };

/**
 * Returns default rest duration in minutes:
 * >= 30m task -> 10m rest
 * < 30m or unspecified (fallback 25m) -> 3m rest
 */
export function getDefaultRestDuration(taskOrMinutes?: number | TaskItem | null): number {
  let minutes: number | undefined;
  if (typeof taskOrMinutes === 'object' && taskOrMinutes !== null) {
    minutes = taskOrMinutes.estimatedMinutes;
  } else if (typeof taskOrMinutes === 'number') {
    minutes = taskOrMinutes;
  }
  if (minutes !== undefined && minutes !== null && minutes >= 30) {
    return 10;
  }
  return 3;
}

/**
 * Resolves item duration for queue execution and display.
 * Tasks use estimatedMinutes or fallback to 25m default.
 * Rest blocks use their durationMinutes (fallback 3m).
 */
export function getQueueItemDuration(
  item: WorkBlockQueueItem,
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

/**
 * Calculates sum of minutes across all items in work block queue.
 */
export function calculateQueueTotalMinutes(
  queue: WorkBlockQueueItem[],
  tasks: Record<string, TaskItem>
): number {
  return queue.reduce((sum, item) => sum + getQueueItemDuration(item, tasks), 0);
}

/**
 * Formats minutes into decimal hours string (e.g. 90m -> "1.5h").
 */
export function formatTotalHours(totalMinutes: number): string {
  const hours = totalMinutes / 60;
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded.toFixed(1)}h`;
}

/**
 * Calculates projected completion wall-clock date from total queue duration.
 */
export function calculateProjectedCompletionTime(
  totalMinutes: number,
  baseDate: Date = new Date()
): Date {
  return new Date(baseDate.getTime() + totalMinutes * 60_000);
}

/**
 * Formats date into local 2-digit time (e.g. "11:30 AM" or "11:30").
 */
export function formatProjectedTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Pure reordering helper for work block queue items.
 */
export function moveQueueItem(
  queue: WorkBlockQueueItem[],
  fromIndex: number,
  toIndex: number
): WorkBlockQueueItem[] {
  if (fromIndex < 0 || fromIndex >= queue.length || toIndex < 0 || toIndex >= queue.length) {
    return queue;
  }
  const copy = [...queue];
  const [item] = copy.splice(fromIndex, 1);
  copy.splice(toIndex, 0, item);
  return copy;
}

/**
 * Inserts rest block immediately following targetIndex.
 */
export function insertRestBlockAfter(
  queue: WorkBlockQueueItem[],
  targetIndex: number,
  customDuration?: number,
  tasks?: Record<string, TaskItem>
): WorkBlockQueueItem[] {
  const targetItem = queue[targetIndex];
  let duration = customDuration;
  if (!duration) {
    if (targetItem && targetItem.type === 'task' && tasks) {
      duration = getDefaultRestDuration(tasks[targetItem.taskId]);
    } else {
      duration = 3;
    }
  }
  const restItem: WorkBlockQueueItem = {
    id: `wb-rest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: 'rest',
    durationMinutes: duration,
  };
  const next = [...queue];
  next.splice(targetIndex + 1, 0, restItem);
  return next;
}

/**
 * Maps task quadrant to valid focus session quadrant.
 * Falls back to 'Q2' if undefined or INBOX.
 */
export function resolveTaskLogQuadrant(task?: TaskItem | null): Exclude<Quadrant, 'INBOX'> {
  if (!task || !task.quadrant || task.quadrant === 'INBOX') {
    return 'Q2';
  }
  return task.quadrant;
}

/**
 * Formats seconds into MM:SS string.
 */
export function formatTimer(sec: number): string {
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}


/**
 * Converts decimal hours string or number to integer minutes.
 * Handles float rounding artifacts (e.g. 0.29 * 60 = 17.4 -> 17).
 * Returns undefined for empty string, NaN, non-finite, or <= 0 values.
 */
export function parseDecimalHours(input: string | number | undefined | null): number | undefined {
  if (input === undefined || input === null) return undefined;
  const str = typeof input === 'number' ? String(input) : input.trim().replace(',', '.');
  if (!str) return undefined;
  const num = parseFloat(str);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return Math.round(num * 60);
}

/**
 * Calculate target ISO date string from local base date and numeric offset.
 * Uses local year/month/date arithmetic to guarantee DST and leap-year safety.
 */
export function calculateOffsetDate(offset: number, baseDate: Date = new Date()): {
  iso: string;
  year: number;
  month: number;
  day: number;
} {
  const target = new Date(
    baseDate.getFullYear(),
    baseDate.getMonth(),
    baseDate.getDate() + offset
  );
  return {
    iso: formatDateISO(target),
    year: target.getFullYear(),
    month: target.getMonth(),
    day: target.getDate(),
  };
}

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export const DAY_HEADERS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

export function App() {
  const [state, setState] = useState<AppState>(() => loadLocalState());
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const hour = new Date().getHours();
    const initial = loadLocalState();
    const stats = computeBoronAnalytics(initial);
    if (hour >= 5 && hour < 10 && !stats.didQ2Today && stats.activeByQuadrant.Q2 > 0) {
      return 'MORNING_Q2';
    }
    return 'MATRIX';
  });

  // Visual preferences state (theme & density)
  const [visualPrefs, setVisualPrefs] = useState(() => loadVisualPrefs());

  useEffect(() => {
    applyVisualTheme(visualPrefs.themeId, visualPrefs.density);
    saveVisualPrefs(visualPrefs);
  }, [visualPrefs]);

  // 3-Step Task Capture state & refs
  const [captureText, setCaptureText] = useState('');
  const [captureHours, setCaptureHours] = useState('');
  const [captureQuadrant, setCaptureQuadrant] = useState<Quadrant>('INBOX');
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [calendarOffset, setCalendarOffset] = useState('');
  const [calendarViewDate, setCalendarViewDate] = useState<Date>(() => new Date());

  const captureInputRef = useRef<HTMLInputElement>(null);
  const hoursInputRef = useRef<HTMLInputElement>(null);
  const calendarOffsetInputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Synchronous ref to prevent stale closures in global keydown listener
  const isCalendarOpenRef = useRef(isCalendarOpen);
  isCalendarOpenRef.current = isCalendarOpen;

  const refocusTitle = () => {
    captureInputRef.current?.focus();
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => {
        captureInputRef.current?.focus();
      });
    }
  };

  const todayISO = useMemo(() => formatDateISO(new Date()), []);

  const convertedMinutes = useMemo(() => {
    return parseDecimalHours(captureHours);
  }, [captureHours]);

  const highlightedDateISO = useMemo(() => {
    const trimmed = calendarOffset.trim();
    if (!trimmed) return null;
    const num = parseInt(trimmed, 10);
    if (isNaN(num) || num < 0) return null;
    return calculateOffsetDate(num).iso;
  }, [calendarOffset]);

  // Synchronize calendar view month if offset crosses month boundaries
  useEffect(() => {
    if (highlightedDateISO) {
      const [y, m] = highlightedDateISO.split('-').map(Number);
      setCalendarViewDate(new Date(y, m - 1, 1));
    }
  }, [highlightedDateISO]);

  // Outside click dismiss for calendar popover
  useEffect(() => {
    if (!isCalendarOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        captureInputRef.current &&
        !captureInputRef.current.contains(e.target as Node) &&
        hoursInputRef.current &&
        !hoursInputRef.current.contains(e.target as Node)
      ) {
        setIsCalendarOpen(false);
        refocusTitle();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isCalendarOpen]);

  const calendarDays = useMemo(() => {
    const year = calendarViewDate.getFullYear();
    const month = calendarViewDate.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstDayOfWeek = new Date(year, month, 1).getDay();

    const days: { dateStr: string; dayNum: number; isCurrentMonth: boolean }[] = [];
    for (let i = 0; i < firstDayOfWeek; i++) {
      days.push({ dateStr: '', dayNum: 0, isCurrentMonth: false });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const dStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      days.push({ dateStr: dStr, dayNum: d, isCurrentMonth: true });
    }
    return days;
  }, [calendarViewDate]);

  const monthTitle = useMemo(() => {
    return `${MONTH_NAMES[calendarViewDate.getMonth()]} ${calendarViewDate.getFullYear()}`;
  }, [calendarViewDate]);

  const handlePrevMonth = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCalendarViewDate((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1));
  };

  const handleNextMonth = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCalendarViewDate((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
  };

  const handleTitleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (!captureText.trim()) return;
      hoursInputRef.current?.focus();
      hoursInputRef.current?.select();
    }
  };

  const handleHoursKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (!captureText.trim()) {
        captureInputRef.current?.focus();
        return;
      }
      setIsCalendarOpen(true);
      setCalendarViewDate(new Date());
      setCalendarOffset('');
      if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(() => {
          calendarOffsetInputRef.current?.focus();
          calendarOffsetInputRef.current?.select();
        });
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      captureInputRef.current?.focus();
    }
  };

  const submitTaskWithDate = (dueDate?: string) => {
    if (!captureText.trim()) return;
    const estimatedMinutes = parseDecimalHours(captureHours);
    setState((curr) =>
      addTask(curr, captureText, captureQuadrant, {
        dueDate: dueDate || undefined,
        estimatedMinutes,
      })
    );
    setCaptureText('');
    setCaptureHours('');
    setCalendarOffset('');
    setIsCalendarOpen(false);
    refocusTitle();
  };

  const handlePopoverSubmit = () => {
    const trimmed = calendarOffset.trim();
    if (!trimmed) {
      submitTaskWithDate(undefined);
      return;
    }
    const offsetNum = parseInt(trimmed, 10);
    if (isNaN(offsetNum) || offsetNum < 0) {
      submitTaskWithDate(undefined);
      return;
    }
    const targetDateISO = calculateOffsetDate(offsetNum).iso;
    submitTaskWithDate(targetDateISO);
  };

  const handleOffsetKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      handlePopoverSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setIsCalendarOpen(false);
      refocusTitle();
    }
  };

  const handleOffsetInput = (e: Event) => {
    const val = (e.target as HTMLInputElement).value;
    const sanitized = val.replace(/\D/g, '');
    setCalendarOffset(sanitized);
  };

  const handleDayCellClick = (dateStr: string) => {
    submitTaskWithDate(dateStr);
  };

  // Inline subtask reduction on click & task drawer state
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [subtaskDraft, setSubtaskDraft] = useState<string>('');

  // Rapid 2-Decision Binary Triage state + synchronous ref to prevent fast-keypress drops
  const [importantChoice, setImportantChoice] = useState<boolean | null>(null);
  const importantChoiceRef = useRef<boolean | null>(null);
  const [lastTriagedFeedback, setLastTriagedFeedback] = useState<string | null>(null);

  // Q1 -> Q2 Prevention banner state
  const [completedQ1Crisis, setCompletedQ1Crisis] = useState<TaskItem | null>(null);
  const [preventionInput, setPreventionInput] = useState('');

  // Morning Q2 Focus Timer state (wall-clock anchored to prevent background tab drift)
  const [selectedFocusTaskId, setSelectedFocusTaskId] = useState<string | undefined>(undefined);
  const [timerDurationMin, setTimerDurationMin] = useState<number>(25);
  const [timerSecondsLeft, setTimerSecondsLeft] = useState<number>(25 * 60);
  const [timerRunning, setTimerRunning] = useState<boolean>(false);
  const timerEndTimeRef = useRef<number | null>(null);

  // Work Block Queue & Sequential Focus Timer state
  const [workBlockQueue, setWorkBlockQueue] = useState<WorkBlockQueueItem[]>(() => {
    try {
      const saved = localStorage.getItem('boron_work_block_queue');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      // ignore
    }
    return [];
  });
  const [currentQueueIndex, setCurrentQueueIndex] = useState<number>(0);
  const [taskPoolFilter, setTaskPoolFilter] = useState<Quadrant | 'ALL'>('Q2');

  const queueRef = useRef(workBlockQueue);
  queueRef.current = workBlockQueue;
  const queueIndexRef = useRef(currentQueueIndex);
  queueIndexRef.current = currentQueueIndex;

  useEffect(() => {
    try {
      localStorage.setItem('boron_work_block_queue', JSON.stringify(workBlockQueue));
    } catch {
      // ignore
    }
  }, [workBlockQueue]);


  // GitHub Gist Sync state
  const [gistConfig, setGistConfig] = useState<GistSyncConfig>(() => loadGistConfig());
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle');
  const [syncMessage, setSyncMessage] = useState<string>('');
  const [showCompleted, setShowCompleted] = useState<boolean>(false);
  const [showMarkdownBox, setShowMarkdownBox] = useState<boolean>(false);
  const [importMarkdownText, setImportMarkdownText] = useState<string>('');

  // Lamport clock tracker for automatic background Gist sync
  const lastSyncedLamportRef = useRef<number>(state.maxLamport);
  const stateRef = useRef(state);
  stateRef.current = state;
  const gistConfigRef = useRef(gistConfig);
  gistConfigRef.current = gistConfig;

  useEffect(() => {
    saveLocalState(state);
  }, [state]);

  useEffect(() => {
    saveGistConfig(gistConfig);
  }, [gistConfig]);

  // Periodically check Q2 -> Q1 deadline escalation while app stays open
  useEffect(() => {
    const checkEscalation = () => {
      setState((curr) => {
        const { state: next, escalatedCount } = escalateNeglectedQ2Tasks(curr);
        return escalatedCount > 0 ? next : curr;
      });
    };
    const id = window.setInterval(checkEscalation, 60_000);
    return () => window.clearInterval(id);
  }, []);

  const activeTasks = useMemo(
    () =>
      Object.values(state.tasks)
        .filter((t) => !t.deleted && !t.completed)
        .sort((a, b) => a.createdAt - b.createdAt),
    [state.tasks]
  );

  const inboxTasks = useMemo(
    () => activeTasks.filter((t) => t.quadrant === 'INBOX'),
    [activeTasks]
  );

  const displayedInboxTasks = useMemo(
    () =>
      Object.values(state.tasks)
        .filter(
          (t) =>
            !t.deleted &&
            t.quadrant === 'INBOX' &&
            (showCompleted ? true : !t.completed)
        )
        .sort((a, b) => Number(a.completed) - Number(b.completed) || a.createdAt - b.createdAt),
    [state.tasks, showCompleted]
  );

  // Milestone 3: HTML5 Drag and Drop state & flicker-free counters
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [activeDropTarget, setActiveDropTarget] = useState<Quadrant | null>(null);
  const dragCounters = useRef<Record<string, number>>({});

  const handleDragStart = (e: DragEvent, taskId: string) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, button, select, [contenteditable="true"]')) {
      e.preventDefault();
      return;
    }
    if (e.dataTransfer) {
      e.dataTransfer.setData('text/plain', taskId);
      e.dataTransfer.effectAllowed = 'move';
    }
    setDraggingTaskId(taskId);
  };

  const handleDragEnd = () => {
    dragCounters.current = {};
    setDraggingTaskId(null);
    setActiveDropTarget(null);
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
  };

  const handleDragEnter = (targetQuadrant: Quadrant, e: DragEvent) => {
    e.preventDefault();
    dragCounters.current[targetQuadrant] = (dragCounters.current[targetQuadrant] || 0) + 1;
    setActiveDropTarget(targetQuadrant);
  };

  const handleDragLeave = (targetQuadrant: Quadrant, e: DragEvent) => {
    e.preventDefault();
    dragCounters.current[targetQuadrant] = Math.max(0, (dragCounters.current[targetQuadrant] || 1) - 1);
    if (dragCounters.current[targetQuadrant] === 0) {
      setActiveDropTarget((curr) => (curr === targetQuadrant ? null : curr));
    }
  };

  const handleDrop = (targetQuadrant: Quadrant, e: DragEvent) => {
    e.preventDefault();
    dragCounters.current[targetQuadrant] = 0;
    setActiveDropTarget(null);
    setDraggingTaskId(null);

    const taskId = e.dataTransfer?.getData('text/plain') || draggingTaskId;
    if (!taskId) return;

    const task = state.tasks[taskId];
    if (!task || task.deleted) return;
    if (task.quadrant === targetQuadrant) return;

    setState((curr) => {
      const next = moveTask(curr, taskId, targetQuadrant);
      saveLocalState(next);
      return next;
    });
  };

  const q2Tasks = useMemo(
    () => activeTasks.filter((t) => t.quadrant === 'Q2'),
    [activeTasks]
  );

  const analytics = useMemo(() => computeBoronAnalytics(state), [state]);

  useEffect(() => {
    if (!selectedFocusTaskId && q2Tasks.length > 0) {
      setSelectedFocusTaskId(q2Tasks[0].id);
    } else if (
      selectedFocusTaskId &&
      !q2Tasks.some((t) => t.id === selectedFocusTaskId)
    ) {
      setSelectedFocusTaskId(q2Tasks[0]?.id);
    }
  }, [q2Tasks, selectedFocusTaskId]);

  const activeQueueItem = useMemo(() => {
    if (workBlockQueue.length === 0) return null;
    if (currentQueueIndex < 0 || currentQueueIndex >= workBlockQueue.length) {
      return workBlockQueue[0] || null;
    }
    return workBlockQueue[currentQueueIndex];
  }, [workBlockQueue, currentQueueIndex]);

  // Total estimated hours and projected finish time
  const totalQueueMinutes = useMemo(() => {
    return calculateQueueTotalMinutes(workBlockQueue, state.tasks);
  }, [workBlockQueue, state.tasks]);

  const totalEstimatedHours = useMemo(() => {
    return formatTotalHours(totalQueueMinutes);
  }, [totalQueueMinutes]);

  const projectedFinishDate = useMemo(() => {
    return calculateProjectedCompletionTime(totalQueueMinutes);
  }, [totalQueueMinutes]);

  const projectedFinishTimeStr = useMemo(() => {
    return formatProjectedTime(projectedFinishDate);
  }, [projectedFinishDate]);

  // Synchronize active item duration with timer when timer is not running
  useEffect(() => {
    if (!timerRunning) {
      if (activeQueueItem) {
        const duration = getQueueItemDuration(activeQueueItem, state.tasks);
        setTimerDurationMin(duration);
        setTimerSecondsLeft(duration * 60);
        if (activeQueueItem.type === 'task') {
          setSelectedFocusTaskId(activeQueueItem.taskId);
        }
      } else if (selectedFocusTaskId && state.tasks[selectedFocusTaskId]) {
        const est = state.tasks[selectedFocusTaskId].estimatedMinutes;
        const duration = est && est > 0 ? est : 25;
        setTimerDurationMin(duration);
        setTimerSecondsLeft(duration * 60);
      }
    }
  }, [activeQueueItem, timerRunning, state.tasks, selectedFocusTaskId]);

  const handleAdvanceQueue = (fromIndex: number, logSession: boolean = true) => {
    const queue = queueRef.current;
    const currentItem = queue[fromIndex];

    // Log focus session if task, NEVER for rest blocks
    if (logSession && currentItem && currentItem.type === 'task') {
      const task = stateRef.current.tasks[currentItem.taskId];
      const logQuad = resolveTaskLogQuadrant(task);
      const duration = getQueueItemDuration(currentItem, stateRef.current.tasks);
      setState((curr) => {
        const next = logFocusSession(curr, logQuad, duration, currentItem.taskId);
        saveLocalState(next);
        return next;
      });
    }

    const nextIndex = fromIndex + 1;
    if (nextIndex < queue.length) {
      const nextItem = queue[nextIndex];
      const nextDuration = getQueueItemDuration(nextItem, stateRef.current.tasks);
      setCurrentQueueIndex(nextIndex);
      setTimerDurationMin(nextDuration);
      setTimerSecondsLeft(nextDuration * 60);
      timerEndTimeRef.current = Date.now() + nextDuration * 60 * 1000;
      setTimerRunning(true);
    } else {
      setCurrentQueueIndex(nextIndex);
      timerEndTimeRef.current = null;
      setTimerRunning(false);
      setTimerSecondsLeft(0);
    }
  };

  // Wall-clock Focus Timer (immune to background tab throttling & state-updater side effects)
  useEffect(() => {
    if (!timerRunning) {
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

    const interval = window.setInterval(syncClock, 500);
    document.addEventListener('visibilitychange', syncClock);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', syncClock);
    };
  }, [timerRunning]);

  // Handle timer completion cleanly and advance to next item automatically
  useEffect(() => {
    if (timerRunning && timerSecondsLeft === 0) {
      timerEndTimeRef.current = null;
      if (queueRef.current.length > 0 && queueIndexRef.current < queueRef.current.length) {
        handleAdvanceQueue(queueIndexRef.current, true);
      } else {
        // Fallback for single selected task outside queue
        setTimerRunning(false);
        if (selectedFocusTaskId) {
          const task = state.tasks[selectedFocusTaskId];
          const quad = resolveTaskLogQuadrant(task);
          setState((curr) => {
            const next = logFocusSession(curr, quad, timerDurationMin, selectedFocusTaskId);
            saveLocalState(next);
            return next;
          });
        }
        setTimerSecondsLeft(timerDurationMin * 60);
      }
    }
  }, [timerRunning, timerSecondsLeft, timerDurationMin, selectedFocusTaskId, state.tasks]);

  const handleMoveUp = (index: number) => {
    if (index <= 0) return;
    setWorkBlockQueue((prev) => moveQueueItem(prev, index, index - 1));
    if (currentQueueIndex === index) {
      setCurrentQueueIndex(index - 1);
    } else if (currentQueueIndex === index - 1) {
      setCurrentQueueIndex(index);
    }
  };

  const handleMoveDown = (index: number) => {
    if (index >= workBlockQueue.length - 1) return;
    setWorkBlockQueue((prev) => moveQueueItem(prev, index, index + 1));
    if (currentQueueIndex === index) {
      setCurrentQueueIndex(index + 1);
    } else if (currentQueueIndex === index + 1) {
      setCurrentQueueIndex(index);
    }
  };

  const handleRemoveQueueItem = (index: number) => {
    setWorkBlockQueue((prev) => prev.filter((_, i) => i !== index));
    if (index < currentQueueIndex) {
      setCurrentQueueIndex((curr) => Math.max(0, curr - 1));
    } else if (index === currentQueueIndex && index >= workBlockQueue.length - 1) {
      setCurrentQueueIndex((curr) => Math.max(0, curr - 1));
    }
  };

  const handleInsertRestAfter = (index: number, customDur?: number) => {
    setWorkBlockQueue((prev) => insertRestBlockAfter(prev, index, customDur, state.tasks));
    if (index < currentQueueIndex) {
      setCurrentQueueIndex((curr) => curr + 1);
    }
  };

  const handleAddRestToEnd = (duration: number = 3) => {
    const restItem: WorkBlockQueueItem = {
      id: `wb-rest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: 'rest',
      durationMinutes: duration,
    };
    setWorkBlockQueue((prev) => [...prev, restItem]);
  };

  const handleAddTaskToQueue = (taskId: string, withRest: boolean = false) => {
    const task = state.tasks[taskId];
    const taskItem: WorkBlockQueueItem = {
      id: `wb-task-${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'task',
      taskId,
    };
    if (withRest) {
      const restDuration = getDefaultRestDuration(task);
      const restItem: WorkBlockQueueItem = {
        id: `wb-rest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: 'rest',
        durationMinutes: restDuration,
      };
      setWorkBlockQueue((prev) => [...prev, taskItem, restItem]);
    } else {
      setWorkBlockQueue((prev) => [...prev, taskItem]);
    }
  };

  const handleQueueAllQ2 = () => {
    const q2s = activeTasks.filter((t) => t.quadrant === 'Q2');
    const newItems: WorkBlockQueueItem[] = [];
    for (const t of q2s) {
      newItems.push({
        id: `wb-task-${t.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'task',
        taskId: t.id,
      });
      const restDur = getDefaultRestDuration(t);
      newItems.push({
        id: `wb-rest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: 'rest',
        durationMinutes: restDur,
      });
    }
    setWorkBlockQueue((prev) => [...prev, ...newItems]);
  };

  const handleClearQueue = () => {
    if (timerRunning) {
      setTimerRunning(false);
      timerEndTimeRef.current = null;
    }
    setWorkBlockQueue([]);
    setCurrentQueueIndex(0);
    setTimerSecondsLeft(25 * 60);
    setTimerDurationMin(25);
  };

  const poolTasks = useMemo(() => {
    const list = activeTasks.slice();
    if (taskPoolFilter === 'ALL') {
      const QUADRANT_WEIGHT: Record<Quadrant, number> = {
        Q2: 0,
        Q1: 1,
        Q3: 2,
        Q4: 3,
        INBOX: 4,
      };
      list.sort((a, b) => {
        const qDiff = (QUADRANT_WEIGHT[a.quadrant] ?? 99) - (QUADRANT_WEIGHT[b.quadrant] ?? 99);
        if (qDiff !== 0) return qDiff;
        return a.createdAt - b.createdAt;
      });
      return list;
    }
    return list.filter((t) => t.quadrant === taskPoolFilter);
  }, [activeTasks, taskPoolFilter]);


  const setTriageStepChoice = (val: boolean | null) => {
    importantChoiceRef.current = val;
    setImportantChoice(val);
  };

  const handleBinaryTriageAnswer = (answer: boolean) => {
    const currentTask = inboxTasks[0];
    if (!currentTask) return;

    const currentStep1 = importantChoiceRef.current;
    if (currentStep1 === null) {
      setTriageStepChoice(answer);
    } else {
      const targetQuadrant = resolveQuadrant(currentStep1, answer);
      setTriageStepChoice(null);
      setState((curr) => triageTask(curr, currentTask.id, currentStep1, answer));
      setLastTriagedFeedback(`Moved "${currentTask.title}" → ${targetQuadrant}`);
    }
  };

  // Safe Global Keyboard Shortcuts (never hijacks Ctrl/Meta/Alt or single letters while interacting)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      const tagName = target?.tagName || '';
      const inputType = (target as HTMLInputElement | null)?.type || '';

      const isTextEntryFocused =
        tagName === 'TEXTAREA' ||
        tagName === 'SELECT' ||
        Boolean(target?.isContentEditable) ||
        (tagName === 'INPUT' && inputType !== 'checkbox' && inputType !== 'radio');

      if (isTextEntryFocused) {
        if (e.key === 'Escape') {
          target?.blur();
          setExpandedTaskId(null);
          if (isCalendarOpenRef.current) {
            setIsCalendarOpen(false);
            refocusTitle();
          }
        }
        return;
      }

      // If calendar popover is open, isolate shortcuts: protect 1-5, /, and Escape
      if (isCalendarOpenRef.current) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setIsCalendarOpen(false);
          refocusTitle();
          return;
        }
        if (['1', '2', '3', '4', '5', '/'].includes(e.key)) {
          e.preventDefault();
          return;
        }
      }

      // Do not trigger global shortcuts when a button has keyboard focus
      if (tagName === 'BUTTON') return;

      // Rapid Triage view shortcuts: Y / N / Backspace
      if (viewMode === 'TRIAGE' && inboxTasks.length > 0) {
        if (e.key.toLowerCase() === 'y') {
          e.preventDefault();
          handleBinaryTriageAnswer(true);
          return;
        }
        if (e.key.toLowerCase() === 'n') {
          e.preventDefault();
          handleBinaryTriageAnswer(false);
          return;
        }
        if (e.key === 'Backspace' && importantChoiceRef.current !== null) {
          e.preventDefault();
          setTriageStepChoice(null);
          return;
        }
      }

      // Number keys 1-5 switch views; '/' focuses quick capture
      if (e.key === '1') {
        e.preventDefault();
        setViewMode('MATRIX');
      } else if (e.key === '2') {
        e.preventDefault();
        setViewMode('TRIAGE');
      } else if (e.key === '3') {
        e.preventDefault();
        setViewMode('MORNING_Q2');
      } else if (e.key === '4') {
        e.preventDefault();
        setViewMode('ANALYTICS');
      } else if (e.key === '5') {
        e.preventDefault();
        setViewMode('SYNC_LAB');
      } else if (e.key === '/') {
        e.preventDefault();
        captureInputRef.current?.focus();
      } else if (e.key === 'Escape') {
        setExpandedTaskId(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [viewMode, inboxTasks]);

  const handleQuickAdd = (e: Event) => {
    e.preventDefault();
    if (!captureText.trim()) return;
    if (isCalendarOpen && calendarOffset.trim()) {
      handlePopoverSubmit();
    } else {
      submitTaskWithDate(undefined);
    }
  };

  const handleToggleComplete = (task: TaskItem) => {
    const becomingCompleted = !task.completed;
    setState((curr) => toggleTaskCompleted(curr, task.id));
    if (becomingCompleted && task.quadrant === 'Q1') {
      setCompletedQ1Crisis(task);
      setPreventionInput('');
    }
  };

  const handleCreatePreventiveQ2 = (e: Event) => {
    e.preventDefault();
    if (!completedQ1Crisis || !preventionInput.trim()) return;
    setState((curr) =>
      addTask(curr, preventionInput, 'Q2', {
        preventsTaskId: completedQ1Crisis.id,
      })
    );
    setCompletedQ1Crisis(null);
    setPreventionInput('');
  };

  const handleSyncGist = async () => {
    const config = gistConfigRef.current;
    const currentState = stateRef.current;
    if (!config.token.trim() || !config.gistId.trim()) return;

    setSyncStatus('syncing');
    setSyncMessage('Syncing (local ⊔ remote)...');
    try {
      const outcome = await syncWithGitHubGist(config, currentState);
      setState(outcome.mergedState);
      lastSyncedLamportRef.current = outcome.mergedState.maxLamport;
      setSyncStatus('success');
      setSyncMessage(
        `Synced ${new Date(outcome.syncedAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })}`
      );
    } catch (err: unknown) {
      setSyncStatus('error');
      setSyncMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCreateSecretGist = async () => {
    setSyncStatus('syncing');
    setSyncMessage('Creating secret Gist...');
    try {
      const outcome = await createNewSecretGist(gistConfig.token, state);
      setGistConfig((prev) => ({ ...prev, gistId: outcome.gistId }));
      setState(outcome.mergedState);
      lastSyncedLamportRef.current = outcome.mergedState.maxLamport;
      setSyncStatus('success');
      setSyncMessage(`Created Gist: ${outcome.gistId}`);
    } catch (err: unknown) {
      setSyncStatus('error');
      setSyncMessage(err instanceof Error ? err.message : String(err));
    }
  };

  // Automatic Gist synchronization on maxLamport increase (debounced 2000ms)
  useEffect(() => {
    if (
      !gistConfig.autoSync ||
      !gistConfig.token.trim() ||
      !gistConfig.gistId.trim()
    ) {
      return;
    }

    if (state.maxLamport > lastSyncedLamportRef.current) {
      const timer = window.setTimeout(() => {
        handleSyncGist();
      }, 2000);
      return () => window.clearTimeout(timer);
    }
  }, [state.maxLamport, gistConfig.autoSync, gistConfig.token, gistConfig.gistId]);

  // Automatic Gist synchronization on window 'online' & document 'visibilitychange'
  useEffect(() => {
    if (
      !gistConfig.autoSync ||
      !gistConfig.token.trim() ||
      !gistConfig.gistId.trim()
    ) {
      return;
    }

    const handleOnline = () => {
      handleSyncGist();
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        handleSyncGist();
      }
    };

    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [gistConfig.autoSync, gistConfig.token, gistConfig.gistId]);

  const semilatticeProof = useMemo(() => {
    const replicaLaptop = addTask(
      { ...state, nodeId: 'laptop_mimuw' },
      'Simulated offline laptop edit #q2'
    );
    const replicaPhone = addTask(
      { ...state, nodeId: 'phone_metro' },
      'Simulated offline phone edit #q3'
    );
    return verifySemilatticeLaws(state, replicaLaptop, replicaPhone);
  }, [state]);


  const renderTaskCard = (task: TaskItem) => {
    const hoursLeft = getHoursUntilDue(task.dueDate);
    const isDriftingToQ1 =
      task.quadrant === 'Q2' &&
      hoursLeft !== null &&
      hoursLeft <= 72 &&
      !task.completed;

    const totalChecklist = task.checklist?.length || 0;
    const doneChecklist =
      task.checklist?.filter((s) => s.done).length || 0;
    const checklistPct =
      totalChecklist > 0
        ? Math.round((doneChecklist / totalChecklist) * 100)
        : 0;

    return (
      <div
        key={task.id}
        class={`task-item ${task.completed ? 'completed' : ''} ${
          draggingTaskId === task.id ? 'is-dragging' : ''
        }`}
        draggable={expandedTaskId !== task.id}
        onDragStart={(e) => handleDragStart(e, task.id)}
        onDragEnd={handleDragEnd}
        data-task-id={task.id}
      >
        <div class="task-left">
          <input
            type="checkbox"
            class="task-checkbox"
            checked={task.completed}
            onChange={() => handleToggleComplete(task)}
            aria-label={`Complete "${task.title}"`}
          />
          <div
            class="task-body"
            onClick={() =>
              setExpandedTaskId(
                expandedTaskId === task.id ? null : task.id
              )
            }
            style={{ cursor: 'pointer' }}
          >
            <div class="task-title" title="Click to expand/edit">
              {task.title}
            </div>

            <div class="task-meta">
              {(task.escalatedFromQ2 || isDriftingToQ1) && (
                <span class="tag-chip tag-alert">
                  !{' '}
                  {task.escalatedFromQ2
                    ? 'Escalated'
                    : `${Math.max(0, Math.round(hoursLeft!))}h`}
                </span>
              )}
              {totalChecklist > 0 && (
                <>
                  <span class="tag-chip">
                    ✓ {doneChecklist}/{totalChecklist}
                  </span>
                  <span
                    class="subtask-progress-mini"
                    title={`${checklistPct}% completed`}
                  >
                    <span
                      class="subtask-progress-bar"
                      style={{ width: `${checklistPct}%` }}
                    />
                  </span>
                </>
              )}
              {task.focusMinutesLogged > 0 && (
                <span class="tag-chip tag-q2-focus">
                  {task.focusMinutesLogged}m logged
                </span>
              )}
              {task.dueDate && (
                <span class="tag-chip">{task.dueDate}</span>
              )}
              {task.estimatedMinutes && (
                <span class="tag-chip">
                  ~{task.estimatedMinutes}m
                </span>
              )}
            </div>

            {task.concurrentConflicts &&
              task.concurrentConflicts.length > 0 && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    marginTop: '0.3rem',
                    padding: '0.35rem 0.55rem',
                    borderRadius: '6px',
                    background: 'rgba(56, 189, 248, 0.1)',
                    border: '1px solid rgba(56, 189, 248, 0.4)',
                    fontSize: '0.74rem',
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '0.35rem',
                  }}
                >
                  <span>
                    ⚡ Overlap ({task.concurrentConflicts[0].clock.nodeId}):{' '}
                    <strong>[{task.concurrentConflicts[0].quadrant}]</strong>{' '}
                    “{task.concurrentConflicts[0].title}”
                  </span>
                  <span style={{ display: 'flex', gap: '0.3rem' }}>
                    <button
                      type="button"
                      class="btn btn-sm btn-primary"
                      onClick={() =>
                        setState((curr) =>
                          resolveTaskConflict(
                            curr,
                            task.id,
                            'FORK_OVERLAP'
                          )
                        )
                      }
                    >
                      Keep Both
                    </button>
                    <button
                      type="button"
                      class="btn btn-sm"
                      onClick={() =>
                        setState((curr) =>
                          resolveTaskConflict(
                            curr,
                            task.id,
                            'KEEP_PRIMARY'
                          )
                        )
                      }
                    >
                      Dismiss
                    </button>
                  </span>
                </div>
              )}

            {expandedTaskId === task.id && (
              <div
                class="task-drawer-inline"
                onClick={(e) => e.stopPropagation()}
                style={{ cursor: 'default' }}
              >
                <div class="task-edit-row">
                  <input
                    type="text"
                    class="capture-input"
                    style={{
                      padding: '0.25rem 0.45rem',
                      fontSize: '0.82rem',
                    }}
                    placeholder="Task title..."
                    defaultValue={task.title}
                    onBlur={(e) => {
                      const val = (e.target as HTMLInputElement).value.trim();
                      if (val && val !== task.title) {
                        setState((curr) =>
                          updateTaskDetails(curr, task.id, {
                            title: val,
                          })
                        );
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        const val = (e.currentTarget as HTMLInputElement).value.trim();
                        if (val && val !== task.title) {
                          setState((curr) =>
                            updateTaskDetails(curr, task.id, {
                              title: val,
                            })
                          );
                        }
                        (e.currentTarget as HTMLInputElement).blur();
                      }
                    }}
                  />
                  <input
                    type="date"
                    class="capture-date"
                    aria-label="Due Date"
                    value={task.dueDate || ''}
                    onInput={(e) => {
                      const val = (e.target as HTMLInputElement).value;
                      setState((curr) =>
                        updateTaskDetails(curr, task.id, {
                          dueDate: val || undefined,
                        })
                      );
                    }}
                  />
                  <input
                    type="text"
                    class="capture-input"
                    style={{
                      padding: '0.25rem 0.45rem',
                      fontSize: '0.82rem',
                    }}
                    placeholder="Notes..."
                    value={task.notes || ''}
                    onInput={(e) => {
                      const val = (e.target as HTMLInputElement).value;
                      setState((curr) =>
                        updateTaskDetails(curr, task.id, {
                          notes: val,
                        })
                      );
                    }}
                  />
                </div>

                {totalChecklist > 0 && (
                  <div class="subtask-list">
                    {(task.checklist || []).map((item) => (
                      <div
                        key={item.id}
                        class={`subtask-item ${item.done ? 'done' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={item.done}
                          onChange={() =>
                            setState((curr) =>
                              toggleSubtask(curr, task.id, item.id)
                            )
                          }
                          aria-label={`Toggle subtask "${item.text}"`}
                        />
                        <span class="subtask-text">
                          {item.text}
                        </span>
                        <button
                          type="button"
                          class="icon-btn"
                          title="Delete subtask"
                          onClick={() =>
                            setState((curr) =>
                              deleteSubtask(curr, task.id, item.id)
                            )
                          }
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <form
                  class="subtask-add-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!subtaskDraft.trim()) return;
                    setState((curr) =>
                      addSubtask(curr, task.id, subtaskDraft)
                    );
                    setSubtaskDraft('');
                  }}
                >
                  <input
                    type="text"
                    class="capture-input"
                    style={{
                      padding: '0.25rem 0.45rem',
                      fontSize: '0.82rem',
                    }}
                    placeholder="Add subtask (press Enter)..."
                    value={subtaskDraft}
                    onInput={(e) =>
                      setSubtaskDraft(
                        (e.target as HTMLInputElement).value
                      )
                    }
                  />
                  <button
                    type="submit"
                    class="btn btn-sm btn-primary"
                  >
                    + Subtask
                  </button>
                </form>
              </div>
            )}
          </div>
        </div>

        <div class="task-actions">
          {task.quadrant === 'Q2' && !task.completed && (
            <button
              type="button"
              class="icon-btn"
              title="Focus on this Q2 task"
              onClick={() => {
                setSelectedFocusTaskId(task.id);
                setViewMode('MORNING_Q2');
              }}
            >
              ▶
            </button>
          )}
          <select
            class="icon-btn"
            value={task.quadrant}
            aria-label="Move Quadrant"
            onChange={(e) =>
              setState((curr) =>
                moveTask(
                  curr,
                  task.id,
                  (e.target as HTMLSelectElement).value as Quadrant
                )
              )
            }
          >
            <option value="Q2">Q2</option>
            <option value="Q1">Q1</option>
            <option value="Q3">Q3</option>
            <option value="Q4">Q4</option>
            <option value="INBOX">Inbox</option>
          </select>
          <button
            type="button"
            class="icon-btn"
            title="Delete task"
            onClick={() =>
              setState((curr) => deleteTask(curr, task.id))
            }
          >
            ✕
          </button>
        </div>
      </div>
    );
  };

  return (
    <div class="app-shell">
      {/* Header */}
      <header class="topbar">
        <div class="brand">
          <h1>Boron Q4</h1>
        </div>

        <div class="status-pills">
          <span
            class={`pill ${analytics.didQ2Today ? 'pill-q2' : 'pill-warn'}`}
            title="Morning Q2 focus logged today"
          >
            Q2: {analytics.todayQ2Minutes}m today
          </span>

          {/* Theme selector */}
          <select
            class="pill"
            style={{ cursor: 'pointer', appearance: 'auto' }}
            value={visualPrefs.themeId}
            aria-label="Theme Selection"
            onChange={(e) =>
              setVisualPrefs((prev) => ({
                ...prev,
                themeId: (e.target as HTMLSelectElement).value,
              }))
            }
          >
            {THEME_REGISTRY.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.label}
              </option>
            ))}
          </select>

          {/* Density toggle button */}
          <button
            type="button"
            class="pill"
            title="Toggle display density"
            onClick={() =>
              setVisualPrefs((prev) => ({
                ...prev,
                density: prev.density === 'comfortable' ? 'compact' : 'comfortable',
              }))
            }
          >
            {visualPrefs.density === 'comfortable' ? 'Comfortable' : 'Compact'}
          </button>

          <button
            type="button"
            class="pill pill-sync"
            onClick={() =>
              gistConfig.token && gistConfig.gistId
                ? handleSyncGist()
                : setViewMode('SYNC_LAB')
            }
          >
            ☁️{' '}
            {syncStatus === 'syncing'
              ? 'Syncing...'
              : state.lastSyncedAt
              ? new Date(state.lastSyncedAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : 'Sync'}
          </button>
        </div>
      </header>

      {/* Navigation Tabs */}
      <nav class="nav-tabs" aria-label="Main Views">
        <button
          type="button"
          class={`nav-tab ${viewMode === 'MATRIX' ? 'active' : ''}`}
          onClick={() => setViewMode('MATRIX')}
        >
          <span>Matrix</span>
        </button>

        <button
          type="button"
          class={`nav-tab ${viewMode === 'TRIAGE' ? 'active' : ''}`}
          onClick={() => setViewMode('TRIAGE')}
        >
          <span>Triage</span>
          {inboxTasks.length > 0 && (
            <span class="badge-count">{inboxTasks.length}</span>
          )}
        </button>

        <button
          type="button"
          class={`nav-tab ${viewMode === 'MORNING_Q2' || viewMode === 'FOCUS' ? 'active-q2' : ''}`}
          onClick={() => setViewMode('MORNING_Q2')}
        >
          <span>Work Block</span>
          <span class="badge-count badge-q2">{q2Tasks.length}</span>
        </button>


        <button
          type="button"
          class={`nav-tab ${viewMode === 'ANALYTICS' ? 'active' : ''}`}
          onClick={() => setViewMode('ANALYTICS')}
        >
          <span>Analytics</span>
        </button>

        <button
          type="button"
          class={`nav-tab ${viewMode === 'SYNC_LAB' ? 'active' : ''}`}
          onClick={() => setViewMode('SYNC_LAB')}
        >
          <span>Sync & Lab</span>
        </button>
      </nav>

      {/* 3-Step Task Capture Bar & Calendar Popover */}
      <form class="capture-bar" onSubmit={handleQuickAdd}>
        <div class="capture-row">
          <input
            ref={captureInputRef}
            type="text"
            class="capture-input capture-title-input"
            placeholder="Task description... (Enter for hours, / to focus)"
            value={captureText}
            onInput={(e) => setCaptureText((e.target as HTMLInputElement).value)}
            onKeyDown={handleTitleKeyDown}
            aria-label="Task Title"
          />

          <div class="capture-hours-wrapper">
            <input
              ref={hoursInputRef}
              type="number"
              step="any"
              min="0"
              class="capture-input capture-hours-input"
              placeholder="Hours (e.g. 0.25)"
              value={captureHours}
              onInput={(e) => setCaptureHours((e.target as HTMLInputElement).value)}
              onKeyDown={handleHoursKeyDown}
              aria-label="Estimated Hours"
            />
            {convertedMinutes !== undefined && (
              <span class="capture-minutes-hint">{convertedMinutes}m</span>
            )}
          </div>

          <select
            class="capture-select"
            value={captureQuadrant}
            onChange={(e) =>
              setCaptureQuadrant((e.target as HTMLSelectElement).value as Quadrant)
            }
            aria-label="Target Quadrant"
          >
            <option value="INBOX">Inbox</option>
            <option value="Q2">Q2 (Important)</option>
            <option value="Q1">Q1 (Urgent)</option>
            <option value="Q3">Q3</option>
            <option value="Q4">Q4</option>
          </select>

          <button type="submit" class="btn btn-primary">
            Add
          </button>
        </div>

        {/* Step 3: Calendar Popover */}
        {isCalendarOpen && (
          <div
            ref={popoverRef}
            class="calendar-popover"
            role="dialog"
            aria-label="Select Task Deadline"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setIsCalendarOpen(false);
                refocusTitle();
              }
            }}
          >
            <div class="popover-header">
              <div class="offset-input-wrap">
                <label for="calendar-offset-input" class="offset-label">
                  Days offset:
                </label>
                <input
                  id="calendar-offset-input"
                  ref={calendarOffsetInputRef}
                  type="number"
                  min="0"
                  class="offset-input"
                  placeholder="0 = today, Enter for none"
                  value={calendarOffset}
                  onInput={handleOffsetInput}
                  onKeyDown={handleOffsetKeyDown}
                  aria-label="Days offset from today"
                />
              </div>

              <button
                type="button"
                class="btn-no-deadline"
                onClick={() => submitTaskWithDate(undefined)}
              >
                No deadline (press Enter)
              </button>
            </div>

            <div class="calendar-nav">
              <button
                type="button"
                class="nav-arrow"
                onClick={handlePrevMonth}
                aria-label="Previous month"
              >
                ‹
              </button>
              <span class="nav-month-title">{monthTitle}</span>
              <button
                type="button"
                class="nav-arrow"
                onClick={handleNextMonth}
                aria-label="Next month"
              >
                ›
              </button>
            </div>

            <div class="calendar-grid">
              <div class="day-headers">
                {DAY_HEADERS.map((h) => (
                  <span class="day-header" key={h}>
                    {h}
                  </span>
                ))}
              </div>
              <div class="day-cells">
                {calendarDays.map((cell, idx) => {
                  if (!cell.isCurrentMonth) {
                    return <div class="day-cell-empty" key={`empty-${idx}`} />;
                  }
                  const isSelected = Boolean(
                    highlightedDateISO && cell.dateStr === highlightedDateISO
                  );
                  const isToday = cell.dateStr === todayISO;
                  return (
                    <button
                      key={cell.dateStr}
                      type="button"
                      class={`day-cell ${isToday ? 'is-today' : ''} ${
                        isSelected ? 'is-selected' : ''
                      }`}
                      data-date={cell.dateStr}
                      onClick={() => handleDayCellClick(cell.dateStr)}
                      aria-label={`Deadline ${cell.dateStr}`}
                    >
                      {cell.dayNum}
                    </button>
                  );
                })}
              </div>
            </div>

            <div class="popover-footer">
              <span class="footer-hint">
                Enter = submit • Esc = cancel • Click cell = select date
              </span>
            </div>
          </div>
        )}
      </form>

      {/* Compact Single-Line Prevention Banner */}
      {completedQ1Crisis && (
        <form class="prevention-banner" onSubmit={handleCreatePreventiveQ2}>
          <span>
            Prevent next <strong>“{completedQ1Crisis.title}”</strong> in Q2:
          </span>
          <div style={{ display: 'flex', gap: '0.4rem', flex: 1, minWidth: '200px' }}>
            <input
              type="text"
              class="capture-input"
              style={{ padding: '0.35rem 0.6rem', fontSize: '0.82rem' }}
              placeholder="Preventive Q2 habit or task..."
              value={preventionInput}
              onInput={(e) =>
                setPreventionInput((e.target as HTMLInputElement).value)
              }
            />
            <button type="submit" class="btn btn-q2 btn-sm">
              + Q2 Task
            </button>
            <button
              type="button"
              class="btn btn-sm"
              onClick={() => setCompletedQ1Crisis(null)}
            >
              ✕
            </button>
          </div>
        </form>
      )}

      {/* VIEW 1: 4-QUADRANT MATRIX */}
      {viewMode === 'MATRIX' && (
        <>
          {/* Permanent Cardboard Inbox Drop Zone */}
          <div
            class={`inbox-strip ${
              activeDropTarget === 'INBOX' ? 'drop-active drag-over drop-target-active' : ''
            }`}
            onDragOver={handleDragOver}
            onDragEnter={(e) => handleDragEnter('INBOX', e)}
            onDragLeave={(e) => handleDragLeave('INBOX', e)}
            onDrop={(e) => handleDrop('INBOX', e)}
            aria-label="Inbox drop target"
          >
            <div class="inbox-strip-header">
              <div class="inbox-strip-title">
                <span>📦</span>
                <strong>Inbox</strong>
                <span class="pill">{inboxTasks.length}</span>
              </div>
              {inboxTasks.length > 0 && (
                <button
                  type="button"
                  class="btn btn-primary btn-sm"
                  onClick={() => setViewMode('TRIAGE')}
                >
                  Triage Now →
                </button>
              )}
            </div>

            {displayedInboxTasks.length === 0 ? (
              <div class="inbox-empty-hint">
                Drop sticky notes here to park in Inbox
              </div>
            ) : (
              <div class="inbox-task-list">
                {displayedInboxTasks.map((task) => renderTaskCard(task))}
              </div>
            )}
          </div>

          <div class="matrix-grid">
            {(['Q1', 'Q2', 'Q3', 'Q4'] as const).map((qId) => {
              const meta = QUADRANT_META[qId];
              const qTasks = Object.values(state.tasks)
                .filter(
                  (t) =>
                    !t.deleted &&
                    t.quadrant === qId &&
                    (showCompleted ? true : !t.completed)
                )
                .sort((a, b) => Number(a.completed) - Number(b.completed));

              return (
                <section
                  key={qId}
                  class={`quadrant-card quadrant-${qId} ${
                    activeDropTarget === qId ? 'drop-active drag-over drop-target-active' : ''
                  }`}
                  onDragOver={handleDragOver}
                  onDragEnter={(e) => handleDragEnter(qId, e)}
                  onDragLeave={(e) => handleDragLeave(qId, e)}
                  onDrop={(e) => handleDrop(qId, e)}
                  aria-label={`${meta.title} drop target`}
                >
                  <div class="quadrant-header">
                    <div>
                      <div
                        class="quadrant-title"
                        style={{ color: meta.accentColor }}
                      >
                        <span>{meta.title}</span>
                      </div>
                      <div class="quadrant-subtitle">{meta.subtitle}</div>
                    </div>
                    <span class="pill">{qTasks.filter((t) => !t.completed).length}</span>
                  </div>

                  <div class="task-list">
                    {qTasks.length === 0 ? (
                      <div
                        style={{
                          padding: '1rem',
                          textAlign: 'center',
                          color: 'var(--text-dim)',
                          fontSize: '0.8rem',
                        }}
                      >
                        Empty
                      </div>
                    ) : (
                      qTasks.map((task) => renderTaskCard(task))
                    )}
                  </div>
                </section>
              );
            })}
          </div>

          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={showCompleted}
                onChange={(e) =>
                  setShowCompleted((e.target as HTMLInputElement).checked)
                }
              />
              Show completed tasks
            </label>
          </div>
        </>
      )}

      {/* VIEW 2: RAPID 2-DECISION BINARY TRIAGE */}
      {viewMode === 'TRIAGE' && (
        <div class="triage-container">
          {lastTriagedFeedback && (
            <div class="pill pill-q2" style={{ alignSelf: 'center' }}>
              ✓ {lastTriagedFeedback}
            </div>
          )}

          {inboxTasks.length === 0 ? (
            <div class="triage-card">
              <h2>Inbox Zero</h2>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.88rem' }}>
                All tasks are sorted.
              </p>
              <div style={{ display: 'flex', justifyContent: 'center', gap: '0.6rem' }}>
                <button
                  type="button"
                  class="btn btn-q2"
                  onClick={() => setViewMode('MORNING_Q2')}
                >
                  Q2 Focus
                </button>
                <button
                  type="button"
                  class="btn"
                  onClick={() => setViewMode('MATRIX')}
                >
                  Matrix
                </button>
              </div>
            </div>
          ) : (
            <div class="triage-card">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: '0.78rem',
                  color: 'var(--text-muted)',
                }}
              >
                <span>2-STEP TRIAGE</span>
                <span>{inboxTasks.length} left</span>
              </div>

              <div class="triage-task-title">“{inboxTasks[0].title}”</div>

              {importantChoice === null ? (
                <div class="triage-step-box">
                  <div class="triage-question">Step 1: Is this IMPORTANT?</div>
                  <div class="triage-sub">
                    Does it matter for long-term goals, health, or CS mastery?
                  </div>
                  <div class="triage-buttons">
                    <button
                      type="button"
                      class="triage-choice-btn triage-choice-yes"
                      onClick={() => handleBinaryTriageAnswer(true)}
                    >
                      <span>YES — Important</span>
                      <span class="kbd-hint">Y</span>
                    </button>
                    <button
                      type="button"
                      class="triage-choice-btn triage-choice-no"
                      onClick={() => handleBinaryTriageAnswer(false)}
                    >
                      <span>NO — Not Important</span>
                      <span class="kbd-hint">N</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div class="triage-step-box">
                  <div class="triage-question">Step 2: Is this URGENT now?</div>
                  <div class="triage-sub">
                    {importantChoice
                      ? 'YES → Q1 (Crisis) | NO → Q2 (Deep Work)'
                      : 'YES → Q3 (Chore) | NO → Q4 (Leisure)'}
                  </div>
                  <div class="triage-buttons">
                    <button
                      type="button"
                      class="triage-choice-btn triage-choice-no"
                      onClick={() => handleBinaryTriageAnswer(true)}
                    >
                      <span>YES → {importantChoice ? 'Q1' : 'Q3'}</span>
                      <span class="kbd-hint">Y</span>
                    </button>
                    <button
                      type="button"
                      class="triage-choice-btn triage-choice-yes"
                      onClick={() => handleBinaryTriageAnswer(false)}
                    >
                      <span>NO → {importantChoice ? 'Q2' : 'Q4'}</span>
                      <span class="kbd-hint">N</span>
                    </button>
                  </div>
                  <button
                    type="button"
                    class="btn btn-sm"
                    style={{ alignSelf: 'center' }}
                    onClick={() => setTriageStepChoice(null)}
                  >
                    ← Back (Backspace)
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* VIEW 3: WORK BLOCK BUILDER & SEQUENTIAL FOCUS TIMER */}
      {(viewMode === 'MORNING_Q2' || viewMode === 'FOCUS') && (
        <div class="focus-arena work-block-arena">
          <div class="work-block-header">
            <div>
              <div class="work-block-title">
                <span>⏱️ Work Block Arena</span>
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                Sequential focus sessions with automatic rest blocks & finish projections
              </div>
            </div>

            <div class="work-block-stats">
              <div class="stat-pill" title="Total duration across all queued tasks and rest blocks">
                <span class="stat-label">Total Duration:</span>
                <strong class="stat-value">{totalEstimatedHours}</strong>
                <span class="stat-sub">({totalQueueMinutes}m)</span>
              </div>
              <div class="stat-pill" title="Projected finish time based on current time and queue duration">
                <span class="stat-label">Projected Finish:</span>
                <strong class="stat-value">{projectedFinishTimeStr}</strong>
              </div>
              <div class="stat-pill" title="Items in work block queue">
                <span class="stat-label">Queue:</span>
                <strong class="stat-value">
                  {workBlockQueue.filter((i) => i.type === 'task').length} tasks,{' '}
                  {workBlockQueue.filter((i) => i.type === 'rest').length} rest
                </strong>
              </div>
            </div>
          </div>

          {/* Sequential Timer Box */}
          <div class="timer-box">
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {activeQueueItem?.type === 'rest'
                  ? '☕ ACTIVE REST INTERVAL'
                  : activeQueueItem?.type === 'task'
                  ? `FOCUS TARGET: ${state.tasks[activeQueueItem.taskId]?.quadrant || 'Q2'}`
                  : 'FOCUS TARGET'}
              </div>
              <div style={{ fontSize: '1.05rem', fontWeight: 700, marginTop: '0.15rem' }}>
                {activeQueueItem?.type === 'rest'
                  ? `Rest Period (${activeQueueItem.durationMinutes}m)`
                  : activeQueueItem?.type === 'task'
                  ? state.tasks[activeQueueItem.taskId]?.title || 'Queued task'
                  : currentQueueIndex >= workBlockQueue.length && workBlockQueue.length > 0
                  ? '🎉 Work Block Complete!'
                  : q2Tasks.find((t) => t.id === selectedFocusTaskId)?.title ||
                    'Select or queue tasks below'}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                {workBlockQueue.length > 0
                  ? currentQueueIndex < workBlockQueue.length
                    ? `Queue Block ${currentQueueIndex + 1} of ${workBlockQueue.length}`
                    : 'All queued items completed!'
                  : 'Single session mode'}
              </div>

              {/* Quick duration overrides */}
              <div
                style={{
                  display: 'flex',
                  gap: '0.35rem',
                  marginTop: '0.5rem',
                  flexWrap: 'wrap',
                }}
              >
                {(activeQueueItem?.type === 'rest' ? [3, 5, 10, 15] : [15, 25, 45, 60]).map(
                  (mins) => (
                    <button
                      key={mins}
                      type="button"
                      class={`btn btn-sm ${timerDurationMin === mins ? (activeQueueItem?.type === 'rest' ? 'tag-rest' : 'btn-q2') : ''}`}
                      onClick={() => {
                        timerEndTimeRef.current = null;
                        setTimerRunning(false);
                        setTimerDurationMin(mins);
                        setTimerSecondsLeft(mins * 60);
                      }}
                    >
                      {mins}m
                    </button>
                  )
                )}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', flexWrap: 'wrap' }}>
              <div class="timer-digits mono">{formatTimer(timerSecondsLeft)}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <button
                  type="button"
                  class={`btn ${activeQueueItem?.type === 'rest' ? '' : 'btn-q2'}`}
                  onClick={() => {
                    if (timerRunning) {
                      timerEndTimeRef.current = null;
                      setTimerRunning(false);
                    } else {
                      timerEndTimeRef.current = Date.now() + timerSecondsLeft * 1000;
                      setTimerRunning(true);
                    }
                  }}
                >
                  {timerRunning ? 'Pause' : 'Start Timer'}
                </button>
                <div style={{ display: 'flex', gap: '0.35rem' }}>
                  <button
                    type="button"
                    class="btn btn-sm"
                    onClick={() => {
                      timerEndTimeRef.current = null;
                      if (workBlockQueue.length > 0 && currentQueueIndex < workBlockQueue.length) {
                        handleAdvanceQueue(currentQueueIndex, true);
                      } else {
                        setTimerRunning(false);
                        if (selectedFocusTaskId) {
                          const task = state.tasks[selectedFocusTaskId];
                          const quad = resolveTaskLogQuadrant(task);
                          setState((curr) =>
                            logFocusSession(curr, quad, timerDurationMin, selectedFocusTaskId)
                          );
                        }
                        setTimerSecondsLeft(timerDurationMin * 60);
                      }
                    }}
                    title="Log session (if task) and advance to next item"
                  >
                    Complete & Next
                  </button>
                  {workBlockQueue.length > 0 && currentQueueIndex < workBlockQueue.length && (
                    <button
                      type="button"
                      class="btn btn-sm"
                      onClick={() => {
                        timerEndTimeRef.current = null;
                        handleAdvanceQueue(currentQueueIndex, false);
                      }}
                      title="Skip this item without logging focus time"
                    >
                      Skip
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Work Block Layout: 2 Columns (Queue & Task Selection Pool) */}
          <div class="work-block-layout">
            {/* Left Column: Work Block Queue */}
            <div class="queue-panel">
              <div class="panel-header-row">
                <h4>Ordered Work Block Queue</h4>
                <div class="queue-controls-bar">
                  <button
                    type="button"
                    class="btn btn-sm btn-q2"
                    onClick={handleQueueAllQ2}
                    title="Queue all active Q2 tasks with default rest blocks"
                  >
                    + Queue All Q2
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm"
                    onClick={() => handleAddRestToEnd(3)}
                    title="Append 3m rest block to queue"
                  >
                    + Rest (3m)
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm"
                    onClick={() => handleAddRestToEnd(10)}
                    title="Append 10m rest block to queue"
                  >
                    + Rest (10m)
                  </button>
                  {workBlockQueue.length > 0 && (
                    <button
                      type="button"
                      class="btn btn-sm btn-danger-ghost"
                      onClick={handleClearQueue}
                      title="Clear all queue items"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {workBlockQueue.length === 0 ? (
                <div class="queue-empty-box">
                  <div style={{ fontSize: '1.2rem' }}>📋</div>
                  <div>Work block queue is empty.</div>
                  <div style={{ fontSize: '0.78rem' }}>
                    Select tasks from the pool on the right or click <strong>+ Queue All Q2</strong> to build your sequence.
                  </div>
                </div>
              ) : (
                <div class="queue-list">
                  {workBlockQueue.map((item, idx) => {
                    const isActive = idx === currentQueueIndex;
                    if (item.type === 'task') {
                      const task = state.tasks[item.taskId];
                      const est = task?.estimatedMinutes || 25;
                      const restDur = getDefaultRestDuration(task);
                      return (
                        <div
                          key={item.id}
                          class={`queue-item ${isActive ? 'active-item' : ''}`}
                        >
                          <div class="queue-item-left">
                            <span class="queue-rank">#{idx + 1}</span>
                            <span class={`tag-chip tag-${(task?.quadrant || 'Q2').toLowerCase()}`}>
                              {task?.quadrant || 'Q2'}
                            </span>
                            <div class="queue-item-content">
                              <div class="queue-item-title" title={task?.title || 'Unknown task'}>
                                {task?.title || '(Deleted task)'}
                              </div>
                              <div class="queue-item-meta">
                                <span>~{est}m</span>
                                {task && task.focusMinutesLogged > 0 && (
                                  <span>• {task.focusMinutesLogged}m logged</span>
                                )}
                                {isActive && (
                                  <span class="tag-active-indicator">● Active</span>
                                )}
                              </div>
                            </div>
                          </div>

                          <div class="queue-item-actions">
                            <button
                              type="button"
                              class="btn btn-sm btn-icon"
                              disabled={idx === 0}
                              onClick={() => handleMoveUp(idx)}
                              title="Move Up"
                              aria-label="Move Up"
                            >
                              ▲
                            </button>
                            <button
                              type="button"
                              class="btn btn-sm btn-icon"
                              disabled={idx === workBlockQueue.length - 1}
                              onClick={() => handleMoveDown(idx)}
                              title="Move Down"
                              aria-label="Move Down"
                            >
                              ▼
                            </button>
                            <button
                              type="button"
                              class="btn btn-sm"
                              onClick={() => handleInsertRestAfter(idx, restDur)}
                              title={`Insert ${restDur}m rest block after this task`}
                            >
                              + Rest ({restDur}m)
                            </button>
                            <button
                              type="button"
                              class={`btn btn-sm ${isActive ? 'btn-q2' : ''}`}
                              onClick={() => {
                                setCurrentQueueIndex(idx);
                                if (!timerRunning) {
                                  setTimerDurationMin(est);
                                  setTimerSecondsLeft(est * 60);
                                  setSelectedFocusTaskId(item.taskId);
                                }
                              }}
                            >
                              {isActive ? 'Active' : 'Select'}
                            </button>
                            <button
                              type="button"
                              class="btn btn-sm btn-icon btn-danger-ghost"
                              onClick={() => handleRemoveQueueItem(idx)}
                              title="Remove from queue"
                              aria-label="Remove from queue"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      );
                    } else {
                      // Rest Block item
                      return (
                        <div
                          key={item.id}
                          class={`queue-item rest-item ${isActive ? 'active-item' : ''}`}
                        >
                          <div class="queue-item-left">
                            <span class="queue-rank">#{idx + 1}</span>
                            <span class="tag-chip tag-rest">☕ Rest</span>
                            <div class="queue-item-content">
                              <div class="queue-item-title">
                                Rest Period ({item.durationMinutes}m)
                              </div>
                              <div class="queue-item-meta">
                                <span>Recharge & hydrate</span>
                                {isActive && (
                                  <span class="tag-active-indicator">● Active</span>
                                )}
                              </div>
                            </div>
                          </div>

                          <div class="queue-item-actions">
                            <button
                              type="button"
                              class="btn btn-sm btn-icon"
                              disabled={idx === 0}
                              onClick={() => handleMoveUp(idx)}
                              title="Move Up"
                              aria-label="Move Up"
                            >
                              ▲
                            </button>
                            <button
                              type="button"
                              class="btn btn-sm btn-icon"
                              disabled={idx === workBlockQueue.length - 1}
                              onClick={() => handleMoveDown(idx)}
                              title="Move Down"
                              aria-label="Move Down"
                            >
                              ▼
                            </button>
                            <button
                              type="button"
                              class={`btn btn-sm ${isActive ? 'btn-q2' : ''}`}
                              onClick={() => {
                                setCurrentQueueIndex(idx);
                                if (!timerRunning) {
                                  setTimerDurationMin(item.durationMinutes);
                                  setTimerSecondsLeft(item.durationMinutes * 60);
                                }
                              }}
                            >
                              {isActive ? 'Active' : 'Select'}
                            </button>
                            <button
                              type="button"
                              class="btn btn-sm btn-icon btn-danger-ghost"
                              onClick={() => handleRemoveQueueItem(idx)}
                              title="Remove from queue"
                              aria-label="Remove from queue"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      );
                    }
                  })}
                </div>
              )}
            </div>

            {/* Right Column: Task Selection Pool */}
            <div class="task-pool-panel">
              <div class="panel-header-row">
                <h4>Task Selection Pool</h4>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Prioritizing Q2 Deep Work
                </div>
              </div>

              {/* Quadrant Filter Tabs */}
              <div class="task-pool-tabs">
                <button
                  type="button"
                  class={`pool-tab-btn ${taskPoolFilter === 'Q2' ? 'active q2-tab' : ''}`}
                  onClick={() => setTaskPoolFilter('Q2')}
                >
                  ⭐ Q2 Focus
                </button>
                <button
                  type="button"
                  class={`pool-tab-btn ${taskPoolFilter === 'ALL' ? 'active' : ''}`}
                  onClick={() => setTaskPoolFilter('ALL')}
                >
                  All (Q2 First)
                </button>
                <button
                  type="button"
                  class={`pool-tab-btn ${taskPoolFilter === 'Q1' ? 'active' : ''}`}
                  onClick={() => setTaskPoolFilter('Q1')}
                >
                  Q1 Crisis
                </button>
                <button
                  type="button"
                  class={`pool-tab-btn ${taskPoolFilter === 'Q3' ? 'active' : ''}`}
                  onClick={() => setTaskPoolFilter('Q3')}
                >
                  Q3 Distraction
                </button>
                <button
                  type="button"
                  class={`pool-tab-btn ${taskPoolFilter === 'Q4' ? 'active' : ''}`}
                  onClick={() => setTaskPoolFilter('Q4')}
                >
                  Q4 Waste
                </button>
                <button
                  type="button"
                  class={`pool-tab-btn ${taskPoolFilter === 'INBOX' ? 'active' : ''}`}
                  onClick={() => setTaskPoolFilter('INBOX')}
                >
                  Inbox
                </button>
              </div>

              {/* Pool List */}
              <div class="task-pool-list">
                {poolTasks.length === 0 ? (
                  <div
                    style={{
                      padding: '1.25rem',
                      textAlign: 'center',
                      color: 'var(--text-muted)',
                      fontSize: '0.85rem',
                    }}
                  >
                    No active tasks in this quadrant.
                  </div>
                ) : (
                  poolTasks.map((task) => {
                    const est = task.estimatedMinutes || 25;
                    const restDur = getDefaultRestDuration(task);
                    const inQueueCount = workBlockQueue.filter(
                      (i) => i.type === 'task' && i.taskId === task.id
                    ).length;

                    return (
                      <div
                        key={task.id}
                        class={`pool-task-card ${task.quadrant === 'Q2' ? 'q2-card' : ''}`}
                      >
                        <div class="pool-task-info">
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <span class={`tag-chip tag-${task.quadrant.toLowerCase()}`}>
                              {task.quadrant}
                            </span>
                            <span style={{ fontSize: '0.88rem', fontWeight: 600 }}>
                              {task.title}
                            </span>
                          </div>
                          <div class="queue-item-meta" style={{ marginTop: '0.2rem' }}>
                            <span>~{est}m estimate</span>
                            <span>• Rest: {restDur}m</span>
                            {task.focusMinutesLogged > 0 && (
                              <span>• {task.focusMinutesLogged}m logged</span>
                            )}
                            {inQueueCount > 0 && (
                              <span style={{ color: '#6ee7b7', fontWeight: 600 }}>
                                ✓ {inQueueCount} in queue
                              </span>
                            )}
                          </div>
                        </div>

                        <div class="pool-task-actions">
                          <button
                            type="button"
                            class="btn btn-sm btn-primary"
                            onClick={() => handleAddTaskToQueue(task.id, false)}
                            title="Add task to work block queue"
                          >
                            + Queue
                          </button>
                          <button
                            type="button"
                            class="btn btn-sm"
                            onClick={() => handleAddTaskToQueue(task.id, true)}
                            title={`Queue task with ${restDur}m rest block`}
                          >
                            + Rest
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* VIEW 4: BORON & COVEY ANALYTICS */}
      {viewMode === 'ANALYTICS' && (
        <div class="analytics-grid">
          {ANALYTICS_WIDGET_REGISTRY.map((widget) => (
            <div
              key={widget.id}
              style={{ gridColumn: widget.spanFull ? '1 / -1' : undefined }}
            >
              {widget.render({ state, analytics })}
            </div>
          ))}
        </div>
      )}

      {/* VIEW 5: GIST SYNC & CS LAB */}
      {viewMode === 'SYNC_LAB' && (
        <div class="panel-grid">
          <div class="panel-card">
            <h3>GitHub Gist CRDT Sync</h3>
            <div class="form-group">
              <label>GitHub Personal Access Token</label>
              <input
                type="password"
                class="capture-input"
                placeholder="ghp_... or github_pat_..."
                value={gistConfig.token}
                onInput={(e) =>
                  setGistConfig((prev) => ({
                    ...prev,
                    token: (e.target as HTMLInputElement).value,
                  }))
                }
              />
            </div>

            <div class="form-group">
              <label>Secret Gist ID</label>
              <input
                type="text"
                class="capture-input mono"
                placeholder="Leave blank on first device, then click Create Secret Gist"
                value={gistConfig.gistId}
                onInput={(e) =>
                  setGistConfig((prev) => ({
                    ...prev,
                    gistId: (e.target as HTMLInputElement).value,
                  }))
                }
              />
            </div>

            <div class="form-group">
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  cursor: 'pointer',
                  fontSize: '0.82rem',
                }}
              >
                <input
                  type="checkbox"
                  checked={gistConfig.autoSync}
                  onChange={(e) =>
                    setGistConfig((prev) => ({
                      ...prev,
                      autoSync: (e.target as HTMLInputElement).checked,
                    }))
                  }
                />
                Automatic background sync (changes, reconnect, tab focus)
              </label>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                class="btn btn-primary"
                disabled={syncStatus === 'syncing' || !gistConfig.token.trim()}
                onClick={handleSyncGist}
              >
                Sync Now (local ⊔ remote)
              </button>
              <button
                type="button"
                class="btn btn-q2"
                disabled={syncStatus === 'syncing' || !gistConfig.token.trim()}
                onClick={handleCreateSecretGist}
              >
                Create Secret Gist
              </button>
              <button
                type="button"
                class="btn btn-sm"
                onClick={() => setGistConfig(clearGistToken())}
              >
                Disconnect Token
              </button>
            </div>

            {syncMessage && (
              <div
                class="pill"
                style={{
                  borderRadius: '8px',
                  whiteSpace: 'normal',
                  borderColor:
                    syncStatus === 'error' ? 'var(--q1-color)' : 'var(--q2-color)',
                }}
              >
                {syncMessage}
              </div>
            )}

            {/* Compact Optional Markdown Bar */}
            <div
              style={{
                marginTop: '0.35rem',
                paddingTop: '0.65rem',
                borderTop: '1px solid var(--border-subtle)',
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.4rem',
              }}
            >
              <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                Export / Backup:
              </span>
              <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  class="btn btn-sm"
                  onClick={() =>
                    navigator.clipboard?.writeText(serializeToMarkdown(state))
                  }
                >
                  Copy MD
                </button>
                <button
                  type="button"
                  class="btn btn-sm"
                  onClick={() =>
                    downloadTextFile(
                      'Q4-MATRIX.md',
                      serializeToMarkdown(state),
                      'text/markdown'
                    )
                  }
                >
                  .MD
                </button>
                <button
                  type="button"
                  class="btn btn-sm"
                  onClick={() =>
                    downloadTextFile(
                      'q4-state.json',
                      JSON.stringify(state, null, 2),
                      'application/json'
                    )
                  }
                >
                  .JSON
                </button>
                <button
                  type="button"
                  class="btn btn-sm"
                  onClick={() => setShowMarkdownBox((v) => !v)}
                >
                  {showMarkdownBox ? 'Hide MD' : 'View / Import MD'}
                </button>
              </div>
            </div>

            {showMarkdownBox && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <pre class="code-preview mono" style={{ maxHeight: '140px' }}>
                  {serializeToMarkdown(state)}
                </pre>
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    class="capture-input"
                    style={{ padding: '0.35rem 0.6rem', fontSize: '0.8rem' }}
                    placeholder="- [ ] Task title #q2"
                    value={importMarkdownText}
                    onInput={(e) =>
                      setImportMarkdownText((e.target as HTMLInputElement).value)
                    }
                  />
                  <button
                    type="button"
                    class="btn btn-sm"
                    onClick={() => {
                      const parsed = parseMarkdownTaskLines(importMarkdownText);
                      if (parsed.length > 0) {
                        setState((curr) => {
                          let next = curr;
                          for (const item of parsed) {
                            next = addTask(next, item.title, item.quadrant, {
                              completed: item.completed,
                            });
                          }
                          return next;
                        });
                        setImportMarkdownText('');
                      }
                    }}
                  >
                    Import
                  </button>
                </div>
              </div>
            )}
          </div>

          <div class="panel-card">
            <h3>How to Set Up Gist Sync & Network (STE-100 Guide)</h3>
            <div
              style={{
                fontSize: '0.8rem',
                color: 'var(--text-muted)',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.55rem',
              }}
            >
              <div>
                <strong style={{ color: 'var(--text-main)' }}>
                  1. Create a GitHub Token (Fix Error 403)
                </strong>
                <div>
                  • Open GitHub <code>Settings → Developer settings → Personal access tokens</code>.
                </div>
                <div>
                  • <strong>Classic token (easiest):</strong> Click <code>Generate new token (classic)</code>. Check the <code>gist</code> box.
                </div>
                <div>
                  • <strong>Fine-grained token:</strong> Open <code>Account permissions</code> (not Repository permissions). Set <code>Gists</code> to <code>Read and write</code>.
                </div>
              </div>

              <div>
                <strong style={{ color: 'var(--text-main)' }}>
                  2. Initialize the Gist on Your Laptop
                </strong>
                <div>
                  • Paste your token into the token field. Leave <code>Secret Gist ID</code> blank.
                </div>
                <div>
                  • Click <code>Create Secret Gist</code>. Copy the generated Gist ID.
                </div>
              </div>

              <div>
                <strong style={{ color: 'var(--text-main)' }}>
                  3. Open the App on Your Phone (Network Setup)
                </strong>
                <div>
                  • <strong>Same Wi-Fi:</strong> Run <code>npm run dev</code> on your laptop. Open the <code>Network: http://192.168.x.x:5173</code> URL printed in your terminal on your phone.
                </div>
                <div>
                  • <strong>Anywhere (Mobile Data):</strong> Run <code>npm run build</code> and upload the <code>dist/</code> folder to GitHub Pages, Cloudflare Pages, or Vercel.
                </div>
                <div>
                  • On your phone, paste the same Token and Secret Gist ID, then click <code>Sync Now</code>.
                </div>
              </div>
            </div>

            <div class="code-preview mono" style={{ padding: '0.55rem 0.7rem' }}>
              {semilatticeProof.details.map((line) => (
                <div key={line}>{line}</div>
              ))}
              <div>
                Node: {state.nodeId} | Lamport: {state.maxLamport} | Q2 Ratio:{' '}
                {analytics.q2CompletionRatio}%
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
