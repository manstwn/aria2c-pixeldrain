const { spawn } = require('child_process');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const pixeldrain = require('./pixeldrain');
require('dotenv').config();

const ARIA2_RPC_URL = process.env.ARIA2_RPC_URL || 'http://127.0.0.1:6800/jsonrpc';
const ARIA2_RPC_SECRET = process.env.ARIA2_RPC_SECRET || '';
const AUTO_START_ARIA2 = process.env.AUTO_START_ARIA2 !== 'false'; // default true
const ARIA2_PATH_ENV = process.env.ARIA2_PATH || '';

// Track GIDs that are currently being processed or uploaded
const activeUploads = new Map(); // gid -> { filename, status, error, record }
const processedGids = new Set();
const taskSourceUrls = new Map(); // gid -> url

let rpcRequestId = 1;
let aria2Process = null;
let rpcErrorLogged = false;
let isStartingAria2 = false;

/**
 * Locate aria2c executable on local machine or system PATH
 */
function findAria2Executable() {
  const candidatePaths = [
    ARIA2_PATH_ENV,
    'C:\\Program Portable\\aria2c\\aria2c.exe',
    'C:\\aria2\\aria2c.exe',
    'aria2c'
  ];

  for (const candidate of candidatePaths) {
    if (!candidate) continue;
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback to system command 'aria2c'
  return 'aria2c';
}

/**
 * Extract port number from ARIA2_RPC_URL
 */
function getRpcPort() {
  try {
    const url = new URL(ARIA2_RPC_URL);
    return url.port || '6800';
  } catch (err) {
    return '6800';
  }
}

/**
 * Auto-spawn aria2c background daemon if RPC connection is missing
 */
function ensureAria2Daemon() {
  if (!AUTO_START_ARIA2 || isStartingAria2 || aria2Process) return;

  const executable = findAria2Executable();
  const port = getRpcPort();
  const downloadsDir = path.resolve(db.DOWNLOADS_DIR);

  const args = [
    '--enable-rpc',
    `--rpc-listen-port=${port}`,
    '--rpc-listen-all=false',
    `--dir=${downloadsDir}`,
    '--max-concurrent-downloads=1',
    '--max-connection-per-server=16',
    '--split=16',
    '--disable-ipv6=true',
    '--quiet=true'
  ];

  if (ARIA2_RPC_SECRET) {
    args.push(`--rpc-secret=${ARIA2_RPC_SECRET}`);
  }

  console.log(`[Aria2] Attempting to auto-start aria2c daemon (${executable} --rpc-listen-port=${port})...`);
  isStartingAria2 = true;

  try {
    aria2Process = spawn(executable, args, {
      windowsHide: true,
      stdio: 'ignore'
    });

    aria2Process.on('error', (err) => {
      console.warn(`[Aria2] Failed to auto-start aria2c process (${executable}): ${err.message}`);
      aria2Process = null;
      isStartingAria2 = false;
    });

    aria2Process.on('exit', (code) => {
      if (code !== null && code !== 0) {
        console.warn(`[Aria2] aria2c process exited with code ${code}`);
      }
      aria2Process = null;
      isStartingAria2 = false;
    });

    // Give it 1 second to bind
    setTimeout(() => {
      isStartingAria2 = false;
    }, 1000);

  } catch (err) {
    console.warn(`[Aria2] Exception starting aria2c process: ${err.message}`);
    isStartingAria2 = false;
  }
}

// Clean up child process on Node exit
process.on('exit', () => {
  if (aria2Process) {
    try { aria2Process.kill(); } catch (e) {}
  }
});
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());

/**
 * Make JSON-RPC call to aria2c daemon
 */
async function rpcCall(method, params = []) {
  const fullParams = ARIA2_RPC_SECRET ? [`token:${ARIA2_RPC_SECRET}`, ...params] : params;

  const payload = {
    jsonrpc: '2.0',
    id: `gotouch_${rpcRequestId++}`,
    method,
    params: fullParams
  };

  const response = await axios.post(ARIA2_RPC_URL, payload, { timeout: 5000 });
  if (response.data.error) {
    throw new Error(`Aria2 RPC Error [${response.data.error.code}]: ${response.data.error.message}`);
  }
  return response.data.result;
}

/**
 * Test aria2 RPC connection
 */
