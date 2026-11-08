import { computeBoronAnalytics, QUADRANT_META } from './engine';
import { AppState, Quadrant, TaskItem } from './types';

export function serializeToMarkdown(state: AppState, now: Date = new Date()): string {
  const analytics = computeBoronAnalytics(state, now);
  const allTasks = Object.values(state.tasks).filter((t) => !t.deleted);

  const byQuadrant = (q: Quadrant, completed: boolean): TaskItem[] =>
    allTasks
      .filter((t) => t.quadrant === q && t.completed === completed)
      .sort((a, b) => a.createdAt - b.createdAt);

  const lines: string[] = [];
  lines.push('# Boron Q4 Matrix');
  lines.push(
    `Q2 Focus: ${analytics.q2FocusRatio}% (${analytics.focusMinutesByQuadrant.Q2}m) | Q2 Done: ${analytics.q2CompletionRatio}%`
  );
  lines.push('');

  const inboxTasks = byQuadrant('INBOX', false);
  if (inboxTasks.length > 0) {
    lines.push('## Inbox');
    for (const t of inboxTasks) {
      lines.push(formatTaskMarkdownLine(t));
      if (t.checklist) {
        for (const sub of t.checklist) {
          lines.push(`  - [${sub.done ? 'x' : ' '}] ${sub.text}`);
        }
      }
    }
    lines.push('');
  }

  const order: Array<Exclude<Quadrant, 'INBOX'>> = ['Q2', 'Q1', 'Q3', 'Q4'];
  for (const qId of order) {
    const meta = QUADRANT_META[qId];
    const active = byQuadrant(qId, false);
    if (active.length === 0 && qId !== 'Q2') continue;
    lines.push(`## ${meta.title}`);
    for (const t of active) {
      lines.push(formatTaskMarkdownLine(t));
      if (t.checklist) {
        for (const sub of t.checklist) {
          lines.push(`  - [${sub.done ? 'x' : ' '}] ${sub.text}`);
        }
      }
    }
    lines.push('');
  }

  const completedTasks = allTasks
    .filter((t) => t.completed)
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

  if (completedTasks.length > 0) {
    lines.push('## Completed');
    for (const t of completedTasks.slice(0, 15)) {
      lines.push(formatTaskMarkdownLine(t, true));
      if (t.checklist) {
        for (const sub of t.checklist) {
          lines.push(`  - [${sub.done ? 'x' : ' '}] ${sub.text}`);
        }
      }
    }
  }

  return lines.join('\n').trim();
}

function formatTaskMarkdownLine(t: TaskItem, includeQuadrantBadge = false): string {
  const checkbox = t.completed ? '[x]' : '[ ]';
  const qBadge = includeQuadrantBadge ? `[${t.quadrant}] ` : '';
  const due = t.dueDate ? ` due:${t.dueDate}` : '';
  const est = t.estimatedMinutes ? ` ~${t.estimatedMinutes}m` : '';

  return `- ${checkbox} ${qBadge}${t.title}${due}${est}`;
}

export function parseMarkdownTaskLines(markdown: string): Array<{
  title: string;
  quadrant: Quadrant;
  completed: boolean;
}> {
  const results: Array<{ title: string; quadrant: Quadrant; completed: boolean }> = [];
  let currentSectionQuadrant: Quadrant = 'INBOX';

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim();
    if (/^##\s+Q1\b/i.test(line)) currentSectionQuadrant = 'Q1';
    else if (/^##\s+Q2\b/i.test(line)) currentSectionQuadrant = 'Q2';
    else if (/^##\s+Q3\b/i.test(line)) currentSectionQuadrant = 'Q3';
    else if (/^##\s+Q4\b/i.test(line)) currentSectionQuadrant = 'Q4';
    else if (/^##\s+Inbox\b/i.test(line)) currentSectionQuadrant = 'INBOX';
    else if (/^##\s+Completed/i.test(line)) currentSectionQuadrant = 'INBOX';

    const match = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (match) {
      const completed = match[1].toLowerCase() === 'x';
      let body = match[2].trim();
      let explicitQ = currentSectionQuadrant;

      const badgeMatch = body.match(/^(?:\*\*\[|\[)(Q1|Q2|Q3|Q4|INBOX)(?:\]\*\*|\])\s+/i);
      if (badgeMatch) {
        explicitQ = badgeMatch[1].toUpperCase() as Quadrant;
        body = body.slice(badgeMatch[0].length);
      }

      body = body
        .replace(/`\[⚠️[^\]]*\]`/g, '')
        .replace(/📅\s*`(due:[^`]+)`/g, '$1')
        .replace(/⏱️\s*`(~[^`]+)`/g, '$1')
        .replace(/🔥\s*`[^`]+`/g, '')
        .replace(/`(\+[a-zA-Z][a-zA-Z0-9_-]*)`/g, '$1')
        .trim();

      results.push({
        title: body,
        quadrant: explicitQ,
        completed,
      });
    }
  }

  return results;
}
