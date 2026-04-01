const { exec } = require('child_process');
const os = require('os');

// Process names to detect — AI tools, screen sharing, cheating tools
const SUSPICIOUS_PROCESSES = [
  // AI assistants
  { name: 'Claude', pattern: /claude/i, category: 'ai-tool', severity: 'critical' },
  { name: 'ChatGPT', pattern: /chatgpt/i, category: 'ai-tool', severity: 'critical' },
  { name: 'Cluely', pattern: /cluely/i, category: 'ai-tool', severity: 'critical' },
  { name: 'Copilot', pattern: /copilot/i, category: 'ai-tool', severity: 'high' },
  { name: 'Cursor', pattern: /\bCursor\b(?!UI)/, category: 'ai-tool', severity: 'high' },
  { name: 'Windsurf', pattern: /windsurf/i, category: 'ai-tool', severity: 'high' },
  { name: 'Perplexity', pattern: /perplexity/i, category: 'ai-tool', severity: 'critical' },
  { name: 'Gemini', pattern: /gemini/i, category: 'ai-tool', severity: 'high' },

  // Screen sharing / remote access
  { name: 'Zoom Screen Share', pattern: /zoom.*share|CptHost/i, category: 'screen-share', severity: 'high' },
  { name: 'Discord Screen Share', pattern: /discord/i, category: 'screen-share', severity: 'medium' },
  { name: 'TeamViewer', pattern: /teamviewer/i, category: 'remote-access', severity: 'critical' },
  { name: 'AnyDesk', pattern: /anydesk/i, category: 'remote-access', severity: 'critical' },

  // Virtual machines
  { name: 'VirtualBox', pattern: /virtualbox|vbox/i, category: 'vm', severity: 'high' },
  { name: 'VMware', pattern: /vmware/i, category: 'vm', severity: 'high' },
  { name: 'Parallels', pattern: /prl_|parallels/i, category: 'vm', severity: 'high' },
];

class ProcessScanner {
  constructor(onSignal) {
    this.onSignal = onSignal;
    this.intervalId = null;
    this.pollIntervalMs = 5000;
    this.detectedProcesses = new Set();
  }

  start() {
    this.scan();
    this.intervalId = setInterval(() => this.scan(), this.pollIntervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  scan() {
    const platform = os.platform();
    let cmd;

    if (platform === 'darwin') {
      cmd = 'ps -eo comm=';
    } else if (platform === 'win32') {
      cmd = 'tasklist /FO CSV /NH';
    } else {
      cmd = 'ps -eo comm=';
    }

    exec(cmd, { timeout: 5000 }, (error, stdout) => {
      if (error) return;

      const lines = stdout.split('\n').filter(Boolean);

      for (const proc of SUSPICIOUS_PROCESSES) {
        const found = lines.some((line) => proc.pattern.test(line));

        if (found && !this.detectedProcesses.has(proc.name)) {
          this.detectedProcesses.add(proc.name);
          this.onSignal({
            type: 'process-detected',
            severity: proc.severity,
            metadata: {
              processName: proc.name,
              category: proc.category,
              detectedAt: Date.now(),
            },
          });
        } else if (!found && this.detectedProcesses.has(proc.name)) {
          this.detectedProcesses.delete(proc.name);
        }
      }
    });
  }
}

module.exports = { ProcessScanner };
