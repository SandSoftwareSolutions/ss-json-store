import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { openStore } from "./src/index.js";

const dir = mkdtempSync(join(tmpdir(), "json-store-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name) => join(dir, name);

test("a new store starts from the defaults and is written at once", async () => {
  const store = await openStore({ path: file("a/settings.json"), defaults: { theme: "dark", count: 0 } });
  assert.deepEqual(store.get(), { theme: "dark", count: 0 });
  assert.deepEqual(JSON.parse(readFileSync(file("a/settings.json"), "utf8")), { version: 1, data: { theme: "dark", count: 0 } });
});

test("update changes in place or returns a new value, and survives a reopen", async () => {
  const path = file("b.json");
  const store = await openStore({ path, defaults: { count: 0 } });
  await store.update((d) => { d.count += 1; });
  assert.deepEqual(await store.update((d) => ({ ...d, extra: true })), { count: 1, extra: true });
  assert.deepEqual((await openStore({ path })).get(), { count: 1, extra: true });
});

test("get returns a copy", async () => {
  const store = await openStore({ path: file("c.json"), defaults: { list: [1] } });
  store.get().list.push(2);
  assert.deepEqual(store.get(), { list: [1] });
});

test("quick updates are applied one after the other and none is lost", async () => {
  const store = await openStore({ path: file("d.json"), defaults: { n: 0 } });
  await Promise.all(Array.from({ length: 50 }, () => store.update(async (d) => { const n = d.n; await new Promise((r) => setImmediate(r)); d.n = n + 1; })));
  assert.equal(store.get().n, 50);
  assert.equal(JSON.parse(readFileSync(file("d.json"), "utf8")).data.n, 50);
});

test("an update that throws changes nothing, and later updates still work", async () => {
  const store = await openStore({ path: file("e.json"), defaults: { n: 1 } });
  await assert.rejects(store.update((d) => { d.n = 99; throw new Error("no"); }), /no/);
  assert.equal(store.get().n, 1);
  await store.update((d) => { d.n = 2; });
  assert.equal(store.get().n, 2);
});

test("set replaces everything", async () => {
  const store = await openStore({ path: file("f.json"), defaults: { a: 1 } });
  await store.set({ b: 2 });
  assert.deepEqual(store.get(), { b: 2 });
});

test("migrations upgrade old files, and keep the old file as a backup", async () => {
  const path = file("g.json");
  writeFileSync(path, JSON.stringify({ version: 1, data: { name: "Kaj Van" } }));
  const store = await openStore({
    path, version: 3, defaults: {},
    migrations: { 2: (d) => ({ first: d.name.split(" ")[0], last: d.name.split(" ").slice(1).join(" ") }), 3: (d) => ({ ...d, tags: [] }) }
  });
  assert.deepEqual(store.get(), { first: "Kaj", last: "Van", tags: [] });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 3);
  assert.deepEqual(JSON.parse(readFileSync(`${path}.v1.bak`, "utf8")), { version: 1, data: { name: "Kaj Van" } });
});

test("a missing migration is a programming error found at startup", async () => {
  await assert.rejects(openStore({ path: file("h.json"), version: 2 }), /missing migration for version 2/);
});

test("a file from a newer version, a corrupt file and a foreign file are refused and never overwritten", async () => {
  const cases = [
    ["newer.json", JSON.stringify({ version: 9, data: {} }), /newer than this program/],
    ["corrupt.json", "{broken", /not valid JSON/],
    ["foreign.json", JSON.stringify({ hello: "world" }), /not a store file/]
  ];
  for (const [name, content, pattern] of cases) {
    writeFileSync(file(name), content);
    await assert.rejects(openStore({ path: file(name), defaults: {} }), pattern, name);
    assert.equal(readFileSync(file(name), "utf8"), content, `${name} must stay as it was`);
  }
});

test("backup keeps the previous version on every write", async () => {
  const path = file("i.json");
  const store = await openStore({ path, defaults: { n: 0 }, backup: true });
  await store.update((d) => { d.n = 1; });
  await store.update((d) => { d.n = 2; });
  assert.equal(JSON.parse(readFileSync(`${path}.bak`, "utf8")).data.n, 1);
});

test("no temporary files stay behind, and a new file is private", { skip: process.platform === "win32" }, async () => {
  const path = file("j/state.json");
  const store = await openStore({ path, defaults: {} });
  await store.update((d) => { d.x = 1; });
  assert.deepEqual(readdirSync(file("j")), ["state.json"]);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("bad options", async () => {
  await assert.rejects(openStore({}), TypeError);
  await assert.rejects(openStore({ path: file("k.json"), version: 0 }), RangeError);
  assert.equal(existsSync(file("k.json")), false);
});
