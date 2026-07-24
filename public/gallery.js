/* ==========================================================================
   PIXELTOUCH MANAGER - DEDICATED GALLERY STUDIO SCRIPT (gallery.js)
   ========================================================================== */

let currentPin = '';
let ledgerFiles = [];
let galleryCategoryFilter = 'ALL';

document.addEventListener('DOMContentLoaded', () => {
  checkAuth();

  const pinInput = document.getElementById('pinInput');
  if (pinInput) {
    pinInput.addEventListener('input', (e) => {
      currentPin = e.target.value;
      updatePinDots();
    });
  }
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
  disconnectSSE();
}

function showDashboard() {
  document.getElementById('authOverlay').classList.add('hidden');
  document.getElementById('mainDashboard').classList.remove('hidden');

  const savedCols = localStorage.getItem('gallery_grid_cols') || '4';
  const gridSelect = document.getElementById('galleryGridColsSelect');
  if (gridSelect) gridSelect.value = savedCols;
  changeGridColumns(savedCols);

  fetchFiles();
  connectSSE();
}

async function handleLogout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (e) {}
  showLogin();
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

      if (data.dataSizeFormatted) {
        const storageText = document.getElementById('storageText');
        if (storageText) storageText.textContent = `Data: ${data.dataSizeFormatted}`;
      }
      // Intentionally DO NOT call renderGalleryPage() from SSE on gallery page
      // to keep DOM 100% static and prevent background re-render jitter!
    } catch (e) {
      console.error('Error parsing SSE event:', e);
    }
  };
}

function disconnectSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

async function fetchFiles() {
  try {
    const res = await fetch('/api/files');
    if (res.status === 401) {
      showLogin();
      return;
    }
    const data = await res.json();
    ledgerFiles = data.files || [];
    renderGalleryPage();
  } catch (err) {
    console.error('Error fetching file ledger:', err);
  }
}

/* ==========================================================================
   GALLERY PAGE RENDERING & INTERACTIVE SCRUBBING
   ========================================================================== */

function changeGridColumns(cols) {
  const container = document.getElementById('galleryGridContainer');
  if (container) {
    container.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  }
  localStorage.setItem('gallery_grid_cols', cols);
}

let activeHoverFileId = null;

