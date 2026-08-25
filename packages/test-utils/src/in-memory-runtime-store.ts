import {
  RuntimeError,
  RuntimeErrorCode,
  createDefaultSkeinContext,
  type CanonicalMessage,
  type CommitTurnCommand,
  type CommitTurnResult,
  type CompactionCommitCommand,
  type CompletedTurnRecord,
  type ConversationSummary,
  type FailedTurnCommand,
  type ProviderConversationBinding,
  type ResetSessionCommand,
  type RestoreSessionCommand,
  type RuntimeSession,
  type RuntimeStore,
  type SessionAggregate,
  validateRestoreSessionCommand,
} from "@skein-chatbot/core";

interface StoredSession {
  session: RuntimeSession;
  context: SessionAggregate["context"];
  messages: CanonicalMessage[];
  providerBindings: ProviderConversationBinding[];
  completedTurns: CompletedTurnRecord[];
  compactedMessageIds: string[];
  summary?: ConversationSummary;
}

const clone = <T>(value: T): T => structuredClone(value);

const conflict = (): RuntimeError =>
  new RuntimeError(
    RuntimeErrorCode.SESSION_CONFLICT,
    "The session revision did not match.",
  );

const invalidContext = (): RuntimeError =>
  new RuntimeError(
    RuntimeErrorCode.CONTEXT_INVALID,
    "The committed context is invalid.",
  );

const publicAggregate = (stored: StoredSession): SessionAggregate => {
  const compactedMessageIds = new Set(stored.compactedMessageIds);
  return {
    session: clone(stored.session),
    context: clone(stored.context),
    messages: clone(
      stored.messages.filter(
        (message) => !compactedMessageIds.has(message.id),
      ),
    ),
    providerBindings: clone(stored.providerBindings),
    ...(stored.summary === undefined
      ? {}
      : { summary: clone(stored.summary) }),
  };
};

export class InMemoryRuntimeStore implements RuntimeStore {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly failedTurns: FailedTurnCommand[] = [];

  loadSessionAggregate(sessionId: string): Promise<SessionAggregate | null> {
    const stored = this.sessions.get(sessionId);
    return Promise.resolve(stored === undefined ? null : publicAggregate(stored));
  }

  async restoreSession(command: RestoreSessionCommand): Promise<RuntimeSession> {
    validateRestoreSessionCommand(command);
    if (this.sessions.has(command.session.id)) {
      throw conflict();
    }
    const next: StoredSession = {
      session: clone(command.session),
      context: clone(command.context),
      messages: clone([...command.messages]),
      providerBindings: [clone(command.providerBinding)],
      completedTurns: [],
      compactedMessageIds: [],
    };
    this.sessions.set(command.session.id, next);
    return clone(next.session);
  }

  commitTurn(command: CommitTurnCommand): Promise<CommitTurnResult> {
    this.assertCommit(command);
    const current = this.sessions.get(command.sessionId);
    const providerBindings = clone(current?.providerBindings ?? []);
    if (command.providerBinding !== undefined) {
      const index = providerBindings.findIndex(
        (binding) =>
          binding.provider === command.providerBinding?.provider &&
          binding.providerKey === command.providerBinding?.providerKey,
      );
      if (index === -1) {
        providerBindings.push(clone(command.providerBinding));
      } else {
        providerBindings[index] = clone(command.providerBinding);
      }
    }

    const createdAt = current?.session.createdAt ?? command.turn.startedAt;
    const next: StoredSession = {
      session: {
        id: command.sessionId,
        userId: command.userId,
        status: "ACTIVE",
        revision: command.nextContext.revision,
        createdAt,
        updatedAt: command.turn.completedAt,
        lastActiveAt: command.turn.completedAt,
      },
      context: clone(command.nextContext),
      messages: [
        ...clone(current?.messages ?? []),
        clone(command.userMessage),
        clone(command.assistantMessage),
      ],
      providerBindings,
      completedTurns: [
        ...clone(current?.completedTurns ?? []),
        clone(command.turn),
      ],
      compactedMessageIds: clone(current?.compactedMessageIds ?? []),
      ...(current?.summary === undefined
        ? {}
        : { summary: clone(current.summary) }),
    };

    this.sessions.set(command.sessionId, next);
    return Promise.resolve({
      session: clone(next.session),
      context: clone(next.context),
    });
  }

