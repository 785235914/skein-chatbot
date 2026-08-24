import type { FastifyReply, FastifyRequest } from "fastify";

export interface RequestAbortContext {
  dispose(): void;
  signal: AbortSignal;
}

/** Propagates transport cancellation without treating a normal response close as an abort. */
export const createRequestAbortContext = (
  request: FastifyRequest,
  reply: FastifyReply,
): RequestAbortContext => {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  const onRequestAborted = (): void => {
    abort();
  };
  const onRequestClose = (): void => {
    if (request.raw.aborted || !request.raw.complete) {
      abort();
    }
  };
  const onResponseClose = (): void => {
    if (!reply.raw.writableEnded) {
      abort();
    }
  };

  request.raw.once("aborted", onRequestAborted);
  request.raw.once("close", onRequestClose);
  reply.raw.once("close", onResponseClose);

  return {
    signal: controller.signal,
    dispose: () => {
      request.raw.removeListener("aborted", onRequestAborted);
      request.raw.removeListener("close", onRequestClose);
      reply.raw.removeListener("close", onResponseClose);
    },
  };
};
