// Service worker: orchestrates background fetch, HTML parsing (via offscreen document),
// and Google Calendar sync. Opens a tab only when user needs to log in.

const VHUB_SCHEDULE_URL = 'https://hopelink.volunteerhub.com/events/myschedule?format=List';
const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
const CALENDAR_ID = 'primary';
const STORAGE_KEY = 'syncedEvents'; // { [vhubGuid]: { googleEventId, hash } }

// --- Auto-sync on event registration ---

let autoSyncTimer = null;
let lastSyncCompletedAt = 0;
let loginTabId = null; // Tab opened for user to log in — closed after successful login
const LOGIN_SYNC_COOLDOWN_MS = 30000; // skip login sync if one ran within 30s

// Restore last sync timestamp from storage (survives service worker restarts)
chrome.storage.local.get('lastSyncCompletedAt', (result) => {
  if (result.lastSyncCompletedAt) {
    lastSyncCompletedAt = result.lastSyncCompletedAt;
  }
});

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (['PUT', 'POST'].includes(details.method) && details.statusCode >= 200 && details.statusCode < 300) {
      // Debounce: wait 3s after last registration request before syncing
      if (autoSyncTimer) clearTimeout(autoSyncTimer);
      autoSyncTimer = setTimeout(() => {
        autoSyncTimer = null;
        runSync().catch((err) => {
          console.error('Auto-sync failed:', err.message);
        });
      }, 3000);
    }
  },
  {
    urls: [
      'https://hopelink.volunteerhub.com/internalapi/wizard/EventRegistration/*',
      'https://hopelink.volunteerhub.com/internalapi/wizard/EventRegistrationCancellation/*',
    ],
  },
);

// --- Auto-sync on login (landing page) ---

chrome.webNavigation.onCompleted.addListener(
  (details) => {
    // Only top-level frame, not iframes
    if (details.frameId !== 0) return;

    // Ignore navigation in the login tab — it triggers on initial load before
    // the user has actually logged in. The login tab is closed by runSync on success.
    if (loginTabId !== null && details.tabId === loginTabId) return;

    // Skip if a sync completed recently (add/delete listeners already cover it)
    if (Date.now() - lastSyncCompletedAt < LOGIN_SYNC_COOLDOWN_MS) {
      console.log('Login sync skipped — recent sync already completed');
      return;
    }

    // Debounce with the same timer as auto-sync to avoid overlap
    if (autoSyncTimer) clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(() => {
      autoSyncTimer = null;
      console.log('Login detected — starting sync');
      runSync().catch((err) => {
        console.error('Login sync failed:', err.message);
      });
    }, 3000);
  },
  {
    url: [
      { urlEquals: 'https://hopelink.volunteerhub.com/vv2/' },
      { urlEquals: 'https://hopelink.volunteerhub.com/events/myschedule'}
    ],
  },
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startSync') {
    runSync()
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'getLastSyncTime') {
    chrome.storage.local.get('lastSyncCompletedAt', (result) => {
      sendResponse({ lastSyncCompletedAt: result.lastSyncCompletedAt || 0 });
    });
    return true;
  }

  if (message.action === 'getDiagnostics') {
    getStoredSyncState().then((state) => {
      const events = Object.entries(state).map(([vhubId, data]) => ({
        vhubId,
        googleEventId: data.googleEventId,
        title: JSON.parse(data.hash).title || '(unknown)',
      }));
      sendResponse({
        trackedCount: events.length,
        hashVersion: HASH_VERSION,
        events,
      });
    });
    return true;
  }
});

// --- Sync ---

async function runSync() {
  // 1. Fetch schedule HTML in the background (no tab)
  //    Works when logged in; throws on auth redirect (CORS blocks the OAuth domain)
  let html;
  try {
    const response = await fetch(VHUB_SCHEDULE_URL, {
      credentials: 'include',
      redirect: 'manual',
    });
    // redirect: 'manual' returns an opaque response (type/status 0) on redirect,
    // avoiding the CORS error that occurs when the browser follows the OAuth redirect.
    if (response.type === 'opaqueredirect' || !response.ok) {
      throw new Error('redirect');
    }
    html = await response.text();
  } catch {
    // Not logged in — open a visible tab so user can authenticate (if not already open)
    if (loginTabId === null) {
      const tab = await chrome.tabs.create({ url: 'https://hopelink.volunteerhub.com/account/signin', active: true });
      loginTabId = tab.id;
    }
    throw new Error('Not logged in — opened VolunteerHub so you can log in');
  }

  // Login succeeded — close the login tab if we had one open
  if (loginTabId !== null) {
    const tabToClose = loginTabId;
    loginTabId = null;
    chrome.tabs.remove(tabToClose).catch(() => {});
  }

  // 2. Parse HTML via offscreen document (service workers lack DOMParser)
  const scrapedEvents = await parseEventsOffscreen(html);

  // 3. Get Google OAuth token
  const token = await getAuthToken();

  // 4. Load previous sync state
  const stored = await getStoredSyncState();

  // 5. Reconcile and sync
  const result = await reconcileAndSync(scrapedEvents, stored, token);

  lastSyncCompletedAt = Date.now();
  await chrome.storage.local.set({ lastSyncCompletedAt });

  return result;
}

// --- Offscreen Document Management ---

let offscreenCreated = false;

