import { useEffect, useRef, useState } from 'preact/hooks';
import {
  calculateOffsetDate,
  formatMinutesAsDecimalHours,
  getSubtasksEstimatedMinutes,
  parseDecimalHours,
} from '../core/engine';
import { Quadrant, SubtaskItem, TaskItem } from '../core/types';
import { closeTopLayer } from './dialogMotion';

export interface TaskEditorPopoverProps {
  task: TaskItem | null;
  anchorRect: DOMRect | null;
  isMobile?: boolean;
  onClose: () => void;
  onUpdateDetails: (
    taskId: string,
    patch: Partial<Pick<TaskItem, 'title' | 'dueDate' | 'estimatedMinutes' | 'notes' | 'tags'>>
  ) => void;
  onMoveQuadrant: (taskId: string, targetQuadrant: Quadrant) => void;
  onDeleteTask: (taskId: string) => void;
  onFocusTask: (taskId: string) => void;
  onAddSubtask: (taskId: string, text: string, estimatedMinutes?: number) => void;
  onUpdateSubtask: (
    taskId: string,
    subtaskId: string,
    patch: Partial<Pick<SubtaskItem, 'text' | 'estimatedMinutes'>>
  ) => void;
  onToggleSubtask: (taskId: string, subtaskId: string) => void;
  onDeleteSubtask: (taskId: string, subtaskId: string) => void;
  onReorderSubtask: (taskId: string, fromIndex: number, toIndex: number) => void;
}

const EDITOR_QUADRANTS: Array<{ id: Quadrant; label: string }> = [
  { id: 'Q2', label: 'Q2' },
  { id: 'Q1', label: 'Q1' },
  { id: 'Q3', label: 'Q3' },
  { id: 'Q4', label: 'Q4' },
  { id: 'INBOX', label: 'Inbox' },
];

const VIEWPORT_MARGIN = 12;
const ANCHOR_GAP = 12;
const DESKTOP_BREAKPOINT = 640;
const MAX_DESKTOP_WIDTH = 420;

function computeAnchoredPosition(
  dialog: HTMLDialogElement,
  anchorRect: DOMRect | null
): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (vw <= DESKTOP_BREAKPOINT) {
    dialog.style.top = '';
    dialog.style.left = '';
    dialog.style.width = '';
    dialog.style.maxHeight = '';
    dialog.style.transformOrigin = '';
    return;
  }

  const width = Math.min(MAX_DESKTOP_WIDTH, vw - VIEWPORT_MARGIN * 2);
  const maxHeight = Math.max(240, vh - VIEWPORT_MARGIN * 2);
  dialog.style.width = `${width}px`;
  dialog.style.maxHeight = `${maxHeight}px`;

  const height = Math.min(dialog.offsetHeight || 360, maxHeight);
  const maxTop = Math.max(VIEWPORT_MARGIN, vh - height - VIEWPORT_MARGIN);
  const maxLeft = Math.max(VIEWPORT_MARGIN, vw - width - VIEWPORT_MARGIN);

  let left: number;
  let top: number;
  let transformOrigin: string;

  if (!anchorRect) {
    left = Math.max(VIEWPORT_MARGIN, Math.round((vw - width) / 2));
    top = Math.round((vh - height) / 2);
    transformOrigin = 'center center';
  } else if (vw - anchorRect.right >= width + VIEWPORT_MARGIN * 2) {
    left = anchorRect.right + ANCHOR_GAP;
    top = anchorRect.top;
    transformOrigin = 'left top';
  } else if (anchorRect.left >= width + VIEWPORT_MARGIN * 2) {
    left = anchorRect.left - width - ANCHOR_GAP;
    top = anchorRect.top;
    transformOrigin = 'right top';
  } else {
    left = Math.min(Math.max(VIEWPORT_MARGIN, anchorRect.left), maxLeft);
    const spaceBelow = vh - anchorRect.bottom;
    const spaceAbove = anchorRect.top;
    if (spaceBelow >= height + VIEWPORT_MARGIN * 2 || spaceBelow >= spaceAbove) {
      top = anchorRect.bottom + ANCHOR_GAP;
      transformOrigin = 'center top';
    } else {
      top = anchorRect.top - height - ANCHOR_GAP;
      transformOrigin = 'center bottom';
    }
  }

  const clampedLeft = Math.min(Math.max(VIEWPORT_MARGIN, left), maxLeft);
  const clampedTop = Math.min(Math.max(VIEWPORT_MARGIN, top), maxTop);

  dialog.style.left = `${Math.round(clampedLeft)}px`;
  dialog.style.top = `${Math.round(clampedTop)}px`;
  dialog.style.transformOrigin = transformOrigin;
}

