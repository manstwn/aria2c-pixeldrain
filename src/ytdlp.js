const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const pixeldrain = require('./pixeldrain');
require('dotenv').config();

const YTDLP_PATH_ENV = process.env.YTDLP_PATH || '';

// Active yt-dlp downloads map: gid -> task object
const activeTasks = new Map();

/**
 * Locate yt-dlp executable on local machine or system PATH
 */
function findYtDlpExecutable() {
  const candidatePaths = [
    YTDLP_PATH_ENV,
    'C:\\Program Portable\\yt-dlp\\yt-dlp.exe',
    'C:\\yt-dlp\\yt-dlp.exe',
    'yt-dlp'
  ];

  for (const candidate of candidatePaths) {
    if (!candidate) continue;
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return 'yt-dlp';
}

/**
 * Get active yt-dlp tasks formatted for SSE/API status
 */
function getDownloadsStatus() {
  const list = [];
  for (const [gid, task] of activeTasks.entries()) {
    list.push({
      gid: task.gid,
      filename: task.customFilename || task.downloadedFilename || task.filename || 'yt-dlp Task',
      engine: 'ytdlp',
      status: task.status,
      progress: task.progress || 0,
      downloadSpeed: task.downloadSpeed || 0,
      completedLength: task.completedLength || 0,
      totalLength: task.totalLength || 0,
      uploadProgress: task.uploadProgress || 0,
      uploadLoaded: task.uploadLoaded || 0,
      uploadTotal: task.uploadTotal || 0,
      uploadSpeed: task.uploadSpeed || 0,
      stageMessage: task.stageMessage || '',
      errorMessage: task.errorMessage || ''
    });
  }
  return list;
}

/**
 * Parse speed string like '2.15MiB/s', '500KiB/s', '1.2GiB/s' to bytes/sec
 */
function parseSpeedToBytes(speedStr) {
  if (!speedStr) return 0;
  const match = speedStr.match(/([\d.]+)\s*([KMG]?i?B\/s)/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  if (unit.startsWith('G')) return Math.round(val * 1024 * 1024 * 1024);
  if (unit.startsWith('M')) return Math.round(val * 1024 * 1024);
  if (unit.startsWith('K')) return Math.round(val * 1024);
  return Math.round(val);
}

/**
 * Parse size string like '10.50MiB', '500KiB', '1.2GiB' to bytes
 */
function parseSizeToBytes(sizeStr) {
  if (!sizeStr) return 0;
  const match = sizeStr.match(/([\d.]+)\s*([KMG]?i?B)/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  if (unit.startsWith('G')) return Math.round(val * 1024 * 1024 * 1024);
  if (unit.startsWith('M')) return Math.round(val * 1024 * 1024);
  if (unit.startsWith('K')) return Math.round(val * 1024);
  return Math.round(val);
}

/**
 * Run yt-dlp download for a queue item
 * Command structure:
 * yt-dlp -N 16 --no-playlist --no-mtime --newline --concurrent-fragments 16 --merge-output-format mp4 -o "<out_path>" "<url>"
 */
function startDownload(qItem, onComplete, onError) {
  const executable = findYtDlpExecutable();
  const downloadsDir = path.resolve(db.DOWNLOADS_DIR);

  let outFilename = qItem.custom_name ? qItem.custom_name.trim() : '';
  if (outFilename && !path.extname(outFilename)) {
    outFilename += '.mp4';
  }

  const outPattern = outFilename ? path.join(downloadsDir, outFilename) : path.join(downloadsDir, '%(title)s [%(id)s].%(ext)s');

  const args = [
    '-N', '16',
    '--no-playlist',
    '--no-mtime',
    '--newline',
    '--concurrent-fragments', '16',
    '--merge-output-format', 'mp4',
    '-o', outPattern,
    qItem.url
  ];

  console.log(`[yt-dlp] Starting execution: ${executable} ${args.join(' ')}`);

  const gid = qItem.id;
  const taskState = {
    gid,
    url: qItem.url,
    filename: outFilename || 'yt-dlp Video',
    customFilename: outFilename,
    downloadedFilename: outFilename,
    filePath: outFilename ? path.join(downloadsDir, outFilename) : '',
    status: 'DOWNLOADING',
    progress: 0,
    downloadSpeed: 0,
    completedLength: 0,
    totalLength: 0,
    uploadProgress: 0,
    uploadLoaded: 0,
    uploadTotal: 0,
    uploadSpeed: 0,
    errorMessage: '',
    process: null
  };

  activeTasks.set(gid, taskState);

  try {
    const child = spawn(executable, args, { windowsHide: true });
    taskState.process = child;

    child.stdout.on('data', (buffer) => {
      const lines = buffer.toString('utf8').split(/[\r\n]+/);
      for (const line of lines) {
        if (!line.trim()) continue;

        // Check for Destination or Merger output lines
        const destMatch = line.match(/(?:[Dd]estination:\s*|[Mm]erging formats into\s*["']?)([^"'\r\n]+)/);
        if (destMatch && destMatch[1]) {
          const rawDest = destMatch[1].trim();
          if (rawDest.includes('.')) {
            taskState.filePath = rawDest;
            taskState.downloadedFilename = path.basename(rawDest);
            taskState.filename = path.basename(rawDest);
          }
        }

        // Parse progress line:
        // [download]  45.2% of ~ 10.50MiB at    2.15MiB/s ETA 00:03
        // [download] 100% of 15.34MiB in 00:05
        const progMatch = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*[KMG]?i?B)(?:\s+at\s+([\d.]+\s*[KMG]?i?B\/s))?/i);
        if (progMatch) {
          const percent = parseFloat(progMatch[1]);
          const totalSizeStr = progMatch[2];
          const speedStr = progMatch[3] || '';

          const totalBytes = parseSizeToBytes(totalSizeStr);
          const speedBytes = parseSpeedToBytes(speedStr);
          const completedBytes = Math.round((percent / 100) * totalBytes);

          taskState.progress = percent;
          taskState.downloadSpeed = speedBytes;
          taskState.totalLength = totalBytes;
          taskState.completedLength = completedBytes;
        }
      }
    });

    child.stderr.on('data', (buffer) => {
      const errStr = buffer.toString('utf8').trim();
      if (errStr && !errStr.includes('[download]')) {
        console.warn(`[yt-dlp stderr] ${errStr}`);
      }
    });

    child.on('error', (err) => {
      console.error(`[yt-dlp] Failed to start process:`, err.message);
      taskState.status = 'ERROR';
      taskState.errorMessage = err.message;
      activeTasks.delete(gid);
      if (onError) onError(err);
    });

    child.on('exit', async (code) => {
      console.log(`[yt-dlp] Process exited with code ${code}`);
      if (code === 0) {
        taskState.progress = 100;
        taskState.downloadSpeed = 0;
        taskState.status = 'UPLOADING';

        // Find actual target file on disk if pattern was dynamic
        let targetFilePath = taskState.filePath;
        if (!targetFilePath || !fs.existsSync(targetFilePath)) {
          if (outFilename && fs.existsSync(path.join(downloadsDir, outFilename))) {
            targetFilePath = path.join(downloadsDir, outFilename);
          } else {
            // Pick most recent file in downloads directory
            const files = fs.readdirSync(downloadsDir).map(f => path.join(downloadsDir, f)).filter(f => fs.statSync(f).isFile());
            if (files.length > 0) {
              files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
              targetFilePath = files[0];
            }
          }
        }

        if (!targetFilePath || !fs.existsSync(targetFilePath)) {
          const err = new Error('yt-dlp finished but output video file could not be found on disk.');
          taskState.status = 'ERROR';
          taskState.errorMessage = err.message;
          activeTasks.delete(gid);
          if (onError) onError(err);
          return;
        }

        const filename = path.basename(targetFilePath);
        taskState.filename = filename;
        taskState.filePath = targetFilePath;

        console.log(`[yt-dlp] Download completed successfully: ${targetFilePath}. Starting Pixeldrain upload...`);

        try {
          const record = await pixeldrain.uploadToPixeldrain(targetFilePath, filename, (progressData) => {
            Object.assign(taskState, progressData);
          }, qItem.url);

          taskState.status = 'UPLOADED';
          db.removeFromQueue(gid);

          // Clean up local temp file after upload
          if (fs.existsSync(targetFilePath)) {
            try {
              fs.rmSync(targetFilePath, { force: true });
              console.log(`[yt-dlp Cleanup] Removed temporary download file: ${targetFilePath}`);
            } catch (e) {}
          }

          setTimeout(() => {
            activeTasks.delete(gid);
            if (onComplete) onComplete(record);
          }, 2000);

        } catch (uploadErr) {
          console.error(`[yt-dlp] Upload failed for task ${gid}:`, uploadErr.message);
          taskState.status = 'UPLOAD_FAILED';
          taskState.errorMessage = uploadErr.message;
          setTimeout(() => {
            activeTasks.delete(gid);
            if (onError) onError(uploadErr);
          }, 2000);
        }
      } else {
        const err = new Error(`yt-dlp process exited with error code ${code}`);
        taskState.status = 'ERROR';
        taskState.errorMessage = err.message;

        // Clean up partial downloads if any
        if (taskState.filePath && fs.existsSync(taskState.filePath)) {
          try { fs.rmSync(taskState.filePath, { force: true }); } catch (e) {}
        }

        setTimeout(() => {
          activeTasks.delete(gid);
          if (onError) onError(err);
        }, 2000);
      }
    });

  } catch (err) {
    console.error(`[yt-dlp] Exception spawning yt-dlp:`, err.message);
    activeTasks.delete(gid);
    if (onError) onError(err);
  }
}

/**
 * Remove/cancel active yt-dlp task
 */
function removeDownload(gid) {
  const task = activeTasks.get(gid);
  if (task) {
    if (task.process) {
      try { task.process.kill(); } catch (e) {}
    }
    if (task.filePath && fs.existsSync(task.filePath)) {
      try { fs.rmSync(task.filePath, { force: true }); } catch (e) {}
    }
    activeTasks.delete(gid);
  }
}

module.exports = {
  findYtDlpExecutable,
  getDownloadsStatus,
  startDownload,
  removeDownload,
  activeTasks
};
