import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseXmltvDate,
  parseXmltvOffsetMinutes,
  formatTime,
  formatLocalTime,
  formatLocalDateTime,
  formatDayLabel,
  displayDayKey,
  startOfDisplayDay,
  addDisplayDays,
  formatPosition,
  formatDuration,
  getTimeSlots,
  isNow,
  getProgress,
  setDisplayTz,
} from './time';

// Display state is module-global; keep tests in the default 'device' mode.
afterEach(() => {
  setDisplayTz('device', null);
});

describe('parseXmltvDate', () => {
  it('parses a timestamp with an explicit timezone offset', () => {
    const d = parseXmltvDate('20240601120000 +0200');
    expect(d?.getTime()).toBe(Date.UTC(2024, 5, 1, 10, 0, 0));
  });

  it('treats a timestamp without a timezone as UTC', () => {
    const d = parseXmltvDate('20240601120000');
    expect(d?.getTime()).toBe(Date.UTC(2024, 5, 1, 12, 0, 0));
  });

  it('handles a negative timezone offset', () => {
    const d = parseXmltvDate('20240601120000 -0500');
    expect(d?.getTime()).toBe(Date.UTC(2024, 5, 1, 17, 0, 0));
  });

  it('returns null for empty or malformed input', () => {
    expect(parseXmltvDate(null)).toBeNull();
    expect(parseXmltvDate('')).toBeNull();
    expect(parseXmltvDate('2024-06-01')).toBeNull();
    expect(parseXmltvDate('not a date')).toBeNull();
  });
});

describe('parseXmltvOffsetMinutes', () => {
  it('extracts the offset in minutes east of UTC', () => {
    expect(parseXmltvOffsetMinutes('20240601120000 +0100')).toBe(60);
    expect(parseXmltvOffsetMinutes('20240601120000 -0500')).toBe(-300);
    expect(parseXmltvOffsetMinutes('20240601120000 +0530')).toBe(330);
  });

  it('returns null when the stamp carries no offset', () => {
    expect(parseXmltvOffsetMinutes('20240601120000')).toBeNull();
    expect(parseXmltvOffsetMinutes(null)).toBeNull();
  });
});

describe('feed time mode', () => {
  // 00:17 at +0100 is 23:17 UTC the previous day.
  const d = parseXmltvDate('20240310001700 +0100')!;

  it('formatTime renders the feed wall clock, not the device clock', () => {
    setDisplayTz('feed', 60);
    expect(formatTime(d)).toBe('00:17');
  });

  it('formatDayLabel and displayDayKey use the feed day', () => {
    setDisplayTz('feed', 60);
    expect(displayDayKey(d)).toBe('2024-03-10');
    expect(formatDayLabel(d)).toEqual({ weekday: 'Sun', date: '03/10' });
  });

  it('startOfDisplayDay floors to feed midnight and addDisplayDays steps 24h', () => {
    setDisplayTz('feed', 60);
    const dayStart = startOfDisplayDay(d);
    // 2024-03-10 00:00 +0100 == 2024-03-09 23:00 UTC
    expect(dayStart.getTime()).toBe(Date.parse('2024-03-09T23:00:00Z'));
    expect(addDisplayDays(dayStart, 1).getTime()).toBe(Date.parse('2024-03-10T23:00:00Z'));
    expect(displayDayKey(dayStart)).toBe('2024-03-10');
  });

  it('falls back to device rendering when no feed offset is known', () => {
    setDisplayTz('feed', null);
    // With no offset, feed mode must render exactly as the device would.
    expect(formatTime(d)).toBe(
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    );
    expect(displayDayKey(d)).toBe(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    );
  });
});

describe('formatTime', () => {
  it('zero-pads hours and minutes (local time)', () => {
    expect(formatTime(new Date(2024, 0, 1, 9, 5))).toBe('09:05');
    expect(formatTime(new Date(2024, 0, 1, 23, 59))).toBe('23:59');
  });

  // Regression for the webOS "24:30" bug: midnight must render as 00:xx, never 24:xx.
  // (toLocaleTimeString with the h24 hour cycle used to emit "24:00" at midnight.)
  it('renders midnight as 00:xx, never 24:xx', () => {
    expect(formatTime(new Date(2024, 0, 2, 0, 0))).toBe('00:00');
    expect(formatTime(new Date(2024, 0, 2, 0, 30))).toBe('00:30');
  });
});

