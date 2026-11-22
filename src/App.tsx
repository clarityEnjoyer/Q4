import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { CaptureBar } from './components/CaptureBar';
import { CompleteTaskDialog } from './components/CompleteTaskDialog';
import { MatrixView } from './components/MatrixView';
import { SyncLabView } from './components/SyncLabView';
import { TaskEditorPopover } from './components/TaskEditorPopover';
import { TriageView } from './components/TriageView';
import { WorkBlockView } from './components/WorkBlockView';
import {
  addSubtask,
  addTask,
  completeTaskWithTime,
  computeBoronAnalytics,
  deleteSubtask,
  deleteTask,
  escalateNeglectedQ2Tasks,
  formatClock24h,
  logFocusSession,
  reorderSubtask,
  reorderTask,
  resolveQuadrant,
  resolveTaskConflict,
  sortTasksInBlock,
  toggleSubtask,
  toggleTaskCompleted,
  triageTask,
  updateSubtask,
  updateTaskDetails,
} from './core/engine';
import { AppState, GistSyncConfig, TaskItem } from './core/types';
import { createNewSecretGist, syncWithGitHubGist } from './sync/gistSync';
import {
  clearGistToken,
  loadGistConfig,
  loadLocalState,
  loadVisualPrefs,
  saveGistConfig,
  saveLocalState,
  saveVisualPrefs,
} from './sync/storage';
import { ANALYTICS_WIDGET_REGISTRY } from './visuals/analyticsWidgets';
import { applyVisualTheme, THEME_REGISTRY } from './visuals/themes';

export type ViewMode =
  | 'MATRIX'
  | 'TRIAGE'
  | 'MORNING_Q2'
  | 'FOCUS'
  | 'ANALYTICS'
  | 'SYNC_LAB';

interface CompletingTargetState {
  task: TaskItem;
  suggestedMinutes?: number;
  onDone?: (actualMinutes?: number) => void;
}

