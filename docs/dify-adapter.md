# Dify Adapter

## Configure

Keep credentials in an ignored `.env.local`:

```text
ORCHESTRATOR_PROVIDER=dify
DIFY_BASE_URL=https://api.example.com/v1
DIFY_API_KEY=replace-locally
DIFY_PROFILE=default
```

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

The command reads `.env.local`, never prints the key, query, answer or raw provider payload, and outputs only status, latency and boolean/count fields. If local credentials are absent it exits successfully with an explicit `NOT RUN` reason; that is not evidence of real-provider compatibility.

## Extension boundary

Level A compatibility uses configuration only. Level B compatibility uses YAML mappings. Truly non-standard provider semantics require a Dify-adapter normalizer extension; they must never enter `packages/core` or the public frontend contract.
