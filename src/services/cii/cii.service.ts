import { IAis, IAisPosition } from '../../models/Ais';
import { AisRepository } from '../../repositories/ais.repository';
// import { IDailyCII } from '../../models/cii/DailyCII';
import { FuelDataRepository } from '../../repositories/ships/fuel-data.repository';
import { DailyCIIRepository } from '../../repositories/cii/dailycii.repository';
import { ShipRepository } from '../../repositories/ships/ships.repository';

import { IShipData } from '../../types/ship.type';

import { calculateSpeed } from '../../utils/cii/speed-calculation';
import {
  calculateFirstFormulaFuel,
  calculateSecondFormulaFuel,
} from '../../utils/cii/fuel-calculation';
import { calculateCII } from '../../utils/cii/cii-calculation';
import {
  ICIICalculation,
  IFuelConsumption,
} from '../../types/second-formula.types';
import {
  CIINotAvailableError,
  NotFoundError,
} from '../../middlewares/error.middleware';

/**
 * Why a computed CII cannot be stored, or null when it can. A ship that has
 * not covered any distance yet has no CII (attained CII divides by distance).
 */
export const getCIIUnavailableReason = (
  cii: ICIICalculation,
): string | null => {
  if (!(cii.totalDistance > 0)) {
    return 'the ship has not covered any distance yet';
  }
  if (!Number.isFinite(cii.ciiAttained) || !Number.isFinite(cii.ciiRating)) {
    return 'the fuel estimate is not a finite number';
  }
  return null;
};

export class CIIService {
  private shipRepository: ShipRepository;
  private aisRepository: AisRepository;
  private dailyCiiRepository: DailyCIIRepository;
  constructor() {
    this.shipRepository = new ShipRepository();
    this.aisRepository = new AisRepository();
    this.dailyCiiRepository = new DailyCIIRepository();
  }

  async calculateCII(
    positions: IAisPosition[],
    shipData: IShipData,
  ): Promise<ICIICalculation> {
    const speedData = calculateSpeed(positions);
    if (!speedData) {
      throw new Error('Insufficient data to calculate speed');
    }
    // The CII accumulated so far, or null for the first computation, which
    // then uses the current segment only. There is deliberately no fallback:
    // the hard-coded "Default CII values" (grade E) that used to be injected
    // here leaked fabricated distance and fuel into every later value. A
    // failing read is not treated as "no CII yet" either, as that would
    // restart the accumulation.
    const latestDailyCII = await this.dailyCiiRepository.getLatestByMmsi(
      shipData.mmsi,
    );
    const latestCII: ICIICalculation | null =
      latestDailyCII?.cii[0]?.cii ?? null;

    console.log(
      `Calculating CII for MMSI ${shipData.mmsi} with speed data:`,
      speedData,
    );
    let ciiResult: ICIICalculation | null = null;

    const isTelemetryActive = await FuelDataRepository.isActive(shipData.mmsi);
    let isFuelFormulaActive = false;
    try {
      isFuelFormulaActive =
        shipData.fuelFormulas?.firstFuelFormula !== undefined;
    } catch (error) {
      console.error(
        `Error checking fuel formula for MMSI ${shipData.mmsi}:`,
        error,
      );
      isFuelFormulaActive = false;
    }
    let notes;

    if (isTelemetryActive) {
      console.log(`Using telemetry data for MMSI ${shipData.mmsi}`);
      notes = `Using telemetry data`;

      const fuelData = await FuelDataRepository.getLatestByMMSI(shipData.mmsi);
      if (!fuelData) {
        throw new Error(`Fuel data for MMSI ${shipData.mmsi} is not available`);
      }
      const formatFuelData: IFuelConsumption = {
        fuelConsumptionMeTon: Number(fuelData.fuelLogs[0].fuelME),
        fuelConsumptionAeTon: Number(fuelData.fuelLogs[0].fuelAE),
        totalFuelConsumptionTon:
          Number(fuelData.fuelLogs[0].fuelAE.toString()) +
          Number(fuelData.fuelLogs[0].fuelME.toString()),
      };
      ciiResult = await calculateCII(
        shipData,
        formatFuelData,
        speedData.distance,
        latestCII,
      );
    } else if (isFuelFormulaActive) {
      notes = `Using first fuel formula`;
      console.log(
        `Using first fuel formula for MMSI ${shipData.mmsi}`,
        shipData.fuelFormulas?.firstFuelFormula,
      );
      const firstFormulaFuel = await calculateFirstFormulaFuel(
        positions[1].navstatus,
        shipData.fuelType,
        speedData.speedKnot,
        shipData.fuelFormulas.firstFuelFormula,
        speedData.timeDifferenceMinutes,
      );

      ciiResult = await calculateCII(
        shipData,
        firstFormulaFuel,
        speedData.distance,
        latestCII,
      );
    } else {
      const secondFormulaFuel = await calculateSecondFormulaFuel(
        speedData,
        positions,
        shipData,
      );
      notes = `Using Holtrop`;

      console.log(`Using second fuel formula for MMSI ${shipData.mmsi}`);
      ciiResult = await calculateCII(
        shipData,
        secondFormulaFuel,
        speedData.distance,
        latestCII,
      );
    }

    const resultCII = {
      ...ciiResult,
      notes: notes,
    };

    const unavailableReason = getCIIUnavailableReason(resultCII);
    if (unavailableReason) {
      // Skip the update rather than storing Infinity/NaN.
      throw new CIINotAvailableError(
        `CII not available for MMSI ${shipData.mmsi}: ${unavailableReason}`,
      );
    }

    await this.dailyCiiRepository.update(shipData.mmsi, resultCII);
    return resultCII;
  }

  async getCIIByMMSI(mmsi: string): Promise<ICIICalculation> {
    const ship = await this.shipRepository.getByMMSI(mmsi);
    if (!ship) {
      throw new NotFoundError(`Ship with MMSI ${mmsi} not found`);
    }

    const aisData: IAis | null = await this.aisRepository.getByMmsi(mmsi);
    if (!aisData) {
      throw new CIINotAvailableError(
        `CII not available for MMSI ${mmsi}: no AIS data`,
      );
    }

    if (!aisData.positions || aisData.positions.length < 2) {
      throw new CIINotAvailableError(
        `CII not available for MMSI ${mmsi}: at least two AIS positions are needed`,
      );
    }
    const ciiResult = await this.calculateCII(
      aisData.positions,
      ship as IShipData,
    );
    console.log(`CII calculated for MMSI ${mmsi}:`, ciiResult);
    if (!ciiResult) {
      throw new Error(`CII calculation failed for MMSI ${mmsi}`);
    }
    return ciiResult;
  }
}
