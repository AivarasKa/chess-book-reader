# Chess Book Reader

Local-first chess book reader. Open large PDFs efficiently, double-click a diagram to recognize the position, send it to a side analysis board, and use the Lichess board editor to manually correct anything the recognition gets wrong.

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