interface SubtaskRowProps {
  taskId: string;
  sub: SubtaskItem;
  index: number;
  isDragging: boolean;
  dropEdge: 'before' | 'after' | null;
  handleRef: (el: HTMLButtonElement | null) => void;
  onDragStart: (index: number, e: DragEvent) => void;
  onDragOver: (index: number, e: DragEvent) => void;
  onDrop: (index: number, e: DragEvent) => void;
  onDragEnd: () => void;
  onReorderKeyDown: (index: number, subId: string, e: KeyboardEvent) => void;
  onToggleSubtask: (taskId: string, subtaskId: string) => void;
  onUpdateSubtask: (
    taskId: string,
    subtaskId: string,
    patch: Partial<Pick<SubtaskItem, 'text' | 'estimatedMinutes'>>
  ) => void;
  onDeleteSubtask: (taskId: string, subtaskId: string) => void;
}

function SubtaskRow({
  taskId,
  sub,
  index,
  isDragging,
  dropEdge,
  handleRef,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onReorderKeyDown,
  onToggleSubtask,
  onUpdateSubtask,
  onDeleteSubtask,
}: SubtaskRowProps) {
  const [textDraft, setTextDraft] = useState(sub.text);
  const [hoursDraft, setHoursDraft] = useState(() =>
    formatMinutesAsDecimalHours(sub.estimatedMinutes)
  );
  const textInputRef = useRef<HTMLInputElement | null>(null);
  const hoursInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (document.activeElement !== textInputRef.current) {
      setTextDraft(sub.text);
    }
  }, [sub.id, sub.text]);

  useEffect(() => {
    if (document.activeElement !== hoursInputRef.current) {
      setHoursDraft(formatMinutesAsDecimalHours(sub.estimatedMinutes));
    }
  }, [sub.id, sub.estimatedMinutes]);

  const commitText = () => {
    const trimmed = textDraft.trim();
    if (trimmed && trimmed !== sub.text) {
      onUpdateSubtask(taskId, sub.id, { text: trimmed });
    } else if (!trimmed) {
      setTextDraft(sub.text);
    }
  };

  const commitHours = () => {
    const nextMinutes = parseDecimalHours(hoursDraft);
    if (nextMinutes !== sub.estimatedMinutes) {
      onUpdateSubtask(taskId, sub.id, { estimatedMinutes: nextMinutes });
    }
    setHoursDraft(formatMinutesAsDecimalHours(nextMinutes));
  };

  const parsedMinutes = parseDecimalHours(hoursDraft);
  const indicatorClass =
    dropEdge === 'before' ? 'drop-before' : dropEdge === 'after' ? 'drop-after' : '';

  return (
    <div
      class={`editor-subtask-row ${sub.done ? 'done' : ''} ${
        isDragging ? 'is-dragging' : ''
      } ${indicatorClass}`.trim()}
      draggable
      onDragStart={(e) => onDragStart(index, e)}
      onDragOver={(e) => onDragOver(index, e)}
      onDrop={(e) => onDrop(index, e)}
      onDragEnd={onDragEnd}
    >
      <button
        type="button"
        ref={handleRef}
        class="drag-handle"
        aria-label={`Reorder subtask "${sub.text}" with ArrowUp or ArrowDown`}
        onKeyDown={(e) => onReorderKeyDown(index, sub.id, e)}
      >
        ⋮⋮
      </button>
      <label class="subtask-checkbox-hit">
        <input
          type="checkbox"
          class="editor-subtask-checkbox"
          checked={sub.done}
          aria-label={`Toggle subtask "${sub.text}"`}
          onChange={() => onToggleSubtask(taskId, sub.id)}
        />
      </label>
      <input
        ref={textInputRef}
        type="text"
        class="editor-subtask-text"
        aria-label={`Subtask "${sub.text}" title`}
        value={textDraft}
        onInput={(e) => setTextDraft((e.currentTarget as HTMLInputElement).value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.isComposing || e.keyCode === 229) return;
            commitText();
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
      />
      <div class="editor-subtask-controls">
        <input
          ref={hoursInputRef}
          type="number"
          step="any"
          min="0"
          inputMode="decimal"
          class="editor-subtask-hours"
          aria-label={`Subtask "${sub.text}" hours`}
          placeholder="0.25"
          value={hoursDraft}
          onInput={(e) => {
            const val = (e.currentTarget as HTMLInputElement).value;
            setHoursDraft(val);
            const nextMinutes = parseDecimalHours(val);
            if ((val === '' || nextMinutes !== undefined) && nextMinutes !== sub.estimatedMinutes) {
              onUpdateSubtask(taskId, sub.id, { estimatedMinutes: nextMinutes });
            }
          }}
          onBlur={commitHours}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (e.isComposing || e.keyCode === 229) return;
              commitHours();
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
        />
        {parsedMinutes !== undefined && (
          <span class="editor-subtask-minutes-badge">{parsedMinutes}m</span>
        )}
        <button
          type="button"
          class="icon-btn editor-subtask-delete"
          aria-label={`Delete subtask "${sub.text}"`}
          title="Delete subtask"
          onClick={() => onDeleteSubtask(taskId, sub.id)}
        >
          ×
        </button>
      </div>
    </div>
  );
}

