// Service worker: reads the volunteer's committed shifts from VolunteerHub's vv2 JSON
// API and reconciles them into Google Calendar. Opens a tab only to let the user log in.

const VHUB_SIGNIN_URL = 'https://hopelink.volunteerhub.com/account/signin';
const VHUB_ORIGIN = 'https://hopelink.volunteerhub.com/';
const VHUB_COOKIE_URL = VHUB_ORIGIN; // cookies are queried by the URL they'd be sent to
const VHUB_AUTH_COOKIE = '.AspNet.Cookies'; // set on login; chunked into C1..Cn when large

// VolunteerHub replaced the server-rendered schedule page with a client-rendered SPA in
// August 2026, so scraping its HTML returns an empty shell. These are the API call the
// SPA's own "My Schedule" page makes: format 0 is the list view, returning days[].events[]
// plus a nextBlockUrl to page through. Internal API — no compatibility promise.
const VHUB_API_ROOT = `${VHUB_ORIGIN}internalapi/`;
const VHUB_SCHEDULE_API_URL = `${VHUB_API_ROOT}volunteerview/view/index`;
const SCHEDULE_FILTER = {
  eventGroupId: null,
  partySize: null,
  startDate: null,
  endDate: null,
  daysOfWeek: [],
  timeOfDay: null,
  locationId: null,
};
const FORMAT_LIST = 0;
const MAX_SCHEDULE_PAGES = 50; // bounds the nextBlockUrl walk against a server-side loop
const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
const CALENDAR_ID = 'primary';
const STORAGE_KEY = 'syncedEvents'; // { [vhubGuid]: { googleEventId, hash } }

// --- Auto-sync on event registration ---

let autoSyncTimer = null;
let syncInProgress = false;
let lastSyncCompletedAt = 0;
const LOGIN_SYNC_COOLDOWN_MS = 30000; // skip login sync if one ran within 30s

// Id of the tab we opened for the user to log in, closed after the next successful
// sync. Kept in session storage rather than a global: the service worker unloads
// after ~30s idle, and a forgotten id means a fresh login tab on every failed sync.
async function getLoginTabId() {
  const { loginTabId } = await chrome.storage.session.get('loginTabId');
  return typeof loginTabId === 'number' ? loginTabId : null;
}

async function setLoginTabId(tabId) {
  if (tabId === null) {
    await chrome.storage.session.remove('loginTabId');
  } else {
    await chrome.storage.session.set({ loginTabId: tabId });
  }
}

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

    // Navigation in the login tab is deliberately not excluded: these URL filters only
    // match post-login landing pages, so a hit there is the signal that login succeeded.

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
      // Post-vv2 schedule route, plus the legacy path that still redirects to it.
      { urlPrefix: 'https://hopelink.volunteerhub.com/vv2/events/myschedule' },
      { urlPrefix: 'https://hopelink.volunteerhub.com/events/myschedule' },
    ],
  },
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startSync') {
    runSync()
      .then((result) => {
        if (result.skipped) {
          sendResponse({ success: true, skipped: true });
        } else {
          sendResponse({ success: true, ...result });
        }
      })
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
    collectDiagnostics().then(sendResponse);
    return true;
  }
});

