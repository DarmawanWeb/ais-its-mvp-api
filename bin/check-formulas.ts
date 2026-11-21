#!/usr/bin/env node

/**
 * Lists the stored first fuel formulas (FirstFuelFormula) whose fuel estimate
 * changes with the safe evaluator of phase 0, and the ships that use them.
 * Run it against the production database before deploying phase 0:
 *
 *   node dist/bin/check-formulas.js    (or pnpm check:formulas; MONGO_URI, MONGO_DB_NAME)
 *
 * Formulas are never run as JavaScript: see findLegacyDifferences.
 */
import mongoose from 'mongoose';
import config from '../src/config/config';
import { FirstFuelFormula } from '../src/models/ships/FirstFuelFormula';
import { Ship } from '../src/models/ships/Ship';
import { evaluateFormula } from '../src/utils/cii/fuel-calculation';
import {
  findLegacyDifferences,
  FormulaError,
} from '../src/utils/cii/safe-formula';

// calculateSpeed caps speeds at 30 kn.
const SPEEDS = [0, 5, 10, 15, 20, 25, 30];
const FIELDS = ['mainEngineFormula', 'auxiliaryEngineFormula'] as const;

/** What changes for one formula; null when nothing does. */
const describeChange = (formula: string): string | null => {
  let differences: string[];
  try {
    differences = findLegacyDifferences(formula, { speedKnot: 0 });
  } catch (error) {
    if (!(error instanceof FormulaError)) throw error;
    return `not accepted (${error.message}): the fuel estimate is now always 0.5`;
  }
  if (differences.length === 0) return null;
  const estimates = SPEEDS.map(
    (speedKnot) =>
      `${speedKnot} kn: ${evaluateFormula(formula, { speedKnot })}`,
  );
  return `${differences.join('; ')}. Fuel estimate now: ${estimates.join(', ')}`;
};

const main = async (): Promise<void> => {
  await mongoose.connect(config.mongo.uri, { dbName: config.mongo.dbName });
  const formulas = await FirstFuelFormula.find().lean();
  let changed = 0;

  for (const stored of formulas) {
    for (const field of FIELDS) {
      const formula = String(stored[field] ?? '');
      const change = describeChange(formula);
      if (change === null) continue;
      changed += 1;
      const ships = await Ship.find(
        { 'fuelFormulas.firstFuelFormula': stored._id },
        { mmsi: 1 },
      ).lean();
      console.log(
        `FirstFuelFormula ${String(stored._id)} ${field} ${JSON.stringify(formula)} ` +
          `(ships: ${ships.map((ship) => ship.mmsi).join(', ') || 'none'})\n  ${change}`,
      );
    }
  }

  console.log(
    `${formulas.length} first fuel formula document(s) checked: ${changed} formula(s) change.`,
  );
  await mongoose.disconnect();
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
