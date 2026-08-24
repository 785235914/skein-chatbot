# Memory Candidates

These are proposals only. They were not written to permanent memory, the knowledge Vault, global Skills, `AGENTS.md` or global configuration.

## Memory Candidate MC-001

- Category: `project_fact`
- Statement: Skein Chatbot is a general open-source modular-monolith backend. Its Core owns provider-neutral session/context/memory/guard/reliability lifecycle; Dify is only a replaceable `BusinessOrchestrator` adapter, PostgreSQL is a replaceable RuntimeStore, and the React/Vite Demo uses only stable REST/SSE.
- Why it matters later: prevents future work from moving company workflow schema, Dify protocol details or frontend session assumptions into Core.
- Scope: `project`
- Evidence/source: master specification, architecture docs, R01-R15 acceptance and independent final review.
- Confidence: `high`
- Stability: `durable`
- Suggested destination: project memory for the `skein-chatbot` repository.
- Sensitive data check: `passed`
- Duplicate check: `new`

## Memory Candidate MC-002

- Category: `technical_reference`
- Statement: Skein's publication scrub uses maintained public/private suffix classification, and the durable provider-key contract is 191 characters enforced in Core, API composition before I/O, and PostgreSQL.
- Why it matters later: these two cross-boundary invariants were final-audit release blockers and must remain coordinated during dependency, adapter or schema changes.
- Scope: `project`
- Evidence/source: D-011/D-012, `XL-01`/`XL-02` fixes and exact boundary tests.
- Confidence: `high`
- Stability: `durable`
- Suggested destination: project memory and architecture decision index.
- Sensitive data check: `passed`
- Duplicate check: `new`

## Memory Candidate MC-003

- Category: `project_fact`
- Statement: Local implementation and independent acceptance are complete, but real Dify smoke and real PostgreSQL restart are `NOT RUN`, while browser visual validation is `PARTIAL / NOT RUN`; fixture, fake-client and API-client tests do not upgrade those statuses.
- Why it matters later: prevents a future continuation from treating missing external compatibility evidence as completed.
- Scope: `project`
- Evidence/source: final verification report and independent scoped re-review.
- Confidence: `high`
- Stability: `review_later`
- Suggested destination: active project status memory until authorized runs occur.
- Sensitive data check: `passed`
- Duplicate check: `new`
