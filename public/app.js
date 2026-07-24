let currentPin = '';
let ledgerFiles = [];
let activeFilter = 'ALL';
let pollInterval = null;

document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
});

/* ==========================================================================
   AUTHENTICATION LOGIC
   ========================================================================== */

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
  } catch (err) {
    console.error('Auth check error:', err);
  }
  showLogin();
}

function showLogin() {
  document.getElementById('authOverlay').classList.remove('hidden');
  document.getElementById('mainDashboard').classList.add('hidden');
  disconnectSSE();
  clearPin();
}

function showDashboard() {
  document.getElementById('authOverlay').classList.add('hidden');
  document.getElementById('mainDashboard').classList.remove('hidden');

  fetchDownloads();
  fetchFiles();
  connectSSE();

  // Fast 1s polling interval for guaranteed live progress updates
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(() => {
    fetchDownloads();
  }, 1000);
}

let eventSource = null;

function connectSSE() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource('/api/stream');

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.conn) {
        const badge = document.getElementById('aria2StatusBadge');
        const badgeText = document.getElementById('aria2StatusText');
        const dot = badge ? badge.querySelector('.status-dot') : null;

        if (badge && dot) {
          if (data.conn.online) {
            dot.className = 'status-dot online';
            badgeText.textContent = 'Aria2 RPC';
          } else {
            dot.className = 'status-dot offline';
            badgeText.textContent = 'Aria2 Offline';
          }
        }
      }

      if (data.downloads) {
        renderActiveDownloads(data.downloads);
      }

      if (data.files) {
        ledgerFiles = data.files;
        renderLedger();
        renderGallery();
      }
    } catch (e) {
      console.error('Error parsing SSE event:', e);
    }
  };

  eventSource.onerror = () => {
    // Fallback polling if SSE drops
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(() => {
      fetchDownloads();
      fetchFiles();
    }, 3000);
  };
}

function disconnectSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
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
      errorEl.textContent = data.error || 'Invalid PIN code.';
      errorEl.classList.remove('hidden');
      clearPin();
    }
  } catch (err) {
    errorEl.textContent = 'Connection error. Please try again.';
    errorEl.classList.remove('hidden');
  }
}

async function handleLogout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (err) {}
  showLogin();
}

/* ==========================================================================
   DOWNLOAD TASK SUBMISSION & MONITORING
   ========================================================================== */

