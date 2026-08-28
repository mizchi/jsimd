// Copyright 2022-2026 Dynatrace LLC
// Register transition and FGRA estimator adapted from Hash4j UltraLogLog (Apache-2.0).
// Licensed under the Apache License, Version 2.0.
// https://github.com/dynatrace-oss/hash4j/blob/main/src/main/java/com/dynatrace/hash4j/distinctcount/UltraLogLog.java

const MIN_PRECISION = 3;
const MAX_PRECISION = 20;
const ETA_0 = 4.663135422063788;
const ETA_1 = 2.1378502137958524;
const ETA_2 = 2.781144650979996;
const ETA_3 = 0.9824082545153715;
const TAU = 0.8194911375910897;
const POW_2_TAU = 2 ** TAU;
const POW_2_MINUS_TAU = 2 ** -TAU;
const POW_4_MINUS_TAU = 4 ** -TAU;
const MINUS_INV_TAU = -1 / TAU;
const ETA_X = ETA_0 - ETA_1 - ETA_2 + ETA_3;
const ETA23X = (ETA_2 - ETA_3) / ETA_X;
const ETA13X = (ETA_1 - ETA_3) / ETA_X;
const ETA3012XX = (ETA_3 * ETA_0 - ETA_1 * ETA_2) / (ETA_X * ETA_X);
const POW_4_MINUS_TAU_ETA_23 = POW_4_MINUS_TAU * (ETA_2 - ETA_3);
const POW_4_MINUS_TAU_ETA_01 = POW_4_MINUS_TAU * (ETA_0 - ETA_1);
const POW_4_MINUS_TAU_ETA_3 = POW_4_MINUS_TAU * ETA_3;
const POW_4_MINUS_TAU_ETA_1 = POW_4_MINUS_TAU * ETA_1;
const POW_2_MINUS_TAU_ETA_X = POW_2_MINUS_TAU * ETA_X;
const PHI_1 = ETA_0 / (POW_2_TAU * (2 * POW_2_TAU - 1));
const P_INITIAL = ETA_X * (POW_4_MINUS_TAU / (2 - POW_2_MINUS_TAU));
const POW_2_MINUS_TAU_ETA_02 = POW_2_MINUS_TAU * (ETA_0 - ETA_2);
const POW_2_MINUS_TAU_ETA_13 = POW_2_MINUS_TAU * (ETA_1 - ETA_3);
const POW_2_MINUS_TAU_ETA_2 = POW_2_MINUS_TAU * ETA_2;
const POW_2_MINUS_TAU_ETA_3 = POW_2_MINUS_TAU * ETA_3;

const ESTIMATION_FACTORS = [
  94.59941722950778,
  455.6358404615186,
  2159.476860400962,
  10149.51036338182,
  47499.52712820488,
  221818.76564766388,
  1034754.6840013304,
  4824374.384717942,
  2.2486750611989766e7,
  1.0479810199493326e8,
  4.8837185623048025e8,
  2.275794725435168e9,
  1.0604938814719946e10,
  4.9417362104242645e10,
  2.30276227770117e11,
  1.0730444972228585e12,
  5.0001829613164e12,
  2.329988778511272e13,
  1.0857295240912981e14,
  5.059288069986326e14,
  2.3575295235667005e15,
  1.0985627213141412e16,
  5.119087674515589e16,
  2.3853948339571715e17,
] as const;

const REGISTER_BASE_CONTRIBUTIONS = [
  0.8484061093359406,
  0.38895829052007685,
  0.5059986252327467,
  0.17873835725405993,
] as const;

/** Strong JavaScript reference for the same 8-bit UltraLogLog state contract. */
export class JsUltraLogLog implements Disposable {
  readonly precision: number;
  readonly state: Uint8Array;
  #disposed = false;

  constructor(precision: number) {
    validatePrecision(precision);
    this.precision = precision;
    this.state = new Uint8Array(1 << precision);
  }

  addU32Many(values: Uint32Array): this {
    this.#assertAlive();
    if (!(values instanceof Uint32Array)) throw new TypeError("values must be a Uint32Array");
    for (let index = 0; index < values.length; index++) {
      addU32ToState(this.state, this.precision, values[index]!);
    }
    return this;
  }

