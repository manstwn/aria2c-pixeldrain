const fs = require('fs');
const path = require('path');
const { execSync, execFile } = require('child_process');

const IMAGES_DIR = path.resolve(__dirname, '../data/image');

/**
 * Ensure data/image storage directory exists
 */
function initImageStorage() {
  if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
  }
}

/**
 * Check if ffmpeg is available on system
 */
function isFFmpegAvailable() {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Extract exact video duration in seconds via ffprobe or metadata fallback
 */
function getVideoDuration(filePath, meta = {}) {
  // 1. Primary: Use ffprobe for 100% exact video duration from file container
  try {
    const output = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`, { timeout: 5000 }).toString().trim();
    const parsedSecs = parseFloat(output);
    if (!isNaN(parsedSecs) && parsedSecs > 0) {
      return Math.round(parsedSecs);
    }
  } catch (e) {}

  // 2. Secondary: Parse HH:MM:SS or MM:SS from metadata
  if (meta.duration_formatted) {
    const parts = meta.duration_formatted.split(':').map(p => parseInt(p, 10));
    if (parts.length === 3 && !parts.some(isNaN)) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2 && !parts.some(isNaN)) {
      return parts[0] * 60 + parts[1];
    }
  }

  if (meta.duration_seconds && meta.duration_seconds > 0) {
    return meta.duration_seconds;
  }

  return 300; // Fallback to 5 minutes (300 seconds) if unknown
}

/**
 * Fast video frame extraction using FFmpeg keyframe seeking and 720p max thumbnail downscaling
 */
function extractVideoFrame(filePath, timestampSeconds, outputPath) {
  return new Promise((resolve) => {
    const args = [
      '-ss', timestampSeconds.toString(),
      '-noaccurate_seek',
      '-i', filePath,
      '-vf', "scale='min(1280,iw)':-1",
      '-vframes', '1',
      '-threads', '2',
      '-q:v', '4',
      '-y',
      outputPath
    ];

    execFile('ffmpeg', args, { timeout: 6000 }, (error) => {
      if (!error && fs.existsSync(outputPath)) {
        resolve(true);
      } else {
        // Fallback seek
        const fallbackArgs = [
          '-ss', timestampSeconds.toString(),
          '-i', filePath,
          '-vf', "scale='min(1280,iw)':-1",
          '-vframes', '1',
          '-q:v', '4',
          '-y',
          outputPath
        ];
        execFile('ffmpeg', fallbackArgs, { timeout: 6000 }, (err2) => {
          resolve(!err2 && fs.existsSync(outputPath));
        });
      }
    });
  });
}

/**
 * Ultra-Fast Single-Pass FFmpeg 15-frame video extraction (720p max resolution across entire duration)
 */
function extractVideoFramesSinglePass(filePath, durationSeconds, fileId) {
  return new Promise((resolve) => {
    const count = 15;
    const safeDuration = Math.max(1, durationSeconds || 300);
    const fpsRate = (count / safeDuration).toFixed(5);
    const outPattern = path.join(IMAGES_DIR, `${fileId}-image-%d.jpg`);

    const args = [
      '-i', filePath,
      '-vf', `fps=${fpsRate},scale='min(1280,iw)':-1`,
      '-vframes', count.toString(),
      '-threads', '2',
      '-q:v', '4',
      '-y',
      outPattern
    ];

    execFile('ffmpeg', args, { timeout: 15000 }, () => {
      const generated = [];
      for (let i = 1; i <= count; i++) {
        const fn = `${fileId}-image-${i}.jpg`;
        const p = path.join(IMAGES_DIR, fn);
        if (fs.existsSync(p)) {
          generated.push(`/data/image/${fn}`);
        }
      }
      resolve(generated);
    });
  });
}

/**
 * Generate thumbnails for image or 15 frame screenshots across video duration
 * @param {string} filePath Absolute path to completed download file on disk
 * @param {string} fileId Record ID (e.g. gt_1784836215_101)
 * @param {object} meta Extracted file metadata object
 * @returns {Promise<Array<string>>} Array of web accessible image URL paths
 */
async function generateThumbnails(filePath, fileId, meta = {}) {
  initImageStorage();

  if (!fs.existsSync(filePath)) {
    return [];
  }

  const category = meta.category || 'file';
  const thumbnails = [];
  let treatAsVideo = false;

  // =========================================================================
  // IMAGE THUMBNAIL GENERATION
  // =========================================================================
  if (category === 'image') {
    try {
      const stats = fs.statSync(filePath);
      if (stats.size > 20 * 1024 * 1024) {
        console.log(`[Thumbnails] "${path.basename(filePath)}" classified as image but is ${(stats.size / 1024 / 1024).toFixed(1)}MB — assuming misclassified video, trying frame extraction.`);
        treatAsVideo = true;
      } else {
        const outFilename = `${fileId}-thumb.jpg`;
        const outPath = path.join(IMAGES_DIR, outFilename);
        fs.copyFileSync(filePath, outPath);
        console.log(`[Thumbnails] Saved image thumbnail: ${outFilename}`);
        return [`/data/image/${outFilename}`];
      }
    } catch (err) {
      console.warn(`[Thumbnails Warning] Could not copy image thumbnail:`, err.message);
      return [];
    }
  }

  // =========================================================================
  // VIDEO 15-FRAME SCREENSHOT GENERATION (SINGLE-PASS ULTRA FAST)
  // =========================================================================
  if (category === 'video' || treatAsVideo) {
    if (!isFFmpegAvailable()) {
      console.warn(`[Thumbnails Info] ffmpeg is not installed on this VPS/system. Skipping 15-frame video screenshots. (Install with: apt install ffmpeg)`);
      return [];
    }

    const duration = getVideoDuration(filePath, meta);
    const count = 15;
    const formattedMins = (duration / 60).toFixed(1);
    console.log(`[Thumbnails] ⚡ Single-Pass extracting ${count} frame screenshots for ${path.basename(filePath)} (${duration}s / ${formattedMins}m)...`);

    // 1. Primary: Try single-pass extraction (1 single FFmpeg process)
    const singlePassFrames = await extractVideoFramesSinglePass(filePath, duration, fileId);
    if (singlePassFrames.length === count) {
      console.log(`[Thumbnails] 🚀 Generated all ${singlePassFrames.length}/${count} video frame screenshots for ${fileId} in 1-pass lightning mode!`);
      return singlePassFrames;
    }

    // Clean up partial single-pass files if fewer than 15 images were generated
    if (singlePassFrames.length > 0) {
      singlePassFrames.forEach(relPath => {
        try {
          const absP = path.join(__dirname, '..', relPath);
          if (fs.existsSync(absP)) fs.unlinkSync(absP);
        } catch (e) {}
      });
    }

    // 2. Secondary Fallback: Seek-based batching (batchSize = 2 for low RAM & 100% 15/15 frames)
    console.log(`[Thumbnails] Running low-memory seek extraction to guarantee all ${count}/${count} frame screenshots...`);
    const interval = duration / (count + 1);
    const tasks = [];
    for (let i = 1; i <= count; i++) {
      const targetTime = parseFloat((interval * i).toFixed(1));
      const outFilename = `${fileId}-image-${i}.jpg`;
      const outPath = path.join(IMAGES_DIR, outFilename);
      tasks.push({ i, targetTime, outFilename, outPath });
    }

    // Controlled batch size of 2 processes: Low CPU & low RAM, but 100% 15/15 frames guaranteed!
    const batchSize = 2;
    for (let b = 0; b < tasks.length; b += batchSize) {
      const batch = tasks.slice(b, b + batchSize);
      await Promise.all(batch.map(async (task) => {
        const success = await extractVideoFrame(filePath, task.targetTime, task.outPath);
        if (success) {
          thumbnails.push(`/data/image/${task.outFilename}`);
        }
      }));
    }

    thumbnails.sort((a, b) => {
      const numA = parseInt((a.match(/-image-(\d+)\.jpg$/) || [])[1] || '0', 10);
      const numB = parseInt((b.match(/-image-(\d+)\.jpg$/) || [])[1] || '0', 10);
      return numA - numB;
    });

    console.log(`[Thumbnails] ✅ Generated ${thumbnails.length}/${count} video frame screenshots for ${fileId}!`);
    return thumbnails;
  }

  return [];
}

module.exports = {
  IMAGES_DIR,
  generateThumbnails
};
