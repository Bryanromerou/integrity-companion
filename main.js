const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("path");
const { SignalAggregator } = require("./src/aggregator");
const { WebSocketServer } = require("./src/server/ws-server");
const { ProcessScanner } = require("./src/detection/process-scanner");
const { FilesystemChecker } = require("./src/detection/filesystem-checker");
const { ClipboardMonitor } = require("./src/detection/clipboard-monitor");
const { NetworkMonitor } = require("./src/detection/network-monitor");
const { DisplayMonitor } = require("./src/detection/display-monitor");
const { ExtensionScanner } = require("./src/detection/extension-scanner");
const { BackendReporter } = require("./src/reporting/backend-reporter");

const WS_PORT = 18329;
const ASSESSMENT_BASE_URL = "http://localhost:3000";

let mainWindow = null;
let aggregator = null;
let wsServer = null;
let reporter = null;
let sessionId = null;
let currentStatus = null;
let statusBeforePause = null;

// Detection modules
let processScanner = null;
let filesystemChecker = null;
let clipboardMonitor = null;
let networkMonitor = null;
let displayMonitor = null;
let extensionScanner = null;
let shutdownReported = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 720,
    resizable: true,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0f1117",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function initAggregator() {
  aggregator = new SignalAggregator();

  aggregator.on("signal", (signal) => {
    sendToRenderer("signal", signal);
    if (reporter) {
      reporter.enqueueSignal(signal);
    }

    // When a blocking process disappears during pre-check, re-run the check
    if (
      signal.type === "process-disappeared" &&
      currentStatus === "pre_check_blocking"
    ) {
      runPreCheckAndReady();
    }

    // Pause the assessment if a blocking process appears mid-test
    if (
      signal.type === "process-detected" &&
      (currentStatus === "ready" || currentStatus === "in_progress")
    ) {
      const blockerApps = processScanner.getBlockingProcesses();
      if (blockerApps.length > 0) {
        pauseAssessment(blockerApps);
      }
    }

    // Resume the assessment when blocking processes are gone
    if (signal.type === "process-disappeared" && currentStatus === "paused") {
      const blockerApps = processScanner.getBlockingProcesses();
      if (blockerApps.length === 0) {
        resumeAssessment();
      }
    }
  });

  aggregator.on("score-update", (score) => {
    sendToRenderer("score-update", score);
  });
}

function initDetectionModules() {
  const emitSignal = (signal) => aggregator.ingest(signal);

  // Process scanner - polls for AI tools, screen sharing, etc.
  processScanner = new ProcessScanner(emitSignal);
  processScanner.start();

  // Filesystem checker - checks for installed cheating apps
  filesystemChecker = new FilesystemChecker(emitSignal);
  filesystemChecker.runOnce();

  // Clipboard monitor - polls clipboard for suspicious content
  clipboardMonitor = new ClipboardMonitor(emitSignal);
  clipboardMonitor.start();

  // Network monitor - checks for connections to AI services
  networkMonitor = new NetworkMonitor(emitSignal);
  networkMonitor.start();

  // Display monitor - detects multiple displays
  displayMonitor = new DisplayMonitor(emitSignal, screen);
  displayMonitor.start();

  // Extension scanner - scans browser extension directories
  extensionScanner = new ExtensionScanner(emitSignal);
  extensionScanner.runOnce();
}

function initWebSocketServer() {
  wsServer = new WebSocketServer(WS_PORT, (signal) => {
    aggregator.ingest({ ...signal, source: "browser" });
  });

  wsServer.on("client-connected", () => {
    sendToRenderer("browser-connected", true);
  });

  wsServer.on("client-disconnected", () => {
    sendToRenderer("browser-connected", false);
  });

  // Auto-pair: browser sends sessionId over WebSocket
  wsServer.on("auto-pair", async (incomingSessionId) => {
    if (sessionId === incomingSessionId) return; // Same session, already paired

    sessionId = incomingSessionId;
    reporter.setSessionId(sessionId);
    statusBeforePause = null;

    currentStatus = "paired";
    sendToRenderer("session-status", "paired");
    const pairResult = await reporter.updateStatus("paired");
    if (pairResult.error) {
      console.error(
        "[Main] Failed to update status to paired:",
        pairResult.error,
      );
    }

    // Check the session's actual status from the backend — the companion
    // app may have been restarted mid-assessment and should not force the
    // session back through the pre-check → ready flow.
    let backendStatus = null;
    try {
      const res = await fetch(
        `${ASSESSMENT_BASE_URL}/api/session/${sessionId}/poll`,
      );
      if (res.ok) {
        const data = await res.json();
        backendStatus = data.status;
      }
    } catch {
      // ignore — fall through to normal flow
    }

    if (backendStatus === "in_progress" || backendStatus === "paused") {
      // Session was already running — resume it directly
      currentStatus = "in_progress";
      sendToRenderer("session-status", "in_progress");
      await reporter.updateStatus("in_progress");
    } else {
      // First-time pairing — run the normal pre-check flow
      currentStatus = "paired";
      sendToRenderer("session-status", "paired");
      await reporter.updateStatus("paired");
      runPreCheckAndReady();
    }
  });

  // Sync status when the browser transitions (e.g. "Begin Assessment")
  wsServer.on("status-update", (status) => {
    currentStatus = status;
    sendToRenderer("session-status", status);
  });

  wsServer.start();
}

