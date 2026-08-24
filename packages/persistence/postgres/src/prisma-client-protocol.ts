type PrismaArguments = Readonly<Record<string, unknown>>;

type PrismaOperation = (arguments_: PrismaArguments) => Promise<unknown>;

interface SessionDelegate {
  findUnique: PrismaOperation;
  create: PrismaOperation;
  update: PrismaOperation;
}

interface ContextStateDelegate {
  create: PrismaOperation;
  updateMany: PrismaOperation;
}

interface MessageDelegate {
  createMany: PrismaOperation;
  deleteMany: PrismaOperation;
  findMany: PrismaOperation;
  updateMany: PrismaOperation;
}

interface TurnDelegate {
  create: PrismaOperation;
}

interface ProviderBindingDelegate {
  deleteMany: PrismaOperation;
  upsert: PrismaOperation;
}

interface ConversationSummaryDelegate {
  deleteMany: PrismaOperation;
  upsert: PrismaOperation;
}

export interface PrismaTransactionClient {
  session: SessionDelegate;
  contextState: ContextStateDelegate;
  message: MessageDelegate;
  turn: TurnDelegate;
  providerBinding: ProviderBindingDelegate;
  conversationSummary: ConversationSummaryDelegate;
}

export interface PrismaRuntimeClient extends PrismaTransactionClient {
  $transaction<Result>(
    callback: (transaction: PrismaTransactionClient) => Promise<Result>,
  ): Promise<Result>;
  $disconnect(): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const hasMethods = (
  value: unknown,
  methods: readonly string[],
): value is Record<string, unknown> =>
  isRecord(value) && methods.every((method) => typeof value[method] === "function");

/**
 * Keeps the repository independent from generated Prisma types while still
 * rejecting a miswired client immediately at the composition boundary.
 */
export const assertPrismaRuntimeClient: (
  value: unknown,
) => asserts value is PrismaRuntimeClient = (value) => {
  if (
    !hasMethods(value, ["$transaction", "$disconnect"]) ||
    !hasMethods(value["session"], ["findUnique", "create", "update"]) ||
    !hasMethods(value["contextState"], ["create", "updateMany"]) ||
    !hasMethods(value["message"], [
      "createMany",
      "deleteMany",
      "findMany",
      "updateMany",
    ]) ||
    !hasMethods(value["turn"], ["create"]) ||
    !hasMethods(value["providerBinding"], ["deleteMany", "upsert"]) ||
    !hasMethods(value["conversationSummary"], ["deleteMany", "upsert"])
  ) {
    throw new TypeError("A compatible Prisma client is required.");
  }
};
