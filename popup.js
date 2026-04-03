const syncBtn = document.getElementById('syncBtn');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const errorsEl = document.getElementById('errors');
const lastSyncEl = document.getElementById('lastSync');

let lastSyncTime = 0;
let lastSyncInterval = null;

function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s ago`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s ago`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return `${hours}h ${remainMinutes}m ago`;
}

function updateLastSyncDisplay() {
  if (!lastSyncTime) {
    lastSyncEl.classList.add('hidden');
    return;
  }
  const elapsed = Date.now() - lastSyncTime;
  lastSyncEl.textContent = `Last synced ${formatElapsed(elapsed)}`;
  lastSyncEl.classList.remove('hidden');
}

function startLastSyncTimer() {
  updateLastSyncDisplay();
  if (lastSyncInterval) clearInterval(lastSyncInterval);
  lastSyncInterval = setInterval(updateLastSyncDisplay, 1000);
}

// Fetch last sync time on popup open
chrome.runtime.sendMessage({ action: 'getLastSyncTime' }, (response) => {
  if (response && response.lastSyncCompletedAt) {
    lastSyncTime = response.lastSyncCompletedAt;
    startLastSyncTimer();
  }
});

syncBtn.addEventListener('click', async () => {
  setStatus('Syncing...', 'syncing');
  syncBtn.disabled = true;
  resultsEl.classList.add('hidden');
  errorsEl.classList.add('hidden');

  chrome.runtime.sendMessage({ action: 'startSync' }, (response) => {
    syncBtn.disabled = false;

    if (chrome.runtime.lastError) {
      setStatus(`Error: ${chrome.runtime.lastError.message}`, 'error');
      return;
    }

    if (!response) {
      setStatus('No response from background script', 'error');
      return;
    }

    if (!response.success) {
      setStatus(`Error: ${response.error}`, 'error');
      return;
    }

    if (response.skipped) {
      setStatus('Sync already in progress — try again shortly', 'syncing');
      return;
    }

    const accounted = response.added + response.updated + response.unchanged;
    if (accounted < response.total) {
      setStatus(`Warning: found ${response.total} events but only processed ${accounted}`, 'error');
    } else {
      setStatus(`Synced ${response.total} events`, 'success');
    }
    showResults(response);

    lastSyncTime = Date.now();
    startLastSyncTimer();

    if (response.errors && response.errors.length > 0) {
      errorsEl.textContent = response.errors.join('\n');
      errorsEl.classList.remove('hidden');
    }
  });
});

function setStatus(text, className) {
  statusEl.textContent = text;
  statusEl.className = `status ${className}`;
  statusEl.classList.remove('hidden');
}

// --- Diagnostics ---

const diagBtn = document.getElementById('diagBtn');
const diagInfo = document.getElementById('diagInfo');

diagBtn.addEventListener('click', () => {
  diagInfo.textContent = 'Loading...';
  diagInfo.classList.remove('hidden');

  chrome.runtime.sendMessage({ action: 'getDiagnostics' }, (response) => {
    if (chrome.runtime.lastError) {
      diagInfo.textContent = `Error: ${chrome.runtime.lastError.message}`;
      return;
    }
    if (!response) {
      diagInfo.textContent = 'No response from background script';
      return;
    }

    const lines = [
      `Tracked events: ${response.trackedCount}`,
      `Storage version: ${response.hashVersion}`,
      '',
      ...response.events.map(
        (e) => `${e.title}\n  VHub: ${e.vhubId.substring(0, 8)}...\n  GCal: ${e.googleEventId}`,
      ),
    ];
    diagInfo.textContent = lines.join('\n');
  });
});

function showResults({ total, added, updated, removed, unchanged, duplicatesRemoved }) {
  document.getElementById('totalCount').textContent = total;
  document.getElementById('addedCount').textContent = added;
  document.getElementById('updatedCount').textContent = updated;
  document.getElementById('removedCount').textContent = removed;
  document.getElementById('unchangedCount').textContent = unchanged;

  const dedupRow = document.getElementById('dedupRow');
  if (duplicatesRemoved > 0) {
    document.getElementById('dedupCount').textContent = duplicatesRemoved;
    dedupRow.classList.remove('hidden');
  } else {
    dedupRow.classList.add('hidden');
  }

  resultsEl.classList.remove('hidden');
}
