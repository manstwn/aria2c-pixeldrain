// PixelTouch Cloud Retention & Touch Manager
let currentPin = '';
let sseSource = null;
let allFiles = [];
let touchStatus = null;
let currentFilter = 'all';
let searchQuery = '';
let currentPage = 1;
const PAGE_SIZE = 25;
let autoScrollLogs = true;

// Utility formatting
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
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return 'Never';
  const now = new Date();
  const past = new Date(dateStr);
  const diffSec = Math.floor((now - past) / 1000);
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDays = Math.floor(diffHour / 24);
  return `${diffDays}d ago`;
}

// Toast Notifications
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 400);
  }, 3500);
}

// PIN Authentication
function appendPin(num) {
  if (currentPin.length < 12) {
    currentPin += num;
    updatePinDots();
    document.getElementById('pinInput').value = currentPin;
    if (currentPin.length >= 4) {
      submitPin(currentPin);
    }
  }
}

function clearPin() {
  currentPin = '';
  updatePinDots();
  document.getElementById('pinInput').value = '';
}

function updatePinDots() {
  const dots = document.querySelectorAll('.pin-dots .dot');
  dots.forEach((dot, index) => {
    if (index < currentPin.length) {
      dot.classList.add('filled');
    } else {
      dot.classList.remove('filled');
    }
  });
}

async function submitPin(pinToSubmit) {
  try {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: pinToSubmit })
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('authOverlay').classList.add('hidden');
      document.getElementById('authError').classList.add('hidden');
      initApp();
    } else {
      showAuthError();
    }
  } catch (err) {
    showAuthError();
  }
}

function showAuthError() {
  const errEl = document.getElementById('authError');
  errEl.classList.remove('hidden');
  clearPin();
  setTimeout(() => errEl.classList.add('hidden'), 3000);
}

function handlePinSubmit(e) {
  e.preventDefault();
  const inputVal = document.getElementById('pinInput').value;
  if (inputVal) {
    submitPin(inputVal);
  }
}

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/check');
    const data = await res.json();
    if (data.authenticated) {
      document.getElementById('authOverlay').classList.add('hidden');
      initApp();
    } else {
      document.getElementById('authOverlay').classList.remove('hidden');
    }
  } catch (e) {
    document.getElementById('authOverlay').classList.remove('hidden');
  }
}

async function lockSession() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.reload();
}

// SSE Stream Connection
function initSSE() {
  if (sseSource) {
    sseSource.close();
  }
  sseSource = new EventSource('/api/stream');

  sseSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.files && Array.isArray(data.files)) {
        allFiles = data.files;
      }
      if (data.touchStatus) {
        touchStatus = data.touchStatus;
        renderTouchStatus();
      }
      if (data.dataSizeFormatted) {
        document.getElementById('storageText').textContent = data.dataSizeFormatted;
      }
      renderLedger();
    } catch (err) {
      console.error('SSE parse error:', err);
    }
  };

  sseSource.onerror = () => {
    console.warn('SSE stream disconnected, retrying in 3s...');
  };
}

let pollInterval = null;

function checkPolling() {
  if (touchStatus && touchStatus.isRunning) {
    if (!pollInterval) {
      pollInterval = setInterval(fetchTouchStatus, 1000);
    }
  } else {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }
}

async function fetchTouchStatus() {
  try {
    const res = await fetch('/api/touch/status');
    const data = await res.json();
    if (data.success) {
      touchStatus = data;
      renderTouchStatus();
      renderLedger();
    }
  } catch (e) {}
}

