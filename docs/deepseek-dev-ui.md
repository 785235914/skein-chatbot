# DeepSeek development UI compatibility boundary

## Evidence inspected

This decision is based on the official
[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)
repository at commit `47f943859bef60e4160492346772ded9b24f765a`.

- `apps/web/src/main.ts` creates `AppWebEntry` from
  `@deepseek-ai/dsh-client-web`; it is a mount-point bootstrap, not a REST/SSE
  client.
- `apps/web/package.json` depends on the web shell and its client module, UI
  primitive, UI slot, and web-react packages.
- `packages/client/web/package.json` shows the shell's Cordis, module, slot,
  theme, runtime, and web-react graph.
- `packages/client/web/src/app-shell.ts` is a Cordis plugin that requires
  `slots`, `sessions`, and `layout`, installs the renderer, and provides the
  assembled application through the host context.
- `packages/client/web/src/app.tsx` reads the host `sessions` service and
  renders the host's `root` slot.
- `packages/client/web-react/src/session-provider.tsx` binds React rendering to
  host session and projection stores.

## V1 decision

Do **not** reuse the DeepSeek Harness Web UI directly in Skein V1. Skein will
not take a DeepSeek dependency, copied source, invasive fork, or runtime
import. Direct reuse would import Cordis boot, plugin and slot assembly,
host session/projection state, plus the harness's RPC/gateway semantics. That
is incompatible with Skein's headless, public-API architecture.

The existing `apps/demo-web` remains the canonical minimal public-API smoke
client. It is deliberately replaceable and speaks only Skein's stable REST
and event-stream surface. It supports a new conversation; streaming chat;
Quick and Deep modes; stop/abort; streamed and terminal sources; follow-up
question and guidance; canonical error display with trace ID; and retry when
the canonical error is retryable.

Its client uses these exact endpoints (also covered by its API tests):

```bash
curl --request POST http://localhost:3000/api/v1/chat \
  --header 'Accept: application/json' \
  --header 'Content-Type: application/json' \
  --data '{"message":"What can Skein do?","mode":"quick"}'

curl --no-buffer --request POST http://localhost:3000/api/v1/chat/stream \
  --header 'Accept: text/event-stream' \
  --header 'Content-Type: application/json' \
  --data '{"message":"Explain the answer step by step.","mode":"deep"}'
```

Neither example requires a secret. A caller may include a Skein `sessionId`
in the request body when it is continuing a conversation.

## Future-only compatibility shape

If a later development experiment needs a DeepSeek-derived UI, it must sit
behind a thin, optional compatibility gateway:

```text
DeepSeek UI request
  -> Skein /api/v1/chat or /api/v1/chat/stream
  -> canonical Skein response/events
  -> UI projection
```

That gateway may translate transport at the edge only: it contains no
business logic, and Skein persistence must never be keyed by DeepSeek session
IDs. The adapter is temporary, non-production, replaceable, and not part of
the Skein protocol. It is not implemented in V1.
