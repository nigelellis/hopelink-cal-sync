# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome extension (Manifest V3) that syncs committed volunteer shifts from Hopelink's VolunteerHub to Google Calendar. No build system, bundler, or package manager — plain JavaScript loaded directly by Chrome.

## Development

**Load the extension:** `chrome://extensions` → Developer mode → Load unpacked → select project folder.

**No build/lint/test commands.** This is a vanilla JS Chrome extension with no toolchain. Changes take effect after reloading the extension in `chrome://extensions`.

**OAuth setup required:** You need a Google Cloud project with Calendar API enabled and an OAuth 2.0 client ID configured for Chrome extensions. The client ID goes in `manifest.json` under `oauth2.client_id`.

## Architecture

Three execution contexts communicate via Chrome's message-passing API:

- **`background.js`** — Service worker. Orchestrates the entire sync flow: fetches the VolunteerHub schedule page HTML directly (no tab needed), delegates DOM parsing to the offscreen document, and handles Google Calendar API calls and reconciliation. Listens for `startSync`, `getLastSyncTime`, and `getDiagnostics` messages from the popup, and auto-triggers sync via `webRequest` (event registration/cancellation) and `webNavigation` (login/landing page) listeners.

- **`offscreen.js` / `offscreen.html`** — Offscreen document (invisible). Receives schedule HTML from the service worker and parses it into structured event data using `DOMParser` (unavailable in service workers). Responds to `parseScheduleHTML` messages.

- **`popup.js` / `popup.html` / `popup.css`** — Extension popup UI. "Sync Now" button, result counters, diagnostics panel. Communicates with the background worker via `chrome.runtime.sendMessage`.

### Sync Flow

1. Background fetches the VolunteerHub "My Schedule" page HTML directly (cookies sent via `host_permissions`)
2. Offscreen document parses the HTML into structured event data
3. Background reconciles scraped events against stored state in `chrome.storage.local` (keyed by VolunteerHub GUID)
4. Diffs are pushed to Google Calendar API (create/update/delete)
5. Calendar events are prefixed `[Hopelink]`, colored Tomato (`colorId: '11'`), and tagged with `extendedProperties.private.source: 'hopelink-cal-sync'`

### Key Mechanisms

- **`HASH_VERSION`** (in `background.js`): Bump this integer to force re-sync of all events (e.g., after changing event formatting like `colorId`).
- **`STORAGE_KEY: 'syncedEvents'`**: Maps `{ [vhubGuid]: { googleEventId, hash } }` in `chrome.storage.local`.
- **Self-healing**: If a calendar event is manually deleted, the next sync detects the 404 and re-creates it.
- **Auto-sync debounce**: 3-second timer after VolunteerHub registration/cancellation API calls. Login-triggered sync has a 30-second cooldown.
