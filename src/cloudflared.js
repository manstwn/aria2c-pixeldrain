const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

let tunnelProcess = null;
let isIntentionallyStopped = false;
let restartTimeout = null;
let isConnected = false;

/**
 * Locate the cloudflared binary on local machine or system PATH
 */
function findCloudflaredExecutable() {
  const configuredPath = (process.env.CLOUDFLARED_PATH || '').trim();
  const candidatePaths = [
    configuredPath,
    'C:\\Program Portable\\cloudflared\\cloudflared.exe',
    'C:\\cloudflared\\cloudflared.exe',
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
    'cloudflared'
  ];

  for (const candidate of candidatePaths) {
    if (!candidate) continue;
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return 'cloudflared';
}

/**
 * Check if Cloudflare Tunnel auto-start is enabled
 */
function isCloudflaredEnabled() {
  const envVal = (process.env.ENABLE_CLOUDFLARED || process.env.AUTO_START_CLOUDFLARED || '').toLowerCase().trim();
  return envVal === 'true' || envVal === '1';
}

/**
 * Retrieve the configured Cloudflare Tunnel Token
 */
function getCloudflaredToken() {
  return (process.env.CLOUDFLARED_TOKEN || '').trim();
}

/**
 * Start Cloudflare Tunnel background daemon
 */
function startCloudflared() {
  if (!isCloudflaredEnabled()) {
    return false;
  }

  const token = getCloudflaredToken();
  if (!token) {
    console.warn('[Cloudflare Tunnel] ⚠️ ENABLE_CLOUDFLARED is true, but CLOUDFLARED_TOKEN is empty in .env. Skipping tunnel summon.');
    return false;
  }

  if (tunnelProcess && !tunnelProcess.killed) {
    return true;
  }

  isIntentionallyStopped = false;
  const binaryPath = findCloudflaredExecutable();

  console.log(`[Cloudflare Tunnel] ⚡ Summoning cloudflared daemon ("${binaryPath}")...`);

  try {
    const args = ['tunnel', 'run', '--token', token];
    tunnelProcess = spawn(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    tunnelProcess.stdout.on('data', (data) => {
      const text = data.toString();
      handleTunnelOutput(text);
    });

    tunnelProcess.stderr.on('data', (data) => {
      const text = data.toString();
      handleTunnelOutput(text);
    });

    tunnelProcess.on('error', (err) => {
      isConnected = false;
      if (err.code === 'ENOENT') {
        console.error(`[Cloudflare Tunnel Error] cloudflared binary not found at "${binaryPath}". Install with: 'curl -L https://pkg.cloudflare.com/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared' or set CLOUDFLARED_PATH in .env.`);
      } else {
        console.error(`[Cloudflare Tunnel Error] Process error:`, err.message);
      }
    });

    tunnelProcess.on('close', (code, signal) => {
      isConnected = false;
      tunnelProcess = null;
      if (!isIntentionallyStopped) {
        console.warn(`[Cloudflare Tunnel] Process exited (code: ${code}, signal: ${signal}). Reconnecting in 5s...`);
        if (restartTimeout) clearTimeout(restartTimeout);
        restartTimeout = setTimeout(() => {
          if (!isIntentionallyStopped) startCloudflared();
        }, 5000);
      } else {
        console.log(`[Cloudflare Tunnel] Daemon stopped.`);
      }
    });

    return true;
  } catch (err) {
    console.error(`[Cloudflare Tunnel Error] Could not spawn process: ${err.message}`);
    return false;
  }
}

/**
 * Parse and log relevant cloudflared tunnel connection lines
 */
function handleTunnelOutput(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    if (line.includes('Registered tunnel connection') || line.includes('Connection registered') || line.includes('connIndex=')) {
      if (!isConnected) {
        isConnected = true;
        console.log(`[Cloudflare Tunnel] ✅ Registered connection to Cloudflare edge network! Your custom domain is LIVE.`);
      }
    } else if (line.includes('Cannot determine default origin certificate') || line.includes('error=')) {
      console.warn(`[Cloudflare Tunnel Warning] ${line}`);
    } else if (line.includes('Quitting') || line.includes('Terminating')) {
      isConnected = false;
    }
  }
}

/**
 * Stop Cloudflare Tunnel daemon cleanly
 */
function stopCloudflared() {
  isIntentionallyStopped = true;
  if (restartTimeout) {
    clearTimeout(restartTimeout);
    restartTimeout = null;
  }

  if (tunnelProcess && !tunnelProcess.killed) {
    try {
      tunnelProcess.kill('SIGTERM');
      setTimeout(() => {
        if (tunnelProcess && !tunnelProcess.killed) {
          try { tunnelProcess.kill('SIGKILL'); } catch (e) {}
        }
      }, 1000);
    } catch (e) {}
  }
  tunnelProcess = null;
  isConnected = false;
}

/**
 * Get current tunnel daemon status
 */
function getStatus() {
  return {
    enabled: isCloudflaredEnabled(),
    hasToken: Boolean(getCloudflaredToken()),
    isRunning: Boolean(tunnelProcess && !tunnelProcess.killed),
    isConnected,
    binaryPath: findCloudflaredExecutable()
  };
}

module.exports = {
  startCloudflared,
  stopCloudflared,
  isCloudflaredEnabled,
  getStatus
};