describe('local wall-clock formatting', () => {
  it('always renders local clock values in 24-hour form', () => {
    const morning = new Date(2024, 0, 2, 9, 5, 7);
    const evening = new Date(2024, 0, 2, 21, 45, 9);

    expect(formatLocalTime(morning)).toBe('09:05');
    expect(formatLocalTime(evening)).toBe('21:45');
    expect(formatLocalDateTime(morning)).toMatch(/09:05:07$/);
    expect(formatLocalDateTime(evening)).toMatch(/21:45:09$/);
    expect(formatLocalDateTime(evening)).not.toMatch(/AM|PM/i);
  });

  it('renders midnight as 00 rather than 24', () => {
    const midnight = new Date(2024, 0, 2, 0, 30, 0);
    expect(formatLocalTime(midnight)).toBe('00:30');
    expect(formatLocalDateTime(midnight)).toMatch(/00:30:00$/);
  });
});

describe('formatPosition', () => {
  it('formats a position under an hour as m:ss', () => {
    expect(formatPosition(0)).toBe('0:00');
    expect(formatPosition(65)).toBe('1:05');
    expect(formatPosition(1810)).toBe('30:10');
  });

  it('includes hours past 60 minutes and zero-pads minutes', () => {
    expect(formatPosition(3905)).toBe('1:05:05');
  });

  it('floors fractional seconds and clamps negatives to 0:00', () => {
    expect(formatPosition(9.9)).toBe('0:09');
    expect(formatPosition(-5)).toBe('0:00');
  });
});

describe('formatDuration', () => {
  it('formats sub-hour durations as minutes only', () => {
    expect(formatDuration(5 * 60000)).toBe('5m');
    expect(formatDuration(0)).toBe('0m');
  });

  it('formats hour-plus durations with hours and minutes', () => {
    expect(formatDuration(65 * 60000)).toBe('1h 5m');
    expect(formatDuration(120 * 60000)).toBe('2h 0m');
  });
});

describe('getTimeSlots', () => {
  it('rounds the start down to the slot boundary and returns one slot per interval', () => {
    const slots = getTimeSlots(new Date(2024, 0, 1, 10, 20), 2, 30);
    expect(slots).toHaveLength(4); // 2h / 30m
    expect(formatTime(slots[0])).toBe('10:00');
    expect(formatTime(slots[1])).toBe('10:30');
    expect(formatTime(slots[3])).toBe('11:30');
  });

  it('renders post-midnight slots as 00:xx, never 24:xx', () => {
    const slots = getTimeSlots(new Date(2024, 0, 1, 23, 20), 2, 30);
    expect(slots.map(formatTime)).toEqual(['23:00', '23:30', '00:00', '00:30']);
  });
});

describe('isNow / getProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-01T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('isNow is true only when now is within [start, stop)', () => {
    const now = Date.now();
    expect(isNow(new Date(now - 1000), new Date(now + 1000))).toBe(true);
    expect(isNow(new Date(now + 1000), new Date(now + 2000))).toBe(false);
    expect(isNow(new Date(now - 2000), new Date(now))).toBe(false); // stop == now is exclusive
  });

  it('getProgress returns a clamped 0..1 fraction', () => {
    const now = Date.now();
    expect(getProgress(new Date(now - 50), new Date(now + 50))).toBeCloseTo(0.5, 5);
    expect(getProgress(new Date(now + 100), new Date(now + 200))).toBe(0); // not started
    expect(getProgress(new Date(now - 200), new Date(now - 100))).toBe(1); // finished
  });

  it('getProgress returns 0 for a non-positive duration', () => {
    const now = Date.now();
    expect(getProgress(new Date(now), new Date(now))).toBe(0);
  });
});
