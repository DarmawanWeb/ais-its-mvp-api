/**
 * Safe evaluator for the user-supplied first fuel formulas
 * (FirstFuelFormula.mainEngineFormula / auxiliaryEngineFormula).
 *
 * It replaces `new Function` + `with`, which executed arbitrary JavaScript.
 * Only arithmetic is accepted:
 *   - decimal numbers: 2, 0.5, .5, 5., 1e-3
 *   - the variables passed by the caller (fuel formulas get `speedKnot`)
 *   - + - * /, ** and ^ (both mean "power"), parentheses, unary - and +
 *   - Math.<function>(...) and Math.<constant>, see MATH_FUNCTIONS / MATH_CONSTANTS
 *   - the bare functions exp, log, ln, sqrt, pow, abs, min, max
 *     (log and ln are both the natural logarithm, like Math.log)
 *
 * Precedence and associativity are JavaScript's, and every operation is the
 * JavaScript one, so a formula that was valid before gives the same result.
 * As in JavaScript, a unary sign directly before a power is rejected:
 * write -(x ** 2) or (-x) ** 2 instead of -x ** 2.
 * Note: in the old evaluator `^` was JavaScript's bitwise XOR.
 */

export class FormulaError extends Error {}

const MAX_FORMULA_LENGTH = 1000;
const MAX_NESTING_DEPTH = 100;

type NumericFunction = (...args: number[]) => number;

const MATH_FUNCTIONS = new Map<string, NumericFunction>([
  ['abs', Math.abs],
  ['acos', Math.acos],
  ['acosh', Math.acosh],
  ['asin', Math.asin],
  ['asinh', Math.asinh],
  ['atan', Math.atan],
  ['atan2', Math.atan2],
  ['atanh', Math.atanh],
  ['cbrt', Math.cbrt],
  ['ceil', Math.ceil],
  ['cos', Math.cos],
  ['cosh', Math.cosh],
  ['exp', Math.exp],
  ['expm1', Math.expm1],
  ['floor', Math.floor],
  ['hypot', Math.hypot],
  ['ln', Math.log],
  ['log', Math.log],
  ['log10', Math.log10],
  ['log1p', Math.log1p],
  ['log2', Math.log2],
  ['max', Math.max],
  ['min', Math.min],
  ['pow', Math.pow],
  ['round', Math.round],
  ['sign', Math.sign],
  ['sin', Math.sin],
  ['sinh', Math.sinh],
  ['sqrt', Math.sqrt],
  ['tan', Math.tan],
  ['tanh', Math.tanh],
  ['trunc', Math.trunc],
]);

const MATH_CONSTANTS = new Map<string, number>([
  ['E', Math.E],
  ['LN10', Math.LN10],
  ['LN2', Math.LN2],
  ['LOG10E', Math.LOG10E],
  ['LOG2E', Math.LOG2E],
  ['PI', Math.PI],
  ['SQRT1_2', Math.SQRT1_2],
  ['SQRT2', Math.SQRT2],
]);

const BARE_FUNCTIONS = new Map<string, NumericFunction>([
  ['exp', Math.exp],
  ['log', Math.log],
  ['ln', Math.log],
  ['sqrt', Math.sqrt],
  ['pow', Math.pow],
  ['abs', Math.abs],
  ['min', Math.min],
  ['max', Math.max],
]);

type BinaryOperator = '+' | '-' | '*' | '/' | '**';
type Operator = BinaryOperator | '(' | ')' | ',' | '.';

type Token =
  | { kind: 'number'; value: number; position: number }
  | { kind: 'identifier'; name: string; position: number }
  | { kind: 'operator'; operator: Operator; position: number }
  | { kind: 'end'; position: number };

type Node =
  | { kind: 'number'; value: number }
  | { kind: 'variable'; name: string }
  | { kind: 'negate' | 'plus'; operand: Node }
  | { kind: 'binary'; operator: BinaryOperator; left: Node; right: Node }
  | { kind: 'call'; fn: NumericFunction; args: Node[] };

const BINARY_OPERATIONS: Record<
  BinaryOperator,
  (left: number, right: number) => number
> = {
  '+': (left, right) => left + right,
  '-': (left, right) => left - right,
  '*': (left, right) => left * right,
  '/': (left, right) => left / right,
  '**': (left, right) => left ** right,
};

