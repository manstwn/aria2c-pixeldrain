/* ==========================================================================
   PIXELTOUCH MANAGER - DEDICATED CINEMA WATCH SCRIPT (watch.js)
   ========================================================================== */

let currentPin = '';
let currentFile = null;
let currentFileId = null;

document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  currentFileId = urlParams.get('id');

  checkAuth();

  const pinInput = document.getElementById('pinInput');
  if (pinInput) {
    pinInput.addEventListener('input', (e) => {
      currentPin = e.target.value;
      updatePinDots();
    });
  }

  setupKeyboardShortcuts();
});

function updatePinDots() {
  const dots = document.querySelectorAll('.pin-dots .dot');
  dots.forEach((dot, index) => {
    if (index < currentPin.length) {
      dot.classList.add('filled');
    } else {
      dot.classList.remove('filled');
    }
  });
  document.getElementById('pinInput').value = currentPin;
}

function appendPin(digit) {
  if (currentPin.length < 12) {
    currentPin += digit;
    updatePinDots();
  }
}

function clearPin() {
  currentPin = '';
  updatePinDots();
  document.getElementById('authError').classList.add('hidden');
}

async function handlePinSubmit(e) {
  if (e) e.preventDefault();
  if (!currentPin) return;

  const errorEl = document.getElementById('authError');
  errorEl.classList.add('hidden');

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: currentPin })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      showDashboard();
    } else {
      errorEl.textContent = data.error || 'Invalid PIN code';
      errorEl.classList.remove('hidden');
      clearPin();
    }
  } catch (err) {
    errorEl.textContent = 'Connection error. Try again.';
    errorEl.classList.remove('hidden');
  }
}

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/check');
    if (res.ok) {
      const data = await res.json();
      if (data.authenticated) {
        showDashboard();
        return;
      }
    }
  } catch (e) {}
  showLogin();
}

function showLogin() {
  document.getElementById('authOverlay').classList.remove('hidden');
  document.getElementById('mainDashboard').classList.add('hidden');
}

function showDashboard() {
  document.getElementById('authOverlay').classList.add('hidden');
  document.getElementById('mainDashboard').classList.remove('hidden');
  loadVideoDetails();
}

async function handleLogout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (e) {}
  showLogin();
}

/* ==========================================================================
   LOAD VIDEO DETAILS & INITIALIZE PLAYER
   ========================================================================== */

async function loadVideoDetails() {
  if (!currentFileId) {
    showToast('No video ID specified in URL.', 'error');
    document.getElementById('videoTitle').textContent = 'No Video Selected';
    return;
  }

  try {
    const res = await fetch('/api/files');
    if (res.status === 401) {
      showLogin();
      return;
    }

    const data = await res.json();
    const files = data.files || [];
    currentFile = files.find(f => f.id === currentFileId);

    if (!currentFile) {
      document.getElementById('videoTitle').textContent = 'Video Not Found';
      showToast('Requested video record was not found in database.', 'error');
      return;
    }

    const displayName = currentFile.custom_name || currentFile.filename;
    document.title = `${displayName} | PixelTouch Cinema`;
    document.getElementById('videoTitle').textContent = displayName;

    // Set up Video Source via Proxy Endpoint with HLS.js support for MPEG-TS & MP4 streams
    const videoUrl = `/api/video/${currentFile.id}`;
    const player = document.getElementById('mainVideoPlayer');

    if (window.Hls && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true
      });
      hls.loadSource(videoUrl);
      hls.attachMedia(player);
      hls.on(Hls.Events.ERROR, function (event, data) {
        if (data.fatal) {
          console.warn('[HLS.js] Fatal error on stream, attempting native fallback:', data);
          hls.destroy();
          player.src = videoUrl;
        }
      });
    } else if (player.canPlayType('application/vnd.apple.mpegurl')) {
      player.src = videoUrl;
    } else {
      player.src = videoUrl;
    }

    player.onerror = () => {
      const err = player.error;
      console.error('[Video Player Error]', err);
      let errMsg = 'Failed to load video stream.';
      if (err) {
        if (err.code === 1) errMsg = 'Video playback aborted by user.';
        else if (err.code === 2) errMsg = 'Network error while downloading video stream.';
        else if (err.code === 3) errMsg = 'Video decoding failed or media corrupt.';
        else if (err.code === 4) errMsg = 'Video format not supported or stream returned 404/401 error.';
      }
      showToast('⚠️ ' + errMsg, 'error');
      const sub = document.getElementById('videoSub');
      if (sub) sub.textContent = '⚠️ Player Error: ' + errMsg;
    };

    // Populate Sidebar Details
    const meta = currentFile.metadata || {};
    document.getElementById('specCat').textContent = meta.category || 'Video';
    document.getElementById('specSize').textContent = meta.size_formatted || (meta.size_bytes ? formatBytes(meta.size_bytes) : 'N/A');
    document.getElementById('specDuration').textContent = meta.duration_formatted || (meta.duration_seconds ? `${meta.duration_seconds}s` : 'N/A');
    document.getElementById('specRes').textContent = meta.resolution || (meta.width && meta.height ? `${meta.width}x${meta.height}` : 'N/A');
    document.getElementById('specStatus').textContent = currentFile.status || 'LIVE';
    document.getElementById('specTouched').textContent = formatRelativeTime(currentFile.last_touched);
    document.getElementById('specCreated').textContent = formatUTC(currentFile.created_at);

    // Populate Tags
    const tagsEl = document.getElementById('specTags');
    if (tagsEl) {
      if (currentFile.tags && currentFile.tags.length > 0) {
        tagsEl.innerHTML = currentFile.tags.map(t => `<span class="file-tag-pill" style="font-size: 0.7rem; padding: 2px 8px;">🏷️ ${escapeHtml(t)}</span>`).join('');
      } else {
        tagsEl.innerHTML = `<span style="font-size: 0.775rem; color: var(--text-muted); font-style: italic;">No tags</span>`;
      }
    }

    const externalLink = document.getElementById('linkExternalPixeldrain');
    if (externalLink && currentFile.download_url) {
      externalLink.href = currentFile.download_url;
    }

  } catch (err) {
    console.error('Error loading video details:', err);
    showToast('Failed to load video details', 'error');
  }
}