async function checkConnection() {
  try {
    const version = await rpcCall('aria2.getVersion');
    if (rpcErrorLogged) {
      console.log('[Aria2] Connected to aria2c RPC daemon successfully!');
      rpcErrorLogged = false;
    }
    return { online: true, version: version.version };
  } catch (err) {
    ensureAria2Daemon();
    return { online: false, error: err.message };
  }
}

/**
 * Submit a URL download to aria2c with strict 16-connection parameters and optional custom output filename
 */
async function addDownload(url, customFilename = '') {
  if (!url || typeof url !== 'string') {
    throw new Error('Valid download URL is required.');
  }

  const options = {
    dir: path.resolve(db.DOWNLOADS_DIR),
    'max-concurrent-downloads': '1',
    'max-connection-per-server': '16',
    split: '16'
  };

  if (customFilename && typeof customFilename === 'string' && customFilename.trim().length > 0) {
    options.out = customFilename.trim();
  }

  const gid = await rpcCall('aria2.addUri', [[url.trim()], options]);
  taskSourceUrls.set(gid, { url: url.trim(), filename: customFilename ? customFilename.trim() : '' });
  console.log(`[Aria2] Download task created with GID ${gid} for URL: ${url} ${options.out ? `(Custom name: ${options.out})` : ''}`);
  return gid;
}

/**
 * Get status of all active and waiting downloads from aria2 RPC
 */
async function getDownloadsStatus() {
  try {
    const active = await rpcCall('aria2.tellActive') || [];
    const waiting = await rpcCall('aria2.tellWaiting', [0, 50]) || [];
    const stopped = await rpcCall('aria2.tellStopped', [0, 20]) || [];

    if (rpcErrorLogged) {
      console.log('[Aria2] Reconnected to aria2c RPC daemon successfully!');
      rpcErrorLogged = false;
    }

    const allTasks = [...active, ...waiting, ...stopped];

    const formattedTasks = allTasks.map(task => {
      const completedLength = parseInt(task.completedLength || '0', 10);
      const totalLength = parseInt(task.totalLength || '0', 10);
      const downloadSpeed = parseInt(task.downloadSpeed || '0', 10);
      const progress = totalLength > 0 ? parseFloat(((completedLength / totalLength) * 100).toFixed(1)) : 0;

      let filename = 'Unknown';
      if (task.files && task.files[0] && task.files[0].path) {
        filename = path.basename(task.files[0].path);
      }

      const uploadInfo = activeUploads.get(task.gid);

      return {
        gid: task.gid,
        filename,
        status: uploadInfo ? uploadInfo.status : task.status,
        progress,
        downloadSpeed,
        completedLength,
        totalLength,
        uploadProgress: uploadInfo ? (uploadInfo.uploadProgress || 0) : 0,
        uploadLoaded: uploadInfo ? (uploadInfo.uploadLoaded || 0) : 0,
        uploadTotal: uploadInfo ? (uploadInfo.uploadTotal || 0) : 0,
        uploadSpeed: uploadInfo ? (uploadInfo.uploadSpeed || 0) : 0,
        errorMessage: task.errorMessage || (uploadInfo ? uploadInfo.error : '')
      };
    });

    const aria2Gids = new Set(allTasks.map(t => t.gid));
    const queuedItems = db.getAllQueue();

    for (const qItem of queuedItems) {
      if (!qItem.gid || !aria2Gids.has(qItem.gid)) {
        formattedTasks.push({
          gid: qItem.id || qItem.gid,
          filename: qItem.filename || qItem.custom_name || (qItem.url ? path.basename(qItem.url.split('?')[0]) : 'Queued Item'),
          status: qItem.status || 'QUEUED',
          progress: 0,
          downloadSpeed: 0,
          completedLength: 0,
          totalLength: 0,
          uploadProgress: 0,
          uploadLoaded: 0,
          uploadTotal: 0,
          uploadSpeed: 0,
          errorMessage: ''
        });
      }
    }

    return formattedTasks;
  } catch (err) {
    if (!rpcErrorLogged) {
      console.warn(`[Aria2] RPC daemon unreachable (${err.message}). ${AUTO_START_ARIA2 ? 'Attempting auto-start...' : 'Please start aria2c.'}`);
      rpcErrorLogged = true;
    }
    ensureAria2Daemon();
    return [];
  }
}