export function TaskEditorPopover(props: TaskEditorPopoverProps) {
  const {
    task,
    anchorRect,
    isMobile,
    onClose,
    onUpdateDetails,
    onMoveQuadrant,
    onDeleteTask,
    onFocusTask,
    onAddSubtask,
    onUpdateSubtask,
    onToggleSubtask,
    onDeleteSubtask,
    onReorderSubtask,
  } = props;

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const hoursInputRef = useRef<HTMLInputElement | null>(null);
  const notesInputRef = useRef<HTMLTextAreaElement | null>(null);
  const newSubTitleRef = useRef<HTMLInputElement | null>(null);
  const newSubHoursRef = useRef<HTMLInputElement | null>(null);
  const subtaskHandleRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const dragStartYRef = useRef<number | null>(null);
  const dragDeltaYRef = useRef<number>(0);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const anchorRectRef = useRef<DOMRect | null>(anchorRect);
  anchorRectRef.current = anchorRect;

  const [titleDraft, setTitleDraft] = useState('');
  const [hoursDraft, setHoursDraft] = useState('');
  const [notesDraft, setNotesDraft] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [newSubtaskText, setNewSubtaskText] = useState('');
  const [newSubtaskHours, setNewSubtaskHours] = useState('');

  const submitNewSubtask = () => {
    if (!task) return;
    const cleanText = newSubtaskText.trim();
    if (!cleanText) {
      newSubTitleRef.current?.focus();
      return;
    }
    const mins = parseDecimalHours(newSubtaskHours);
    onAddSubtask(task.id, cleanText, mins);
    setNewSubtaskText('');
    setNewSubtaskHours('');
    newSubTitleRef.current?.focus();
  };

  const finishSheetDrag = (commitClose: boolean) => {
    if (dragStartYRef.current === null) return;
    const dy = dragDeltaYRef.current;
    dragStartYRef.current = null;
    dragDeltaYRef.current = 0;
    const dialog = dialogRef.current;
    if (dialog) {
      dialog.style.transition = '';
      dialog.style.transform = '';
      if (commitClose && dy > 72) {
        void closeTopLayer(dialog);
      }
    }
  };

  const draggingSubIdxRef = useRef<number | null>(null);
  const [draggingSubIdx, setDraggingSubIdx] = useState<number | null>(null);
  const [subDropIndicator, setSubDropIndicator] = useState<{
    index: number;
    edge: 'before' | 'after';
  } | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      dialog.returnValue = '';
      onCloseRef.current();
    };

    const handleCancel = (e: Event) => {
      e.preventDefault();
      void closeTopLayer(dialog);
    };

    dialog.addEventListener('close', handleClose);
    dialog.addEventListener('cancel', handleCancel);

    let cleanupBackdrop: (() => void) | undefined;
    if (
      typeof HTMLDialogElement !== 'undefined' &&
      !('closedBy' in HTMLDialogElement.prototype)
    ) {
      let pointerDownOutside = false;

      const isOutsideRect = (e: PointerEvent): boolean => {
        const rect = dialog.getBoundingClientRect();
        return (
          e.clientX < rect.left ||
          e.clientX > rect.right ||
          e.clientY < rect.top ||
          e.clientY > rect.bottom
        );
      };

      const handlePointerDown = (e: PointerEvent) => {
        pointerDownOutside = e.target === dialog && isOutsideRect(e);
      };

      const handlePointerUp = (e: PointerEvent) => {
        if (pointerDownOutside && e.target === dialog && isOutsideRect(e)) {
          void closeTopLayer(dialog);
        }
        pointerDownOutside = false;
      };

      const handlePointerCancel = () => {
        pointerDownOutside = false;
      };

      dialog.addEventListener('pointerdown', handlePointerDown);
      dialog.addEventListener('pointerup', handlePointerUp);
      dialog.addEventListener('pointercancel', handlePointerCancel);

      cleanupBackdrop = () => {
        dialog.removeEventListener('pointerdown', handlePointerDown);
        dialog.removeEventListener('pointerup', handlePointerUp);
        dialog.removeEventListener('pointercancel', handlePointerCancel);
      };
    }

    return () => {
      dialog.removeEventListener('close', handleClose);
      dialog.removeEventListener('cancel', handleCancel);
      cleanupBackdrop?.();
    };
  }, []);

  useEffect(() => {
    setTitleDraft(task?.title ?? '');
    setHoursDraft(formatMinutesAsDecimalHours(task?.estimatedMinutes));
    setNotesDraft(task?.notes ?? '');
    setTagDraft('');
    setNewSubtaskText('');
    setNewSubtaskHours('');
    draggingSubIdxRef.current = null;
    setDraggingSubIdx(null);
    setSubDropIndicator(null);
  }, [task?.id]);

  useEffect(() => {
    if (task && document.activeElement !== titleInputRef.current) {
      setTitleDraft(task.title);
    }
  }, [task?.id, task?.title]);

  useEffect(() => {
    if (task && document.activeElement !== hoursInputRef.current) {
      setHoursDraft(formatMinutesAsDecimalHours(task.estimatedMinutes));
    }
  }, [task?.id, task?.estimatedMinutes]);

  useEffect(() => {
    if (task && document.activeElement !== notesInputRef.current) {
      setNotesDraft(task.notes ?? '');
    }
  }, [task?.id, task?.notes]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    dragStartYRef.current = null;
    dragDeltaYRef.current = 0;
    dialog.style.transform = '';
    dialog.style.transition = '';

    if (task) {
      if (!dialog.open) {
        dialog.showModal();
      }

      const updatePosition = () => {
        if (!dialog.open || dialog.hasAttribute('data-closing')) return;
        computeAnchoredPosition(dialog, anchorRectRef.current);
      };

      updatePosition();
      window.addEventListener('resize', updatePosition);
      const ro =
        typeof ResizeObserver !== 'undefined'
          ? new ResizeObserver(updatePosition)
          : null;
      ro?.observe(dialog);

      return () => {
        ro?.disconnect();
        window.removeEventListener('resize', updatePosition);
      };
    } else if (dialog.open) {
      dialog.removeAttribute('data-closing');
      dialog.close();
    }
  }, [task?.id, anchorRect]);

  const commitTitle = () => {
    if (!task) return;
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== task.title) {
      onUpdateDetails(task.id, { title: trimmed });
    } else if (!trimmed) {
      setTitleDraft(task.title);
    }
  };

  const commitHours = () => {
    if (!task) return;
    const nextMinutes = parseDecimalHours(hoursDraft);
    if (nextMinutes !== task.estimatedMinutes) {
      onUpdateDetails(task.id, { estimatedMinutes: nextMinutes });
    }
    setHoursDraft(formatMinutesAsDecimalHours(nextMinutes));
  };

  const commitTags = (rawInput: string) => {
    if (!task) return;
    const parts = rawInput.split(',');
    const existing = task.tags || [];
    const nextTags = [...existing];
    let changed = false;

    for (const part of parts) {
      const clean = part.trim().replace(/^[#+]+/, '').trim().toLowerCase();
      if (clean && !nextTags.includes(clean)) {
        nextTags.push(clean);
        changed = true;
      }
    }

    if (changed) {
      onUpdateDetails(task.id, { tags: nextTags });
    }
    setTagDraft('');
  };

  const resetSubDragState = () => {
    draggingSubIdxRef.current = null;
    setDraggingSubIdx(null);
    setSubDropIndicator(null);
  };

  const computeSubtaskDropTarget = (
    fromIndex: number,
    hoveredIndex: number,
    e: DragEvent
  ): { toIndex: number; edge: 'before' | 'after' } => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const edge: 'before' | 'after' =
      e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    const rawTarget = edge === 'before' ? hoveredIndex : hoveredIndex + 1;
    const toIndex = fromIndex < rawTarget ? rawTarget - 1 : rawTarget;
    return { toIndex, edge };
  };

  const checklist = task?.checklist || [];
  const doneCount = checklist.filter((s) => s.done).length;
  const totalCount = checklist.length;
  const subTotal = getSubtasksEstimatedMinutes(task?.checklist);
  const subTotalHours = formatMinutesAsDecimalHours(subTotal);
  const parsedTaskMinutes = parseDecimalHours(hoursDraft);
  const parsedNewSubMinutes = parseDecimalHours(newSubtaskHours);

  return (
    <dialog
      ref={dialogRef}
      class="task-editor-dialog"
      aria-labelledby="task-editor-heading"
      {...({ closedby: 'any' } as Record<string, unknown>)}
    >
      {task && (
        <div class="task-editor-content">
          <div
            class="editor-sheet-handle"
            onPointerDown={(e) => {
              if (window.innerWidth > DESKTOP_BREAKPOINT) return;
              const dialog = dialogRef.current;
              if (!dialog || dialog.scrollTop > 0) return;
              const target = e.target as HTMLElement | null;
              if (target?.closest('button, input, select, textarea, a')) return;
              dragStartYRef.current = e.clientY;
              dragDeltaYRef.current = 0;
              dialog.style.transition = 'none';
              if (typeof e.currentTarget.setPointerCapture === 'function') {
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {
                  // Ignore synthetic pointer ids without active capture
                }
              }
            }}
            onPointerMove={(e) => {
              if (dragStartYRef.current === null) return;
              const dialog = dialogRef.current;
              if (!dialog) return;
              const dy = Math.max(0, e.clientY - dragStartYRef.current);
              dragDeltaYRef.current = dy;
              dialog.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
            }}
            onPointerUp={() => finishSheetDrag(true)}
            onPointerCancel={() => finishSheetDrag(false)}
          >
            <div class="sheet-grabber" aria-hidden="true" />

            <div class="editor-header">
              <h2 id="task-editor-heading" class="visually-hidden">
                Edit Task
              </h2>
              <div class="editor-quadrant-pills" role="group" aria-label="Task Quadrant">
                {EDITOR_QUADRANTS.map((qOpt) => (
                  <button
                    key={qOpt.id}
                    type="button"
                    class={`editor-quadrant-pill pill-${qOpt.id} ${
                      task.quadrant === qOpt.id ? 'active' : ''
                    }`}
                    aria-pressed={task.quadrant === qOpt.id}
                    onClick={() => onMoveQuadrant(task.id, qOpt.id)}
                  >
                    {qOpt.label}
                  </button>
                ))}
              </div>

              <div class="editor-header-actions">
                {!task.completed && !isMobile && (
                  <button
                    type="button"
                    class="btn btn-sm btn-q2"
                    onClick={() => {
                      onFocusTask(task.id);
                      if (dialogRef.current) void closeTopLayer(dialogRef.current);
                    }}
                  >
                    ▶ Focus
                  </button>
                )}
                <button
                  type="button"
                  class="icon-btn editor-close-btn"
                  aria-label="Close editor"
                  onClick={() => {
                    if (dialogRef.current) void closeTopLayer(dialogRef.current);
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          </div>

          <label for="editor-task-title" class="visually-hidden">
            Task title
          </label>
          <input
            ref={titleInputRef}
            id="editor-task-title"
            type="text"
            class="editor-title-input"
            value={titleDraft}
            onInput={(e) => setTitleDraft((e.currentTarget as HTMLInputElement).value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (e.isComposing || e.keyCode === 229) return;
                commitTitle();
                (e.currentTarget as HTMLInputElement).blur();
              }
            }}
          />

          <div class="editor-meta-grid">
            <div class="editor-meta-field">
              <label for="editor-task-hours" class="editor-field-label">
                Estimated hours
              </label>
              <div class="capture-hours-wrapper">
                <input
                  ref={hoursInputRef}
                  id="editor-task-hours"
                  type="number"
                  step="any"
                  min="0"
                  inputMode="decimal"
                  class="capture-input capture-hours-input"
                  placeholder="Hours (e.g. 0.5)"
                  value={hoursDraft}
                  onInput={(e) => {
                    const val = (e.currentTarget as HTMLInputElement).value;
                    setHoursDraft(val);
                    const nextMinutes = parseDecimalHours(val);
                    if (
                      (val === '' || nextMinutes !== undefined) &&
                      nextMinutes !== task.estimatedMinutes
                    ) {
                      onUpdateDetails(task.id, { estimatedMinutes: nextMinutes });
                    }
                  }}
                  onBlur={commitHours}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (e.isComposing || e.keyCode === 229) return;
                      commitHours();
                      (e.currentTarget as HTMLInputElement).blur();
                    }
                  }}
                />
                {parsedTaskMinutes !== undefined && (
                  <span class="capture-minutes-hint">{parsedTaskMinutes}m</span>
                )}
              </div>
            </div>

            <div class="editor-meta-field">
              <label for="editor-task-due" class="editor-field-label">
                Due date
              </label>
              <div class="editor-due-wrapper">
                <input
                  id="editor-task-due"
                  type="date"
                  class="capture-date"
                  value={task.dueDate || ''}
                  onInput={(e) => {
                    const val = (e.currentTarget as HTMLInputElement).value;
                    onUpdateDetails(task.id, { dueDate: val || undefined });
                  }}
                />
                {task.dueDate && (
                  <button
                    type="button"
                    class="icon-btn editor-clear-due-btn"
                    aria-label="Clear due date"
                    title="Clear due date"
                    onClick={() => onUpdateDetails(task.id, { dueDate: undefined })}
                  >
                    ×
                  </button>
                )}
              </div>
              <div class="editor-quick-dates">
                {[
                  { label: 'Today', offset: 0 },
                  { label: 'Tomorrow', offset: 1 },
                  { label: '+7d', offset: 7 },
                ].map((preset) => {
                  const iso = calculateOffsetDate(preset.offset).iso;
                  return (
                    <button
                      key={preset.label}
                      type="button"
                      class={`quick-date-chip ${task.dueDate === iso ? 'active' : ''}`}
                      onClick={() => onUpdateDetails(task.id, { dueDate: iso })}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div class="editor-tags-section">
            <div class="editor-tags-list">
              {(task.tags || []).map((tag) => (
                <span key={tag} class="tag-pill editor-tag-pill">
                  #{tag}
                  <button
                    type="button"
                    class="editor-tag-remove"
                    aria-label={`Remove tag ${tag}`}
                    onClick={() => {
                      const next = (task.tags || []).filter((t) => t !== tag);
                      onUpdateDetails(task.id, {
                        tags: next.length > 0 ? next : undefined,
                      });
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <input
              type="text"
              class="capture-input editor-tag-input"
              aria-label="Add tag"
              placeholder="+ Add tag (Enter)..."
              value={tagDraft}
              onInput={(e) => {
                const val = (e.currentTarget as HTMLInputElement).value;
                if (val.includes(',')) {
                  commitTags(val);
                } else {
                  setTagDraft(val);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault();
                  if (e.isComposing || e.keyCode === 229) return;
                  commitTags(tagDraft);
                }
              }}
            />
          </div>

          <div class="editor-notes-section">
            <label for="editor-task-notes" class="editor-field-label">
              Notes
            </label>
            <textarea
              ref={notesInputRef}
              id="editor-task-notes"
              rows={2}
              class="editor-notes"
              placeholder="Notes..."
              value={notesDraft}
              onInput={(e) => {
                const val = (e.currentTarget as HTMLTextAreaElement).value;
                setNotesDraft(val);
                onUpdateDetails(task.id, { notes: val });
              }}
            />
          </div>

          <div class="editor-subtasks-section">
            <div class="editor-subtasks-header">
              <span class="editor-subtasks-title">
                Subtasks ({doneCount}/{totalCount})
              </span>
              <div class="editor-subtasks-summary">
                {subTotal > 0 && (
                  <span class="editor-subtasks-sum mono">
                    {subTotalHours}h ({subTotal}m)
                  </span>
                )}
                {subTotal > 0 && subTotal !== task.estimatedMinutes && (
                  <button
                    type="button"
                    class="btn btn-sm editor-sync-hours-btn"
                    onClick={() => onUpdateDetails(task.id, { estimatedMinutes: subTotal })}
                  >
                    Sync to task
                  </button>
                )}
              </div>
            </div>

            <form
              class="editor-subtask-add-form"
              onSubmit={(e) => {
                e.preventDefault();
                submitNewSubtask();
              }}
            >
              <input
                ref={newSubTitleRef}
                type="text"
                class="capture-input editor-subtask-add-input"
                enterKeyHint="next"
                aria-label="Subtask title"
                placeholder="Subtask title (Enter for hrs)..."
                value={newSubtaskText}
                onInput={(e) =>
                  setNewSubtaskText((e.currentTarget as HTMLInputElement).value)
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.isComposing || e.keyCode === 229) return;
                    if (!newSubtaskText.trim()) return;
                    newSubHoursRef.current?.focus();
                    newSubHoursRef.current?.select();
                  }
                }}
              />
              <div class="capture-hours-wrapper editor-subtask-add-hours-wrap">
                <input
                  ref={newSubHoursRef}
                  type="number"
                  step="any"
                  min="0"
                  inputMode="decimal"
                  enterKeyHint="done"
                  class="capture-input capture-hours-input editor-subtask-add-hours"
                  aria-label="Subtask estimated hours"
                  placeholder="Hours (e.g. 0.25)"
                  value={newSubtaskHours}
                  onInput={(e) =>
                    setNewSubtaskHours((e.currentTarget as HTMLInputElement).value)
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      newSubTitleRef.current?.focus();
                      return;
                    }
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      e.stopPropagation();
                      if (e.isComposing || e.keyCode === 229) return;
                      submitNewSubtask();
                    }
                  }}
                />
                {parsedNewSubMinutes !== undefined && (
                  <span class="capture-minutes-hint">{parsedNewSubMinutes}m</span>
                )}
              </div>
              <button type="submit" class="btn btn-sm btn-primary">
                + Add
              </button>
            </form>

            {checklist.length > 0 && (
              <div class="editor-subtasks-list">
                {checklist.map((sub, idx) => (
                  <SubtaskRow
                    key={sub.id}
                    taskId={task.id}
                    sub={sub}
                    index={idx}
                    isDragging={draggingSubIdx === idx}
                    dropEdge={
                      subDropIndicator && subDropIndicator.index === idx
                        ? subDropIndicator.edge
                        : null
                    }
                    handleRef={(el) => {
                      subtaskHandleRefs.current[sub.id] = el;
                    }}
                    onDragStart={(fromIdx, e) => {
                      const target = e.target as HTMLElement | null;
                      if (
                        target?.closest('input, textarea, button:not(.drag-handle), select')
                      ) {
                        e.preventDefault();
                        return;
                      }
                      if (e.dataTransfer) {
                        e.dataTransfer.setData('text/plain', String(fromIdx));
                        e.dataTransfer.effectAllowed = 'move';
                      }
                      draggingSubIdxRef.current = fromIdx;
                      setDraggingSubIdx(fromIdx);
                    }}
                    onDragOver={(hoveredIdx, e) => {
                      e.preventDefault();
                      if (e.dataTransfer) {
                        e.dataTransfer.dropEffect = 'move';
                      }
                      const fromIdx = draggingSubIdxRef.current;
                      if (fromIdx === null || fromIdx === hoveredIdx) {
                        setSubDropIndicator(null);
                        return;
                      }
                      const { toIndex, edge } = computeSubtaskDropTarget(
                        fromIdx,
                        hoveredIdx,
                        e
                      );
                      if (toIndex === fromIdx) {
                        setSubDropIndicator(null);
                        return;
                      }
                      setSubDropIndicator({ index: hoveredIdx, edge });
                    }}
                    onDrop={(hoveredIdx, e) => {
                      e.preventDefault();
                      const raw =
                        draggingSubIdxRef.current ??
                        Number(e.dataTransfer?.getData('text/plain'));
                      if (
                        !Number.isInteger(raw) ||
                        raw < 0 ||
                        raw >= checklist.length
                      ) {
                        resetSubDragState();
                        return;
                      }
                      const { toIndex } = computeSubtaskDropTarget(raw, hoveredIdx, e);
                      if (toIndex !== raw) {
                        onReorderSubtask(task.id, raw, toIndex);
                      }
                      resetSubDragState();
                    }}
                    onDragEnd={resetSubDragState}
                    onReorderKeyDown={(fromIdx, subId, e) => {
                      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                        e.preventDefault();
                        const delta = e.key === 'ArrowUp' ? -1 : 1;
                        const toIdx = fromIdx + delta;
                        if (toIdx >= 0 && toIdx < checklist.length) {
                          onReorderSubtask(task.id, fromIdx, toIdx);
                          requestAnimationFrame(() => {
                            subtaskHandleRefs.current[subId]?.focus({
                              preventScroll: true,
                            });
                          });
                        }
                      }
                    }}
                    onToggleSubtask={onToggleSubtask}
                    onUpdateSubtask={onUpdateSubtask}
                    onDeleteSubtask={onDeleteSubtask}
                  />
                ))}
              </div>
            )}
          </div>

          <div class="editor-footer">
            <button
              type="button"
              class="btn btn-sm btn-danger-ghost"
              onClick={() => {
                onDeleteTask(task.id);
                if (dialogRef.current) void closeTopLayer(dialogRef.current);
              }}
            >
              Delete
            </button>

            <button
              type="button"
              class="btn btn-sm btn-primary"
              onClick={() => {
                if (dialogRef.current) void closeTopLayer(dialogRef.current);
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
