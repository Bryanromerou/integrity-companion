/**
 * Proctor Snippet — ~100 lines of browser-side detection
 * Embed in the assessment page. Connects to the Electron companion app
 * via WebSocket. Falls back to console logging if Electron isn't running.
 *
 * Usage: <script src="proctor-snippet.js"></script>
 */
(function () {
  const WS_PORT = 18329;
  const WS_URL = `ws://localhost:${WS_PORT}`;
  const RECONNECT_INTERVAL_MS = 3000;

  let ws = null;
  let connected = false;
  let sessionId = null;
  let reconnectTimer = null;

  // ── WebSocket Connection ─────────────────────────────

  function connect() {
    try {
      ws = new WebSocket(WS_URL);

      ws.onopen = function () {
        connected = true;
        console.log('[Proctor] Connected to companion app');
        if (reconnectTimer) {
          clearInterval(reconnectTimer);
          reconnectTimer = null;
        }
      };

      ws.onmessage = function (event) {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'handshake') {
            sessionId = msg.payload.sessionId;
          }
        } catch (e) {
          /* ignore */
        }
      };

      ws.onclose = function () {
        connected = false;
        console.log('[Proctor] Disconnected from companion app');
        scheduleReconnect();
      };

      ws.onerror = function () {
        connected = false;
      };
    } catch (e) {
      connected = false;
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (!reconnectTimer) {
      reconnectTimer = setInterval(connect, RECONNECT_INTERVAL_MS);
    }
  }

  function sendSignal(signal) {
    signal.timestamp = signal.timestamp || Date.now();
    if (connected && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'signal', payload: signal }));
    } else {
      console.log('[Proctor][local]', signal.type, signal.metadata || {});
    }
  }

  // ── Browser-Side Detection ───────────────────────────

  // Tab blur / visibility change
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      sendSignal({
        type: 'focus-loss',
        severity: 'medium',
        metadata: { source: 'visibilitychange' },
      });
    } else if (document.visibilityState === 'visible') {
      sendSignal({
        type: 'focus-gain',
        severity: 'info',
        metadata: { source: 'visibilitychange' },
      });
    }
  });
  window.addEventListener('blur', function () {
    sendSignal({
      type: 'focus-loss',
      severity: 'medium',
      metadata: { source: 'blur' },
    });
  });
  window.addEventListener('focus', function () {
    sendSignal({
      type: 'focus-gain',
      severity: 'info',
      metadata: { source: 'focus' },
    });
  });

  // Copy / paste interception
  ['copy', 'paste', 'cut'].forEach(function (evt) {
    document.addEventListener(evt, function (e) {
      sendSignal({
        type: 'clipboard-event',
        severity: 'medium',
        metadata: {
          action: evt,
          hasData:
            evt === 'paste' &&
            e.clipboardData &&
            e.clipboardData.getData('text').length > 0,
        },
      });
    });
  });

  // Suspicious keyboard shortcuts
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.key === 'Enter') {
      sendSignal({
        type: 'suspicious-shortcut',
        severity: 'high',
        metadata: { combo: 'Ctrl+Enter', tool: 'cluely-suspected' },
      });
    }
    if (e.ctrlKey && e.shiftKey && e.key === 'Space') {
      sendSignal({
        type: 'suspicious-shortcut',
        severity: 'high',
        metadata: { combo: 'Ctrl+Shift+Space', tool: 'unknown' },
      });
    }
    // DevTools shortcuts
    if (
      e.key === 'F12' ||
      (e.ctrlKey &&
        e.shiftKey &&
        (e.key === 'I' || e.key === 'J' || e.key === 'C'))
    ) {
      sendSignal({
        type: 'devtools-shortcut',
        severity: 'high',
        metadata: { combo: e.key === 'F12' ? 'F12' : 'Ctrl+Shift+' + e.key },
      });
    }
  });

  // DevTools open detection (size-based heuristic)
  var devtoolsOpen = false;
  setInterval(function () {
    var threshold = 160;
    var widthDiff = window.outerWidth - window.innerWidth > threshold;
    var heightDiff = window.outerHeight - window.innerHeight > threshold;
    var isOpen = widthDiff || heightDiff;
    if (isOpen && !devtoolsOpen) {
      devtoolsOpen = true;
      sendSignal({
        type: 'devtools-open',
        severity: 'high',
        metadata: { method: 'size-heuristic' },
      });
    } else if (!isOpen) {
      devtoolsOpen = false;
    }
  }, 2000);

  // DOM injection monitoring (deny-listed prefixes)
  var DENY_PREFIXES = ['claude-', 'pplx-', 'mynext-', 'cluely-'];
  var observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (mut) {
      if (mut.type !== 'childList') return;
      mut.addedNodes.forEach(function (node) {
        if (node.nodeType !== 1) return;
        var id = node.id || '';
        var matched = DENY_PREFIXES.find(function (p) {
          return id.startsWith(p);
        });
        if (matched) {
          sendSignal({
            type: 'dom-mutation',
            severity: 'critical',
            metadata: {
              mutationType: 'deny-list-injection',
              matchedPrefix: matched,
              elementId: id,
              targetTag: node.tagName,
            },
          });
        }
        if (
          node.tagName === 'IFRAME' &&
          node.src &&
          /^(chrome|moz)-extension:\/\//.test(node.src)
        ) {
          sendSignal({
            type: 'extension-injection',
            severity: 'critical',
            metadata: { source: 'iframe-injection', extensionUrl: node.src },
          });
        }
      });
    });
  });
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  // AI browser user-agent detection
  var ua = navigator.userAgent;
  var aiPatterns = [
    { p: /opera.*neon/i, t: 'opera-neon' },
    { p: /atlas/i, t: 'atlas-browser' },
    { p: /dia\s/i, t: 'dia-browser' },
    { p: /arc\//i, t: 'arc-browser' },
  ];
  aiPatterns.forEach(function (ai) {
    if (ai.p.test(ua)) {
      sendSignal({
        type: 'ai-browser',
        severity: 'critical',
        metadata: { aiBrowserType: ai.t, source: 'user-agent' },
      });
    }
  });

  // ── Expose connection status for the assessment app ──

  window.__proctorCompanion = {
    isConnected: function () {
      return connected;
    },
    getSessionId: function () {
      return sessionId;
    },
  };

  // ── Connect ──────────────────────────────────────────

  connect();
})();
