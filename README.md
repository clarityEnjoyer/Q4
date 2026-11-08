# Boron Q4 Matrix ⏱️

> A local-first, zero-backend Progressive Web App (PWA) grounded in Stephen Covey's 4-Quadrant Matrix and Chapter 1 of *The Boron Letters* by Gary & Bond Halbert.

[![Deploy to GitHub Pages](https://github.com/clarityEnjoyer/Q4/actions/workflows/deploy.yml/badge.svg)](https://github.com/clarityEnjoyer/Q4/actions/workflows/deploy.yml)
[![Tests](https://img.shields.io/badge/tests-7%20passed-brightgreen.svg)](#)

---

## 💡 The Boron Philosophy

> *"Everything you do in Q2 helps avoid having to do so much in Q1. Take care of important things first and early before the world wakes up."*  
> — [base.md](base.md)

Most productivity tools treat all tasks identically, trapping you in reactive crises (**Q1**) or trivial distractions (**Q3**). Boron Q4 enforces **Q2 Primacy (Important & Not Urgent)**:
- **Morning Focus Gate**: Defaults to deep work on Q2 tasks before 10:00 AM, hiding urgent fires and chores until your high-leverage work is done.
- **Prevention Loop**: Turn every Q1 fire into a preventive Q2 habit.
- **Temporal Decay**: Q2 tasks neglected to within $\le 36\text{h}$ of deadline automatically escalate to Q1.

---

## ⚡ Key Features

- **Pure Functional CRDT Core**: Formulated as a bounded Join-Semilattice ($A \sqcup B = B \sqcup A$, $(A \sqcup B) \sqcup C = A \sqcup (B \sqcup C)$, $A \sqcup A = A$).
- **Zero-Backend Cross-Device Sync**: Free synchronization across phone and computer via GitHub Gist storing both `q4-state.json` and human-readable `Q4-MATRIX.md`.
- **Rapid 2-Decision Triage**: Rapid keyboard flow (`[Y]/[N]` Important $\to$ `[Y]/[N]` Urgent $\implies$ Q1/Q2/Q3/Q4).
- **Shorthand DSL**: Quick input supports `#q1..#q4`, `+tag`, `due:YYYY-MM-DD`, and `~45m`.
- **Background-Resilient Timer**: Anchored to wall-clock epoch time with `visibilitychange` sync to survive browser tab throttling.
- **Offline PWA**: Installable on iOS, Android, and Desktop with offline caching.

---

## 🛠️ Quick Start

```bash
# Clone and install dependencies
git clone https://github.com/clarityEnjoyer/Q4.git
cd Q4
npm install

# Start local development server
npm run dev

# Run Vitest CRDT test suite
npm test

# Build production bundle
npm run build
```

---

## 📖 In-Depth Documentation

For complete architectural specifications, mathematical proofs, conflict resolution rules, and the engineering roadmap, see:

👉 **[DEVELOPMENT.md](DEVELOPMENT.md)**

