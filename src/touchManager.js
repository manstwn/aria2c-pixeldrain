const axios = require('axios');
const cron = require('node-cron');
const db = require('./db');
const logger = require('./logger');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  const targetUrl = `https://pixeldrain.com/api/file/${file.pixeldrain_id}`;

  console.log(`[TouchManager] Pinging & 12% chunk-downloading (${Math.round(targetBytes / 1024)} KB) for ${file.filename} | RAW URL: ${targetUrl}...`);

  try {
    const response = await axios.get(targetUrl, {
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
      console.log(`[TouchManager] ✅ Touch successful (12% downloaded) for ${file.filename} | RAW URL: ${targetUrl}`);
      return { success: true, status: 'LIVE', file: updated };

    } else if (isNotFound) {
      const updated = db.updateFile(file.id, { status: 'DEAD' });
      console.warn(`[TouchManager] ❌ Touch FAILED (404) for ${file.filename} | RAW URL: ${targetUrl}. Marked DEAD.`);
      return { success: false, status: 'DEAD', file: updated };

    } else {
      console.warn(`[TouchManager] Received HTTP ${response.status} for ${file.filename} | RAW URL: ${targetUrl}. Leaving status untouched.`);
      return { success: false, status: file.status, file };
    }

  } catch (err) {
    console.warn(`[TouchManager Warning] Chunk-download error for ${file.filename} (${targetUrl}): ${err.message}`);
    return { success: false, status: file.status, file };
  }
}

/**
 * Touch all files in database sequentially with randomized delay
 */
async function touchAllFiles() {
  const files = db.getAllFiles();
  console.log(`[TouchManager] Starting batch touch process for ${files.length} records...`);

  let touchedCount = 0;
  let deadCount = 0;

  for (const file of files) {
    const result = await touchFileRecord(file);
    if (result && result.success) {
      touchedCount++;
    } else if (result && result.status === 'DEAD') {
      deadCount++;
    }

    const delay = Math.floor(Math.random() * 2000) + 1000;
    await sleep(delay);
  }

  console.log(`[TouchManager] Batch touch complete. Touched: ${touchedCount} | Dead: ${deadCount} | Total: ${files.length}`);
  return { touchedCount, deadCount, total: files.length };
}

/**
 * Initialize daily cron scheduler (Runs every day at midnight 00:00)
 */
function initScheduler() {
  console.log('[TouchManager] Initializing daily cron scheduler (0 0 * * *)...');
  cron.schedule('0 0 * * *', async () => {
    console.log('[TouchManager] Daily cron triggered! Running batch file touch...');
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
