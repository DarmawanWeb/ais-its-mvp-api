import { type IAis, type IAisPosition } from '../models/Ais';
import { AisRepository } from '../repositories/ais.repository';
import { TimestampedAisMessage } from '../types/ais.type';
import { CIIService } from './cii/cii.service';
import { calculatePredictedNavStatus } from './predict-navstatus.service';
import {
  findNearestCoastDistance,
  checkShipStatus,
} from '../utils/calculate-ews';
import { IllegalTranshipmentService } from './illegal-transhipment/illegal-transhipment.service';
import { IllegalTranshipmentDetectionService } from './illegal-transhipment/illegal-transhipment-det.service';
import { calculateDistance } from '../utils/cii/speed-calculation';
import config from '../config/config';
import logger from '../config/logger';

const COASTLINE_FILE = 'data/indonesia.json';

/** A new fix closer than this to the latest stored one is a duplicate. */
export const DUPLICATE_MOVEMENT_THRESHOLD_METERS = 0.1;

/**
 * Duplicate-movement filter. `latest` must be the newest stored position:
 * positions are stored newest-first, so that is `positions[0]`. (Before
 * phase 0 the comparison used the oldest stored fix, about 24 h old.)
 */
export const isDuplicateMovement = (
  latest: IAisPosition | undefined,
  next: IAisPosition,
): boolean =>
  latest !== undefined &&
  calculateDistance(latest, next).distanceInMeters <
    DUPLICATE_MOVEMENT_THRESHOLD_METERS;

export interface AisServiceOptions {
  aisRepository?: AisRepository;
  /** MMSIs whose CII is updated on every accepted position (CII_ENABLED_MMSIS). */
  ciiEnabledMmsis?: Iterable<string>;
}

export class AisService {
  private aisRepository: AisRepository;
  private readonly ciiEnabledMmsis: ReadonlySet<string>;
  private ciiService: CIIService = new CIIService();
  private illegalTranshipmentService: IllegalTranshipmentService =
    new IllegalTranshipmentService();
  private illegalTranshipmentDetectionService: IllegalTranshipmentDetectionService =
    new IllegalTranshipmentDetectionService();
  private readonly ONE_DAY_MS = 24 * 60 * 60 * 1000;

  constructor(options: AisServiceOptions = {}) {
    this.aisRepository = options.aisRepository ?? new AisRepository();
    this.ciiEnabledMmsis = new Set(
      options.ciiEnabledMmsis ?? config.cii.enabledMmsis,
    );
  }

  private filterPositionsWithinOneDay(
    positions: IAisPosition[],
    currentTimestamp: Date,
  ): IAisPosition[] {
    const oneHourAgo = new Date(currentTimestamp.getTime() - this.ONE_DAY_MS);

    const validPositions = positions.filter((position) => {
      if (!position || !position.timestamp) return false;
      const ts = new Date(position.timestamp);
      return ts >= oneHourAgo && ts <= currentTimestamp;
    });

    validPositions.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    return validPositions;
  }

