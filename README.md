# Boron Q4 Matrix

> Local-first, zero-backend Progressive Web App (PWA) grounded in Stephen Covey's 4-Quadrant Matrix and Chapter 1 of *The Boron Letters* by Gary & Bond Halbert.

[![Deploy to GitHub Pages](https://github.com/clarityEnjoyer/Q4/actions/workflows/deploy.yml/badge.svg)](https://github.com/clarityEnjoyer/Q4/actions/workflows/deploy.yml)

## Philosophy

> *"Everything you do in Q2 helps avoid having to do so much in Q1. Take care of important things first and early before the world wakes up."* — [base.md](base.md)

Boron Q4 enforces **Q2 Primacy (Important & Not Urgent)**:
- **Morning Focus Gate**: Opens directly in Q2 Work Block before 10:00 AM if daily Q2 work is pending.
- **Prevention Loop**: Converts completed Q1 crises into preventive Q2 systems.
- **Deadline Drift Escalation**: Q2 tasks within 36h of deadline escalate automatically to Q1.

## Features

- **Pure Functional CRDT Core**: Bounded Join-Semilattice (`A ⊔ B = B ⊔ A`, `(A ⊔ B) ⊔ C = A ⊔ (B ⊔ C)`, `A ⊔ A = A`) with Lamport clocks and tombstone deletions.
- **3-Step Task Capture**: Keyboard-first `Title -> Decimal Hours -> Calendar Popover` flow (`/` to focus).
- **Intra-Block & Cross-Block Drag-and-Drop**: Reorder tasks inside any block or across quadrants with pointer or keyboard handles (`Space` + Arrows / `Alt+Arrows`).
- **3-Phase Work Block**: Budget `Auto-Plan` with proportional timeline -> distraction-free `Focus Cockpit` with wall-clock timer & embedded subtasks -> `Session Debrief`.
- **Actual Time Tracking**: Native `<dialog>` completion prompt records actual hours taken without double-counting logged timer sessions.
- **Zero-Backend GitHub Gist Sync**: Offline-first sync storing `q4-state.json` and `Q4-MATRIX.md` in a private Gist.

## Quick Start

```bash
npm install
npm run dev    # Local dev server
npm test       # Run Vitest suite
npm run build  # Typecheck and production build
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for architecture and subsystem contracts.
