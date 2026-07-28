const { spawn } = require('child_process');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const pixeldrain = require('./pixeldrain');
const ytdlp = require('./ytdlp');
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
        stageMessage: uploadInfo ? (uploadInfo.stageMessage || '') : '',
        errorMessage: task.errorMessage || (uploadInfo ? uploadInfo.error : '')
      };
    });

    const ytdlpTasks = ytdlp.getDownloadsStatus();
    formattedTasks.push(...ytdlpTasks);

    const activeGids = new Set([
      ...allTasks.map(t => t.gid),
      ...ytdlpTasks.map(t => t.gid)
    ]);
    const queuedItems = db.getAllQueue();

    for (const qItem of queuedItems) {
      const qId = qItem.id || qItem.gid;
      if (!qId || !activeGids.has(qId)) {
        formattedTasks.push({
          gid: qId,
          filename: qItem.filename || qItem.custom_name || (qItem.url ? path.basename(qItem.url.split('?')[0]) : 'Queued Item'),
          engine: qItem.engine || 'aria2',
          status: qItem.status || 'QUEUED',
          progress: 0,
          downloadSpeed: 0,
          completedLength: 0,
          totalLength: 0,
          uploadProgress: 0,
          uploadLoaded: 0,
          uploadTotal: 0,
          uploadSpeed: 0,
          errorMessage: qItem.error || ''
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
          db.removeFromQueue(task.gid);
          continue;
        }

        const filename = path.basename(filePath);
        const sourceData = taskSourceUrls.get(task.gid);
        const sourceUrlStr = typeof sourceData === 'string' ? sourceData : (sourceData && sourceData.url ? sourceData.url : '');
        console.log(`[Aria2] Task ${task.gid} completed downloading (${filename}). Starting serial pipeline (Upload -> Thumbnails -> Cleanup)...`);

        activeUploads.set(task.gid, {
          filename,
          status: 'UPLOADING',
          error: null,
          uploadProgress: 0,
          uploadLoaded: 0,
          uploadTotal: 0,
          uploadSpeed: 0
        });

        const queuedItems = db.getAllQueue();
        const qItem = queuedItems.find(q => q.gid === task.gid);
        if (qItem) {
          db.updateQueueItem(qItem.id, { status: 'UPLOADING' });
        }

        // Trigger Pixeldrain upload -> thumbnail generation -> metadata -> local file cleanup
        pixeldrain.uploadToPixeldrain(filePath, filename, (progressData) => {
          const current = activeUploads.get(task.gid) || {};
          const newStatus = progressData.status || current.status || 'UPLOADING';
          activeUploads.set(task.gid, {
            ...current,
            ...progressData,
            status: newStatus
          });
          if (qItem && progressData.status) {
            db.updateQueueItem(qItem.id, { status: progressData.status });
          }
        }, sourceUrlStr)
          .then(record => {
            console.log(`[Aria2 Pipeline] ✅ Task ${task.gid} 100% finished (Download -> Upload -> Thumbnails -> Cleanup).`);
            activeUploads.set(task.gid, { filename, status: 'UPLOADED', record, uploadProgress: 100 });
            db.removeFromQueue(task.gid);
            activeUploads.delete(task.gid);
            try { rpcCall('aria2.removeDownloadResult', [task.gid]); } catch (e) {}
            // ONLY NOW launch the next queue item after disk cleanup!
            processNextQueueItem();
          })
          .catch(err => {
            console.error(`[Aria2 Pipeline] ❌ Upload/Processing failed for task ${task.gid}:`, err.message);
            activeUploads.set(task.gid, { filename, status: 'UPLOAD_FAILED', error: err.message });
            db.removeFromQueue(task.gid);
            activeUploads.delete(task.gid);
            try { rpcCall('aria2.removeDownloadResult', [task.gid]); } catch (e) {}
            processNextQueueItem();
          });
      } else if (task.status === 'error' && !processedGids.has(task.gid)) {
        processedGids.add(task.gid);
        console.warn(`[Aria2] Task ${task.gid} failed with error (${task.errorMessage || 'Invalid URL or download error'}). Cleaning up temporary files...`);
        await cleanUpTaskFiles(task.gid, task);
        
        const queuedItems = db.getAllQueue();
        const qItem = queuedItems.find(q => q.gid === task.gid);
        if (qItem) {
          db.updateQueueItem(qItem.id, {
            status: 'PAUSED',
            gid: '',
            error: task.errorMessage || 'Download failed (e.g. invalid URL or network error).'
          });
        }
        
        try {
          await rpcCall('aria2.removeDownloadResult', [task.gid]);
        } catch (e) {}

        processNextQueueItem();
      }
    }

    if (!isPipelineBusy()) {
      processNextQueueItem();
    }
  } catch (err) {
    ensureAria2Daemon();
  }
}

