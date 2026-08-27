import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { PageBackend } from "./backend.ts";
import { validateKey, validatePrefix } from "./backend.ts";

/** Node 24-compatible filesystem backend with atomic manifest replacement. */
export class NodeFsPageBackend implements PageBackend {
  readonly #root: string;

  constructor(root: string) {
    if (root.length === 0) throw new RangeError("filesystem root must not be empty");
    this.#root = resolve(root);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const path = this.#path(key);
    try {
      const value = await readFile(path);
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    if (!(value instanceof Uint8Array)) throw new TypeError("page value must be a Uint8Array");
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${crypto.randomUUID()}`;
    try {
      await writeFile(temporary, value);
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }

  async list(prefix: string): Promise<readonly string[]> {
    validatePrefix(prefix);
    const output: string[] = [];
    await this.#collect(this.#root, output);
    return output.filter((key) => key.startsWith(prefix)).sort();
  }

  async #collect(directory: string, output: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await this.#collect(path, output);
      else if (entry.isFile() && !entry.name.includes(".tmp-")) {
        output.push(relative(this.#root, path).split(sep).join("/"));
      }
    }
  }

  #path(key: string): string {
    validateKey(key);
    const path = resolve(this.#root, ...key.split("/"));
    if (path !== this.#root && !path.startsWith(`${this.#root}${sep}`)) {
      throw new RangeError("page key escapes filesystem root");
    }
    return path;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
