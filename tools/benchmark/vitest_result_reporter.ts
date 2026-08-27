import { dirname } from "node:path";
import process from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform } from "node:os";
import {
  experimental_getRunnerTask,
  type Reporter,
  type TestCase,
  type TestModule,
  type TestRunEndReason,
} from "vitest/node";
import { detectBenchmarkEnvironment } from "./result.ts";
import {
  createVitestBenchmarkResult,
  retainUniformSamples,
  type VitestBenchmarkCase,
} from "./vitest_result.ts";

interface RetainedBenchmarkResult {
  readonly samples?: number[];
}

interface BenchmarkRunnerTask {
  readonly meta?: { readonly benchmark?: boolean };
  readonly result?: { readonly benchmark?: RetainedBenchmarkResult };
}

export default class CommonBenchmarkResultReporter implements Reporter {
  readonly #cases: VitestBenchmarkCase[] = [];

  onTestCaseResult(testCase: TestCase): void {
    const task = experimental_getRunnerTask(testCase) as BenchmarkRunnerTask;
    if (!task.meta?.benchmark) return;
    const samplesMs = task.result?.benchmark?.samples;
    if (samplesMs === undefined || samplesMs.length === 0) {
      throw new Error(
        `${testCase.fullName}: no raw samples; run with benchmark.includeSamples enabled`,
      );
    }
    const fullSampleCount = samplesMs.length;
    const sampleLimit = parsePositiveInteger(process.env.JSIMD_VITEST_SAMPLE_LIMIT ?? "20");
    this.#cases.push({
      name: testCase.fullName,
      samplesMs: retainUniformSamples(samplesMs, sampleLimit),
      fullSampleCount,
    });
    samplesMs.length = 0;
  }

  async onTestRunEnd(
    _testModules: readonly TestModule[],
    unhandledErrors: readonly unknown[],
    reason: TestRunEndReason,
  ): Promise<void> {
    const output = process.env.JSIMD_VITEST_OUTPUT;
    if (output === undefined) return;
    if (reason !== "passed" || unhandledErrors.length > 0) {
      throw new Error("refusing to record a failed Vitest benchmark run");
    }
    const cpuList = cpus();
    const result = createVitestBenchmarkResult({
      name: process.env.JSIMD_VITEST_NAME ?? "vitest/benchmark",
      recordedAt: new Date().toISOString(),
      environment: detectBenchmarkEnvironment({
        runtimeName: "node",
        runtimeVersion: process.version,
        platform: `${platform()}-${arch()}`,
        logicalCpus: cpuList.length,
        cpu: cpuList[0]?.model ?? "unavailable",
        adapter: null,
      }),
      cases: this.#cases,
      sampleLimit: parsePositiveInteger(process.env.JSIMD_VITEST_SAMPLE_LIMIT ?? "20"),
    });
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  }
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError("JSIMD_VITEST_SAMPLE_LIMIT must be a positive integer");
  }
  return parsed;
}
