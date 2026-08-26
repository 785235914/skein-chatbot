# Dify Adapter

## Configure

Create `apps/api/.env.local` from the root `.env.example` and keep credentials only in that ignored local file:

```text
ORCHESTRATOR_PROVIDER=dify
DIFY_BASE_URL=https://api.example.com/v1
DIFY_API_KEY=replace-locally
DIFY_PROFILE=default
SESSION_RESUME_SECRET=replace-with-base64-32-byte-key
```

`DIFY_BASE_URL` is the API root ending in `/v1`; do not append `/chat-messages`. Generate the local resume key with:

```text
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Keep the generated value only in `apps/api/.env.local`. Restarting with a different key intentionally invalidates previously issued browser tokens. `pnpm smoke:dify` also accepts a root `.env.local`, or an explicit ignored path through `SKEIN_LOCAL_ENV_FILE`, but the API development process reads `apps/api/.env.local` because its working directory is `apps/api`.

Use `pnpm dev:dify` for the API and demo. The default `pnpm dev:mock` path needs no Dify or cloud account.

## Switch applications

For two Skein-compatible apps on the same base URL, start a fresh Skein session and change only `DIFY_API_KEY`. Existing sessions retain their app-specific external conversation binding and are never silently rebound.

For apps with different input or output names, add an ignored `config/dify-profiles/local-<name>.yaml` based on `example.yaml`, set `DIFY_PROFILE=<name>`, and restart. Profile names participate in provider identity, so bindings cannot leak across profiles. Runtime Core code does not change.

Set `transport.executeResponseMode: streaming` for Dify app modes that expose only streaming chat execution. In that mode the adapter safely aggregates a terminal result for blocking Skein calls.

## Smoke test

Run:

```text
pnpm smoke:dify
```

The command reads `.env.local`, sends an initial harmless chat, closes the Runtime, creates a fresh in-memory Runtime, restores history with the opaque token and sends a continuation. It never prints the URL, key, token, conversation ID, query, answer or raw provider payload; output is restricted to PASS/FAIL, latency and boolean/count fields. If `DIFY_BASE_URL`, `DIFY_API_KEY` or `SESSION_RESUME_SECRET` is absent it exits successfully with an explicit `NOT RUN` reason; that is not evidence of real-provider compatibility.

## Recovery scope

V1 live restart recovery is Dify-only because this adapter supplies `/messages` history retrieval. Runtime Core and the public route remain provider-neutral; another provider can add the capability by supplying the same history and token-codec ports. Recovery is bounded to 200 Dify rows and reconstructs the default Skein context at revision `0`. Use PostgreSQL when full Skein turn, summary and context durability is required.

## Extension boundary

Level A compatibility uses configuration only. Level B compatibility uses YAML mappings. Truly non-standard provider semantics require a Dify-adapter normalizer extension; they must never enter `packages/core` or the public frontend contract.
