# Reliability

`ReliableBusinessOrchestrator` is a provider-neutral decorator around `BusinessOrchestrator`. The default API composition applies it once to either the Mock or Dify adapter before constructing `ChatRuntime`.

## Timeout

Each provider attempt uses an abort-linked timeout selected by execution mode: `QUICK_TIMEOUT_MS` defaults to 25000 and `DEEP_TIMEOUT_MS` defaults to 60000. Timeout remains authoritative even if a provider ignores abort. External cancellation maps to `ABORTED`, while an expired attempt maps to retryable `PROVIDER_TIMEOUT`.

## Retry

`RETRY_ATTEMPTS` is the number of additional attempts and defaults to 1. Retry is allowed only for adapter-normalized, explicitly retryable `PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE` and `PROVIDER_RATE_LIMITED` errors. Validation, authentication/configuration rejection, guard decisions, invalid context/response, business rejection and abort are not retried. Streaming retries only before the first public orchestration event.

## Circuit breaker

The V1 breaker implements `CLOSED`, `OPEN` and `HALF_OPEN`, with one concurrent half-open probe. State is isolated by canonical provider plus provider key and remains local to the composed runtime instance. Non-transient failures do not count as provider availability failures.

## Cleanup and safety

Every attempt releases its timer and external abort listener. Timed-out, aborted or consumer-cancelled streams close the provider iterator. Reliability never inspects provider payloads, URLs, credentials or business fields; adapters normalize failures before policy is applied.
