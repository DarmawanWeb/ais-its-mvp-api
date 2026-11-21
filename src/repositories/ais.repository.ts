import Ais, { type IAisPosition, type IAis } from '../models/Ais';

export interface IAisRepository {
  create(data: IAis): Promise<IAis>;
  getAll(): Promise<IAis[]>;
  getByMmsi(mmsi: string): Promise<IAis | null>;
  updatePositions(mmsi: string, newPosition: IAisPosition[]): Promise<void>;
  getShipRouteByMMSI(mmsi: string, duration: number): Promise<IAisPosition[]>;
}

export class AisRepository implements IAisRepository {
  async create(data: IAis): Promise<IAis> {
    const ais = new Ais(data);
    await ais.save();
    return ais;
  }

  async getAll(): Promise<IAis[]> {
    const since = new Date(Date.now() - 12 * 60 * 60 * 1000);
    return Ais.aggregate([
      {
        $project: {
          mmsi: 1,
          positions: {
            $filter: {
              input: {
                $map: {
                  input: '$positions',
                  as: 'pos',
                  in: {
                    $mergeObjects: [
                      '$$pos',
                      { timestampDate: { $toDate: '$$pos.timestamp' } },
                    ],
                  },
                },
              },
              as: 'pos',
              cond: { $gte: ['$$pos.timestampDate', since] },
            },
          },
        },
      },
      { $match: { 'positions.0': { $exists: true } } },
    ]);
  }

  async streamRecent(hours: number) {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

    return Ais.aggregate([
      // Same filter as after $unwind, applied first so the
      // 'positions.timestamp' index can skip ships without recent fixes.
      { $match: { 'positions.timestamp': { $gte: cutoff } } },
      { $unwind: '$positions' },
      { $match: { 'positions.timestamp': { $gte: cutoff } } },
      { $sort: { 'positions.timestamp': -1 } },
      {
        $group: {
          _id: '$mmsi',
          mmsi: { $first: '$mmsi' },
          positions: { $push: '$positions' },
        },
      },
      {
        $project: {
          mmsi: 1,
          positions: { $slice: ['$positions', 1] },
        },
      },
    ]).cursor({ batchSize: 500 });
  }

  async getBatamShipsinLast5Minutes(cutoffTime: Date): Promise<IAis[]> {
    return Ais.aggregate([
      {
        $match: {
          isBatam: true,
          // Ships without any fix since cutoffTime are dropped by the
          // 'positions.0' check below anyway; matching them here lets MongoDB
          // use the 'positions.timestamp' index.
          'positions.timestamp': { $gte: cutoffTime },
        },
      },
      {
        $project: {
          mmsi: 1,
          positions: {
            $filter: {
              input: '$positions',
              as: 'position',
              cond: { $gte: ['$$position.timestamp', cutoffTime] },
            },
          },
        },
      },
      {
        $match: {
          'positions.0': { $exists: true },
        },
      },
    ]).exec();
  }

  async getByMmsi(mmsi: string): Promise<IAis | null> {
    return Ais.findOne({ mmsi });
  }

  /**
   * The ship with only its latest position. Positions are stored newest-first,
   * so that is the first element (this used to return the last one, i.e. the
   * oldest fix of the stored 24 h window).
   */
  async getLastByMmsi(mmsi: string): Promise<IAis | null> {
    const [ais] = await Ais.aggregate([
      { $match: { mmsi: mmsi } },
      {
        $project: {
          mmsi: 1,
          positions: { $slice: ['$positions', 1] },
        },
      },
    ]);
    return ais ?? null;
  }

  async updatePositions(
    mmsi: string,
    newPosition: IAisPosition[],
  ): Promise<void> {
    await Ais.findOneAndUpdate(
      { mmsi: mmsi },
      {
        $set: { positions: newPosition },
      },
      { new: true },
    );
  }

  async getShipRouteByMMSI(
    mmsi: string,
    duration: number,
  ): Promise<IAisPosition[]> {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - duration);

    const ship = await Ais.findOne({ mmsi });

    if (!ship) {
      return [];
    }

    const route = ship.positions.filter((position) => {
      const posTime = new Date(position.timestamp);
      return posTime >= startTime && posTime <= endTime;
    });

    return route.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  }
}
