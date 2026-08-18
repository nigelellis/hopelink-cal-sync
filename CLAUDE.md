# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome extension (Manifest V3) that syncs committed volunteer shifts from Hopelink's VolunteerHub to Google Calendar. No build system, bundler, or package manager — plain JavaScript loaded directly by Chrome.

## Development

**Load the extension:** `chrome://extensions` → Developer mode → Load unpacked → select project folder.

**No build/lint/test commands.** This is a vanilla JS Chrome extension with no toolchain. Changes take effect after reloading the extension in `chrome://extensions`.

**OAuth setup required:** You need a Google Cloud project with Calendar API enabled and an OAuth 2.0 client ID configured for Chrome extensions. The client ID goes in `manifest.json` under `oauth2.client_id`.

## Architecture

Two execution contexts communicate via Chrome's message-passing API:

- **`background.js`** — Service worker. Orchestrates the entire sync flow: reads the schedule from VolunteerHub's vv2 JSON API, maps it to calendar events, and handles Google Calendar API calls and reconciliation. Listens for `startSync`, `getLastSyncTime`, and `getDiagnostics` messages from the popup, and auto-triggers sync via `webRequest` (event registration/cancellation) and `webNavigation` (login/landing page) listeners.

- **`popup.js` / `popup.html` / `popup.css`** — Extension popup UI. "Sync Now" button, result counters, diagnostics panel. Communicates with the background worker via `chrome.runtime.sendMessage`.

### Schedule Source

VolunteerHub replaced the server-rendered schedule page with a client-rendered SPA in August 2026. `/events/myschedule` now redirects to `/vv2/events/myschedule`, which returns only an empty app shell — there is no HTML left to scrape. The extension therefore calls the same internal API the SPA itself uses:

```
GET /internalapi/volunteerview/view/index?filter={...}&format=0&mySchedule=true
    X-Requested-With: XMLHttpRequest
```

It returns `{ format, days: [{ events: [...] }], nextBlockUrl }`, paged via `nextBlockUrl`. Each event carries `guid`, `id`, `name`, `sTime`, `eTime`, `location`, `shortDescription`. **This is an internal endpoint with no compatibility promise** — if sync breaks again, re-check it against the SPA bundle at `/vv2/assets/index-*.js` (the store lives in the `CalendarPanel-*.js` chunk).

### Sync Flow

1. Background calls the schedule API, following `nextBlockUrl` until exhausted (cookies sent via `host_permissions`)
2. Events are mapped to `{ id, title, startDateTime, endDateTime, location, description }`, keyed by `guid` — the same GUID the pre-vv2 HTML scraper read from the event href, so stored state survived the migration
3. Background reconciles against stored state in `chrome.storage.local` (keyed by VolunteerHub GUID)
4. Diffs are pushed to Google Calendar API (create/update/delete)
5. Calendar events are prefixed `[Hopelink]`, colored Tomato (`colorId: '11'`), and tagged with `extendedProperties.private.source: 'hopelink-cal-sync'`

### Safety Rails

Reconciliation refuses to delete when it cannot trust the read: removals are skipped if the API returned no shifts while events are still tracked, or if paging hit `MAX_SCHEDULE_PAGES`. A sync where none of the fetched ids match any tracked id aborts outright rather than duplicating every event. These exist because a silent parse failure once looked identical to "the user cancelled everything."

### Key Mechanisms

- **`HASH_VERSION`** (in `background.js`): Bump this integer to force re-sync of all events (e.g., after changing event formatting like `colorId`). Currently 3 — bumped when the source moved from scraped HTML to the JSON API.
- **Diagnostics** (popup): runs a live, read-only schedule read and reports the API result, how many ids match stored state, the `Cookie` header actually sent, and any redirect target. Reach for this first when sync breaks — it is what distinguishes "signed out" from "the endpoint moved".
- **`STORAGE_KEY: 'syncedEvents'`**: Maps `{ [vhubGuid]: { googleEventId, hash } }` in `chrome.storage.local`.
- **Self-healing**: If a calendar event is manually deleted, the next sync detects the 404 and re-creates it.
- **Auto-sync debounce**: 3-second timer after VolunteerHub registration/cancellation API calls. Login-triggered sync has a 30-second cooldown.