// Render Touch Daemon Header & Active Progress
function renderTouchStatus() {
  if (!touchStatus) return;

  checkPolling();

  const isRunning = Boolean(touchStatus.isRunning);
  const badge = document.getElementById('touchStatusBadge');
  const badgeText = document.getElementById('touchStatusBadgeText');
  const btnStartDue = document.getElementById('btnStartTouchDue');
  const btnStartForce = document.getElementById('btnStartTouchForce');
  const btnStop = document.getElementById('btnStopTouch');
  const activeBox = document.getElementById('activeTaskBox');
  const dueCountEl = document.getElementById('btnDueCount');

  // Stats
  const metrics = touchStatus.metrics || {};
  document.getElementById('statDueCount').textContent = metrics.dueCount ?? 0;
  document.getElementById('statLiveCount').textContent = metrics.liveCount ?? 0;
  document.getElementById('statDeadCount').textContent = metrics.deadCount ?? 0;
  document.getElementById('statTotalCount').textContent = metrics.totalFiles ?? allFiles.length;
  document.getElementById('statIntervalDays').textContent = metrics.intervalDays ?? 20;
  if (dueCountEl) dueCountEl.textContent = metrics.dueCount ?? 0;

  // Calculate "At Risk" (> 45 days)
  let riskCount = 0;
  const now = Date.now();
  allFiles.forEach(f => {
    if (f.status !== 'DEAD') {
      const lastStr = f.last_touched || f.created_at;
      const ageMs = now - (lastStr ? new Date(lastStr).getTime() : 0);
      const ageDays = ageMs / 86400000;
      if (ageDays >= 45) riskCount++;
    }
  });
  document.getElementById('statRiskCount').textContent = riskCount;

  // Mode badge
  document.getElementById('touchModeTag').textContent = `[Threshold: ${metrics.intervalDays || 20} Days | Mode: ${touchStatus.mode || 'idle'}]`;

  if (isRunning) {
    badge.className = 'touch-status-badge running';
    badgeText.textContent = '⚡ TOUCHING IN PROGRESS';
    btnStartDue.disabled = true;
    btnStartForce.disabled = true;
    btnStartDue.style.opacity = '0.5';
    btnStartForce.style.opacity = '0.5';
    btnStop.style.display = 'inline-flex';
    activeBox.style.display = 'block';

    const curr = touchStatus.currentFile;
    if (curr) {
      document.getElementById('activeFilename').textContent = curr.filename || 'Downloading chunk...';
      const pixelLink = document.getElementById('activePageLink');
      pixelLink.href = curr.page_url || `https://pixeldrain.com/u/${curr.pixeldrain_id}`;
      document.getElementById('activePixelId').textContent = curr.pixeldrain_id || 'View';

      const totalEligible = touchStatus.totalEligible || 1;
      const currIdx = touchStatus.currentIndex || 1;
      document.getElementById('activeBatchProgress').textContent = `File ${currIdx} of ${totalEligible}`;

      document.getElementById('activeSpeed').textContent = curr.speed_formatted || '0.0 MB/s';
      document.getElementById('activeEta').textContent = curr.eta_seconds > 0 ? `ETA: ${curr.eta_seconds}s` : 'Finishing...';

      const pct = curr.percent || 0;
      document.getElementById('activeProgressBar').style.width = `${pct}%`;
      document.getElementById('activePercentText').textContent = `${pct.toFixed(1)}%`;

      const dlMB = (curr.downloaded_bytes / (1024 * 1024)).toFixed(1);
      document.getElementById('activeTransferredBytes').textContent = `${dlMB} MB`;
      document.getElementById('activeTargetBytes').textContent = curr.target_formatted || '0 MB';
    } else {
      document.getElementById('activeFilename').textContent = 'Preparing next file in queue...';
      document.getElementById('activeProgressBar').style.width = '100%';
      document.getElementById('activePercentText').textContent = '100%';
    }
  } else {
    badge.className = 'touch-status-badge idle';
    badgeText.textContent = 'DAEMON IDLE / READY';
    btnStartDue.disabled = false;
    btnStartForce.disabled = false;
    btnStartDue.style.opacity = '1';
    btnStartForce.style.opacity = '1';
    btnStartDue.style.display = 'inline-flex';
    btnStartForce.style.display = 'inline-flex';
    btnStop.style.display = 'none';
    activeBox.style.display = 'none';
  }

  // Render recent logs
  if (touchStatus.recentLogs && Array.isArray(touchStatus.recentLogs)) {
    renderLogs(touchStatus.recentLogs);
  }
}

// Render Daemon Logs Box
function renderLogs(logs) {
  const box = document.getElementById('touchLogBox');
  if (!box) return;

  if (logs.length === 0) {
    box.innerHTML = `<div class="touch-log-line info"><span class="touch-log-time">[System]</span><span class="touch-log-msg">No logs recorded yet.</span></div>`;
    return;
  }

  box.innerHTML = logs.map(l => {
    const timeStr = l.time ? new Date(l.time).toLocaleTimeString() : '';
    const typeClass = l.type || 'info';
    return `<div class="touch-log-line ${typeClass}">
      <span class="touch-log-time">[${escapeHtml(timeStr)}]</span>
      <span class="touch-log-msg">${escapeHtml(l.message)}</span>
    </div>`;
  }).join('');

  if (autoScrollLogs) {
    box.scrollTop = 0;
  }
}

