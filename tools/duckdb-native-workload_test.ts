import {
  extractDuckDbProfiles,
  nativeDuckDbWorkload,
  validateNativeDuckDbResult,
} from "./duckdb-native-workload.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("native DuckDB workloads preserve the browser comparison shapes", () => {
  const q6 = nativeDuckDbWorkload("q6", 33_554_432, 2_048);
  assert(q6.bytes === 134_217_728, "q6 bytes");
  assert(q6.selectivity === 0.25, "q6 selectivity");
  assert(q6.setupSql.includes("(i & 65535) - 32768"), "q6 data shape");
  assert(q6.querySql.includes("value >= -8192 AND value < 8192"), "q6 predicate");

  const q1 = nativeDuckDbWorkload("q1", 16_777_216, 2_048);
  assert(q1.bytes === 150_994_944, "q1 bytes");
  assert(q1.querySql.includes("filter >= 0 AND filter < 25"), "q1 predicate");
  assert(q1.querySql.includes("GROUP BY group_id ORDER BY group_id"), "q1 grouping");

  const logs = nativeDuckDbWorkload("logs", 16_777_216, 2_048);
  assert(logs.querySql.includes("filter >= 11744051 AND filter < 13421772"), "log bounds");

  const sparse = nativeDuckDbWorkload("sparse", 16_777_216, 2_048);
  assert(sparse.bytes === 218_103_808, "sparse bytes");
  assert(sparse.querySql.includes("count(*) - count(value) AS null_count"), "nullable state");
  assert(sparse.querySql.includes("GROUP BY group_id ORDER BY group_id"), "sparse grouping");
});

Deno.test("DuckDB JSON profiles retain sub-millisecond latency", () => {
  const stderr = [
    "warning before profile",
    JSON.stringify({ query_name: "SELECT 1;", latency: 0.000_625 }),
    JSON.stringify({ query_name: "SELECT '{';", latency: 0.001_25 }),
  ].join("\n");
  const profiles = extractDuckDbProfiles(stderr);
  assert(profiles.length === 2, "profile count");
  assert(profiles[0]!.latencyMs === 0.625, "sub-ms latency");
  assert(profiles[1]!.latencyMs === 1.25, "string braces do not break framing");
});

Deno.test("native DuckDB validation rejects a wrong result", () => {
  const workload = nativeDuckDbWorkload("q6", 65_536, 2_048);
  validateNativeDuckDbResult(workload, [{ count: 16_384, sum: "-8192" }]);
  assertThrows(() => validateNativeDuckDbResult(workload, [{ count: 1, sum: "0" }]));
});

function assertThrows(operation: () => unknown): void {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error("expected operation to throw");
}
