export interface StoreOptions<T> {
  path: string;
  /** The starting value for a new store. Default {}. */
  defaults?: T;
  /** Current version of the data's shape. Default 1. */
  version?: number;
  /** `{ 2: (old) => new, 3: ... }`: each upgrades the data from the version before it. */
  migrations?: Record<number, (data: any) => any | Promise<any>>;
  /** Keep `<path>.bak` of the previous file on every write. */
  backup?: boolean;
}

export interface Store<T> {
  /** A copy: changing it changes nothing. */
  get(): T;
  /** Change `draft` in place, or return a new value. Runs after earlier updates. Rolls back if it throws or the write fails. */
  update(fn: (draft: T) => T | void | Promise<T | void>): Promise<T>;
  set(value: T): Promise<T>;
  readonly path: string;
}

export function openStore<T = Record<string, unknown>>(options: StoreOptions<T>): Promise<Store<T>>;
