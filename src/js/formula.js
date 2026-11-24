// Quest Studio formula language.
// Safe pipeline: tokenize -> parse (AST) -> compile to closures. User text is never passed to eval/new Function.
//
// Variables: t (seconds since the note started, alias x), f (note frequency in Hz), v (velocity 0..1)
// Constants: pi, tau, e
// Operators: + - * / % ^ (also **), unary -, implicit multiplication (2pi, 3(t+1))

const MAX_LENGTH = 2000;
const MAX_DEPTH = 120;

export const mod = (a, b) => ((a % b) + b) % b;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Deterministic white noise in [-1, 1]: same t always gives the same value (reproducible sound).
export function noise(x) {
  let h = Math.floor(x * 44100) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483647.5 - 1;
}

// name: [arity, implementation, description]
export const FUNCTIONS = {
  sin: [1, Math.sin, 'sine, argument in radians'],
  cos: [1, Math.cos, 'cosine, argument in radians'],
  tan: [1, Math.tan, 'tangent'],
  tanh: [1, Math.tanh, 'soft saturation'],
  exp: [1, Math.exp, 'e to the power x'],
  log: [1, Math.log, 'natural logarithm'],
  abs: [1, Math.abs, 'absolute value'],
  sqrt: [1, Math.sqrt, 'square root'],
  floor: [1, Math.floor, 'round down'],
  ceil: [1, Math.ceil, 'round up'],
  round: [1, Math.round, 'round to nearest'],
  sign: [1, Math.sign, '-1, 0 or 1'],
  step: [1, (x) => (x >= 0 ? 1 : 0), '1 when x >= 0, else 0'],
  frac: [1, (x) => x - Math.floor(x), 'fractional part, x - floor(x)'],
  if: [3, (c, a, b) => (c > 0 ? a : b), 'a when c > 0, otherwise b (piecewise)'],
  min: [2, Math.min, 'smaller value'],
  max: [2, Math.max, 'larger value'],
  pow: [2, Math.pow, 'a to the power b'],
  mod: [2, mod, 'remainder, always positive'],
  clamp: [3, clamp, 'limit x between a and b'],
  saw: [1, (p) => 2 * mod(p, 1) - 1, 'sawtooth, argument in cycles'],
  sqr: [1, (p) => (mod(p, 1) < 0.5 ? 1 : -1), 'square wave, argument in cycles'],
  tri: [1, (p) => 1 - 4 * Math.abs(mod(p, 1) - 0.5), 'triangle wave, argument in cycles'],
  noise: [1, noise, 'reproducible white noise'],
};

export const CONSTANTS = { pi: Math.PI, tau: 2 * Math.PI, e: Math.E, nan: NaN }; // nan = undefined (silent in Graph mode)
export const VARIABLES = ['t', 'f', 'v'];
const VAR_ALIASES = { x: 't' };

// Oscillator functions and the unit of their argument (used by the verifier to predict frequencies).
export const OSCILLATORS = { sin: 'radians', cos: 'radians', saw: 'cycles', sqr: 'cycles', tri: 'cycles' };
export const DISCONTINUOUS = new Set(['saw', 'sqr', 'mod', 'floor', 'ceil', 'round', 'step', 'sign', 'noise', 'frac', 'if']);