// Reports what the schedule fetch actually does right now, alongside the cookie
// state that determines whether it can succeed. Read-only: touches no calendar.
async function collectDiagnostics() {
  const state = await getStoredSyncState();
  const events = Object.entries(state).map(([vhubId, data]) => ({
    vhubId,
    googleEventId: data.googleEventId,
    title: JSON.parse(data.hash).title || '(unknown)',
  }));

  const { result: schedule, trace } = await traceScheduleRequest(fetchScheduleEvents);
  const connection = [];
  const mapped = schedule.ok ? schedule.raw.map(mapApiEvent).filter(Boolean) : [];

  if (schedule.ok) {
    connection.push(
      `Schedule API: OK — ${schedule.raw.length} events over ${schedule.pages} page(s)` +
      `${schedule.truncated ? ' (TRUNCATED at the page limit)' : ''}`,
      `  mapped successfully: ${mapped.length} of ${schedule.raw.length}`,
    );

    // The decisive check before a first sync: if these ids do not line up with the
    // stored ones, reconciliation would treat every shift as new and duplicate the lot.
    const storedIds = new Set(Object.keys(state));
    const overlap = mapped.filter((event) => storedIds.has(event.id)).length;
    connection.push(
      `  ids matching stored sync state: ${overlap} of ${mapped.length}` +
      `${storedIds.size && !overlap ? '  ← WARNING: no overlap, a sync would duplicate every event' : ''}`,
    );
    if (mapped.length) {
      const sample = mapped[0];
      connection.push(`  sample: ${sample.title} | ${sample.startDateTime} → ${sample.endDateTime} | ${sample.location || '(no location)'}`);
    }
  } else {
    connection.push(`Schedule API: FAILED — ${schedule.detail}`);
    if (await hasAuthCookie()) {
      connection.push(`  a ${VHUB_AUTH_COOKIE} cookie exists, so the session is not being accepted`);
    }
  }

  // Names and attributes only. Cookie values are session tokens and are never read
  // out: sameSite is the field that decides whether a background fetch sends them.
  let cookies;
  try {
    // Filter by url, not domain: a domain filter excludes cookies set on the parent
    // .volunteerhub.com, and it is precisely "would this cookie be sent" we care about.
    const jar = await chrome.cookies.getAll({ url: VHUB_COOKIE_URL });
    cookies = jar.length
      ? jar.map((c) => `${c.name} [sameSite=${c.sameSite}, ${c.session ? 'session' : 'persistent'}]`)
      : ['(none — you are not logged in to VolunteerHub in this browser)'];
  } catch (err) {
    cookies = [`(unavailable: ${err.message})`];
  }

  const wire = [
    `Cookie header sent: ${trace.cookieNames.length ? `${trace.cookieNames.length} cookies, ${trace.cookieHeaderBytes} bytes` : 'NONE'}`,
    `  auth cookies on the wire: ${trace.cookieNames.filter((n) => n.startsWith(VHUB_AUTH_COOKIE)).join(', ') || 'NONE'}`,
    `Redirected: ${trace.redirectedTo ? `${trace.statusCode} → ${trace.redirectedTo}` : 'no redirect observed'}`,
  ];

  return {
    trackedCount: events.length,
    hashVersion: HASH_VERSION,
    connection,
    wire,
    cookies,
    events,
  };
}

// --- Sync ---

async function runSync() {
  if (syncInProgress) {
    console.log('Sync already in progress — skipping');
    return { skipped: true };
  }
  syncInProgress = true;
  try {
    return await _runSync();
  } finally {
    syncInProgress = false;
  }
}

// --- VolunteerHub schedule API ---

function scheduleApiUrl() {
  const params = new URLSearchParams({
    filter: JSON.stringify(SCHEDULE_FILTER),
    format: String(FORMAT_LIST),
    mySchedule: 'true',
  });
  return `${VHUB_SCHEDULE_API_URL}?${params}`;
}

