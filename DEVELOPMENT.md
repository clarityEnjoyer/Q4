# Boron Q4 Matrix — Development Guide

> *"Everything you do in Q2 helps avoid having to do so much in Q1. Take care of important things first and early before the world wakes up."* — Chapter 1, *The Boron Letters*

## Architecture (Functional Core / Imperative Shell)

```text
Imperative Shell (Preact UI, LocalStorage, GitHub Gist API)
  src/App.tsx              -> Top-level view router, global shortcuts, CompleteTaskDialog trigger
  src/components/          -> CaptureBar, MatrixView, TriageView, WorkBlockView, CompleteTaskDialog, SyncLabView
  src/sync/                -> storage.ts (LocalStorage & prefs), gistSync.ts (Gist REST API)
  src/visuals/             -> themes.ts (boron-dark, oled-midnight, nord-frost), analyticsWidgets.tsx

Pure Functional Core (Zero DOM, window, localStorage, or fetch)
  src/core/types.ts        -> Domain ADTs (TaskItem, LogicalClock, FocusSession, AppState)
  src/core/crdt.ts         -> State-based CvRDT Join-Semilattice (mergeAppState, nextClock, verifySemilatticeLaws)
  src/core/engine.ts       -> Task CRUD, reorderTask, completeTaskWithTime, deadline escalation, Boron analytics
  src/core/workBlock.ts    -> autoPlanWorkBlock, reconcileBreaks, computeWorkBlockSchedule
  src/core/markdown.ts     -> Deterministic Markdown export & import
```

## Core Invariants
1. **Pure Core Isolation (`src/core/`)**: Never access `window`, `document`, `localStorage`, or `fetch`.
2. **Monotonic Lamport Clocks**: Every `AppState` mutation advances `maxLamport` via `nextClock(state)`.
3. **Tombstone Deletions**: Mark `deleted: true` instead of deleting map keys.
4. **Join-Semilattice Laws**: `mergeAppState` stays commutative, associative, and idempotent across concurrent `reorderTask` and `completeTaskWithTime` edits.

## Key Subsystems
- **3-Step Task Capture (`CaptureBar.tsx`)**: Title (`Enter`) -> Decimal hours (`Enter`) -> Calendar popover (day offset, cell click, or `Enter` for no deadline).
- **Block Ordering (`MatrixView.tsx`, `reorderTask`)**: Intra-block and cross-block HTML5 drag-and-drop plus `drag-handle` keyboard reordering (`Space`/`Enter` grab mode, `ArrowUp`/`ArrowDown`, `Alt+ArrowUp`/`ArrowDown`, `Escape` cancel). Uses midpoint float spacing (`ORDER_STEP = 1024`) with automatic rebalance on tight gaps.
- **Completion Time Dialog (`CompleteTaskDialog.tsx`)**: Native `<dialog closedby="any">` (with Safari pointer fallback) prompting for decimal hours on task finish. Prevents double-counting in `computeBoronAnalytics` by subtracting linked session minutes from reported `actualMinutes` / `estimatedMinutes`.
- **3-Phase Work Block (`WorkBlockView.tsx`, `workBlock.ts`)**:
  - `PLAN`: Time-budget `Auto-Plan` (respecting custom Matrix order & scope), proportional timeline bar, smart break reconciliation (`3m`/`5m`/`10m`), drag-to-reorder sprint list, click-to-toggle task picker.
  - `FOCUS`: Distraction-free cockpit anchored to wall-clock epoch + `visibilitychange`, embedded notes/subtasks, live `document.title` countdown, optional Web Audio chime, and integrated `✓ Finish Task` flow.
  - `DEBRIEF`: Session KPI summary (Deep Work Logged, Tasks Completed, Q2 Share, Est vs Actual).
- **CRDT Gist Sync (`gistSync.ts`)**: Dual-file GitHub Secret Gist (`q4-state.json` + `Q4-MATRIX.md`) with ETag caching.

## Commands

```bash
npm install   # Install dependencies
npm run dev   # Start Vite dev server
npm test      # Run Vitest unit & CRDT semilattice tests (src/core/*.test.ts)
npm run build # Typecheck (tsc) and build production bundle to dist/
```

## Deployment
GitHub Actions workflow `.github/workflows/deploy.yml` builds `dist/` and deploys to GitHub Pages on pushes to `main`.
