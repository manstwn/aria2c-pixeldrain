const fs = require('fs');
const path = require('path');
require('dotenv').config();

const DATA_DIR = process.env.DATA_DIR || './data';
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
const FILES_JSON_PATH = path.join(DATA_DIR, 'files.json');

// Ensure required directories and files exist
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
  const queuePath = path.join(DATA_DIR, 'queue.json');
  if (!fs.existsSync(queuePath)) {
    fs.writeFileSync(queuePath, JSON.stringify([], null, 2), 'utf8');
  }
}

const metadataModule = require('./metadata');

function getAllFiles() {
  initStorage();
  try {
    const data = fs.readFileSync(FILES_JSON_PATH, 'utf8');
    const files = JSON.parse(data || '[]');

    return files.map(file => {
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
      return file;
    });
  } catch (err) {
    console.error('Error reading files.json:', err);
    return [];
  }
}

function saveAllFiles(files) {
  initStorage();
  fs.writeFileSync(FILES_JSON_PATH, JSON.stringify(files, null, 2), 'utf8');
}

function getFileById(id) {
  const files = getAllFiles();
  return files.find(f => f.id === id);
}

function generateId() {
  const timestamp = Date.now();
  const random = Math.floor(100 + Math.random() * 900);
  return `gt_${timestamp}_${random}`;
}

function addFile(record) {
  const files = getAllFiles();
  const now = new Date().toISOString();
  const thumbs = record.thumbnails || [];
  const defaultThumb = thumbs.length > 0 ? thumbs[0] : '';

  const newRecord = {
    id: record.id || generateId(),
    filename: record.filename || record.original_filename || 'unknown_file',
    custom_name: record.custom_name || '',
    original_filename: record.original_filename || record.filename || '',
    source_url: record.source_url || '',
    pixeldrain_id: record.pixeldrain_id || '',
    download_url: record.download_url || '',
    admin_code: record.admin_code || '',
    created_at: record.created_at || now,
    last_touched: record.last_touched || now,
    status: record.status || 'LIVE',
    metadata: record.metadata || null,
    thumbnails: thumbs,
    selected_thumbnail: record.selected_thumbnail || defaultThumb
  };

  files.unshift(newRecord);
  saveAllFiles(files);
  return newRecord;
}

function updateFile(id, updates) {
  const files = getAllFiles();
  const index = files.findIndex(f => f.id === id);
  if (index === -1) return null;

  files[index] = {
    ...files[index],
    ...updates
  };
  saveAllFiles(files);
  return files[index];
}

function setFileThumbnail(id, thumbnailUrl) {
  return updateFile(id, { selected_thumbnail: thumbnailUrl });
}

function deleteFile(id) {
  const files = getAllFiles();
  const filtered = files.filter(f => f.id !== id);
  if (filtered.length !== files.length) {
    saveAllFiles(filtered);
    return true;
  }
  return false;
}

initStorage();

const QUEUE_JSON_PATH = path.join(DATA_DIR, 'queue.json');

function getAllQueue() {
  initStorage();
  try {
    const data = fs.readFileSync(QUEUE_JSON_PATH, 'utf8');
    return JSON.parse(data || '[]');
  } catch (err) {
    console.error('Error reading queue.json:', err);
    return [];
  }
}

function saveAllQueue(queueItems) {
  initStorage();
  fs.writeFileSync(QUEUE_JSON_PATH, JSON.stringify(queueItems, null, 2), 'utf8');
}

function addToQueue(item) {
  const queue = getAllQueue();
  const now = new Date().toISOString();
  const id = `q_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`;
  const newItem = {
    id,
    gid: item.gid || '',
    url: item.url || '',
    custom_name: item.custom_name || '',
    filename: item.filename || item.custom_name || (item.url ? path.basename(item.url.split('?')[0]) : 'Queued Item'),
    status: item.status || 'QUEUED',
    created_at: now
  };
  queue.push(newItem);
  saveAllQueue(queue);
  return newItem;
}

function updateQueueItem(idOrGid, updates) {
  const queue = getAllQueue();
  const index = queue.findIndex(q => q.id === idOrGid || (q.gid && q.gid === idOrGid));
  if (index === -1) return null;
  queue[index] = { ...queue[index], ...updates };
  saveAllQueue(queue);
  return queue[index];
}

function removeFromQueue(idOrGid) {
  const queue = getAllQueue();
  const filtered = queue.filter(q => q.id !== idOrGid && (q.gid ? q.gid !== idOrGid : true));
  if (filtered.length !== queue.length) {
    saveAllQueue(filtered);
    return true;
  }
  return false;
}

function clearQueue() {
  saveAllQueue([]);
  return true;
}

module.exports = {
  DATA_DIR,
  DOWNLOADS_DIR,
  FILES_JSON_PATH,
  QUEUE_JSON_PATH,
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
  clearQueue
};
