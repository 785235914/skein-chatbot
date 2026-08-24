import { createDifyInvalidResponseError } from "./errors.js";

const MAX_SSE_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_SSE_FRAME_BYTES = 1024 * 1024;

interface ExtractedLine {
  line: string;
  rest: string;
}

const extractLine = (buffer: string, final: boolean): ExtractedLine | null => {
  for (let index = 0; index < buffer.length; index += 1) {
    const character = buffer[index];
    if (character !== "\n" && character !== "\r") {
      continue;
    }
    if (character === "\r" && index === buffer.length - 1 && !final) {
      return null;
    }
    const terminatorLength =
      character === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
    return {
      line: buffer.slice(0, index),
      rest: buffer.slice(index + terminatorLength),
    };
  }
  if (final && buffer.length > 0) {
    return { line: buffer, rest: "" };
  }
  return null;
};

/** Incrementally parses SSE data fields without interpreting provider JSON. */
export async function* parseDifySseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let dataLines: string[] = [];
  let dataBytes = 0;
  let firstLine = true;
  let completed = false;
  const decode = (chunk?: Uint8Array, stream = false): string => {
    try {
      return chunk === undefined
        ? decoder.decode()
        : decoder.decode(chunk, { stream });
    } catch {
      throw createDifyInvalidResponseError();
    }
  };

  const consumeLine = (rawLine: string): string | undefined => {
    const line = firstLine ? rawLine.replace(/^\uFEFF/u, "") : rawLine;
    firstLine = false;
    if (line.length === 0) {
      if (dataLines.length === 0) {
        return undefined;
      }
      const data = dataLines.join("\n");
      dataLines = [];
      dataBytes = 0;
      return data;
    }
    if (line.startsWith(":")) {
      return undefined;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== "data") {
      return undefined;
    }
    let fieldValue = colon < 0 ? "" : line.slice(colon + 1);
    if (fieldValue.startsWith(" ")) {
      fieldValue = fieldValue.slice(1);
    }
    dataBytes += Buffer.byteLength(fieldValue, "utf8") + 1;
    if (dataBytes > MAX_SSE_FRAME_BYTES) {
      throw createDifyInvalidResponseError();
    }
    dataLines.push(fieldValue);
    return undefined;
  };

  try {
    while (true) {
      if (signal?.aborted === true) {
        throw signal.reason;
      }
      const next = await reader.read();
      if (next.done) {
        completed = true;
        buffer += decode();
      } else {
        buffer += decode(next.value, true);
      }
      if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_BUFFER_BYTES) {
        throw createDifyInvalidResponseError();
      }

      while (true) {
        const extracted = extractLine(buffer, completed);
        if (extracted === null) {
          break;
        }
        buffer = extracted.rest;
        const eventData = consumeLine(extracted.line);
        if (eventData !== undefined) {
          yield eventData;
        }
      }
      if (completed) {
        if (dataLines.length > 0) {
          const eventData = consumeLine("");
          if (eventData !== undefined) {
            yield eventData;
          }
        }
        return;
      }
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}
