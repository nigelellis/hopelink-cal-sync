# Hopelink VolunteerHub Calendar Sync

A Chrome extension that syncs your committed volunteer shifts from [Hopelink's VolunteerHub](https://hopelink.volunteerhub.com) to Google Calendar.

## Features

- **One-click sync** — Click the extension icon and hit "Sync Now" to pull all your committed events into Google Calendar
- **Auto-sync** — Automatically syncs when you register for or cancel an event on VolunteerHub
- **Full reconciliation** — Adds new events, updates changed events, and removes cancelled ones
- **Duplicate prevention** — Tracks synced events by VolunteerHub GUID so duplicates are never created
- **Self-healing** — If you manually delete a calendar event, the next sync re-creates it
- **Diagnostics** — Built-in diagnostics panel shows tracked events and storage state

## How It Works

1. The extension navigates to your VolunteerHub "My Schedule" page (opening a new tab if needed, or reloading an existing one)
2. A content script scrapes event data from the page: title, date, start/end times, location, and description
3. The background service worker compares scraped events against previously synced state stored in `chrome.storage.local`
4. New, updated, or removed events are pushed to Google Calendar via the Calendar API
5. Calendar events are prefixed with `[Hopelink]` and colored Tomato for easy identification

### Auto-Sync Triggers

The extension listens for HTTP requests to VolunteerHub's internal API and automatically triggers a sync when:

- **Event registration** — `POST` to `/internalapi/wizard/EventRegistration/*`
- **Event cancellation** — `POST` to `/internalapi/wizard/EventRegistrationCancellation/*`

A 3-second debounce prevents duplicate syncs from rapid successive requests.

## Setup

### 1. Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a new project
2. Enable the **Google Calendar API** under APIs & Services
3. Configure the **OAuth consent screen** (Testing mode is fine — add your Google account as a test user)
4. Create an **OAuth 2.0 Client ID**:
   - Application type: **Chrome extension**
   - Item ID: your extension's ID (from step 2 below)

### 2. Install the Extension

1. Clone this repo or download the source
2. Open `chrome://extensions` in Chrome, enable **Developer mode**
3. Click **Load unpacked** and select the project folder
4. Copy the generated **extension ID**
5. Go back to Google Cloud Console and add the extension ID to your OAuth client
6. Edit `manifest.json` and replace the `client_id` in the `oauth2` section with your OAuth client ID

### 3. First Sync

1. Sign in to [hopelink.volunteerhub.com](https://hopelink.volunteerhub.com)
2. Click the extension icon in Chrome's toolbar
3. Click **Sync Now**
4. Authorize Google Calendar access when prompted
5. Your volunteer shifts will appear in Google Calendar

## Permissions

| Permission | Purpose |
|------------|---------|
| `identity` | Google OAuth for Calendar API access |
| `storage` | Persist sync state between sessions |
| `tabs` | Open/reload the VolunteerHub schedule page |
| `scripting` | Inject content script to scrape events |
| `webRequest` | Detect event registration/cancellation for auto-sync |

## License

[MIT](LICENSE)
