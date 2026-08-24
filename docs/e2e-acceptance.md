# E2E acceptance matrix

This matrix preserves the 19 Section 67 scenarios in their original order. `PASS` means the cited automated test covers the stated contract; `PARTIAL` means the public client/API contract is covered but a rendered browser UI is not; `NOT RUN` requires separately authorized external infrastructure.

## Section 67 scenarios

| # | Scenario | Evidence | Command | Status |
| --- | --- | --- | --- | --- |
| 1 | Demo UI -> Runtime -> Mock | Canonical Demo `createApiClient` over real loopback HTTP | `pnpm exec vitest run scripts/mock-public-e2e.test.ts` | PARTIAL |
| 2 | Demo UI -> Runtime -> real Dify | Separately authorized external smoke only | `pnpm smoke:dify` | NOT RUN |
| 3 | new session | Provider-free public journey | `pnpm exec vitest run scripts/mock-public-e2e.test.ts` | PASS |
| 4 | multi-turn | Provider-free public journey | same | PASS |
| 5 | session reload | Provider-free public journey | same | PASS |
| 6 | quick mode | Provider-free public journey | same | PASS |
| 7 | deep mode | Provider-free public journey | same | PASS |
| 8 | source rendering | Canonical source response reaches Demo API client; rendered UI is not exercised | `pnpm exec vitest run scripts/mock-public-e2e.test.ts apps/demo-web/src/api.test.ts` | PARTIAL |
| 9 | follow-up guidance | Provider-free public journey asserts canonical guidance through Demo client | `pnpm exec vitest run scripts/mock-public-e2e.test.ts` | PASS |
| 10 | input redact | Core Guard regression | `pnpm exec vitest run packages/core/test/guard.test.ts` | PASS |
| 11 | input block | Core Guard regression | `pnpm exec vitest run packages/core/test/guard.test.ts` | PASS |
| 12 | timeout | Composed default-Mock blocking route: `returns HTTP 504 with a canonical public error for a composed Mock timeout` in `apps/api/test/app.test.ts` | `pnpm exec vitest run apps/api/test/app.test.ts -t "returns HTTP 504 with a canonical public error for a composed Mock timeout"` | PASS |
| 13 | retry | API composition regression | `pnpm exec vitest run apps/api/test/composition.test.ts` | PASS |
| 14 | abort | API failure-path regression | `pnpm exec vitest run apps/api/test/app.test.ts` | PASS |
| 15 | revision conflict | Runtime regression | `pnpm exec vitest run packages/core/test/chat-runtime.test.ts` | PASS |
| 16 | long chat compaction | Memory compaction regression | `pnpm exec vitest run packages/core/test/memory-compaction.test.ts` | PASS |
| 17 | provider switch via config | API configuration selection is covered; a cross-provider live journey is not | `pnpm exec vitest run apps/api/test/config.test.ts` | PARTIAL |
| 18 | Dify switch via API key | Adapter regression changes only the app key on one shared base URL | `pnpm exec vitest run packages/adapters/dify/test/dify-business-orchestrator.test.ts` | PASS |
| 19 | Dify switch via profile | API composition and adapter profile regressions | `pnpm exec vitest run apps/api/test/composition.test.ts packages/adapters/dify/test/dify-business-orchestrator.test.ts` | PASS |

## Task 10B complete Mock journey

| Journey substep | Evidence | Command | Status |
| --- | --- | --- | --- |
| Health and readiness | Real Fastify loopback listener | `pnpm exec vitest run scripts/mock-public-e2e.test.ts` | PASS |
| New QUICK session with canonical sources | Demo client over blocking public HTTP | same | PASS |
| DEEP follow-up with canonical guidance | Demo client over blocking public HTTP | same | PASS |
| Session reload and ordered canonical messages | Public session and message endpoints | same | PASS |
| Ordered SSE with one terminal completion | Demo client stream parser | same | PASS |
| Reset with empty active-message history | Public reset and messages endpoints | same | PASS |

## Critical acceptance scenarios

| Scenario | Evidence | Command | Status |
| --- | --- | --- | --- |
| API-key-only Dify switching uses a fresh Skein session | Adapter regression changes only the app key on one shared base URL | `pnpm exec vitest run packages/adapters/dify/test/dify-business-orchestrator.test.ts` | PASS |
| Mapping-profile switch stays outside Runtime Core | Adapter profile regression and Core boundary scan | `pnpm exec vitest run packages/adapters/dify/test/dify-business-orchestrator.test.ts scripts/frontend-boundary.test.ts` | PASS |
| Frontend replacement keeps the public REST/SSE boundary | Demo API and frontend-boundary regressions | `pnpm exec vitest run apps/demo-web/src/api.test.ts scripts/frontend-boundary.test.ts` | PASS |

## External checks

| Check | Command | Status |
| --- | --- | --- |
| Real Dify smoke against separately authorized local credentials | `pnpm smoke:dify` | NOT RUN |
| Real PostgreSQL restart against a separately authorized dedicated database | `pnpm --filter @skein-chatbot/postgres test:postgres` | NOT RUN |
