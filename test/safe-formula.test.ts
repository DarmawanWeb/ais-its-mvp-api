import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateArithmetic,
  FormulaError,
} from '../src/utils/cii/safe-formula';
import { evaluateFormula } from '../src/utils/cii/fuel-calculation';

/**
 * The evaluator used before phase 0 (src/utils/cii/fuel-calculation.ts),
 * verbatim. It executes arbitrary JavaScript, so it is only ever called with
 * the trusted formulas below, never with the malicious ones.
 */
const legacyEvaluateFormula = (
  formula: string,
  context: { speedKnot: number },
): number => {
  try {
    const safeEval = new Function(
      'context',
      `with (context) { return ${formula}; }`,
    );
    return Math.max(safeEval(context), 0.5);
  } catch {
    return 0.5;
  }
};

// Speeds are capped at 30 kn by calculateSpeed.
const SPEEDS = [0, 0.05, 0.5, 1, 2.75, 3.7, 8, 10, 12.5, 14.2, 19.999, 25, 30];

const REALISTIC_FORMULAS = [
  // The examples from docs/postman "3.7 Ships - First Fuel Formula"
  '-0.0382 * speedKnot ** 2 + 0.8658 * speedKnot - 0.0197',
  '1.5103 * Math.exp(-0.064 * speedKnot)',
  // Typical polynomial / exponential fits
  '0.0035 * speedKnot ** 3 - 0.012 * speedKnot ** 2 + 0.45 * speedKnot + 1.2',
  '0.00012*speedKnot**4-0.0021*speedKnot**3+0.031*speedKnot**2+0.2*speedKnot+0.9',
  '2.4e-3 * speedKnot ** 3 + .5',
  '1.2E+1 * speedKnot / 100',
  'Math.pow(speedKnot, 2) * 0.01 + 2',
  'Math.pow(speedKnot, 3) / 1000 + Math.pow(speedKnot, 2) / 100',
  '2.1 * Math.log(speedKnot + 1) + 0.3',
  'Math.log10(speedKnot + 1) * 4',
  'Math.sqrt(speedKnot) * 1.75 - 0.2',
  'Math.cbrt(speedKnot) + Math.hypot(speedKnot, 3)',
  '(0.5 + 0.02 * speedKnot) * (1 + speedKnot / 10)',
  '((speedKnot + 1) * (speedKnot - 1)) / (speedKnot + 2)',
  'Math.max(0.8, 0.05 * speedKnot ** 2)',
  'Math.min(speedKnot, 12) * 0.3 + Math.abs(speedKnot - 10) * 0.01',
  'Math.max(1, 2, speedKnot / 3, 0.25 * speedKnot)',
  'Math.round(speedKnot * 10) / 10 + Math.floor(speedKnot) - Math.ceil(speedKnot / 2)',
  'Math.PI * speedKnot / 4',
  'Math.E ** (-0.064 * speedKnot) * 1.5103',
  'speedKnot ** 2 ** 0.5',
  '2 ** -speedKnot + 1',
  '-(speedKnot ** 2) / 40 + 5',
  '(-speedKnot) ** 2 / 40',
  '- -speedKnot * 0.25',
  '+speedKnot * 0.25 - +1',
  '100 / (speedKnot + 1) - 3',
  '10 - 4 - 3 + speedKnot / 2 / 2',
  '0.1 * speedKnot;',
  '  0.3 * speedKnot  ',
  '0.2 *\n speedKnot + 1',
  'Math.max(speedKnot, 1,)',
  '5. * speedKnot',
  'speedKnot / 0',
  '0 / 0 + speedKnot',
];

