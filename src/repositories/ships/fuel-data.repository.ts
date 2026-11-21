import FuelData from '../../models/ships/Telemetry';
import { IFuelData } from '../../models/ships/Telemetry';

/** Telemetry counts as active when its latest entry is at most this old. */
export const TELEMETRY_ACTIVE_WINDOW_MINUTES = 1;
const MS_PER_MINUTE = 60_000;

export const FuelDataRepository = {
  async create(fuelData: IFuelData) {
    return await FuelData.create(fuelData);
  },

  async findAll() {
    return await FuelData.find({});
  },

  async isActive(mmsi: string) {
    try {
      const lastEntry = await FuelData.findOne({ mmsi }).sort({
        createdAt: -1,
      });
      if (!lastEntry) return false;

      const now = new Date();
      const lastTimestamp = lastEntry.createdAt
        ? new Date(lastEntry.createdAt)
        : new Date(0);
      // Before phase 0 this divided by 10 000, so "1 minute" was really 10 s.
      const differenceInMinutes =
        (now.getTime() - lastTimestamp.getTime()) / MS_PER_MINUTE;
      return differenceInMinutes <= TELEMETRY_ACTIVE_WINDOW_MINUTES;
    } catch (error) {
      console.error(`Error checking activity for MMSI ${mmsi}:`, error);
      return false;
    }
  },

  async getLatestByMMSI(mmsi: string) {
    try {
      return await FuelData.findOne({ mmsi }).sort({ createdAt: -1 });
    } catch (error) {
      console.error(`Error fetching latest fuel data for MMSI ${mmsi}:`, error);
      throw error;
    }
  },

  async deleteByMMSI(mmsi: string) {
    try {
      const result = await FuelData.deleteMany({ mmsi });
      return result.deletedCount > 0;
    } catch (error) {
      console.error(`Error deleting fuel data for MMSI ${mmsi}:`, error);
      throw error;
    }
  },
};
