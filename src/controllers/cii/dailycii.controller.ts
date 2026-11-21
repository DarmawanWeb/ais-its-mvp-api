import { Request, Response } from 'express';
import { DailyCIIService } from '../../services/cii/dailycii.service';
import { handleError } from '../../utils/error.handler';
import { CIINotAvailableError } from '../../middlewares/error.middleware';

const dailyCiiService = new DailyCIIService();

/** 404 { code: 'CII_NOT_AVAILABLE' } when no daily CII exists for a ship yet. */
const sendCIINotAvailable = (res: Response, mmsi: string) =>
  handleError(
    new CIINotAvailableError(
      `CII not available for MMSI ${mmsi}: no daily CII has been computed yet`,
    ),
    res,
  );

export const createDailyCiiController = async (req: Request, res: Response) => {
  const { mmsi, ciiData } = req.body;
  try {
    const newDailyCii = await dailyCiiService.createDailyCii(mmsi, ciiData);
    res.status(201).json({
      message: 'Daily Cii created successfully',
      data: newDailyCii,
      success: true,
    });
  } catch (error: unknown) {
    handleError(error, res);
  }
};

export const getAllDailyCiiController = async (
  _req: Request,
  res: Response,
) => {
  try {
    const dailyCiiRecords = await dailyCiiService.getAllDailyCii();
    res.status(200).json({
      message: 'All Daily Cii records fetched successfully',
      data: dailyCiiRecords,
      success: true,
    });
  } catch (error: unknown) {
    handleError(error, res);
  }
};

export const getDailyCiiByMmsiController = async (
  req: Request,
  res: Response,
) => {
  const { mmsi } = req.params;
  try {
    const dailyCiiRecord = await dailyCiiService.getDailyCiiByMmsi(mmsi);
    if (!dailyCiiRecord || dailyCiiRecord.cii.length === 0) {
      sendCIINotAvailable(res, mmsi);
      return;
    }
    res.status(200).json({
      message: 'Daily Cii record fetched successfully',
      data: dailyCiiRecord,
      success: true,
    });
  } catch (error: unknown) {
    handleError(error, res);
  }
};

export const getLatestDailyCiiByMmsiController = async (
  req: Request,
  res: Response,
) => {
  const { mmsi } = req.params;
  try {
    const latestDailyCiiRecord =
      await dailyCiiService.getLatestDailyCiiByMmsi(mmsi);
    if (!latestDailyCiiRecord) {
      sendCIINotAvailable(res, mmsi);
    } else {
      res.status(200).json({
        message: 'Latest Daily Cii record fetched successfully',
        data: latestDailyCiiRecord,
        success: true,
      });
    }
  } catch (error: unknown) {
    handleError(error, res);
  }
};

export const getAttainedCiiByMmsiController = async (
  req: Request,
  res: Response,
) => {
  const { mmsi } = req.params;
  try {
    const attainedCii = await dailyCiiService.getAttainedCiiByMmsi(mmsi);
    if (!attainedCii) {
      sendCIINotAvailable(res, mmsi);
    } else {
      res.status(200).json({
        message: 'Attained CII data fetched successfully',
        data: attainedCii,
        success: true,
      });
    }
  } catch (error: unknown) {
    handleError(error, res);
  }
};

export const deleteDailyCiiController = async (req: Request, res: Response) => {
  const { mmsi } = req.params;
  try {
    const deletedDailyCii = await dailyCiiService.deleteDailyCii(mmsi);
    if (!deletedDailyCii) {
      res.status(404).json({
        message: 'Daily Cii record not found',
        success: false,
      });
    } else {
      res.status(200).json({
        message: 'Daily Cii record deleted successfully',
        success: true,
      });
    }
  } catch (error: unknown) {
    handleError(error, res);
  }
};