export class FormulaError extends Error {
  constructor(message, pos) {
    super(message);
    this.pos = pos;
  }
}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new FormulaError(`Invalid number`, i);
      tokens.push({ type: 'num', value: parseFloat(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if (/[a-zA-Z_π]/.test(c)) {
      const m = /^[a-zA-Z_π][a-zA-Z0-9_]*/.exec(src.slice(i));
      tokens.push({ type: 'id', value: m[0] === 'π' ? 'pi' : m[0].toLowerCase(), pos: i });
      i += m[0].length;
      continue;
    }
    if (c === '*' && src[i + 1] === '*') { tokens.push({ type: 'op', value: '^', pos: i }); i += 2; continue; }
    if ('+-*/%^(),'.includes(c)) { tokens.push({ type: 'op', value: c, pos: i }); i++; continue; }
    throw new FormulaError(`Unexpected character "${c}"`, i);
  }
  tokens.push({ type: 'end', pos: src.length });
  return tokens;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.i = 0;
    this.depth = 0;
  }
  peek() { return this.tokens[this.i]; }
  next() { return this.tokens[this.i++]; }
  isOp(v) { const t = this.peek(); return t.type === 'op' && t.value === v; }
  expect(v) {
    const t = this.next();
    if (t.type !== 'op' || t.value !== v) throw new FormulaError(`Expected "${v}"`, t.pos);
  }
  enter(pos) { if (++this.depth > MAX_DEPTH) throw new FormulaError('Formula is nested too deeply', pos); }

  parse() {
    const node = this.expr();
    const t = this.peek();
    if (t.type !== 'end') throw new FormulaError(`Unexpected "${t.value}"`, t.pos);
    return node;
  }
  expr() {
    let a = this.term();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next();
      a = { type: 'bin', op: op.value, a, b: this.term(), pos: op.pos };
    }
    return a;
  }
  startsOperand() {
    const t = this.peek();
    return t.type === 'num' || t.type === 'id' || (t.type === 'op' && t.value === '(');
  }
  term() {
    let a = this.unary();
    for (;;) {
      if (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
        const op = this.next();
        a = { type: 'bin', op: op.value, a, b: this.unary(), pos: op.pos };
      } else if (this.startsOperand()) {
        a = { type: 'bin', op: '*', a, b: this.unary(), pos: this.peek().pos }; // implicit multiplication
      } else {
        return a;
      }
    }
  }
  unary() {
    if (this.isOp('-') || this.isOp('+')) {
      const op = this.next();
      this.enter(op.pos);
      const a = this.unary();
      this.depth--;
      return op.value === '-' ? { type: 'neg', a, pos: op.pos } : a;
    }
    return this.power();
  }
  power() {
    const base = this.primary();
    if (this.isOp('^')) {
      const op = this.next();
      this.enter(op.pos);
      const b = this.unary(); // right-associative, allows 2^-t
      this.depth--;
      return { type: 'bin', op: '^', a: base, b, pos: op.pos };
    }
    return base;
  }
  primary() {
    const t = this.next();
    if (t.type === 'num') return { type: 'num', value: t.value, pos: t.pos };
    if (t.type === 'op' && t.value === '(') {
      this.enter(t.pos);
      const e = this.expr();
      this.depth--;
      this.expect(')');
      return e;
    }
    if (t.type === 'id') {
      if (this.isOp('(')) {
        const fn = Object.hasOwn(FUNCTIONS, t.value) ? FUNCTIONS[t.value] : null;
        if (!fn) throw new FormulaError(`Unknown function "${t.value}"`, t.pos);
        this.next();
        this.enter(t.pos);
        const args = [];
        if (!this.isOp(')')) {
          args.push(this.expr());
          while (this.isOp(',')) { this.next(); args.push(this.expr()); }
        }
        this.depth--;
        this.expect(')');
        if (args.length !== fn[0]) {
          throw new FormulaError(`${t.value}() needs ${fn[0]} value${fn[0] > 1 ? 's' : ''}, got ${args.length}`, t.pos);
        }
        return { type: 'call', name: t.value, args, pos: t.pos };
      }
      if (Object.hasOwn(CONSTANTS, t.value)) return { type: 'num', value: CONSTANTS[t.value], name: t.value, pos: t.pos };
      const name = Object.hasOwn(VAR_ALIASES, t.value) ? VAR_ALIASES[t.value] : t.value;
      if (VARIABLES.includes(name)) return { type: 'var', name, pos: t.pos };
      if (Object.hasOwn(FUNCTIONS, t.value)) throw new FormulaError(`"${t.value}" is a function, use ${t.value}(...)`, t.pos);
      throw new FormulaError(`Unknown name "${t.value}". Use t, f, v, pi, tau or e`, t.pos);
    }
    if (t.type === 'end') throw new FormulaError('Formula ended unexpectedly', t.pos);
    throw new FormulaError(`Unexpected "${t.value}"`, t.pos);
  }
}

