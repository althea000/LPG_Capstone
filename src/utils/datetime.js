const MANILA_TIME_ZONE = "Asia/Manila";
const MANILA_UTC_OFFSET_HOURS = 8; // Asia/Manila has no DST.

const absoluteFormatter = new Intl.DateTimeFormat("en-PH", {
  timeZone: MANILA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function parseSqlDatetimeInManila(text) {
  const match = String(text || "")
    .trim()
    .match(
      /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/
    );

  if (!match) return null;

  const [, year, month, day, hour = "00", minute = "00", second = "00", millis = "0"] = match;
  const ms = Number(millis.padEnd(3, "0"));

  const utcMillis = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour) - MANILA_UTC_OFFSET_HOURS,
    Number(minute),
    Number(second),
    ms
  );

  return new Date(utcMillis);
}

export function parseAppTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "number") {
    const numericValue = Number(value);
    const epochMillis = numericValue > 1e12 ? numericValue : numericValue * 1000;
    const date = new Date(epochMillis);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const explicitTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
    if (explicitTimezone) {
      const explicit = new Date(trimmed);
      if (!Number.isNaN(explicit.getTime())) return explicit;
    }

    const manilaDate = parseSqlDatetimeInManila(trimmed);
    if (manilaDate) return manilaDate;

    const fallback = new Date(trimmed);
    if (!Number.isNaN(fallback.getTime())) return fallback;
  }

  return null;
}

export function formatTimestampManila(value) {
  const date = parseAppTimestamp(value);
  if (!date) return "—";
  return absoluteFormatter.format(date);
}

export function formatRelativeTimeFromTimestamp(value, nowTs = Date.now()) {
  const date = parseAppTimestamp(value);
  if (!date) return "";

  const diffMs = Math.max(0, nowTs - date.getTime());
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "Just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  if (hours < 48) return "Yesterday";

  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}


