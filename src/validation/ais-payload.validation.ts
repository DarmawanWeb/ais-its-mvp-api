import type { TimestampedAisMessage } from '../types/ais.type';

const MMSI_PATTERN = /^\d{1,15}$/;
const NUMERIC_FIELDS = [
  'navstatus',
  'lat',
  'lon',
  'sog',
  'cog',
  'hdg',
  'utc',
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * Validates an `ais:data` payload pushed to the ingest socket and returns a
 * clean copy, or null when it does not have the legacy shape:
 * `{ timestamp, message: { port?, data: { mmsi, navstatus, lat, lon, sog, cog, hdg, utc, ... } } }`.
 * A numeric MMSI is accepted and converted to a string; the timestamp may be
 * an ISO string or epoch milliseconds.
 */
export const parseAisSocketPayload = (
  payload: unknown,
): TimestampedAisMessage | null => {
  if (!isRecord(payload) || !isRecord(payload.message)) return null;
  const { message } = payload;
  if (!isRecord(message.data)) return null;
  const { data } = message;

  const { timestamp } = payload;
  if (typeof timestamp !== 'string' && !isFiniteNumber(timestamp)) return null;
  const time = new Date(timestamp);
  if (Number.isNaN(time.getTime())) return null;

  const mmsi =
    typeof data.mmsi === 'number' && Number.isSafeInteger(data.mmsi)
      ? String(data.mmsi)
      : data.mmsi;
  if (typeof mmsi !== 'string' || !MMSI_PATTERN.test(mmsi)) return null;

  for (const field of NUMERIC_FIELDS) {
    if (!isFiniteNumber(data[field])) return null;
  }
  const { navstatus, lat, lon, sog, cog, hdg, utc } = data as Record<
    (typeof NUMERIC_FIELDS)[number],
    number
  >;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  return {
    timestamp: typeof timestamp === 'string' ? timestamp : time.toISOString(),
    message: {
      port: typeof message.port === 'string' ? message.port : '',
      data: {
        valid: data.valid === undefined ? true : Boolean(data.valid),
        aistype: isFiniteNumber(data.aistype) ? data.aistype : 0,
        mmsi,
        navstatus,
        lat,
        lon,
        sog,
        cog,
        hdg,
        utc,
      },
    },
  };
};
