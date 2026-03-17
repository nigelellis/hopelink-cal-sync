// Content script: scrapes committed events from the VolunteerHub "My Schedule" page.
// Injected into hopelink.volunteerhub.com pages.

function scrapeEvents() {
  const events = [];
  const eventLists = document.querySelectorAll('ul.events-listing');

  eventLists.forEach((ul) => {
    // DOM structure: div > h6.sticky + div.container-fluid > ul.events-listing
    // The h6 is a sibling of the ul's parent div, not of the ul itself
    const wrapperDiv = ul.parentElement;
    const dateHeader = wrapperDiv?.previousElementSibling;
    const dateText = dateHeader?.textContent?.trim(); // e.g. "Tuesday, 3/17/2026"
    if (!dateText) return;

    // Parse the date from header: "DayName, M/D/YYYY"
    const dateMatch = dateText.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!dateMatch) return;
    const [, month, day, year] = dateMatch;

    const items = ul.querySelectorAll('li');
    items.forEach((li) => {
      // Event title and GUID from the link
      const titleLink = li.querySelector('a[class*="text-tertiary"]');
      if (!titleLink) return;

      const title = titleLink.textContent.trim();
      const hrefMatch = titleLink.getAttribute('href')?.match(/\/event\/([a-f0-9-]+)/);
      if (!hrefMatch) return;
      const eventId = hrefMatch[1];

      // Start and end times from span.text-nowrap.text-lowercase
      const timeSpans = li.querySelectorAll('span.text-nowrap.text-lowercase');
      const startTimeText = timeSpans[0]?.textContent?.trim() || '';
      const endTimeText = timeSpans[1]?.textContent?.trim() || '';

      // Location from the third .media element
      const mediaItems = li.querySelectorAll('.media');
      const location = mediaItems.length >= 3
        ? mediaItems[2].textContent.trim()
        : '';

      // Description from .tinyMceContent
      const descEl = li.querySelector('.tinyMceContent');
      const description = descEl ? descEl.textContent.trim() : '';

      // Build ISO datetimes
      const startDateTime = parseDateTime(year, month, day, startTimeText);
      const endDateTime = parseDateTime(year, month, day, endTimeText);

      if (startDateTime && endDateTime) {
        events.push({
          id: eventId,
          title,
          startDateTime,
          endDateTime,
          location,
          description,
        });
      }
    });
  });

  return events;
}

function parseDateTime(year, month, day, timeText) {
  // timeText is like "8:30 AM" or "10 AM"
  if (!timeText) return null;

  const match = timeText.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (!match) return null;

  let [, hours, minutes, ampm] = match;
  hours = parseInt(hours, 10);
  minutes = parseInt(minutes || '0', 10);

  if (ampm.toUpperCase() === 'PM' && hours !== 12) hours += 12;
  if (ampm.toUpperCase() === 'AM' && hours === 12) hours = 0;

  // Return ISO 8601 with local timezone offset
  const date = new Date(
    parseInt(year, 10),
    parseInt(month, 10) - 1,
    parseInt(day, 10),
    hours,
    minutes,
  );

  // Format as ISO string with timezone offset
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absOffset = Math.abs(offset);
  const offsetHours = String(Math.floor(absOffset / 60)).padStart(2, '0');
  const offsetMinutes = String(absOffset % 60).padStart(2, '0');

  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00${sign}${offsetHours}:${offsetMinutes}`;
}

// Listen for scrape requests from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'scrapeEvents') {
    const events = scrapeEvents();
    sendResponse({ events });
  }
  return true;
});
