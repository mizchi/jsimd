export type NativeDuckDbWorkloadName = "q6" | "q1" | "logs" | "sparse";

export interface NativeDuckDbWorkload {
  readonly name: NativeDuckDbWorkloadName;
  readonly rows: number;
  readonly groupCount: number;
  readonly bytes: number;
  readonly selectivity: number;
  readonly setupSql: string;
  readonly querySql: string;
}

export interface DuckDbProfile {
  readonly queryName: string;
  readonly latencyMs: number;
}

type DuckDbRow = Readonly<Record<string, unknown>>;

export function nativeDuckDbWorkload(
  name: NativeDuckDbWorkloadName,
  rows: number,
  groupCount: number,
): NativeDuckDbWorkload {
  positiveInteger(rows, "rows");
  positiveInteger(groupCount, "groupCount");
  if (name === "q6") {
    return {
      name,
      rows,
      groupCount: 0,
      bytes: rows * Int32Array.BYTES_PER_ELEMENT,
      selectivity: 0.25,
      setupSql: `CREATE TABLE data AS
SELECT CAST((i & 65535) - 32768 AS INTEGER) AS value
FROM range(${rows}) AS rows(i);`,
      querySql: "SELECT count(*) AS count, sum(value) AS sum FROM data " +
        "WHERE value >= -8192 AND value < 8192;",
    };
  }

  if (name === "sparse") {
    const lower = Math.floor(rows * 0.7);
    const upper = Math.floor(rows * 0.8);
    return {
      name,
      rows,
      groupCount,
      bytes: rows * 13,
      selectivity: 0.1,
      setupSql: `CREATE TABLE data AS
SELECT CAST(i AS INTEGER) AS filter,
       CAST((((i % ${groupCount})::UBIGINT * 2654435761) & 4294967295) AS UINTEGER) AS group_id,
       CASE WHEN i % 17 = 0 THEN NULL ELSE CAST((i % 20001) - 10000 AS INTEGER) END AS value
FROM range(${rows}) AS rows(i);`,
      querySql: "SELECT group_id, count(value) AS count, count(*) - count(value) AS null_count, " +
        "sum(value) AS sum, min(value) AS min, max(value) AS max " +
        `FROM data WHERE filter >= ${lower} AND filter < ${upper} ` +
        "GROUP BY group_id ORDER BY group_id;",
    };
  }

  const lower = name === "q1" ? 0 : Math.floor(rows * 0.7);
  const upper = name === "q1" ? 25 : Math.floor(rows * 0.8);
  const filterExpression = name === "q1" ? "i % 50" : "i";
  return {
    name,
    rows,
    groupCount: 8,
    bytes: rows * 9,
    selectivity: name === "q1" ? 0.5 : 0.1,
    setupSql: `CREATE TABLE data AS
SELECT CAST(${filterExpression} AS INTEGER) AS filter,
       CAST((i % 20001) - 10000 AS INTEGER) AS value,
       CAST(i % 8 AS UTINYINT) AS group_id
FROM range(${rows}) AS rows(i);`,
    querySql:
      "SELECT group_id, count(*) AS count, sum(value) AS sum, min(value) AS min, max(value) AS max " +
      `FROM data WHERE filter >= ${lower} AND filter < ${upper} ` +
      "GROUP BY group_id ORDER BY group_id;",
  };
}

export function extractDuckDbProfiles(stderr: string): DuckDbProfile[] {
  const profiles: DuckDbProfile[] = [];
  for (const json of extractJsonObjects(stderr)) {
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const profile = value as Record<string, unknown>;
    if (typeof profile.query_name !== "string" || typeof profile.latency !== "number") continue;
    if (!Number.isFinite(profile.latency) || profile.latency < 0) {
      throw new RangeError("DuckDB profile latency must be finite and non-negative");
    }
    profiles.push({ queryName: profile.query_name, latencyMs: profile.latency * 1_000 });
  }
  return profiles;
}

