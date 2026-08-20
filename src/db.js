const fs = require('fs');
const path = require('path');
const mongoClient = require('./mongoClient');
const metadataModule = require('./metadata');
require('dotenv').config();

const DATA_DIR = process.env.DATA_DIR || './data';
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
const FILES_JSON_PATH = path.join(DATA_DIR, 'files.json');
const QUEUE_JSON_PATH = path.join(DATA_DIR, 'queue.json');

// In-Memory Cache for ultra-fast, zero-latency synchronous access
let _filesCache = [];
let _queueCache = [];
let _isInitialized = false;

/**
 * Format bytes into human readable string
 */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Ensure required storage directories and backup JSON files exist
 */
function initStorage() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  }
  if (!fs.existsSync(FILES_JSON_PATH)) {
    fs.writeFileSync(FILES_JSON_PATH, JSON.stringify([], null, 2), 'utf8');
  }
  if (!fs.existsSync(QUEUE_JSON_PATH)) {
    fs.writeFileSync(QUEUE_JSON_PATH, JSON.stringify([], null, 2), 'utf8');
  }
}

/**
 * Load raw data from local JSON flat-files into memory
 */
function loadFromLocalJson() {
  initStorage();
  try {
    const rawFiles = fs.readFileSync(FILES_JSON_PATH, 'utf8');
    _filesCache = JSON.parse(rawFiles || '[]');
  } catch (err) {
    console.error('[DB] Error reading files.json:', err.message);
    _filesCache = [];
  }

  try {
    const rawQueue = fs.readFileSync(QUEUE_JSON_PATH, 'utf8');
    _queueCache = JSON.parse(rawQueue || '[]');
  } catch (err) {
    console.error('[DB] Error reading queue.json:', err.message);
    _queueCache = [];
  }
}

/**
 * Save memory state to local JSON files (used for backup and local mode)
 */
function syncToLocalJson() {
  try {
    initStorage();
    fs.writeFileSync(FILES_JSON_PATH, JSON.stringify(_filesCache, null, 2), 'utf8');
    fs.writeFileSync(QUEUE_JSON_PATH, JSON.stringify(_queueCache, null, 2), 'utf8');
  } catch (err) {
    console.error('[DB] Error syncing to local JSON files:', err.message);
  }
}

/**
 * Initialize Database Engine (Loads from MongoDB if connected, else flat JSON)
 */
async function initDbEngine() {
  initStorage();
  loadFromLocalJson();

  if (mongoClient.isMongoConfigured()) {
    const db = await mongoClient.connectMongo();
    if (db) {
      try {
        const filesCol = mongoClient.getFilesCollection();
        const queueCol = mongoClient.getQueueCollection();

        const mongoFiles = await filesCol.find({}).sort({ created_at: -1 }).toArray();
        const mongoQueue = await queueCol.find({}).toArray();

        // Strip MongoDB internal _id for clean representation
        const cleanFiles = mongoFiles.map(({ _id, ...doc }) => doc);
        const cleanQueue = mongoQueue.map(({ _id, ...doc }) => doc);

        if (cleanFiles.length > 0 || cleanQueue.length > 0) {
          _filesCache = cleanFiles;
          _queueCache = cleanQueue;
          console.log(`[DB] 📦 Loaded ${cleanFiles.length} file record(s) and ${cleanQueue.length} queue item(s) from MongoDB.`);
        } else if (_filesCache.length > 0) {
          // If MongoDB is empty but local JSON has records, offer auto-migration
          console.log(`[DB] ℹ️ MongoDB is currently empty. ${_filesCache.length} local JSON record(s) available for migration.`);
        }

        // Sync memory state to backup JSON
        syncToLocalJson();
      } catch (err) {
        console.error('[DB Error] Failed to load documents from MongoDB:', err.message);
      }
    }
  }

  _isInitialized = true;
}

// Initial bootstrap from local files
loadFromLocalJson();

/**
 * Enrich file record with calculated metadata and thumbnail metrics
 */
function enrichFile(file) {
  if (!file) return null;

  if (!file.metadata) {
    const ext = path.extname(file.filename || '').replace('.', '').toLowerCase();
    const category = metadataModule.getCategory(ext);
    file.metadata = {
      size_bytes: 0,
      size_formatted: 'N/A',
      category: category,
      extension: ext || 'file',
      source_url: file.source_url || '',
      resolution: '',
      width: null,
      height: null,
      duration_formatted: ''
    };
  }

  // Calculate total thumbnail count & consumed disk size
  let totalThumbBytes = 0;
  const thumbs = file.thumbnails || [];
  thumbs.forEach(thumbRelPath => {
    try {
      const absolutePath = path.join(__dirname, '..', thumbRelPath);
      if (fs.existsSync(absolutePath)) {
        totalThumbBytes += fs.statSync(absolutePath).size;
      }
    } catch (e) {}
  });

  file.thumbnail_count = thumbs.length;
  file.thumbnail_size_bytes = totalThumbBytes;
  file.thumbnail_size_formatted = formatBytes(totalThumbBytes);

  return file;
}

/**
 * Generate unique database record ID
 */
