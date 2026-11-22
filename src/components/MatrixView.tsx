import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  formatMinutesAsDecimalHours,
  getHoursUntilDue,
  QUADRANT_META,
  sortTasksInBlock,
} from '../core/engine';
import { Quadrant, TaskItem } from '../core/types';

export interface MatrixViewProps {
  tasks: Record<string, TaskItem>;
  inboxCount: number;
  showCompleted: boolean;
  onToggleShowCompleted: (show: boolean) => void;
  onReorderTask: (taskId: string, targetQuadrant: Quadrant, targetIndex?: number) => void;
  onRequestComplete: (task: TaskItem) => void;
  onUncomplete: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onResolveConflict: (taskId: string, strategy: 'KEEP_PRIMARY' | 'FORK_OVERLAP') => void;
  onGoTriage: () => void;
  onFocusTask: (taskId: string) => void;
  editingTaskId: string | null;
  onOpenTaskEditor: (taskId: string, anchorRect: DOMRect) => void;
  isMobile?: boolean;
}

const MATRIX_QUADRANTS = ['Q1', 'Q2', 'Q3', 'Q4'] as const;
const MOBILE_QUADRANTS = ['Q2', 'Q1', 'Q3', 'Q4'] as const;

type DropIndicatorState = {
  quadrant: Quadrant;
  taskId: string;
  edge: 'before' | 'after';
} | null;

/**
 * 4-Quadrant Eisenhower Matrix view with permanent Inbox strip,
 * intra-block/cross-block drag-and-drop, and accessible keyboard reordering.
 */