let isProcessingQueue = false;

function isPipelineBusy() {
  // 1. Check activeUploads map for any task currently downloading, uploading, or processing
  for (const [gid, upload] of activeUploads.entries()) {
    if (upload && (
      upload.status === 'DOWNLOADING' ||
      upload.status === 'UPLOADING' ||
      upload.status === 'PROCESSING' ||
      upload.status === 'CLEANING'
    )) {
      return true;
    }
  }

  // 2. Check yt-dlp active tasks
  const ytdlpTasks = ytdlp.getDownloadsStatus() || [];
  if (ytdlpTasks.some(t => t.status === 'DOWNLOADING' || t.status === 'UPLOADING' || t.status === 'PROCESSING')) {
    return true;
  }

  // 3. Check data/queue.json for any items currently downloading, uploading, or processing
  const queue = db.getAllQueue();
  if (queue.some(q => q.status === 'DOWNLOADING' || q.status === 'UPLOADING' || q.status === 'PROCESSING')) {
    return true;
  }

  return false;
}

/**
 * Strict Serial Queue Processor:
 * Ensures only 1 task downloads, uploads, extracts metadata, generates thumbnails, and cleans up before starting the next task!
 */
async function processNextQueueItem() {
  if (isProcessingQueue) return;

  let nextItem = null;

  try {
    isProcessingQueue = true;

    // 1. Check if pipeline is busy anywhere (Download, Upload, Thumbnails, Cleanup)
    if (isPipelineBusy()) {
      return;
    }

    // 2. Double-check Aria2 RPC active downloads
    let activeTasks = [];
    try {
      activeTasks = await rpcCall('aria2.tellActive') || [];
    } catch (e) {}

    if (activeTasks.length > 0) {
      return;
    }

    // 3. Find next QUEUED item in data/queue.json
    const queue = db.getAllQueue();
    nextItem = queue.find(q => q.status === 'QUEUED');
    if (!nextItem) return;

    console.log(`[Queue Engine] 🚀 Pipeline 100% clear. Launching next queued download (${nextItem.engine || 'aria2'}): "${nextItem.filename || nextItem.custom_name}" (${nextItem.url})`);

    if (nextItem.engine === 'ytdlp') {
      db.updateQueueItem(nextItem.id, { status: 'DOWNLOADING' });
      ytdlp.startDownload(nextItem, () => {
        processNextQueueItem();
      }, (err) => {
        db.updateQueueItem(nextItem.id, { status: 'PAUSED', error: err.message || 'yt-dlp download failed' });
        processNextQueueItem();
      });
    } else {
      // Submit to Aria2 RPC
      const gid = await addDownload(nextItem.url, nextItem.custom_name);
      if (gid) {
        db.updateQueueItem(nextItem.id, { gid, status: 'DOWNLOADING' });
      }
    }
  } catch (err) {
    console.error('[Queue Engine] Error launching next queue item:', err.message);
    if (nextItem) {
      db.updateQueueItem(nextItem.id, { status: 'QUEUED', error: err.message || 'Failed to start' });
    }
  } finally {
    isProcessingQueue = false;
  }
}

/**
 * Helper to delete all local download files, partial files (.part, .ytdl), and .aria2 control files associated with a task
 */
