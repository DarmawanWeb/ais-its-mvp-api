import mongoose, { Document, Schema } from 'mongoose';

export interface IIllegalTranshipmentResult extends Document {
  ship1MMSI: string;
  ship2MMSI: string;
  isIllegal: boolean;
  startTimestamp?: Date;
  endTimestamp?: Date;
  accuracy?: number;
  averagePriority?: number;
  priorityDistribution?: {
    low: number;
    medium: number;
    high: number;
  };
  detectedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const illegalTranshipmentResultSchema: Schema = new Schema(
  {
    ship1MMSI: {
      type: String,
      required: true,
      ref: 'Ais',
    },
    ship2MMSI: {
      type: String,
      required: true,
      ref: 'Ais',
    },
    isIllegal: {
      type: Boolean,
      required: true,
    },
    startTimestamp: {
      type: Date,
    },
    endTimestamp: {
      type: Date,
    },
    accuracy: {
      type: Number,
    },
    averagePriority: {
      type: Number,
    },
    priorityDistribution: {
      low: { type: Number },
      medium: { type: Number },
      high: { type: Number },
    },
    detectedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  { timestamps: true },
);

// Latest detection of a pair (also serves plain pair lookups).
illegalTranshipmentResultSchema.index({
  ship1MMSI: 1,
  ship2MMSI: 1,
  detectedAt: -1,
});
// Second branch of the "results of a ship" $or query.
illegalTranshipmentResultSchema.index({ ship2MMSI: 1, detectedAt: -1 });
// GET /illegal-transhipment/results (illegal results, newest first).
illegalTranshipmentResultSchema.index({ isIllegal: 1, detectedAt: -1 });
illegalTranshipmentResultSchema.index({ detectedAt: -1 });

const IllegalTranshipmentResult = mongoose.model<IIllegalTranshipmentResult>(
  'IllegalTranshipmentResult',
  illegalTranshipmentResultSchema,
);

export { IllegalTranshipmentResult };
