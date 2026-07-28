const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const db = require('./src/db');
const auth = require('./src/auth');
const aria2 = require('./src/aria2');
const touchManager = require('./src/touchManager');
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

// Protected static route for generated image thumbnails (requires valid PIN auth)
app.use('/data/image', auth.requireAuth, express.static(path.join(__dirname, 'data/image')));

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
app.get('/api/files', auth.requireAuth, (req, res) => {
  try {
    const files = db.getAllFiles();
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

app.delete('/api/files/:id', auth.requireAuth, (req, res) => {
  try {
    const { id } = req.params;
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

// Dedicated Video Watch & Streaming Proxy Routes
app.get('/watch', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'watch.html'));
});

/**
 * Helper to stream video from Pixeldrain with redirect support and verbose logging
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

  logger.debug(`[Video Proxy Stream] Requesting (Depth ${depth}) -> ${targetUrl}`);

  const proxyReq = https.request(options, (proxyRes) => {
    logger.debug(`[Video Proxy Response] Status: ${proxyRes.statusCode} | Headers:`, {
      'content-type': proxyRes.headers['content-type'],
      'content-length': proxyRes.headers['content-length'],
      'content-range': proxyRes.headers['content-range'],
      'accept-ranges': proxyRes.headers['accept-ranges'],
      'location': proxyRes.headers['location'] || 'None'
    });

    // Handle 301/302/307/308 Redirects from Pixeldrain
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      const redirectUrl = new URL(proxyRes.headers.location, targetUrl).toString();
      logger.debug(`[Video Proxy Redirect] ${proxyRes.statusCode} redirect -> ${redirectUrl}`);
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

    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', 'video/mp4');
    }

    logger.debug(`[Video Proxy Piping] Streaming bytes to client response (Status ${proxyRes.statusCode})...`);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    logger.error(`[Video Proxy Request Error] ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Video streaming failed: ' + err.message });
    }
  });

  req.on('close', () => {
    logger.debug('[Video Proxy Stream] Client closed connection / stopped playback.');
    try { proxyReq.destroy(); } catch (e) {}
  });

  // End request stream to send HTTP GET to Pixeldrain!
  proxyReq.end();
}

app.get('/api/video/:id', (req, res) => {
  const { id } = req.params;
  const rangeHeader = req.headers.range || 'None';

  logger.debug(`[Video Proxy API] Incoming GET /api/video/${id} | Range: ${rangeHeader}`);

  const token = req.cookies?.gotouch_token || req.query.token || (req.headers.authorization && req.headers.authorization.split(' ')[1]);
  const decoded = auth.verifyToken(token);

  if (!decoded) {
    logger.warn(`[Video Proxy Auth Failed] Unauthorized request for video ID ${id}. Invalid/missing token.`);
    return res.status(401).json({ error: 'Unauthorized', message: 'PIN authentication required.' });
  }

  logger.debug(`[Video Proxy Auth Success] Authenticated session for video ID ${id}`);

  const file = db.getFileById(id);
  if (!file || !file.pixeldrain_id) {
    logger.warn(`[Video Proxy Not Found] Record ID ${id} not found or missing pixeldrain_id in database.`);
    return res.status(404).json({ error: 'Video file record not found or missing Pixeldrain ID.' });
  }

  logger.debug(`[Video Proxy File Record] File: "${file.filename}" | Pixeldrain ID: ${file.pixeldrain_id} | Status: ${file.status}`);

  const targetUrl = `https://pixeldrain.com/api/file/${file.pixeldrain_id}`;
  const reqHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*'
  };

  const pixeldrainToken = (process.env.PIXELDRAIN_API_TOKEN || '').trim();
  if (pixeldrainToken) {
    reqHeaders['Authorization'] = `Basic ${Buffer.from(`:${pixeldrainToken}`).toString('base64')}`;
    logger.debug('[Video Proxy Auth] Attached Pixeldrain API basic authorization header');
  }

  if (req.headers.range) {
    reqHeaders['Range'] = req.headers.range;
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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`  GoTouch Manager Server running on http://localhost:${PORT}`);
  console.log(`  Target Audience: Single-user / Self-hosted Admin`);
  console.log(`=======================================================`);

  // Initialize Background Daemon Monitors
  aria2.startMonitor();
  touchManager.initScheduler();

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
