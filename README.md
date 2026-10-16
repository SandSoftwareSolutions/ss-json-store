# @sandsoftwaresolutions/json-store

[![CI](https://github.com/SandSoftwareSolutions/ss-json-store/actions/workflows/ci.yml/badge.svg)](https://github.com/SandSoftwareSolutions/ss-json-store/actions/workflows/ci.yml)

A small database for the things that do not need a database: settings, state, a few records, in one JSON file. Safe writes, updates that never get lost, and migrations when the shape changes. No dependencies.

## Install

```bash
npm install @sandsoftwaresolutions/json-store
```

## Usage

```js
import { openStore } from "@sandsoftwaresolutions/json-store";

const store = await openStore({
  path: "/var/lib/myapp/state.json",
  defaults: { lastRun: 0, failures: 0 }
});

store.get();                                   // { lastRun: 0, failures: 0 } (a copy)
await store.update((state) => { state.failures += 1; });   // change in place...
await store.update((state) => ({ ...state, lastRun: Date.now() })); // ...or return a new value
await store.set({ lastRun: 0, failures: 0 });  // replace everything
```

## What it takes care of

- **Atomic writes.** The file is written to a temporary file, flushed, and renamed over the old one, so a crash or power cut never leaves half a file.
- **No lost updates.** Updates run one after the other, in order, even when the callbacks are async. Fifty `update` calls at the same time give fifty changes.
- **Rollback.** If your callback throws or the write fails, the data stays as it was.
- **Copies, not references.** `get()` returns a copy, so changing it by accident changes nothing.
- **A private file.** A new file is created with permissions `600`, because stores tend to hold tokens.
- **It refuses to destroy what it does not understand.** A corrupt file, a file that is not a store, or a file from a newer version of your program is *never* overwritten: you get an error that names the file.

## Migrations

The file is `{ "version": 1, "data": { ... } }`. When the shape of your data changes, raise `version` and add a migration:

```js
const store = await openStore({
  path, version: 3, defaults: { first: "", last: "", tags: [] },
  migrations: {
    2: (old) => ({ first: old.name.split(" ")[0], last: old.name.split(" ").slice(1).join(" ") }),
    3: (old) => ({ ...old, tags: [] })
  }
});
```

Each migration upgrades from the version before it. The old file is kept as `<path>.v1.bak` before the first write of the new shape. A missing migration is an error at startup. `backup: true` also keeps `<path>.bak` of the previous content on every write.

## Not for everything

The whole file is read once and written on every change. That is fine for kilobytes, not for megabytes or heavy traffic; for that use SQLite (`@sandsoftwaresolutions/sqlite-kit`). One process should own the file; for several, add `@sandsoftwaresolutions/file-lock`.
