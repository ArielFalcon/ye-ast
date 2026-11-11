export interface HolderRow {
  name: string;
  module?: string;
  callback?: boolean;
  binds: { kind: "argument"; index: number } | { kind: "receiver" };
  read: { kind: "same" } | { kind: "member"; name: string } | { kind: "controls" };
}

export const HOLDER_ROWS: readonly HolderRow[] = [
  { name: "signal", module: "@angular/core", binds: { kind: "argument", index: 0 }, read: { kind: "same" } },
  { name: "set", binds: { kind: "argument", index: 0 }, read: { kind: "same" } },
  { name: "next", binds: { kind: "argument", index: 0 }, read: { kind: "same" } },
  { name: "computed", module: "@angular/core", callback: true, binds: { kind: "argument", index: 0 }, read: { kind: "same" } },
  { name: "linkedSignal", module: "@angular/core", callback: true, binds: { kind: "argument", index: 0 }, read: { kind: "same" } },
  { name: "asReadonly", binds: { kind: "receiver" }, read: { kind: "same" } },
  { name: "resource", module: "@angular/core", binds: { kind: "argument", index: 0 }, read: { kind: "member", name: "value" } },
  { name: "rxResource", module: "@angular/core", binds: { kind: "argument", index: 0 }, read: { kind: "member", name: "value" } },
  { name: "patchValue", binds: { kind: "argument", index: 0 }, read: { kind: "controls" } },
  { name: "setValue", binds: { kind: "argument", index: 0 }, read: { kind: "controls" } },
  { name: "reset", binds: { kind: "argument", index: 0 }, read: { kind: "controls" } },
];
