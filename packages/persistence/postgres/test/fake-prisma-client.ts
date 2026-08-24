import type {
  PrismaRuntimeClient,
  PrismaTransactionClient,
} from "../src/prisma-client-protocol.js";

type Arguments = Readonly<Record<string, unknown>>;
type Row = Record<string, unknown>;

interface FakeState {
  sessions: Map<string, Row>;
  contexts: Map<string, Row>;
  messages: Map<string, Row>;
  turns: Map<string, Row>;
  summaries: Map<string, Row>;
  bindings: Map<string, Row>;
}

const initialState = (): FakeState => ({
  sessions: new Map(),
  contexts: new Map(),
  messages: new Map(),
  turns: new Map(),
  summaries: new Map(),
  bindings: new Map(),
});

const record = (value: unknown, label: string): Row => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Row;
};

const stringField = (value: unknown, label: string): string => {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }
  return value;
};

const whereFrom = (arguments_: Arguments): Row =>
  record(arguments_["where"], "where");

const dataFrom = (arguments_: Arguments): Row =>
  record(arguments_["data"], "data");

const bindingKey = (sessionId: string, provider: string, providerKey: string): string =>
  `${sessionId}\u0000${provider}\u0000${providerKey}`;

const prismaError = (code: string): Error & { code: string } =>
  Object.assign(new Error(`Fake Prisma error ${code}`), { code });

const rowsForSession = (rows: Map<string, Row>, sessionId: string): Row[] =>
  [...rows.values()].filter((row) => row["sessionId"] === sessionId);

const orderedMessages = (rows: readonly Row[]): Row[] =>
  [...rows].sort((left, right) => {
    const leftDate = (left["createdAt"] as Date).getTime();
    const rightDate = (right["createdAt"] as Date).getTime();
    if (leftDate !== rightDate) {
      return leftDate - rightDate;
    }
    return String(left["id"]).localeCompare(String(right["id"]));
  });

export class FakePrismaClient implements PrismaRuntimeClient {
  private state: FakeState = initialState();
  private readonly failures = new Map<string, unknown>();
  private transactionTail: Promise<void> = Promise.resolve();

  readonly session = this.rootDelegates().session;
  readonly contextState = this.rootDelegates().contextState;
  readonly message = this.rootDelegates().message;
  readonly turn = this.rootDelegates().turn;
  readonly providerBinding = this.rootDelegates().providerBinding;
  readonly conversationSummary = this.rootDelegates().conversationSummary;

