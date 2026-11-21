import { describe, expect, it, vi } from 'vitest';
import type { IAis, IAisPosition } from '../src/models/Ais';
import type { AisRepository } from '../src/repositories/ais.repository';
import { AisService, isDuplicateMovement } from '../src/services/ais.service';
import type { TimestampedAisMessage } from '../src/types/ais.type';

const MMSI = '525005223';
const NOW = new Date('2026-11-20T10:00:00.000Z');

const position = (
  lat: number,
  lon: number,
  minutesAgo: number,
): IAisPosition => ({
  navstatus: 0,
  predictedNavStatus: 0,
  ewsStatus: 3,
  lat,
  lon,
  sog: 10,
  cog: 90,
  hdg: 90,
  timestamp: new Date(NOW.getTime() - minutesAgo * 60_000),
});

// Stored newest-first, as AisService writes them.
const NEWEST = position(-6.9, 112.75, 1);
const OLDEST = position(-7.1, 112.6, 23 * 60);
const STORED: IAisPosition[] = [NEWEST, position(-7, 112.7, 12 * 60), OLDEST];

const message = (lat: number, lon: number): TimestampedAisMessage => ({
  timestamp: NOW.toISOString(),
  message: {
    port: 'test',
    data: {
      valid: true,
      aistype: 1,
      mmsi: MMSI,
      navstatus: 0,
      lat,
      lon,
      sog: 10,
      cog: 90,
      hdg: 90,
      utc: 0,
    },
  },
});

const createService = () => {
  const repository = {
    getByMmsi: vi.fn(
      async () =>
        ({ mmsi: MMSI, isBatam: false, positions: STORED }) as unknown as IAis,
    ),
    getLastByMmsi: vi.fn(),
    updatePositions: vi.fn<
      (mmsi: string, positions: IAisPosition[]) => Promise<void>
    >(async () => undefined),
    create: vi.fn(),
  };
  const service = new AisService({
    aisRepository: repository as unknown as AisRepository,
    ciiEnabledMmsis: [],
  });
  return { service, repository };
};

describe('duplicate-movement filter', () => {
  it('isDuplicateMovement compares the distance with 0.1 m', () => {
    expect(isDuplicateMovement(undefined, NEWEST)).toBe(false);
    expect(isDuplicateMovement(NEWEST, { ...NEWEST })).toBe(true);
    // 1e-7 degrees of latitude is about 1.1 cm; 1e-5 is about 1.1 m.
    expect(
      isDuplicateMovement(NEWEST, { ...NEWEST, lat: NEWEST.lat + 1e-7 }),
    ).toBe(true);
    expect(
      isDuplicateMovement(NEWEST, { ...NEWEST, lat: NEWEST.lat + 1e-5 }),
    ).toBe(false);
  });

  it('skips a fix that did not move from the latest stored position', async () => {
    const { service, repository } = createService();

    await service.createOrUpdateAis(message(NEWEST.lat, NEWEST.lon));

    expect(repository.updatePositions).not.toHaveBeenCalled();
  });

  it('stores a fix equal to the oldest stored position (the old bug compared with it)', async () => {
    const { service, repository } = createService();

    await service.createOrUpdateAis(message(OLDEST.lat, OLDEST.lon));

    expect(repository.updatePositions).toHaveBeenCalledTimes(1);
    const [mmsi, positions] = repository.updatePositions.mock.calls[0];
    expect(mmsi).toBe(MMSI);
    expect(positions).toHaveLength(STORED.length + 1);
    expect(positions[0]).toMatchObject({
      lat: OLDEST.lat,
      lon: OLDEST.lon,
      timestamp: NOW,
    });
  });

  it('uses the already loaded document instead of a second query', async () => {
    const { service, repository } = createService();

    await service.createOrUpdateAis(message(NEWEST.lat, NEWEST.lon));
    await service.createOrUpdateAis(message(-6.95, 112.8));

    expect(repository.getByMmsi).toHaveBeenCalledTimes(2);
    expect(repository.getLastByMmsi).not.toHaveBeenCalled();
    expect(repository.updatePositions).toHaveBeenCalledTimes(1);
  });

  it('ignores a message whose timestamp is invalid instead of wiping the history', async () => {
    const { service, repository } = createService();
    const invalid = message(-6.95, 112.8);
    invalid.message.data.utc = undefined as unknown as number;

    await expect(service.createOrUpdateAis(invalid)).resolves.toBeNull();
    expect(repository.updatePositions).not.toHaveBeenCalled();
  });
});
