import type { JSX } from 'preact';
import { formatDateISO, type BoronAnalytics } from '../core/engine';
import type { AppState } from '../core/types';

// Augment BoronAnalytics in case it is extended with 30-day history and morning streak
declare module '../core/engine' {
  interface BoronAnalytics {
    morningStreakDays?: number;
    history30d?: Array<{
      date: string;
      q1Minutes: number;
      q2Minutes: number;
      q3Minutes: number;
      q4Minutes: number;
      boronIndex: number;
      completedQ2Count: number;
    }>;
  }
}

export interface AnalyticsWidget {
  id: string;
  title: string;
  subtitle: string;
  spanFull?: boolean;
  render: (props: { state: AppState; analytics: BoronAnalytics }) => JSX.Element;
}

export interface HistoryDay {
  date: string;
  q1Minutes: number;
  q2Minutes: number;
  q3Minutes: number;
  q4Minutes: number;
  boronIndex: number;
  completedQ2Count: number;
}

function resolveHistory30d(analytics: BoronAnalytics, state: AppState): HistoryDay[] {
  if (analytics.history30d && analytics.history30d.length > 0) {
    return analytics.history30d;
  }

  const result: HistoryDay[] = [];
  const now = new Date();
  const days: string[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    days.push(formatDateISO(d));
  }

  const sessions = Object.values(state.focusSessions || {});
  const tasks = Object.values(state.tasks || {}).filter((t) => !t.deleted);

  for (const dateStr of days) {
    let q1 = 0;
    let q2 = 0;
    let q3 = 0;
    let q4 = 0;

    for (const s of sessions) {
      const sDate = formatDateISO(new Date(s.endedAt));
      if (sDate === dateStr) {
        if (s.quadrant === 'Q1') q1 += s.durationMinutes;
        else if (s.quadrant === 'Q2') q2 += s.durationMinutes;
        else if (s.quadrant === 'Q3') q3 += s.durationMinutes;
        else if (s.quadrant === 'Q4') q4 += s.durationMinutes;
      }
    }

    let completedQ2 = 0;
    for (const t of tasks) {
      if (t.completed && t.quadrant !== 'INBOX') {
        const cTimestamp = t.completedAt || t.clock?.wallTime || t.createdAt;
        if (cTimestamp) {
          const cDate = formatDateISO(new Date(cTimestamp));
          if (cDate === dateStr) {
            const est = t.estimatedMinutes || 0;
            if (t.quadrant === 'Q1') q1 += est;
            else if (t.quadrant === 'Q2') {
              q2 += est;
              completedQ2++;
            } else if (t.quadrant === 'Q3') q3 += est;
            else if (t.quadrant === 'Q4') q4 += est;
          }
        }
      }
    }

    const denom = q1 + q2;
    const boronIndex = denom > 0 ? Math.round((q2 / denom) * 100) : (q2 > 0 ? 100 : 0);

    result.push({
      date: dateStr,
      q1Minutes: q1,
      q2Minutes: q2,
      q3Minutes: q3,
      q4Minutes: q4,
      boronIndex,
      completedQ2Count: completedQ2,
    });
  }

  return result;
}

function resolveMorningStreak(analytics: BoronAnalytics, state: AppState): number {
  if (typeof analytics.morningStreakDays === 'number') {
    return analytics.morningStreakDays;
  }

  const now = new Date();
  const sessions = Object.values(state.focusSessions || {});
  const tasks = Object.values(state.tasks || {}).filter(
    (t) => !t.deleted && t.completed && t.quadrant === 'Q2'
  );

  const todayStr = formatDateISO(now);
  const didToday =
    analytics.didQ2Today ||
    sessions.some((s) => s.quadrant === 'Q2' && formatDateISO(new Date(s.endedAt)) === todayStr) ||
    tasks.some((t) => {
      const ts = t.completedAt || t.clock?.wallTime || t.createdAt;
      return ts ? formatDateISO(new Date(ts)) === todayStr : false;
    });

  let streak = 0;
  const startOffset = didToday ? 0 : 1;

  for (let i = startOffset; i < 365; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const dateStr = formatDateISO(d);
    const hadActivity =
      sessions.some((s) => s.quadrant === 'Q2' && formatDateISO(new Date(s.endedAt)) === dateStr) ||
      tasks.some((t) => {
        const ts = t.completedAt || t.clock?.wallTime || t.createdAt;
        return ts ? formatDateISO(new Date(ts)) === dateStr : false;
      });

    if (hadActivity) {
      streak++;
    } else {
      break;
    }
  }

  return streak;
}

