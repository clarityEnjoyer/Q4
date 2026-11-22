import { RefObject } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  calculateOffsetDate,
  DAY_HEADERS,
  formatDateISO,
  MONTH_NAMES,
  parseDecimalHours,
  parseQuickInput,
} from '../core/engine';
import { Quadrant } from '../core/types';

export interface CaptureBarProps {
  captureInputRef: RefObject<HTMLInputElement>;
  onAddTask: (
    title: string,
    quadrant: Quadrant,
    options: { dueDate?: string; estimatedMinutes?: number }
  ) => void;
  onCalendarOpenChange: (open: boolean) => void;
  isMobile?: boolean;
}

/**
 * Task capture bar: desktop 3-step keyboard flow; mobile 1-tap quick capture.
 */
export function CaptureBar({
  captureInputRef,
  onAddTask,
  onCalendarOpenChange,
  isMobile,
}: CaptureBarProps) {
  const [captureText, setCaptureText] = useState('');
  const [captureHours, setCaptureHours] = useState('');
  const [captureQuadrant, setCaptureQuadrant] = useState<Quadrant>('INBOX');
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [calendarOffset, setCalendarOffset] = useState('');
  const [calendarViewDate, setCalendarViewDate] = useState<Date>(() => new Date());

  const hoursInputRef = useRef<HTMLInputElement>(null);
  const calendarOffsetInputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const calToggleBtnRef = useRef<HTMLButtonElement>(null);

  const refocusTitle = () => {
    if (isMobile) return;
    captureInputRef.current?.focus();
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => {
        captureInputRef.current?.focus();
      });
    }
  };

  useEffect(() => {
    onCalendarOpenChange(isCalendarOpen);
  }, [isCalendarOpen, onCalendarOpenChange]);

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
    const handleClickOutside = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (
        target &&
        popoverRef.current &&
        !popoverRef.current.contains(target) &&
        !captureInputRef.current?.contains(target) &&
        !hoursInputRef.current?.contains(target) &&
        !calToggleBtnRef.current?.contains(target)
      ) {
        setIsCalendarOpen(false);
        refocusTitle();
      }
    };
    document.addEventListener('pointerdown', handleClickOutside);
    return () => document.removeEventListener('pointerdown', handleClickOutside);
  }, [isCalendarOpen, captureInputRef, isMobile]);

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
      if (e.isComposing || e.keyCode === 229) return;
      if (!captureText.trim()) return;
      if (isMobile) {
        submitTaskWithDate(undefined);
        return;
      }
      hoursInputRef.current?.focus();
      hoursInputRef.current?.select();
    }
  };

  const handleHoursKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (e.isComposing || e.keyCode === 229) return;
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
    const cleanTitle = captureText.trim();
    if (!cleanTitle) return;
    const parsed = parseQuickInput(cleanTitle);
    const finalTitle = parsed.cleanTitle || cleanTitle;
    const estimatedMinutes =
      parseDecimalHours(captureHours) ?? parsed.estimatedMinutes;
    onAddTask(finalTitle, captureQuadrant, {
      dueDate: dueDate || undefined,
      estimatedMinutes,
    });
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
      if (e.isComposing || e.keyCode === 229) return;
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

  const handleQuickAdd = (e: Event) => {
    e.preventDefault();
    if (!captureText.trim()) return;
    if (isCalendarOpen && calendarOffset.trim()) {
      handlePopoverSubmit();
    } else {
      submitTaskWithDate(undefined);
    }
  };

  return (
    <form class="capture-bar" onSubmit={handleQuickAdd}>
      <div class="capture-row">
        <input
          ref={captureInputRef}
          type="text"
          enterKeyHint={isMobile ? 'done' : 'next'}
          class="capture-input capture-title-input"
          placeholder={
            isMobile
              ? 'Add task (e.g. Write notes ~30m)...'
              : 'Task description... (Enter for hours, / to focus)'
          }
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
            inputMode="decimal"
            enterKeyHint="done"
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

        {isMobile && (
          <button
            ref={calToggleBtnRef}
            type="button"
            class={`btn btn-sm capture-cal-toggle ${isCalendarOpen ? 'btn-primary' : ''}`}
            aria-label="Pick deadline"
            aria-expanded={isCalendarOpen}
            onClick={() => {
              setIsCalendarOpen((open) => {
                const next = !open;
                if (next) {
                  setCalendarViewDate(new Date());
                  setCalendarOffset('');
                }
                return next;
              });
            }}
          >
            📅
          </button>
        )}

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
                inputMode="numeric"
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
  );
}