function generateId() {
  const timestamp = Date.now();
  const random = Math.floor(100 + Math.random() * 900);
  return `gt_${timestamp}_${random}`;
}

// ===========================================================================
// FILES REPOSITORY METHODS
// ===========================================================================

function getAllFiles() {
  return _filesCache.map(file => enrichFile({ ...file }));
}

function getFileById(id) {
  const file = _filesCache.find(f => f.id === id);
  return file ? enrichFile({ ...file }) : null;
}

function addFile(record) {
  const now = new Date().toISOString();
  const thumbs = record.thumbnails || [];
  const defaultThumb = thumbs.length > 0 ? thumbs[0] : '';

  const newRecord = {
    id: record.id || generateId(),
    filename: record.filename || record.original_filename || 'unknown_file',
    custom_name: record.custom_name || '',
    original_filename: record.original_filename || record.filename || '',
    source_url: record.source_url || '',
    engine: record.engine || (record.metadata && record.metadata.engine) || 'aria2',
    pixeldrain_id: record.pixeldrain_id || '',
    download_url: record.download_url || '',
    admin_code: record.admin_code || '',
    created_at: record.created_at || now,
    last_touched: record.last_touched || now,
    status: record.status || 'LIVE',
    tags: Array.isArray(record.tags) ? record.tags : [],
    metadata: record.metadata || null,
    thumbnails: thumbs,
    selected_thumbnail: record.selected_thumbnail || defaultThumb
  };

  _filesCache.unshift(newRecord);
  syncToLocalJson();

  // Async persist to MongoDB
  if (mongoClient.isMongoConnected()) {
    const filesCol = mongoClient.getFilesCollection();
    filesCol.updateOne(
      { id: newRecord.id },
      { $set: { ...newRecord } },
      { upsert: true }
    ).catch(err => {
      console.error(`[MongoDB Add Error] Failed to persist file ${newRecord.id}:`, err.message);
    });
  }

  return enrichFile({ ...newRecord });
}

function updateFile(id, updates) {
  const index = _filesCache.findIndex(f => f.id === id);
  if (index === -1) return null;

  _filesCache[index] = {
    ..._filesCache[index],
    ...updates
  };

  const updatedRecord = _filesCache[index];
  syncToLocalJson();

  // Async persist to MongoDB
  if (mongoClient.isMongoConnected()) {
    const filesCol = mongoClient.getFilesCollection();
    filesCol.updateOne(
      { id },
      { $set: updates }
    ).catch(err => {
      console.error(`[MongoDB Update Error] Failed to update file ${id}:`, err.message);
    });
  }

  return enrichFile({ ...updatedRecord });
}

function setFileThumbnail(id, thumbnailUrl) {
  return updateFile(id, { selected_thumbnail: thumbnailUrl });
}

function deleteFile(id) {
  const beforeLen = _filesCache.length;
  _filesCache = _filesCache.filter(f => f.id !== id);

  if (_filesCache.length !== beforeLen) {
    syncToLocalJson();

    // Async delete from MongoDB
    if (mongoClient.isMongoConnected()) {
      const filesCol = mongoClient.getFilesCollection();
      filesCol.deleteOne({ id }).catch(err => {
        console.error(`[MongoDB Delete Error] Failed to delete file ${id}:`, err.message);
      });
    }

    return true;
  }
  return false;
}

// ===========================================================================
// QUEUE REPOSITORY METHODS
// ===========================================================================

function getAllQueue() {
  return _queueCache.map(q => ({ ...q }));
}

function addToQueue(item) {
  const now = new Date().toISOString();
  const id = `q_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`;
  const newItem = {
    id,
    gid: item.gid || '',
    url: item.url || '',
    custom_name: item.custom_name || '',
    filename: item.filename || item.custom_name || (item.url ? path.basename(item.url.split('?')[0]) : 'Queued Item'),
    engine: item.engine || 'aria2',
    status: item.status || 'QUEUED',
    created_at: now
  };

  _queueCache.push(newItem);
  syncToLocalJson();

  // Async persist to MongoDB
  if (mongoClient.isMongoConnected()) {
    const queueCol = mongoClient.getQueueCollection();
    queueCol.updateOne(
      { id: newItem.id },
      { $set: { ...newItem } },
      { upsert: true }
    ).catch(err => {
      console.error(`[MongoDB Queue Add Error] Failed to persist queue item ${newItem.id}:`, err.message);
    });
  }

  return { ...newItem };
}

function updateQueueItem(idOrGid, updates) {
  const index = _queueCache.findIndex(q => q.id === idOrGid || (q.gid && q.gid === idOrGid));
  if (index === -1) return null;

  _queueCache[index] = { ..._queueCache[index], ...updates };
  const updatedItem = _queueCache[index];
  syncToLocalJson();

  // Async persist to MongoDB
  if (mongoClient.isMongoConnected()) {
    const queueCol = mongoClient.getQueueCollection();
    queueCol.updateOne(
      { $or: [{ id: idOrGid }, { gid: idOrGid }] },
      { $set: updates }
    ).catch(err => {
      console.error(`[MongoDB Queue Update Error] Failed to update queue item ${idOrGid}:`, err.message);
    });
  }

  return { ...updatedItem };
}