function clearLogs() {
  const box = document.getElementById('touchLogBox');
  if (box) box.innerHTML = `<div class="touch-log-line info"><span class="touch-log-time">[Cleared]</span><span class="touch-log-msg">Console logs cleared.</span></div>`;
}

// Filter Tabs & Search
function setFilter(filter, el) {
  currentFilter = filter;
  currentPage = 1;
  document.querySelectorAll('.filter-pill').forEach(btn => {
    if (btn.getAttribute('data-filter') === filter) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
  renderLedger();
}

function handleSearch() {
  searchQuery = (document.getElementById('touchSearchInput').value || '').trim().toLowerCase();
  currentPage = 1;
  renderLedger();
}

function changePage(delta) {
  currentPage += delta;
  renderLedger();
}

// Render Retention Ledger Table
function renderLedger() {
  const tbody = document.getElementById('touchTableBody');
  if (!tbody) return;

  const now = Date.now();
  const intervalDays = (touchStatus && touchStatus.metrics && touchStatus.metrics.intervalDays) ? touchStatus.metrics.intervalDays : 20;

  // Calculate counts for filters
  let dueCount = 0;
  let urgentCount = 0;
  let liveCount = 0;
  let deadCount = 0;

  allFiles.forEach(f => {
    const isDead = f.status === 'DEAD';
    if (isDead) {
      deadCount++;
    } else {
      liveCount++;
      const lastStr = f.last_touched || f.created_at;
      const ageDays = (now - (lastStr ? new Date(lastStr).getTime() : 0)) / 86400000;
      if (ageDays >= intervalDays) dueCount++;
      if (ageDays >= 45) urgentCount++;
    }
  });

  document.getElementById('filterAllCount').textContent = allFiles.length;
  document.getElementById('filterDueCount').textContent = dueCount;
  document.getElementById('filterUrgentCount').textContent = urgentCount;
  document.getElementById('filterLiveCount').textContent = liveCount;
  document.getElementById('filterDeadCount').textContent = deadCount;

  // Filter items
  let filtered = allFiles.filter(file => {
    const isDead = file.status === 'DEAD';
    const lastStr = file.last_touched || file.created_at;
    const ageDays = (now - (lastStr ? new Date(lastStr).getTime() : 0)) / 86400000;

    if (currentFilter === 'due' && (isDead || ageDays < intervalDays)) return false;
    if (currentFilter === 'urgent' && (isDead || ageDays < 45)) return false;
    if (currentFilter === 'live' && isDead) return false;
    if (currentFilter === 'dead' && !isDead) return false;

    if (searchQuery) {
      const name = (file.custom_name || file.filename || file.original_filename || '').toLowerCase();
      const pid = (file.pixeldrain_id || '').toLowerCase();
      if (!name.includes(searchQuery) && !pid.includes(searchQuery)) return false;
    }

    return true;
  });

  const totalFiltered = filtered.length;
  const maxPage = Math.max(1, Math.ceil(totalFiltered / PAGE_SIZE));
  if (currentPage > maxPage) currentPage = maxPage;
  if (currentPage < 1) currentPage = 1;

  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filtered.slice(startIdx, startIdx + PAGE_SIZE);

  document.getElementById('pageStart').textContent = totalFiltered > 0 ? startIdx + 1 : 0;
  document.getElementById('pageEnd').textContent = Math.min(startIdx + PAGE_SIZE, totalFiltered);
  document.getElementById('pageTotal').textContent = totalFiltered;
  document.getElementById('pageIndicator').textContent = `${currentPage} / ${maxPage}`;

  document.getElementById('btnPrevPage').disabled = (currentPage <= 1);
  document.getElementById('btnNextPage').disabled = (currentPage >= maxPage);

  if (pageItems.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 32px; color: var(--text-muted);">No matching file records found.</td></tr>`;
    return;
  }

  tbody.innerHTML = pageItems.map(file => {
    const name = file.custom_name || file.filename || file.original_filename || 'Unknown file';
    const sizeBytes = file.metadata && file.metadata.size_bytes ? file.metadata.size_bytes : 0;
    const sizeFormatted = sizeBytes > 0 ? formatBytes(sizeBytes) : (file.metadata?.size_formatted || 'N/A');

    // File Original Age (since uploaded/created)
    const createdStr = file.created_at || file.last_touched;
    const createdRel = formatRelativeTime(createdStr);
    const fileAgeDays = createdStr ? Math.floor((now - new Date(createdStr).getTime()) / 86400000) : 0;

    // Last Touched Age
    const lastTouchedStr = file.last_touched || file.created_at;
    const lastTouchedRel = formatRelativeTime(lastTouchedStr);
    const ageDays = Math.floor((now - (lastTouchedStr ? new Date(lastTouchedStr).getTime() : 0)) / 86400000);
    const remainingDays = Math.max(0, 60 - ageDays);
    const isDead = file.status === 'DEAD';

    let urgencyBadge = '';
    if (isDead) {
      urgencyBadge = `<span class="urgency-badge dead">EXPIRED</span>`;
    } else if (remainingDays < 15) {
      urgencyBadge = `<span class="urgency-badge danger" title="Expires in ${remainingDays} days! Needs touch immediately">⚠️ ${remainingDays}d left</span>`;
    } else if (remainingDays < 30) {
      urgencyBadge = `<span class="urgency-badge warning" title="Expires in ${remainingDays} days">${remainingDays}d left</span>`;
    } else {
      urgencyBadge = `<span class="urgency-badge safe" title="Protected: expires in ${remainingDays} days">${remainingDays}d left</span>`;
    }

    const statusBadge = isDead
      ? `<span class="status-badge dead">DEAD</span>`
      : `<span class="status-badge live"><span class="dot-pulse"></span> LIVE</span>`;

    const isRunning = Boolean(touchStatus && touchStatus.isRunning);
    const isCurrentlyTouching = isRunning && touchStatus.currentFile && touchStatus.currentFile.id === file.id;

    let buttonLabel = '⚡ Touch';
    let buttonDisabled = false;
    let buttonTitle = 'Download 15% chunk to reset 60-day expiry timer';

    if (isCurrentlyTouching) {
      buttonLabel = '⚡ Downloading...';
      buttonDisabled = true;
      buttonTitle = 'This file is currently downloading';
    } else if (isRunning) {
      buttonDisabled = true;
      buttonTitle = 'Another touch operation is currently in progress. Please wait.';
    } else if (isDead) {
      buttonTitle = 'File returned 404 from Pixeldrain (already expired)';
    }

    return `<tr>
      <td>
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <strong style="color: #f1f5f9; font-size: 0.9rem; word-break: break-all;">${escapeHtml(name)}</strong>
          <div style="display: flex; align-items: center; gap: 6px;">
            <a href="https://pixeldrain.com/u/${escapeHtml(file.pixeldrain_id)}" target="_blank" class="gofile-link-badge" style="font-size: 0.72rem;">
              <span>${escapeHtml(file.pixeldrain_id)}</span> ↗
            </a>
            ${file.metadata?.resolution ? `<span class="gallery-cover-badge" style="font-size: 0.65rem; padding: 1px 5px;">${escapeHtml(file.metadata.resolution)}</span>` : ''}
            ${file.metadata?.duration_formatted ? `<span class="gallery-cover-badge" style="font-size: 0.65rem; padding: 1px 5px;">${escapeHtml(file.metadata.duration_formatted)}</span>` : ''}
          </div>
        </div>
      </td>
      <td class="mono" style="font-size: 0.85rem; color: #cbd5e1;">${sizeFormatted}</td>
      <td>
        <div style="display: flex; flex-direction: column;">
          <span style="font-size: 0.85rem; color: #e2e8f0;">${createdRel}</span>
          <span class="mono" style="font-size: 0.72rem; color: #64748b;">${fileAgeDays} day(s) old</span>
        </div>
      </td>
      <td>
        <div style="display: flex; flex-direction: column;">
          <span style="font-size: 0.85rem; color: #e2e8f0;">${lastTouchedRel}</span>
          <span class="mono" style="font-size: 0.72rem; color: #64748b;">${ageDays} day(s) ago</span>
        </div>
      </td>
      <td>${urgencyBadge}</td>
      <td>${statusBadge}</td>
      <td style="text-align: right;">
        <button type="button" class="btn-table-action" style="padding: 4px 10px; font-size: 0.75rem;" 
          onclick="touchSingleFile('${file.id}')"
          ${buttonDisabled ? 'disabled' : ''}
          title="${escapeHtml(buttonTitle)}">
          ${buttonLabel}
        </button>
      </td>
    </tr>`;
  }).join('');
}

// User Actions
async function startTouchDue() {
  if (touchStatus && touchStatus.isRunning) {
    showToast('Touch daemon is already running. Please wait.', 'warn');
    return;
  }
  const btn = document.getElementById('btnStartTouchDue');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/touch/start', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('🚀 Background touch batch started for due files!', 'success');
      fetchTouchStatus();
    } else {
      showToast(data.message || 'Touch batch already running', 'warn');
    }
  } catch (err) {
    showToast('Failed to start touch batch', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function startTouchForce() {
  if (touchStatus && touchStatus.isRunning) {
    showToast('Touch daemon is already running. Please wait.', 'warn');
    return;
  }
  if (!confirm('Force Touch will touch ALL live files regardless of how recently they were touched. Continue?')) {
    return;
  }
  const btn = document.getElementById('btnStartTouchForce');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/touch/start?force=true', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('⚡ Force touch started for ALL files in background!', 'success');
      fetchTouchStatus();
    } else {
      showToast(data.message || 'Touch batch already running', 'warn');
    }
  } catch (err) {
    showToast('Failed to start force touch', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function stopTouch() {
  const btn = document.getElementById('btnStopTouch');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/touch/stop', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('🛑 Touch process cancellation requested.', 'warn');
      setTimeout(fetchTouchStatus, 500);
    } else {
      showToast(data.message || 'Failed to stop touch', 'error');
    }
  } catch (err) {
    showToast('Error requesting touch stop', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function touchSingleFile(id) {
  if (touchStatus && touchStatus.isRunning) {
    showToast('Touch daemon is currently busy with another file. Please wait.', 'warn');
    return;
  }
  showToast('⚡ Starting 15% download for file...', 'info');
  // Trigger immediate status check to lock UI
  setTimeout(fetchTouchStatus, 300);

  try {
    const res = await fetch(`/api/files/${id}/touch`, { method: 'POST' });
    const data = await res.json();
    if (res.status === 409) {
      showToast(data.error || 'Daemon is currently busy', 'warn');
      return;
    }
    if (data.success) {
      showToast('✅ File successfully touched! Expiry reset +60 days.', 'success');
    } else {
      showToast(`Touch failed: ${data.result?.status || data.error || 'Check logs'}`, 'error');
    }
    fetchTouchStatus();
  } catch (err) {
    showToast('Error touching file', 'error');
  }
}

// Initialize Application
async function initApp() {
  initSSE();

  // Initial fetch of touch status
  try {
    const res = await fetch('/api/touch/status');
    const data = await res.json();
    if (data.success) {
      touchStatus = data;
      renderTouchStatus();
    }
  } catch (e) {}

  // Initial fetch of DB status for topbar
  try {
    const res = await fetch('/api/db/status');
    const data = await res.json();
    const dbPill = document.getElementById('dbStatusText');
    if (dbPill && data.engine) {
      dbPill.textContent = data.engine === 'mongodb' ? `DB: Mongo (${data.mongoDbName || 'gotouch'})` : 'DB: JSON';
    }
  } catch (e) {}
}

document.addEventListener('DOMContentLoaded', () => {
  const pinInput = document.getElementById('pinInput');
  if (pinInput) {
    pinInput.addEventListener('input', (e) => {
      currentPin = e.target.value;
      updatePinDots();
      if (currentPin.length >= 4) {
        submitPin(currentPin);
      }
    });
  }

  const autoScroll = document.getElementById('autoScrollCheck');
  if (autoScroll) {
    autoScroll.addEventListener('change', (e) => {
      autoScrollLogs = e.target.checked;
    });
  }

  checkAuth();
});