export function MatrixView({
  tasks,
  inboxCount,
  showCompleted,
  onToggleShowCompleted,
  onReorderTask,
  onRequestComplete,
  onUncomplete,
  onDeleteTask,
  onResolveConflict,
  onGoTriage,
  onFocusTask,
  editingTaskId,
  onOpenTaskEditor,
  isMobile,
}: MatrixViewProps) {
  const [mobileFilter, setMobileFilter] = useState<'ALL' | Quadrant>('ALL');
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const draggingTaskIdRef = useRef<string | null>(null);
  const [activeDropTarget, setActiveDropTarget] = useState<Quadrant | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicatorState>(null);
  const dragCounters = useRef<Record<string, number>>({});

  const [grabbedTaskId, setGrabbedTaskId] = useState<string | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState('');
  const preGrabPosRef = useRef<{ taskId: string; quadrant: Quadrant; index: number } | null>(null);
  const ignoreBlurRef = useRef(false);
  const pendingFocusTaskIdRef = useRef<string | null>(null);
  const handleRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const restoreHandleFocus = (taskId: string) => {
    const btn = handleRefs.current[taskId];
    if (btn) {
      if (typeof btn.scrollIntoView === 'function') {
        btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      btn.focus({ preventScroll: true });
    }
    ignoreBlurRef.current = false;
  };

  useEffect(() => {
    const taskId = pendingFocusTaskIdRef.current;
    if (!taskId) return;
    pendingFocusTaskIdRef.current = null;
    restoreHandleFocus(taskId);
  }, [tasks]);

  const scheduleFocusRestore = (taskId: string) => {
    pendingFocusTaskIdRef.current = taskId;
    window.setTimeout(() => {
      if (pendingFocusTaskIdRef.current === taskId) {
        pendingFocusTaskIdRef.current = null;
        restoreHandleFocus(taskId);
      }
    }, 0);
  };

  const resetDragState = () => {
    dragCounters.current = {};
    draggingTaskIdRef.current = null;
    setDraggingTaskId(null);
    setActiveDropTarget(null);
    setDropIndicator(null);
  };

  const getSortedGroup = (quadrant: Quadrant, completed: boolean): TaskItem[] =>
    sortTasksInBlock(
      Object.values(tasks).filter(
        (t) => !t.deleted && t.quadrant === quadrant && t.completed === completed
      )
    );

  const displayedInboxTasks = useMemo(
    () =>
      sortTasksInBlock(
        Object.values(tasks).filter(
          (t) => !t.deleted && t.quadrant === 'INBOX' && (showCompleted ? true : !t.completed)
        )
      ),
    [tasks, showCompleted]
  );

  const quadrantTasks = useMemo(() => {
    const map: Record<(typeof MATRIX_QUADRANTS)[number], TaskItem[]> = {
      Q1: [],
      Q2: [],
      Q3: [],
      Q4: [],
    };
    for (const qId of MATRIX_QUADRANTS) {
      map[qId] = sortTasksInBlock(
        Object.values(tasks).filter(
          (t) => !t.deleted && t.quadrant === qId && (showCompleted ? true : !t.completed)
        )
      );
    }
    return map;
  }, [tasks, showCompleted]);

  const computeDropEdge = (e: DragEvent): 'before' | 'after' => {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const inboxList = el.closest('.inbox-task-list') as HTMLElement | null;
    if (inboxList) {
      const parentRect = inboxList.getBoundingClientRect();
      if (parentRect.width > 0 && rect.width < parentRect.width * 0.65) {
        return e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
      }
    }
    return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  };

  const handleDragStart = (e: DragEvent, taskId: string) => {
    const rawTarget = e.target as HTMLElement | null;
    const target =
      rawTarget && typeof rawTarget.closest === 'function'
        ? rawTarget
        : rawTarget?.parentElement ?? null;
    if (
      target?.closest(
        'input, textarea, button:not(.drag-handle), select, [contenteditable="true"]'
      )
    ) {
      e.preventDefault();
      return;
    }
    if (e.dataTransfer) {
      e.dataTransfer.setData('text/plain', taskId);
      e.dataTransfer.effectAllowed = 'move';
    }
    draggingTaskIdRef.current = taskId;
    setDraggingTaskId(taskId);
  };

  const handleDragEnd = () => {
    resetDragState();
  };

  const handleContainerDragOver = (targetQuadrant: Quadrant, e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
    setDropIndicator((curr) => (curr && curr.quadrant === targetQuadrant ? null : curr));
  };

  const handleContainerDragEnter = (targetQuadrant: Quadrant, e: DragEvent) => {
    e.preventDefault();
    dragCounters.current[targetQuadrant] = (dragCounters.current[targetQuadrant] || 0) + 1;
    setActiveDropTarget(targetQuadrant);
  };

  const handleContainerDragLeave = (targetQuadrant: Quadrant, e: DragEvent) => {
    e.preventDefault();
    dragCounters.current[targetQuadrant] = Math.max(
      0,
      (dragCounters.current[targetQuadrant] || 1) - 1
    );
    if (dragCounters.current[targetQuadrant] === 0) {
      setActiveDropTarget((curr) => (curr === targetQuadrant ? null : curr));
      setDropIndicator((curr) => (curr?.quadrant === targetQuadrant ? null : curr));
    }
  };

  const handleContainerDrop = (targetQuadrant: Quadrant, e: DragEvent) => {
    e.preventDefault();
    const draggedId =
      e.dataTransfer?.getData('text/plain') || draggingTaskIdRef.current || draggingTaskId;
    resetDragState();
    if (!draggedId) return;

    const task = tasks[draggedId];
    if (!task || task.deleted) return;

    onReorderTask(draggedId, targetQuadrant, undefined);
  };

  const handleItemDragOver = (hoveredTask: TaskItem, e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }

    const draggedId =
      draggingTaskIdRef.current ||
      draggingTaskId ||
      e.dataTransfer?.getData('text/plain') ||
      null;

    if (!draggedId || draggedId === hoveredTask.id) {
      setDropIndicator(null);
      return;
    }

    const draggedTask = tasks[draggedId];
    if (!draggedTask || draggedTask.deleted || draggedTask.completed !== hoveredTask.completed) {
      setDropIndicator(null);
      return;
    }

    const edge = computeDropEdge(e);
    const group = getSortedGroup(hoveredTask.quadrant, draggedTask.completed);
    const siblings = group.filter((t) => t.id !== draggedId);
    const sibIdx = siblings.findIndex((t) => t.id === hoveredTask.id);
    if (sibIdx === -1) {
      setDropIndicator(null);
      return;
    }

    const targetIdx = edge === 'before' ? sibIdx : sibIdx + 1;
    if (draggedTask.quadrant === hoveredTask.quadrant) {
      const currentIdx = group.findIndex((t) => t.id === draggedId);
      if (currentIdx === targetIdx) {
        setDropIndicator(null);
        return;
      }
    }

    setDropIndicator({
      quadrant: hoveredTask.quadrant,
      taskId: hoveredTask.id,
      edge,
    });
  };

  const handleItemDrop = (hoveredTask: TaskItem, e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const draggedId =
      e.dataTransfer?.getData('text/plain') || draggingTaskIdRef.current || draggingTaskId;

    if (!draggedId || draggedId === hoveredTask.id) {
      resetDragState();
      return;
    }

    const draggedTask = tasks[draggedId];
    if (!draggedTask || draggedTask.deleted) {
      resetDragState();
      return;
    }

    const edge = computeDropEdge(e);
    const group = getSortedGroup(hoveredTask.quadrant, draggedTask.completed);
    const siblings = group.filter((t) => t.id !== draggedId);
    const sibIdx = siblings.findIndex((t) => t.id === hoveredTask.id);
    const targetIdx = sibIdx === -1 ? undefined : edge === 'before' ? sibIdx : sibIdx + 1;

    onReorderTask(draggedId, hoveredTask.quadrant, targetIdx);
    resetDragState();
  };

  const handleDragHandleKeyDown = (task: TaskItem, e: KeyboardEvent) => {
    const group = getSortedGroup(task.quadrant, false);
    const currentIndex = group.findIndex((t) => t.id === task.id);
    if (currentIndex === -1) return;
    const total = group.length;

    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const delta = e.key === 'ArrowUp' ? -1 : 1;
      const nextIndex = Math.max(0, Math.min(total - 1, currentIndex + delta));
      if (nextIndex !== currentIndex) {
        ignoreBlurRef.current = true;
        onReorderTask(task.id, task.quadrant, nextIndex);
        scheduleFocusRestore(task.id);
      }
      setLiveAnnouncement(`Position ${nextIndex + 1} of ${total}`);
      return;
    }

    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (grabbedTaskId === task.id) {
        setGrabbedTaskId(null);
        preGrabPosRef.current = null;
        setLiveAnnouncement(`Dropped "${task.title}" at position ${currentIndex + 1} of ${total}.`);
      } else {
        setGrabbedTaskId(task.id);
        preGrabPosRef.current = { taskId: task.id, quadrant: task.quadrant, index: currentIndex };
        setLiveAnnouncement(
          `Grabbed "${task.title}", position ${currentIndex + 1} of ${total}. Arrows to move, Space to drop, Escape to cancel.`
        );
      }
      return;
    }

    if (grabbedTaskId !== task.id) return;

    if (
      e.key === 'ArrowUp' ||
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowDown' ||
      e.key === 'ArrowRight'
    ) {
      e.preventDefault();
      const delta = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 1;
      const nextIndex = Math.max(0, Math.min(total - 1, currentIndex + delta));
      if (nextIndex !== currentIndex) {
        ignoreBlurRef.current = true;
        onReorderTask(task.id, task.quadrant, nextIndex);
        scheduleFocusRestore(task.id);
      }
      setLiveAnnouncement(`Position ${nextIndex + 1} of ${total}`);
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const saved = preGrabPosRef.current;
      setGrabbedTaskId(null);
      preGrabPosRef.current = null;
      if (saved && saved.taskId === task.id && (saved.index !== currentIndex || saved.quadrant !== task.quadrant)) {
        ignoreBlurRef.current = true;
        onReorderTask(task.id, saved.quadrant, saved.index);
        scheduleFocusRestore(task.id);
      }
      setLiveAnnouncement('Reorder cancelled');
    }
  };

  const renderTaskCard = (task: TaskItem) => {
    const hoursLeft = getHoursUntilDue(task.dueDate);
    const isDriftingToQ1 =
      task.quadrant === 'Q2' &&
      hoursLeft !== null &&
      hoursLeft <= 72 &&
      !task.completed;

    const totalChecklist = task.checklist?.length || 0;
    const doneChecklist = task.checklist?.filter((s) => s.done).length || 0;
    const checklistPct =
      totalChecklist > 0 ? Math.round((doneChecklist / totalChecklist) * 100) : 0;

    const indicatorClass =
      dropIndicator &&
      dropIndicator.quadrant === task.quadrant &&
      dropIndicator.taskId === task.id
        ? dropIndicator.edge === 'before'
          ? 'drop-before'
          : 'drop-after'
        : '';

    const isGrabbed = grabbedTaskId === task.id;
    const maxTags = isMobile ? 2 : 4;

    return (
      <div
        key={task.id}
        class={`task-item ${task.completed ? 'completed' : ''} ${
          draggingTaskId === task.id ? 'is-dragging' : ''
        } ${isGrabbed ? 'is-grabbed' : ''} ${
          editingTaskId === task.id ? 'is-editing' : ''
        } ${indicatorClass}`.trim()}
        draggable={!isMobile}
        onDragStart={!isMobile ? (e) => handleDragStart(e, task.id) : undefined}
        onDragOver={!isMobile ? (e) => handleItemDragOver(task, e) : undefined}
        onDrop={!isMobile ? (e) => handleItemDrop(task, e) : undefined}
        onDragEnd={!isMobile ? handleDragEnd : undefined}
        onClick={
          isMobile
            ? (e) => {
                const target = e.target as HTMLElement | null;
                if (target?.closest('.task-checkbox-hit, button, select, input, a')) {
                  return;
                }
                onOpenTaskEditor(task.id, e.currentTarget.getBoundingClientRect());
              }
            : undefined
        }
        data-task-id={task.id}
      >
        <div class="task-left">
          {!task.completed && !isMobile && (
            <button
              type="button"
              ref={(el) => {
                handleRefs.current[task.id] = el;
              }}
              class="drag-handle"
              aria-label={`Reorder "${task.title}"`}
              aria-pressed={isGrabbed}
              onKeyDown={(e) => handleDragHandleKeyDown(task, e)}
              onBlur={() => {
                if (ignoreBlurRef.current) return;
                if (grabbedTaskId === task.id) {
                  setGrabbedTaskId(null);
                  preGrabPosRef.current = null;
                }
              }}
            >
              ⋮⋮
            </button>
          )}
          <label class="task-checkbox-hit" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              class="task-checkbox"
              checked={task.completed}
              onChange={() => {
                if (!task.completed) {
                  onRequestComplete(task);
                } else {
                  onUncomplete(task.id);
                }
              }}
              aria-label={`Complete "${task.title}"`}
            />
          </label>
          <div
            class="task-body"
            onClick={
              !isMobile
                ? (e) => {
                    const itemEl = e.currentTarget.closest('.task-item');
                    const rect = (itemEl ?? e.currentTarget).getBoundingClientRect();
                    onOpenTaskEditor(task.id, rect);
                  }
                : undefined
            }
            style={!isMobile ? { cursor: 'pointer' } : undefined}
          >
            <div class="task-title" title={isMobile ? undefined : 'Click to edit'}>
              {task.title}
            </div>

            <div class="task-meta">
              {(task.escalatedFromQ2 || isDriftingToQ1) && (
                <span class="tag-chip tag-alert">
                  ! {task.escalatedFromQ2 ? 'Escalated' : `${Math.max(0, Math.round(hoursLeft!))}h`}
                </span>
              )}
              {totalChecklist > 0 && (
                <>
                  <span class="tag-chip">
                    ✓ {doneChecklist}/{totalChecklist}
                  </span>
                  <span class="subtask-progress-mini" title={`${checklistPct}% completed`}>
                    <span class="subtask-progress-bar" style={{ width: `${checklistPct}%` }} />
                  </span>
                </>
              )}
              {task.focusMinutesLogged > 0 && (
                <span class="tag-chip tag-q2-focus">{task.focusMinutesLogged}m logged</span>
              )}
              {task.completed && task.actualMinutes ? (
                <span class="tag-chip tag-q2-focus">
                  ✓ {formatMinutesAsDecimalHours(task.actualMinutes)}h ({task.actualMinutes}m)
                </span>
              ) : null}
              {task.dueDate && <span class="tag-chip">{task.dueDate}</span>}
              {task.estimatedMinutes && (
                <span class="tag-chip">~{task.estimatedMinutes}m</span>
              )}
              {task.tags && task.tags.length > 0 && (
                <>
                  {task.tags.slice(0, maxTags).map((tag) => (
                    <span key={tag} class="tag-chip tag-custom">
                      {tag.startsWith('#') ? tag : `#${tag}`}
                    </span>
                  ))}
                  {task.tags.length > maxTags && (
                    <span class="tag-chip tag-custom">+{task.tags.length - maxTags}</span>
                  )}
                </>
              )}
            </div>

            {isGrabbed && (
              <span class="reorder-hint" aria-hidden="true">
                Arrows to move · Space to drop · Esc to cancel
              </span>
            )}

            {task.concurrentConflicts && task.concurrentConflicts.length > 0 && (
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
                  <strong>[{task.concurrentConflicts[0].quadrant}]</strong> “
                  {task.concurrentConflicts[0].title}”
                </span>
                <span style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    class="btn btn-sm btn-primary"
                    onClick={() => onResolveConflict(task.id, 'FORK_OVERLAP')}
                  >
                    Keep Both
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm"
                    onClick={() => onResolveConflict(task.id, 'KEEP_PRIMARY')}
                  >
                    Dismiss
                  </button>
                </span>
              </div>
            )}
          </div>
        </div>

        {isMobile ? (
          <span class="task-mobile-chevron" aria-hidden="true">
            ›
          </span>
        ) : (
          <div class="task-actions">
            {task.quadrant === 'Q2' && !task.completed && (
              <button
                type="button"
                class="icon-btn"
                title="Focus on this Q2 task"
                onClick={() => onFocusTask(task.id)}
              >
                ▶
              </button>
            )}
            <select
              class="icon-btn"
              value={task.quadrant}
              aria-label="Move Quadrant"
              onChange={(e) =>
                onReorderTask(
                  task.id,
                  (e.currentTarget as HTMLSelectElement).value as Quadrant,
                  undefined
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
              onClick={() => onDeleteTask(task.id)}
            >
              ✕
            </button>
          </div>
        )}
      </div>
    );
  };

  const totalActiveQuadrantTasks = MATRIX_QUADRANTS.reduce(
    (sum, q) => sum + quadrantTasks[q].filter((t) => !t.completed).length,
    0
  );

  if (isMobile) {
    return (
      <>
        <div class="visually-hidden" aria-live="polite" aria-atomic="true">
          {liveAnnouncement}
        </div>

        <div class="mobile-quadrant-pills" role="group" aria-label="Filter quadrant">
          <button
            type="button"
            class={`mobile-quadrant-pill ${mobileFilter === 'ALL' ? 'active' : ''}`}
            aria-pressed={mobileFilter === 'ALL'}
            onClick={() => setMobileFilter('ALL')}
          >
            All ({totalActiveQuadrantTasks})
          </button>
          {MOBILE_QUADRANTS.map((qId) => {
            const activeCount = quadrantTasks[qId].filter((t) => !t.completed).length;
            return (
              <button
                key={qId}
                type="button"
                class={`mobile-quadrant-pill pill-${qId} ${
                  mobileFilter === qId ? 'active' : ''
                }`}
                aria-pressed={mobileFilter === qId}
                onClick={() => setMobileFilter(qId)}
              >
                {qId} ({activeCount})
              </button>
            );
          })}
          {(displayedInboxTasks.length > 0 || mobileFilter === 'INBOX') && (
            <button
              type="button"
              class={`mobile-quadrant-pill pill-INBOX ${
                mobileFilter === 'INBOX' ? 'active' : ''
              }`}
              aria-pressed={mobileFilter === 'INBOX'}
              onClick={() => setMobileFilter('INBOX')}
            >
              Inbox ({displayedInboxTasks.length})
            </button>
          )}
        </div>

        {(mobileFilter === 'INBOX' ||
          (mobileFilter === 'ALL' && displayedInboxTasks.length > 0)) && (
          <div class="inbox-strip" aria-label="Inbox tasks">
            <div class="inbox-strip-header">
              <div class="inbox-strip-title">
                <span>📦</span>
                <strong>Inbox</strong>
                <span class="pill">{inboxCount}</span>
              </div>
              {inboxCount > 0 && (
                <button type="button" class="btn btn-primary btn-sm" onClick={onGoTriage}>
                  Triage Now →
                </button>
              )}
            </div>

            {displayedInboxTasks.length === 0 ? (
              <div class="inbox-empty-hint">Inbox clear</div>
            ) : (
              <div class="task-list">
                {displayedInboxTasks.map((task) => renderTaskCard(task))}
              </div>
            )}
          </div>
        )}

        {mobileFilter === 'ALL' && (
          <div class="matrix-grid">
            {MOBILE_QUADRANTS.map((qId) => {
              const meta = QUADRANT_META[qId];
              const qTasks = quadrantTasks[qId];
              const activeCount = qTasks.filter((t) => !t.completed).length;
              const isEmpty = qTasks.length === 0;

              return (
                <section
                  key={qId}
                  class={`quadrant-card quadrant-${qId} ${
                    isEmpty ? 'is-empty-mobile' : ''
                  }`}
                  aria-label={meta.title}
                >
                  <div class="quadrant-header">
                    <div>
                      <div class="quadrant-title" style={{ color: meta.accentColor }}>
                        <span>{meta.title}</span>
                      </div>
                      {!isEmpty && <div class="quadrant-subtitle">{meta.subtitle}</div>}
                    </div>
                    <span class="pill">{activeCount}</span>
                  </div>

                  {!isEmpty && (
                    <div class="task-list">
                      {qTasks.map((task) => renderTaskCard(task))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}

        {mobileFilter !== 'ALL' && mobileFilter !== 'INBOX' && (
          <section
            class={`quadrant-card quadrant-${mobileFilter}`}
            aria-label={QUADRANT_META[mobileFilter].title}
          >
            <div class="quadrant-header">
              <div>
                <div
                  class="quadrant-title"
                  style={{ color: QUADRANT_META[mobileFilter].accentColor }}
                >
                  <span>{QUADRANT_META[mobileFilter].title}</span>
                </div>
                <div class="quadrant-subtitle">
                  {QUADRANT_META[mobileFilter].subtitle}
                </div>
              </div>
              <span class="pill">
                {quadrantTasks[mobileFilter].filter((t) => !t.completed).length}
              </span>
            </div>

            <div class="task-list">
              {quadrantTasks[mobileFilter].length === 0 ? (
                <div
                  style={{
                    padding: '1rem',
                    textAlign: 'center',
                    color: 'var(--text-dim)',
                    fontSize: '0.84rem',
                  }}
                >
                  Empty
                </div>
              ) : (
                quadrantTasks[mobileFilter].map((task) => renderTaskCard(task))
              )}
            </div>
          </section>
        )}

        <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
          <label class="completed-toggle-label">
            <input
              type="checkbox"
              checked={showCompleted}
              onChange={(e) =>
                onToggleShowCompleted((e.currentTarget as HTMLInputElement).checked)
              }
            />
            Show completed tasks
          </label>
        </div>
      </>
    );
  }

  return (
    <>
      <div class="visually-hidden" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </div>

      {/* Permanent Cardboard Inbox Drop Zone */}
      <div
        class={`inbox-strip ${
          activeDropTarget === 'INBOX' ? 'drop-active drag-over drop-target-active' : ''
        }`}
        onDragOver={(e) => handleContainerDragOver('INBOX', e)}
        onDragEnter={(e) => handleContainerDragEnter('INBOX', e)}
        onDragLeave={(e) => handleContainerDragLeave('INBOX', e)}
        onDrop={(e) => handleContainerDrop('INBOX', e)}
        aria-label="Inbox drop target"
      >
        <div class="inbox-strip-header">
          <div class="inbox-strip-title">
            <span>📦</span>
            <strong>Inbox</strong>
            <span class="pill">{inboxCount}</span>
          </div>
          {inboxCount > 0 && (
            <button type="button" class="btn btn-primary btn-sm" onClick={onGoTriage}>
              Triage Now →
            </button>
          )}
        </div>

        {displayedInboxTasks.length === 0 ? (
          <div class="inbox-empty-hint">Drop sticky notes here to park in Inbox</div>
        ) : (
          <div class="inbox-task-list">
            {displayedInboxTasks.map((task) => renderTaskCard(task))}
          </div>
        )}
      </div>

      <div class="matrix-grid">
        {MATRIX_QUADRANTS.map((qId) => {
          const meta = QUADRANT_META[qId];
          const qTasks = quadrantTasks[qId];

          return (
            <section
              key={qId}
              class={`quadrant-card quadrant-${qId} ${
                activeDropTarget === qId ? 'drop-active drag-over drop-target-active' : ''
              }`}
              onDragOver={(e) => handleContainerDragOver(qId, e)}
              onDragEnter={(e) => handleContainerDragEnter(qId, e)}
              onDragLeave={(e) => handleContainerDragLeave(qId, e)}
              onDrop={(e) => handleContainerDrop(qId, e)}
              aria-label={`${meta.title} drop target`}
            >
              <div class="quadrant-header">
                <div>
                  <div class="quadrant-title" style={{ color: meta.accentColor }}>
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
        <label class="completed-toggle-label">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) =>
              onToggleShowCompleted((e.currentTarget as HTMLInputElement).checked)
            }
          />
          Show completed tasks
        </label>
      </div>
    </>
  );
}