function formatMinutes(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export const ANALYTICS_WIDGET_REGISTRY: AnalyticsWidget[] = [
  // Widget 1: 30-Day Rolling Boron Index
  {
    id: 'boron-index-trend',
    title: '30-Day Rolling Boron Index',
    subtitle: 'Q2 / (Q1 + Q2) Focus Ratio — Target: ≥ 50% Proactive Defense',
    spanFull: true,
    render: ({ state, analytics }) => {
      const history = resolveHistory30d(analytics, state);
      const totalQ2Min = history.reduce((acc, d) => acc + d.q2Minutes, 0);
      const totalQ1Min = history.reduce((acc, d) => acc + d.q1Minutes, 0);
      const denom = totalQ1Min + totalQ2Min;
      const rolling30dIndex = denom > 0 ? Math.round((totalQ2Min / denom) * 100) : 0;

      const latestDayIndex = history.length > 0 ? history[history.length - 1].boronIndex : rolling30dIndex;
      const isTargetMet = rolling30dIndex >= 50;

      // SVG Chart Geometry
      const padLeft = 45;
      const padRight = 20;
      const padTop = 20;
      const padBottom = 28;
      const totalWidth = 600;
      const totalHeight = 160;
      const plotWidth = totalWidth - padLeft - padRight;
      const plotHeight = totalHeight - padTop - padBottom;

      const yTarget50 = padTop + plotHeight * 0.5;

      const points = history.map((d, i) => {
        const x = padLeft + (i / Math.max(1, history.length - 1)) * plotWidth;
        const clampedIndex = Math.min(100, Math.max(0, d.boronIndex));
        const y = padTop + (1 - clampedIndex / 100) * plotHeight;
        return { x, y, val: d.boronIndex, date: d.date };
      });

      const lineD =
        points.length > 0
          ? 'M ' + points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L ')
          : '';

      const areaD =
        points.length > 0
          ? `M ${points[0].x.toFixed(1)},${(padTop + plotHeight).toFixed(1)} L ` +
            points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L ') +
            ` L ${points[points.length - 1].x.toFixed(1)},${(padTop + plotHeight).toFixed(1)} Z`
          : '';

      const latestPoint = points.length > 0 ? points[points.length - 1] : null;

      return (
        <div
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '10px',
            padding: '1.1rem 1.25rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.9rem',
          }}
        >
          {/* Header & Metrics */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '0.75rem',
            }}
          >
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.55rem',
                }}
              >
                <span
                  style={{
                    fontSize: '0.92rem',
                    fontWeight: 700,
                    letterSpacing: '-0.01em',
                    color: 'var(--text-main)',
                  }}
                >
                  30-Day Rolling Boron Index
                </span>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '0.18rem 0.55rem',
                    borderRadius: '999px',
                    fontSize: '0.72rem',
                    fontWeight: 700,
                    fontFamily: 'monospace',
                    background: isTargetMet ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                    color: isTargetMet ? '#10b981' : '#ef4444',
                    border: `1px solid ${isTargetMet ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.4)'}`,
                  }}
                >
                  {rolling30dIndex}% Rolling Avg
                </span>
                <span
                  style={{
                    fontSize: '0.73rem',
                    color: 'var(--text-dim)',
                  }}
                >
                  (Today: {latestDayIndex}%)
                </span>
              </div>
              <div
                style={{
                  fontSize: '0.76rem',
                  color: 'var(--text-muted)',
                  marginTop: '0.2rem',
                }}
              >
                Formula: Q2 / (Q1 + Q2). Covey &amp; Boron philosophy: Maintain &ge; 50% to prevent firefighting.
              </div>
            </div>

            {/* 30-Day Focus Summary Pill Box */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.65rem',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                padding: '0.35rem 0.75rem',
                fontSize: '0.78rem',
              }}
            >
              <div>
                <span style={{ color: 'var(--text-dim)' }}>Q2 Focus: </span>
                <strong style={{ color: '#10b981' }}>{formatMinutes(totalQ2Min)}</strong>
              </div>
              <span style={{ color: 'var(--border-focus)' }}>|</span>
              <div>
                <span style={{ color: 'var(--text-dim)' }}>Q1 Fires: </span>
                <strong style={{ color: '#ef4444' }}>{formatMinutes(totalQ1Min)}</strong>
              </div>
            </div>
          </div>

          {/* Responsive SVG Area & Line Chart */}
          <div
            style={{
              width: '100%',
              overflow: 'hidden',
              background: 'var(--bg-base)',
              borderRadius: '8px',
              border: '1px solid var(--border-subtle)',
              padding: '0.25rem 0.5rem',
            }}
          >
            <svg
              viewBox={`0 0 ${totalWidth} ${totalHeight}`}
              style={{ width: '100%', height: 'auto', display: 'block' }}
              role="img"
              aria-label="30-Day Rolling Boron Index trend chart"
            >
              <defs>
                <linearGradient id="boronIndexGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#10b981" stop-opacity="0.38" />
                  <stop offset="100%" stop-color="#10b981" stop-opacity="0.01" />
                </linearGradient>
              </defs>

              {/* Grid Lines */}
              <line
                x1={padLeft}
                y1={padTop}
                x2={totalWidth - padRight}
                y2={padTop}
                stroke="var(--border-subtle)"
                strokeDasharray="2 3"
                strokeWidth="1"
              />
              <text
                x={padLeft - 6}
                y={padTop + 3}
                text-anchor="end"
                fill="var(--text-dim)"
                font-size="9"
                font-family="monospace"
              >
                100%
              </text>

              {/* 50% Target Threshold Line */}
              <line
                x1={padLeft}
                y1={yTarget50}
                x2={totalWidth - padRight}
                y2={yTarget50}
                stroke="#64748b"
                strokeDasharray="4 4"
                strokeWidth="1.2"
              />
              <text
                x={padLeft - 6}
                y={yTarget50 + 3}
                text-anchor="end"
                fill="#10b981"
                font-size="9"
                font-weight="bold"
                font-family="monospace"
              >
                50%
              </text>
              <text
                x={totalWidth - padRight}
                y={yTarget50 - 4}
                text-anchor="end"
                fill="#64748b"
                font-size="8.5"
                font-family="monospace"
              >
                Target Threshold
              </text>

              {/* 0% Line */}
              <line
                x1={padLeft}
                y1={padTop + plotHeight}
                x2={totalWidth - padRight}
                y2={padTop + plotHeight}
                stroke="var(--border-subtle)"
                strokeWidth="1"
              />
              <text
                x={padLeft - 6}
                y={padTop + plotHeight + 3}
                text-anchor="end"
                fill="var(--text-dim)"
                font-size="9"
                font-family="monospace"
              >
                0%
              </text>

              {/* Area fill */}
              {areaD && <path d={areaD} fill="url(#boronIndexGradient)" />}

              {/* Line */}
              {lineD && (
                <path
                  d={lineD}
                  fill="none"
                  stroke="#10b981"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}

              {/* Highlight Latest Point */}
              {latestPoint && (
                <g>
                  <circle
                    cx={latestPoint.x}
                    cy={latestPoint.y}
                    r="4.5"
                    fill="#10b981"
                    stroke="#ffffff"
                    strokeWidth="1.8"
                  />
                  <text
                    x={latestPoint.x}
                    y={Math.max(padTop + 10, latestPoint.y - 8)}
                    text-anchor={latestPoint.x > totalWidth - 60 ? 'end' : 'middle'}
                    fill="var(--text-main)"
                    font-size="9.5"
                    font-weight="bold"
                    font-family="monospace"
                  >
                    {latestPoint.val}%
                  </text>
                </g>
              )}

              {/* Date Axis Markers */}
              {history.length > 0 && (
                <>
                  <text
                    x={padLeft}
                    y={totalHeight - 8}
                    text-anchor="start"
                    fill="var(--text-dim)"
                    font-size="9"
                    font-family="monospace"
                  >
                    {history[0].date.slice(5)}
                  </text>
                  <text
                    x={padLeft + plotWidth / 2}
                    y={totalHeight - 8}
                    text-anchor="middle"
                    fill="var(--text-dim)"
                    font-size="9"
                    font-family="monospace"
                  >
                    {history[Math.floor(history.length / 2)].date.slice(5)}
                  </text>
                  <text
                    x={totalWidth - padRight}
                    y={totalHeight - 8}
                    text-anchor="end"
                    fill="var(--text-dim)"
                    font-size="9"
                    font-family="monospace"
                  >
                    Today
                  </text>
                </>
              )}
            </svg>
          </div>
        </div>
      );
    },
  },

  // Widget 2: Morning Q2 Streak & 14-Day Activity
  {
    id: 'morning-streak',
    title: 'Morning Q2 Streak & 14-Day Activity',
    subtitle: 'Consistency in taking care of important things early',
    spanFull: false,
    render: ({ state, analytics }) => {
      const streak = resolveMorningStreak(analytics, state);
      const history = resolveHistory30d(analytics, state);
      const last14 = history.slice(-14);

      return (
        <div
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '10px',
            padding: '1.1rem 1.25rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.85rem',
            height: '100%',
          }}
        >
          {/* Streak Counter Header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <div
                style={{
                  fontSize: '0.78rem',
                  color: 'var(--text-dim)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  fontWeight: 600,
                }}
              >
                Morning Q2 Streak
              </div>
              <div
                style={{
                  fontSize: '1.75rem',
                  fontWeight: 800,
                  letterSpacing: '-0.02em',
                  color: streak > 0 ? '#10b981' : 'var(--text-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                }}
              >
                <span>🔥</span>
                <span>{streak} {streak === 1 ? 'Day' : 'Days'}</span>
              </div>
            </div>

            <div
              style={{
                textAlign: 'right',
                fontSize: '0.74rem',
                color: analytics.didQ2Today ? '#10b981' : 'var(--text-dim)',
                background: analytics.didQ2Today
                  ? 'rgba(16, 185, 129, 0.12)'
                  : 'var(--bg-elevated)',
                border: `1px solid ${analytics.didQ2Today ? 'rgba(16, 185, 129, 0.35)' : 'var(--border-subtle)'}`,
                padding: '0.3rem 0.65rem',
                borderRadius: '999px',
                fontWeight: 600,
              }}
            >
              {analytics.didQ2Today ? '✓ Q2 Logged Today' : '⏳ Pending Today'}
            </div>
          </div>

          <div
            style={{
              fontSize: '0.75rem',
              color: 'var(--text-muted)',
              fontStyle: 'italic',
            }}
          >
            &ldquo;Take care of important things first and early before the world wakes up.&rdquo;
          </div>

          {/* 14-Day Visual Grid */}
          <div>
            <div
              style={{
                fontSize: '0.72rem',
                color: 'var(--text-dim)',
                marginBottom: '0.4rem',
                display: 'flex',
                justifyContent: 'space-between',
              }}
            >
              <span>Past 14 Days Activity</span>
              <span>Today →</span>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(14, 1fr)',
                gap: '0.3rem',
              }}
            >
              {last14.map((day, idx) => {
                const isActive = day.q2Minutes > 0 || day.completedQ2Count > 0;
                const isToday = idx === last14.length - 1;
                return (
                  <div
                    key={day.date}
                    title={`${day.date}: ${day.q2Minutes}m Q2 focus, ${day.completedQ2Count} Q2 tasks completed`}
                    style={{
                      height: '32px',
                      borderRadius: '5px',
                      background: isActive
                        ? '#10b981'
                        : 'var(--bg-elevated)',
                      border: isToday
                        ? '1.5px solid var(--text-main)'
                        : `1px solid ${isActive ? 'rgba(16, 185, 129, 0.4)' : 'var(--border-subtle)'}`,
                      opacity: isActive ? 1 : 0.45,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '0.62rem',
                      fontWeight: 700,
                      color: isActive ? '#ffffff' : 'var(--text-dim)',
                      transition: 'transform 0.15s ease',
                      cursor: 'default',
                    }}
                  >
                    {isActive ? (day.q2Minutes > 0 ? `${day.q2Minutes}m` : '✓') : '·'}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      );
    },
  },

  // Widget 3: Q1 -> Q2 Prevention Loop
  {
    id: 'crisis-prevention',
    title: 'Q1 → Q2 Prevention Loop',
    subtitle: 'Turning crises into preventive systems',
    spanFull: false,
    render: ({ analytics }) => {
      const { preventiveQ2Count, escalatedCrisesCount } = analytics;
      const netRatio = preventiveQ2Count - escalatedCrisesCount;
      const isStrongDefense = netRatio >= 0;

      return (
        <div
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '10px',
            padding: '1.1rem 1.25rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.9rem',
            height: '100%',
          }}
        >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <div
                style={{
                  fontSize: '0.9rem',
                  fontWeight: 700,
                  color: 'var(--text-main)',
                }}
              >
                Prevention vs Firefighting Loop
              </div>
              <div style={{ fontSize: '0.74rem', color: 'var(--text-dim)' }}>
                Systemic Moat Building (Boron Principle #1)
              </div>
            </div>

            <span
              style={{
                fontSize: '0.72rem',
                fontWeight: 700,
                padding: '0.2rem 0.55rem',
                borderRadius: '999px',
                background: isStrongDefense
                  ? 'rgba(16, 185, 129, 0.15)'
                  : 'rgba(239, 68, 68, 0.15)',
                color: isStrongDefense ? '#10b981' : '#ef4444',
                border: `1px solid ${isStrongDefense ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.4)'}`,
              }}
            >
              {netRatio >= 0 ? `+${netRatio} Net Defense` : `${netRatio} Net Deficit`}
            </span>
          </div>

          {/* Metric Cards Comparison */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '0.65rem',
            }}
          >
            <div
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid rgba(16, 185, 129, 0.25)',
                borderRadius: '8px',
                padding: '0.65rem 0.8rem',
              }}
            >
              <div
                style={{
                  fontSize: '0.7rem',
                  color: 'var(--text-dim)',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                }}
              >
                Preventive Q2 Habits
              </div>
              <div
                style={{
                  fontSize: '1.45rem',
                  fontWeight: 800,
                  color: '#10b981',
                  marginTop: '0.15rem',
                }}
              >
                {preventiveQ2Count}
              </div>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                Permanent systems linked
              </div>
            </div>

            <div
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid rgba(239, 68, 68, 0.25)',
                borderRadius: '8px',
                padding: '0.65rem 0.8rem',
              }}
            >
              <div
                style={{
                  fontSize: '0.7rem',
                  color: 'var(--text-dim)',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                }}
              >
                Escalated Crises
              </div>
              <div
                style={{
                  fontSize: '1.45rem',
                  fontWeight: 800,
                  color: '#ef4444',
                  marginTop: '0.15rem',
                }}
              >
                {escalatedCrisesCount}
              </div>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                Decayed past deadline
              </div>
            </div>
          </div>

          {/* Actionable Boron Feedback */}
          <div
            style={{
              background: 'var(--bg-base)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '8px',
              padding: '0.65rem 0.85rem',
              fontSize: '0.76rem',
              color: 'var(--text-muted)',
              lineHeight: 1.45,
            }}
          >
            {escalatedCrisesCount > 0 ? (
              <div style={{ color: '#fca5a5' }}>
                ⚠️ <strong>Crisis Alert:</strong> {escalatedCrisesCount} task(s) slipped past deadline decay into Q1 emergencies. Schedule morning Q2 triage before deadlines tighten.
              </div>
            ) : preventiveQ2Count > 0 ? (
              <div style={{ color: '#86efac' }}>
                🛡️ <strong>System Active:</strong> You have created {preventiveQ2Count} preventive system(s). You are systematically eliminating emergency firefighting before it starts.
              </div>
            ) : (
              <div>
                💡 <strong>Boron Rule:</strong> Whenever a Q1 emergency happens, create an associated Q2 task to build an automated or daily preventive habit.
              </div>
            )}
          </div>
        </div>
      );
    },
  },
];