async function ensureOffscreenDocument() {
  if (offscreenCreated) return;

  // Check if one already exists (e.g. from a prior service worker lifecycle)
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length > 0) {
    offscreenCreated = true;
    return;
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: 'Parse VolunteerHub schedule HTML into structured event data',
  });
  offscreenCreated = true;
}

async function parseEventsOffscreen(html) {
  await ensureOffscreenDocument();

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'parseScheduleHTML', html }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(`Offscreen parse failed: ${chrome.runtime.lastError.message}`));
        return;
      }
      if (!response || !response.events) {
        reject(new Error('No events returned from offscreen parser'));
        return;
      }
      resolve(response.events);
    });
  });
}

// --- Google Auth ---

function getAuthToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(`Auth failed: ${chrome.runtime.lastError.message}`));
        return;
      }
      resolve(token);
    });
  });
}

// --- Storage ---

async function getStoredSyncState() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || {};
}

async function saveStoredSyncState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

// --- Reconciliation & Sync ---

// Bump HASH_VERSION to force re-sync of all events (e.g. after changing colorId)
const HASH_VERSION = 2;

function eventHash(event) {
  return JSON.stringify({
    v: HASH_VERSION,
    title: event.title,
    startDateTime: event.startDateTime,
    endDateTime: event.endDateTime,
    location: event.location,
  });
}

async function reconcileAndSync(scrapedEvents, storedState, token) {
  const currentIds = new Set(scrapedEvents.map((e) => e.id));
  const storedIds = new Set(Object.keys(storedState));
  const newState = { ...storedState };

  let added = 0;
  let updated = 0;
  let removed = 0;
  let unchanged = 0;
  const errors = [];

  // Add or update events
  for (const event of scrapedEvents) {
    const hash = eventHash(event);
    const existing = storedState[event.id];

    if (!existing) {
      // New event — create in Google Calendar
      try {
        const googleEventId = await createCalendarEvent(event, token);
        newState[event.id] = { googleEventId, hash };
        added++;
      } catch (err) {
        errors.push(`Failed to add "${event.title}": ${err.message}`);
      }
    } else {
      // Event exists in stored state — verify it still exists in Google Calendar
      const existsInCalendar = await calendarEventExists(existing.googleEventId, token);

      if (!existsInCalendar) {
        // Re-create: manually deleted from calendar
        try {
          const googleEventId = await createCalendarEvent(event, token);
          newState[event.id] = { googleEventId, hash };
          added++;
        } catch (err) {
          errors.push(`Failed to re-add "${event.title}": ${err.message}`);
        }
      } else if (existing.hash !== hash) {
        // Event details changed — update in Google Calendar
        try {
          await updateCalendarEvent(existing.googleEventId, event, token);
          newState[event.id] = { googleEventId: existing.googleEventId, hash };
          updated++;
        } catch (err) {
          errors.push(`Failed to update "${event.title}": ${err.message}`);
        }
      } else {
        unchanged++;
      }
    }
  }

  // Remove events no longer on schedule
  for (const storedId of storedIds) {
    if (!currentIds.has(storedId)) {
      const { googleEventId } = storedState[storedId];
      try {
        await deleteCalendarEvent(googleEventId, token);
        delete newState[storedId];
        removed++;
      } catch (err) {
        // If event already deleted from calendar, just clean up state
        if (err.status === 404 || err.status === 410) {
          delete newState[storedId];
          removed++;
        } else {
          errors.push(`Failed to remove event: ${err.message}`);
        }
      }
    }
  }

  await saveStoredSyncState(newState);

  return { added, updated, removed, unchanged, errors, total: scrapedEvents.length };
}

// --- Google Calendar API ---

async function calendarApiFetch(url, options, token) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const error = new Error(`Calendar API error: ${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }

  if (response.status === 204) return null;
  return response.json();
}

function buildCalendarEventBody(event) {
  return {
    summary: `[Hopelink] ${event.title}`,
    colorId: '11', // Tomato
    location: event.location || undefined,
    description: event.description
      ? `${event.description}\n\nSynced from VolunteerHub`
      : 'Synced from VolunteerHub',
    start: {
      dateTime: event.startDateTime,
    },
    end: {
      dateTime: event.endDateTime,
    },
    extendedProperties: {
      private: {
        vhubEventId: event.id,
        source: 'hopelink-cal-sync',
      },
    },
  };
}

async function calendarEventExists(googleEventId, token) {
  const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${encodeURIComponent(googleEventId)}`;
  try {
    const result = await calendarApiFetch(url, { method: 'GET' }, token);
    // Google Calendar keeps cancelled events — treat them as deleted
    return result && result.status !== 'cancelled';
  } catch (err) {
    if (err.status === 404 || err.status === 410) return false;
    throw err;
  }
}

async function createCalendarEvent(event, token) {
  const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(CALENDAR_ID)}/events`;
  const body = buildCalendarEventBody(event);
  const result = await calendarApiFetch(url, {
    method: 'POST',
    body: JSON.stringify(body),
  }, token);
  return result.id;
}

async function updateCalendarEvent(googleEventId, event, token) {
  const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${encodeURIComponent(googleEventId)}`;
  const body = buildCalendarEventBody(event);
  await calendarApiFetch(url, {
    method: 'PUT',
    body: JSON.stringify(body),
  }, token);
}

async function deleteCalendarEvent(googleEventId, token) {
  const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${encodeURIComponent(googleEventId)}`;
  await calendarApiFetch(url, {
    method: 'DELETE',
  }, token);
}