  merge(other: JsUltraLogLog): this {
    this.#assertAlive();
    other.#assertAlive();
    if (other.precision !== this.precision) throw new RangeError("precision mismatch");
    mergeStates(this.state, other.state, this.state);
    return this;
  }

  estimate(): number {
    this.#assertAlive();
    return estimateUltraLogLog(this.state, this.precision);
  }

  reset(): this {
    this.#assertAlive();
    this.state.fill(0);
    return this;
  }

  [Symbol.dispose](): void {
    this.#disposed = true;
    this.state.fill(0);
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("JsUltraLogLog has been disposed");
  }
}

export function addU32ToState(state: Uint8Array, precision: number, value: number): void {
  const high = mix32((value ^ 0x9e37_79b9) >>> 0);
  const low = mix32((value ^ 0x85eb_ca6b) >>> 0);
  const index = high >>> (32 - precision);
  const shiftedHigh = ((high << precision) | (low >>> (32 - precision))) >>> 0;
  const shiftedLow = (low << precision) >>> 0;
  const leadingZeros = shiftedHigh !== 0
    ? Math.clz32(shiftedHigh)
    : Math.min(64 - precision, 32 + Math.clz32(shiftedLow));
  const eventRegister = ((precision - 1 + leadingZeros) << 2) & 0xff;
  state[index] = mergeRegister(state[index]!, eventRegister);
}

export function mergeStates(left: Uint8Array, right: Uint8Array, output: Uint8Array): void {
  if (left.length !== right.length || output.length < left.length) {
    throw new RangeError("states must have matching lengths");
  }
  for (let index = 0; index < left.length; index++) {
    output[index] = mergeRegister(left[index]!, right[index]!);
  }
}

export function mergeRegister(left: number, right: number): number {
  if (left === 0) return right;
  if (right === 0) return left;
  const leftRank = left >>> 2;
  const rightRank = right >>> 2;
  if (leftRank === rightRank) return (left & 0xfc) | ((left | right) & 3);
  const larger = leftRank > rightRank ? left : right;
  const smaller = leftRank > rightRank ? right : left;
  const difference = Math.abs(leftRank - rightRank);
  let history = larger & 3;
  if (difference === 1) history |= 2 | ((smaller >>> 1) & 1);
  else if (difference === 2) history |= 1;
  return (larger & 0xfc) | history;
}

export function estimateUltraLogLog(state: Uint8Array, precision: number): number {
  validatePrecision(precision);
  if (state.length !== 1 << precision) {
    throw new RangeError("state length does not match precision");
  }
  const m = state.length;
  let c0 = 0;
  let c4 = 0;
  let c8 = 0;
  let c10 = 0;
  let c4w0 = 0;
  let c4w1 = 0;
  let c4w2 = 0;
  let c4w3 = 0;
  let sum = 0;
  const offset = (precision << 2) + 4;
  for (let index = 0; index < state.length; index++) {
    const register = state[index]!;
    const relative = register - offset;
    if (relative < 0) {
      if (relative < -8) c0++;
      if (relative === -8) c4++;
      if (relative === -4) c8++;
      if (relative === -2) c10++;
    } else if (register < 252) {
      sum += REGISTER_BASE_CONTRIBUTIONS[relative & 3]! *
        POW_2_MINUS_TAU ** (relative >>> 2);
    } else {
      if (register === 252) c4w0++;
      if (register === 253) c4w1++;
      if (register === 254) c4w2++;
      if (register === 255) c4w3++;
    }
  }
  if (c0 === m) return 0;
  if (c0 > 0 || c4 > 0 || c8 > 0 || c10 > 0) {
    const z = smallRangeEstimate(c0, c4, c8, c10, m);
    if (c0 > 0) sum += c0 * sigma(z);
    if (c4 > 0) sum += c4 * POW_2_MINUS_TAU_ETA_X * psiPrime(z, z * z);
    if (c8 > 0) sum += c8 * (z * POW_4_MINUS_TAU_ETA_01 + POW_4_MINUS_TAU_ETA_1);
    if (c10 > 0) sum += c10 * (z * POW_4_MINUS_TAU_ETA_23 + POW_4_MINUS_TAU_ETA_3);
  }
  if (c4w0 > 0 || c4w1 > 0 || c4w2 > 0 || c4w3 > 0) {
    sum += largeRangeContribution(c4w0, c4w1, c4w2, c4w3, m, 65 - precision);
  }
  return ESTIMATION_FACTORS[precision - MIN_PRECISION]! * sum ** MINUS_INV_TAU;
}

