import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IAis, IAisPosition } from '../src/models/Ais';
import FuelData from '../src/models/ships/Telemetry';
import type { AisRepository } from '../src/repositories/ais.repository';
import { FuelDataRepository } from '../src/repositories/ships/fuel-data.repository';
import { AisService } from '../src/services/ais.service';
import { CIIService } from '../src/services/cii/cii.service';
import type { TimestampedAisMessage } from '../src/types/ais.type';

const loadConfig = async () => {
  vi.resetModules();
  return (await import('../src/config/config')).default;
};

describe('configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('parses CII_ENABLED_MMSIS as a comma separated list (empty = disabled)', async () => {
    vi.stubEnv('CII_ENABLED_MMSIS', ' 525005223, 525016306 ,, ');
    expect((await loadConfig()).cii.enabledMmsis).toEqual([
      '525005223',
      '525016306',
    ]);

    vi.stubEnv('CII_ENABLED_MMSIS', '');
    expect((await loadConfig()).cii.enabledMmsis).toEqual([]);
  });

  it('trims ALLOWED_ORIGINS entries and ignores trailing slashes', async () => {
    vi.stubEnv(
      'ALLOWED_ORIGINS',
      'http://localhost:5173/, https://app.example.com ,',
    );
    expect((await loadConfig()).cors.origin).toEqual([
      'http://localhost:5173',
      'https://app.example.com',
    ]);
  });
});

describe('CII trigger on AIS updates', () => {
  const stored: IAisPosition = {
    navstatus: 0,
    predictedNavStatus: 0,
    ewsStatus: 3,
    lat: -6.9,
    lon: 112.7,
    sog: 10,
    cog: 90,
    hdg: 90,
    timestamp: new Date('2026-11-20T09:59:00Z'),
  };
  const message = (mmsi: string): TimestampedAisMessage => ({
    timestamp: '2026-11-20T10:00:00Z',
    message: {
      port: 'test',
      data: {
        valid: true,
        aistype: 1,
        mmsi,
        navstatus: 0,
        lat: -6.91,
        lon: 112.71,
        sog: 10,
        cog: 90,
        hdg: 90,
        utc: 0,
      },
    },
  });
  const repository = () =>
    ({
      getByMmsi: async (mmsi: string) =>
        ({ mmsi, isBatam: false, positions: [stored] }) as unknown as IAis,
      updatePositions: async () => undefined,
    }) as unknown as AisRepository;

  it('stays disabled by default, as with the old validMMSIs = [""]', async () => {
    const getCII = vi
      .spyOn(CIIService.prototype, 'getCIIByMMSI')
      .mockResolvedValue({} as never);

    await new AisService({ aisRepository: repository() }).createOrUpdateAis(
      message('525005223'),
    );

    expect(getCII).not.toHaveBeenCalled();
  });

  it('updates the CII of the configured MMSIs only, and survives CII errors', async () => {
    const getCII = vi
      .spyOn(CIIService.prototype, 'getCIIByMMSI')
      .mockRejectedValue(new Error('CII not available'));
    const service = new AisService({
      aisRepository: repository(),
      ciiEnabledMmsis: ['525005223'],
    });

    await expect(
      service.createOrUpdateAis(message('525005223')),
    ).resolves.toBeUndefined();
    await service.createOrUpdateAis(message('111111111'));

    expect(getCII).toHaveBeenCalledTimes(1);
    expect(getCII).toHaveBeenCalledWith('525005223');
  });
});

describe('FuelDataRepository.isActive', () => {
  const lastEntryAgo = (ms: number) =>
    vi.spyOn(FuelData, 'findOne').mockReturnValue({
      sort: async () => ({ createdAt: new Date(Date.now() - ms) }),
    } as never);

  it('treats telemetry as active for one minute after the last entry', async () => {
    lastEntryAgo(30_000); // the old "/ 10000" computed 3 "minutes" here
    await expect(FuelDataRepository.isActive('1')).resolves.toBe(true);

    lastEntryAgo(59_000);
    await expect(FuelDataRepository.isActive('1')).resolves.toBe(true);

    lastEntryAgo(61_000);
    await expect(FuelDataRepository.isActive('1')).resolves.toBe(false);
  });
});