/* ==========================================================================
   KEYBOARD SHORTCUTS & PLAYER CONTROLS
   ========================================================================== */

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const player = document.getElementById('mainVideoPlayer');
    if (!player || document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') {
      return;
    }

    switch (e.key) {
      case ' ':
      case 'k':
      case 'K':
        e.preventDefault();
        if (player.paused) player.play();
        else player.pause();
        break;

      case 'f':
      case 'F':
        e.preventDefault();
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else if (player.requestFullscreen) {
          player.requestFullscreen();
        }
        break;

      case 'm':
      case 'M':
        e.preventDefault();
        player.muted = !player.muted;
        showToast(player.muted ? '🔇 Muted' : '🔊 Unmuted', 'info');
        break;

      case 'ArrowLeft':
        e.preventDefault();
        player.currentTime = Math.max(0, player.currentTime - 5);
        break;

      case 'ArrowRight':
        e.preventDefault();
        player.currentTime = Math.min(player.duration || 0, player.currentTime + 5);
        break;

      case 'ArrowUp':
        e.preventDefault();
        player.volume = Math.min(1, player.volume + 0.1);
        showToast(`🔊 Volume: ${Math.round(player.volume * 100)}%`, 'info');
        break;

      case 'ArrowDown':
        e.preventDefault();
        player.volume = Math.max(0, player.volume - 0.1);
        showToast(`🔉 Volume: ${Math.round(player.volume * 100)}%`, 'info');
        break;
    }
  });
}

async function touchCurrentVideo() {
  if (!currentFileId) return;
  const btn = document.getElementById('btnTouchThisFile');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`/api/files/${currentFileId}/touch`, { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast('⚡ Pixeldrain link successfully touched!', 'success');
      loadVideoDetails();
    } else {
      showToast(data.error || 'Failed to touch link', 'error');
    }
  } catch (err) {
    showToast('Error sending touch request', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function copyStreamLink() {
  if (!currentFileId) return;
  const streamUrl = `${window.location.origin}/api/video/${currentFileId}`;
  navigator.clipboard.writeText(streamUrl).then(() => {
    showToast('📋 Stream URL copied to clipboard!', 'success');
  }).catch(() => {
    showToast('Failed to copy stream URL', 'error');
  });
}

async function deleteCurrentFile() {
  if (!currentFileId || !confirm('Are you sure you want to delete this record from ledger?')) return;

  try {
    const res = await fetch(`/api/files/${currentFileId}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('Record deleted.', 'info');
      setTimeout(() => {
        window.location.href = '/gallery';
      }, 1000);
    } else {
      showToast('Failed to delete record.', 'error');
    }
  } catch (err) {
    showToast('Network error while deleting', 'error');
  }
}

/* Helper Utilities */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatUTC(dateString) {
  if (!dateString) return 'Never';
  const d = new Date(dateString);
  if (isNaN(d.getTime())) return dateString;
  const pad = n => n < 10 ? '0' + n : n;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function formatRelativeTime(dateString) {
  if (!dateString) return 'Never';
  const d = new Date(dateString);
  const diffMs = new Date() - d;
  if (isNaN(diffMs)) return dateString;
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
