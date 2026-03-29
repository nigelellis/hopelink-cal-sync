// Offscreen document: parses VolunteerHub schedule HTML into structured event data.
// Used because DOMParser is not available in service workers.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'parseScheduleHTML') {
    const events = parseEvents(message.html);
    sendResponse({ events });
  }
  return true;
});

function parseEvents(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const events = [];
  const eventLists = doc.querySelectorAll('ul.events-listing');

  eventLists.forEach((ul) => {
    const wrapperDiv = ul.parentElement;
    const dateHeader = wrapperDiv?.previousElementSibling;
    const dateText = dateHeader?.textContent?.trim();
    if (!dateText) return;

    const dateMatch = dateText.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!dateMatch) return;
    const [, month, day, year] = dateMatch;

    const items = ul.querySelectorAll('li');
    items.forEach((li) => {
      const titleLink = li.querySelector('a[class*="text-tertiary"]');
      if (!titleLink) return;

      const title = titleLink.textContent.trim();
      const hrefMatch = titleLink.getAttribute('href')?.match(/\/event\/([a-f0-9-]+)/);
      if (!hrefMatch) return;
      const eventId = hrefMatch[1];

      const timeSpans = li.querySelectorAll('span.text-nowrap.text-lowercase');
      const startTimeText = timeSpans[0]?.textContent?.trim() || '';
      const endTimeText = timeSpans[1]?.textContent?.trim() || '';

      const mediaItems = li.querySelectorAll('.media');
      const location = mediaItems.length >= 3
        ? mediaItems[2].textContent.trim()
        : '';

      const descEl = li.querySelector('.tinyMceContent');
      const description = descEl ? descEl.textContent.trim() : '';

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
  if (!timeText) return null;

  const match = timeText.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (!match) return null;

  let [, hours, minutes, ampm] = match;
  hours = parseInt(hours, 10);
  minutes = parseInt(minutes || '0', 10);

  if (ampm.toUpperCase() === 'PM' && hours !== 12) hours += 12;
  if (ampm.toUpperCase() === 'AM' && hours === 12) hours = 0;

  const date = new Date(
    parseInt(year, 10),
    parseInt(month, 10) - 1,
    parseInt(day, 10),
    hours,
    minutes,
  );

  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absOffset = Math.abs(offset);
  const offsetHours = String(Math.floor(absOffset / 60)).padStart(2, '0');
  const offsetMinutes = String(absOffset % 60).padStart(2, '0');

  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00${sign}${offsetHours}:${offsetMinutes}`;
}