/**
 * Helper to delete all local download files and .aria2 control files associated with a task
 */
async function cleanUpTaskFiles(gid, taskDetails = null) {
  try {
    let task = taskDetails;
    if (!task) {
      try {
        task = await rpcCall('aria2.tellStatus', [gid]);
      } catch (e) {}
    }

    if (task && task.files && Array.isArray(task.files)) {
      for (const file of task.files) {
        if (file.path) {
          const filePath = file.path;
          if (fs.existsSync(filePath)) {
            fs.rmSync(filePath, { recursive: true, force: true });
            console.log(`[Aria2 Cleanup] Removed downloaded file: ${filePath}`);
          }
          const controlFile = `${filePath}.aria2`;
          if (fs.existsSync(controlFile)) {
            fs.rmSync(controlFile, { force: true });
            console.log(`[Aria2 Cleanup] Removed control file: ${controlFile}`);
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[Aria2 Cleanup] Error removing files for GID ${gid}:`, err.message);
  }
}

/**
 * Poll aria2c stopped downloads to trigger Pixeldrain upload for completed tasks or clean up failed tasks
 */
async function pollCompletedDownloads() {
  try {
    const stopped = await rpcCall('aria2.tellStopped', [0, 50]) || [];
    for (const task of stopped) {
      if (task.status === 'complete' && !processedGids.has(task.gid)) {
        processedGids.add(task.gid);

        const filePath = task.files && task.files[0] && task.files[0].path;
        if (!filePath || !fs.existsSync(filePath)) {
          console.warn(`[Aria2] Download completed for GID ${task.gid} but file not found on disk.`);
          continue;
        }

        const filename = path.basename(filePath);
        const sourceData = taskSourceUrls.get(task.gid);
        const sourceUrlStr = typeof sourceData === 'string' ? sourceData : (sourceData && sourceData.url ? sourceData.url : '');
        console.log(`[Aria2] Task ${task.gid} completed downloading (${filename}). Triggering Pixeldrain upload...`);

        activeUploads.set(task.gid, {
          filename,
          status: 'UPLOADING',
          error: null,
          uploadProgress: 0,
          uploadLoaded: 0,
          uploadTotal: 0,
          uploadSpeed: 0
        });

        // Trigger asynchronous Pixeldrain upload pipeline
        pixeldrain.uploadToPixeldrain(filePath, filename, (progressData) => {
          const current = activeUploads.get(task.gid) || {};
          activeUploads.set(task.gid, {
            ...current,
            ...progressData,
            status: 'UPLOADING'
          });
        }, sourceUrlStr)
          .then(record => {
            activeUploads.set(task.gid, { filename, status: 'UPLOADED', record, uploadProgress: 100 });
            db.removeFromQueue(task.gid);
            setTimeout(() => {
              activeUploads.delete(task.gid);
              try { rpcCall('aria2.removeDownloadResult', [task.gid]); } catch (e) {}
              processNextQueueItem();
            }, 2000);
          })
          .catch(err => {
            console.error(`[Aria2] Pixeldrain upload failed for task ${task.gid}:`, err.message);
            activeUploads.set(task.gid, { filename, status: 'UPLOAD_FAILED', error: err.message });
            processNextQueueItem();
          });
      } else if (task.status === 'error' && !processedGids.has(task.gid)) {
        processedGids.add(task.gid);
        console.warn(`[Aria2] Task ${task.gid} failed with error (${task.errorMessage || 'unknown'}). Cleaning up temporary files...`);
        await cleanUpTaskFiles(task.gid, task);
        try {
          await rpcCall('aria2.removeDownloadResult', [task.gid]);
        } catch (e) {}
        processNextQueueItem();
      }
    }

    // Process next queued task if pipeline is free
    processNextQueueItem();
  } catch (err) {
    // Suppress polling errors when RPC is down
  }
}

let isProcessingQueue = false;

/**
 * Strict Serial Queue Processor:
 * Ensures only 1 task downloads AND uploads completely before starting the next task!
 */
async function processNextQueueItem() {
  if (isProcessingQueue) return;

  try {
    isProcessingQueue = true;

    // 1. Check active downloads in Aria2 RPC
    let activeTasks = [];
    try {
      activeTasks = await rpcCall('aria2.tellActive') || [];
    } catch (e) {}

    const hasActiveDownload = activeTasks.length > 0;

    // 2. Check active uploads in memory map
    let hasActiveUpload = false;
    for (const [gid, upload] of activeUploads.entries()) {
      if (upload && upload.status === 'UPLOADING') {
        hasActiveUpload = true;
        break;
      }
    }

    // Strict Pipeline Lock: If downloading OR uploading, DO NOT start next task!
    if (hasActiveDownload || hasActiveUpload) {
      return;
    }

    // 3. Find next QUEUED item in data/queue.json
    const queue = db.getAllQueue();
    const nextItem = queue.find(q => q.status === 'QUEUED');
    if (!nextItem) return;

    console.log(`[Queue Engine] Pipeline clear. Launching next queued download: "${nextItem.filename}" (${nextItem.url})`);

    // Mark status as DOWNLOADING in queue.json
    db.updateQueueItem(nextItem.id, { status: 'DOWNLOADING' });

    // Submit to Aria2 RPC
    const gid = await addDownload(nextItem.url, nextItem.custom_name);
    if (gid) {
      db.updateQueueItem(nextItem.id, { gid, status: 'DOWNLOADING' });
    }
  } catch (err) {
    console.error('[Queue Engine] Error launching next queue item:', err.message);
  } finally {
    isProcessingQueue = false;
  }
}

// Start continuous background status monitoring every 3 seconds
let monitorInterval = null;
function startMonitor() {
  if (!monitorInterval) {
    monitorInterval = setInterval(pollCompletedDownloads, 3000);
  }
}

/**
 * Cancel/remove a download task by GID and clean up disk files
 */
async function removeDownload(gid) {
  if (!gid) throw new Error('Valid GID is required.');

  // If this is a persistent queue-only ID (not yet submitted to Aria2 RPC),
  // just delete it from queue.json directly without touching Aria2 at all.
  if (typeof gid === 'string' && gid.startsWith('q_')) {
    const removed = db.removeFromQueue(gid);
    if (removed) {
      console.log(`[Queue Engine] Queued item ${gid} removed from queue before starting.`);
    }
    return true;
  }

  try {
    let task = null;
    try {
      task = await rpcCall('aria2.tellStatus', [gid]);
    } catch (e) {}

    try {
      await rpcCall('aria2.remove', [gid]);
    } catch (e1) {
      try {
        await rpcCall('aria2.forceRemove', [gid]);
      } catch (e2) {
        try { await rpcCall('aria2.removeDownloadResult', [gid]); } catch (e3) {}
      }
    }

    // Clean up local download file and .aria2 control file
    await cleanUpTaskFiles(gid, task);

    db.removeFromQueue(gid);
    activeUploads.delete(gid);
    processedGids.add(gid);
    console.log(`[Aria2] Download task GID ${gid} cancelled and local files deleted.`);
    return true;
  } catch (err) {
    db.removeFromQueue(gid);
    console.error(`[Aria2] Failed to remove download task GID ${gid}:`, err.message);
    throw err;
  }
}

/**
 * Pause all queued downloads in Aria2
 */
async function pauseAll() {
  try {
    await rpcCall('aria2.pauseAll');
    return true;
  } catch (err) {
    console.error('[Aria2] Failed to pause all tasks:', err.message);
    throw err;
  }
}

/**
 * Unpause/resume all queued downloads in Aria2
 */
async function unpauseAll() {
  try {
    await rpcCall('aria2.unpauseAll');
    return true;
  } catch (err) {
    console.error('[Aria2] Failed to unpause all tasks:', err.message);
    throw err;
  }
}

/**
 * Pause a single task by GID
 */
async function pauseTask(gid) {
  try {
    await rpcCall('aria2.pause', [gid]);
    return true;
  } catch (err) {
    console.error(`[Aria2] Failed to pause task ${gid}:`, err.message);
    throw err;
  }
}

/**
 * Unpause/resume a single task by GID
 */
async function unpauseTask(gid) {
  try {
    await rpcCall('aria2.unpause', [gid]);
    return true;
  } catch (err) {
    console.error(`[Aria2] Failed to unpause task ${gid}:`, err.message);
    throw err;
  }
}

module.exports = {
  checkConnection,
  addDownload,
  removeDownload,
  getDownloadsStatus,
  pauseAll,
  unpauseAll,
  pauseTask,
  unpauseTask,
  processNextQueueItem,
  startMonitor
};