  async createOrUpdateAis(
    data: TimestampedAisMessage,
    isBatam: boolean = false,
  ): Promise<IAis | void | null> {
    const messageData = data.message.data;
    try {
      if (!messageData) return null;

      const { mmsi, navstatus, lat, lon, sog, cog, hdg, utc } = messageData;
      if (
        !mmsi ||
        navstatus == null ||
        lat == null ||
        lon == null ||
        sog == null ||
        cog == null ||
        hdg == null
      ) {
        return null;
      }

      const timestamp = new Date(data.timestamp);
      timestamp.setSeconds(timestamp.getSeconds() - utc);
      // An invalid timestamp (e.g. missing utc) would make the one-day filter
      // below drop every stored position of the ship.
      if (Number.isNaN(timestamp.getTime())) return null;

      let newPosition: IAisPosition;
      const existingAis = await this.aisRepository.getByMmsi(mmsi);

      // =======================
      // CASE 1: Kapal baru
      // =======================
      if (!existingAis) {
        const minDistance = findNearestCoastDistance(COASTLINE_FILE, lat, lon);
        const predictedNavStatus = calculatePredictedNavStatus(
          { sog, cog, hdg },
          { sog, cog, hdg },
          minDistance,
        );

        newPosition = {
          navstatus,
          lat,
          lon,
          sog,
          cog,
          hdg,
          timestamp,
          predictedNavStatus,
          ewsStatus: checkShipStatus(lat, lon, predictedNavStatus),
        };

        const newAis = {
          mmsi,
          isBatam,
          positions: [newPosition],
        };
        return this.aisRepository.create(newAis as IAis);
      }

      // =======================
      // CASE 2: Kapal sudah ada
      // =======================
      newPosition = {
        navstatus,
        lat,
        lon,
        sog,
        cog,
        hdg,
        timestamp,
        predictedNavStatus: 0,
        ewsStatus: 0,
      };
      if (isDuplicateMovement(existingAis.positions?.[0], newPosition)) {
        logger.debug(
          `⏩ Skip update untuk ${mmsi}: pergerakan < ${DUPLICATE_MOVEMENT_THRESHOLD_METERS} meter dari posisi terakhir`,
        );
        return;
      }

      const minDistance = findNearestCoastDistance(COASTLINE_FILE, lat, lon);
      const predictedNavStatus = calculatePredictedNavStatus(
        { sog, cog, hdg },
        existingAis.positions[0],
        minDistance,
      );

      newPosition = {
        navstatus,
        lat,
        lon,
        sog,
        cog,
        hdg,
        timestamp,
        predictedNavStatus,
        ewsStatus: checkShipStatus(lat, lon, predictedNavStatus),
      };

      const allPositions = [newPosition, ...existingAis.positions];
      const updatedPositions = this.filterPositionsWithinOneDay(
        allPositions,
        timestamp,
      );

      await this.aisRepository.updatePositions(mmsi, updatedPositions);

      if (this.ciiEnabledMmsis.has(mmsi)) {
        try {
          await this.ciiService.getCIIByMMSI(mmsi);
        } catch (error) {
          // A missing CII must not stop the transhipment check below.
          logger.warn(
            `CII update skipped for MMSI ${mmsi}: ${(error as Error).message}`,
          );
        }
      }

      if (isBatam) {
        await this.illegalTranshipmentService.detectIllegalTranshipment(
          mmsi,
          newPosition,
        );
      }
    } catch (error) {
      console.error('Error creating or updating AIS:', error);
      return null;
    }
  }

  async getAllAis(): Promise<IAis[]> {
    return this.aisRepository.getAll();
  }

  async getAllAisStreamed(hours: number): Promise<IAis[]> {
    const cursor = await this.aisRepository.streamRecent(hours);
    const aisList: IAis[] = [];

    console.log('Streaming AIS data...');

    try {
      for await (const doc of cursor) {
        aisList.push(doc as IAis);
      }

      console.log('✅ Stream selesai, total data:', aisList.length);
      return aisList;
    } catch (err) {
      console.error('❌ Stream error:', err);
      throw err;
    }
  }

  async getAisByMmsi(mmsi: string): Promise<IAis | null> {
    return this.aisRepository.getByMmsi(mmsi);
  }

  async getTwoShipRoutesInSpecificTimeRange(
    mmsi1: string,
    mmsi2: string,
    startTime: Date,
    endTime: Date,
  ): Promise<{
    ship1Positions: IAisPosition[];
    ship2Positions: IAisPosition[];
  }> {
    const ship1 = await this.aisRepository.getByMmsi(mmsi1);
    const ship2 = await this.aisRepository.getByMmsi(mmsi2);

    const filterPositionsByTimeRange = (
      positions: IAisPosition[],
      start: Date,
      end: Date,
    ): IAisPosition[] => {
      return positions.filter((position) => {
        const posTime = new Date(position.timestamp);
        return posTime >= start && posTime <= end;
      });
    };

    const ship1Positions = ship1
      ? filterPositionsByTimeRange(ship1.positions, startTime, endTime)
      : [];
    const ship2Positions = ship2
      ? filterPositionsByTimeRange(ship2.positions, startTime, endTime)
      : [];

    return { ship1Positions, ship2Positions };
  }

  async processIllegalTranshipmentQueue(): Promise<void> {
    await this.illegalTranshipmentDetectionService.processQueue();
  }

  async getIllegalTranshipmentResults() {
    return await this.illegalTranshipmentDetectionService.getIllegalTranshipmentResults();
  }

  async getIllegalTranshipmentResultsByShip(mmsi: string) {
    return await this.illegalTranshipmentDetectionService.getResultsByShip(
      mmsi,
    );
  }
}