const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const IDENTIFIER_PART = /[A-Za-z0-9_$.]/;
const SINGLE_CHAR_OPERATORS = new Set<string>([
  '+',
  '-',
  '*',
  '/',
  '(',
  ')',
  ',',
  '.',
]);

const matchAt = (pattern: RegExp, source: string, index: number): string => {
  pattern.lastIndex = index;
  return pattern.exec(source)?.[0] ?? '';
};

const tokenize = (source: string): Token[] => {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    const number = matchAt(NUMBER, source, index);
    if (number) {
      const end = index + number.length;
      // JavaScript rejects "1e", "2speedKnot" and "1.2.3" too; leading zeros
      // ("012") would be legacy octal there, so they are rejected as well.
      if (/^0\d/.test(number) || IDENTIFIER_PART.test(source[end] ?? '')) {
        throw new FormulaError(`Invalid number at position ${index}`);
      }
      tokens.push({ kind: 'number', value: Number(number), position: index });
      index = end;
      continue;
    }

    const identifier = matchAt(IDENTIFIER, source, index);
    if (identifier) {
      tokens.push({ kind: 'identifier', name: identifier, position: index });
      index += identifier.length;
      continue;
    }

    const pair = source.slice(index, index + 2);
    if (pair === '++' || pair === '--') {
      throw new FormulaError(`'${pair}' is not supported (position ${index})`);
    }
    if (pair === '**' || char === '^') {
      tokens.push({ kind: 'operator', operator: '**', position: index });
      index += pair === '**' ? 2 : 1;
      continue;
    }
    if (SINGLE_CHAR_OPERATORS.has(char)) {
      tokens.push({
        kind: 'operator',
        operator: char as Operator,
        position: index,
      });
      index += 1;
      continue;
    }

    throw new FormulaError(
      `Unexpected character '${char}' at position ${index}`,
    );
  }

  tokens.push({ kind: 'end', position: source.length });
  return tokens;
};