// Removes an optional "y =" / "f(t) =" prefix so pasted formulas work.
function stripAssignment(src) {
  return src.replace(/^\s*[a-zA-Z]\w*\s*(\(\s*[a-zA-Z,\s]*\))?\s*=(?!=)/, '');
}

export function parse(source) {
  if (typeof source !== 'string' || !source.trim()) throw new FormulaError('Formula is empty', 0);
  if (source.length > MAX_LENGTH) throw new FormulaError(`Formula is longer than ${MAX_LENGTH} characters`, MAX_LENGTH);
  const body = stripAssignment(source);
  const offset = source.length - body.length;
  try {
    return new Parser(tokenize(body)).parse();
  } catch (err) {
    if (err instanceof FormulaError) err.pos += offset;
    throw err;
  }
}

const BIN = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => a / b,
  '%': mod,
  '^': Math.pow,
};

// Fast path used for audio rendering: AST -> nested closures, specialised per operator,
// with constant parts pre-computed (e.g. tau*440 becomes 2764.6...). Same math, same order of operations.
// A part of the formula is constant when it cannot change during the sound: it never uses t
// (and, before the note is known, never uses f or v either).
function isConst(node, fixed) {
  if (fixed) return !dependsOn(node, 't');
  return node.type === 'num' || (node.type !== 'var' && !['t', 'f', 'v'].some((n) => dependsOn(node, n)));
}

// `fixed` = { f, v } of one note: everything that does not depend on t is then computed only once.
export function compileAst(node, fixed = null) {
  if (node.type !== 'num' && isConst(node, fixed)) {
    const v = evaluate(node, fixed || {});
    return () => v;
  }
  switch (node.type) {
    case 'shared': return node.fn;
    case 'num': { const v = node.value; return () => v; }
    case 'var':
      if (node.name === 't') return (e) => e.t;
      if (node.name === 'f') return (e) => e.f;
      return (e) => e.v;
    case 'neg': { const a = compileAst(node.a, fixed); return (e) => -a(e); }
    case 'bin': {
      const a = compileAst(node.a, fixed), b = compileAst(node.b, fixed);
      const ka = isConst(node.a, fixed) ? a() : null, kb = isConst(node.b, fixed) ? b() : null;
      switch (node.op) {
        case '+': return kb !== null ? (e) => a(e) + kb : ka !== null ? (e) => ka + b(e) : (e) => a(e) + b(e);
        case '-': return kb !== null ? (e) => a(e) - kb : ka !== null ? (e) => ka - b(e) : (e) => a(e) - b(e);
        case '*': return kb !== null ? (e) => a(e) * kb : ka !== null ? (e) => ka * b(e) : (e) => a(e) * b(e);
        case '/': return kb !== null ? (e) => a(e) / kb : (e) => a(e) / b(e);
        case '%': return (e) => mod(a(e), b(e));
        case '^': return (e) => Math.pow(a(e), b(e));
        default: throw new Error(`Unknown operator ${node.op}`);
      }
    }
    case 'call': {
      const fn = FUNCTIONS[node.name][1];
      const args = node.args.map((x) => compileAst(x, fixed));
      if (args.length === 1) {
        const [a] = args;
        switch (node.name) {
          case 'sin': return (e) => Math.sin(a(e));
          case 'cos': return (e) => Math.cos(a(e));
          case 'exp': return (e) => Math.exp(a(e));
          case 'tanh': return (e) => Math.tanh(a(e));
          default: return (e) => fn(a(e));
        }
      }
      if (args.length === 2) { const [a, b] = args; return (e) => fn(a(e), b(e)); }
      return (e) => fn(...args.map((g) => g(e)));
    }
    default: throw new Error(`Unknown node ${node.type}`);
  }
}

