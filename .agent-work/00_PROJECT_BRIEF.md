# Project Brief

## Outcome

A working open-source, provider-agnostic backend framework for secure, stateful chat applications, with Dify as one replaceable reference adapter.

## Target and current state

- Target: this `skein-chatbot` directory.
- Initial state: empty directory, no Git repository.
- Delivery: source, tests, docs, migrations, demo and verification evidence in this repository.

## Scope

- In scope: Milestones 0-10 in the user-supplied master build specification.
- Out of scope: business workflow logic, custom RAG/planner, vector database, multi-agent engine, Kafka, Kubernetes, SSO, admin portal and microservices.

## Protected areas

- Local Dify exports are read-only and secret-bearing.
- No credential or proprietary material may enter this repository.
- Existing PostgreSQL databases and the external UI source are read-only.

## Definition of done

- [x] Public REST/SSE contract and session lifecycle work.
- [x] Core remains provider and business neutral.
- [x] Mock and Dify adapters pass local contract/integration tests.
- [x] PostgreSQL schema/repository, context, memory, guards, reliability and telemetry exist.
- [x] Demo consumes only the public API.
- [x] Every implemented milestone has lint, typecheck, test and build evidence.
- [x] The corrected open-source scrub passes on the concentrated final-fix tree.
- [x] Final independent acceptance: a fresh physical independent scoped reviewer verified all five final-audit findings addressed, found no new Critical/Important breakage and returned `ACCEPT`.

## External acceptance limits

- Real Dify smoke: `NOT RUN` because no separately authorized `.env.local` credentials are available.
- Real PostgreSQL migration/restart/persistence: `NOT RUN` because no authorized dedicated database credentials are available.
- Browser-rendered Demo visual journey: `PARTIAL / NOT RUN`; contract tests, build and loopback API journey exist, but no browser visual claim is made.

## Unknowns

| Item | Class | Resolution |
|---|---|---|
| Local Dify URL/API credential | DISCOVERABLE but protected | Do not extract; use separately authorized `.env.local` only |
| PostgreSQL login/database | DISCOVERABLE but authorization-bound | No authorized dedicated database was available; keep the real restart/migration check `NOT RUN` and do not modify existing databases |
| Provider-specific custom response fields | ASSUMABLE | Profile/normalizer extension; default public contract plus mocks |
| DeepSeek UI direct reuse | DISCOVERABLE | Coupling inspection rejects invasive integration; retain independent demo |
