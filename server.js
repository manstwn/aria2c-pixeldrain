const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
require('dotenv').config();

const db = require('./src/db');
const auth = require('./src/auth');
const aria2 = require('./src/aria2');
const touchManager = require('./src/touchManager');

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

function getFolderSize(dirPath) {
  let totalBytes = 0;
  if (!fs.existsSync(dirPath)) return 0;

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        const stats = fs.statSync(fullPath);
        totalBytes += stats.size;
      } else if (entry.isDirectory()) {
        totalBytes += getFolderSize(fullPath);
      }
    }
  } catch (e) {}

  return totalBytes;
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
      const downloads = await aria2.getDownloadsStatus();
      const conn = await aria2.checkConnection();
      const files = db.getAllFiles();
      const dataSizeBytes = getFolderSize(path.join(__dirname, 'data'));
      const dataSizeFormatted = formatBytes(dataSizeBytes);

      res.write(`data: ${JSON.stringify({ downloads, conn, files, dataSizeFormatted, dataSizeBytes })}\n\n`);
    } catch (err) {}
  };

  sendUpdate();
  const interval = setInterval(sendUpdate, 1000);

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
      const existsInAria2 = status.some(s => (qItem.gid && s.gid === qItem.gid) || s.filename === qItem.filename);
      if (!existsInAria2) {
        mergedDownloads.push({
          gid: qItem.gid || qItem.id,
          filename: qItem.filename || qItem.custom_name || 'Queued Item',
          status: qItem.status === 'PAUSED' ? 'paused' : 'waiting',
          progress: 0,
          downloadSpeed: 0,
          completedLength: 0,
          totalLength: 0,
          errorMessage: ''
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
    const { url, filename, customFilename } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URL parameter is required.' });
    }

    const conn = await aria2.checkConnection();
    if (!conn.online) {
      return res.status(503).json({
        error: 'Aria2 RPC daemon is offline.',
        details: 'Make sure aria2c is running with RPC enabled at ' + (process.env.ARIA2_RPC_URL || 'http://127.0.0.1:6800/jsonrpc')
      });
    }

    const chosenName = filename || customFilename || '';
    const queueRecord = db.addToQueue({ url, custom_name: chosenName, status: 'QUEUED' });

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
    await aria2.unpauseTask(gid);
    db.updateQueueItem(gid, { status: 'QUEUED' });
    res.json({ success: true, message: 'Task resumed.' });
  } catch (err) {
    db.updateQueueItem(req.params.gid, { status: 'QUEUED' });
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
    const { custom_name } = req.body;
    if (custom_name === undefined) {
      return res.status(400).json({ error: 'custom_name is required' });
    }
    const updated = db.updateFile(id, { custom_name: custom_name.trim() });
    if (!updated) return res.status(404).json({ error: 'File not found' });
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

  // On startup: reset any stuck DOWNLOADING queue items back to QUEUED
  // (happens if server crashed mid-download) and kick off the queue engine
  const queue = db.getAllQueue();
  const stuckItems = queue.filter(q => q.status === 'DOWNLOADING');
  if (stuckItems.length > 0) {
    console.log(`[Queue Engine] Resetting ${stuckItems.length} stuck DOWNLOADING item(s) back to QUEUED on startup...`);
    stuckItems.forEach(item => db.updateQueueItem(item.id, { status: 'QUEUED', gid: '' }));
  }
  // Kick off queue engine after a short delay (let aria2 daemon connect first)
  setTimeout(() => aria2.processNextQueueItem(), 3000);
});
