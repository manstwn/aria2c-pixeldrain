const jwt = require('jsonwebtoken');
const crypto = require('crypto');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'gotouch_secret_key_change_in_production';
const ADMIN_PIN = process.env.ADMIN_PIN || '123456';

const SHARE_TTL_MS = 60 * 60 * 1000;
const shareSecrets = new Map();
const loginAttempts = new Map();

function createShareSecret(fileId) {
  const secret = crypto.randomBytes(24).toString('hex');
  shareSecrets.set(secret, { fileId, expiresAt: Date.now() + SHARE_TTL_MS });
  return secret;
}

function verifyShareSecret(secret, fileId) {
  if (!secret) return false;
  const entry = shareSecrets.get(secret);
  if (!entry || entry.fileId !== fileId) return false;
  if (Date.now() > entry.expiresAt) {
    shareSecrets.delete(secret);
    return false;
  }
  return true;
}

function allowLoginAttempt(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart >= 60000) {
    loginAttempts.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= 5;
}

function resetLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

function verifyPin(pin) {
  return String(pin).trim() === String(ADMIN_PIN).trim();
}

function generateToken() {
  return jwt.sign({ role: 'admin', authAt: Date.now() }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

function requireAuth(req, res, next) {
  // Check cookie or authorization header
  const token = req.cookies?.gotouch_token || (req.headers.authorization && req.headers.authorization.split(' ')[1]);

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized', message: 'PIN authentication required.' });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Session expired or invalid PIN.' });
  }

  req.user = decoded;
  next();
}

module.exports = {
  verifyPin,
  generateToken,
  verifyToken,
  requireAuth,
  createShareSecret,
  verifyShareSecret,
  allowLoginAttempt,
  resetLoginAttempts
};
