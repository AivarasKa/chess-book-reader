#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn, spawnSync } = require("child_process");

const CHECK_ONLY = process.argv.includes("--check-only");
const CI_SMOKE = process.argv.includes("--ci-smoke");
const BACKEND_DEFAULT_PORT = 8123;
const FRONTEND_DEFAULT_PORT = 5173;
const PORT_SEARCH_ATTEMPTS = 31;
const READY_TIMEOUT_MS = 90_000;
const READY_INTERVAL_MS = 500;

const repoRoot = path.resolve(__dirname, "..", "..");
const logsDir = path.join(repoRoot, "logs");
const logPath = path.join(logsDir, "launcher.log");
const frontendEnvLocalPath = path.join(repoRoot, "apps", "frontend", ".env.development.local");
const portableDataRoot = path.join(repoRoot, "portable-data");
const vendorRepoPath = path.join(repoRoot, "apps", "backend", "vendor", "Chess_diagram_to_FEN");
const vendorModelsPath = path.join(vendorRepoPath, "models");

let backendProc = null;
let frontendProc = null;
let shutdownStarted = false;
let parentExiting = false;
let originalFrontendEnvLocal = null;
let hadFrontendEnvLocal = false;

function appendLog(line) {
  fs.mkdirSync(logsDir, { recursive: true });
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
}

function log(line) {
  console.log(line);
  appendLog(line);
}

function escapePsSingleQuoted(text) {
  return text.replace(/'/g, "''");
}

function showDialog(title, message) {
  if (process.platform !== "win32") return;
  if (CHECK_ONLY || CI_SMOKE || process.env.CI) return;
  if (!process.stdin.isTTY) return;
  const safeTitle = escapePsSingleQuoted(title);
  const safeMsg = escapePsSingleQuoted(message);
  const cmd =
    "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');" +
    `[System.Windows.Forms.MessageBox]::Show('${safeMsg}','${safeTitle}') | Out-Null`;
  try {
    spawnSync("powershell", ["-NoProfile", "-Command", cmd], { stdio: "ignore" });
  } catch {
    // Best effort only.
  }
}

function failWithMessage(message) {
  log(`ERROR: ${message}`);
  showDialog("Chess Book Reader Launcher", message);
  process.exit(1);
}

function runVersionCheck(cmd, args) {
  const proc = spawnSync(cmd, args, { encoding: "utf8" });
  if (proc.status !== 0) return null;
  return `${proc.stdout || ""}${proc.stderr || ""}`.trim();
}

function resolveNodeExecPath() {
  const raw = runVersionCheck("node", ["-p", "process.execPath"]);
  if (!raw) return null;
  const cleaned = raw.split(/\r?\n/)[0].trim();
  return cleaned || null;
}

function runCommandChecked(cmd, args, cwd, failMessage) {
  log(`Running: ${cmd} ${args.join(" ")}`);
  const proc = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (proc.stdout) appendLog(proc.stdout.trimEnd());
  if (proc.stderr) appendLog(proc.stderr.trimEnd());
  if (proc.status !== 0) {
    const detail = `${failMessage}\nCommand: ${cmd} ${args.join(" ")}\nExit code: ${proc.status ?? "unknown"}`;
    throw new Error(detail);
  }
}

function bootstrapVendorFromZip() {
  const vendorParent = path.join(repoRoot, "apps", "backend", "vendor");
  fs.mkdirSync(vendorParent, { recursive: true });
  const zipPath = path.join(vendorParent, "Chess_diagram_to_FEN-main.zip");
  const curlAttempt = spawnSync(
    "curl.exe",
    ["-L", "--fail", "--retry", "3", "--retry-delay", "2", "https://github.com/tsoj/Chess_diagram_to_FEN/archive/refs/heads/main.zip", "-o", zipPath],
    { cwd: repoRoot, encoding: "utf8", shell: true }
  );
  if (curlAttempt.status === 0) {
    appendLog("Downloaded Chess_diagram_to_FEN using curl.exe");
  } else {
    appendLog(`curl.exe download failed, falling back to PowerShell: ${curlAttempt.stderr || curlAttempt.stdout || ""}`);
  }
  const psScript = [
    "$ErrorActionPreference='Stop'",
    `$vendorParent='${escapePsSingleQuoted(vendorParent)}'`,
    `$vendorRepo='${escapePsSingleQuoted(vendorRepoPath)}'`,
    "$zipPath=Join-Path $vendorParent 'Chess_diagram_to_FEN-main.zip'",
    "$extractPath=Join-Path $vendorParent 'Chess_diagram_to_FEN-main'",
    "if (!(Test-Path $zipPath)) { Invoke-WebRequest -Uri 'https://github.com/tsoj/Chess_diagram_to_FEN/archive/refs/heads/main.zip' -OutFile $zipPath }",
    "if (Test-Path $extractPath) { Remove-Item $extractPath -Recurse -Force }",
    "Expand-Archive -Path $zipPath -DestinationPath $vendorParent -Force",
    "if (Test-Path $vendorRepo) { Remove-Item $vendorRepo -Recurse -Force }",
    "Move-Item -Path $extractPath -Destination $vendorRepo",
    "Remove-Item $zipPath -Force",
  ].join(";");
  runCommandChecked(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript],
    repoRoot,
    "Failed to download/extract Chess_diagram_to_FEN from GitHub."
  );
}