interface EditingTargetState {
  taskId: string;
  anchorRect: DOMRect;
}

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

  const [visualPrefs, setVisualPrefs] = useState(() => loadVisualPrefs());

  useEffect(() => {
    applyVisualTheme(visualPrefs.themeId, visualPrefs.density);
    saveVisualPrefs(visualPrefs);
  }, [visualPrefs]);

  const captureInputRef = useRef<HTMLInputElement>(null);
  const isCalendarOpenRef = useRef(false);
  const handleCalendarOpenChange = useCallback((open: boolean) => {
    isCalendarOpenRef.current = open;
  }, []);

  const [editingTarget, setEditingTarget] = useState<EditingTargetState | null>(null);
  const editingTargetRef = useRef<EditingTargetState | null>(editingTarget);
  editingTargetRef.current = editingTarget;
  const [showCompleted, setShowCompleted] = useState(false);

  // Rapid 2-Decision Binary Triage state
  const [importantChoice, setImportantChoice] = useState<boolean | null>(null);
  const importantChoiceRef = useRef<boolean | null>(null);
  const [lastTriagedFeedback, setLastTriagedFeedback] = useState<string | null>(null);

  // Q1 -> Q2 Prevention banner state
  const [completedQ1Crisis, setCompletedQ1Crisis] = useState<TaskItem | null>(null);
  const [preventionInput, setPreventionInput] = useState('');

  // Cross-view Work Block focus request & Completion modal state
  const [focusRequestTaskId, setFocusRequestTaskId] = useState<string | null>(null);
  const [completingTarget, setCompletingTarget] =
    useState<CompletingTargetState | null>(null);
  const completingTargetRef = useRef<CompletingTargetState | null>(completingTarget);
  completingTargetRef.current = completingTarget;

  // GitHub Gist Sync state
  const [gistConfig, setGistConfig] = useState<GistSyncConfig>(() => loadGistConfig());
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle');
  const [syncMessage, setSyncMessage] = useState<string>('');

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
      sortTasksInBlock(
        Object.values(state.tasks).filter((t) => !t.deleted && !t.completed)
      ),
    [state.tasks]
  );

  const inboxTasks = useMemo(
    () => activeTasks.filter((t) => t.quadrant === 'INBOX'),
    [activeTasks]
  );

  const q2TasksCount = useMemo(
    () => activeTasks.filter((t) => t.quadrant === 'Q2').length,
    [activeTasks]
  );

  const analytics = useMemo(() => computeBoronAnalytics(state), [state]);

  const setTriageStepChoice = (val: boolean | null) => {
    importantChoiceRef.current = val;
    setImportantChoice(val);
  };

  const handleBinaryTriageAnswer = useCallback(
    (answer: boolean) => {
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
    },
    [inboxTasks]
  );

  // Safe global keyboard shortcuts (never hijacks modal dialog, popover, or text inputs)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (completingTargetRef.current || editingTargetRef.current) return;
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
        }
        return;
      }

      if (isCalendarOpenRef.current) {
        if (['1', '2', '3', '4', '5', '/'].includes(e.key)) {
          e.preventDefault();
        }
        return;
      }

      if (tagName === 'BUTTON') return;

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
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [viewMode, inboxTasks, handleBinaryTriageAnswer]);

  const handleConfirmComplete = (task: TaskItem, actualMinutes?: number) => {
    const callback = completingTarget?.onDone;
    setCompletingTarget(null);
    setState((curr) => completeTaskWithTime(curr, task.id, actualMinutes));
    if (task.quadrant === 'Q1') {
      setCompletedQ1Crisis(task);
      setPreventionInput('');
    }
    callback?.(actualMinutes);
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
      setSyncMessage(`Synced ${formatClock24h(outcome.syncedAt)}`);
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

  useEffect(() => {
    if (!gistConfig.autoSync || !gistConfig.token.trim() || !gistConfig.gistId.trim()) {
      return;
    }

    if (state.maxLamport > lastSyncedLamportRef.current) {
      const timer = window.setTimeout(() => {
        handleSyncGist();
      }, 2000);
      return () => window.clearTimeout(timer);
    }
  }, [state.maxLamport, gistConfig.autoSync, gistConfig.token, gistConfig.gistId]);

  useEffect(() => {
    if (!gistConfig.autoSync || !gistConfig.token.trim() || !gistConfig.gistId.trim()) {
      return;
    }

    const handleOnline = () => handleSyncGist();
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

  return (
    <div class="app-shell">
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

          <select
            class="pill"
            style={{ cursor: 'pointer', appearance: 'auto' }}
            value={visualPrefs.themeId}
            aria-label="Theme Selection"
            onChange={(e) =>
              setVisualPrefs((prev) => ({
                ...prev,
                themeId: (e.currentTarget as HTMLSelectElement).value,
              }))
            }
          >
            {THEME_REGISTRY.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.label}
              </option>
            ))}
          </select>

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
              ? formatClock24h(state.lastSyncedAt)
              : 'Sync'}
          </button>
        </div>
      </header>

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
          class={`nav-tab ${
            viewMode === 'MORNING_Q2' || viewMode === 'FOCUS' ? 'active-q2' : ''
          }`}
          onClick={() => setViewMode('MORNING_Q2')}
        >
          <span>Work Block</span>
          <span class="badge-count badge-q2">{q2TasksCount}</span>
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

      <CaptureBar
        captureInputRef={captureInputRef}
        onAddTask={(title, quadrant, options) =>
          setState((curr) => addTask(curr, title, quadrant, options))
        }
        onCalendarOpenChange={handleCalendarOpenChange}
      />

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
                setPreventionInput((e.currentTarget as HTMLInputElement).value)
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

      <main>
        {viewMode === 'MATRIX' && (
          <MatrixView
            tasks={state.tasks}
            inboxCount={inboxTasks.length}
            showCompleted={showCompleted}
            onToggleShowCompleted={setShowCompleted}
            onReorderTask={(taskId, targetQuadrant, targetIndex) =>
              setState((curr) =>
                reorderTask(curr, taskId, targetQuadrant, targetIndex)
              )
            }
            onRequestComplete={(task) => setCompletingTarget({ task })}
            onUncomplete={(taskId) =>
              setState((curr) => toggleTaskCompleted(curr, taskId))
            }
            onDeleteTask={(taskId) =>
              setState((curr) => deleteTask(curr, taskId))
            }
            onResolveConflict={(taskId, strategy) =>
              setState((curr) => resolveTaskConflict(curr, taskId, strategy))
            }
            onGoTriage={() => setViewMode('TRIAGE')}
            onFocusTask={(taskId) => {
              setFocusRequestTaskId(taskId);
              setViewMode('MORNING_Q2');
            }}
            editingTaskId={editingTarget?.taskId ?? null}
            onOpenTaskEditor={(taskId, anchorRect) =>
              setEditingTarget({ taskId, anchorRect })
            }
          />
        )}

        {viewMode === 'TRIAGE' && (
          <TriageView
            inboxTasks={inboxTasks}
            importantChoice={importantChoice}
            lastTriagedFeedback={lastTriagedFeedback}
            onAnswer={handleBinaryTriageAnswer}
            onResetStep={() => setTriageStepChoice(null)}
            onGoMatrix={() => setViewMode('MATRIX')}
            onGoWorkBlock={() => setViewMode('MORNING_Q2')}
          />
        )}

        {(viewMode === 'MORNING_Q2' || viewMode === 'FOCUS') && (
          <WorkBlockView
            state={state}
            focusRequestTaskId={focusRequestTaskId}
            onClearFocusRequest={() => setFocusRequestTaskId(null)}
            onLogFocusSession={(quadrant, durationMinutes, taskId) =>
              setState((curr) =>
                logFocusSession(curr, quadrant, durationMinutes, taskId)
              )
            }
            onRequestCompleteFromWorkBlock={(task, suggestedMinutes, onCompleted) =>
              setCompletingTarget({ task, suggestedMinutes, onDone: onCompleted })
            }
            onAddSubtask={(taskId, text, estimatedMinutes) =>
              setState((curr) => addSubtask(curr, taskId, text, estimatedMinutes))
            }
            onUpdateSubtask={(taskId, subtaskId, patch) =>
              setState((curr) => updateSubtask(curr, taskId, subtaskId, patch))
            }
            onToggleSubtask={(taskId, subtaskId) =>
              setState((curr) => toggleSubtask(curr, taskId, subtaskId))
            }
            onReorderSubtask={(taskId, fromIndex, toIndex) =>
              setState((curr) => reorderSubtask(curr, taskId, fromIndex, toIndex))
            }
            onGoMatrix={() => setViewMode('MATRIX')}
          />
        )}

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

        {viewMode === 'SYNC_LAB' && (
          <SyncLabView
            state={state}
            analytics={analytics}
            gistConfig={gistConfig}
            syncStatus={syncStatus}
            syncMessage={syncMessage}
            onUpdateGistConfig={setGistConfig}
            onSyncGist={handleSyncGist}
            onCreateSecretGist={handleCreateSecretGist}
            onDisconnectToken={() => setGistConfig(clearGistToken())}
            onImportTasks={(items) =>
              setState((curr) => {
                let next = curr;
                for (const item of items) {
                  next = addTask(next, item.title, item.quadrant, {
                    completed: item.completed,
                  });
                }
                return next;
              })
            }
          />
        )}
      </main>

      <TaskEditorPopover
        task={
          editingTarget &&
          state.tasks[editingTarget.taskId] &&
          !state.tasks[editingTarget.taskId].deleted
            ? state.tasks[editingTarget.taskId]
            : null
        }
        anchorRect={editingTarget?.anchorRect ?? null}
        onClose={() => setEditingTarget(null)}
        onUpdateDetails={(taskId, patch) =>
          setState((curr) => updateTaskDetails(curr, taskId, patch))
        }
        onMoveQuadrant={(taskId, targetQuadrant) =>
          setState((curr) => reorderTask(curr, taskId, targetQuadrant, undefined))
        }
        onDeleteTask={(taskId) => {
          setEditingTarget(null);
          setState((curr) => deleteTask(curr, taskId));
        }}
        onFocusTask={(taskId) => {
          setEditingTarget(null);
          setFocusRequestTaskId(taskId);
          setViewMode('MORNING_Q2');
        }}
        onAddSubtask={(taskId, text, estimatedMinutes) =>
          setState((curr) => addSubtask(curr, taskId, text, estimatedMinutes))
        }
        onUpdateSubtask={(taskId, subtaskId, patch) =>
          setState((curr) => updateSubtask(curr, taskId, subtaskId, patch))
        }
        onToggleSubtask={(taskId, subtaskId) =>
          setState((curr) => toggleSubtask(curr, taskId, subtaskId))
        }
        onDeleteSubtask={(taskId, subtaskId) =>
          setState((curr) => deleteSubtask(curr, taskId, subtaskId))
        }
        onReorderSubtask={(taskId, fromIndex, toIndex) =>
          setState((curr) => reorderSubtask(curr, taskId, fromIndex, toIndex))
        }
      />

      <CompleteTaskDialog
        task={completingTarget?.task ?? null}
        suggestedMinutes={completingTarget?.suggestedMinutes}
        onConfirm={handleConfirmComplete}
        onCancel={() => setCompletingTarget(null)}
      />
    </div>
  );
}
