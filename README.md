# Chess Book Reader

Local-first chess book reader. Open large PDFs efficiently, double-click a diagram to recognize the position, send it to a side analysis board, and use the Lichess board editor to manually correct anything the recognition gets wrong.

## Portable Quick Start (Windows)

If you received a portable ZIP package, follow these steps:

1. Unzip the package to a normal folder (for example: `Documents\ChessBookReader-portable-win`).
2. Open the extracted folder.
3. Run `Setup-ChessBookReader.cmd` once (first-time setup).
   - 3.1 Installs root npm dependencies (`node_modules`) so shared tooling/scripts work.
   - 3.2 Installs frontend dependencies (`apps/frontend/node_modules`) so the local UI can run with Vite.
   - 3.3 Downloads and extracts `Chess_diagram_to_FEN` into `apps/backend/vendor/` (diagram recognition library source).
   - 3.4 Creates backend Python virtualenv and installs backend dependencies (`apps/backend/.venv`), including ML/runtime packages needed by recognition.
   - 3.5 Downloads model files used by the recognizer (these are required for diagram-to-FEN inference).
4. When setup finishes, run `Run-ChessBookReader.cmd`.
5. Your browser opens automatically with the app.
6. To stop the app, close the launcher window (browser tab close does not stop services).

If setup reports missing tools, install:
- Node.js 20+
- Python 3.11+

Then run `Setup-ChessBookReader.cmd` again.

## Repository layout

```
apps/
  backend/    Python FastAPI service: PDF crop, diagram detection, recognition, persistence
  frontend/   React + TypeScript + Vite: PDF viewer (pdf.js), analysis board, Edit Board button
```

The desktop shell (Tauri) is planned but not yet integrated. The app currently runs as a local web app: backend on `:8123` and frontend dev server on `:5173`.

## Prerequisites

- Node.js 20+ and npm
- Python 3.11+

## First-time setup

From the repo root:

```bash
npm install
git clone https://github.com/tsoj/Chess_diagram_to_FEN.git apps/backend/vendor/Chess_diagram_to_FEN
npm run setup:backend
```

`setup:backend` creates `apps/backend/.venv`, installs Python dependencies (including PyTorch CPU + the recognition library deps), and downloads pre-trained model weights (~80 MB) into the vendored library.

> The vendored `Chess_diagram_to_FEN` library does the heavy lifting for diagram → FEN recognition. It uses several training-time dependencies that aren't available on Windows; we stub them at inference time in `apps/backend/app/cdf_integration.py`.

## Run (development)

```bash
npm run dev
```

This starts the backend (`http://localhost:8123`) and the frontend dev server (`http://localhost:5173`) in parallel. Open the frontend URL in your browser.

The frontend reads `apps/frontend/.env.development` for backend routing in dev:

```bash
VITE_API_BASE_URL=http://127.0.0.1:8123
```

No Vite API proxy is required.

## Available scripts

- `npm run dev` - run backend and frontend together
- `npm run dev:backend` - run only the backend
- `npm run dev:frontend` - run only the frontend
- `npm run stop:dev` - force-stop dev services on ports `8123` and `5173` (Windows/PowerShell)
- `npm run build:frontend` - production build of the frontend
- `npm run setup:backend` - create venv and install Python deps
- `npm run launcher:check` - check launcher runtime/dependency prerequisites
- `npm run launcher:run` - run the Windows launcher (dynamic ports + browser open)
- `npm run package:portable:win` - create lean Windows portable zip in `dist/portable-win`

## Windows lean portable launcher

This repository now includes isolated packaging logic under `packaging/windows-portable/`.
It does **not** replace normal development flow; `npm run dev` and related scripts remain unchanged.

### Behavior

- Runtime/dependency check only (no auto-install).
- First run auto-bootstrap for recognizer assets: launcher downloads/extracts `Chess_diagram_to_FEN` and downloads models if missing.
  - downloader prefers `curl.exe` when available, and falls back to PowerShell download.
- Dynamic port selection: prefers backend `8123` and frontend `5173`, then selects nearby free ports.
- Launcher creates `apps/frontend/.env.development.local` at runtime with dynamic backend URL and restores/removes it on launcher exit.
- Closing browser tab does not stop services; closing launcher process stops backend and frontend.
- Logs are written to `logs/launcher.log`.
- Portable runtime data/cache is stored inside the package folder under `portable-data/chess_book_reader/` (not `%APPDATA%`).

### Prerequisites for launcher

- Python 3.11+
- Node.js 20+ and npm (setup step uses npm)
- `node_modules` at repo root and `apps/frontend/node_modules`
- `apps/backend/.venv`

If missing:

- root deps: `npm install`
- frontend deps: `cd apps/frontend && npm install`
- backend venv: `npm run setup:backend`
- optional pre-download models (skip first-run bootstrap wait): `cd apps/backend && npm run setup:models`

### Portable zip output

`npm run package:portable:win` produces:

- staged folder: `dist/portable-win/ChessBookReader-portable-win/`
- zip: `dist/portable-win/ChessBookReader-portable-win.zip`

Run portable build via `Run-ChessBookReader.cmd` in the package root.
An internal copy also exists at `packaging/windows-portable/Run-ChessBookReader.cmd`.
For first-time setup in the extracted portable folder, run `Setup-ChessBookReader.cmd` once.

### GitHub Actions (manual)

Workflow: `.github/workflows/windows-portable.yml`

- Trigger: manual (`workflow_dispatch`) only
- Runner: `windows-latest`
- Steps:
  - launcher smoke check (`--check-only --ci-smoke`)
  - package zip
  - upload `ChessBookReader-portable-win` artifact

## Data location

Session state and corrections cache are stored in a local SQLite database under the user's app-data folder (`%APPDATA%/chess_book_reader/state.sqlite3` on Windows, `~/.local/share/chess_book_reader/state.sqlite3` elsewhere).

## Regression testing

Use the regression checklist in [docs/regression-test-suite.md](docs/regression-test-suite.md) before shipping UI/recognition changes.

Run automated E2E checks (Playwright):

```bash
npm run test:e2e
```

Run backend regression API tests:

```bash
cd apps/backend
npm run test
```
