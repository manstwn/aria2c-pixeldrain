const { S3Client } = require('@aws-sdk/client-s3');
require('dotenv').config();

let s3ClientInstance = null;

/**
 * Check if all required S3 credentials are configured in environment
 */
function isS3Configured() {
  const endpoint = (process.env.S3_ENDPOINT || '').trim();
  const accessKey = (process.env.S3_ACCESS_KEY_ID || '').trim();
  const secretKey = (process.env.S3_SECRET_ACCESS_KEY || '').trim();
  const bucket = (process.env.S3_BUCKET || '').trim();

  return Boolean(endpoint && accessKey && secretKey && bucket);
}

/**
 * Retrieve the configured S3 bucket name
 */
function getBucket() {
  return (process.env.S3_BUCKET || '').trim();
}

/**
 * Retrieve normalized folder prefix (defaults to 'aria2c')
 * Always ends with a forward slash if not empty
 */
function getFolderPrefix() {
  let prefix = (process.env.S3_FOLDER_PREFIX || 'aria2c').trim();
  prefix = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  return prefix ? `${prefix}/` : 'aria2c/';
}

/**
 * Get or initialize the singleton S3 client
 */
function getS3Client() {
  if (!isS3Configured()) {
    return null;
  }

  if (!s3ClientInstance) {
    const endpoint = (process.env.S3_ENDPOINT || '').trim();
    const region = (process.env.S3_REGION || 'us-east-1').trim();
    const accessKeyId = (process.env.S3_ACCESS_KEY_ID || '').trim();
    const secretAccessKey = (process.env.S3_SECRET_ACCESS_KEY || '').trim();

    s3ClientInstance = new S3Client({
      endpoint,
      region,
      credentials: {
        accessKeyId,
        secretAccessKey
      },
      forcePathStyle: true // Required for iDrive e2, MinIO, and path-style S3 buckets
    });
  }

  return s3ClientInstance;
}

module.exports = {
  getS3Client,
  isS3Configured,
  getBucket,
  getFolderPrefix
};