function removeFromQueue(idOrGid) {
  const beforeLen = _queueCache.length;
  _queueCache = _queueCache.filter(q => q.id !== idOrGid && (q.gid ? q.gid !== idOrGid : true));

  if (_queueCache.length !== beforeLen) {
    syncToLocalJson();

    // Async delete from MongoDB
    if (mongoClient.isMongoConnected()) {
      const queueCol = mongoClient.getQueueCollection();
      queueCol.deleteOne({ $or: [{ id: idOrGid }, { gid: idOrGid }] }).catch(err => {
        console.error(`[MongoDB Queue Delete Error] Failed to delete queue item ${idOrGid}:`, err.message);
      });
    }

    return true;
  }
  return false;
}

function clearQueue() {
  _queueCache = [];
  syncToLocalJson();

  if (mongoClient.isMongoConnected()) {
    const queueCol = mongoClient.getQueueCollection();
    queueCol.deleteMany({}).catch(err => {
      console.error('[MongoDB Queue Clear Error]', err.message);
    });
  }

  return true;
}

// ===========================================================================
// MIGRATION & STATUS HELPERS
// ===========================================================================

/**
 * Migrate all local JSON file and queue records into MongoDB
 */
async function migrateJsonToMongo() {
  if (!mongoClient.isMongoConfigured()) {
    throw new Error('MONGODB_URI is not configured in .env. Please set your MongoDB connection string first.');
  }

  const db = await mongoClient.connectMongo();
  if (!db) {
    throw new Error('Could not connect to MongoDB. Please ensure your MongoDB server or Atlas cluster is online.');
  }

  const filesCol = mongoClient.getFilesCollection();
  const queueCol = mongoClient.getQueueCollection();

  // Read latest local JSON records
  let localFiles = [];
  let localQueue = [];

  try {
    if (fs.existsSync(FILES_JSON_PATH)) {
      localFiles = JSON.parse(fs.readFileSync(FILES_JSON_PATH, 'utf8') || '[]');
    }
    if (fs.existsSync(QUEUE_JSON_PATH)) {
      localQueue = JSON.parse(fs.readFileSync(QUEUE_JSON_PATH, 'utf8') || '[]');
    }
  } catch (e) {
    throw new Error(`Failed to read local JSON files: ${e.message}`);
  }

  let filesMigrated = 0;
  let queueMigrated = 0;

  // Batch upsert files into MongoDB
  if (localFiles.length > 0) {
    const fileOps = localFiles.map(file => ({
      updateOne: {
        filter: { id: file.id },
        update: { $set: file },
        upsert: true
      }
    }));
    const res = await filesCol.bulkWrite(fileOps);
    filesMigrated = (res.upsertedCount || 0) + (res.modifiedCount || 0) + (res.matchedCount || 0);
  }

  // Batch upsert queue into MongoDB
  if (localQueue.length > 0) {
    const queueOps = localQueue.map(q => ({
      updateOne: {
        filter: { id: q.id },
        update: { $set: q },
        upsert: true
      }
    }));
    const resQ = await queueCol.bulkWrite(queueOps);
    queueMigrated = (resQ.upsertedCount || 0) + (resQ.modifiedCount || 0) + (resQ.matchedCount || 0);
  }

  // Reload cache from MongoDB
  const mongoFiles = await filesCol.find({}).sort({ created_at: -1 }).toArray();
  const mongoQueue = await queueCol.find({}).toArray();

  _filesCache = mongoFiles.map(({ _id, ...doc }) => doc);
  _queueCache = mongoQueue.map(({ _id, ...doc }) => doc);

  console.log(`[DB Migration] ✅ Migrated ${filesMigrated} file(s) and ${queueMigrated} queue item(s) to MongoDB collection.`);

  return {
    success: true,
    filesMigrated,
    queueMigrated,
    totalFiles: _filesCache.length,
    totalQueue: _queueCache.length,
    dbName: mongoClient.getMongoDbName()
  };
}

/**
 * Get current Database Engine & Connection Status
 */
function getDbStatus() {
  const isMongo = mongoClient.isMongoConnected();
  const configured = mongoClient.isMongoConfigured();

  return {
    engine: isMongo ? 'mongodb' : 'json',
    isMongoConfigured: configured,
    isMongoConnected: isMongo,
    mongoDbName: mongoClient.getMongoDbName(),
    mongoUriMasked: mongoClient.getMongoUriMasked(),
    filesCount: _filesCache.length,
    queueCount: _queueCache.length,
    jsonFilesPath: FILES_JSON_PATH,
    jsonQueuePath: QUEUE_JSON_PATH
  };
}

module.exports = {
  DATA_DIR,
  DOWNLOADS_DIR,
  FILES_JSON_PATH,
  QUEUE_JSON_PATH,
  initDbEngine,
  generateId,
  getAllFiles,
  getFileById,
  addFile,
  updateFile,
  setFileThumbnail,
  deleteFile,
  getAllQueue,
  addToQueue,
  updateQueueItem,
  removeFromQueue,
  clearQueue,
  migrateJsonToMongo,
  getDbStatus
};
