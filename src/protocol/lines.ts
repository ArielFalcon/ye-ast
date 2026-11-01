import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export interface LineReader {
  /** Settles when the input ended or closed, or `stop` was called. */
  done: Promise<void>;
  stop(): void;
}

/** Hands each UTF-8 line of `input` to `onLine`, splitting on "\n" only: a U+2028 or a lone "\r" inside a JSON string is not a frame boundary. */
export function readLines(input: Readable, onLine: (line: string) => void): LineReader {
  const decoder = new StringDecoder("utf8");
  let rest = "";
  let stop: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    const onData = (chunk: Buffer | string): void => {
      const lines = (rest + decoder.write(chunk as Buffer)).split("\n");
      rest = lines.pop()!;
      lines.forEach(onLine);
    };
    const onEnd = (): void => {
      rest += decoder.end();
      if (rest !== "") onLine(rest);
      stop();
    };
    stop = (): void => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("close", stop);
      input.pause();
      resolve();
    };
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("close", stop);
  });
  return { done, stop: () => stop() };
}
