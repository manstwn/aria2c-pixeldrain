const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const db = require('./src/db');
const auth = require('./src/auth');
const aria2 = require('./src/aria2');
const ytdlp = require('./src/ytdlp');
const touchManager = require('./src/touchManager');
const s3Storage = require('./src/s3Storage');
const mongoClient = require('./src/mongoClient');
const cloudflared = require('./src/cloudflared');
const logger = require('./src/logger');

const app = express();
const PORT = process.env.PORT || 6258;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve static UI assets from public folder
app.use(express.static(path.join(__dirname, 'public')));

/* ==========================================================================
   PUBLIC AUTH ROUTES
   ========================================================================== */

app.post('/api/login', (req, res) => {
  const { pin } = req.body;
  if (!pin) {
    return res.status(400).json({ error: 'PIN is required' });
  }

  if (auth.verifyPin(pin)) {
    const token = auth.generateToken();
    res.cookie('gotouch_token', token, {
      httpOnly: true,
      secure: false, // Localhost/http supported; set true in HTTPS reverse proxy
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
    return res.json({ success: true, message: 'Authentication successful', token });
  } else {
    return res.status(401).json({ error: 'Invalid PIN' });
  }
});

app.get('/api/auth/check', (req, res) => {
  const token = req.cookies?.gotouch_token || (req.headers.authorization && req.headers.authorization.split(' ')[1]);
  const decoded = auth.verifyToken(token);
  if (decoded) {
    return res.json({ authenticated: true });
  } else {
    return res.status(401).json({ authenticated: false });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('gotouch_token');
  res.json({ success: true, message: 'Logged out' });
});

let _cachedFolderSize = 0;
let _folderSizeLastCalc = 0;

function walkFolderSize(dirPath) {
  let totalBytes = 0;
  if (!fs.existsSync(dirPath)) return 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        totalBytes += fs.statSync(fullPath).size;
      } else if (entry.isDirectory()) {
        totalBytes += walkFolderSize(fullPath);
      }
    }
  } catch (e) {}
  return totalBytes;
}

function getFolderSize(dirPath) {
  const now = Date.now();
  if (now - _folderSizeLastCalc < 10000) return _cachedFolderSize;
  _cachedFolderSize = walkFolderSize(dirPath);
  _folderSizeLastCalc = now;
  return _cachedFolderSize;
}


