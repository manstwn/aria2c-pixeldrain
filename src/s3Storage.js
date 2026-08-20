const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, HeadObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const s3Client = require('./s3Client');

const LOCAL_IMAGES_DIR = path.resolve(__dirname, '../data/image');

/**
 * Format bytes into human readable format
 */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Test S3 connectivity with configured credentials and bucket
 */
async function testS3Connection() {
  if (!s3Client.isS3Configured()) {
    const missing = [];
    if (!process.env.S3_ENDPOINT) missing.push('S3_ENDPOINT');
    if (!process.env.S3_ACCESS_KEY_ID) missing.push('S3_ACCESS_KEY_ID');
    if (!process.env.S3_SECRET_ACCESS_KEY) missing.push('S3_SECRET_ACCESS_KEY');
    if (!process.env.S3_BUCKET) missing.push('S3_BUCKET');
    return {
      success: false,
      error: `Missing required environment variable(s): ${missing.join(', ')}`,
      details: 'Please fill in all S3 keys in your .env file.'
    };
  }

  const startTime = Date.now();
  const s3 = s3Client.getS3Client();
  const bucket = s3Client.getBucket();
  const folderPrefix = s3Client.getFolderPrefix();

  try {
    const command = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: folderPrefix,
      MaxKeys: 1
    });

    await s3.send(command);
    const latency = Date.now() - startTime;

    return {
      success: true,
      bucket,
      folderPrefix,
      latencyMs: latency,
      message: `Connection successful! Reached S3 bucket "${bucket}" with folder prefix "${folderPrefix}" (${latency}ms).`
    };
  } catch (err) {
    const latency = Date.now() - startTime;
    return {
      success: false,
      bucket,
      latencyMs: latency,
      error: err.name || 'S3ConnectionError',
      message: err.message || 'Failed to connect to S3 endpoint.',
      code: err.$metadata?.httpStatusCode || 500,
      details: `Endpoint: ${process.env.S3_ENDPOINT || 'N/A'}, Region: ${process.env.S3_REGION || 'us-east-1'}`
    };
  }
}

/**
 * Upload a local image file to S3 under the configured folder prefix (e.g. aria2c/<filename>)
 * @param {string} localFilePath Absolute path to local image
 * @param {string} filename Base filename (e.g. gt_1784845422811_393-image-1.jpg)
 * @returns {Promise<{ key: string, success: boolean }>}
 */
async function uploadImageToS3(localFilePath, filename) {
  if (!s3Client.isS3Configured()) {
    throw new Error('S3 is not configured. Please set S3 credentials in .env.');
  }

  if (!fs.existsSync(localFilePath)) {
    throw new Error(`Local file not found for S3 upload: ${localFilePath}`);
  }

  const s3 = s3Client.getS3Client();
  const bucket = s3Client.getBucket();
  const folderPrefix = s3Client.getFolderPrefix();
  const s3Key = `${folderPrefix}${filename}`;
  const contentType = mime.lookup(filename) || 'image/jpeg';

  const fileStream = fs.createReadStream(localFilePath);

  try {
    const upload = new Upload({
      client: s3,
      params: {
        Bucket: bucket,
        Key: s3Key,
        Body: fileStream,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable'
      },
      queueSize: 1,
      partSize: 5 * 1024 * 1024
    });

    await upload.done();

    try {
      fileStream.destroy();
    } catch (e) {}

    return { success: true, key: s3Key, filename };
  } catch (err) {
    try {
      fileStream.destroy();
    } catch (e) {}
    throw new Error(`S3 upload error for ${s3Key}: ${err.message}`);
  }
}

/**
 * Stream an image object from S3 for masked server proxying
 * @param {string} filename Base filename (e.g. gt_1784845422811_393-image-1.jpg)
 * @returns {Promise<{ stream: ReadableStream, contentType: string, contentLength: number }>}
 */
async function getImageStreamFromS3(filename) {
  if (!s3Client.isS3Configured()) {
    return null;
  }

  const s3 = s3Client.getS3Client();
  const bucket = s3Client.getBucket();
  const folderPrefix = s3Client.getFolderPrefix();
  const s3Key = `${folderPrefix}${filename}`;

  try {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: s3Key
    });

    const response = await s3.send(command);

    return {
      stream: response.Body,
      contentType: response.ContentType || mime.lookup(filename) || 'image/jpeg',
      contentLength: response.ContentLength
    };
  } catch (err) {
    if (err.$metadata?.httpStatusCode === 404 || err.name === 'NoSuchKey' || err.name === 'NotFound') {
      return null;
    }
    console.error(`[S3 Storage Error] Failed to get object ${s3Key}:`, err.message);
    throw err;
  }
}

/**
 * Delete a single image from S3
 * @param {string} filename Base filename
 */
async function deleteImageFromS3(filename) {
  if (!s3Client.isS3Configured() || !filename) return false;

  const s3 = s3Client.getS3Client();
  const bucket = s3Client.getBucket();
  const folderPrefix = s3Client.getFolderPrefix();
  const s3Key = `${folderPrefix}${filename}`;

  try {
    const command = new DeleteObjectCommand({
      Bucket: bucket,
      Key: s3Key
    });
    await s3.send(command);
    return true;
  } catch (err) {
    console.warn(`[S3 Storage Warning] Failed to delete ${s3Key}:`, err.message);
    return false;
  }
}