describe('evaluateFormula (safe evaluator)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(REALISTIC_FORMULAS)(
    'gives the same result as the old evaluator for %s',
    (formula) => {
      for (const speedKnot of SPEEDS) {
        const expected = legacyEvaluateFormula(formula, { speedKnot });
        const actual = evaluateFormula(formula, { speedKnot });
        expect(
          Object.is(actual, expected),
          `${formula} @ ${speedKnot} kn`,
        ).toBe(true);
      }
    },
  );

  it('floors results at 0.5 and returns NaN results unchanged, as before', () => {
    expect(evaluateFormula('0.1', { speedKnot: 3 })).toBe(0.5);
    expect(evaluateFormula('-speedKnot', { speedKnot: 3 })).toBe(0.5);
    expect(evaluateFormula('Math.log(-1)', { speedKnot: 3 })).toBeNaN();
    expect(legacyEvaluateFormula('Math.log(-1)', { speedKnot: 3 })).toBeNaN();
  });

  it('returns 0.5 for formulas the old evaluator also rejected', () => {
    for (const formula of [
      '2 speedKnot',
      '2speedKnot',
      '-speedKnot ** 2',
      '(1 + 2',
      'speedKnot +',
      'SpeedKnot * 2',
      'Math.foo(1)',
    ]) {
      expect(evaluateFormula(formula, { speedKnot: 4 })).toBe(0.5);
      expect(legacyEvaluateFormula(formula, { speedKnot: 4 })).toBe(0.5);
    }
    // The old evaluator returned NaN for an empty formula (`return ;`).
    expect(evaluateFormula('', { speedKnot: 4 })).toBe(0.5);
  });

  it('supports ^ as power and the bare functions exp, log, ln, sqrt, pow, abs, min, max', () => {
    const context = { speedKnot: 9 };
    expect(evaluateArithmetic('speedKnot ^ 2', context)).toBe(81);
    expect(evaluateArithmetic('2 ^ 3 ^ 2', context)).toBe(512);
    expect(evaluateArithmetic('exp(1)', context)).toBe(Math.E);
    expect(evaluateArithmetic('log(speedKnot)', context)).toBe(Math.log(9));
    expect(evaluateArithmetic('ln(speedKnot)', context)).toBe(Math.log(9));
    expect(evaluateArithmetic('sqrt(speedKnot)', context)).toBe(3);
    expect(evaluateArithmetic('pow(speedKnot, 0.5)', context)).toBe(3);
    expect(evaluateArithmetic('abs(-speedKnot)', context)).toBe(9);
    expect(evaluateArithmetic('min(4, speedKnot)', context)).toBe(4);
    expect(evaluateArithmetic('max(4, speedKnot)', context)).toBe(9);
    expect(evaluateArithmetic('Math.ln(Math.E)', context)).toBe(1);
  });

  describe('rejects anything that is not arithmetic', () => {
    const MALICIOUS = [
      'process.exit(1)',
      'process.exit()',
      "require('child_process').execSync('id')",
      'globalThis.process.exit(1)',
      'globalThis',
      'this',
      'this.constructor.constructor("return process")().exit()',
      "constructor.constructor('return process')()",
      'speedKnot.constructor',
      "speedKnot.constructor.constructor('return 1')()",
      'Math.constructor',
      "Math['exp'](1)",
      "Math['constructor']",
      'Math.__proto__',
      '__proto__',
      'toString()',
      'hasOwnProperty("speedKnot")',
      'eval("1 + 1")',
      'Function("return process")()',
      'import("fs")',
      'new Date()',
      '(() => 1)()',
      'function () { return 1 }',
      'speedKnot = 5',
      '1; process.exit(1)',
    ];

    const UNSUPPORTED = [
      'Math.random()',
      'Math',
      'Math.exp',
      'speedKnot++',
      '--speedKnot',
      '"1" + 1',
      '`${1}`',
      '[1, 2]',
      '{}',
      'speedKnot ? 1 : 2',
      'speedKnot > 1',
      'speedKnot % 2',
      '1 & 3',
      'void 0',
      'typeof speedKnot',
      'Infinity',
      'NaN',
      '0x10',
      '010',
      '1_000',
      '1e',
      '/* comment */ 1',
      '1 // comment',
      `${'('.repeat(200)}1${')'.repeat(200)}`, // nested too deeply
      `${'-'.repeat(1)}${' -'.repeat(150)}1`, // nested too deeply
      `1${' + 1'.repeat(400)}`, // longer than 1000 characters
    ];

    it.each([...MALICIOUS, ...UNSUPPORTED])('%s', (formula) => {
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit must not be called');
      });

      expect(() => evaluateArithmetic(formula, { speedKnot: 10 })).toThrow(
        FormulaError,
      );
      expect(evaluateFormula(formula, { speedKnot: 10 })).toBe(0.5);
      expect(exit).not.toHaveBeenCalled();
    });

    it('does not resolve identifiers through the prototype chain', () => {
      const variables = Object.create({ inherited: 1 }) as Record<
        string,
        number
      >;
      expect(() => evaluateArithmetic('inherited', variables)).toThrow(
        FormulaError,
      );
      expect(() => evaluateArithmetic('constructor', {})).toThrow(FormulaError);
    });

    it('rejects non-string formulas', () => {
      expect(() =>
        evaluateArithmetic(undefined as unknown as string, { speedKnot: 1 }),
      ).toThrow(FormulaError);
    });
  });
});
