# Regression Test Suite

This document defines a lightweight regression suite for the current app shape.
It is designed to be run manually today, and mapped to automation later.

## Scope

Focus on areas that recently changed and are likely to regress:

- Diagram detection/caching performance behavior
- PDF scroll and progress persistence behavior
- Lichess embed integration behavior
- Local history mode behavior
- Mode-switch and state-isolation behavior

## Pre-test setup

1. Start app from repo root:

```bash
npm run dev
```

2. Open frontend at `http://localhost:5173`.
3. Use a known PDF with multiple diagram pages.
4. For cache tests, begin from empty cache:

```bash
curl.exe -s -X POST http://127.0.0.1:8123/api/cache/clear
```

## Test matrix

### A. Core detect + cache path

1. Open PDF, double-click a clear diagram:
   - expected: detect succeeds, FEN loads, overlay appears.
2. Double-click the same diagram again:
   - expected: result comes from cache (note indicates normalized cache path).
3. In browser Network, inspect `cache-lookup`:
   - expected: `200` and low `x-process-time-ms` (single-digit or low tens ms).
4. Click several cached diagrams:
   - expected: no repeated long upload delays for cache-hit path.

### B. Indexing and reopen behavior

1. Clear cache, reopen book:
   - expected: indexing banner appears and progresses to completion.
2. After completion, reopen same book:
   - expected: full-book indexing does not re-run.
3. Clear cache, reopen same book:
   - expected: indexing runs again.

### C. PDF scroll + progress save throttling

1. Scroll quickly through many pages:
   - expected: page indicator updates smoothly.
2. In Network, inspect `POST /api/books/progress` volume:
   - expected: requests are throttled/debounced, not spammed on every tiny scroll step.

### D. Lichess mode regression checks

1. In Lichess mode:
   - Turn button changes side to move in FEN.
   - Flip board works.
   - Open in Lichess opens a new tab.
   - Edit Board modal opens and applies FEN changes.
2. Validate embed stays responsive when local mode has history data.

### E. Local history mode checks

1. Switch to Local history mode:
   - expected: board is visible and interactive.
2. Make several moves:
   - expected: moves apply and board updates without noticeable stutter.
3. Add to list:
   - expected: item appears in dropdown, active item label updates.
4. Create 2-3 items and switch between them:
   - expected: each item restores its own line/state.
5. Undo and Reset line:
   - expected: state updates correctly.
6. Remove active item:
   - expected: next item becomes active or falls back to detected position.

### F. Mode isolation checks

1. Set a custom state in Lichess mode.
2. Switch to Local mode, create history and moves.
3. Switch back to Lichess:
   - expected: Lichess mode state remains as before.
4. Switch again to Local:
   - expected: Local history list and active line remain.

### G. Session reset semantics

1. Refresh browser tab:
   - expected: local history list resets (session-only behavior).
2. Reopen app:
   - expected: local history does not persist across app launches.

## Non-functional checks

- **Performance sanity**
  - Cached diagram retrieval should feel near-instant.
  - Local board should remain usable after repeated mode switches.
- **Error handling**
  - Invalid/missing PDF path should not crash app.
  - Detection failures show user-facing warning note.

## Build/quality gate

Run before shipping:

```bash
npm run build:frontend
```

Expected: successful TypeScript + Vite build.

## Automation roadmap (next step)

When adding automation, prioritize:

1. Frontend E2E with Playwright:
   - mode switch, local history CRUD, UI visibility checks.
2. Backend API regression tests with pytest:
   - `/api/diagram/cache-lookup` hit/miss behavior.
   - cache clear and precache-complete semantics.
3. Add npm scripts:
   - `test:e2e`
   - `test:api`
   - `test:regression` (aggregator)