/**
 * Delete all thumbnails associated with a file record from S3
 * @param {object} fileRecord Database record object
 */
async function deleteFileThumbnailsFromS3(fileRecord) {
  if (!fileRecord || !s3Client.isS3Configured()) return false;

  const thumbs = fileRecord.thumbnails || [];
  const s3 = s3Client.getS3Client();
  const bucket = s3Client.getBucket();
  const folderPrefix = s3Client.getFolderPrefix();

  const keysToDelete = [];

  thumbs.forEach(thumbPath => {
    const fn = path.basename(thumbPath);
    if (fn) {
      keysToDelete.push({ Key: `${folderPrefix}${fn}` });
    }
  });

  if (keysToDelete.length === 0) return true;

  try {
    const command = new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: keysToDelete,
        Quiet: true
      }
    });
    await s3.send(command);
    return true;
  } catch (err) {
    console.warn(`[S3 Storage Warning] Error batch deleting thumbnails from S3:`, err.message);
    return false;
  }
}

/**
 * Migration tool: Sync and push all existing local images from data/image to S3 under /aria2c folder,
 * then safely delete the local files to free up disk space.
 * @param {function} onProgress Optional progress callback ({ current, total, filename, percent, status })
 * @returns {Promise<{ total: number, uploaded: number, failed: number, freedBytes: number, errors: Array }>}
 */
async function syncAllLocalImagesToS3(onProgress = null) {
  if (!s3Client.isS3Configured()) {
    throw new Error('Cannot sync to S3: S3 credentials are not configured in .env.');
  }

  if (!fs.existsSync(LOCAL_IMAGES_DIR)) {
    return { total: 0, uploaded: 0, failed: 0, freedBytes: 0, errors: [] };
  }

  const allFiles = fs.readdirSync(LOCAL_IMAGES_DIR);
  const imageFiles = allFiles.filter(f => {
    const ext = path.extname(f).toLowerCase();
    return ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
  });

  const total = imageFiles.length;
  let uploaded = 0;
  let failed = 0;
  let freedBytes = 0;
  const errors = [];

  console.log(`[S3 Sync] 🚀 Starting migration of ${total} local image(s) to S3 folder "${s3Client.getFolderPrefix()}"...`);

  for (let i = 0; i < total; i++) {
    const filename = imageFiles[i];
    const localPath = path.join(LOCAL_IMAGES_DIR, filename);

    if (onProgress) {
      onProgress({
        current: i + 1,
        total,
        filename,
        percent: Math.round(((i) / total) * 100),
        status: `Uploading ${filename} (${i + 1}/${total})...`
      });
    }

    try {
      if (!fs.existsSync(localPath)) continue;
      const stats = fs.statSync(localPath);
      const fileSize = stats.size;

      // Upload to S3
      await uploadImageToS3(localPath, filename);

      // Safe local deletion after confirmed upload
      try {
        fs.unlinkSync(localPath);
        freedBytes += fileSize;
      } catch (unlinkErr) {
        console.warn(`[S3 Sync Warning] Uploaded to S3 but could not delete local file ${filename}:`, unlinkErr.message);
      }

      uploaded++;
      console.log(`[S3 Sync] [${i + 1}/${total}] ✅ Migrated & deleted local file: ${filename} (${formatBytes(fileSize)})`);

    } catch (uploadErr) {
      failed++;
      errors.push({ filename, error: uploadErr.message });
      console.error(`[S3 Sync] [${i + 1}/${total}] ❌ Failed to migrate ${filename}:`, uploadErr.message);
    }
  }

  if (onProgress) {
    onProgress({
      current: total,
      total,
      filename: '',
      percent: 100,
      status: `Sync complete! ${uploaded} uploaded, ${failed} failed, ${formatBytes(freedBytes)} disk space freed.`
    });
  }

  console.log(`[S3 Sync] 🏁 Finished migration: ${uploaded} uploaded, ${failed} failed. Freed ${formatBytes(freedBytes)} from disk.`);

  return {
    total,
    uploaded,
    failed,
    freedBytes,
    freedBytesFormatted: formatBytes(freedBytes),
    errors
  };
}

/**
 * Get S3 configuration and local image storage status
 */
function getS3Status() {
  const configured = s3Client.isS3Configured();
  const bucket = s3Client.getBucket();
  const folderPrefix = s3Client.getFolderPrefix();

  let localImageCount = 0;
  let localImageSizeBytes = 0;

  if (fs.existsSync(LOCAL_IMAGES_DIR)) {
    try {
      const files = fs.readdirSync(LOCAL_IMAGES_DIR);
      files.forEach(f => {
        const ext = path.extname(f).toLowerCase();
        if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
          localImageCount++;
          const p = path.join(LOCAL_IMAGES_DIR, f);
          localImageSizeBytes += fs.statSync(p).size;
        }
      });
    } catch (e) {}
  }

  return {
    configured,
    bucket,
    folderPrefix,
    localImageCount,
    localImageSizeBytes,
    localImageSizeFormatted: formatBytes(localImageSizeBytes)
  };
}

module.exports = {
  uploadImageToS3,
  getImageStreamFromS3,
  deleteImageFromS3,
  deleteFileThumbnailsFromS3,
  syncAllLocalImagesToS3,
  getS3Status,
  testS3Connection,
  formatBytes
};