function initReporter() {
  reporter = new BackendReporter({
    baseUrl: ASSESSMENT_BASE_URL,
  });
  reporter.start();
}

/**
 * Run pre-check: collect blocking apps from the initial signals
 * already gathered by detection modules, then drive the session
 * through pre_check → ready.
 */
async function runPreCheckAndReady() {
  const isRecheck = currentStatus === "pre_check_blocking";

  // Tell assessment we're running pre-checks
  currentStatus = "pre_check";
  sendToRenderer("session-status", "pre_check");
  const preCheckResult = await reporter.updateStatus("pre_check");
  if (preCheckResult.error) {
    console.error(
      "[Main] Failed to update status to pre_check:",
      preCheckResult.error,
    );
  }

  // Give detection modules a moment to finish initial scans (only on first run)
  if (!isRecheck) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  // Check currently-running blocking processes (live state, not historical signals)
  const blockerApps = processScanner.getBlockingProcesses();

  if (blockerApps.length > 0) {
    // Report blockers — assessment app shows "please close these apps"
    currentStatus = "pre_check_blocking";
    const blockResult = await reporter.updateStatus("pre_check", {
      blocker: true,
      apps: blockerApps,
    });
    if (blockResult.error) {
      console.error(
        "[Main] Failed to update status to pre_check (blocking):",
        blockResult.error,
      );
    }
    sendToRenderer("session-status", "pre_check_blocking");
    sendToRenderer("pre-check-blockers", blockerApps);
  } else {
    // All clear — move to ready
    currentStatus = "ready";
    const readyResult = await reporter.updateStatus("ready");
    if (readyResult.error) {
      console.error(
        "[Main] Failed to update status to ready:",
        readyResult.error,
      );
    }
    sendToRenderer("session-status", "ready");
  }
}

/**
 * Pause the assessment because a blocking process was detected mid-test.
 */
async function pauseAssessment(blockerApps) {
  statusBeforePause = currentStatus;
  currentStatus = "paused";
  sendToRenderer("session-status", "paused");
  sendToRenderer("pre-check-blockers", blockerApps);
  const pauseResult = await reporter.updateStatus("paused", {
    reason: blockerApps.join(", "),
    apps: blockerApps,
  });
  if (pauseResult.error) {
    console.error(
      "[Main] Failed to update status to paused:",
      pauseResult.error,
    );
  }
}

/**
 * Resume the assessment after all blocking processes have been closed.
 */
async function resumeAssessment() {
  const resumeTo = statusBeforePause || "in_progress";
  statusBeforePause = null;
  currentStatus = resumeTo;
  sendToRenderer("session-status", resumeTo);
  const resumeResult = await reporter.updateStatus(resumeTo);
  if (resumeResult.error) {
    console.error(
      `[Main] Failed to update status to ${resumeTo}:`,
      resumeResult.error,
    );
  }
}

// ── IPC Handlers ──────────────────────────────────────

ipcMain.handle("get-status", () => {
  return {
    wsPort: WS_PORT,
    sessionId,
    browserConnected: wsServer ? wsServer.hasClients() : false,
    signalCount: aggregator ? aggregator.getSignalCount() : 0,
    score: aggregator ? aggregator.getScore() : 100,
    signals: aggregator ? aggregator.getRecentSignals(50) : [],
  };
});

ipcMain.handle("get-detections", () => {
  return aggregator ? aggregator.getRecentSignals(100) : [];
});

// ── App Lifecycle ─────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  initAggregator();
  initDetectionModules();
  initWebSocketServer();
  initReporter();

  sendToRenderer("status", { ready: true, wsPort: WS_PORT });
});

const ACTIVE_STATUSES = [
  "paired",
  "pre_check",
  "pre_check_blocking",
  "ready",
  "in_progress",
  "paused",
];

app.on("before-quit", async (event) => {
  if (shutdownReported) return;

  if (!sessionId || !ACTIVE_STATUSES.includes(currentStatus)) return;

  event.preventDefault();
  shutdownReported = true;

  // Best-effort report to backend before quitting (2s timeout)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);

  try {
    await Promise.allSettled([
      fetch(`${ASSESSMENT_BASE_URL}/api/session/${sessionId}/signal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "companion-app-closed",
          metadata: {
            reason: "electron-shutdown",
            previousStatus: currentStatus,
          },
          source: "electron",
        }),
        signal: controller.signal,
      }),
      fetch(`${ASSESSMENT_BASE_URL}/api/session/${sessionId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "paused",
          details: {
            reason: "companion-app-closed",
            apps: ["Integrity Companion App"],
          },
        }),
        signal: controller.signal,
      }),
    ]);
  } catch {
    // ignore — best effort
  }

  clearTimeout(timeout);
  app.quit();
});

app.on("window-all-closed", () => {
  if (processScanner) processScanner.stop();
  if (clipboardMonitor) clipboardMonitor.stop();
  if (networkMonitor) networkMonitor.stop();
  if (displayMonitor) displayMonitor.stop();
  if (wsServer) wsServer.stop();
  if (reporter) reporter.stop();
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
