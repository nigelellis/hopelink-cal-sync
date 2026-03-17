// Service worker: orchestrates tab management, event scraping, and Google Calendar sync.

const VHUB_SCHEDULE_URL = 'https://hopelink.volunteerhub.com/events/myschedule';
const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
const CALENDAR_ID = 'primary';
const STORAGE_KEY = 'syncedEvents'; // { [vhubGuid]: { googleEventId, hash } }

// --- Auto-sync on event registration ---

let autoSyncTimer = null;

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.method === 'POST' && details.statusCode >= 200 && details.statusCode < 300) {
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startSync') {
    runSync()
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
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

async function runSync() {
  // 1. Open or reload the schedule tab
  const tab = await openOrReloadScheduleTab();

  // 2. Wait for tab to finish loading
  await waitForTabLoad(tab.id);

  // 3. Scrape events from the page
  const scrapedEvents = await scrapeEventsFromTab(tab.id);

  // 4. Get Google OAuth token
  const token = await getAuthToken();

  // 5. Load previous sync state
  const stored = await getStoredSyncState();

  // 6. Reconcile and sync
  const result = await reconcileAndSync(scrapedEvents, stored, token);

  return result;
}

// --- Tab Management ---

async function openOrReloadScheduleTab() {
  const tabs = await chrome.tabs.query({ url: 'https://hopelink.volunteerhub.com/*' });
  const scheduleTab = tabs.find((t) =>
    t.url && t.url.includes('/events/myschedule'),
  );

  if (scheduleTab) {
    await chrome.tabs.reload(scheduleTab.id);
    return scheduleTab;
  }

  return chrome.tabs.create({ url: VHUB_SCHEDULE_URL, active: false });
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        // Small delay to let content script initialize
        setTimeout(resolve, 500);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function scrapeEventsFromTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { action: 'scrapeEvents' }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(`Failed to scrape: ${chrome.runtime.lastError.message}`));
        return;
      }
      if (!response || !response.events) {
        reject(new Error('No events returned from content script'));
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
