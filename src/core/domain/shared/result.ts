export type Result<T, F> = { ok: true; value: T } | { ok: false; fault: F };