// Independent reference path used by the verifier: plain recursive interpretation (no closures, no cache).
export function evaluate(node, env) {
  switch (node.type) {
    case 'num': return node.value;
    case 'var': return env[node.name];
    case 'neg': return -evaluate(node.a, env);
    case 'bin': return BIN[node.op](evaluate(node.a, env), evaluate(node.b, env));
    case 'call': return FUNCTIONS[node.name][1](...node.args.map((a) => evaluate(a, env)));
    default: throw new Error(`Unknown node ${node.type}`);
  }
}

export function dependsOn(node, name) {
  if (node.type === 'shared') return true; // only time-dependent parts are shared
  if (node.type === 'var') return node.name === name;
  if (node.type === 'neg') return dependsOn(node.a, name);
  if (node.type === 'bin') return dependsOn(node.a, name) || dependsOn(node.b, name);
  if (node.type === 'call') return node.args.some((a) => dependsOn(a, name));
  return false;
}

export function walk(node, visit) {
  visit(node);
  if (node.type === 'neg') walk(node.a, visit);
  else if (node.type === 'bin') { walk(node.a, visit); walk(node.b, visit); }
  else if (node.type === 'call') node.args.forEach((a) => walk(a, visit));
}

const cache = new Map();

// Parse + compile with a small cache. Throws FormulaError for invalid input.
export function compile(source) {
  let entry = cache.get(source);
  if (!entry) {
    const ast = parse(source);
    entry = { source, ast, fn: compileAst(ast) };
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    cache.set(source, entry);
  }
  return entry;
}

// Version of a formula specialised for one note (f and v known): used by the renderer.
const noteCache = new Map();
// Text key that is identical for identical sub-expressions.
function nodeKey(node) {
  switch (node.type) {
    case 'num': return String(node.value);
    case 'var': return node.name;
    case 'neg': return `-(${nodeKey(node.a)})`;
    case 'bin': return `(${nodeKey(node.a)}${node.op}${nodeKey(node.b)})`;
    default: return `${node.name}(${node.args.map(nodeKey).join(',')})`;
  }
}

// Repeated time-dependent parts (e.g. one vibrato phase used by 8 harmonics) are computed once per sample.
function withSharedParts(ast, fixed) {
  const counts = new Map();
  walk(ast, (n) => { if (n.type !== 'num' && n.type !== 'var') { const k = nodeKey(n); counts.set(k, (counts.get(k) || 0) + 1); } });
  const memo = new Map();
  const build = (node) => {
    const k = node.type === 'num' || node.type === 'var' ? null : nodeKey(node);
    if (k && counts.get(k) > 1 && dependsOn(node, 't')) {
      if (!memo.has(k)) {
        const inner = compileAst(node, fixed);
        let lastT = NaN, value = 0;
        memo.set(k, (e) => (e.t === lastT ? value : (lastT = e.t, value = inner(e))));
      }
      return { type: 'shared', fn: memo.get(k) };
    }
    if (node.type === 'neg') return { ...node, a: build(node.a) };
    if (node.type === 'bin') return { ...node, a: build(node.a), b: build(node.b) };
    if (node.type === 'call') return { ...node, args: node.args.map(build) };
    return node;
  };
  return build(ast);
}

export function compileForNote(source, f, v) {
  const key = `${f}|${v}|${source}`;
  let fn = noteCache.get(key);
  if (!fn) {
    fn = compileAst(withSharedParts(compile(source).ast, { f, v }), { f, v });
    if (noteCache.size > 400) noteCache.delete(noteCache.keys().next().value);
    noteCache.set(key, fn);
  }
  return fn;
}

export function check(source) {
  try {
    compile(source);
    return null;
  } catch (err) {
    if (err instanceof FormulaError) return err;
    throw err;
  }
}
