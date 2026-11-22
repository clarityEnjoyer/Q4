import { TaskItem } from '../core/types';

export interface TriageViewProps {
  inboxTasks: TaskItem[];
  importantChoice: boolean | null;
  lastTriagedFeedback: string | null;
  onAnswer: (answer: boolean) => void;
  onResetStep: () => void;
  onGoMatrix: () => void;
  onGoWorkBlock: () => void;
  isMobile?: boolean;
}

/**
 * Rapid 2-decision binary triage view for sorting inbox tasks into Q1–Q4.
 */
export function TriageView({
  inboxTasks,
  importantChoice,
  lastTriagedFeedback,
  onAnswer,
  onResetStep,
  onGoMatrix,
  onGoWorkBlock,
  isMobile,
}: TriageViewProps) {
  return (
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
          <div style={{ display: 'flex', justifyContent: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            {!isMobile && (
              <button type="button" class="btn btn-q2" onClick={onGoWorkBlock}>
                Q2 Focus
              </button>
            )}
            <button
              type="button"
              class={`btn ${isMobile ? 'btn-q2' : ''}`}
              onClick={onGoMatrix}
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
                  onClick={() => onAnswer(true)}
                >
                  <span>YES — Important</span>
                  <span class="kbd-hint">Y</span>
                </button>
                <button
                  type="button"
                  class="triage-choice-btn triage-choice-no"
                  onClick={() => onAnswer(false)}
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
                  onClick={() => onAnswer(true)}
                >
                  <span>YES → {importantChoice ? 'Q1' : 'Q3'}</span>
                  <span class="kbd-hint">Y</span>
                </button>
                <button
                  type="button"
                  class="triage-choice-btn triage-choice-yes"
                  onClick={() => onAnswer(false)}
                >
                  <span>NO → {importantChoice ? 'Q2' : 'Q4'}</span>
                  <span class="kbd-hint">N</span>
                </button>
              </div>
              <button
                type="button"
                class="btn btn-sm"
                style={{ alignSelf: 'center' }}
                onClick={onResetStep}
              >
                {isMobile ? '← Back' : '← Back (Backspace)'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