export function validateNativeDuckDbResult(
  workload: NativeDuckDbWorkload,
  rows: readonly DuckDbRow[],
): void {
  if (workload.name === "q6") {
    if (rows.length !== 1) throw new Error(`q6 returned ${rows.length} rows`);
    const expected = expectedQ6(workload.rows);
    equalNumber(rows[0]!.count, expected.count, "q6 count");
    equalBigInt(rows[0]!.sum, expected.sum, "q6 sum");
    return;
  }

  const expected = workload.name === "sparse"
    ? expectedSparse(workload.rows, workload.groupCount)
    : expectedDenseGroups(workload.name, workload.rows);
  if (rows.length !== expected.length) {
    throw new Error(`${workload.name} returned ${rows.length} groups, expected ${expected.length}`);
  }
  for (let index = 0; index < expected.length; index++) {
    const actual = rows[index]!;
    const wanted = expected[index]!;
    equalNumber(actual.group_id, wanted.group, `group ${index} key`);
    equalNumber(actual.count, wanted.count, `group ${index} count`);
    equalBigInt(actual.sum, wanted.sum, `group ${index} sum`);
    equalNumber(actual.min, wanted.min, `group ${index} min`);
    equalNumber(actual.max, wanted.max, `group ${index} max`);
    if (workload.name === "sparse") {
      equalNumber(actual.null_count, wanted.nullCount, `group ${index} null count`);
    }
  }
}

function extractJsonObjects(text: string): string[] {
  const output: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (start < 0) {
      if (character === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) {
      output.push(text.slice(start, index + 1));
      start = -1;
    }
  }
  return output;
}

interface ExpectedGroup {
  readonly group: number;
  readonly count: number;
  readonly nullCount: number;
  readonly sum: bigint;
  readonly min: number;
  readonly max: number;
}

function expectedQ6(rows: number): { count: number; sum: bigint } {
  const cycles = Math.floor(rows / 65_536);
  const remainder = rows % 65_536;
  const remainderStart = 24_576;
  const remainderEnd = Math.min(remainder, 40_960);
  const remainderCount = Math.max(0, remainderEnd - remainderStart);
  const firstValue = -8_192;
  const lastValue = firstValue + remainderCount - 1;
  const remainderSum = remainderCount === 0
    ? 0n
    : BigInt((firstValue + lastValue) * remainderCount / 2);
  return {
    count: cycles * 16_384 + remainderCount,
    sum: BigInt(cycles) * -8_192n + remainderSum,
  };
}

function expectedDenseGroups(name: "q1" | "logs", rows: number): ExpectedGroup[] {
  const states = emptyGroups(8);
  const lower = name === "q1" ? 0 : Math.floor(rows * 0.7);
  const upper = name === "q1" ? 25 : Math.floor(rows * 0.8);
  const start = name === "q1" ? 0 : lower;
  const end = name === "q1" ? rows : upper;
  for (let row = start; row < end; row++) {
    if (name === "q1" && row % 50 >= upper) continue;
    updateExpected(states[row & 7]!, (row % 20_001) - 10_000, true);
  }
  return materializeExpected(states, (group) => group);
}

function expectedSparse(rows: number, groupCount: number): ExpectedGroup[] {
  const states = emptyGroups(groupCount);
  const lower = Math.floor(rows * 0.7);
  const upper = Math.floor(rows * 0.8);
  for (let row = lower; row < upper; row++) {
    updateExpected(states[row % groupCount]!, (row % 20_001) - 10_000, row % 17 !== 0);
  }
  return materializeExpected(states, (group) => Math.imul(group, 0x9e37_79b1) >>> 0)
    .sort((left, right) => left.group - right.group);
}

interface MutableExpectedGroup {
  count: number;
  nullCount: number;
  sum: bigint;
  min: number;
  max: number;
}

function emptyGroups(length: number): MutableExpectedGroup[] {
  return Array.from(
    { length },
    () => ({ count: 0, nullCount: 0, sum: 0n, min: 0x7fff_ffff, max: -0x8000_0000 }),
  );
}

function updateExpected(state: MutableExpectedGroup, value: number, valid: boolean): void {
  if (!valid) {
    state.nullCount++;
    return;
  }
  state.count++;
  state.sum += BigInt(value);
  if (value < state.min) state.min = value;
  if (value > state.max) state.max = value;
}

function materializeExpected(
  states: readonly MutableExpectedGroup[],
  key: (index: number) => number,
): ExpectedGroup[] {
  const output: ExpectedGroup[] = [];
  for (let index = 0; index < states.length; index++) {
    const state = states[index]!;
    if (state.count === 0 && state.nullCount === 0) continue;
    output.push({ group: key(index), ...state });
  }
  return output;
}

function equalNumber(actual: unknown, expected: number, label: string): void {
  if (Number(actual) !== expected) throw new Error(`${label}: ${actual} !== ${expected}`);
}

function equalBigInt(actual: unknown, expected: bigint, label: string): void {
  if (BigInt(String(actual)) !== expected) throw new Error(`${label}: ${actual} !== ${expected}`);
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be positive`);
}
