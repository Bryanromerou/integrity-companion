const SCORE_CIRCUMFERENCE = 326.73; // 2 * PI * 52
const CHECK_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const CLOCK_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

let signalCount = 0;
let osSignalCount = 0;
let browserSignalCount = 0;
let currentScore = 100;

// ── Tab Switching ────────────────────────────────────

function switchTab(tabName) {
  document
    .querySelectorAll('.tab-content')
    .forEach((el) => el.classList.remove('active'));
  document
    .querySelectorAll('.tab-btn')
    .forEach((el) => el.classList.remove('active'));

  const tabEl = document.getElementById(`tab-${tabName}`);
  const btnEl = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
  if (tabEl) tabEl.classList.add('active');
  if (btnEl) btnEl.classList.add('active');
}

window.switchTab = switchTab;

// ── Auto-Pairing ────────────────────────────────────
// Pairing is handled automatically via WebSocket when the browser connects.
// The main process receives the sessionId and transitions the UI.

// ── Check-item helpers ───────────────────────────────

function setCheckDone(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const icon = el.querySelector('.check-icon');
  if (icon) {
    icon.className = 'check-icon done';
    icon.innerHTML = CHECK_SVG;
  }
}

function setCheckWaiting(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const icon = el.querySelector('.check-icon');
  if (icon) {
    icon.className = 'check-icon waiting';
    icon.innerHTML = CLOCK_SVG;
  }
}

function setCheckError(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const icon = el.querySelector('.check-icon');
  if (icon) {
    icon.className = 'check-icon error';
    icon.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  }
}

// ── Helpers ──────────────────────────────────────────

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function getSignalDescription(signal) {
  const m = signal.metadata || {};
  switch (signal.type) {
    case 'process-detected':
      return `${m.processName} running (${m.category})`;
    case 'app-installed':
      return `${m.appName} found at ${m.path}`;
    case 'extension-installed':
      return `${m.extensionName} (${m.extensionId})`;
    case 'clipboard-suspicious-content':
      return `${m.description}: "${m.preview}"`;
    case 'clipboard-rapid-change':
      return `${m.changesInWindow} clipboard changes in quick succession`;
    case 'clipboard-large-content':
      return `Large content (${m.contentLength} chars): "${m.preview}"`;
    case 'network-connection':
      return `Connection to ${m.service} detected`;
    case 'multi-display':
      return `${m.displayCount} displays detected`;
    case 'display-change':
      return `Display ${m.change}: ${m.previousCount} → ${m.currentCount}`;
    case 'focus-loss':
      return `Window lost focus (${m.source})`;
    case 'suspicious-shortcut':
      return `${m.combo} pressed (${m.tool})`;
    case 'clipboard-event':
      return `${m.action} event in browser`;
    case 'dom-mutation':
      return `${m.mutationType}: <${m.targetTag}>`;
    case 'ai-browser':
      return `AI browser: ${m.aiBrowserType} (${m.source})`;
    case 'fast-answer':
      return `Q${m.questionId}: ${m.elapsedMs}ms (${m.category})`;
    default:
      return JSON.stringify(m).substring(0, 80);
  }
}

// ── Debug View Updates ───────────────────────────────

