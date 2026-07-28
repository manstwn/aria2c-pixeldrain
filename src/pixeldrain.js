const axios = require('axios');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const metadata = require('./metadata');
const thumbnailsModule = require('./thumbnails');
const logger = require('./logger');
require('dotenv').config();

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Upload a local file to Pixeldrain
 * @param {string} filePath Absolute path to completed download file
 * @param {string} overrideFilename Optional custom filename
 * @param {function} onProgress Optional progress callback
 * @param {string} sourceUrl Optional original remote URL
 * @param {string} engine Optional download engine ('ytdlp' or 'aria2')
 */
function uploadToPixeldrain(filePath, overrideFilename, onProgress = null, sourceUrl = '', engine = 'aria2') {
  let activeFileStream = null;
  let activeReq = null;
  let isAborted = false;

  const uploadTaskPromise = (async () => {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found on disk for upload: ${filePath}`);
    }

    metadata.sanitizeVideoFile(filePath);

    const filename = overrideFilename || path.basename(filePath);
    const token = (process.env.PIXELDRAIN_API_TOKEN || '').trim();
    const stats = fs.statSync(filePath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

    console.log(`[Pixeldrain] Preparing upload for ${filename} (${fileSizeMB} MB)...`);
    
    if (!token) {
      throw new Error('PIXELDRAIN_API_TOKEN is required for Pixeldrain uploads.');
    }

    const uploadUrl = `https://pixeldrain.com/api/file/${encodeURIComponent(filename)}`;

    activeFileStream = fs.createReadStream(filePath);
    let loadedBytes = 0;
    let lastLoaded = 0;
    let lastTime = Date.now();

    activeFileStream.on('data', (chunk) => {
      if (isAborted) return;
      loadedBytes += chunk.length;
      const currentTime = Date.now();
      const timeDiffSeconds = (currentTime - lastTime) / 1000;

      if (timeDiffSeconds >= 0.25 || loadedBytes >= stats.size) {
        const currentSpeed = timeDiffSeconds > 0 ? Math.max(0, (loadedBytes - lastLoaded) / timeDiffSeconds) : 0;
        lastLoaded = loadedBytes;
        lastTime = currentTime;

        const percent = stats.size > 0 ? parseFloat(((loadedBytes / stats.size) * 100).toFixed(1)) : 0;
        if (onProgress) {
          onProgress({
            uploadProgress: Math.min(99.9, percent),
            uploadLoaded: loadedBytes,
            uploadTotal: stats.size,
            uploadSpeed: currentSpeed
          });
        }
      }
    });

    console.log(`[Pixeldrain] Streaming file (${metadata.formatBytes(stats.size)}) to ${uploadUrl} via native HTTPS stream...`);

    const https = require('https');
    const { URL } = require('url');
    const parsedUrl = new URL(uploadUrl);

    try {
      const resData = await new Promise((resolve, reject) => {
        if (isAborted) return reject(new Error('Pixeldrain upload aborted by user.'));

        activeReq = https.request({
          hostname: parsedUrl.hostname,
          port: 443,
          path: parsedUrl.pathname,
          method: 'PUT',
          headers: {
            'Authorization': `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
            'Content-Type': 'application/octet-stream',
            'Content-Length': stats.size,
            'User-Agent': USER_AGENT
          }
        }, (res) => {
          let body = '';
          res.on('data', (chunk) => body += chunk);
          res.on('end', () => {
            if (isAborted) return reject(new Error('Pixeldrain upload aborted by user.'));
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(body));
              } catch (e) {
                reject(new Error(`Invalid JSON response from Pixeldrain: ${body}`));
              }
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${body || res.statusMessage}`));
            }
          });
        });

        activeReq.on('error', (err) => reject(err));
        activeFileStream.pipe(activeReq);
      });

      if (isAborted) throw new Error('Pixeldrain upload aborted by user.');

      if (onProgress) {
        onProgress({
          uploadProgress: 100,
          uploadLoaded: stats.size,
          uploadTotal: stats.size,
          uploadSpeed: 0
        });
      }

      if (!resData || !resData.id) {
        throw new Error(`Pixeldrain upload failed: ${JSON.stringify(resData)}`);
      }

      const fileId = resData.id;
      const downloadPage = `https://pixeldrain.com/u/${fileId}`;

      if (onProgress) {
        onProgress({
          uploadProgress: 100,
          status: 'PROCESSING',
          stageMessage: 'Analyzing metadata...'
        });
      }

      const fileMeta = metadata.extractMetadata(filePath, sourceUrl);
      
      let originalFilename = path.basename(filePath);
      if (sourceUrl) {
        try {
          const parsedUrl = new URL(sourceUrl);
          const urlBasename = path.basename(parsedUrl.pathname);
          if (urlBasename && urlBasename.includes('.')) {
            originalFilename = urlBasename;
          }
        } catch (e) {}
      }

      const recordId = db.generateId();

      const cat = fileMeta.category || 'file';
      if (onProgress) {
        onProgress({
          uploadProgress: 100,
          status: 'PROCESSING',
          stageMessage: cat === 'video' ? '🎬 Video detected! Generating 15-frame screenshots...' : '🖼️ Generating preview thumbnails...'
        });
      }

      if (isAborted) throw new Error('Pixeldrain upload aborted by user.');

      const thumbs = await thumbnailsModule.generateThumbnails(filePath, recordId, fileMeta);

      if (isAborted) throw new Error('Pixeldrain upload aborted by user.');

      const now = new Date().toISOString();
      const record = db.addFile({
        id: recordId,
        filename: filename,
        custom_name: (filename && filename !== originalFilename) ? filename : '',
        original_filename: originalFilename,
        source_url: sourceUrl || '',
        engine: engine || 'aria2',
        pixeldrain_id: fileId,
        download_url: downloadPage,
        created_at: now,
        last_touched: now,
        status: 'LIVE',
        metadata: fileMeta,
        thumbnails: thumbs
      });

      console.log(`[Pixeldrain] ✅ Upload successful! Filename: ${filename} | Download URL: ${downloadPage}`);
      return record;

    } catch (err) {
      let detailedError = err.message;
      if (err.response) {
        const status = err.response.status;
        const dataStr = typeof err.response.data === 'object' ? JSON.stringify(err.response.data) : err.response.data;
        detailedError = `HTTP ${status}: ${dataStr || err.message}`;
      }
      console.error(`[Pixeldrain Error] Failed to upload ${filename}: ${detailedError}`);
      throw new Error(detailedError);

    } finally {
      // Guaranteed disk cleanup
      try {
        if (fs.existsSync(filePath)) {
          fs.rmSync(filePath, { recursive: true, force: true });
          console.log(`[Pixeldrain Cleanup] Temporary local file removed: ${filePath}`);
        }
        const aria2ControlFile = `${filePath}.aria2`;
        if (fs.existsSync(aria2ControlFile)) {
          fs.rmSync(aria2ControlFile, { force: true });
          console.log(`[Pixeldrain Cleanup] Temporary control file removed: ${aria2ControlFile}`);
        }
      } catch (cleanupErr) {
        console.warn(`[Pixeldrain Cleanup Warning] Error deleting temp files: ${cleanupErr.message}`);
      }
    }
  })();

  uploadTaskPromise.abort = () => {
    isAborted = true;
    try {
      if (activeFileStream) activeFileStream.destroy();
      if (activeReq) activeReq.destroy();
    } catch (e) {}
  };

  return uploadTaskPromise;
}

module.exports = {
  uploadToPixeldrain
};
