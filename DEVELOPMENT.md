# Boron Q4 Matrix — Architecture, Engineering & Development Guide

> *"Everything you do in Q2 helps avoid having to do so much in Q1. Take care of important things first and early before the world wakes up."*  
> — Chapter 1, *The Boron Letters* (Gary & Bond Halbert)

---

## 1. Executive Summary & Philosophy

**Boron Q4 Matrix** is a local-first, zero-backend Progressive Web App (PWA) engineered around the intersection of Stephen Covey’s 4-Quadrant Time Management Matrix and Chapter 1 of *The Boron Letters*.

The application is tailored for computer science students, researchers, and engineers who face an unrelenting barrage of reactive interruptions. Standard todo lists treat all items equally or sort purely by urgent deadlines, encouraging users to live in perpetual crisis (**Q1**) or distraction (**Q3**). 

Boron Q4 enforces an opinionated operating model:
1. **Q2 Primacy (Important & Not Urgent)**: High-leverage activities (studying algorithms, system design, exercise, proactive maintenance) are prioritized first.
2. **Morning Focus Gate**: Before 10:00 AM, the app defaults to a dedicated deep-work gate, hiding Q1 fires, Q3 interruptions, and Q4 distractions until daily Q2 commitments are met.
3. **Prevention Feedback Loop**: When a Q1 crisis strikes, the user is prompted to capture a corresponding Q2 preventive habit or system to ensure the crisis never recurs.
4. **Deadline Drift Escalation**: Neglected Q2 tasks automatically escalate to Q1 crises when their deadline reaches $\le 36\text{ hours}$ ($\le 72\text{h}$ for warning), reflecting real-world entropy.

---

## 2. Architectural Design & Invariants

The codebase follows the **Functional Core / Imperative Shell** paradigm:

```
┌─────────────────────────────────────────────────────────────┐
│                       IMPERATIVE SHELL                      │
│                                                             │
│   src/App.tsx            Preact UI, Keyboard, Timers        │
│   src/sync/storage.ts    LocalStorage, File I/O, Node ID    │
│   src/sync/gistSync.ts   GitHub Gist REST API Transport     │
└──────────────────────────────┬──────────────────────────────┘
                               │ Dispatches Actions / Reads
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                     PURE FUNCTIONAL CORE                    │
│                                                             │
│   src/core/types.ts      Algebraic Data Types & Logical Clocks│
│   src/core/crdt.ts       Join-Semilattice (CvRDT) Engine    │
│   src/core/engine.ts     Triage, DSL Parser, Analytics      │
│   src/core/markdown.ts   Two-Way Markdown Serializer        │
│                                                             │
│   * Completely free of DOM, window, fetch, or side effects   │
│   * 100% Deterministic & Unit-Tested via Vitest             │
└─────────────────────────────────────────────────────────────┘
```

### Core Architectural Invariants

1. **Pure Core Isolation (`src/core/`)**:
   - `src/core/` must never reference `window`, `document`, `localStorage`, `fetch`, or generate non-deterministic time without receiving it as an argument or clock seed.
2. **Monotonic Lamport Clock Advancement**:
   - Every state modification (`addTask`, `moveTask`, `triageTask`, `deleteTask`, `updateTaskDetails`) MUST invoke `nextClock(state)` and increment `maxLamport`.
3. **Tombstone-Based Deletions**:
   - Never remove a task key physically (`delete state.tasks[id]`). A deleted item is marked with `deleted: true` and a new Lamport clock stamp. This prevents an offline device from resurrecting a deleted task during a merge.
4. **Join-Semilattice Convergence**:
   - The state merge operation $\sqcup$ (`mergeAppState`) must satisfy Commutativity, Associativity, and Idempotence across all arbitrary concurrent edit sequences.

---

## 3. Mathematical Foundations: State-based CRDT (CvRDT)

Cross-device synchronization (between laptop, tablet, and mobile) operates without a centralized database or coordination server. Instead, it relies on state-based Conflict-Free Replicated Data Types (CvRDTs) formalized as a **Bounded Join-Semilattice** $(S, \sqcup, \bot)$.

### 3.1 The Join-Semilattice Laws

Given any two or three application states $A, B, C \in S$:

$$\begin{aligned}
\text{Commutativity:} & \quad A \sqcup B = B \sqcup A \\
\text{Associativity:} & \quad (A \sqcup B) \sqcup C = A \sqcup (B \sqcup C) \\
\text{Idempotence:}   & \quad A \sqcup A = A
\end{aligned}$$

Because the semilattice is bounded with a partial order $A \le B \iff A \sqcup B = B$, network payloads can arrive out-of-order, be duplicated, or sync after days offline, and all devices will deterministically compute the exact same state.

### 3.2 Total Ordering on Hybrid Logical Clocks

Each task carries a logical clock:
```typescript
export interface LogicalClock {
  lamport: number;  // Logical causal progression
  wallTime: number; // Physical wall-clock timestamp (ms)
  nodeId: string;   // Unique device identifier
}
```