/** Recursive-descent parser following JavaScript's expression grammar. */
class Parser {
  private index = 0;
  private depth = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly variables: ReadonlySet<string>,
  ) {}

  parse(): Node {
    const node = this.parseAdditive();
    const token = this.peek();
    if (token.kind !== 'end') throw this.unexpected(token);
    return node;
  }

  private parseAdditive(): Node {
    return this.nested(() => {
      let left = this.parseMultiplicative();
      for (;;) {
        const operator = this.peekOperator();
        if (operator !== '+' && operator !== '-') return left;
        this.index += 1;
        left = {
          kind: 'binary',
          operator,
          left,
          right: this.parseMultiplicative(),
        };
      }
    });
  }

  private parseMultiplicative(): Node {
    let left = this.parseExponentiation();
    for (;;) {
      const operator = this.peekOperator();
      if (operator !== '*' && operator !== '/') return left;
      this.index += 1;
      left = {
        kind: 'binary',
        operator,
        left,
        right: this.parseExponentiation(),
      };
    }
  }

  // ExponentiationExpression: UnaryExpression | UpdateExpression ** ExponentiationExpression
  // (right-associative; a signed operand cannot be the base of a power).
  private parseExponentiation(): Node {
    const operator = this.peekOperator();
    if (operator === '-' || operator === '+') {
      const unary = this.parseUnary();
      if (this.peekOperator() === '**') {
        throw new FormulaError(
          'A sign before a power is ambiguous: write -(x ** 2) or (-x) ** 2',
        );
      }
      return unary;
    }

    const base = this.parsePrimary();
    if (this.peekOperator() !== '**') return base;
    this.index += 1;
    const exponent = this.nested(() => this.parseExponentiation());
    return { kind: 'binary', operator: '**', left: base, right: exponent };
  }

  private parseUnary(): Node {
    const operator = this.peekOperator();
    if (operator === '-' || operator === '+') {
      this.index += 1;
      const operand = this.nested(() => this.parseUnary());
      return { kind: operator === '-' ? 'negate' : 'plus', operand };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const token = this.next();
    if (token.kind === 'number') return { kind: 'number', value: token.value };
    if (token.kind === 'identifier') return this.parseIdentifier(token.name);
    if (token.kind === 'operator' && token.operator === '(') {
      const inner = this.parseAdditive();
      this.expect(')');
      return inner;
    }
    throw this.unexpected(token);
  }

  private parseIdentifier(name: string): Node {
    if (name === 'Math') {
      this.expect('.');
      const member = this.next();
      if (member.kind !== 'identifier') throw this.unexpected(member);
      const constant = MATH_CONSTANTS.get(member.name);
      if (constant !== undefined) return { kind: 'number', value: constant };
      const fn = MATH_FUNCTIONS.get(member.name);
      if (!fn) throw new FormulaError(`Math.${member.name} is not allowed`);
      return this.parseCall(fn);
    }

    if (this.peekOperator() === '(') {
      const fn = BARE_FUNCTIONS.get(name);
      if (!fn) throw new FormulaError(`Unknown function '${name}'`);
      return this.parseCall(fn);
    }

    if (!this.variables.has(name)) {
      throw new FormulaError(`Unknown variable '${name}'`);
    }
    return { kind: 'variable', name };
  }

  private parseCall(fn: NumericFunction): Node {
    this.expect('(');
    const args: Node[] = [];
    while (this.peekOperator() !== ')') {
      args.push(this.parseAdditive());
      if (this.peekOperator() !== ',') break;
      this.index += 1; // a trailing comma is allowed, as in JavaScript
    }
    this.expect(')');
    return { kind: 'call', fn, args };
  }

  private nested<T>(parse: () => T): T {
    this.depth += 1;
    if (this.depth > MAX_NESTING_DEPTH) {
      throw new FormulaError('Formula is nested too deeply');
    }
    try {
      return parse();
    } finally {
      this.depth -= 1;
    }
  }

  private peek(): Token {
    return this.tokens[this.index];
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (token.kind !== 'end') this.index += 1;
    return token;
  }

  private peekOperator(): Operator | null {
    const token = this.peek();
    return token.kind === 'operator' ? token.operator : null;
  }

  private expect(operator: Operator): void {
    const token = this.next();
    if (token.kind !== 'operator' || token.operator !== operator) {
      throw this.unexpected(token, `'${operator}'`);
    }
  }

  private unexpected(token: Token, expected?: string): FormulaError {
    const found = describeToken(token);
    return new FormulaError(
      expected
        ? `Expected ${expected} but found ${found}`
        : `Unexpected ${found}`,
    );
  }
}

const describeToken = (token: Token): string => {
  switch (token.kind) {
    case 'end':
      return 'end of formula';
    case 'number':
      return `number ${token.value} at position ${token.position}`;
    case 'identifier':
      return `'${token.name}' at position ${token.position}`;
    case 'operator':
      return `'${token.operator}' at position ${token.position}`;
  }
};

const evaluateNode = (
  node: Node,
  variables: Readonly<Record<string, number>>,
): number => {
  switch (node.kind) {
    case 'number':
      return node.value;
    case 'variable':
      return variables[node.name];
    case 'negate':
      return -evaluateNode(node.operand, variables);
    case 'plus':
      return +evaluateNode(node.operand, variables);
    case 'binary':
      return BINARY_OPERATIONS[node.operator](
        evaluateNode(node.left, variables),
        evaluateNode(node.right, variables),
      );
    case 'call':
      return node.fn(...node.args.map((arg) => evaluateNode(arg, variables)));
  }
};

/**
 * Evaluates an arithmetic formula. Throws FormulaError when the formula uses
 * anything outside the grammar described at the top of this file.
 */
export const evaluateArithmetic = (
  formula: string,
  variables: Readonly<Record<string, number>>,
): number => {
  if (typeof formula !== 'string') {
    throw new FormulaError('Formula must be a string');
  }
  if (formula.length > MAX_FORMULA_LENGTH) {
    throw new FormulaError(
      `Formula is longer than ${MAX_FORMULA_LENGTH} characters`,
    );
  }
  // `return <formula>;` accepted trailing semicolons, so they are ignored.
  const source = formula.replace(/[\s;]+$/, '');
  const variableNames = new Set(Object.keys(variables));
  const ast = new Parser(tokenize(source), variableNames).parse();
  return evaluateNode(ast, variables);
};
