# Context

Skein context is durable, generic workflow state. It is distinct from conversational memory and contains no provider or business schema.

```ts
interface SkeinContext {
  version: "1.0";
  revision: number;
  conversation: { topic?: string; language?: string };
  workflow: { state: Record<string, unknown> };
  runtime: { lastTurnId?: string; updatedAt?: string };
}
```

## Validation limits

The default Core validator accepts only ordinary JSON values and enforces:

- at most 64 KiB of UTF-8 serialized context;
- at most 16 nested containers;
- at most 128 entries per array;
- plain objects and dense, ordinary arrays only;
- finite numbers and no cycles, accessors, symbols, custom properties or class instances;
- no prototype-pollution keys.

The limits can be replaced when constructing `ChatRuntime`, but invalid limits fail startup. A loaded context is validated before an orchestrator receives it, and the merged result is validated again before persistence.

## Provider patches

Providers may propose only:

```ts
interface ContextPatch {
  conversation?: { topic?: string; language?: string };
  workflowState?: Record<string, unknown>;
}
```

The Runtime shallow-merges generic workflow-state keys. A patch cannot write `revision`, `runtime`, `lastTurnId`, `updatedAt`, or prototype-related keys at any nesting level. The Runtime alone increments revision and writes turn/timestamp metadata.

An invalid provider patch fails as `PROVIDER_INVALID_RESPONSE`; invalid stored, extension or merged state fails as `CONTEXT_INVALID`. Neither path calls `commitTurn`.

## Typed extensions

Applications may inject a synchronous `ContextExtensionProvider` that validates `workflow.state`. Core first provides it a cloned, bounded safe object and then validates/clones its returned value again. The extension cannot relax Core limits or write runtime-owned keys.

## Concurrency

Each turn loads a revision, receives a deeply cloned/frozen snapshot and proposes a new revision. Persistence commits only when the stored revision still equals the loaded revision; otherwise the turn fails with `SESSION_CONFLICT` instead of overwriting concurrent state.