Comparison between clocks $C_1$ and $C_2$ is defined by a strict total ordering:
$$\operatorname{cmp}(C_1, C_2) = \begin{cases}
C_1.\text{lamport} - C_2.\text{lamport} & \text{if } C_1.\text{lamport} \neq C_2.\text{lamport} \\
C_1.\text{wallTime} - C_2.\text{wallTime} & \text{if } C_1.\text{wallTime} \neq C_2.\text{wallTime} \\
\operatorname{localeCompare}(C_1.\text{nodeId}, C_2.\text{nodeId}) & \text{otherwise}
\end{cases}$$

### 3.3 Register Merge Semantics

When two versions of the same task $T_A$ and $T_B$ are merged:
1. **Strict Lamport Superiority**: If $T_A.\text{clock}.\text{lamport} > T_B.\text{clock}.\text{lamport}$, $T_A$ wins entirely.
2. **Tied Lamport Clock Resolution**:
   - **Edit-Wins over Tombstone**: If one device edited the task while another deleted it at the same Lamport clock, the live edit wins to safeguard against accidental data loss.
   - **Deterministic Tie-Break**: If both are live edits (or both tombstones), the winner is chosen via `compareClocks`.
   - **Multi-Value (MV) Register for Overlaps**: If both devices performed differing live edits at the exact same Lamport version, the alternative edit is preserved in `task.concurrentConflicts: ConcurrentTaskValue[]`. The UI alerts the user and provides deterministic options:
     - `Keep Primary`: Adopts the tie-breaker winner and clears conflicts.
     - `Fork Overlap`: Forks the conflicting edit into a new task with a deterministic ID (`${taskId}_fork_${nodeId}_${lamport}`).
3. **Session Aggregation**: Focus session minutes are linked to tasks via an immutable Grow-Only Set (G-Set). When sessions merge, each task’s `focusMinutesLogged` is recalculated as $\max(\text{existing}, \sum \text{session duration})$.

### 3.4 Live Property Verification

The codebase includes an algebraic verifier in `src/core/crdt.ts` (`verifySemilatticeLaws(A, B, C)`) which runs both in the automated Vitest suite and live inside the app's **Sync & Lab** panel.

---

## 4. Key Subsystems & Implementation Details

### 4.1 Rapid 2-Decision Binary Triage Engine

Incoming tasks in `#inbox` bypass cognitive decision fatigue through a rapid 2-question keyboard triage:
1. **Is it Important?** (`[Y]` / `[N]`)
2. **Is it Urgent?** (`[Y]` / `[N]`)

```
               Important?
               /        \
           [YES]        [NO]
           /                \
      Urgent?              Urgent?
      /     \              /     \
   [YES]   [NO]         [YES]   [NO]
    │       │            │       │
    ▼       ▼            ▼       ▼
    Q1      Q2           Q3      Q4
  Crisis   Deep        Delegate Rest
          Work
```

Shortcuts: `Y` or `1` for YES, `N` or `0` for NO. A synchronous ref lock (`triageLockRef`) prevents debounce double-triggers.

### 4.2 Shorthand DSL Parser (`parseQuickInput`)

The quick-capture bar at the top of the matrix parses tags, dates, and estimates in a single string while leaving regular prose intact:
- `#q1`, `#q2`, `#q3`, `#q4`, `#inbox`: Target quadrant.
- `+tag`: Categorization tags (e.g. `+mimuw`, `+asd`, `+health`). Requires leading alphabetic character so mathematical syntax like `+1` is preserved.
- `due:YYYY-MM-DD`, `due:today`, `due:tomorrow`, `due:+3d`: Deadlines with calendar validation (`isValidISODate`).
- `~45m`, `~2h`: Time estimates converted to minutes.

### 4.3 Wall-Clock Anchored Focus Timer

In mobile browsers and background tabs, standard `setInterval(..., 1000)` ticks are throttled down to once per minute to save battery, causing countdown timers to stall.

Boron Q4 resolves this by anchoring the timer to wall-clock epoch time:
```typescript
const endTime = Date.now() + remainingSeconds * 1000;
```
A `visibilitychange` event listener recalculates `remainingSeconds = Math.max(0, Math.round((endTime - Date.now()) / 1000))` whenever the user switches back to the tab.

### 4.4 Zero-Backend GitHub Gist Synchronization

Cross-device sync uses GitHub Gist as an encrypted/authenticated personal object store:
- **Dual Representation Payload**:
  - `q4-state.json`: Raw CRDT state containing tasks, tombstones, clocks, and focus logs.
  - `Q4-MATRIX.md`: Human-readable Markdown file rendered from the state, making your tasks readable directly from any web browser or GitHub mobile app.