async function handleDownloadSubmit(e) {
  e.preventDefault();
  const inputUrl = document.getElementById('downloadUrlInput');
  const inputName = document.getElementById('customFilenameInput');
  const btn = document.getElementById('btnSubmitDownload');

  const url = inputUrl.value.trim();
  const filename = inputName ? inputName.value.trim() : '';

  if (!url) return;

  btn.disabled = true;
  btn.innerHTML = 'Submitting...';

  try {
    const res = await fetch('/api/downloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, filename })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      showToast('Download task started (16 connections enforced)', 'success');
      inputUrl.value = '';
      if (inputName) inputName.value = '';
      fetchDownloads();
    } else {
      showToast(data.error || 'Failed to submit download task', 'error');
    }
  } catch (err) {
    showToast('Network error while submitting URL', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg> Start Download`;
  }
}

async function fetchDownloads() {
  try {
    const res = await fetch('/api/downloads');
    if (res.status === 401) {
      showLogin();
      return;
    }
    const data = await res.json();

    // Update Aria2 status badge
    const badge = document.getElementById('aria2StatusBadge');
    const badgeText = document.getElementById('aria2StatusText');
    const dot = badge.querySelector('.status-dot');

    if (data.aria2Connection && data.aria2Connection.online) {
      dot.className = 'status-dot online';
      badgeText.textContent = 'Aria2 RPC';
    } else {
      dot.className = 'status-dot offline';
      badgeText.textContent = 'Aria2 Offline';
    }

    renderActiveDownloads(data.downloads || []);
  } catch (err) {
    console.error('Error fetching downloads:', err);
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

let isQueuePaused = false;

function renderActiveDownloads(downloads) {
  const listEl = document.getElementById('activeDownloadsList');
  const emptyState = document.getElementById('downloadsEmptyState');

  if (!listEl || !emptyState) return;

  const activeDownloadingTasks = downloads.filter(t => t.status === 'active' || t.status === 'UPLOADING' || t.status === 'UPLOAD_FAILED' || t.status === 'error');
  const queueTasks = downloads.filter(t => t.status === 'waiting' || t.status === 'paused');

  // Render Queue Column
  renderQueueTasks(queueTasks);

  // Update Overview Metric Counters
  const activeCountEl = document.getElementById('metricActiveTasksCount');
  if (activeCountEl) activeCountEl.textContent = activeDownloadingTasks.length;

  let totalSpeedBytes = 0;
  activeDownloadingTasks.forEach(task => {
    totalSpeedBytes += (task.downloadSpeed || 0) + (task.uploadSpeed || 0);
  });
  const speedEl = document.getElementById('metricSpeedText');
  if (speedEl) speedEl.textContent = `${formatBytes(totalSpeedBytes)}/s`;

  if (!activeDownloadingTasks || activeDownloadingTasks.length === 0) {
    listEl.innerHTML = '';
    emptyState.classList.remove('hidden');
  } else {
    emptyState.classList.add('hidden');

    const itemsHTML = activeDownloadingTasks.map(task => {
      const speed = task.downloadSpeed ? `${formatBytes(task.downloadSpeed)}/s` : '0 B/s';
      const downloadedStr = formatBytes(task.completedLength || 0);
      const totalStr = formatBytes(task.totalLength || 0);
      const isUploading = task.status === 'UPLOADING';
      const isFailed = task.status === 'UPLOAD_FAILED' || task.status === 'error';

      let statusTag = `<span class="tech-tag">${task.status.toUpperCase()}</span>`;
      if (isUploading) {
        statusTag = `<span class="tech-tag" style="background: rgba(245,158,11,0.2); color: #f59e0b;">UPLOADING...</span>`;
      } else if (isFailed) {
        statusTag = `<span class="tech-tag" style="background: rgba(239,68,68,0.2); color: #f87171;">FAILED</span>`;
      }

      const errorDetailsHTML = isFailed && task.errorMessage ? `
        <div style="margin-top: 8px; font-size: 0.8rem; color: #f87171; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.2); padding: 6px 10px; border-radius: 6px;">
          ⚠️ <strong>Error Report:</strong> ${escapeHtml(task.errorMessage)}
        </div>
      ` : '';

      const downloadStageHTML = !isUploading ? `
        <div class="download-stats">
          <span>Aria2 Download: <strong>${task.progress}%</strong></span>
          <span>Downloaded: ${downloadedStr} / ${totalStr}</span>
          <span>Speed: ⚡ <strong>${speed}</strong></span>
        </div>
        <div class="progress-bar-bg" style="margin-top: 10px;">
          <div class="progress-bar-fill" style="width: ${task.progress}%"></div>
        </div>
      ` : '';

      const uploadStageHTML = isUploading ? `
        <div class="download-stats" style="color: #f59e0b; font-weight: 500;">
          <span>☁️ Upload: <strong>${task.uploadProgress || 0}%</strong></span>
          <span>Uploaded: ${formatBytes(task.uploadLoaded || 0)} / ${formatBytes(task.uploadTotal || 0)}</span>
          <span>Upload Speed: ⚡ <strong>${formatBytes(task.uploadSpeed || 0)}/s</strong></span>
        </div>
        <div class="progress-bar-bg" style="margin-top: 10px;">
          <div class="progress-bar-fill uploading" style="width: ${task.uploadProgress || 0}%"></div>
        </div>
      ` : '';

      return `
        <div class="download-item-card">
          <div class="download-item-header">
            <span class="filename-title">${escapeHtml(task.filename)}</span>
            <div style="display: flex; align-items: center; gap: 10px;">
              ${statusTag}
              <button class="btn-cancel-task" onclick="cancelDownloadTask('${task.gid}')" title="Cancel Task">
                ✕ Cancel
              </button>
            </div>
          </div>
          ${downloadStageHTML}
          ${uploadStageHTML}
          ${errorDetailsHTML}
        </div>
      `;
    }).join('');

    listEl.innerHTML = itemsHTML;
  }
}

function renderQueueTasks(queueTasks) {
  const queueContainer = document.getElementById('queueListContainer');
  const queueEmpty = document.getElementById('queueEmptyState');
  const badgeEl = document.getElementById('queueBadge');

  if (!queueContainer || !queueEmpty) return;

  if (badgeEl) badgeEl.textContent = `${queueTasks.length} Queued`;

  if (!queueTasks || queueTasks.length === 0) {
    queueContainer.innerHTML = '';
    queueEmpty.classList.remove('hidden');
    return;
  }

  queueEmpty.classList.add('hidden');

  queueContainer.innerHTML = queueTasks.map(task => {
    const isPaused = task.status === 'paused';
    const statusBadge = isPaused
      ? `<span class="status-badge dead">PAUSED</span>`
      : `<span class="status-badge live" style="background: rgba(0, 122, 255, 0.15); color: var(--color-electric-blue); border-color: rgba(0, 122, 255, 0.3);"><span class="dot-pulse" style="background: var(--color-electric-blue);"></span> QUEUED</span>`;

    const pauseResumeBtn = isPaused
      ? `<button class="btn-copy-mini" onclick="unpauseQueueTask('${task.gid}')" title="Resume task">▶️</button>`
      : `<button class="btn-copy-mini" onclick="pauseQueueTask('${task.gid}')" title="Pause task">⏸️</button>`;

    return `
      <div class="queue-item-card">
        <div class="queue-item-title" title="${escapeHtml(task.filename)}">${escapeHtml(task.filename)}</div>
        <div class="queue-item-meta">
          ${statusBadge}
          <div style="display: flex; gap: 4px;">
            ${pauseResumeBtn}
            <button class="btn-copy-mini" onclick="cancelDownloadTask('${task.gid}')" title="Cancel/Remove task">❌</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

async function toggleQueuePause() {
  const btn = document.getElementById('btnPauseResumeQueue');
  try {
    if (isQueuePaused) {
      const res = await fetch('/api/queue/unpause-all', { method: 'POST' });
      if (res.ok) {
        isQueuePaused = false;
        if (btn) btn.textContent = '⏸️ Pause Queue';
        showToast('Queue resumed', 'success');
      }
    } else {
      const res = await fetch('/api/queue/pause-all', { method: 'POST' });
      if (res.ok) {
        isQueuePaused = true;
        if (btn) btn.textContent = '▶️ Resume Queue';
        showToast('Queue paused', 'info');
      }
    }
    fetchDownloads();
  } catch (err) {
    showToast('Failed to update queue state', 'error');
  }
}

async function pauseQueueTask(gid) {
  try {
    await fetch(`/api/queue/${gid}/pause`, { method: 'POST' });
    showToast('Task paused', 'info');
    fetchDownloads();
  } catch (e) {}
}

async function unpauseQueueTask(gid) {
  try {
    await fetch(`/api/queue/${gid}/unpause`, { method: 'POST' });
    showToast('Task resumed', 'success');
    fetchDownloads();
  } catch (e) {}
}

async function cancelDownloadTask(gid) {
  if (!confirm('Are you sure you want to cancel this download task?')) return;

  try {
    const res = await fetch(`/api/downloads/${gid}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast('Download task cancelled.', 'info');
      fetchDownloads();
    } else {
      showToast(data.error || 'Failed to cancel download task', 'error');
    }
  } catch (err) {
    showToast('Network error while cancelling download', 'error');
  }
}

/* ==========================================================================
   FILE MANAGEMENT LEDGER
   ========================================================================== */

async function fetchFiles() {
  try {
    const res = await fetch('/api/files');
    if (res.status === 401) {
      showLogin();
      return;
    }
    const data = await res.json();
    ledgerFiles = data.files || [];
    renderLedger();
    renderGallery();
  } catch (err) {
    console.error('Error fetching file ledger:', err);
  }
}

let currentPage = 1;
let pageSize = 25;

function setFilter(filter, el) {
  activeFilter = filter;
  document.querySelectorAll('.filter-pill').forEach(pill => pill.classList.remove('active'));
  el.classList.add('active');
  currentPage = 1;
  renderLedger();
}

function changePageSize(val) {
  pageSize = parseInt(val, 10) || 25;
  currentPage = 1;
  renderLedger();
}

function changePage(delta) {
  currentPage += delta;
  renderLedger();
}

function resetPageAndRender() {
  currentPage = 1;
  renderLedger();
}

function formatUTC(dateString) {
  if (!dateString) return 'Never';
  const d = new Date(dateString);
  if (isNaN(d.getTime())) return dateString;

  const pad = n => n < 10 ? '0' + n : n;
  const year = d.getUTCFullYear();
  const month = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hours = pad(d.getUTCHours());
  const mins = pad(d.getUTCMinutes());
  const secs = pad(d.getUTCSeconds());

  return `${year}-${month}-${day} ${hours}:${mins}:${secs} UTC`;
}

function formatRelativeTime(dateString) {
  if (!dateString) return 'Never';
  const d = new Date(dateString);
  const now = new Date();
  const diffMs = now - d;

  if (isNaN(diffMs)) return dateString;
  if (diffMs < 0) return 'Just now';

  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) {
    return 'Just now';
  } else if (diffMins < 60) {
    return `${diffMins}m ago`;
  } else if (diffHours < 24) {
    const remainingMins = diffMins % 60;
    return remainingMins > 0 ? `${diffHours}h ${remainingMins}m ago` : `${diffHours}h ago`;
  } else {
    const remainingHours = diffHours % 24;
    return remainingHours > 0 ? `${diffDays}d ${remainingHours}h ago` : `${diffDays}d ago`;
  }
}

function renderLedger() {
  const search = (document.getElementById('searchInput').value || '').toLowerCase().trim();
  const tbody = document.getElementById('ledgerTableBody');
  const mobileCardsEl = document.getElementById('ledgerMobileCards');
  const emptyState = document.getElementById('ledgerEmptyState');

  // Update counts
  const totalCount = ledgerFiles.length;
  const liveCount = ledgerFiles.filter(f => f.status === 'LIVE').length;
  const deadCount = ledgerFiles.filter(f => f.status === 'DEAD').length;

  const statLiveEl = document.getElementById('statLiveCount');
  if (statLiveEl) statLiveEl.textContent = liveCount;

  const countAllEl = document.getElementById('countAll');
  if (countAllEl) countAllEl.textContent = totalCount;

  const countLiveEl = document.getElementById('countLive');
  if (countLiveEl) countLiveEl.textContent = liveCount;

  const countDeadEl = document.getElementById('countDead');
  if (countDeadEl) countDeadEl.textContent = deadCount;

  const totalFilesEl = document.getElementById('metricTotalFilesCount');
  if (totalFilesEl) totalFilesEl.textContent = totalCount;

  // Filter items
  const filtered = ledgerFiles.filter(file => {
    const matchesFilter = activeFilter === 'ALL' || file.status === activeFilter;
    const matchesSearch = !search ||
      file.filename.toLowerCase().includes(search) ||
      file.id.toLowerCase().includes(search) ||
      file.download_url.toLowerCase().includes(search);
    return matchesFilter && matchesSearch;
  });

  const totalItems = filtered.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;

  if (currentPage < 1) currentPage = 1;
  if (currentPage > totalPages) currentPage = totalPages;

  const startIndex = (currentPage - 1) * pageSize;
  const pageItems = filtered.slice(startIndex, startIndex + pageSize);

  // Update Pagination Controls UI
  const pageInfoStr = `Page ${currentPage} of ${totalPages}`;
  const showingStr = totalItems === 0 ? 'Showing 0 entries' : `Showing ${startIndex + 1} to ${Math.min(startIndex + pageSize, totalItems)} of ${totalItems} entries`;

  const pageInfoTopEl = document.getElementById('pageInfoTop');
  if (pageInfoTopEl) pageInfoTopEl.textContent = pageInfoStr;

  const pageInfoBottomEl = document.getElementById('pageInfoBottom');
  if (pageInfoBottomEl) pageInfoBottomEl.textContent = pageInfoStr;

  const showingEntriesEl = document.getElementById('showingEntriesText');
  if (showingEntriesEl) showingEntriesEl.textContent = showingStr;

  const btnPrevTop = document.getElementById('btnPrevPageTop');
  if (btnPrevTop) btnPrevTop.disabled = currentPage <= 1;

  const btnPrevBottom = document.getElementById('btnPrevPageBottom');
  if (btnPrevBottom) btnPrevBottom.disabled = currentPage <= 1;

  const btnNextTop = document.getElementById('btnNextPageTop');
  if (btnNextTop) btnNextTop.disabled = currentPage >= totalPages;

  const btnNextBottom = document.getElementById('btnNextPageBottom');
  if (btnNextBottom) btnNextBottom.disabled = currentPage >= totalPages;

  if (pageItems.length === 0) {
    if (tbody) tbody.innerHTML = '';
    if (mobileCardsEl) mobileCardsEl.innerHTML = '';
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');

  // 1. Render Desktop Table Rows
  if (tbody) {
    tbody.innerHTML = pageItems.map(file => {
      const isLive = file.status === 'LIVE';
      const statusBadge = isLive
        ? `<span class="status-badge live"><span class="dot-pulse"></span> LIVE</span>`
        : `<span class="status-badge dead">DEAD</span>`;

      const lastTouchedRel = formatRelativeTime(file.last_touched);
      const createdAtRel = formatRelativeTime(file.created_at);
      const lastTouchedUTC = formatUTC(file.last_touched);
      const createdAtUTC = formatUTC(file.created_at);

      const meta = file.metadata || {};
      const cat = meta.category || 'file';
      const catIcon = cat === 'video' ? '🎬' : cat === 'image' ? '🖼️' : cat === 'audio' ? '🎵' : cat === 'archive' ? '📦' : '📄';

      const displayName = file.custom_name || file.filename;
      const originalName = file.original_filename || file.filename;

      const originalRow = (originalName && originalName !== displayName)
        ? `<div class="original-name-row" title="Original Download Filename">📁 Original: ${escapeHtml(originalName)}</div>`
        : '';

      const thumbUrl = (file.thumbnails && file.thumbnails.length > 0) ? file.thumbnails[0] : null;
      const previewCellHTML = thumbUrl
        ? `<div class="table-thumb-box" onclick="openGalleryModal('${file.id}')" title="Click to view 15-frame gallery (${file.thumbnails.length} frames)">
             <img src="${escapeHtml(thumbUrl)}" alt="Thumbnail Preview" />
             <span class="thumb-count-tag">${file.thumbnails.length}f</span>
           </div>`
        : `<div class="table-thumb-box fallback" title="No thumbnail available">
             <span>${catIcon}</span>
           </div>`;

      const galleryBtn = (file.thumbnails && file.thumbnails.length > 0)
        ? `<button class="btn-table-action" onclick="openGalleryModal('${file.id}')" title="View 15-Frame Screenshot Gallery (${file.thumbnails.length} frames)">🖼️ Gallery</button>`
        : '';

      return `
        <tr>
          <td>${previewCellHTML}</td>
          <td class="filename-cell">
            <div class="file-title-row">
              <span class="cat-icon">${catIcon}</span>
              <span
                class="file-name-text editable-name"
                contenteditable="true"
                spellcheck="false"
                title="Click to edit display name"
                data-file-id="${file.id}"
                data-original-value="${escapeHtml(displayName)}"
                onblur="saveCustomName(this)"
                onkeydown="handleNameKeydown(event, this)"
              >${escapeHtml(displayName)}</span>
            </div>
            ${originalRow}
          </td>
          <td class="link-cell">
            ${file.download_url ? `
              <div class="gofile-link-badge">
                <a href="${escapeHtml(file.download_url)}" target="_blank" rel="noopener">${escapeHtml(file.download_url)}</a>
                <button class="btn-copy-mini" onclick="copyToClipboard('${escapeHtml(file.download_url)}')" title="Copy Pixeldrain Link">📋</button>
              </div>
            ` : '<span class="text-muted">N/A</span>'}
          </td>
          <td>${statusBadge}</td>
          <td><small class="utc-date-text" title="UTC: ${escapeHtml(lastTouchedUTC)}">${escapeHtml(lastTouchedRel)}</small></td>
          <td class="text-right">
            <div class="action-buttons-stack">
              <div class="action-row">
                <button class="btn-table-action primary" onclick="showFileMetadata('${file.id}')" title="View Full File Metadata">🔍 Meta</button>
                <button class="btn-table-action" onclick="copyToClipboard('${escapeHtml(file.download_url)}')" title="Copy Link">📋 Copy</button>
              </div>
              <div class="action-row">
                <button class="btn-table-action success" onclick="triggerSingleTouch('${file.id}')" title="Ping Pixeldrain Link">⚡ Touch</button>
                ${galleryBtn ? galleryBtn : `<button class="btn-table-action" disabled style="opacity: 0.3; cursor: not-allowed;">🖼️ N/A</button>`}
              </div>
              <button class="btn-table-action danger" onclick="deleteRecord('${file.id}')" title="Delete Ledger Entry" style="width: 100%;">🗑️ Delete</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  // 2. Render Mobile Cards View (Vertical Phone Mode)
  if (mobileCardsEl) {
    mobileCardsEl.innerHTML = pageItems.map(file => {
      const isLive = file.status === 'LIVE';
      const statusBadge = isLive
        ? `<span class="status-badge live"><span class="dot-pulse"></span> LIVE</span>`
        : `<span class="status-badge dead">DEAD</span>`;

      const lastTouchedRel = formatRelativeTime(file.last_touched);
      const createdAtRel = formatRelativeTime(file.created_at);
      const lastTouchedUTC = formatUTC(file.last_touched);
      const createdAtUTC = formatUTC(file.created_at);

      const meta = file.metadata || {};
      const cat = meta.category || 'file';
      const catIcon = cat === 'video' ? '🎬' : cat === 'image' ? '🖼️' : cat === 'audio' ? '🎵' : cat === 'archive' ? '📦' : '📄';

      let metaPills = [];
      if (meta.size_formatted && meta.size_formatted !== 'N/A') {
        metaPills.push(`<span class="meta-pill">💾 ${escapeHtml(meta.size_formatted)}</span>`);
      } else if (meta.size_bytes > 0) {
        metaPills.push(`<span class="meta-pill">💾 ${formatBytes(meta.size_bytes)}</span>`);
      }
      if (meta.resolution) {
        metaPills.push(`<span class="meta-pill">📐 ${escapeHtml(meta.resolution)}</span>`);
      }
      if (meta.duration_formatted) {
        metaPills.push(`<span class="meta-pill">⏱️ ${escapeHtml(meta.duration_formatted)}</span>`);
      }
      if (file.source_url) {
        metaPills.push(`<a href="${escapeHtml(file.source_url)}" target="_blank" rel="noopener" class="meta-pill source" title="${escapeHtml(file.source_url)}">🌐 Source</a>`);
      }

      const displayName = file.custom_name || file.filename;
      const originalName = file.original_filename || file.filename;

      const originalRow = (originalName && originalName !== displayName)
        ? `<div class="section-desc">📁 Original: ${escapeHtml(originalName)}</div>`
        : '';

      const galleryBtn = (file.thumbnails && file.thumbnails.length > 0)
        ? `<button class="btn-table-action" onclick="openGalleryModal('${file.id}')">🖼️ Gallery</button>`
        : '';

      return `
        <div class="ledger-mobile-card">
          <div class="card-top-row">
            <div class="card-title-container">
              <div style="font-weight: 700; font-size: 0.95rem; display: flex; align-items: flex-start; gap: 6px; min-width: 0;">
                <span style="flex-shrink: 0; line-height: 1.4;">${catIcon}</span>
                <span
                  class="editable-name"
                  contenteditable="true"
                  spellcheck="false"
                  data-file-id="${file.id}"
                  data-original-value="${escapeHtml(displayName)}"
                  onblur="saveCustomName(this)"
                  onkeydown="handleNameKeydown(event, this)"
                >${escapeHtml(displayName)}</span>
              </div>
              ${originalRow}
            </div>
            ${statusBadge}
          </div>

          ${file.download_url ? `
            <div class="gofile-link-badge" style="max-width: 100%;">
              <a href="${escapeHtml(file.download_url)}" target="_blank" rel="noopener">${escapeHtml(file.download_url)}</a>
              <button class="btn-copy-mini" onclick="copyToClipboard('${escapeHtml(file.download_url)}')" title="Copy Link">📋</button>
            </div>
          ` : ''}

          <div class="card-meta-pills">
            ${metaPills.join('')}
          </div>

          <div class="card-dates-row">
            <span title="UTC: ${escapeHtml(lastTouchedUTC)}">Touched: ${escapeHtml(lastTouchedRel)}</span>
            <span title="UTC: ${escapeHtml(createdAtUTC)}">Created: ${escapeHtml(createdAtRel)}</span>
          </div>

          <div class="card-actions-row">
            ${galleryBtn}
            <button class="btn-table-action primary" onclick="showFileMetadata('${file.id}')">🔍 Meta</button>
            <button class="btn-table-action" onclick="copyToClipboard('${escapeHtml(file.download_url)}')">📋 Copy</button>
            <button class="btn-table-action success" onclick="triggerSingleTouch('${file.id}')">⚡ Touch</button>
            <button class="btn-table-action danger" onclick="deleteRecord('${file.id}')">🗑️</button>
          </div>
        </div>
      `;
    }).join('');
  }
}

/* ==========================================================================
   METADATA INSPECTOR MODAL HANDLERS
   ========================================================================== */

function showFileMetadata(id) {
  const file = ledgerFiles.find(f => f.id === id);
  if (!file) return;

  const meta = file.metadata || {};
  const cat = meta.category || 'file';
  const catIcon = cat === 'video' ? '🎬' : cat === 'image' ? '🖼️' : cat === 'audio' ? '🎵' : cat === 'archive' ? '📦' : '📄';

  const displayName = file.custom_name || file.filename;
  const originalName = file.original_filename || file.filename;

  document.getElementById('metaCategoryIcon').textContent = catIcon;
  document.getElementById('metaModalTitle').textContent = displayName;
  document.getElementById('metaModalSub').textContent = `Record ID: ${file.id}`;

  const body = document.getElementById('metaModalBody');

  body.innerHTML = `
    <div class="meta-item span-2">
      <span class="meta-label">Display Name ${file.custom_name ? '(Custom)' : ''}</span>
      <div class="meta-value" style="font-size: 1.05rem; color: #fff;">${escapeHtml(displayName)}</div>
    </div>

    <div class="meta-item">
      <span class="meta-label">Original Download Filename</span>
      <div class="meta-value mono" style="color: #cbd5e1;">📁 ${escapeHtml(originalName)}</div>
    </div>

    <div class="meta-item">
      <span class="meta-label">Format & Category</span>
      <div class="meta-value" style="text-transform: uppercase;">${catIcon} ${escapeHtml(meta.extension || 'N/A')} (${cat})</div>
    </div>

    <div class="meta-item">
      <span class="meta-label">File Size</span>
      <div class="meta-value" style="color: #60a5fa;">💾 ${escapeHtml(meta.size_formatted || formatBytes(meta.size_bytes || 0))}</div>
    </div>

    <div class="meta-item">
      <span class="meta-label">Resolution / Dimensions</span>
      <div class="meta-value" style="color: #22d3ee;">${meta.resolution ? `📐 ${escapeHtml(meta.resolution)}` : '<span style="color:#64748b;">N/A</span>'}</div>
    </div>

    <div class="meta-item">
      <span class="meta-label">Media Duration</span>
      <div class="meta-value" style="color: #fbbf24;">${meta.duration_formatted ? `⏱️ ${escapeHtml(meta.duration_formatted)}` : '<span style="color:#64748b;">N/A</span>'}</div>
    </div>

    <div class="meta-item span-2">
      <span class="meta-label">Pixeldrain Download Link</span>
      <div class="meta-value mono"><a href="${escapeHtml(file.download_url)}" target="_blank" rel="noopener" style="color:#007AFF;">${escapeHtml(file.download_url)}</a></div>
    </div>

    <div class="meta-item">
      <span class="meta-label">Pixeldrain Retention Status</span>
      <div class="meta-value">${file.status === 'LIVE' ? '<span style="color:#10B981;">🟢 LIVE</span>' : '<span style="color:#F43F5E;">🔴 DEAD</span>'}</div>
    </div>

    ${file.source_url ? `
    <div class="meta-item full-width">
      <span class="meta-label">Original Remote Source URL</span>
      <div class="meta-value mono"><a href="${escapeHtml(file.source_url)}" target="_blank" rel="noopener" style="color:#9ca3af; text-decoration:underline;">${escapeHtml(file.source_url)}</a></div>
    </div>
    ` : ''}

    <div class="meta-item">
      <span class="meta-label">Pixeldrain File ID</span>
      <div class="meta-value mono">${escapeHtml(file.pixeldrain_id || file.gofile_id || 'N/A')}</div>
    </div>

    <div class="meta-item">
      <span class="meta-label">Created Date (UTC)</span>
      <div class="meta-value mono" style="font-size:0.8rem;">${formatUTC(file.created_at)}</div>
    </div>

    <div class="meta-item">
      <span class="meta-label">Last Touched Date (UTC)</span>
      <div class="meta-value mono" style="font-size:0.8rem;">${formatUTC(file.last_touched)}</div>
    </div>

    ${(file.thumbnails && file.thumbnails.length > 0) ? `
    <div class="meta-item full-width" style="margin-top: 6px;">
      <span class="meta-label">🖼️ Screenshot Frame Gallery (${file.thumbnails.length} frames)</span>
      <div class="thumb-gallery-grid">
        ${file.thumbnails.map((tUrl, idx) => `
          <a href="${tUrl}" target="_blank" class="thumb-card" title="Frame ${idx + 1}">
            <img src="${tUrl}" alt="Frame ${idx + 1}" loading="lazy" />
            <span class="thumb-badge">#${idx + 1}</span>
          </a>
        `).join('')}
      </div>
    </div>
    ` : ''}
  `;

  document.getElementById('metaBtnTouch').onclick = () => { triggerSingleTouch(file.id); };
  document.getElementById('metaBtnCopyGoFile').onclick = () => { copyToClipboard(file.download_url); };

  document.getElementById('metadataModal').classList.remove('hidden');
}

function closeMetadataModal() {
  document.getElementById('metadataModal').classList.add('hidden');
}

async function triggerSingleTouch(id) {
  try {
    showToast('Pinging file download page...', 'info');
    const res = await fetch(`/api/files/${id}/touch`, { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.success) {
      if (data.result.success) {
        showToast('Touch successful! Status: LIVE', 'success');
      } else {
        showToast(`Touch failed. Status updated to: ${data.result.status}`, 'error');
      }
      fetchFiles();
    } else {
      showToast(data.error || 'Touch trigger failed', 'error');
    }
  } catch (err) {
    showToast('Network error during touch ping', 'error');
  }
}

async function triggerTouchAll() {
  const btn = document.getElementById('btnTouchAll');
  btn.disabled = true;
  btn.textContent = 'Pinging files...';
  showToast('Initiating rate-limited Touch Manager routine...', 'info');

  try {
    const res = await fetch('/api/files/touch-all', { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`Touch complete. Processed ${data.count} file(s).`, 'success');
      fetchFiles();
    } else {
      showToast(data.error || 'Failed to execute touch routine', 'error');
    }
  } catch (err) {
    showToast('Network error during Touch routine', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg> Touch All LIVE Files`;
  }
}

async function deleteRecord(id) {
  if (!confirm('Are you sure you want to delete this record from the ledger?')) return;

  try {
    const res = await fetch(`/api/files/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast('Record deleted.', 'success');
      fetchFiles();
    } else {
      showToast(data.error || 'Failed to delete record', 'error');
    }
  } catch (err) {
    showToast('Network error deleting record', 'error');
  }
}

/* ==========================================================================
   UTILITY FUNCTIONS
   ========================================================================== */

function copyToClipboard(text) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    showToast('GoFile link copied to clipboard!', 'success');
  }).catch(() => {
    showToast('Failed to copy link', 'error');
  });
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(30px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  if (typeof str !== 'string') str = String(str);
  return str.replace(/[&<>"']/g, match => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[match];
  });
}

/* ==========================================================================
   INLINE FILENAME EDIT HANDLERS
   ========================================================================== */

function handleNameKeydown(event, el) {
  if (event.key === 'Enter') {
    event.preventDefault();
    el.blur(); // Trigger save via onblur
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    el.textContent = el.dataset.originalValue;
    el.blur();
  }
}

async function saveCustomName(el) {
  const fileId = el.dataset.fileId;
  const originalValue = el.dataset.originalValue;
  const newName = el.textContent.trim();

  if (!newName) {
    el.textContent = originalValue; // Restore if blank
    return;
  }

  if (newName === originalValue) return; // Nothing changed

  el.setAttribute('contenteditable', 'false');
  el.classList.add('saving');

  try {
    const res = await fetch(`/api/files/${fileId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ custom_name: newName })
    });
    const data = await res.json();

    if (res.ok && data.success) {
      el.dataset.originalValue = newName;
      // Update in-memory record
      const idx = ledgerFiles.findIndex(f => f.id === fileId);
      if (idx !== -1) ledgerFiles[idx].custom_name = newName;
      showToast(`Name updated to "${newName}"`, 'success');
    } else {
      el.textContent = originalValue;
      showToast(data.error || 'Failed to save name', 'error');
    }
  } catch (err) {
    el.textContent = originalValue;
    showToast('Network error saving name', 'error');
  }

  el.setAttribute('contenteditable', 'true');
  el.classList.remove('saving');
}

/* ==========================================================================
   GALLERY LIGHTBOX MODAL HANDLERS
   ========================================================================== */

let activeGalleryImages = [];
let currentGalleryIndex = 0;

function openGalleryModal(id) {
  const file = ledgerFiles.find(f => f.id === id);
  if (!file || !file.thumbnails || file.thumbnails.length === 0) {
    showToast('No screenshot thumbnails available for this file', 'info');
    return;
  }

  activeGalleryImages = file.thumbnails;
  currentGalleryIndex = 0;

  const displayName = file.custom_name || file.filename;
  document.getElementById('galleryModalTitle').textContent = `${displayName} — Screenshot Gallery`;

  renderGalleryState();
  document.getElementById('galleryModal').classList.remove('hidden');
}

function renderGalleryState() {
  if (!activeGalleryImages || activeGalleryImages.length === 0) return;

  const total = activeGalleryImages.length;
  document.getElementById('galleryModalSub').textContent = `Frame ${currentGalleryIndex + 1} of ${total}`;
  document.getElementById('galleryMainImage').src = activeGalleryImages[currentGalleryIndex];

  const strip = document.getElementById('galleryThumbStrip');
  strip.innerHTML = activeGalleryImages.map((tUrl, idx) => `
    <div class="gallery-thumb-item ${idx === currentGalleryIndex ? 'active' : ''}" onclick="setGalleryIndex(${idx})">
      <img src="${tUrl}" alt="Thumb ${idx + 1}" />
    </div>
  `).join('');
}

function setGalleryIndex(index) {
  if (index >= 0 && index < activeGalleryImages.length) {
    currentGalleryIndex = index;
    renderGalleryState();
  }
}

function prevGalleryImage() {
  if (activeGalleryImages.length === 0) return;
  currentGalleryIndex = (currentGalleryIndex - 1 + activeGalleryImages.length) % activeGalleryImages.length;
  renderGalleryState();
}

function nextGalleryImage() {
  if (activeGalleryImages.length === 0) return;
  currentGalleryIndex = (currentGalleryIndex + 1) % activeGalleryImages.length;
  renderGalleryState();
}

function closeGalleryModal() {
  document.getElementById('galleryModal').classList.add('hidden');
}

// Keyboard arrow key navigation support for Gallery Modal
document.addEventListener('keydown', (e) => {
  const modal = document.getElementById('galleryModal');
  if (modal && !modal.classList.contains('hidden')) {
    if (e.key === 'ArrowLeft') prevGalleryImage();
    if (e.key === 'ArrowRight') nextGalleryImage();
    if (e.key === 'Escape') closeGalleryModal();
  }
});

/* ==========================================================================
   MEDIA GALLERY VIEW RENDERING LOGIC
   ========================================================================== */

let galleryCategoryFilter = 'ALL';

function setGalleryCategory(cat, el) {
  galleryCategoryFilter = cat;
  if (el) {
    const parent = el.closest('.status-filter-pills');
    if (parent) {
      parent.querySelectorAll('.filter-pill').forEach(pill => pill.classList.remove('active'));
      el.classList.add('active');
    }
  }
  renderGallery();
}

function renderGallery() {
  const container = document.getElementById('galleryGridContainer');
  const emptyState = document.getElementById('galleryEmptyState');
  const searchInput = document.getElementById('gallerySearchInput');

  if (!container) return;

  const search = (searchInput ? searchInput.value : '').toLowerCase().trim();

  const filtered = ledgerFiles.filter(file => {
    const meta = file.metadata || {};
    const cat = meta.category || 'file';

    const matchesCat = galleryCategoryFilter === 'ALL' || cat === galleryCategoryFilter;
    const matchesSearch = !search ||
      file.filename.toLowerCase().includes(search) ||
      (file.custom_name && file.custom_name.toLowerCase().includes(search));

    return matchesCat && matchesSearch;
  });

  if (filtered.length === 0) {
    container.innerHTML = '';
    if (emptyState) emptyState.classList.remove('hidden');
    return;
  }

  if (emptyState) emptyState.classList.add('hidden');

  container.innerHTML = filtered.map(file => {
    const meta = file.metadata || {};
    const cat = meta.category || 'file';
    const catIcon = cat === 'video' ? '🎬' : cat === 'image' ? '🖼️' : cat === 'audio' ? '🎵' : cat === 'archive' ? '📦' : '📄';
    const displayName = file.custom_name || file.filename;
    const thumbUrl = (file.thumbnails && file.thumbnails.length > 0) ? file.thumbnails[0] : null;

    let metaPills = [];
    if (meta.size_formatted && meta.size_formatted !== 'N/A') {
      metaPills.push(`<span class="meta-pill">💾 ${escapeHtml(meta.size_formatted)}</span>`);
    } else if (meta.size_bytes > 0) {
      metaPills.push(`<span class="meta-pill">💾 ${formatBytes(meta.size_bytes)}</span>`);
    }
    if (meta.resolution) {
      metaPills.push(`<span class="meta-pill">📐 ${escapeHtml(meta.resolution)}</span>`);
    }
    if (meta.duration_formatted) {
      metaPills.push(`<span class="meta-pill">⏱️ ${escapeHtml(meta.duration_formatted)}</span>`);
    }

    const coverHTML = thumbUrl
      ? `<div class="gallery-card-cover" onclick="openGalleryModal('${file.id}')" title="Click to open 15-frame lightbox">
           <img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(displayName)}" />
           <span class="gallery-cover-badge">📷 ${file.thumbnails.length} Frames</span>
         </div>`
      : `<div class="gallery-card-cover" onclick="showFileMetadata('${file.id}')" title="View File Metadata">
           <span class="gallery-cover-fallback">${catIcon}</span>
         </div>`;

    const galleryBtn = (file.thumbnails && file.thumbnails.length > 0)
      ? `<button class="btn-table-action primary" style="flex:1;" onclick="openGalleryModal('${file.id}')">🖼️ 15-Frame Lightbox</button>`
      : '';

    return `
      <div class="gallery-item-card">
        ${coverHTML}
        <div class="gallery-card-body">
          <div class="gallery-card-title">
            <span>${catIcon}</span>
            <span>${escapeHtml(displayName)}</span>
          </div>

          <div class="card-meta-pills">
            ${metaPills.join('')}
          </div>

          ${file.download_url ? `
            <div class="gofile-link-badge" style="max-width: 100%;">
              <a href="${escapeHtml(file.download_url)}" target="_blank" rel="noopener">${escapeHtml(file.download_url)}</a>
              <button class="btn-copy-mini" onclick="copyToClipboard('${escapeHtml(file.download_url)}')" title="Copy Link">📋</button>
            </div>
          ` : ''}

          <div class="gallery-card-actions">
            ${galleryBtn}
            <button class="btn-table-action" style="flex:1;" onclick="showFileMetadata('${file.id}')">🔍 Meta</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}
