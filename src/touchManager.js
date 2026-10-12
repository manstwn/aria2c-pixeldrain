const axios = require('axios');
const cron = require('node-cron');
const db = require('./db');
const logger = require('./logger');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Global Touch Engine State
let activeHttpStream = null;
const touchState = {
  isRunning: false,
  isAborted: false,
  mode: 'idle', // 'idle' | 'batch' | 'single'
  startedAt: null,
  completedAt: null,
  totalEligible: 0,
  currentIndex: 0,
  touchedCount: 0,
  deadCount: 0,
  skippedCount: 0,
  errorCount: 0,
  currentFile: null,
  recentLogs: []
};

function addTouchLog(message, type = 'info') {
  const entry = {
    time: new Date().toISOString(),
    message,
    type
  };
  touchState.recentLogs.unshift(entry);
  if (touchState.recentLogs.length > 60) {
    touchState.recentLogs.pop();
  }
  if (type === 'error') console.error(`[TouchManager] ${message}`);
  else if (type === 'warn') console.warn(`[TouchManager] ${message}`);
  else console.log(`[TouchManager] ${message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractSourceUrl(file) {
  if (!file) return '';
  let raw = file.source_url || (file.metadata && file.metadata.source_url) || '';
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    return raw.url || raw.source_url || '';
  }
  return '';
}

function getTouchIntervalDays() {
  const days = parseInt(process.env.TOUCH_INTERVAL_DAYS, 10);
  return (!isNaN(days) && days > 0) ? days : 30;
}

/**
 * Perform 15% chunk download on a single Pixeldrain record to reset 60-day expiry timer.
 * @param {object} file File record object from database
 * @param {object} options Optional settings
 * @param {boolean} internal True if called from touchAllFiles batch loop
 */
async function touchFileRecord(file, options = {}, internal = false) {
  if (!file || (!file.download_url && !file.pixeldrain_id)) {
    addTouchLog(`Skipping invalid record: ${JSON.stringify(file)}`, 'warn');
    return { success: false, status: 'INVALID', file };
  }

  // Mutex: Reject parallel calls when daemon is already busy
  if (!internal && touchState.isRunning) {
    addTouchLog(`⚠️ Rejected manual touch for "${file.filename || file.id}": Touch daemon is currently busy.`, 'warn');
    return { success: false, status: 'BUSY', error: 'Another touch operation is already running. Please wait.' };
  }

  let singleLockAcquired = false;
  if (!internal) {
    touchState.isRunning = true;
    touchState.isAborted = false;
    touchState.mode = 'single';
    touchState.startedAt = new Date().toISOString();
    touchState.currentIndex = 1;
    touchState.totalEligible = 1;
    singleLockAcquired = true;
  }

  const filename = file.filename || file.original_filename || 'file';
  const pageUrl = file.download_url || `https://pixeldrain.com/u/${file.pixeldrain_id}`;
  const directFileUrl = `https://pixeldrain.com/api/file/${file.pixeldrain_id}`;

  try {
    if (touchState.isAborted) {
      addTouchLog(`Touch aborted before starting ${filename}`, 'warn');
      return { success: false, status: 'ABORTED', file };
    }

    let fileSize = file.metadata && file.metadata.size_bytes ? file.metadata.size_bytes : 0;
    if (!fileSize && file.pixeldrain_id) {
      try {
        const infoRes = await axios.get(`https://pixeldrain.com/api/file/${file.pixeldrain_id}/info`, { timeout: 10000 });
        if (infoRes.data && infoRes.data.size) {
          fileSize = infoRes.data.size;
        }
      } catch (e) {
        if (e.response && e.response.status === 404) {
          const updated = db.updateFile(file.id, { status: 'DEAD' });
          addTouchLog(`❌ Touch FAILED (404 Not Found) for "${filename}". Marked DEAD.`, 'error');
          return { success: false, status: 'DEAD', file: updated };
        }
      }
    }

    const targetBytes = fileSize > 0 ? Math.ceil(fileSize * 0.15) : 1024;
    const rangeHeader = fileSize > 0 ? `bytes=0-${targetBytes - 1}` : 'bytes=0-1024';
    const targetMB = (targetBytes / (1024 * 1024)).toFixed(1);
    const totalMB = (fileSize / (1024 * 1024)).toFixed(1);

    // Dynamic timeout: ~300 KB/s worst-case rate limit + 60s base
    const timeoutMs = Math.max(60000, Math.ceil((targetBytes / 300000) * 1000));

    touchState.currentFile = {
      id: file.id,
      filename: filename,
      pixeldrain_id: file.pixeldrain_id,
      page_url: pageUrl,
      direct_url: directFileUrl,
      total_bytes: fileSize,
      total_formatted: `${totalMB} MB`,
      target_bytes: targetBytes,
      target_formatted: `${targetMB} MB`,
      downloaded_bytes: 0,
      percent: 0,
      speed_bytes: 0,
      speed_formatted: '0 MB/s',
      eta_seconds: 0
    };

    addTouchLog(`⚡ Touching "${filename}" (15% chunk = ${targetMB} MB / ${totalMB} MB total)...`, 'info');

    const headers = {
      'User-Agent': USER_AGENT,
      'Accept': '*/*',
      'Range': rangeHeader
    };
    const token = (process.env.PIXELDRAIN_API_TOKEN || '').trim();
    if (token) {
      headers['Authorization'] = `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
    }

    const response = await axios.get(directFileUrl, {
      headers,
      timeout: timeoutMs,
      responseType: 'stream',
      validateStatus: s => s < 500
    });

    if (response.status === 404) {
      const updated = db.updateFile(file.id, { status: 'DEAD' });
      addTouchLog(`❌ 404 Not Found for "${filename}" (ID: ${file.pixeldrain_id}). Marked DEAD.`, 'error');
      return { success: false, status: 'DEAD', file: updated };
    }

    // Rate-limit handling: 403 / 429
    if ((response.status === 403 || response.status === 429) && !options.retried) {
      addTouchLog(`⚠️ HTTP ${response.status} rate-limited for "${filename}". Backing off 5s before retry...`, 'warn');
      await sleep(5000);
      return touchFileRecord(file, { ...options, retried: true }, internal);
    }

    if (response.status !== 200 && response.status !== 206) {
      addTouchLog(`⚠️ HTTP ${response.status} for "${filename}". Status untouched.`, 'warn');
      return { success: false, status: file.status, file };
    }

    activeHttpStream = response.data;
    let downloadedBytes = 0;
    let lastLoaded = 0;
    let lastTime = Date.now();
    const startTime = Date.now();

    await new Promise((resolve, reject) => {
      response.data.on('data', chunk => {
        if (touchState.isAborted) {
          try { response.data.destroy(); } catch (e) {}
          return reject(new Error('Touch aborted by user.'));
        }

        downloadedBytes += chunk.length;
        const now = Date.now();
        const diffSec = (now - lastTime) / 1000;

        if (diffSec >= 0.25 || downloadedBytes >= targetBytes) {
          const currentSpeed = diffSec > 0 ? (downloadedBytes - lastLoaded) / diffSec : 0;
          lastLoaded = downloadedBytes;
          lastTime = now;

          const pct = targetBytes > 0 ? Math.min(100, parseFloat(((downloadedBytes / targetBytes) * 100).toFixed(1))) : 0;
          const remainingBytes = Math.max(0, targetBytes - downloadedBytes);
          const etaSec = currentSpeed > 0 ? Math.ceil(remainingBytes / currentSpeed) : 0;
          const speedMB = (currentSpeed / (1024 * 1024)).toFixed(2);

          if (touchState.currentFile) {
            touchState.currentFile.downloaded_bytes = downloadedBytes;
            touchState.currentFile.percent = pct;
            touchState.currentFile.speed_bytes = currentSpeed;
            touchState.currentFile.speed_formatted = `${speedMB} MB/s`;
            touchState.currentFile.eta_seconds = etaSec;
          }
        }
      });

      response.data.on('end', resolve);
      response.data.on('error', err => {
        if (touchState.isAborted) return reject(new Error('Touch aborted by user.'));
        reject(err);
      });
    });

    activeHttpStream = null;

    // Verify transferred bytes actually exceeded the required 10% threshold
    const minRequiredBytes = fileSize > 0 ? Math.floor(fileSize * 0.10) : 512;
    if (downloadedBytes < minRequiredBytes && !touchState.isAborted) {
      throw new Error(`Incomplete download: stream closed after ${(downloadedBytes / (1024 * 1024)).toFixed(1)} MB (less than 10% threshold of ${(minRequiredBytes / (1024 * 1024)).toFixed(1)} MB)`);
    }

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
    const updated = db.updateFile(file.id, {
      last_touched: new Date().toISOString(),
      status: 'LIVE'
    });

    const actualDrainedMB = (downloadedBytes / (1024 * 1024)).toFixed(1);
    addTouchLog(`✅ Touch successful for "${filename}" (${actualDrainedMB} MB in ${durationSec}s). Timer reset +60 days!`, 'success');
    return { success: true, status: 'LIVE', file: updated };

  } catch (err) {
    activeHttpStream = null;

    if (touchState.isAborted) {
      addTouchLog(`🛑 Touch cancelled for "${filename}".`, 'warn');
      return { success: false, status: 'ABORTED', file };
    }

    addTouchLog(`⚠️ Touch error for "${filename}": ${err.message}`, 'error');
    return { success: false, status: file.status, file };
  } finally {
    if (singleLockAcquired) {
      touchState.isRunning = false;
      touchState.completedAt = new Date().toISOString();
      touchState.currentFile = null;
      activeHttpStream = null;
    }
  }
}

/**
 * Filter all records that require touching
 */
function getEligibleFiles(force = false, fileIds = null) {
  const files = db.getAllFiles();
  const now = Date.now();
  const touchIntervalDays = getTouchIntervalDays();
  const intervalMs = touchIntervalDays * 24 * 60 * 60 * 1000;

  if (Array.isArray(fileIds) && fileIds.length > 0) {
    const idSet = new Set(fileIds);
    return files.filter(file => idSet.has(file.id) && file.status !== 'DEAD');
  }

  return files.filter(file => {
    if (file.status === 'DEAD') return false;
    if (force) return true;

    const lastTouchStr = file.last_touched || file.created_at;
    const lastTouchTime = lastTouchStr ? new Date(lastTouchStr).getTime() : 0;
    const ageMs = now - lastTouchTime;
    return ageMs >= intervalMs;
  });
}

/**
 * Touch all eligible files sequentially.
 * @param {boolean|object} options - If boolean: force flag. If object: { force, fileIds }
 */
async function touchAllFiles(options = false) {
  let force = false;
  let fileIds = null;
  if (typeof options === 'boolean') {
    force = options;
  } else if (options && typeof options === 'object') {
    force = Boolean(options.force);
    if (Array.isArray(options.fileIds)) {
      fileIds = options.fileIds;
    }
  }

  if (touchState.isRunning) {
    addTouchLog('Touch batch is already running. Cannot start another.', 'warn');
    return {
      alreadyRunning: true,
      touchedCount: touchState.touchedCount,
      deadCount: touchState.deadCount,
      total: touchState.totalEligible
    };
  }

  const eligibleFiles = getEligibleFiles(force, fileIds);
  const totalFiles = fileIds ? eligibleFiles.length : db.getAllFiles().length;
  const touchIntervalDays = getTouchIntervalDays();

  touchState.isRunning = true;
  touchState.isAborted = false;
  touchState.mode = fileIds ? 'selected' : 'batch';
  touchState.startedAt = new Date().toISOString();
  touchState.completedAt = null;
  touchState.totalEligible = eligibleFiles.length;
  touchState.currentIndex = 0;
  touchState.touchedCount = 0;
  touchState.deadCount = 0;
  touchState.errorCount = 0;
  touchState.skippedCount = totalFiles - eligibleFiles.length;

  if (fileIds) {
    addTouchLog(`🚀 Starting bulk touch for ${eligibleFiles.length} selected file(s).`, 'info');
  } else {
    addTouchLog(`🚀 Starting touch batch: ${eligibleFiles.length} file(s) eligible (${touchIntervalDays}+ days since touch) out of ${totalFiles} total.`, 'info');
  }

  if (eligibleFiles.length === 0) {
    touchState.isRunning = false;
    touchState.completedAt = new Date().toISOString();
    if (fileIds) {
      addTouchLog('No live files found among selected records.', 'warn');
    } else {
      addTouchLog(`All files have been touched within the last ${touchIntervalDays} days. Nothing to do today.`, 'info');
    }
    return { touchedCount: 0, deadCount: 0, total: totalFiles, skipped: totalFiles };
  }

  try {
    for (let i = 0; i < eligibleFiles.length; i++) {
      if (touchState.isAborted) {
        addTouchLog(`🛑 Touch batch stopped by user after ${i} item(s).`, 'warn');
        break;
      }

      touchState.currentIndex = i + 1;
      const file = eligibleFiles[i];

      const result = await touchFileRecord(file, {}, true);
      if (result && result.success) {
        touchState.touchedCount++;
      } else if (result && result.status === 'DEAD') {
        touchState.deadCount++;
      } else if (!touchState.isAborted) {
        touchState.errorCount++;
      }

      if (i < eligibleFiles.length - 1 && !touchState.isAborted) {
        const delay = Math.floor(Math.random() * 1500) + 3500;
        await sleep(delay);
      }
    }
  } finally {
    touchState.isRunning = false;
    touchState.completedAt = new Date().toISOString();
    touchState.currentFile = null;
    activeHttpStream = null;

    addTouchLog(`🏁 Touch batch complete! Touched: ${touchState.touchedCount} | Dead: ${touchState.deadCount} | Errors: ${touchState.errorCount}`, 'info');
  }

  return {
    touchedCount: touchState.touchedCount,
    deadCount: touchState.deadCount,
    errorCount: touchState.errorCount,
    total: totalFiles,
    skipped: touchState.skippedCount
  };
}

/**
 * Start touch batch asynchronously in background without blocking the caller.
 * @param {boolean|object} options - If boolean: force flag. If object: { force, fileIds }
 */
function startTouchAll(options = false) {
  if (touchState.isRunning) {
    return {
      success: false,
      message: 'Touch batch is already running.',
      status: getTouchStatus()
    };
  }

  // Fire and forget
  touchAllFiles(options).catch(err => {
    addTouchLog(`Touch batch error: ${err.message}`, 'error');
  });

  return {
    success: true,
    message: 'Touch batch started in background.',
    status: getTouchStatus()
  };
}

/**
 * Abort active touch process immediately
 */
function stopTouch() {
  if (!touchState.isRunning) {
    return { success: false, message: 'No touch job is currently running.' };
  }

  touchState.isAborted = true;
  if (activeHttpStream && typeof activeHttpStream.destroy === 'function') {
    try {
      activeHttpStream.destroy();
    } catch (e) {}
  }

  addTouchLog('Touch cancellation requested by user.', 'warn');
  return { success: true, message: 'Touch cancellation requested.' };
}

/**
 * Get comprehensive touch engine status
 */
function getTouchStatus() {
  const allFiles = db.getAllFiles();
  const touchIntervalDays = getTouchIntervalDays();
  const now = Date.now();
  const intervalMs = touchIntervalDays * 24 * 60 * 60 * 1000;

  const dueFiles = allFiles.filter(f => {
    if (f.status === 'DEAD') return false;
    const lastTouchStr = f.last_touched || f.created_at;
    const ageMs = now - (lastTouchStr ? new Date(lastTouchStr).getTime() : 0);
    return ageMs >= intervalMs;
  });

  const deadFiles = allFiles.filter(f => f.status === 'DEAD');
  const liveFiles = allFiles.filter(f => f.status === 'LIVE');

  return {
    isRunning: touchState.isRunning,
    isAborted: touchState.isAborted,
    mode: touchState.mode,
    startedAt: touchState.startedAt,
    completedAt: touchState.completedAt,
    totalEligible: touchState.totalEligible,
    currentIndex: touchState.currentIndex,
    touchedCount: touchState.touchedCount,
    deadCount: touchState.deadCount,
    errorCount: touchState.errorCount,
    skippedCount: touchState.skippedCount,
    currentFile: touchState.currentFile,
    recentLogs: touchState.recentLogs.slice(0, 40),
    metrics: {
      totalFiles: allFiles.length,
      liveCount: liveFiles.length,
      deadCount: deadFiles.length,
      dueCount: dueFiles.length,
      intervalDays: touchIntervalDays
    }
  };
}

/**
 * Initialize daily cron scheduler (Runs every day at midnight 00:00)
 */
function initScheduler() {
  const touchIntervalDays = getTouchIntervalDays();
  console.log(`[TouchManager] Initializing daily cron scheduler (0 0 * * *) — touches files only once every ${touchIntervalDays} days based on last_touched...`);
  cron.schedule('0 0 * * *', async () => {
    console.log(`[TouchManager] Daily cron triggered! Checking files not touched in ${touchIntervalDays}+ days...`);
    try {
      await touchAllFiles(false);
    } catch (err) {
      console.error('[TouchManager Error] Cron execution failed:', err);
    }
  });
}

module.exports = {
  touchFileRecord,
  touchAllFiles,
  startTouchAll,
  stopTouch,
  getTouchStatus,
  getEligibleFiles,
  initScheduler
};
