import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAisPosition } from '../src/models/Ais';
import type { IDailyCII } from '../src/models/cii/DailyCII';
import type { IZValue } from '../src/models/cii/ZValue';
import { DailyCIIRepository } from '../src/repositories/cii/dailycii.repository';
import { ZValueRepository } from '../src/repositories/cii/zvalue.repository';
import { FuelDataRepository } from '../src/repositories/ships/fuel-data.repository';
import { CIINotAvailableError } from '../src/middlewares/error.middleware';
import { CIIService } from '../src/services/cii/cii.service';
import type { ICIICalculation } from '../src/types/second-formula.types';
import type { IShipData } from '../src/types/ship.type';
import { calculateFirstFormulaFuel } from '../src/utils/cii/fuel-calculation';
import { calculateSpeed } from '../src/utils/cii/speed-calculation';

const MMSI = '525005223';

const shipData = {
  mmsi: MMSI,
  typeData: {
    a: 5247,
    c: 0.61,
    d: { d1: 0.86, d2: 0.94, d3: 1.06, d4: 1.18 },
  },
  sizeData: { capacity: 5000 },
  fuelType: { conversionFactor: 3.206, fuelDensity: 0.85 },
  fuelFormulas: {
    firstFuelFormula: {
      mainEngineFormula:
        '-0.0382 * speedKnot ** 2 + 0.8658 * speedKnot - 0.0197',
      auxiliaryEngineFormula: '1.5103 * Math.exp(-0.064 * speedKnot)',
    },
  },
} as unknown as IShipData;

const fix = (lat: number, lon: number, time: string): IAisPosition => ({
  navstatus: 0,
  predictedNavStatus: 0,
  ewsStatus: 3,
  lat,
  lon,
  sog: 10,
  cog: 90,
  hdg: 90,
  timestamp: new Date(time),
});

// Newest first, 6 minutes and about 1 nm apart.
const MOVING = [
  fix(-6.9, 112.7333, '2026-11-20T10:06:00Z'),
  fix(-6.9, 112.7166, '2026-11-20T10:00:00Z'),
];
const STATIONARY = [
  fix(-6.9, 112.7166, '2026-11-20T10:06:00Z'),
  fix(-6.9, 112.7166, '2026-11-20T10:00:00Z'),
];

describe('CIIService.calculateCII without fabricated defaults', () => {
  let update: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(FuelDataRepository, 'isActive').mockResolvedValue(false);
    vi.spyOn(ZValueRepository.prototype, 'getValueByYear').mockResolvedValue({
      year: 2026,
      zValue: 11,
    } as IZValue);
    update = vi.fn(async () => null);
    vi.spyOn(DailyCIIRepository.prototype, 'update').mockImplementation(
      update as never,
    );
  });

  it('computes the first CII from the current segment only', async () => {
    vi.spyOn(DailyCIIRepository.prototype, 'getLatestByMmsi').mockResolvedValue(
      null,
    );
    const speed = calculateSpeed(MOVING);
    const fuel = await calculateFirstFormulaFuel(
      MOVING[1].navstatus,
      shipData.fuelType,
      speed.speedKnot,
      shipData.fuelFormulas.firstFuelFormula,
      speed.timeDifferenceMinutes,
    );

    const cii = await new CIIService().calculateCII(MOVING, shipData);

    // The old "Default CII values" added 0.000437 nm and 0.0000504 t here.
    expect(cii.totalDistance).toBe(speed.distance);
    expect(cii.fuelConsumption).toEqual(fuel);
    expect(cii.ciiAttained).toBeCloseTo(
      ((fuel.totalFuelConsumptionTon * 3.206) / (speed.distance * 5000)) * 1e6,
      9,
    );
    expect(cii.notes).toBe('Using first fuel formula');
    expect(update).toHaveBeenCalledWith(MMSI, cii);
  });

  it('accumulates onto the latest stored CII', async () => {
    const previous: ICIICalculation = {
      notes: 'Using first fuel formula',
      ciiRequired: 10,
      ciiAttained: 12,
      ciiRating: 1.2,
      ciiGrade: 'D',
      totalDistance: 100,
      fuelConsumption: {
        fuelConsumptionMeTon: 1,
        fuelConsumptionAeTon: 0.5,
        totalFuelConsumptionTon: 1.5,
      },
    };
    vi.spyOn(DailyCIIRepository.prototype, 'getLatestByMmsi').mockResolvedValue(
      {
        mmsi: MMSI,
        cii: [{ timestamp: new Date(), cii: previous }],
      } as unknown as IDailyCII,
    );

    const cii = await new CIIService().calculateCII(MOVING, shipData);

    expect(cii.totalDistance).toBe(100 + calculateSpeed(MOVING).distance);
    expect(cii.fuelConsumption.totalFuelConsumptionTon).toBeGreaterThan(1.5);
  });

  it('skips the update and reports "not available" when nothing can be computed', async () => {
    vi.spyOn(DailyCIIRepository.prototype, 'getLatestByMmsi').mockResolvedValue(
      null,
    );

    await expect(
      new CIIService().calculateCII(STATIONARY, shipData),
    ).rejects.toBeInstanceOf(CIINotAvailableError);
    expect(update).not.toHaveBeenCalled();
  });

  it('does not restart the accumulation when the latest CII cannot be read', async () => {
    vi.spyOn(DailyCIIRepository.prototype, 'getLatestByMmsi').mockRejectedValue(
      new Error('connection lost'),
    );

    await expect(
      new CIIService().calculateCII(MOVING, shipData),
    ).rejects.toThrow('connection lost');
    expect(update).not.toHaveBeenCalled();
  });
});
