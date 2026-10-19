import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// What goes into the file is JSON, so that is also what the store holds in memory: a Date is a string, undefined fields are gone,
// and what get() returns right after an update is exactly what a reopened store returns.
const plain = (value) => {
  const text = JSON.stringify(value);
  return text === undefined ? undefined : JSON.parse(text);
};

async function writeAtomic(path, text) {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  let mode = 0o600;
  let keep = false;
  try {
    mode = (await stat(path)).mode & 0o7777;
    keep = true;
  } catch {
    // New file: private by default, because stores often hold settings and tokens.
  }
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    if (keep && process.platform !== "win32") await handle.chmod(mode); // exactly as before, whatever the umask
    await handle.writeFile(text);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
  await handle.close();
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/**
 * A small store for one JSON file: settings, state, a few records. Writes are atomic (a crash never leaves half a file), changes
 * are applied one at a time in order (so two quick updates do not lose one), and the file has a version number so you can change
 * its shape later with migrations.
 *
 * Options: `path`, `defaults` (value for a new store; the starting point), `version` (current version, default 1),
 * `migrations` ({ 2: (data) => newData, 3: ... } each upgrades from the version before it), `backup` (keep `<path>.bak` of the
 * previous file on every write, default false).
 * The file looks like `{ "version": 1, "data": { ... } }`.
 */
export async function openStore({ path, defaults = {}, version = 1, migrations = {}, backup = false } = {}) {
  if (typeof path !== "string" || path === "") throw new TypeError("json-store: path is required");
  if (!Number.isInteger(version) || version < 1) throw new RangeError("json-store: version must be a whole number, 1 or more");
  for (let v = 2; v <= version; v++) {
    if (typeof migrations[v] !== "function") throw new TypeError(`json-store: missing migration for version ${v}`);
  }
  await mkdir(dirname(path), { recursive: true });

  let data;
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    // Only a missing file starts a new store. Anything that goes wrong after this point (a failing migration, a failing write)
    // must never be mistaken for a missing file, or the data in the file would be replaced by the defaults.
    if (error.code !== "ENOENT") throw error;
  }
  if (text !== undefined) {
    let file;
    try {
      file = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch (error) {
      throw new SyntaxError(`json-store: ${path} is not valid JSON (${error.message}). It was not touched; fix or remove it.`);
    }
    if (file === null || typeof file !== "object" || !Number.isInteger(file.version) || !("data" in file)) {
      throw new SyntaxError(`json-store: ${path} is not a store file (expected { version, data }). It was not touched.`);
    }
    if (file.version < 1) throw new RangeError(`json-store: ${path} has version ${file.version}; versions start at 1. It was not touched.`);
    if (file.version > version) throw new RangeError(`json-store: ${path} is version ${file.version}, newer than this program understands (${version}). It was not touched.`);
    data = file.data;
    for (let v = file.version + 1; v <= version; v++) data = plain(await migrations[v](structuredClone(data)));
    if (file.version < version) await persist(file.version);
  } else {
    data = plain(defaults);
    if (data === undefined) data = {};
    await persist();
  }

  let queue = Promise.resolve();
  async function persist(fromVersion) {
    if (backup || fromVersion !== undefined) {
      // Keep the old file before replacing it with a changed shape, and on every write when backup is on.
      try {
        const old = await readFile(path, "utf8");
        await writeAtomic(fromVersion !== undefined ? `${path}.v${fromVersion}.bak` : `${path}.bak`, old);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    await writeAtomic(path, `${JSON.stringify({ version, data }, null, 2)}\n`);
  }

  const api = {
    /** A copy of the current data. Changing the copy changes nothing; use `update`. */
    get: () => structuredClone(data),
    /**
     * Changes the data: `await store.update((d) => { d.count++; })` (change it in place) or return a new value.
     * Updates run one after the other. If `fn` throws or the write fails, the data stays as it was.
     */
    update(fn) {
      const run = queue.then(async () => {
        const draft = structuredClone(data);
        const result = await fn(draft);
        const before = data;
        data = result === undefined ? plain(draft) : plain(result);
        try {
          await persist();
        } catch (error) {
          data = before;
          throw error;
        }
        return structuredClone(data);
      });
      queue = run.catch(() => {});
      return run;
    },
    /** Replaces everything. */
    set: (value) => api.update(() => structuredClone(value)),
    path
  };
  return api;
}