async function cleanUpTaskFiles(gid, taskDetails = null) {
  try {
    const downloadsDir = path.resolve(db.DOWNLOADS_DIR);
    if (!fs.existsSync(downloadsDir)) return;

    const targetKeywords = [gid];

    if (taskDetails && taskDetails.files) {
      for (const file of taskDetails.files) {
        if (file.path) {
          const fn = path.basename(file.path);
          targetKeywords.push(fn);
          targetKeywords.push(fn.split('.')[0]);
          if (fs.existsSync(file.path)) {
            try { fs.rmSync(file.path, { recursive: true, force: true }); } catch (e) {}
          }
        }
      }
    }

    const filesInDir = fs.readdirSync(downloadsDir);
    for (const f of filesInDir) {
      const fullP = path.join(downloadsDir, f);
      const isMatch = targetKeywords.some(kw => kw && kw.length > 2 && f.includes(kw));

      if (isMatch) {
        try {
          fs.rmSync(fullP, { recursive: true, force: true });
          console.log(`[Disk Cleanup] Wiped temp download file: ${fullP}`);
        } catch (e) {}
      }
    }
  } catch (err) {
    console.warn(`[Disk Cleanup Warning] Error cleaning up download files for GID ${gid}:`, err.message);
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
 * Cancel/remove a download task by GID and clean up disk files immediately at ANY stage
 */
async function removeDownload(gid) {
  if (!gid) throw new Error('Valid GID is required.');

  // 1. Check if an active upload stream exists in activeUploads map and abort it
  const activeUpload = activeUploads.get(gid);
  if (activeUpload) {
    if (activeUpload.uploadTaskPromise && activeUpload.uploadTaskPromise.abort) {
      try { activeUpload.uploadTaskPromise.abort(); } catch (e) {}
    }
    cleanUpTaskFiles(gid, null);
    activeUploads.delete(gid);
  }

  // 2. If this is an active yt-dlp task
  if (ytdlp.activeTasks.has(gid)) {
    ytdlp.removeDownload(gid);
    db.removeFromQueue(gid);
    console.log(`[yt-dlp] Download task ${gid} cancelled & disk files wiped.`);
    setTimeout(() => processNextQueueItem(), 300);
    return true;
  }

  // 3. If this is a persistent queue-only ID
  if (typeof gid === 'string' && gid.startsWith('q_')) {
    const queue = db.getAllQueue();
    const qItem = queue.find(q => q.id === gid);
    if (qItem && qItem.filename) {
      cleanUpTaskFiles(gid, { files: [{ path: path.join(db.DOWNLOADS_DIR, qItem.filename) }] });
    }
    db.removeFromQueue(gid);
    console.log(`[Queue Engine] Queued item ${gid} removed from queue & disk wiped.`);
    setTimeout(() => processNextQueueItem(), 300);
    return true;
  }

  // 4. Active Aria2 RPC task
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

    // Clean up local download files, partial files (.part, .ytdl), and .aria2 control files
    await cleanUpTaskFiles(gid, task);

    db.removeFromQueue(gid);
    activeUploads.delete(gid);
    processedGids.add(gid);
    console.log(`[Aria2] Download task GID ${gid} cancelled and local files deleted.`);
    setTimeout(() => processNextQueueItem(), 300);
    return true;
  } catch (err) {
    db.removeFromQueue(gid);
    cleanUpTaskFiles(gid, null);
    console.error(`[Aria2] Failed to remove download task GID ${gid}:`, err.message);
    setTimeout(() => processNextQueueItem(), 300);
    return true;
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

/**
 * Force stop and purge all active, waiting, and stopped downloads from Aria2 daemon,
 * then wipe local cache files from disk.
 */
async function wipeAllAria2Tasks() {
  let rpcReachable = true;

  try {
    // 1. Force purge active tasks
    try {
      const active = await rpcCall('aria2.tellActive') || [];
      for (const task of active) {
        try { await rpcCall('aria2.forceRemove', [task.gid]); } catch (e) {}
      }
    } catch (e) {
      rpcReachable = false;
    }

    // 2. Force purge waiting tasks
    if (rpcReachable) {
      try {
        const waiting = await rpcCall('aria2.tellWaiting', [0, 100]) || [];
        for (const task of waiting) {
          try { await rpcCall('aria2.forceRemove', [task.gid]); } catch (e) {}
        }
      } catch (e) {
        rpcReachable = false;
      }
    }

    // 3. Purge stopped/completed results from aria2 memory
    if (rpcReachable) {
      try {
        await rpcCall('aria2.purgeDownloadResult');
      } catch (e) {
        rpcReachable = false;
      }
    }

    if (rpcReachable) {
      console.log('[Aria2] All active and waiting tasks purged from Aria2 RPC daemon.');
    }
  } catch (err) {
    rpcReachable = false;
    console.warn(`[Aria2] Error purging Aria2 tasks on startup: ${err.message}`);
  }

  // 4. Only delete download files if RPC was reachable and purge succeeded,
  //    otherwise completed tasks still in aria2 would report missing files.
  if (rpcReachable) {
    const downloadsDir = path.resolve(db.DOWNLOADS_DIR);
    if (fs.existsSync(downloadsDir)) {
      try {
        const files = fs.readdirSync(downloadsDir);
        for (const file of files) {
          const curPath = path.join(downloadsDir, file);
          fs.rmSync(curPath, { recursive: true, force: true });
        }
        console.log(`[Startup Cleanup] Wiped all cached download files in ${downloadsDir}`);
      } catch (e) {
        console.warn(`[Startup Cleanup] Failed to wipe cache files: ${e.message}`);
      }
    }
  } else {
    console.log('[Startup Cleanup] Skipped file cleanup: RPC daemon unreachable, preserving completed task files.');
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
  startMonitor,
  wipeAllAria2Tasks
};