  async $transaction<Result>(
    callback: (transaction: PrismaTransactionClient) => Promise<Result>,
  ): Promise<Result> {
    const previous = this.transactionTail;
    let release: (() => void) | undefined;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.consumeFailure("$transaction");
      const working = structuredClone(this.state);
      const result = await callback(this.delegatesFor(working));
      this.state = working;
      return result;
    } finally {
      release?.();
    }
  }

  $disconnect(): Promise<void> {
    return Promise.resolve();
  }

  failNext(operation: string, error: unknown): void {
    this.failures.set(operation, error);
  }

  inspect(): {
    sessions: number;
    messages: number;
    turns: readonly Row[];
    bindings: number;
    summaries: number;
  } {
    return {
      sessions: this.state.sessions.size,
      messages: this.state.messages.size,
      turns: structuredClone([...this.state.turns.values()]),
      bindings: this.state.bindings.size,
      summaries: this.state.summaries.size,
    };
  }

  private rootDelegates(): PrismaTransactionClient {
    const operation = <Result>(callback: (state: FakeState) => Result): Result =>
      callback(this.state);
    return this.delegatesFor(undefined, operation);
  }

  private delegatesFor(
    fixedState?: FakeState,
    withRootState?: <Result>(callback: (state: FakeState) => Result) => Result,
  ): PrismaTransactionClient {
    const useState = <Result>(callback: (state: FakeState) => Result): Result => {
      if (fixedState !== undefined) {
        return callback(fixedState);
      }
      if (withRootState === undefined) {
        throw new Error("Fake state is unavailable.");
      }
      return withRootState(callback);
    };

    return {
      session: {
        findUnique: (arguments_) => {
          this.consumeFailure("session.findUnique");
          const id = stringField(whereFrom(arguments_)["id"], "session id");
          const includeValue = arguments_["include"];
          const activeMessagesOnly =
            includeValue !== undefined &&
            record(
              record(includeValue, "include")["messages"],
              "messages include",
            )["where"] !== undefined;
          return Promise.resolve(
            useState((state) => {
              const session = state.sessions.get(id);
              if (session === undefined) {
                return null;
              }
              return structuredClone({
                ...session,
                contextState: state.contexts.get(id) ?? null,
                messages: orderedMessages(
                  rowsForSession(state.messages, id).filter(
                    (message) =>
                      !activeMessagesOnly || message["compactedAt"] == null,
                  ),
                ),
                conversationSummary: state.summaries.get(id) ?? null,
                providerBindings: rowsForSession(state.bindings, id),
              });
            }),
          );
        },
        create: (arguments_) => {
          this.consumeFailure("session.create");
          const data = structuredClone(dataFrom(arguments_));
          const id = stringField(data["id"], "session id");
          return Promise.resolve(
            useState((state) => {
              if (state.sessions.has(id)) {
                throw prismaError("P2002");
              }
              state.sessions.set(id, data);
              return structuredClone(data);
            }),
          );
        },
        update: (arguments_) => {
          this.consumeFailure("session.update");
          const id = stringField(whereFrom(arguments_)["id"], "session id");
          const data = structuredClone(dataFrom(arguments_));
          return Promise.resolve(
            useState((state) => {
              const current = state.sessions.get(id);
              if (current === undefined) {
                throw prismaError("P2025");
              }
              const next = { ...current, ...data };
              state.sessions.set(id, next);
              return structuredClone(next);
            }),
          );
        },
      },
      contextState: {
        create: (arguments_) => {
          this.consumeFailure("contextState.create");
          const data = structuredClone(dataFrom(arguments_));
          const sessionId = stringField(data["sessionId"], "session id");
          return Promise.resolve(
            useState((state) => {
              if (state.contexts.has(sessionId)) {
                throw prismaError("P2002");
              }
              state.contexts.set(sessionId, data);
              return structuredClone(data);
            }),
          );
        },
        updateMany: (arguments_) => {
          this.consumeFailure("contextState.updateMany");
          const where = whereFrom(arguments_);
          const data = structuredClone(dataFrom(arguments_));
          const sessionId = stringField(where["sessionId"], "session id");
          return Promise.resolve(
            useState((state) => {
              const current = state.contexts.get(sessionId);
              if (
                current === undefined ||
                (where["revision"] !== undefined &&
                  current["revision"] !== where["revision"])
              ) {
                return { count: 0 };
              }
              state.contexts.set(sessionId, { ...current, ...data });
              return { count: 1 };
            }),
          );
        },
      },
      message: {
        createMany: (arguments_) => {
          this.consumeFailure("message.createMany");
          const data = arguments_["data"];
          if (!Array.isArray(data)) {
            throw new TypeError("message data must be an array");
          }
          const rows = structuredClone(data).map((entry) => record(entry, "message"));
          return Promise.resolve(
            useState((state) => {
              for (const row of rows) {
                const id = stringField(row["id"], "message id");
                const sessionId = stringField(row["sessionId"], "session id");
                if (state.messages.has(id)) {
                  throw prismaError("P2002");
                }
                if (!state.sessions.has(sessionId)) {
                  throw prismaError("P2003");
                }
              }
              for (const row of rows) {
                state.messages.set(stringField(row["id"], "message id"), row);
              }
              return { count: rows.length };
            }),
          );
        },
        deleteMany: (arguments_) => {
          this.consumeFailure("message.deleteMany");
          const sessionId = stringField(
            whereFrom(arguments_)["sessionId"],
            "session id",
          );
          return Promise.resolve(
            useState((state) => {
              let count = 0;
              for (const [id, row] of state.messages) {
                if (row["sessionId"] === sessionId) {
                  state.messages.delete(id);
                  count += 1;
                }
              }
              return { count };
            }),
          );
        },
        findMany: (arguments_) => {
          this.consumeFailure("message.findMany");
          const where = whereFrom(arguments_);
          const sessionId = stringField(where["sessionId"], "session id");
          const idFilter = where["id"];
          const ids =
            idFilter === undefined
              ? undefined
              : new Set(
                  record(idFilter, "id filter")["in"] as readonly string[],
                );
          return Promise.resolve(
            useState((state) =>
              structuredClone(
                orderedMessages(
                  rowsForSession(state.messages, sessionId).filter(
                    (row) => ids === undefined || ids.has(String(row["id"])),
                  ),
                ),
              ),
            ),
          );
        },
        updateMany: (arguments_) => {
          this.consumeFailure("message.updateMany");
          const where = whereFrom(arguments_);
          const data = structuredClone(dataFrom(arguments_));
          const sessionId = stringField(where["sessionId"], "session id");
          const ids = new Set(
            record(where["id"], "id filter")["in"] as readonly string[],
          );
          const compactedAt = where["compactedAt"];
          return Promise.resolve(
            useState((state) => {
              let count = 0;
              for (const [id, row] of state.messages) {
                if (
                  row["sessionId"] === sessionId &&
                  ids.has(id) &&
                  (compactedAt === undefined ||
                    (compactedAt === null && row["compactedAt"] == null))
                ) {
                  state.messages.set(id, { ...row, ...data });
                  count += 1;
                }
              }
              return { count };
            }),
          );
        },
      },
      turn: {
        create: (arguments_) => {
          this.consumeFailure("turn.create");
          const data = structuredClone(dataFrom(arguments_));
          const turnId = stringField(data["turnId"], "turn id");
          return Promise.resolve(
            useState((state) => {
              if (
                state.turns.has(turnId) ||
                [...state.turns.values()].some(
                  (row) => row["traceId"] === data["traceId"],
                )
              ) {
                throw prismaError("P2002");
              }
              state.turns.set(turnId, data);
              return structuredClone(data);
            }),
          );
        },
      },
      providerBinding: {
        deleteMany: (arguments_) => {
          this.consumeFailure("providerBinding.deleteMany");
          const sessionId = stringField(
            whereFrom(arguments_)["sessionId"],
            "session id",
          );
          return Promise.resolve(
            useState((state) => {
              let count = 0;
              for (const [key, row] of state.bindings) {
                if (row["sessionId"] === sessionId) {
                  state.bindings.delete(key);
                  count += 1;
                }
              }
              return { count };
            }),
          );
        },
        upsert: (arguments_) => {
          this.consumeFailure("providerBinding.upsert");
          const where = record(
            whereFrom(arguments_)["sessionId_provider_providerKey"],
            "binding key",
          );
          const sessionId = stringField(where["sessionId"], "session id");
          const provider = stringField(where["provider"], "provider");
          const providerKey = stringField(where["providerKey"], "provider key");
          const key = bindingKey(sessionId, provider, providerKey);
          return Promise.resolve(
            useState((state) => {
              const current = state.bindings.get(key);
              const next =
                current === undefined
                  ? structuredClone(record(arguments_["create"], "create"))
                  : {
                      ...current,
                      ...structuredClone(record(arguments_["update"], "update")),
                    };
              state.bindings.set(key, next);
              return structuredClone(next);
            }),
          );
        },
      },
      conversationSummary: {
        deleteMany: (arguments_) => {
          this.consumeFailure("conversationSummary.deleteMany");
          const sessionId = stringField(
            whereFrom(arguments_)["sessionId"],
            "session id",
          );
          return Promise.resolve(
            useState((state) => ({ count: state.summaries.delete(sessionId) ? 1 : 0 })),
          );
        },
        upsert: (arguments_) => {
          this.consumeFailure("conversationSummary.upsert");
          const sessionId = stringField(
            whereFrom(arguments_)["sessionId"],
            "session id",
          );
          return Promise.resolve(
            useState((state) => {
              const current = state.summaries.get(sessionId);
              const next =
                current === undefined
                  ? structuredClone(record(arguments_["create"], "create"))
                  : {
                      ...current,
                      ...structuredClone(record(arguments_["update"], "update")),
                    };
              state.summaries.set(sessionId, next);
              return structuredClone(next);
            }),
          );
        },
      },
    };
  }

  private consumeFailure(operation: string): void {
    if (!this.failures.has(operation)) {
      return;
    }
    const error = this.failures.get(operation);
    this.failures.delete(operation);
    throw error;
  }
}