function mix32(value: number): number {
  let hash = value >>> 0;
  hash = Math.imul(hash ^ hash >>> 16, 0x7feb_352d);
  hash = Math.imul(hash ^ hash >>> 15, 0x846c_a68b);
  return (hash ^ hash >>> 16) >>> 0;
}

function smallRangeEstimate(c0: number, c4: number, c8: number, c10: number, m: number): number {
  const alpha = m + 3 * (c0 + c4 + c8 + c10);
  const beta = m - c0 - c4;
  const gamma = 4 * c0 + 2 * c4 + 3 * c8 + c10;
  const quadRoot = (Math.sqrt(beta * beta + 4 * alpha * gamma) - beta) / (2 * alpha);
  const root = quadRoot * quadRoot;
  return root * root;
}

function largeRangeEstimate(c0: number, c1: number, c2: number, c3: number, m: number): number {
  const alpha = m + 3 * (c0 + c1 + c2 + c3);
  const beta = c0 + c1 + 2 * (c2 + c3);
  const gamma = m + 2 * c0 + c2 - c3;
  return Math.sqrt((Math.sqrt(beta * beta + 4 * alpha * gamma) - beta) / (2 * alpha));
}

function psiPrime(z: number, zSquare: number): number {
  return (z + ETA23X) * (zSquare + ETA13X) + ETA3012XX;
}

function sigma(z: number): number {
  if (z <= 0) return ETA_3;
  if (z >= 1) return Number.POSITIVE_INFINITY;
  let powerZ = z;
  let nextPowerZ = powerZ * powerZ;
  let sum = 0;
  let powerTau = ETA_X;
  while (true) {
    const previous = sum;
    const nextNextPowerZ = nextPowerZ * nextPowerZ;
    sum += powerTau * (powerZ - nextPowerZ) * psiPrime(nextPowerZ, nextNextPowerZ);
    if (!(sum > previous)) return sum / z;
    powerZ = nextPowerZ;
    nextPowerZ = nextNextPowerZ;
    powerTau *= POW_2_TAU;
  }
}

function phi(z: number, zSquare: number): number {
  if (z <= 0) return 0;
  if (z >= 1) return PHI_1;
  let previousPowerZ = zSquare;
  let powerZ = z;
  let nextPowerZ = Math.sqrt(powerZ);
  let p = P_INITIAL / (1 + nextPowerZ);
  let previousPsi = psiPrime(powerZ, previousPowerZ);
  let sum = nextPowerZ * (previousPsi + previousPsi) * p;
  while (true) {
    previousPowerZ = powerZ;
    powerZ = nextPowerZ;
    const previous = sum;
    nextPowerZ = Math.sqrt(powerZ);
    const nextPsi = psiPrime(powerZ, previousPowerZ);
    p *= POW_2_MINUS_TAU / (1 + nextPowerZ);
    sum += nextPowerZ * ((nextPsi + nextPsi) - (powerZ + nextPowerZ) * previousPsi) * p;
    if (!(sum > previous)) return sum;
    previousPsi = nextPsi;
  }
}

function largeRangeContribution(
  c0: number,
  c1: number,
  c2: number,
  c3: number,
  m: number,
  w: number,
): number {
  const z = largeRangeEstimate(c0, c1, c2, c3, m);
  const rootZ = Math.sqrt(z);
  let sum = phi(rootZ, z) * (c0 + c1 + c2 + c3);
  sum += z * (1 + rootZ) * (c0 * ETA_0 + c1 * ETA_1 + c2 * ETA_2 + c3 * ETA_3);
  sum += rootZ *
    ((c0 + c1) * (z * POW_2_MINUS_TAU_ETA_02 + POW_2_MINUS_TAU_ETA_2) +
      (c2 + c3) * (z * POW_2_MINUS_TAU_ETA_13 + POW_2_MINUS_TAU_ETA_3));
  return sum * POW_2_MINUS_TAU ** w / ((1 + rootZ) * (1 + z));
}

function validatePrecision(precision: number): void {
  if (!Number.isSafeInteger(precision) || precision < MIN_PRECISION || precision > MAX_PRECISION) {
    throw new RangeError(`precision must be between ${MIN_PRECISION} and ${MAX_PRECISION}`);
  }
}