function renderGalleryPage() {
  const container = document.getElementById('galleryGridContainer');
  const emptyState = document.getElementById('galleryEmptyState');
  const searchInput = document.getElementById('gallerySearchInput');
  const sortSelect = document.getElementById('gallerySortSelect');

  if (!container) return;

  // Prevent SSE refresh from wiping out active hover slideshow card
  if (activeHoverFileId) return;

  // Restore or set grid columns selection
  const gridSelect = document.getElementById('galleryGridColsSelect');
  if (gridSelect && gridSelect.value) {
    container.style.gridTemplateColumns = `repeat(${gridSelect.value}, 1fr)`;
  }

  // Update Summary Counters
  const totalMediaEl = document.getElementById('statTotalMedia');
  if (totalMediaEl) totalMediaEl.textContent = ledgerFiles.length;

  const search = (searchInput ? searchInput.value : '').toLowerCase().trim();
  const sortVal = sortSelect ? sortSelect.value : 'newest';

  // Filter items
  let filtered = ledgerFiles.filter(file => {
    return !search ||
      file.filename.toLowerCase().includes(search) ||
      (file.custom_name && file.custom_name.toLowerCase().includes(search));
  });

  // Sort items
  filtered.sort((a, b) => {
    if (sortVal === 'oldest') {
      return new Date(a.created_at || 0) - new Date(b.created_at || 0);
    } else if (sortVal === 'name') {
      const nameA = (a.custom_name || a.filename).toLowerCase();
      const nameB = (b.custom_name || b.filename).toLowerCase();
      return nameA.localeCompare(nameB);
    } else if (sortVal === 'size') {
      const sizeA = a.metadata?.size_bytes || 0;
      const sizeB = b.metadata?.size_bytes || 0;
      return sizeB - sizeA;
    } else {
      // newest first
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    }
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
    const thumbs = file.thumbnails || [];
    const thumbUrl = file.selected_thumbnail || (thumbs.length > 0 ? thumbs[0] : null);

    // Top-Right Badge: Show Video Duration (not frame count)
    const durationText = meta.duration_formatted || (meta.duration_seconds ? `${meta.duration_seconds}s` : '');
    const topBadgeHTML = durationText
      ? `<span class="gallery-cover-badge">⏱️ ${escapeHtml(durationText)}</span>`
      : (cat === 'video' ? `<span class="gallery-cover-badge">🎬 Video</span>` : '');

    // Bottom Frame Lighting Dots
    const frameDotsHTML = (thumbs.length > 1)
      ? `<div class="cover-frame-dots" id="dots_${file.id}">
           ${thumbs.map((_, idx) => `<span class="frame-dot ${idx === 0 ? 'active' : ''}"></span>`).join('')}
         </div>`
      : '';

    // Cover HTML with dual-layer crossfade for cinematic smooth frame transitions
    let coverHTML = '';
    if (thumbUrl) {
      coverHTML = `
        <div class="gallery-card-cover"
             id="coverDiv_${file.id}"
             onmouseenter="startHoverSlideshow(event, '${file.id}')"
             onmouseleave="stopHoverSlideshow(event, '${file.id}')"
             onclick="openGalleryModal('${file.id}')"
             title="Hover to auto-preview frames • Click to open lightbox">
          <div class="cover-layer layer-bg" id="layerBg_${file.id}" style="background-image: url('${escapeHtml(thumbUrl)}');"></div>
          <div class="cover-layer layer-fg" id="layerFg_${file.id}" style="background-image: url('${escapeHtml(thumbUrl)}'); opacity: 0;"></div>
          <span class="cover-small-dot"></span>
          ${topBadgeHTML}
          ${frameDotsHTML}
        </div>
      `;
    } else {
      coverHTML = `
        <div class="gallery-card-cover" onclick="showFileMetadata('${file.id}')" title="View File Metadata">
          <span class="cover-small-dot"></span>
          <span class="gallery-cover-fallback">${catIcon}</span>
          ${topBadgeHTML}
        </div>
      `;
    }

    // Metadata string values
    let sizeStr = 'N/A';
    if (meta.size_formatted && meta.size_formatted !== 'N/A') {
      sizeStr = escapeHtml(meta.size_formatted);
    } else if (meta.size_bytes > 0) {
      sizeStr = formatBytes(meta.size_bytes);
    }

    return `
      <div class="gallery-item-card">
        ${coverHTML}
        <div class="gallery-card-body">
          <div class="gallery-card-title">
            <span class="cat-icon">${catIcon}</span>
            <span class="name-text" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</span>
          </div>

          <div class="gallery-specs-grid">
            <div class="spec-item">
              <span class="spec-label">Size:</span>
              <span class="spec-value">${sizeStr}</span>
            </div>
            <div class="spec-item">
              <span class="spec-label">Duration:</span>
              <span class="spec-value">${escapeHtml(durationText) || 'N/A'}</span>
            </div>
            ${meta.resolution ? `
              <div class="spec-item" style="grid-column: span 2;">
                <span class="spec-label">Res:</span>
                <span class="spec-value">${escapeHtml(meta.resolution)}</span>
              </div>
            ` : ''}
          </div>

          ${file.download_url ? `
            <div class="gofile-link-badge" style="max-width: 100%;">
              <a href="${escapeHtml(file.download_url)}" target="_blank" rel="noopener">${escapeHtml(file.download_url)}</a>
              <button class="btn-copy-mini" onclick="copyToClipboard('${escapeHtml(file.download_url)}')" title="Copy Link">📋</button>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  // Do NOT preload all thumbnails upfront — load lazily on hover/modal open
}

// Automatic Smooth Frame Slideshow on Hover with Dual-Layer Fade Crossfade & Frame Dots
const hoverSlideshowIntervals = {};
const preloadedCache = {};

// Lazily preload only the thumbnails for a single specific card (called on hover)
function preloadCardThumbnails(fileId) {
  if (preloadedCache[fileId]) return; // already done
  const file = ledgerFiles.find(f => f.id === fileId);
  if (!file || !file.thumbnails) return;
  preloadedCache[fileId] = true;
  file.thumbnails.forEach(url => {
    const img = new Image();
    img.src = url;
  });
}

function startHoverSlideshow(evt, fileId) {
  activeHoverFileId = fileId;
  const file = ledgerFiles.find(f => f.id === fileId);
  if (!file || !file.thumbnails || file.thumbnails.length <= 1) return;

  // Lazy-load this card's frames only now on first hover
  preloadCardThumbnails(fileId);

  stopHoverSlideshow(evt, fileId);

  let frameIdx = 0;
  let activeLayer = 'bg';

  hoverSlideshowIntervals[fileId] = setInterval(() => {
    frameIdx = (frameIdx + 1) % file.thumbnails.length;
    const nextUrl = file.thumbnails[frameIdx];
    const layerBg = document.getElementById(`layerBg_${fileId}`);
    const layerFg = document.getElementById(`layerFg_${fileId}`);

    if (layerBg && layerFg && nextUrl) {
      if (activeLayer === 'bg') {
        layerFg.style.backgroundImage = `url("${nextUrl}")`;
        layerFg.style.opacity = '1';
        activeLayer = 'fg';
      } else {
        layerBg.style.backgroundImage = `url("${nextUrl}")`;
        layerFg.style.opacity = '0';
        activeLayer = 'bg';
      }
    }

    // Light up active frame indicator dot
    const dotsContainer = document.getElementById(`dots_${fileId}`);
    if (dotsContainer && dotsContainer.children.length > 0) {
      Array.from(dotsContainer.children).forEach((dot, idx) => {
        if (idx === frameIdx) {
          dot.classList.add('active');
        } else {
          dot.classList.remove('active');
        }
      });
    }
  }, 650);
}

function stopHoverSlideshow(evt, fileId) {
  const coverDiv = document.getElementById(`coverDiv_${fileId}`);
  if (evt && evt.relatedTarget && coverDiv && coverDiv.contains(evt.relatedTarget)) {
    return;
  }

  if (activeHoverFileId === fileId) {
    activeHoverFileId = null;
  }

  if (hoverSlideshowIntervals[fileId]) {
    clearInterval(hoverSlideshowIntervals[fileId]);
    delete hoverSlideshowIntervals[fileId];
  }

  const file = ledgerFiles.find(f => f.id === fileId);
  const layerBg = document.getElementById(`layerBg_${fileId}`);
  const layerFg = document.getElementById(`layerFg_${fileId}`);

  if (file && file.thumbnails && file.thumbnails.length > 0) {
    const defaultThumb = file.selected_thumbnail || file.thumbnails[0];
    if (layerBg) layerBg.style.backgroundImage = `url("${defaultThumb}")`;
    if (layerFg) layerFg.style.opacity = '0';
  }

  // Reset frame dots to initial state (frame 0 active)
  const dotsContainer = document.getElementById(`dots_${fileId}`);
  if (dotsContainer && dotsContainer.children.length > 0) {
    Array.from(dotsContainer.children).forEach((dot, idx) => {
      if (idx === 0) {
        dot.classList.add('active');
      } else {
        dot.classList.remove('active');
      }
    });
  }
}

/* ==========================================================================
   METADATA & LIGHTBOX MODAL HANDLERS
   ========================================================================== */

let activeGalleryFileId = null;
let activeGalleryImages = [];
let currentGalleryIndex = 0;

function openGalleryModal(fileId) {
  const file = ledgerFiles.find(f => f.id === fileId);
  if (!file || !file.thumbnails || file.thumbnails.length === 0) {
    showToast('No screenshot frames available for this file.', 'info');
    return;
  }

  activeGalleryFileId = fileId;
  activeGalleryImages = file.thumbnails;

  // Lazy-load only this card's frames (skipped if already cached from a prior hover)
  preloadCardThumbnails(fileId);

  // Default to selected_thumbnail if present
  const selectedIdx = file.thumbnails.indexOf(file.selected_thumbnail);
  currentGalleryIndex = selectedIdx !== -1 ? selectedIdx : 0;

  const displayName = file.custom_name || file.filename;
  document.getElementById('galleryModalTitle').textContent = displayName;

  const modal = document.getElementById('galleryModal');
  modal.classList.remove('hidden');

  renderGalleryState();
}

function renderGalleryState() {
  const total = activeGalleryImages.length;
  const currentUrl = activeGalleryImages[currentGalleryIndex];

  document.getElementById('galleryModalSub').textContent = `Frame ${currentGalleryIndex + 1} of ${total}`;
  document.getElementById('galleryMainImage').src = currentUrl;

  const activeFile = ledgerFiles.find(f => f.id === activeGalleryFileId);
  const btnSet = document.getElementById('btnSetThumbnail');
  if (btnSet && activeFile) {
    const isSelected = activeFile.selected_thumbnail === currentUrl;
    if (isSelected) {
      btnSet.innerHTML = '⭐ Primary Cover';
      btnSet.style.background = 'rgba(16, 185, 129, 0.25)';
      btnSet.style.borderColor = 'rgba(16, 185, 129, 0.5)';
      btnSet.style.color = '#34d399';
    } else {
      btnSet.innerHTML = '📌 Set as Cover';
      btnSet.style.background = '';
      btnSet.style.borderColor = '';
      btnSet.style.color = '';
    }
  }

  const strip = document.getElementById('galleryThumbStrip');
  strip.innerHTML = activeGalleryImages.map((tUrl, idx) => `
    <div class="gallery-thumb-item ${idx === currentGalleryIndex ? 'active' : ''}" onclick="setGalleryIndex(${idx})">
      <img src="${tUrl}" alt="Thumb ${idx + 1}" />
    </div>
  `).join('');
}

async function setAsCoverThumbnail() {
  if (!activeGalleryFileId || !activeGalleryImages[currentGalleryIndex]) return;

  const currentUrl = activeGalleryImages[currentGalleryIndex];
  const file = ledgerFiles.find(f => f.id === activeGalleryFileId);
  if (!file) return;

  try {
    const res = await fetch(`/api/files/${activeGalleryFileId}/thumbnail`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thumbnail: currentUrl })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      file.selected_thumbnail = currentUrl;
      showToast('⭐ Primary cover thumbnail updated!', 'success');
      renderGalleryState();
      renderGalleryPage();
    } else {
      showToast(data.error || 'Failed to update thumbnail', 'error');
    }
  } catch (err) {
    showToast('Network error updating cover thumbnail', 'error');
  }
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

// Keyboard arrow key navigation for Gallery Modal
document.addEventListener('keydown', (e) => {
  const modal = document.getElementById('galleryModal');
  if (modal && !modal.classList.contains('hidden')) {
    if (e.key === 'ArrowLeft') prevGalleryImage();
    if (e.key === 'ArrowRight') nextGalleryImage();
    if (e.key === 'Escape') closeGalleryModal();
  }
});

function showFileMetadata(id) {
  const file = ledgerFiles.find(f => f.id === id);
  if (!file) return;

  const modal = document.getElementById('metadataModal');
  const titleEl = document.getElementById('metaModalTitle');
  const bodyEl = document.getElementById('metaModalBody');
  const touchBtn = document.getElementById('metaBtnTouch');
  const copyBtn = document.getElementById('metaBtnCopyGoFile');

  const meta = file.metadata || {};
  const cat = meta.category || 'file';
  const catIcon = cat === 'video' ? '🎬' : cat === 'image' ? '🖼️' : cat === 'audio' ? '🎵' : cat === 'archive' ? '📦' : '📄';

  document.getElementById('metaCategoryIcon').textContent = catIcon;
  titleEl.textContent = file.custom_name || file.filename;

  let items = [
    { label: 'File ID', value: file.id },
    { label: 'Status', value: file.status },
    { label: 'Pixeldrain Link', value: file.download_url ? `<a href="${escapeHtml(file.download_url)}" target="_blank" style="color:#60a5fa;">${escapeHtml(file.download_url)}</a>` : 'N/A', full: true },
    { label: 'Original Filename', value: file.original_filename || file.filename, full: true },
    { label: 'File Size', value: meta.size_formatted || (meta.size_bytes ? formatBytes(meta.size_bytes) : 'N/A') },
    { label: 'Category', value: (meta.category || 'N/A').toUpperCase() },
    { label: 'Resolution', value: meta.resolution || 'N/A' },
    { label: 'Duration', value: meta.duration_formatted || (meta.duration_seconds ? `${meta.duration_seconds}s` : 'N/A') },
    { label: 'Last Touched (UTC)', value: formatUTC(file.last_touched) },
    { label: 'Created At (UTC)', value: formatUTC(file.created_at) }
  ];

  bodyEl.innerHTML = items.map(item => `
    <div class="meta-item ${item.full ? 'span-2' : ''}">
      <span class="meta-label">${escapeHtml(item.label)}</span>
      <div class="meta-value">${item.value}</div>
    </div>
  `).join('');

  touchBtn.onclick = () => { triggerSingleTouch(file.id); closeMetadataModal(); };
  copyBtn.onclick = () => { copyToClipboard(file.download_url); };

  modal.classList.remove('hidden');
}

function closeMetadataModal() {
  document.getElementById('metadataModal').classList.add('hidden');
}

async function triggerSingleTouch(id) {
  try {
    const res = await fetch(`/api/files/${id}/touch`, { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`⚡ Link touched successfully! Live check OK.`, 'success');
      fetchFiles();
    } else {
      showToast(data.error || 'Touch failed.', 'error');
    }
  } catch (err) {
    showToast('Failed to touch file link.', 'error');
  }
}

function copyToClipboard(text) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    showToast('📋 Link copied to clipboard!', 'success');
  }).catch(() => {
    showToast('Failed to copy link.', 'error');
  });
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
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
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
  toast.innerHTML = `<span>${icon}</span> <span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(40px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
