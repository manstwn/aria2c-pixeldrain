const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Format raw bytes into human readable size (e.g. 14.2 MB)
 */
function formatBytes(bytes) {
  if (bytes === 0 || !bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Format duration in seconds into HH:MM:SS or MM:SS string
 */
function formatDuration(seconds) {
  if (seconds === undefined || seconds === null || isNaN(seconds) || seconds <= 0) return '';
  const secs = Math.floor(seconds);
  const hrs = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  const remainderSecs = secs % 60;

  const pad = (n) => (n < 10 ? '0' + n : '' + n);

  if (hrs > 0) {
    return `${hrs}:${pad(mins)}:${pad(remainderSecs)}`;
  }
  return `${pad(mins)}:${pad(remainderSecs)}`;
}

/**
 * Determine file category based on extension
 */
function getCategory(ext) {
  const cleanExt = (ext || '').toLowerCase().replace('.', '');
  const categories = {
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tiff', 'ico'],
    video: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'ts'],
    audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus'],
    archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'],
    document: ['pdf', 'doc', 'docx', 'txt', 'epub', 'xls', 'xlsx', 'ppt', 'pptx']
  };

  for (const [cat, exts] of Object.entries(categories)) {
    if (exts.includes(cleanExt)) return cat;
  }
  return 'file';
}

/**
 * Auto-detect file format and category from magic bytes or URL fallback
 */
function detectCategoryAndExtension(buf, filename, sourceUrl) {
  let ext = path.extname(filename).replace('.', '').toLowerCase();
  if (!ext && sourceUrl) {
    try {
      const urlPath = new URL(sourceUrl).pathname;
      ext = path.extname(urlPath).replace('.', '').toLowerCase();
    } catch (e) {}
  }

  if (buf && buf.length >= 8) {
    // PNG
    if (buf.toString('hex', 0, 8) === '89504e470d0a1a0a') {
      return { category: 'image', extension: ext || 'png' };
    }
    // JPEG
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
      return { category: 'image', extension: ext || 'jpg' };
    }
    // GIF
    if (buf.toString('ascii', 0, 4) === 'GIF8') {
      return { category: 'image', extension: ext || 'gif' };
    }
    // WEBP
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      return { category: 'image', extension: ext || 'webp' };
    }
    // MP4 / MOV (ftyp)
    if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
      return { category: 'video', extension: ext || 'mp4' };
    }
    // MKV / WEBM (Matroska)
    if (buf.length >= 4 && buf.readUInt32BE(0) === 0x1A45DFA3) {
      return { category: 'video', extension: ext || 'webm' };
    }
  }

  return { category: getCategory(ext), extension: ext || 'file' };
}

/**
 * Extract PNG dimensions from buffer
 */
function parsePNG(buf) {
  if (buf.length >= 24 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a') {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { width, height };
  }
  return null;
}

/**
 * Extract GIF dimensions from buffer
 */
function parseGIF(buf) {
  if (buf.length >= 10 && (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')) {
    const width = buf.readUInt16LE(6);
    const height = buf.readUInt16LE(8);
    return { width, height };
  }
  return null;
}

/**
 * Extract JPEG dimensions from buffer
 */
function parseJPEG(buf) {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let offset = 2;
  while (offset < buf.length) {
    if (buf[offset] !== 0xFF) break;
    const marker = buf[offset + 1];

    // SOF0, SOF1, SOF2 markers
    if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
      if (offset + 9 < buf.length) {
        const height = buf.readUInt16BE(offset + 5);
        const width = buf.readUInt16BE(offset + 7);
        return { width, height };
      }
    }
    const len = buf.readUInt16BE(offset + 2);
    offset += 2 + len;
  }
  return null;
}

/**
 * Extract WEBP dimensions from buffer
 */
function parseWEBP(buf) {
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const type = buf.toString('ascii', 12, 16);
    if (type === 'VP8 ') {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { width, height };
    } else if (type === 'VP8L') {
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { width, height };
    }
  }
  return null;
}

/**
 * Extract MP4 / MOV video dimensions and duration from buffer
 */
function parseMP4(buf) {
  let offset = 0;
  let width = 0;
  let height = 0;
  let durationSeconds = 0;

  try {
    while (offset < buf.length - 8) {
      const size = buf.readUInt32BE(offset);
      const type = buf.toString('ascii', offset + 4, offset + 8);

      if (size === 1 || size === 0) break; // extended or till end

      if (type === 'moov' || type === 'trak' || type === 'mdia' || type === 'minf' || type === 'stbl') {
        // Step inside container atom
        offset += 8;
        continue;
      }

      if (type === 'tkhd') {
        // Track Header atom
        const version = buf[offset + 8];
        const widthOffset = version === 1 ? offset + 92 : offset + 84;
        const heightOffset = widthOffset + 4;
        if (heightOffset + 4 <= buf.length) {
          const w = buf.readUInt32BE(widthOffset) >> 16;
          const h = buf.readUInt32BE(heightOffset) >> 16;
          if (w > 0 && h > 0) {
            width = w;
            height = h;
          }
        }
      }

      if (type === 'mvhd') {
        // Movie Header atom (duration)
        const version = buf[offset + 8];
        const timeScaleOffset = version === 1 ? offset + 20 : offset + 12;
        const durationOffset = timeScaleOffset + 4;
        if (durationOffset + 4 <= buf.length) {
          const timeScale = buf.readUInt32BE(timeScaleOffset);
          const duration = buf.readUInt32BE(durationOffset);
          if (timeScale > 0) {
            durationSeconds = Math.round(duration / timeScale);
          }
        }
      }

      offset += size;
    }
  } catch (e) {}

  if (width > 0 || height > 0 || durationSeconds > 0) {
    return { width: width || null, height: height || null, durationSeconds };
  }
  return null;
}