function updateScore(score) {
  currentScore = score;
  const scoreEl = document.getElementById('scoreValue');
  const arcEl = document.getElementById('scoreArc');
  const iconEl = document.getElementById('statusIcon');
  const statusText = document.getElementById('statusText');
  const statusSub = document.getElementById('statusSub');

  scoreEl.textContent = score;

  const offset = SCORE_CIRCUMFERENCE * (1 - score / 100);
  arcEl.setAttribute('stroke-dashoffset', offset.toString());

  // Candidate view elements
  const candidateIcon = document.getElementById('candidateIcon');
  const candidateStatus = document.getElementById('candidateStatus');
  const candidateSub = document.getElementById('candidateSub');
  const footerDot = document.getElementById('candidateFooterDot');
  const footerText = document.getElementById('candidateFooterText');

  if (score > 70) {
    scoreEl.className = 'score-value';
    arcEl.setAttribute('stroke', '#3fb950');
    iconEl.className = 'status-icon';
    statusText.textContent = 'Proctoring Active';
    statusSub.textContent = 'All systems monitoring';
    if (candidateIcon) candidateIcon.className = 'candidate-icon';
    if (candidateStatus) candidateStatus.textContent = 'Proctoring Active';
    if (candidateSub)
      candidateSub.textContent =
        'Your session is being monitored. Please keep this app running while you complete your assessment.';
    if (footerDot) footerDot.style.background = '#3fb950';
    if (footerText) footerText.textContent = 'Monitoring in progress';
  } else if (score > 40) {
    scoreEl.className = 'score-value warning';
    arcEl.setAttribute('stroke', '#d29922');
    iconEl.className = 'status-icon warning';
    statusText.textContent = 'Suspicious Activity';
    statusSub.textContent = 'Potential integrity issues detected';
    if (candidateIcon) candidateIcon.className = 'candidate-icon warning';
    if (candidateStatus) candidateStatus.textContent = 'Attention Required';
    if (candidateSub)
      candidateSub.textContent =
        'Some activity on your system may affect your assessment. Please close any unnecessary applications and stay focused on your test.';
    if (footerDot) footerDot.style.background = '#d29922';
    if (footerText) footerText.textContent = 'Please review the notice above';
  } else {
    scoreEl.className = 'score-value danger';
    arcEl.setAttribute('stroke', '#f85149');
    iconEl.className = 'status-icon danger';
    statusText.textContent = 'Integrity Compromised';
    statusSub.textContent = 'Multiple cheating signals detected';
    if (candidateIcon) candidateIcon.className = 'candidate-icon danger';
    if (candidateStatus) candidateStatus.textContent = 'Session Issue Detected';
    if (candidateSub)
      candidateSub.textContent =
        'Activity has been detected that may violate assessment guidelines. Your session data has been recorded. Please ensure you are following all assessment rules.';
    if (footerDot) footerDot.style.background = '#f85149';
    if (footerText) footerText.textContent = 'Activity has been flagged';
  }
}

function addSignalToFeed(signal) {
  const feed = document.getElementById('signalFeed');

  const empty = feed.querySelector('.signal-empty');
  if (empty) empty.remove();

  const item = document.createElement('div');
  const severity = signal.severity || 'info';
  const source = signal.source || 'os';
  item.className = `signal-item ${severity}`;

  item.innerHTML = `
    <div class="signal-type">
      ${signal.type}
      <span class="signal-source ${source}">${source}</span>
      <span class="signal-time">${formatTime(signal.timestamp)}</span>
    </div>
    <div class="signal-meta">${getSignalDescription(signal)}</div>
  `;

  feed.insertBefore(item, feed.firstChild);

  signalCount++;
  if (source === 'browser') {
    browserSignalCount++;
  } else {
    osSignalCount++;
  }

  document.getElementById('signalCount').textContent = signalCount;
  document.getElementById('osSignals').textContent = osSignalCount;
  document.getElementById('browserSignals').textContent = browserSignalCount;
  document.getElementById('feedCount').textContent = `${signalCount} events`;
}

function setBrowserConnected(connected) {
  const dot = document.getElementById('browserDot');
  const detail = document.getElementById('browserDetail');

  if (connected) {
    dot.className = 'connection-dot active';
    detail.textContent = 'Connected';
  } else {
    dot.className = 'connection-dot waiting';
    detail.textContent = 'Waiting for browser...';
  }
}

// ── Session Status Handler ───────────────────────────

