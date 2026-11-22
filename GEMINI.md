# Boron Q4 Matrix — Project Rules & Architecture

## Core Philosophy (`base.md`)
- Based on Chapter 1 of *The Boron Letters* (Gary/Bond Halbert) and Stephen Covey's 4-Quadrant Matrix.
- **Q2 (Important & Not Urgent)** is the primary quadrant: *"Everything you do in Q2 helps avoid having to do so much in Q1. Take care of important things first and early before the world wakes up."*

## Architectural Invariants
1. **Pure Functional Core (`src/core/`)**:
   - Keep `src/core/crdt.ts`, `src/core/engine.ts`, and `src/core/markdown.ts` completely free of DOM or network side effects.
2. **CRDT Join-Semilattice (`src/core/crdt.ts`)**:
   - All mutations to `AppState` MUST advance the Lamport clock via `nextClock(state)`.
   - Deletions MUST use tombstones (`deleted: true`), never `delete state.tasks[id]`, to preserve CRDT convergence across offline devices.
   - `mergeAppState(A, B)` must remain commutative, associative, and idempotent. Run `npm test` to verify semilattice laws.

## Communication & Subagent Orchestration Protocol
1. **User Communication (`caveman`)**:
   - Always speak to user in terse caveman style: drop articles (`a`, `an`, `the`), use short fragments, answer first, zero filler.
   - Keep caveman active during `/grill-me` explanations, security summaries, and plan/walkthrough artifacts.
2. **Subagent Prompts (`asd-ste100` -> `flash`)**:
   - Partition tasks by non-overlapping file ownership and delegate to `flash` subagents (`Model: 'flash'`) in parallel.
   - Write subagent prompts in strict **ASD-STE100**: active voice, imperative verbs, <= 20 words per sentence, one instruction per sentence, no ambiguity.
   - First line of every subagent prompt MUST be: `Respond in caveman format: drop articles, use fragments, technical facts only, zero filler.`

## Module Map (Token-Optimized Navigation)
- `src/core/types.ts`: ADTs (`TaskItem` with `order` + `actualMinutes`, `LogicalClock`, `AppState`, `FocusSession`).
- `src/core/crdt.ts`: Join-Semilattice `mergeAppState`, `mergeTaskItem`, `nextClock`, `verifySemilatticeLaws`.
- `src/core/engine.ts`: Pure mutations (`addTask`, `reorderTask`, `completeTaskWithTime`, `sortTasksInBlock`, `computeBoronAnalytics`, capture/date helpers).
- `src/core/workBlock.ts`: Pure Work Block planner (`autoPlanWorkBlock`, `reconcileBreaks`, `computeWorkBlockSchedule`, `moveWorkBlockItem`).
- `src/core/markdown.ts`: Two-way Markdown export/import (`serializeToMarkdown`, `parseMarkdownTaskLines`).
- `src/components/`: `CaptureBar.tsx`, `MatrixView.tsx`, `TriageView.tsx`, `WorkBlockView.tsx`, `CompleteTaskDialog.tsx`, `SyncLabView.tsx`.
- `src/sync/`: `storage.ts` (LocalStorage/prefs/export), `gistSync.ts` (GitHub Gist CRDT sync), `types.ts`.
- `src/visuals/`: `themes.ts` (`THEME_REGISTRY`, `applyVisualTheme`), `analyticsWidgets.tsx` (`ANALYTICS_WIDGET_REGISTRY`).
- `src/App.tsx`: Slim shell routing views, global keyboard shortcuts, and `CompleteTaskDialog`.