function hasModelFiles() {
  if (!fs.existsSync(vendorModelsPath)) return false;
  const chessDir = path.join(vendorModelsPath, "chess");
  if (!fs.existsSync(chessDir)) return false;
  const files = fs.readdirSync(chessDir).filter((n) => n.endsWith(".pth"));
  return files.length > 0;
}

function parseMajor(raw, regex) {
  if (!raw) return null;
  const m = raw.match(regex);
  if (!m) return null;
  return Number(m[1]);
}

function checkPrerequisites() {
  const failures = [];
  const pythonRaw = runVersionCheck("python", ["--version"]);
  const nodeRaw = runVersionCheck("node", ["--version"]);

  const pyMajor = parseMajor(pythonRaw, /Python\s+(\d+)\.(\d+)/);
  const pyMinor = pythonRaw ? Number((pythonRaw.match(/Python\s+\d+\.(\d+)/) || [])[1]) : null;
  const nodeMajor = parseMajor(nodeRaw, /v(\d+)\./);

  if (!pythonRaw || pyMajor === null || pyMinor === null || pyMajor < 3 || (pyMajor === 3 && pyMinor < 11)) {
    failures.push(
      "Python 3.11+ is required. Install Python 3.11+, then run `Setup-ChessBookReader.cmd`."
    );
  }
  if (!nodeRaw || nodeMajor === null || nodeMajor < 20) {
    failures.push("Node.js 20+ is required. Install Node.js 20+, then run `Setup-ChessBookReader.cmd`.");
  }
  if (!CI_SMOKE) {
    const checks = [
      {
        p: path.join(repoRoot, "node_modules"),
        msg: "Missing root node_modules in this portable folder. Run `Setup-ChessBookReader.cmd` (or `npm install`).",
      },
      {
        p: path.join(repoRoot, "apps", "frontend", "node_modules"),
        msg: "Missing frontend node_modules in this portable folder. Run `Setup-ChessBookReader.cmd`.",
      },
      {
        p: path.join(repoRoot, "apps", "backend", ".venv"),
        msg: "Missing backend virtualenv in this portable folder. Run `Setup-ChessBookReader.cmd`.",
      },
      {
        p: path.join(repoRoot, "apps", "frontend", "node_modules", "vite", "bin", "vite.js"),
        msg: "Missing Vite runtime entrypoint. Run `Setup-ChessBookReader.cmd`.",
      },
    ];
    for (const item of checks) {
      if (!fs.existsSync(item.p)) failures.push(item.msg);
    }
  }

  if (failures.length) {
    failWithMessage(
      `Launcher root: ${repoRoot}\n\n` +
        "Note: checks are local to this extracted portable folder, not your original development repo.\n\n" +
        failures.join("\n\n")
    );
  }

  log(`Runtime checks OK (python='${pythonRaw}', node='${nodeRaw}')`);
}