// nextBlockUrl comes back relative to the API root, the way the SPA's HTTP client
// resolves it. Anything that resolves off-origin is refused rather than followed.
function resolveApiUrl(value) {
  const resolved = new URL(String(value).replace(/^\//, ''), VHUB_API_ROOT).toString();
  return resolved.startsWith(VHUB_ORIGIN) ? resolved : null;
}

// Walks the paged schedule endpoint. Returns a verdict rather than throwing, so the
// caller can tell "signed out" apart from "the request failed" — conflating those is
// what made the previous breakage undiagnosable.
async function fetchScheduleEvents() {
  const raw = [];
  let url = scheduleApiUrl();
  let pages = 0;

  while (url && pages < MAX_SCHEDULE_PAGES) {
    let response;
    try {
      response = await fetch(url, {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' }, // what the SPA's client sends
      });
    } catch (err) {
      // A redirect off-origin to the identity provider trips CORS and throws, looking
      // exactly like a network failure. Absence of a session cookie is what separates
      // them: with no cookie, being signed out is by far the likelier explanation.
      const signedOut = !(await hasAuthCookie());
      return {
        ok: false,
        authFailure: signedOut,
        detail: `request failed: ${err.message}${signedOut ? ' (no session cookie — probably signed out)' : ''}`,
      };
    }

    // An expired session either gets a 401 from the API or is redirected to the
    // identity provider; a redirect that stays on VolunteerHub is just a moved route.
    if (response.status === 401 || response.status === 403) {
      return { ok: false, authFailure: true, detail: `HTTP ${response.status} from the schedule API` };
    }
    if (!response.url.startsWith(VHUB_ORIGIN)) {
      return { ok: false, authFailure: true, detail: `redirected off-origin to ${response.url}` };
    }
    if (!response.ok) {
      return { ok: false, authFailure: false, detail: `HTTP ${response.status} ${response.statusText}`.trim() };
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      // HTML here means a sign-in page served with a 200.
      return { ok: false, authFailure: true, detail: `expected JSON, got something else (${err.message})` };
    }

    for (const day of data.days || []) {
      raw.push(...(day.events || []));
    }

    pages++;
    url = data.nextBlockUrl ? resolveApiUrl(data.nextBlockUrl) : null;
  }

  return { ok: true, raw, pages, truncated: Boolean(url) };
}

// --- Event mapping ---

// sTime/eTime are whatever the API hands back; the SPA parses them with new Date().
// A value carrying no zone designator is a local wall-clock time, so it is stamped with
// the local offset — Google Calendar rejects a dateTime with no offset at all.
function toRfc3339(value) {
  if (!value) return null;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return value;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:00` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// shortDescription is TinyMCE HTML. DOMParser does not exist in a service worker and
// pulling in an offscreen document to strip tags is not worth it for a description.
function htmlToText(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// guid is preferred over id: it is the same GUID the old HTML scraper read out of the
// event href, so stored sync state carries over instead of duplicating every event.
function mapApiEvent(event) {
  const id = event.guid || event.id;
  const startDateTime = toRfc3339(event.sTime);
  const endDateTime = toRfc3339(event.eTime) || startDateTime;
  if (!id || !startDateTime) return null;

  return {
    id: String(id),
    title: String(event.name || '').trim(),
    startDateTime,
    endDateTime,
    location: String(event.location || '').trim(),
    description: htmlToText(event.shortDescription || ''),
  };
}

async function _runSync() {
  // 1. Read the schedule from the vv2 API
  const schedule = await fetchScheduleEvents();

  if (!schedule.ok) {
    if (!schedule.authFailure) {
      // Logging in cannot fix this, so do not open a tab implying that it can.
      throw new Error(`Could not reach VolunteerHub — ${schedule.detail}`);
    }

    // Genuinely unauthenticated — open one visible tab so the user can sign in.
    let loginTabId = await getLoginTabId();
    if (loginTabId !== null && !(await tabExists(loginTabId))) {
      loginTabId = null; // user closed it
    }
    if (loginTabId === null) {
      const tab = await chrome.tabs.create({ url: VHUB_SIGNIN_URL, active: true });
      await setLoginTabId(tab.id);
    }
    throw new Error(`Not logged in — opened VolunteerHub so you can log in (${schedule.detail})`);
  }

  // Reaching the API means the session is good — close the login tab if one is open.
  const loginTabId = await getLoginTabId();
  if (loginTabId !== null) {
    await setLoginTabId(null);
    chrome.tabs.remove(loginTabId).catch(() => {});
  }

  // 2. Map API events, keeping track of any the mapping could not use
  const warnings = [];
  const scrapedEvents = [];
  let unmapped = 0;
  for (const raw of schedule.raw) {
    const mapped = mapApiEvent(raw);
    if (mapped) scrapedEvents.push(mapped);
    else unmapped++;
  }
  if (unmapped > 0) {
    warnings.push(`${unmapped} event(s) from the API could not be read (missing id or start time) and were ignored.`);
  }
  if (schedule.truncated) {
    warnings.push(`Stopped after ${MAX_SCHEDULE_PAGES} pages of schedule data — some shifts may be missing. Removals skipped.`);
  }

  // 3. Get Google OAuth token
  const token = await getAuthToken();

  // 4. Load previous sync state
  const stored = await getStoredSyncState();

  // The API exposes both `guid` and `id`; the old scraper keyed off the GUID in the
  // event href. If the key chosen in mapApiEvent were the wrong one, every shift would
  // read as new and be duplicated onto the calendar while the originals were orphaned.
  // Total non-overlap against existing state is not a recoverable condition, so stop.
  const storedIds = Object.keys(stored);
  const overlap = scrapedEvents.filter((event) => stored[event.id]).length;
  if (storedIds.length > 0 && scrapedEvents.length > 0 && overlap === 0) {
    throw new Error(
      `Refusing to sync: none of the ${scrapedEvents.length} shifts from the API match ` +
      `any of the ${storedIds.length} already tracked, so syncing would duplicate all of ` +
      'them. The API event id may have changed meaning — check Diagnostics before proceeding.',
    );
  }

  // An empty schedule is legitimate, but it is also what a broken read looks like.
  // Requiring a page of data before honouring mass removals keeps a bad response from
  // clearing a calendar full of real shifts.
  const allowRemovals = !schedule.truncated && (scrapedEvents.length > 0 || Object.keys(stored).length === 0);
  if (!allowRemovals && !schedule.truncated) {
    warnings.push('The API returned no shifts while events are still tracked — removals skipped pending a non-empty read.');
  }

  // 5. Reconcile and sync
  const result = await reconcileAndSync(scrapedEvents, stored, token, allowRemovals);

  lastSyncCompletedAt = Date.now();
  await chrome.storage.local.set({ lastSyncCompletedAt });

  return { ...result, warnings };
}

// Observes what a schedule request actually puts on the wire and where the server
// sends it. This is the difference between "Chrome withheld the cookie" and "the
// server rejected it" — indistinguishable from the response alone.
// Cookie names and byte counts only: the values are session tokens and are not read.
async function traceScheduleRequest(run) {
  const trace = { cookieNames: [], cookieHeaderBytes: 0, statusCode: null, redirectedTo: null };
  // Glob the path loosely: the schedule endpoint has already moved once, and a filter
  // pinned to one exact path silently observes nothing when it moves again.
  const filter = { urls: ['https://hopelink.volunteerhub.com/internalapi/volunteerview/*'] };

  const onSendHeaders = (details) => {
    const cookie = (details.requestHeaders || []).find((h) => h.name.toLowerCase() === 'cookie');
    if (!cookie || !cookie.value) return;
    trace.cookieHeaderBytes = cookie.value.length;
    trace.cookieNames = cookie.value
      .split(';')
      .map((pair) => pair.split('=')[0].trim())
      .filter(Boolean);
  };

  const onBeforeRedirect = (details) => {
    trace.statusCode = details.statusCode;
    try {
      const target = new URL(details.redirectUrl);
      trace.redirectedTo = `${target.origin}${target.pathname}`; // query carries auth state
    } catch {
      trace.redirectedTo = '(unparseable redirect target)';
    }
  };

  chrome.webRequest.onSendHeaders.addListener(onSendHeaders, filter, ['requestHeaders', 'extraHeaders']);
  chrome.webRequest.onBeforeRedirect.addListener(onBeforeRedirect, filter);
  try {
    return { result: await run(), trace };
  } finally {
    chrome.webRequest.onSendHeaders.removeListener(onSendHeaders);
    chrome.webRequest.onBeforeRedirect.removeListener(onBeforeRedirect);
  }
}

// Whether a VolunteerHub login cookie exists in this profile, regardless of whether
// Chrome is willing to send it on our requests.
async function hasAuthCookie() {
  try {
    const jar = await chrome.cookies.getAll({ url: VHUB_COOKIE_URL });
    return jar.some((c) => c.name.startsWith(VHUB_AUTH_COOKIE));
  } catch {
    return false;
  }
}

async function tabExists(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
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

// Bump HASH_VERSION to force re-sync of all events (e.g. after changing colorId).
// 3: source moved from scraped HTML to the vv2 JSON API, so titles, locations and
// descriptions parse differently even where the underlying shift is unchanged.
const HASH_VERSION = 3;

function eventHash(event) {
  return JSON.stringify({
    v: HASH_VERSION,
    title: event.title,
    startDateTime: event.startDateTime,
    endDateTime: event.endDateTime,
    location: event.location,
  });
}

async function deduplicateCalendarEvents(storedState, token) {
  const allEvents = [];
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      privateExtendedProperty: 'source=hopelink-cal-sync',
      maxResults: '250',
      showDeleted: 'false',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(CALENDAR_ID)}/events?${params}`;
    const result = await calendarApiFetch(url, { method: 'GET' }, token);
    if (result.items) allEvents.push(...result.items);
    pageToken = result.nextPageToken || null;
  } while (pageToken);

  // Group by vhubEventId
  const byVhubId = new Map();
  for (const event of allEvents) {
    if (event.status === 'cancelled') continue;
    const vhubId = event.extendedProperties?.private?.vhubEventId;
    if (!vhubId) continue;
    if (!byVhubId.has(vhubId)) byVhubId.set(vhubId, []);
    byVhubId.get(vhubId).push(event);
  }

  let duplicatesRemoved = 0;
  const updatedState = { ...storedState };
  let stateChanged = false;

  for (const [vhubId, events] of byVhubId) {
    if (events.length <= 1) continue;

    // Prefer the event referenced in stored state; otherwise keep most recently updated
    const storedGoogleId = storedState[vhubId]?.googleEventId;
    events.sort((a, b) => {
      if (a.id === storedGoogleId) return -1;
      if (b.id === storedGoogleId) return 1;
      return new Date(b.updated) - new Date(a.updated);
    });

    const [keeper, ...extras] = events;

    // Repoint stored state to the keeper if needed
    if (updatedState[vhubId] && updatedState[vhubId].googleEventId !== keeper.id) {
      updatedState[vhubId] = { ...updatedState[vhubId], googleEventId: keeper.id };
      stateChanged = true;
    }

    for (const extra of extras) {
      try {
        await deleteCalendarEvent(extra.id, token);
        duplicatesRemoved++;
      } catch (err) {
        if (err.status === 404 || err.status === 410) {
          duplicatesRemoved++;
        } else {
          console.error(`Failed to delete duplicate calendar event ${extra.id}:`, err.message);
        }
      }
    }
  }

  if (stateChanged) {
    await saveStoredSyncState(updatedState);
  }

  return { duplicatesRemoved, updatedState: stateChanged ? updatedState : storedState };
}

async function reconcileAndSync(scrapedEvents, storedState, token, allowRemovals = true) {
  const { duplicatesRemoved, updatedState } = await deduplicateCalendarEvents(storedState, token);
  storedState = updatedState;

  const currentIds = new Set(scrapedEvents.map((e) => e.id));
  const storedIds = new Set(Object.keys(storedState));
  const newState = { ...storedState };

  let added = 0;
  let updated = 0;
  let removed = 0;
  let unchanged = 0;
  let kept = 0;
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

  // Remove events no longer on schedule (skip past events — leave them on the calendar).
  // Skipped entirely when the fetched page was not recognisable as a schedule, so an
  // unparseable page cannot be mistaken for "the user cancelled everything".
  for (const storedId of allowRemovals ? storedIds : []) {
    if (!currentIds.has(storedId)) {
      const { googleEventId, hash } = storedState[storedId];

      // Check if the event has already occurred — if so, leave it on the calendar
      try {
        const eventData = JSON.parse(hash);
        const endTime = new Date(eventData.endDateTime || eventData.startDateTime);
        if (endTime < new Date()) {
          kept++;
          continue;
        }
      } catch {
        // If we can't parse the hash, fall through to delete
      }

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

  return { added, updated, removed, unchanged, kept, duplicatesRemoved, errors, total: scrapedEvents.length };
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
