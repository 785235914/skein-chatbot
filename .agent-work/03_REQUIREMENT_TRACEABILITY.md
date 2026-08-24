# Requirement Traceability

| ID | Requirement | Output | Acceptance check | Status |
|---|---|---|---|---|
| R01 | Headless, provider-neutral Runtime Core | `packages/core`, architecture tests | forbidden-import/string scan | accepted |
| R02 | Stable REST/SSE API | `apps/api`, `packages/contracts` | injection and SSE tests | accepted |
| R03 | Session lifecycle | core repositories/runtime and routes | create/reload/messages/reset/abort tests | accepted |
| R04 | Replaceable orchestrator | orchestrator contract, Mock and Dify adapters | config switch test | accepted |
| R05 | API-key-only Dify app switch | Dify transport/config tests | two mock apps, only key changes | accepted |
| R06 | Profile-based schema mapping | profile schema/loader | two profile switch test | accepted |
| R07 | Separate provider conversation binding | persistence model/runtime commit | fresh/multi-turn binding tests | accepted |
| R08 | Generic context and safe commit | context/turn services | validation/conflict/failure atomicity | accepted |
| R09 | Recent memory and compaction | memory services | window/threshold/state integrity | accepted |
| R10 | Provider-neutral reliability | reliability services | timeout/retry/circuit/abort tests | accepted |
| R11 | Input/output guards | guard services and Runtime integration | 85 Guard + 26 runtime redact/block/leak/abort tests and 331-test M8 gate | accepted |
| R12 | PostgreSQL persistence | Prisma schema/migration/repositories | schema, codec, transaction and fake-restart checks implemented; real migration/restart `NOT RUN` without an authorized dedicated database | implemented; external verification not run |
| R13 | Observability/audit/metrics | telemetry ports and Pino adapters | event/counter/redaction tests | accepted |
| R14 | Replaceable demo frontend | `apps/demo-web`, DeepSeek decision and boundary verifier | Demo build, 10 focused tests, live REST/SSE smoke and frontend-removed 329-test boundary | accepted |
| R15 | Provider-free developer experience | Mock composition/scripts | `pnpm dev:mock` smoke | accepted |
| R16 | Real-provider smoke command | sanitized script | no-secret output; real provider run requires separately authorized credentials | implemented; external run `NOT RUN` |
| R17 | Open-source hygiene | ignore rules, maintained public-suffix scrub and docs | full-repo forbidden-content/secret scan including special-use/private authorities | accepted |
| R18 | Four green gates per milestone | scripts/status evidence | milestone gates plus final fresh lint/typecheck/25 files and 392 tests/build evidence | accepted |
