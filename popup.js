const syncBtn = document.getElementById('syncBtn');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const errorsEl = document.getElementById('errors');

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

    const accounted = response.added + response.updated + response.unchanged;
    if (accounted !== response.total) {
      setStatus(`Warning: found ${response.total} events but only processed ${accounted}`, 'error');
    } else {
      setStatus(`Synced ${response.total} events`, 'success');
    }
    showResults(response);

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

function showResults({ total, added, updated, removed, unchanged }) {
  document.getElementById('totalCount').textContent = total;
  document.getElementById('addedCount').textContent = added;
  document.getElementById('updatedCount').textContent = updated;
  document.getElementById('removedCount').textContent = removed;
  document.getElementById('unchangedCount').textContent = unchanged;
  resultsEl.classList.remove('hidden');
}
