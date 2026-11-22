import { useEffect, useRef, useState } from 'preact/hooks';
import { formatMinutesAsDecimalHours, parseDecimalHours } from '../core/engine';
import { TaskItem } from '../core/types';

export interface CompleteTaskDialogProps {
  task: TaskItem | null;
  suggestedMinutes?: number;
  onConfirm: (task: TaskItem, actualMinutes?: number) => void;
  onCancel: () => void;
}

export function CompleteTaskDialog(props: CompleteTaskDialogProps) {
  const { task, suggestedMinutes, onConfirm, onCancel } = props;

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const hoursInputElRef = useRef<HTMLInputElement | null>(null);

  const [hoursInput, setHoursInput] = useState('');

  const taskRef = useRef<TaskItem | null>(task);
  const hoursInputRef = useRef<string>(hoursInput);
  const onConfirmRef = useRef(onConfirm);
  const onCancelRef = useRef(onCancel);

  taskRef.current = task;
  hoursInputRef.current = hoursInput;
  onConfirmRef.current = onConfirm;
  onCancelRef.current = onCancel;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      const rv = dialog.returnValue;
      dialog.returnValue = '';

      const currentTask = taskRef.current;
      if (!currentTask) return;

      const currentHours = hoursInputRef.current;
      if (rv === 'confirm') {
        onConfirmRef.current(currentTask, parseDecimalHours(currentHours));
      } else if (rv === 'skip') {
        onConfirmRef.current(currentTask, undefined);
      } else if (rv === 'cancel' || rv === '') {
        onCancelRef.current();
      }
    };

    dialog.addEventListener('close', handleClose);

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
          dialog.close();
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
      cleanupBackdrop?.();
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (task) {
      const initialMinutes =
        suggestedMinutes ??
        (task.focusMinutesLogged > 0 ? task.focusMinutesLogged : task.estimatedMinutes);
      const initialHours = formatMinutesAsDecimalHours(initialMinutes);

      hoursInputRef.current = initialHours;
      setHoursInput(initialHours);

      if (!dialog.open) {
        dialog.showModal();
      }

      const input = hoursInputElRef.current;
      if (input) {
        input.value = initialHours;
        input.focus();
        input.select();
      }

      // Re-select after Preact flushes controlled value update to the DOM.
      const rafId = requestAnimationFrame(() => {
        const currentInput = hoursInputElRef.current;
        if (currentInput && dialog.open) {
          currentInput.focus();
          currentInput.select();
        }
      });

      return () => cancelAnimationFrame(rafId);
    } else if (dialog.open) {
      dialog.close();
    }
  }, [task, suggestedMinutes]);

  const parsedMinutes = parseDecimalHours(hoursInput);

  const referenceParts: string[] = [];
  if (task) {
    if (task.estimatedMinutes !== undefined && task.estimatedMinutes > 0) {
      referenceParts.push(`Est: ${Math.round(task.estimatedMinutes)}m`);
    }
    if (task.focusMinutesLogged > 0) {
      referenceParts.push(`Logged: ${Math.round(task.focusMinutesLogged)}m`);
    }
    if (suggestedMinutes !== undefined && suggestedMinutes > 0) {
      referenceParts.push(`Suggested: ${Math.round(suggestedMinutes)}m`);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      class="complete-dialog"
      aria-labelledby="complete-dialog-title"
      {...({ closedby: 'any' } as Record<string, unknown>)}
    >
      <form method="dialog" class="complete-dialog-form">
        <h2 id="complete-dialog-title">Finish Task</h2>
        <p class="complete-dialog-task">{task?.title ?? ''}</p>
        {referenceParts.length > 0 && (
          <p class="complete-dialog-ref">{referenceParts.join(' · ')}</p>
        )}
        <label for="complete-actual-hours">Time taken (hours)</label>
        <div class="capture-hours-wrapper">
          <input
            ref={hoursInputElRef}
            id="complete-actual-hours"
            type="number"
            step="any"
            min="0"
            class="capture-input capture-hours-input"
            placeholder="Hours (e.g. 0.25)"
            value={hoursInput}
            onInput={(e) => {
              const val = (e.currentTarget as HTMLInputElement).value;
              hoursInputRef.current = val;
              setHoursInput(val);
            }}
            autofocus
          />
          {parsedMinutes !== undefined && (
            <span class="capture-minutes-hint">{parsedMinutes}m</span>
          )}
        </div>
        <div class="complete-dialog-actions">
          <button
            type="button"
            class="btn"
            onClick={() => dialogRef.current?.close('cancel')}
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn"
            onClick={() => dialogRef.current?.close('skip')}
          >
            Skip time
          </button>
          <button type="submit" value="confirm" class="btn btn-q2">
            Complete
          </button>
        </div>
      </form>
    </dialog>
  );
}