- **Sync Protocol**:
  1. Fetch remote Gist files.
  2. Parse remote `q4-state.json`.
  3. Compute `mergedState = mergeAppState(localState, remoteState)`.
  4. Save `mergedState` locally.
  5. `PATCH` the updated `q4-state.json` and freshly serialized `Q4-MATRIX.md` back to the Gist.

---

## 5. Directory Layout

```
/home/alex/programming/projects/Q4/
├── .github/
│   └── workflows/
│       └── deploy.yml          # GitHub Pages automated CI/CD pipeline
├── public/
│   ├── icon.svg                # Vector SVG app icon
│   ├── manifest.json           # PWA installation manifest
│   └── sw.js                   # Service Worker for offline shell caching
├── src/
│   ├── core/                   # PURE FUNCTIONAL CORE (Zero side effects)
│   │   ├── crdt.ts             # CvRDT Join-Semilattice implementation
│   │   ├── crdt.test.ts        # Vitest test suite (7 comprehensive tests)
│   │   ├── engine.ts           # DSL parser, triage, decay, analytics
│   │   ├── markdown.ts         # Two-way Markdown export/import
│   │   └── types.ts            # Algebraic Data Types & interfaces
│   ├── sync/                   # IMPERATIVE STORAGE & TRANSPORT
│   │   ├── gistSync.ts         # GitHub Gist REST API client
│   │   └── storage.ts          # LocalStorage & device nodeId persistence
│   ├── App.tsx                 # Preact single-file UI component
│   ├── main.tsx                # DOM entry point
│   └── styles.css              # Dark theme, responsive grid & mobile styles
├── base.md                     # Source excerpt from The Boron Letters Ch. 1
├── GEMINI.md                   # Agentic rules & architectural invariants
├── index.html                  # HTML entry point with PWA meta tags
├── package.json                # Dependencies (Preact, Vite, Vitest, TypeScript)
├── tsconfig.json               # TypeScript configuration with bundler resolution
└── vite.config.ts              # Vite configuration (base: './' for Pages)
```

---

## 6. Development & Deployment Workflow

### 6.1 Prerequisites
- Node.js $\ge 20$
- npm $\ge 10$

### 6.2 Local Commands

```bash
# Install dependencies
npm install

# Run development server with Hot Module Replacement
npm run dev

# Run the CRDT and domain test suite
npm test

# Build for production
npm run build
```

Production build footprint is exceptionally lean:
- HTML: `~0.65 kB`
- CSS: `~9.1 kB`
- JavaScript: `~49.3 kB` (uncompressed, including Preact runtime and full CRDT engine)

### 6.3 GitHub Pages Deployment Setup

The repository includes a fully automated GitHub Actions deployment workflow (`.github/workflows/deploy.yml`).

To activate live hosting on GitHub Pages:
1. Open the repository on GitHub: `https://github.com/clarityEnjoyer/Q4`
2. Navigate to **Settings** $\to$ **Pages**
3. Under **Build and deployment** $\to$ **Source**, choose **GitHub Actions**
4. Push a commit to `main` (or trigger the workflow manually from the Actions tab).
5. The live site will deploy to: `https://clarityenjoyer.github.io/Q4/`

---

## 7. Future Development Roadmap

The following tracks outline planned enhancements for future development iterations:

### Track 1: Hierarchical Q2 Projects & Task Drawer
- **Goal**: Large Q2 initiatives (e.g. *Learn Distributed Systems*, *Prepare for MIMUW Exam*) need breakdown into atomic sub-tasks without cluttering the high-level matrix.
- **Specification**:
  - Add optional `checklist?: Array<{ id: string; text: string; done: boolean }>` to `TaskItem`.
  - Add a flyout Task Detail Drawer when clicking a task card.
  - Sub-task toggle advances parent task Lamport clock.

### Track 2: Client-Side Web Crypto End-to-End Encryption
- **Goal**: Allow users to store sensitive tasks on GitHub Secret Gists with zero-knowledge encryption.
- **Specification**:
  - Derive a symmetric encryption key from a user password using `PBKDF2` / `Web Crypto API` (`AES-GCM-256`).
  - Encrypt `q4-state.json` and generate an encrypted payload before pushing to the Gist.
  - Decrypt in-browser upon sync.

### Track 3: Historical Boron Analytics & Trend Visualizations
- **Goal**: Measure long-term behavioral transformation from reactive (Q1-heavy) to proactive (Q2-heavy).
- **Specification**:
  - Add an SVG/Canvas area chart showing 30-day rolling ratios:
    $$\text{Boron Index} = \frac{\text{Q2 Focus Minutes}}{\text{Q1 Focus Minutes} + \text{Q2 Focus Minutes}}$$
  - Track weekly morning streaks and crisis avoidance statistics.

### Track 4: Audio Signals & Web Notifications API
- **Goal**: Sound cues for focus completion.
- **Specification**:
  - Integrate a gentle synthesized sine-wave chime using the `AudioContext` API (zero external audio file dependencies).
  - Request `Notification.requestPermission()` to trigger system notifications when deep work blocks complete while in the background.