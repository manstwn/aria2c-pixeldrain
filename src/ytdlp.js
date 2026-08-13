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
      fragCurrent: task.fragCurrent || 0,
      fragTotal: task.fragTotal || 0,
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
 * Parse output lines from stdout or stderr (handles native yt-dlp & FFmpeg downloader output)
 */
function parseYtDlpOutput(line, taskState) {
  if (!line || typeof line !== 'string') return;
  const str = line.trim();
  if (!str) return;

  // 1. Check for Destination or Merger output lines
  const destMatch = str.match(/(?:[Dd]estination:\s*|[Mm]erging formats into\s*["']?)([^"'\r\n]+)/i);
  if (destMatch && destMatch[1]) {
    const rawDest = destMatch[1].trim();
    if (rawDest.includes('.')) {
      taskState.filePath = rawDest;
      taskState.downloadedFilename = path.basename(rawDest);
      taskState.filename = path.basename(rawDest);
    }
  }

  // 2. Standard yt-dlp native progress line:
  // [download]  19.1% of ~   1.00GiB at   10.66MiB/s ETA 01:25 (frag 207/1085)
  const progMatch = str.match(/\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*[KMG]?i?B)(?:\s+at\s+([\d.]+\s*[KMG]?i?B\/s))?(?:.*\(frag\s+(\d+)\/(\d+)\))?/i);
  if (progMatch) {
    const percent = parseFloat(progMatch[1]);
    const totalSizeStr = progMatch[2];
    const speedStr = progMatch[3] || '';
    const fragCurrent = progMatch[4] ? parseInt(progMatch[4], 10) : 0;
    const fragTotal = progMatch[5] ? parseInt(progMatch[5], 10) : 0;

    const totalBytes = parseSizeToBytes(totalSizeStr);
    const speedBytes = parseSpeedToBytes(speedStr);
    const completedBytes = Math.round((percent / 100) * totalBytes);

    taskState.progress = percent;
    taskState.downloadSpeed = speedBytes;
    taskState.totalLength = totalBytes;
    taskState.completedLength = completedBytes;
    if (fragCurrent && fragTotal) {
      taskState.fragCurrent = fragCurrent;
      taskState.fragTotal = fragTotal;
    }
    return;
  }

  // 3. FFmpeg downloader progress line fallback:
  // size=  880384KiB time=01:07:17.62 bitrate=1786.2kbits/s speed=16.4x
  const ffmpegSizeMatch = str.match(/size=\s*(\d+)\s*(KiB|kB|MiB|MB|B)?\s+time=\s*([\d:.]+)/i);
  if (ffmpegSizeMatch) {
    const rawSize = parseInt(ffmpegSizeMatch[1], 10);
    const unit = (ffmpegSizeMatch[2] || 'KiB').toUpperCase();
    let completedBytes = rawSize;
    if (unit.startsWith('K')) completedBytes = rawSize * 1024;
    else if (unit.startsWith('M')) completedBytes = rawSize * 1024 * 1024;
    else if (unit.startsWith('G')) completedBytes = rawSize * 1024 * 1024 * 1024;

    taskState.completedLength = completedBytes;

    const now = Date.now();
    if (taskState._lastTime && taskState._lastBytes !== undefined) {
      const timeDiff = (now - taskState._lastTime) / 1000;
      const bytesDiff = completedBytes - taskState._lastBytes;
      if (timeDiff >= 0.25 && bytesDiff >= 0) {
        taskState.downloadSpeed = Math.round(bytesDiff / timeDiff);
        taskState._lastTime = now;
        taskState._lastBytes = completedBytes;
      }
    } else {
      taskState._lastTime = now;
      taskState._lastBytes = completedBytes;
    }

    if (taskState.totalLength && taskState.totalLength > 0) {
      taskState.progress = parseFloat(((completedBytes / taskState.totalLength) * 100).toFixed(1));
    }
  }

  // 4. HLS segment number tracking (e.g. seg-406-f2-v1-a1.woff2)
  const segMatch = str.match(/seg-(\d+)-/i);
  if (segMatch) {
    const currentSeg = parseInt(segMatch[1], 10);
    if (!taskState._maxSeg || currentSeg > taskState._maxSeg) {
      taskState._maxSeg = currentSeg;
    }
  }
}

/**
 * Run yt-dlp download for a queue item
 */
function startDownload(qItem, onComplete, onError) {
  const executable = findYtDlpExecutable();
  const downloadsDir = path.resolve(db.DOWNLOADS_DIR);

  let outFilename = qItem.custom_name ? qItem.custom_name.trim() : '';
  if (outFilename && !path.extname(outFilename)) {
    outFilename += '.mp4';
  }

  let targetUrl = qItem.url ? qItem.url.trim().replace(/^hls\+/, '') : '';
  const isHlsPlaylist = targetUrl && (
    targetUrl.endsWith('.txt') ||
    targetUrl.endsWith('.m3u8') ||
    targetUrl.includes('.urlset/') ||
    targetUrl.includes('index-') ||
    targetUrl.includes('master.')
  );

  if (isHlsPlaylist) {
    console.log(`[yt-dlp Engine] ⚡ Auto-detected HLS playlist manifest: ${targetUrl}`);
  }

  const outPattern = outFilename ? path.join(downloadsDir, outFilename) : path.join(downloadsDir, '%(title)s [%(id)s].%(ext)s');

  let refererUrl = '';
  try {
    const parsed = new URL(targetUrl);
    refererUrl = `${parsed.protocol}//${parsed.hostname}/`;
  } catch (e) {}

  const args = [
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '--no-check-certificates',
    '-N', '1',
    '--no-playlist',
    '--no-mtime',
    '--newline',
    '--concurrent-fragments', '4',
    '--remux-video', 'mp4',
    '--merge-output-format', 'mp4'
  ];

  if (refererUrl) {
    args.push('--referer', refererUrl);
  }

  args.push('-o', outPattern, targetUrl);

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
    const child = spawn(executable, args, {
      windowsHide: true,
      detached: process.platform !== 'win32'
    });
    taskState.process = child;

    child.stdout.on('data', (buffer) => {
      const lines = buffer.toString('utf8').split(/[\r\n]+/);
      for (const line of lines) {
        parseYtDlpOutput(line, taskState);
      }
    });

    child.stderr.on('data', (buffer) => {
      const lines = buffer.toString('utf8').split(/[\r\n]+/);
      for (const line of lines) {
        if (!line.trim()) continue;
        parseYtDlpOutput(line, taskState);
        if (!line.includes('[download]') && !line.includes('size=') && !line.includes('Opening')) {
          console.warn(`[yt-dlp stderr] ${line.trim()}`);
        }
      }
    });

    child.on('error', (err) => {
      if (taskState.isCancelled) return;
      console.error(`[yt-dlp] Failed to start process:`, err.message);
      taskState.status = 'ERROR';
      taskState.errorMessage = err.message;
      activeTasks.delete(gid);
      if (onError) onError(err);
    });

    child.on('exit', async (code) => {
      if (taskState.isCancelled) {
        console.log(`[yt-dlp] Task ${gid} exit signal ignored (cancelled by user).`);
        return;
      }
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
          }, qItem.url, 'ytdlp');

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
 * Remove/cancel active yt-dlp task and 100% wipe temporary files from disk
 */
function removeDownload(gid) {
  const task = activeTasks.get(gid);
  if (task) {
    task.isCancelled = true;
    task.status = 'CANCELLED';

    if (task.process) {
      try {
        if (task.process.pid) {
          if (process.platform === 'win32') {
            const { execSync } = require('child_process');
            execSync(`taskkill /F /T /PID ${task.process.pid}`, { stdio: 'ignore' });
          } else {
            try {
              process.kill(-task.process.pid, 'SIGKILL');
            } catch (e) {
              try { task.process.kill('SIGKILL'); } catch (e2) {}
            }
          }
        }
      } catch (e) {}
    }
    if (task.uploadTaskPromise && task.uploadTaskPromise.abort) {
      try { task.uploadTaskPromise.abort(); } catch (e) {}
    }

    const targetKeywords = [gid];
    if (task.filePath) {
      const fn = path.basename(task.filePath);
      targetKeywords.push(fn);
      targetKeywords.push(fn.split('.')[0]);
      if (fs.existsSync(task.filePath)) {
        try { fs.rmSync(task.filePath, { recursive: true, force: true }); } catch (e) {}
      }
    }

    const downloadsDir = path.resolve(DOWNLOADS_DIR);
    if (fs.existsSync(downloadsDir)) {
      try {
        const filesInDir = fs.readdirSync(downloadsDir);
        for (const f of filesInDir) {
          const fullP = path.join(downloadsDir, f);
          const isMatch = targetKeywords.some(kw => kw && kw.length > 2 && f.includes(kw));

          if (isMatch) {
            try {
              fs.rmSync(fullP, { recursive: true, force: true });
              console.log(`[yt-dlp Cleanup] Wiped temp download file: ${fullP}`);
            } catch (e) {}
          }
        }
      } catch (e) {}
    }

    activeTasks.delete(gid);
    console.log(`[yt-dlp Cleanup] Task ${gid} cancelled & disk files wiped.`);
  }
}

/**
 * Forcibly kill ALL active yt-dlp child processes and abort in-flight uploads
 */
function killAllActiveYtDlpProcesses() {
  console.log(`[yt-dlp Shutdown] Terminating ${activeTasks.size} active yt-dlp task(s)...`);
  for (const [gid, task] of activeTasks.entries()) {
    if (task.process) {
      try {
        task.process.kill('SIGKILL');
        console.log(`[yt-dlp Shutdown] Killed process for task ${gid}`);
      } catch (e) {}
    }
    if (task.uploadTaskPromise && task.uploadTaskPromise.abort) {
      try { task.uploadTaskPromise.abort(); } catch (e) {}
    }
    if (task.filePath && fs.existsSync(task.filePath)) {
      try { fs.rmSync(task.filePath, { recursive: true, force: true }); } catch (e) {}
    }
  }
  activeTasks.clear();

  // Also kill any orphaned yt-dlp OS processes
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
      execSync('taskkill /F /IM yt-dlp.exe /T', { stdio: 'ignore' });
    } else {
      execSync('pkill -9 -f yt-dlp', { stdio: 'ignore' });
    }
  } catch (e) {}
}

/**
 * Scan downloads folder and purge all leftover temporary/partial files (.part, .ytdl, .aria2, .temp)
 */
function cleanUpOrphanedTempFiles() {
  try {
    const downloadsDir = path.resolve(DOWNLOADS_DIR);
    if (!fs.existsSync(downloadsDir)) return;

    const files = fs.readdirSync(downloadsDir);
    let count = 0;
    for (const f of files) {
      const fullPath = path.join(downloadsDir, f);
      if (
        f.endsWith('.part') ||
        f.endsWith('.ytdl') ||
        f.endsWith('.aria2') ||
        f.endsWith('.temp') ||
        f.includes('.f1') ||
        f.includes('.f2') ||
        f.includes('.f3') ||
        f.includes('.f4')
      ) {
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
          count++;
          console.log(`[Disk Cleanup] Purged orphaned temp file: ${f}`);
        } catch (e) {}
      }
    }
    if (count > 0) {
      console.log(`[Disk Cleanup] Total ${count} orphaned temporary file(s) purged from disk.`);
    }
  } catch (err) {
    console.warn(`[Disk Cleanup Warning] Error purging temp files:`, err.message);
  }
}

module.exports = {
  findYtDlpExecutable,
  getDownloadsStatus,
  startDownload,
  removeDownload,
  killAllActiveYtDlpProcesses,
  cleanUpOrphanedTempFiles,
  activeTasks
};