function handleSessionStatus(status) {
  const candidateStatus = document.getElementById('candidateStatus');
  const candidateSub = document.getElementById('candidateSub');

  switch (status) {
    case 'paired':
      // Auto-paired via WebSocket — switch to monitoring view
      document.getElementById('candidatePairing').classList.add('hidden');
      document.getElementById('candidateMonitoring').classList.remove('hidden');
      setCheckDone('checkPaired');
      setCheckWaiting('checkPreCheck');
      if (candidateStatus) candidateStatus.textContent = 'Paired Successfully';
      if (candidateSub) candidateSub.textContent = 'Running system checks...';
      break;

    case 'pre_check':
      setCheckDone('checkPaired');
      setCheckWaiting('checkPreCheck');
      if (candidateStatus) candidateStatus.textContent = 'System Check';
      if (candidateSub)
        candidateSub.textContent = 'Scanning your system for integrity...';
      break;

    case 'pre_check_blocking':
      setCheckDone('checkPaired');
      setCheckError('checkPreCheck');
      if (candidateStatus) candidateStatus.textContent = 'Action Required';
      if (candidateSub)
        candidateSub.textContent =
          'Please close the applications listed below, then the check will re-run automatically.';
      break;

    case 'ready':
    case 'in_progress':
      setCheckDone('checkPaired');
      setCheckDone('checkPreCheck');
      setCheckDone('checkReady');
      document.getElementById('blockerWarning').classList.add('hidden');
      if (candidateStatus) candidateStatus.textContent = 'Proctoring Active';
      if (candidateSub)
        candidateSub.textContent =
          'Your session is being monitored. Please keep this app running while you complete your assessment.';
      const footerDot = document.getElementById('candidateFooterDot');
      const footerText = document.getElementById('candidateFooterText');
      if (footerDot) footerDot.style.background = '#3fb950';
      if (footerText) footerText.textContent = 'Monitoring in progress';
      break;
  }
}

// ── Initialize ───────────────────────────────────────

async function init() {
  window.proctorAPI.onSignal((signal) => {
    addSignalToFeed(signal);
  });

  window.proctorAPI.onScoreUpdate((score) => {
    updateScore(score);
  });

  window.proctorAPI.onBrowserConnected((connected) => {
    setBrowserConnected(connected);
  });

  window.proctorAPI.onSessionStatus((status) => {
    handleSessionStatus(status);
  });

  window.proctorAPI.onPreCheckBlockers((apps) => {
    const warning = document.getElementById('blockerWarning');
    const list = document.getElementById('blockerList');
    list.innerHTML = '';
    apps.forEach((appName) => {
      const li = document.createElement('li');
      li.textContent = appName;
      list.appendChild(li);
    });
    warning.classList.remove('hidden');
  });

  window.proctorAPI.onStatus((status) => {
    if (status.ready) {
      document.getElementById('statusText').textContent = 'Proctoring Active';
      document.getElementById('statusSub').textContent =
        'All systems monitoring';

      const wsDot = document.getElementById('wsDot');
      const wsDetail = document.getElementById('wsDetail');
      wsDot.className = 'connection-dot active';
      wsDetail.textContent = `Port ${status.wsPort}`;
    }
  });

  try {
    const status = await window.proctorAPI.getStatus();
    if (status) {
      updateScore(status.score);
      document.getElementById('signalCount').textContent = status.signalCount;

      const wsDot = document.getElementById('wsDot');
      const wsDetail = document.getElementById('wsDetail');
      wsDot.className = 'connection-dot active';
      wsDetail.textContent = `Port ${status.wsPort}`;

      setBrowserConnected(status.browserConnected);

      // If already paired, skip to monitoring view
      if (status.sessionId) {
        document.getElementById('candidatePairing').classList.add('hidden');
        document
          .getElementById('candidateMonitoring')
          .classList.remove('hidden');
        setCheckDone('checkPaired');
        setCheckDone('checkPreCheck');
        setCheckDone('checkReady');
      }

      for (const signal of status.signals) {
        addSignalToFeed(signal);
      }
    }
  } catch {
    // Initial load may fail before main process is ready
  }
}

init();
