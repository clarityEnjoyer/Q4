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

