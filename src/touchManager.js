const axios = require('axios');
const cron = require('node-cron');
const db = require('./db');
const logger = require('./logger');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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

/**
 * Perform 1 KB Micro-Download & Abort on a single Pixeldrain record.
 * @param {object} file File record object from database
 */
async function touchFileRecord(file) {
  if (!file || !file.download_url) {
    console.warn(`[TouchManager] Skipping invalid record:`, file);
    return false;
  }

  const fileSize = file.metadata && file.metadata.size_bytes ? file.metadata.size_bytes : 0;
  // Pixeldrain requires at least 10% download to reset the 60-day timer.
  // We calculate 12% to ensure we comfortably exceed the 10% threshold.
  const targetBytes = fileSize > 0 ? Math.ceil(fileSize * 0.12) : 1024;
  const rangeHeader = fileSize > 0 ? `bytes=0-${targetBytes}` : 'bytes=0-1024';
  const filename = file.filename || file.original_filename || 'file';
  const pageUrl = file.download_url || `https://pixeldrain.com/u/${file.pixeldrain_id}`;
  const directFileUrl = `https://pixeldrain.com/api/file/${file.pixeldrain_id}`;

  console.log(`[TouchManager] Pinging & 12% chunk-downloading (${Math.round(targetBytes / 1024)} KB) for ${filename} | Page: ${pageUrl} | Direct File: ${directFileUrl}`);

  try {
    const response = await axios.get(directFileUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': '*/*',
        'Range': rangeHeader
      },
      timeout: 30000,
      responseType: 'stream',
      validateStatus: s => s < 500
    });

    if (response.data && typeof response.data.destroy === 'function') {
      response.data.destroy();
    }

    const isOk = response.status === 200 || response.status === 206;
    const isNotFound = response.status === 404;

    if (isOk) {
      const updated = db.updateFile(file.id, {
        last_touched: new Date().toISOString(),
        status: 'LIVE'
      });
      console.log(`[TouchManager] ✅ Touch successful (12% downloaded) for ${filename} | Page: ${pageUrl} | Direct File: ${directFileUrl}`);
      return { success: true, status: 'LIVE', file: updated };

    } else if (isNotFound) {
      const updated = db.updateFile(file.id, { status: 'DEAD' });
      console.warn(`[TouchManager] ❌ Touch FAILED (404) for ${filename} | Page: ${pageUrl} | Direct File: ${directFileUrl}. Marked DEAD.`);
      return { success: false, status: 'DEAD', file: updated };

    } else {
      console.warn(`[TouchManager] Received HTTP ${response.status} for ${filename} | Direct File: ${directFileUrl}. Leaving status untouched.`);
      return { success: false, status: file.status, file };
    }

  } catch (err) {
    console.warn(`[TouchManager Warning] Chunk-download error for ${filename} (${directFileUrl}): ${err.message}`);
    return { success: false, status: file.status, file };
  }
}

/**
 * Touch files that haven't been touched in 30+ days.
 * Evaluates last_touched (falling back to created_at if last_touched is missing).
 * Skips files that were touched less than 30 days ago, and skips DEAD files.
 * @param {boolean} force - If true, bypasses the 30-day age check (e.g. manual override)
 */
async function touchAllFiles(force = false) {
  const files = db.getAllFiles();
  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  const eligibleFiles = files.filter(file => {
    // Skip dead files
    if (file.status === 'DEAD') {
      return false;
    }

    if (force) return true;

    // Focus on last_touched; fall back to created_at if last_touched is absent
    const lastTouchStr = file.last_touched || file.created_at;
    const lastTouchTime = lastTouchStr ? new Date(lastTouchStr).getTime() : 0;
    const ageMs = now - lastTouchTime;

    if (ageMs < THIRTY_DAYS_MS) {
      const daysSinceTouch = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      const daysRemaining = 30 - daysSinceTouch;
      console.log(`[TouchManager] Skipping ${file.filename || file.id} — last touched ${daysSinceTouch} day(s) ago (next touch in ~${daysRemaining} day(s)).`);
      return false;
    }
    return true;
  });

  console.log(`[TouchManager] Batch touch: ${eligibleFiles.length} eligible (30+ days since last touch) out of ${files.length} total records.`);

  if (eligibleFiles.length === 0) {
    console.log('[TouchManager] No files need touching today (all files touched within last 30 days).');
    return { touchedCount: 0, deadCount: 0, total: files.length, skipped: files.length };
  }

  let touchedCount = 0;
  let deadCount = 0;

  for (const file of eligibleFiles) {
    const result = await touchFileRecord(file);
    if (result && result.success) {
      touchedCount++;
    } else if (result && result.status === 'DEAD') {
      deadCount++;
    }

    const delay = Math.floor(Math.random() * 2000) + 1000;
    await sleep(delay);
  }

  console.log(`[TouchManager] Batch touch complete. Touched: ${touchedCount} | Dead: ${deadCount} | Skipped (< 30 days since last touch): ${files.length - eligibleFiles.length}`);
  return { touchedCount, deadCount, total: files.length, skipped: files.length - eligibleFiles.length };
}

/**
 * Initialize daily cron scheduler (Runs every day at midnight 00:00)
 * Evaluates last_touched timestamp — touches each file only once every 30 days.
 */
function initScheduler() {
  console.log('[TouchManager] Initializing daily cron scheduler (0 0 * * *) — touches files only once every 30 days based on last_touched...');
  cron.schedule('0 0 * * *', async () => {
    console.log('[TouchManager] Daily cron triggered! Checking files not touched in 30+ days...');
    try {
      await touchAllFiles();
    } catch (err) {
      console.error('[TouchManager Error] Cron execution failed:', err);
    }
  });
}

module.exports = {
  touchFileRecord,
  touchAllFiles,
  initScheduler
};