function formatBytes(bytes) {
  if (bytes === 0) return '0 MB';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/* ==========================================================================
   REAL-TIME SERVER-SENT EVENTS (SSE) STREAMING
   ========================================================================== */

app.get('/api/stream', (req, res) => {
  const token = req.cookies?.gotouch_token || req.query.token;
  const decoded = auth.verifyToken(token);
  if (!decoded) {
    return res.status(401).end();
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();

  const sendUpdate = async () => {
    try {
      await db.refreshFromMongo();
      const downloadsStatus = await aria2.getDownloadsStatus();
      const conn = await aria2.checkConnection();
      const persistentQueue = db.getAllQueue();

      // Merge persistent queue items so nothing is omitted in SSE payload
      const downloads = [...downloadsStatus];
      persistentQueue.forEach(qItem => {
        const exists = downloadsStatus.some(s => (qItem.gid && s.gid === qItem.gid) || s.filename === qItem.filename || s.gid === qItem.id);
        if (!exists) {
          downloads.push({
            gid: qItem.id || qItem.gid,
            filename: qItem.filename || qItem.custom_name || 'Queued Item',
            status: qItem.status || 'QUEUED',
            progress: 0,
            downloadSpeed: 0,
            completedLength: 0,
            totalLength: 0,
            errorMessage: qItem.error || ''
          });
        }
      });

      const files = db.getAllFiles();
      const dataSizeBytes = getFolderSize(path.join(__dirname, 'data'));
      const dataSizeFormatted = formatBytes(dataSizeBytes);

      res.write(`data: ${JSON.stringify({ downloads, conn, files, dataSizeFormatted, dataSizeBytes })}\n\n`);
    } catch (err) {}
  };

  sendUpdate();
  const interval = setInterval(sendUpdate, 3000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

/* ==========================================================================
   PROTECTED API ROUTES (Require PIN Authentication)
   ========================================================================== */

// Protected masked image proxy for generated thumbnails (checks local disk first, else streams from S3)
app.get('/data/image/:filename', auth.requireAuth, async (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const localPath = path.join(__dirname, 'data/image', filename);

    // 1. Check local disk first (for unmigrated local images or offline dev)
    if (fs.existsSync(localPath)) {
      return res.sendFile(localPath);
    }

    // 2. Stream directly from S3 behind server proxy (100% masked, no presigned URLs exposed)
    const s3Object = await s3Storage.getImageStreamFromS3(filename);
    if (s3Object && s3Object.stream) {
      res.setHeader('Content-Type', s3Object.contentType || 'image/jpeg');
      if (s3Object.contentLength) {
        res.setHeader('Content-Length', s3Object.contentLength);
      }
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return s3Object.stream.pipe(res);
    }

    return res.status(404).json({ error: 'Image not found on local disk or S3 storage.' });
  } catch (err) {
    console.error('[Image Proxy Error]', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to retrieve image.' });
    }
  }
});

// Download Orchestration Routes
app.get('/api/downloads', auth.requireAuth, async (req, res) => {
  try {
    const status = await aria2.getDownloadsStatus();
    const conn = await aria2.checkConnection();
    const persistentQueue = db.getAllQueue();

    // Merge persistent queue items from data/queue.json so nothing is lost on page refresh
    const mergedDownloads = [...status];
    persistentQueue.forEach(qItem => {
      const existsInAria2 = status.some(s => (qItem.gid && s.gid === qItem.gid) || s.filename === qItem.filename || s.gid === qItem.id);
      if (!existsInAria2) {
        mergedDownloads.push({
          gid: qItem.id || qItem.gid,
          filename: qItem.filename || qItem.custom_name || 'Queued Item',
          status: qItem.status || 'PAUSED',
          progress: 0,
          downloadSpeed: 0,
          completedLength: 0,
          totalLength: 0,
          errorMessage: qItem.error || ''
        });
      }
    });

    res.json({ aria2Connection: conn, downloads: mergedDownloads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/downloads', auth.requireAuth, async (req, res) => {
  try {
    const { url, filename, customFilename, engine } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URL parameter is required.' });
    }

    const selectedEngine = engine === 'ytdlp' ? 'ytdlp' : 'aria2';

    if (selectedEngine === 'aria2') {
      const conn = await aria2.checkConnection();
      if (!conn.online) {
        return res.status(503).json({
          error: 'Aria2 RPC daemon is offline.',
          details: 'Make sure aria2c is running with RPC enabled at ' + (process.env.ARIA2_RPC_URL || 'http://127.0.0.1:6800/jsonrpc')
        });
      }
    }

    const chosenName = filename || customFilename || '';
    const queueRecord = db.addToQueue({ url, custom_name: chosenName, engine: selectedEngine, status: 'QUEUED' });

    // Trigger Strict Serial Queue Engine: will launch immediately if pipeline is free,
    // or keep QUEUED if another task is currently downloading or uploading!
    setTimeout(() => aria2.processNextQueueItem(), 300);

    const queue = db.getAllQueue();
    const position = queue.findIndex(q => q.id === queueRecord.id) + 1;
    res.json({ success: true, queued: true, queueId: queueRecord.id, queuePosition: position, message: position === 1 ? 'Download started!' : `Added to queue (position ${position})` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/downloads/:gid', auth.requireAuth, async (req, res) => {
  try {
    const { gid } = req.params;
    await aria2.removeDownload(gid);
    db.removeFromQueue(gid);
    res.json({ success: true, message: 'Download task cancelled.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* Queue Control Endpoints */
app.post('/api/queue/pause-all', auth.requireAuth, async (req, res) => {
  try {
    await aria2.pauseAll();
    res.json({ success: true, message: 'Queue paused.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/queue/unpause-all', auth.requireAuth, async (req, res) => {
  try {
    await aria2.unpauseAll();
    res.json({ success: true, message: 'Queue resumed.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/queue/:gid/pause', auth.requireAuth, async (req, res) => {
  try {
    const { gid } = req.params;
    await aria2.pauseTask(gid);
    db.updateQueueItem(gid, { status: 'PAUSED' });
    res.json({ success: true, message: 'Task paused.' });
  } catch (err) {
    db.updateQueueItem(req.params.gid, { status: 'PAUSED' });
    res.json({ success: true, message: 'Task marked paused.' });
  }
});

app.post('/api/queue/:gid/unpause', auth.requireAuth, async (req, res) => {
  try {
    const { gid } = req.params;
    try { await aria2.unpauseTask(gid); } catch (e) {}
    db.updateQueueItem(gid, { status: 'QUEUED', error: '' });
    setTimeout(() => aria2.processNextQueueItem(), 300);
    res.json({ success: true, message: 'Task resumed.' });
  } catch (err) {
    db.updateQueueItem(req.params.gid, { status: 'QUEUED', error: '' });
    setTimeout(() => aria2.processNextQueueItem(), 300);
    res.json({ success: true, message: 'Task marked resumed.' });
  }
});

// File Ledger Routes
app.get('/api/files', auth.requireAuth, async (req, res) => {
  try {
    const files = await db.getAllFilesAsync(true);
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/files/:id', auth.requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.getFileById(id);
    if (!existing) return res.status(404).json({ error: 'File not found' });

    const { custom_name, status, download_url, category, selected_thumbnail, tags, engine } = req.body;
    const updateData = {};

    if (custom_name !== undefined) updateData.custom_name = custom_name.trim();
    if (status !== undefined) updateData.status = status;
    if (download_url !== undefined) updateData.download_url = download_url.trim();
    if (selected_thumbnail !== undefined) updateData.selected_thumbnail = selected_thumbnail;
    if (engine !== undefined) updateData.engine = engine;
    if (tags !== undefined) {
      updateData.tags = Array.isArray(tags) ? tags : String(tags).split(',').map(t => t.trim()).filter(Boolean);
    }

    if (category !== undefined) {
      updateData.metadata = {
        ...(existing.metadata || {}),
        category: category
      };
    }

    const updated = db.updateFile(id, updateData);
    res.json({ success: true, file: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/files/:id/thumbnail', auth.requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { thumbnail } = req.body;
    if (!thumbnail) {
      return res.status(400).json({ error: 'thumbnail parameter is required' });
    }
    const updated = db.setFileThumbnail(id, thumbnail);
    if (!updated) return res.status(404).json({ error: 'File record not found' });
    res.json({ success: true, file: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/files/:id/touch', auth.requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const file = db.getFileById(id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    const result = await touchManager.touchFileRecord(file);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/files/touch-all', auth.requireAuth, async (req, res) => {
  try {
    const results = await touchManager.touchAllFiles();
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/files/:id', auth.requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const file = db.getFileById(id);
    if (file) {
      // Also delete thumbnails from S3 if configured
      try {
        await s3Storage.deleteFileThumbnailsFromS3(file);
      } catch (e) {}
    }
    const deleted = db.deleteFile(id);
    if (deleted) {
      res.json({ success: true, message: 'Record deleted from ledger.' });
    } else {
      res.status(404).json({ error: 'Record not found.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ==========================================================================
   S3 IMAGE STORAGE & MIGRATION ENDPOINTS
   ========================================================================== */

app.get('/api/s3/status', auth.requireAuth, (req, res) => {
  try {
    const status = s3Storage.getS3Status();
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

let isS3SyncRunning = false;

app.post('/api/s3/sync-images', auth.requireAuth, async (req, res) => {
  if (isS3SyncRunning) {
    return res.status(409).json({ error: 'S3 image migration is already running.' });
  }

  try {
    isS3SyncRunning = true;
    const result = await s3Storage.syncAllLocalImagesToS3();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    isS3SyncRunning = false;
  }
});

app.post('/api/s3/test', auth.requireAuth, async (req, res) => {
  try {
    const result = await s3Storage.testS3Connection();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.name, message: err.message });
  }
});

/* ==========================================================================
   DATABASE STATUS & MONGODB MIGRATION ENDPOINTS
   ========================================================================== */

app.get('/api/db/status', auth.requireAuth, (req, res) => {
  try {
    const status = db.getDbStatus();
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/db/test', auth.requireAuth, async (req, res) => {
  try {
    const result = await mongoClient.testMongoConnection();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.name, message: err.message });
  }
});

let isMongoMigrating = false;

app.post('/api/db/migrate-to-mongo', auth.requireAuth, async (req, res) => {
  if (isMongoMigrating) {
    return res.status(409).json({ error: 'MongoDB migration is already in progress.' });
  }

  try {
    isMongoMigrating = true;
    const result = await db.migrateJsonToMongo();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    isMongoMigrating = false;
  }
});

// Dedicated Video Watch & Streaming Proxy Routes
app.get('/watch', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'watch.html'));
});

/**
 * Basic helper to proxy video stream directly from Pixeldrain
 */
function streamVideoFromPixeldrain(targetUrl, headers, req, res, depth = 0) {
  if (depth > 5) {
    logger.error(`[Video Proxy Error] Exceeded max redirects (5) for URL: ${targetUrl}`);
    return res.status(502).json({ error: 'Too many redirects from Pixeldrain server.' });
  }

  const https = require('https');
  const { URL } = require('url');
  const parsedUrl = new URL(targetUrl);

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || 443,
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'GET',
    headers: headers
  };

  const proxyReq = https.request(options, (proxyRes) => {
    // Handle 301/302/307/308 Redirects
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      const redirectUrl = new URL(proxyRes.headers.location, targetUrl).toString();
      return streamVideoFromPixeldrain(redirectUrl, headers, req, res, depth + 1);
    }

    res.status(proxyRes.statusCode);

    const headersToForward = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'last-modified',
      'cache-control',
      'etag'
    ];

    headersToForward.forEach(header => {
      if (proxyRes.headers[header]) {
        res.setHeader(header, proxyRes.headers[header]);
      }
    });

    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    logger.error(`[Video Proxy Error] ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Video streaming failed: ' + err.message });
    }
  });

  req.on('close', () => {
    try { proxyReq.destroy(); } catch (e) {}
  });

  proxyReq.end();
}

app.get('/api/video/:id', (req, res) => {
  const { id } = req.params;

  const token = req.cookies?.gotouch_token || req.query.token || (req.headers.authorization && req.headers.authorization.split(' ')[1]);
  const decoded = auth.verifyToken(token);

  if (!decoded && !auth.verifyPin(req.query.pin || '')) {
    return res.status(401).json({ error: 'Unauthorized', message: 'PIN authentication required.' });
  }

  const file = db.getFileById(id);
  if (!file || !file.pixeldrain_id) {
    return res.status(404).json({ error: 'Video file record not found or missing Pixeldrain ID.' });
  }

  const targetUrl = `https://pixeldrain.com/api/file/${file.pixeldrain_id}`;
  const reqHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*'
  };

  if (req.headers.range) {
    reqHeaders['Range'] = req.headers.range;
  }

  const pixeldrainToken = (process.env.PIXELDRAIN_API_TOKEN || '').trim();
  if (pixeldrainToken) {
    reqHeaders['Authorization'] = `Basic ${Buffer.from(`:${pixeldrainToken}`).toString('base64')}`;
  }

  streamVideoFromPixeldrain(targetUrl, reqHeaders, req, res);
});

// Dedicated Gallery Page Route
app.get('/gallery', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'gallery.html'));
});

// Serve SPA fallback for HTML requests
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// Start Background Services & Server
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`=======================================================`);
  console.log(`  GoTouch Manager Server running on http://localhost:${PORT}`);
  console.log(`  Target Audience: Single-user / Self-hosted Admin`);
  console.log(`=======================================================`);

  // Initialize Database Engine (MongoDB with local JSON fallback)
  await db.initDbEngine();

  // Check S3 Storage Connectivity and Auto-Migrate local images on startup
  try {
    const s3Check = await s3Storage.testS3Connection();
    if (s3Check.success) {
      console.log(`[S3 Storage] ✅ Connected successfully to bucket "${s3Check.bucket}" (Prefix: "/${s3Check.folderPrefix || 'aria2c'}") in ${s3Check.latencyMs}ms!`);

      const s3Status = s3Storage.getS3Status();
      if (s3Status.localImageCount > 0) {
        console.log(`[S3 Auto-Migration] 🚀 Found ${s3Status.localImageCount} local image(s) (${s3Status.localImageSizeFormatted}). Auto-migrating to S3 (/aria2c)...`);
        s3Storage.syncAllLocalImagesToS3().catch(err => {
          console.error('[S3 Auto-Migration Error]', err.message);
        });
      }
    } else if (process.env.S3_ENDPOINT || process.env.S3_BUCKET) {
      console.warn(`[S3 Storage] ⚠️ S3 check issue: ${s3Check.message || s3Check.error}. Local images will be used as fallback.`);
    } else {
      console.log(`[S3 Storage] ℹ️ S3 is not configured in .env. Storing images on local disk (data/image/).`);
    }
  } catch (s3BootErr) {
    console.warn(`[S3 Storage Warning] S3 startup check error: ${s3BootErr.message}`);
  }

  // Initialize Background Daemon Monitors
  aria2.startMonitor();
  touchManager.initScheduler();

  // Summon Cloudflare Tunnel daemon if ENABLE_CLOUDFLARED=true in .env
  cloudflared.startCloudflared();

  // On startup: kill leftover OS child processes & wipe temporary files from disk
  setTimeout(async () => {
    ytdlp.killAllActiveYtDlpProcesses();
    ytdlp.cleanUpOrphanedTempFiles();
    await aria2.wipeAllAria2Tasks();

    // Reset any stuck DOWNLOADING or UPLOADING queue items back to PAUSED
    const queue = db.getAllQueue();
    const stuckItems = queue.filter(q => q.status === 'DOWNLOADING' || q.status === 'UPLOADING' || q.status === 'PROCESSING');
    if (stuckItems.length > 0) {
      console.log(`[Queue Engine] Setting ${stuckItems.length} interrupted task(s) to PAUSED (Interrupted by runtime restart)...`);
      stuckItems.forEach(item => db.updateQueueItem(item.id, { 
        status: 'PAUSED', 
        gid: '', 
        error: 'Interrupted by runtime restart. Requires manual retry.' 
      }));
    }
  }, 1500);
});

/**
 * Graceful Shutdown Handlers:
 * Ensures Node.js kills all yt-dlp/ffmpeg child processes and wipes temp files when stopped (Ctrl+C, PM2 stop, SIGTERM)
 */
function handleGracefulShutdown(signal) {
  console.log(`\n[Server Shutdown] Received ${signal}. Terminating child processes and cleaning disk...`);
  try {
    cloudflared.stopCloudflared();
    ytdlp.killAllActiveYtDlpProcesses();
    ytdlp.cleanUpOrphanedTempFiles();
  } catch (e) {}

  setTimeout(() => {
    process.exit(0);
  }, 500);
}

process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));
process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));
process.on('SIGHUP', () => handleGracefulShutdown('SIGHUP'));
