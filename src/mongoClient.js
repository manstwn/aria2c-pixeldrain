const { MongoClient } = require('mongodb');
require('dotenv').config();

let clientInstance = null;
let dbInstance = null;
let isConnected = false;

function getRawMongoUri() {
  return (process.env.MONGODB_URI || process.env.MONGO_URI || '').trim();
}

function getMongoDbName() {
  if (process.env.MONGODB_DB_NAME || process.env.MONGO_DB_NAME) {
    return (process.env.MONGODB_DB_NAME || process.env.MONGO_DB_NAME).trim();
  }
  const uri = getRawMongoUri();
  if (uri) {
    try {
      const match = uri.match(/^mongodb(?:\+srv)?:\/\/[^\/]+\/([^?]+)/i);
      if (match && match[1]) {
        return decodeURIComponent(match[1].trim());
      }
    } catch (e) {}
  }
  return 'gotouch';
}

/**
 * Check if MongoDB URI is configured in environment
 */
function isMongoConfigured() {
  return Boolean(getRawMongoUri());
}

/**
 * Check if currently connected to MongoDB
 */
function isMongoConnected() {
  return isConnected && Boolean(dbInstance);
}

/**
 * Get masked URI for safe display in UI/logs
 */
function getMongoUriMasked() {
  const uri = getRawMongoUri();
  if (!uri) return '';
  try {
    // Mask password if present (mongodb://user:password@host...)
    return uri.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:******@');
  } catch (e) {
    return 'mongodb://[configured]';
  }
}

/**
 * Connect to MongoDB and create collection indexes
 */
async function connectMongo() {
  const uri = getRawMongoUri();
  const dbName = getMongoDbName();
  if (!uri) {
    console.log('[MongoDB] MONGO_URI / MONGODB_URI is not set. Running in Local Flat JSON mode (data/files.json).');
    return null;
  }

  if (isConnected && dbInstance) {
    return dbInstance;
  }

  try {
    console.log(`[MongoDB] 🔄 Connecting to ${getMongoUriMasked()} (database: "${dbName}")...`);
    clientInstance = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 8000,
    });

    await clientInstance.connect();
    dbInstance = clientInstance.db(dbName);
    isConnected = true;

    console.log(`[MongoDB] ✅ Connected successfully to "${dbName}"! (Inspectable via MongoDB Compass)`);


    // Ensure collections and indexes exist
    try {
      const filesCol = dbInstance.collection('files');
      await filesCol.createIndex({ id: 1 }, { unique: true });
      await filesCol.createIndex({ status: 1 });
      await filesCol.createIndex({ created_at: -1 });

      const queueCol = dbInstance.collection('queue');
      await queueCol.createIndex({ id: 1 }, { unique: true });
      await queueCol.createIndex({ gid: 1 });
      await queueCol.createIndex({ status: 1 });
    } catch (idxErr) {
      console.warn('[MongoDB Index Warning]', idxErr.message);
    }

    // Handle connection drops gracefully
    clientInstance.on('close', () => {
      isConnected = false;
      console.warn('[MongoDB] Connection closed.');
    });

    return dbInstance;
  } catch (err) {
    isConnected = false;
    dbInstance = null;
    console.error(`[MongoDB Error] Failed to connect: ${err.message}. Falling back to flat JSON.`);
    return null;
  }
}

/**
 * Get MongoDB database instance
 */
function getDb() {
  return dbInstance;
}

/**
 * Get 'files' collection
 */
function getFilesCollection() {
  if (!isMongoConnected()) return null;
  return dbInstance.collection('files');
}

/**
 * Get 'queue' collection
 */
function getQueueCollection() {
  if (!isMongoConnected()) return null;
  return dbInstance.collection('queue');
}

/**
 * Test MongoDB connectivity and measure round-trip ping latency
 */
async function testMongoConnection() {
  const uri = getRawMongoUri();
  const dbName = getMongoDbName();
  if (!uri) {
    return {
      success: false,
      error: 'MONGO_URI / MONGODB_URI is not configured in .env',
      details: 'Please set MONGO_URI=mongodb+srv://... in your .env file.'
    };
  }

  const startTime = Date.now();
  let tempClient = null;

  try {
    let activeDb = dbInstance;

    if (!activeDb || !isConnected) {
      tempClient = new MongoClient(uri, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 6000
      });
      await tempClient.connect();
      activeDb = tempClient.db(dbName);
    }

    await activeDb.command({ ping: 1 });
    const latency = Date.now() - startTime;

    if (tempClient) {
      try { await tempClient.close(); } catch (e) {}
    }

    return {
      success: true,
      dbName,
      uriMasked: getMongoUriMasked(),
      latencyMs: latency,
      message: `Connection successful! Pinged database "${dbName}" in ${latency}ms.`
    };
  } catch (err) {
    if (tempClient) {
      try { await tempClient.close(); } catch (e) {}
    }
    const latency = Date.now() - startTime;
    return {
      success: false,
      dbName,
      uriMasked: getMongoUriMasked(),
      latencyMs: latency,
      error: err.name || 'MongoConnectionError',
      message: err.message || 'Failed to connect to MongoDB server.',
      details: 'Check your host, port, username, password, or Network Access / IP Whitelist in MongoDB Atlas.'
    };
  }
}

/**
 * Close MongoDB connection
 */
async function closeMongo() {
  if (clientInstance) {
    try {
      await clientInstance.close();
    } catch (e) {}
    isConnected = false;
    dbInstance = null;
  }
}

module.exports = {
  connectMongo,
  closeMongo,
  getDb,
  getFilesCollection,
  getQueueCollection,
  isMongoConfigured,
  isMongoConnected,
  getMongoDbName,
  getMongoUriMasked,
  testMongoConnection
};