function ensureVendorAndModels() {
  if (CI_SMOKE || CHECK_ONLY) return;

  const hasVendorRepo = fs.existsSync(vendorRepoPath);
  const hasModels = hasModelFiles();
  if (hasVendorRepo && hasModels) return;

  log("First-run bootstrap: Chess_diagram_to_FEN repo/models missing, preparing them now...");

  if (!hasVendorRepo) {
    bootstrapVendorFromZip();
  }

  const backendPython = path.join(repoRoot, "apps", "backend", ".venv", "Scripts", "python.exe");
  runCommandChecked(
    backendPython,
    ["scripts/download_models.py"],
    path.join(repoRoot, "apps", "backend"),
    "Failed to download model files. Ensure backend dependencies are installed (`Setup-ChessBookReader.cmd`)."
  );

  if (!hasModelFiles()) {
    throw new Error("Model download step completed but required model files were not found.");
  }

  log("First-run bootstrap complete: vendor repo and models are ready.");
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findAvailablePort(preferred) {
  for (let i = 0; i < PORT_SEARCH_ATTEMPTS; i += 1) {
    const candidate = preferred + i;
    // eslint-disable-next-line no-await-in-loop
    const free = await isPortFree(candidate);
    if (free) return candidate;
  }
  throw new Error(`Could not find a free port near ${preferred}.`);
}

async function waitForHttp(url, label) {
  const start = Date.now();
  let lastErr = "";
  while (Date.now() - start < READY_TIMEOUT_MS) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(url);
      if (res.ok) return;
      lastErr = `${label} responded ${res.status}`;
    } catch (err) {
      lastErr = `${label} not ready: ${err instanceof Error ? err.message : String(err)}`;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, READY_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for ${label}. Last status: ${lastErr}`);
}

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // ignore
    }
  }
}

function restoreFrontendEnvLocal() {
  try {
    if (hadFrontendEnvLocal) {
      fs.writeFileSync(frontendEnvLocalPath, originalFrontendEnvLocal ?? "", "utf8");
    } else if (fs.existsSync(frontendEnvLocalPath)) {
      fs.rmSync(frontendEnvLocalPath);
    }
  } catch (err) {
    log(`WARN: Failed to restore ${frontendEnvLocalPath}: ${String(err)}`);
  }
}

function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  parentExiting = true;
  log("Shutting down launcher and child services...");
  if (frontendProc) killProcessTree(frontendProc.pid);
  if (backendProc) killProcessTree(backendProc.pid);
  restoreFrontendEnvLocal();
  process.exit(0);
}

function wireProcessSignals() {
  process.on("SIGINT", () => {
    parentExiting = true;
    shutdown();
  });
  process.on("SIGTERM", () => {
    parentExiting = true;
    shutdown();
  });
  process.on("SIGHUP", () => {
    parentExiting = true;
    shutdown();
  });
  process.on("beforeExit", () => {
    parentExiting = true;
  });
  process.on("exit", () => {
    parentExiting = true;
    shutdownStarted = true;
    restoreFrontendEnvLocal();
  });
}

function openBrowser(url) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

async function startServices() {
  const backendPort = await findAvailablePort(BACKEND_DEFAULT_PORT);
  const frontendPort = await findAvailablePort(FRONTEND_DEFAULT_PORT);
  log(`Selected ports: backend=${backendPort}, frontend=${frontendPort}`);
  log("Starting backend and frontend services... this can take a moment on first run.");
  fs.mkdirSync(portableDataRoot, { recursive: true });

  hadFrontendEnvLocal = fs.existsSync(frontendEnvLocalPath);
  originalFrontendEnvLocal = hadFrontendEnvLocal ? fs.readFileSync(frontendEnvLocalPath, "utf8") : null;
  fs.writeFileSync(
    frontendEnvLocalPath,
    `VITE_API_BASE_URL=http://127.0.0.1:${backendPort}\n`,
    "utf8"
  );

  const backendPython = path.join(repoRoot, "apps", "backend", ".venv", "Scripts", "python.exe");
  backendProc = spawn(
    backendPython,
    ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(backendPort)],
    {
      cwd: path.join(repoRoot, "apps", "backend"),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
      env: { ...process.env, APPDATA: portableDataRoot },
    }
  );

  backendProc.stdout.on("data", (d) => appendLog(`[backend] ${String(d).trimEnd()}`));
  backendProc.stderr.on("data", (d) => appendLog(`[backend] ${String(d).trimEnd()}`));
  backendProc.on("exit", (code) => {
    appendLog(`[backend] exited with code ${code}`);
    if (!shutdownStarted && !parentExiting) {
      log(`Backend exited (code ${code ?? "?"}); shutting down launcher.`);
      parentExiting = true;
      shutdown();
    }
  });

  const frontendViteJs = path.join(repoRoot, "apps", "frontend", "node_modules", "vite", "bin", "vite.js");
  const nodeExec = resolveNodeExecPath() || "node";
  frontendProc = spawn(nodeExec, [frontendViteJs, "--host", "127.0.0.1", "--port", String(frontendPort), "--strictPort"], {
    cwd: path.join(repoRoot, "apps", "frontend"),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
    env: { ...process.env, VITE_API_BASE_URL: `http://127.0.0.1:${backendPort}` },
  });

  frontendProc.stdout.on("data", (d) => appendLog(`[frontend] ${String(d).trimEnd()}`));
  frontendProc.stderr.on("data", (d) => appendLog(`[frontend] ${String(d).trimEnd()}`));
  frontendProc.on("exit", (code) => {
    appendLog(`[frontend] exited with code ${code}`);
    if (!shutdownStarted && !parentExiting) {
      log(`Frontend exited (code ${code ?? "?"}); shutting down launcher.`);
      parentExiting = true;
      shutdown();
    }
  });

  await waitForHttp(`http://127.0.0.1:${backendPort}/api/health`, "backend");
  await waitForHttp(`http://127.0.0.1:${frontendPort}/`, "frontend");

  const frontendUrl = `http://127.0.0.1:${frontendPort}/`;
  log(`Backend ready at http://127.0.0.1:${backendPort}/api/health`);
  log(`Frontend ready at ${frontendUrl}`);
  openBrowser(frontendUrl);
}

async function main() {
  wireProcessSignals();
  checkPrerequisites();
  if (CHECK_ONLY) {
    log("Check-only mode passed.");
    return;
  }
  ensureVendorAndModels();
  await startServices();
  log("Launcher is running. Closing this process will stop backend/frontend.");
}

main().catch((err) => {
  failWithMessage(err instanceof Error ? err.message : String(err));
});
