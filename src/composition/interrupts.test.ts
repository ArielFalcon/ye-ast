import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EXIT_CODE } from "../cli/main.ts";
import { watchInterrupts } from "./interrupts.ts";

const SIGNAL_EXIT = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const;

test("SIGINT and SIGTERM abort the signal, and an interrupted run exits with 128 plus the signal number", () => {
  for (const [name, exitCode] of SIGNAL_EXIT) {
    const source = new EventEmitter();
    const watch = watchInterrupts(source);
    assert.equal(watch.signal.aborted, false, name);

    source.emit(name);

    assert.equal(watch.signal.aborted, true, name);
    assert.equal(watch.exitCode(EXIT_CODE.interrupted), exitCode, name);
  }
});

test("without an interrupt the exit code is the run's own, and a run that finished before the signal keeps its code", () => {
  const source = new EventEmitter();
  const watch = watchInterrupts(source);
  assert.equal(watch.exitCode(EXIT_CODE.queryFailed), EXIT_CODE.queryFailed);

  source.emit("SIGTERM");

  assert.equal(watch.exitCode(EXIT_CODE.ok), EXIT_CODE.ok);
});

test("a repeated signal is still handled, so it cannot kill the process while the export is removed", () => {
  for (const [name] of SIGNAL_EXIT) {
    const source = new EventEmitter();
    watchInterrupts(source);

    source.emit(name);

    assert.equal(source.listenerCount(name), 1, name);
  }
});

test("the first signal decides the exit code", () => {
  const source = new EventEmitter();
  const watch = watchInterrupts(source);

  source.emit("SIGTERM");
  source.emit("SIGINT");

  assert.equal(watch.exitCode(EXIT_CODE.interrupted), 143);
});
