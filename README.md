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
npm run setup:backend
```

`setup:backend` creates `apps/backend/.venv` and installs Python dependencies.

## Run (development)

```bash
npm run dev
```

This starts the backend (`http://localhost:8123`) and the frontend dev server (`http://localhost:5173`) in parallel. Open the frontend URL in your browser.

## Available scripts

- `npm run dev` - run backend and frontend together
- `npm run dev:backend` - run only the backend
- `npm run dev:frontend` - run only the frontend
- `npm run build:frontend` - production build of the frontend
- `npm run setup:backend` - create venv and install Python deps

## Data location

Session state and corrections cache are stored in a local SQLite database under the user's app-data folder (`%APPDATA%/chess_book_reader/state.sqlite3` on Windows, `~/.local/share/chess_book_reader/state.sqlite3` elsewhere).
