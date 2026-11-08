import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { verifySemilatticeLaws } from './core/crdt';
import {
  addSubtask,
  addTask,
  computeBoronAnalytics,
  deleteSubtask,
  deleteTask,
  escalateNeglectedQ2Tasks,
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

type ViewMode = 'MATRIX' | 'TRIAGE' | 'MORNING_Q2' | 'ANALYTICS' | 'SYNC_LAB';

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

  // Quick capture bar state
  const [captureText, setCaptureText] = useState('');
  const [captureQuadrant, setCaptureQuadrant] = useState<Quadrant>('INBOX');
  const [captureDueDate, setCaptureDueDate] = useState<string>('');
  const captureInputRef = useRef<HTMLInputElement>(null);

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

  // Handle timer completion cleanly in its own effect
  useEffect(() => {
    if (timerRunning && timerSecondsLeft === 0) {
      timerEndTimeRef.current = null;
      setTimerRunning(false);
      setState((curr) =>
        logFocusSession(curr, 'Q2', timerDurationMin, selectedFocusTaskId)
      );
      setTimerSecondsLeft(timerDurationMin * 60);
    }
  }, [timerRunning, timerSecondsLeft, timerDurationMin, selectedFocusTaskId]);

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
        }
        return;
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
    setState((curr) =>
      addTask(curr, captureText, captureQuadrant, {
        dueDate: captureDueDate || undefined,
      })
    );
    setCaptureText('');
    setCaptureDueDate('');
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

  const formatTimer = (sec: number) => {
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${m}:${s}`;
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
          class={`nav-tab ${viewMode === 'MORNING_Q2' ? 'active-q2' : ''}`}
          onClick={() => setViewMode('MORNING_Q2')}
        >
          <span>Q2 Focus</span>
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

      {/* Clean Quick Capture Bar */}
      <form class="capture-bar" onSubmit={handleQuickAdd}>
        <div class="capture-row">
          <input
            ref={captureInputRef}
            type="text"
            class="capture-input"
            placeholder="Add task... (~30m optional — press / to focus)"
            value={captureText}
            onInput={(e) => setCaptureText((e.target as HTMLInputElement).value)}
          />
          <input
            type="date"
            class="capture-date"
            aria-label="Due Date"
            value={captureDueDate}
            onInput={(e) =>
              setCaptureDueDate((e.target as HTMLInputElement).value)
            }
          />
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
          {inboxTasks.length > 0 && (
            <div class="inbox-strip">
              <strong>{inboxTasks.length} unsorted task(s) in Inbox</strong>
              <button
                type="button"
                class="btn btn-primary btn-sm"
                onClick={() => setViewMode('TRIAGE')}
              >
                Triage Now →
              </button>
            </div>
          )}

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
                <section key={qId} class={`quadrant-card quadrant-${qId}`}>
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
                      qTasks.map((task) => {
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
                            class={`task-item ${task.completed ? 'completed' : ''}`}
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
                              {qId === 'Q2' && !task.completed && (
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
                      })
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

      {/* VIEW 3: MORNING Q2 FOCUS */}
      {viewMode === 'MORNING_Q2' && (
        <div class="focus-arena">
          <div class="timer-box">
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Q2 FOCUS TARGET
              </div>
              <div style={{ fontSize: '1rem', fontWeight: 700, marginTop: '0.15rem' }}>
                {q2Tasks.find((t) => t.id === selectedFocusTaskId)?.title ||
                  'Select a Q2 task below'}
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: '0.35rem',
                  marginTop: '0.5rem',
                  flexWrap: 'wrap',
                }}
              >
                {[15, 25, 45, 60].map((mins) => (
                  <button
                    key={mins}
                    type="button"
                    class={`btn btn-sm ${timerDurationMin === mins ? 'btn-q2' : ''}`}
                    onClick={() => {
                      timerEndTimeRef.current = null;
                      setTimerRunning(false);
                      setTimerDurationMin(mins);
                      setTimerSecondsLeft(mins * 60);
                    }}
                  >
                    {mins}m
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', flexWrap: 'wrap' }}>
              <div class="timer-digits mono">{formatTimer(timerSecondsLeft)}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <button
                  type="button"
                  class="btn btn-q2"
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
                  {timerRunning ? 'Pause' : 'Start Focus'}
                </button>
                <button
                  type="button"
                  class="btn btn-sm"
                  onClick={() => {
                    timerEndTimeRef.current = null;
                    setTimerRunning(false);
                    setState((curr) =>
                      logFocusSession(
                        curr,
                        'Q2',
                        timerDurationMin,
                        selectedFocusTaskId
                      )
                    );
                    setTimerSecondsLeft(timerDurationMin * 60);
                  }}
                >
                  Log {timerDurationMin}m
                </button>
              </div>
            </div>
          </div>

          <div class="task-list">
            {q2Tasks.length === 0 ? (
              <div
                style={{
                  padding: '1.25rem',
                  textAlign: 'center',
                  color: 'var(--text-muted)',
                  fontSize: '0.85rem',
                }}
              >
                No active Q2 tasks. Add one above with <code>#q2</code>.
              </div>
            ) : (
              q2Tasks.map((task) => {
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
                    class="task-item"
                    style={{
                      borderColor:
                        task.id === selectedFocusTaskId
                          ? 'var(--q2-color)'
                          : undefined,
                    }}
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
                    <button
                      type="button"
                      class={`btn btn-sm ${
                        task.id === selectedFocusTaskId ? 'btn-q2' : ''
                      }`}
                      onClick={() => setSelectedFocusTaskId(task.id)}
                    >
                      {task.id === selectedFocusTaskId ? 'Active' : 'Select'}
                    </button>
                  </div>
                );
              })
            )}
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
