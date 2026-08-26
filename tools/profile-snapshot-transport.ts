import { BinaryVectorIndex } from "../src/binary-vector-index/mod.ts";

const dimensions = 256;
const count = 8_192;
const values = Float32Array.from(
  { length: count * dimensions },
  (_, index) => ((Math.imul(index, 17) % 101) - 50) / 50,
);
const snapshot = (() => {
  using index = BinaryVectorIndex.fromFloat32(values, count, dimensions);
  return index.serialize();
})();

const results: Array<{ name: string; iterations: number; milliseconds: number }> = [];

results.push(
  await measure("structuredClone", 100, () => {
    const copy = structuredClone(snapshot);
    if (copy.byteLength !== snapshot.byteLength) throw new Error("structured clone failed");
  }),
);

const workerUrl = URL.createObjectURL(
  new Blob([
    "self.onmessage = (event) => self.postMessage(event.data.byteLength);",
  ], { type: "text/javascript" }),
);
const worker = new Worker(workerUrl, { type: "module" });
try {
  results.push(await measure("Worker postMessage round trip", 100, () => workerRoundTrip(worker)));
} finally {
  worker.terminate();
  URL.revokeObjectURL(workerUrl);
}

const directory = await Deno.makeTempDir({ prefix: "jsimd-snapshot-" });
try {
  const path = `${directory}/binary-vector.jsimd`;
  results.push(
    await measure("file write + read", 50, async () => {
      await Deno.writeFile(path, snapshot);
      const copy = await Deno.readFile(path);
      if (copy.byteLength !== snapshot.byteLength) throw new Error("file round trip failed");
    }),
  );
} finally {
  await Deno.remove(directory, { recursive: true });
}

if ("indexedDB" in globalThis) {
  const databaseName = `jsimd-snapshot-${crypto.randomUUID()}`;
  const database = await openDatabase(databaseName);
  try {
    results.push(
      await measure("IndexedDB put + get", 50, async () => {
        const write = database.transaction("snapshots", "readwrite");
        write.objectStore("snapshots").put(snapshot, "binary");
        await transactionComplete(write);
        const read = database.transaction("snapshots", "readonly");
        const copy = await requestResult<Uint8Array>(read.objectStore("snapshots").get("binary"));
        await transactionComplete(read);
        if (copy.byteLength !== snapshot.byteLength) throw new Error("IndexedDB round trip failed");
      }),
    );
  } finally {
    database.close();
    indexedDB.deleteDatabase(databaseName);
  }
} else {
  const result = await measureIndexedDbInChrome(snapshot.byteLength, 50);
  if (result !== undefined) results.push(result);
}

console.log(`Snapshot: ${snapshot.byteLength} bytes`);
console.log("| transport | mean time | throughput |");
console.log("| :-- | --: | --: |");
for (const result of results) {
  const mean = result.milliseconds / result.iterations;
  const mibPerSecond = snapshot.byteLength / (1024 * 1024) / (mean / 1000);
  console.log(`| ${result.name} | ${mean.toFixed(3)} ms | ${mibPerSecond.toFixed(1)} MiB/s |`);
}

async function measure(
  name: string,
  iterations: number,
  operation: () => void | Promise<void>,
): Promise<{ name: string; iterations: number; milliseconds: number }> {
  for (let index = 0; index < 5; index++) await operation();
  const start = performance.now();
  for (let index = 0; index < iterations; index++) await operation();
  return { name, iterations, milliseconds: performance.now() - start };
}

function workerRoundTrip(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<number>) => {
      if (event.data !== snapshot.byteLength) reject(new Error("Worker round trip failed"));
      else resolve();
    };
    worker.onerror = (event) => reject(event.error ?? new Error(event.message));
    worker.postMessage(snapshot);
  });
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("snapshots");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("transaction aborted"));
  });
}

async function measureIndexedDbInChrome(
  byteLength: number,
  iterations: number,
): Promise<{ name: string; iterations: number; milliseconds: number } | undefined> {
  const candidates = [
    Deno.env.get("CHROME_BIN"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter((value): value is string => value !== undefined);
  let executable: string | undefined;
  for (const candidate of candidates) {
    try {
      if ((await Deno.stat(candidate)).isFile) {
        executable = candidate;
        break;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  if (executable === undefined) return undefined;

  const directory = await Deno.makeTempDir({ prefix: "jsimd-indexeddb-" });
  try {
    let reportResult: ((value: { milliseconds: number }) => void) | undefined;
    const report = new Promise<{ milliseconds: number }>((resolve) => {
      reportResult = resolve;
    });
    let reportPort: ((value: number) => void) | undefined;
    const listening = new Promise<number>((resolve) => {
      reportPort = resolve;
    });
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen: ({ port }) => reportPort?.(port),
    }, async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/result" && request.method === "POST") {
        reportResult?.(await request.json() as { milliseconds: number });
        return new Response("ok");
      }
      return new Response(indexedDbProfileHtml(byteLength, iterations), {
        headers: { "content-type": "text/html" },
      });
    });
    const port = await listening;
    const child = new Deno.Command(executable, {
      args: [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${directory}/profile`,
        `http://127.0.0.1:${port}`,
      ],
      stdout: "null",
      stderr: "null",
    }).spawn();
    let timeoutId: number | undefined;
    try {
      const value = await Promise.race([
        report,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("headless Chrome IndexedDB profile timed out")),
            30_000,
          );
        }),
      ]);
      return { name: "IndexedDB put + get", iterations, milliseconds: value.milliseconds };
    } finally {
      clearTimeout(timeoutId);
      child.kill("SIGTERM");
      await child.status;
      await server.shutdown();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

function indexedDbProfileHtml(byteLength: number, iterations: number): string {
  return `<!doctype html><body>pending<script type="module">
const bytes = new Uint8Array(${byteLength});
const iterations = ${iterations};
const report = value => fetch("/result", { method: "POST", body: JSON.stringify(value) });
const request = indexedDB.open("jsimd-profile", 1);
request.onupgradeneeded = () => request.result.createObjectStore("snapshots");
request.onerror = () => report({ error: String(request.error) });
request.onsuccess = async () => {
  const database = request.result;
  const transactionDone = transaction => new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  const requestDone = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const roundTrip = async () => {
    const write = database.transaction("snapshots", "readwrite");
    write.objectStore("snapshots").put(bytes, "binary");
    await transactionDone(write);
    const read = database.transaction("snapshots", "readonly");
    const copy = await requestDone(read.objectStore("snapshots").get("binary"));
    await transactionDone(read);
    if (copy.byteLength !== bytes.byteLength) throw new Error("incorrect byte length");
  };
  for (let index = 0; index < 5; index++) await roundTrip();
  const start = performance.now();
  for (let index = 0; index < iterations; index++) await roundTrip();
  await report({ milliseconds: performance.now() - start });
  database.close();
};
</script>`;
}