  recordFailedTurn(command: FailedTurnCommand): Promise<void> {
    this.failedTurns.push(clone(command));
    return Promise.resolve();
  }

  resetSession(command: ResetSessionCommand): Promise<void> {
    const current = this.sessions.get(command.sessionId);
    if (
      current === undefined ||
      current.session.revision !== command.expectedRevision
    ) {
      return Promise.reject(conflict());
    }

    const nextRevision = current.session.revision + 1;
    const next: StoredSession = {
      session: {
        ...clone(current.session),
        status: "RESET",
        revision: nextRevision,
        updatedAt: command.resetAt,
        lastActiveAt: command.resetAt,
      },
      context: {
        ...createDefaultSkeinContext(nextRevision),
        runtime: { updatedAt: command.resetAt },
      },
      messages: [],
      providerBindings: [],
      completedTurns: clone(current.completedTurns),
      compactedMessageIds: [],
    };

    this.sessions.set(command.sessionId, next);
    return Promise.resolve();
  }

  commitCompaction(command: CompactionCommitCommand): Promise<void> {
    const current = this.sessions.get(command.sessionId);
    if (
      current === undefined ||
      current.session.revision !== command.expectedRevision
    ) {
      return Promise.reject(conflict());
    }
    const messageIds = new Set(current.messages.map((message) => message.id));
    if (command.compactedMessageIds.some((id) => !messageIds.has(id))) {
      return Promise.reject(invalidContext());
    }
    const compactedMessageIds = new Set(current.compactedMessageIds);
    if (command.compactedMessageIds.some((id) => compactedMessageIds.has(id))) {
      return Promise.reject(conflict());
    }

    const next: StoredSession = {
      ...clone(current),
      summary: clone(command.summary),
      compactedMessageIds: Array.from(
        new Set([
          ...current.compactedMessageIds,
          ...command.compactedMessageIds,
        ]),
      ),
    };
    this.sessions.set(command.sessionId, next);
    return Promise.resolve();
  }

  getSession(sessionId: string): Promise<RuntimeSession | null> {
    const session = this.sessions.get(sessionId)?.session;
    return Promise.resolve(session === undefined ? null : clone(session));
  }

  getMessages(sessionId: string): Promise<readonly CanonicalMessage[]> {
    return Promise.resolve(clone(this.sessions.get(sessionId)?.messages ?? []));
  }

  getFailedTurns(sessionId?: string): readonly FailedTurnCommand[] {
    return clone(
      sessionId === undefined
        ? this.failedTurns
        : this.failedTurns.filter((turn) => turn.sessionId === sessionId),
    );
  }

  getCompletedTurns(sessionId: string): readonly CompletedTurnRecord[] {
    return clone(this.sessions.get(sessionId)?.completedTurns ?? []);
  }

  private assertCommit(command: CommitTurnCommand): void {
    const current = this.sessions.get(command.sessionId);
    const currentRevision = current?.session.revision ?? 0;
    if (
      currentRevision !== command.expectedRevision ||
      (current !== undefined && current.session.userId !== command.userId)
    ) {
      throw conflict();
    }
    if (
      command.nextContext.revision !== command.expectedRevision + 1 ||
      command.nextContext.version !== "1.0" ||
      command.turn.sessionId !== command.sessionId ||
      command.userMessage.sessionId !== command.sessionId ||
      command.assistantMessage.sessionId !== command.sessionId ||
      command.userMessage.role !== "USER" ||
      command.assistantMessage.role !== "ASSISTANT" ||
      command.providerBinding?.sessionId !== command.sessionId &&
        command.providerBinding !== undefined
    ) {
      throw invalidContext();
    }
    const existingIds = new Set(
      current?.messages.map((message) => message.id) ?? [],
    );
    if (
      command.userMessage.id === command.assistantMessage.id ||
      existingIds.has(command.userMessage.id) ||
      existingIds.has(command.assistantMessage.id)
    ) {
      throw conflict();
    }
  }
}