/**
 * Use ffprobe to extract accurate duration and dimensions for video files
 */
function getVideoMetadataFFprobe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration -show_entries format=duration -of json "${filePath}"`;
    const output = execSync(cmd, { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const parsed = JSON.parse(output);

    let durationSeconds = 0;
    let width = 0;
    let height = 0;

    if (parsed.format && parsed.format.duration) {
      durationSeconds = parseFloat(parsed.format.duration);
    }

    if (parsed.streams && parsed.streams[0]) {
      const stream = parsed.streams[0];
      if (stream.width && stream.height) {
        width = stream.width;
        height = stream.height;
      }
      if (!durationSeconds && stream.duration) {
        durationSeconds = parseFloat(stream.duration);
      }
    }

    if (durationSeconds > 0 || (width > 0 && height > 0)) {
      return {
        width: width || null,
        height: height || null,
        durationSeconds: Math.round(durationSeconds)
      };
    }
  } catch (e) {}
  return null;
}

/**
 * Extract full metadata for any file path
 * @param {string} filePath Absolute path to file on disk
 * @param {string} sourceUrl Optional original remote URL
 */
function extractMetadata(filePath, sourceUrl = '') {
  const filename = path.basename(filePath);
  let sizeBytes = 0;
  let headerBuf = null;

  try {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      sizeBytes = stats.size;

      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(131072);
      const bytesRead = fs.readSync(fd, buffer, 0, 131072, 0);
      fs.closeSync(fd);
      headerBuf = buffer.subarray(0, bytesRead);
    }
  } catch (e) {}

  const typeInfo = detectCategoryAndExtension(headerBuf, filename, sourceUrl);

  const meta = {
    size_bytes: sizeBytes,
    size_formatted: formatBytes(sizeBytes),
    category: typeInfo.category,
    extension: typeInfo.extension,
    source_url: sourceUrl || '',
    resolution: '',
    width: null,
    height: null,
    duration_seconds: 0,
    duration_formatted: ''
  };

  try {
    if (typeInfo.category === 'video') {
      // 1. Primary video metadata extraction via ffprobe
      const ffprobeMeta = getVideoMetadataFFprobe(filePath);
      if (ffprobeMeta) {
        if (ffprobeMeta.width && ffprobeMeta.height) {
          meta.width = ffprobeMeta.width;
          meta.height = ffprobeMeta.height;
          meta.resolution = `${ffprobeMeta.width}x${ffprobeMeta.height}`;
        }
        if (ffprobeMeta.durationSeconds) {
          meta.duration_seconds = ffprobeMeta.durationSeconds;
          meta.duration_formatted = formatDuration(ffprobeMeta.durationSeconds);
        }
      }

      // 2. Secondary fallback via header buffer parsing if ffprobe didn't get values
      if (headerBuf && (!meta.duration_formatted || !meta.resolution)) {
        const mediaInfo = parseMP4(headerBuf);
        if (mediaInfo) {
          if (!meta.resolution && mediaInfo.width && mediaInfo.height) {
            meta.width = mediaInfo.width;
            meta.height = mediaInfo.height;
            meta.resolution = `${mediaInfo.width}x${mediaInfo.height}`;
          }
          if (!meta.duration_formatted && mediaInfo.durationSeconds) {
            meta.duration_seconds = mediaInfo.durationSeconds;
            meta.duration_formatted = formatDuration(mediaInfo.durationSeconds);
          }
        }
      }
    } else if (typeInfo.category === 'image' && headerBuf) {
      const mediaInfo = parsePNG(headerBuf) || parseJPEG(headerBuf) || parseGIF(headerBuf) || parseWEBP(headerBuf);
      if (mediaInfo && mediaInfo.width && mediaInfo.height) {
        meta.width = mediaInfo.width;
        meta.height = mediaInfo.height;
        meta.resolution = `${mediaInfo.width}x${mediaInfo.height}`;
      }
    }
  } catch (err) {
    console.warn(`[Metadata Warning] Error parsing metadata for ${filename}:`, err.message);
  }

  return meta;
}

module.exports = {
  formatBytes,
  formatDuration,
  getCategory,
  extractMetadata
};

