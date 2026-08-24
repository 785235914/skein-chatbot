# Retrospective

## Objective and delivered result

- Original objective: build the actual general open-source Skein framework, not a business-specific chatbot or a design-only response.
- Actual result: Milestones 0-10 delivered, locally verified, independently accepted, and documented with exact external limitations.

## What worked

- Practice: froze package boundaries and public contracts before implementation. Evidence: Core/provider scans remained clear and both Mock and Dify compose through `BusinessOrchestrator`.
- Practice: persisted SDD ledger, hash baselines and bounded review packages. Evidence: recovery after context compaction and the original reviewer's quota failure did not redispatch completed milestones or lose findings.
- Practice: red/green regressions plus physically independent review. Evidence: Guard/scrub fix loops and the final XL audit exposed subtle credential, path, suffix, provider-key and public-timeout gaps that ordinary green gates missed.
- Practice: protected external references and explicit authorization boundaries. Evidence: no reference credential was read for execution; both external commands returned sanitized `NOT RUN`.

## Friction, failure and recovery

- Event: Task 10B reached its five-round breaker with NB-05. Cause: increasingly patched hostname heuristics. Recovery: carry the load-bearing defect into the mandated final audit and use one maintained PSL-based concentrated fix.
- Event: original final auditor exhausted its independent usage quota during scoped re-review. Recovery: ledger a ruling, reuse the frozen package and dispatch one fresh physical independent reviewer; result was 5/5 addressed and `ACCEPT`.
- Event: combined background-process/temp-cleanup and computed-directory-move commands were rejected before PowerShell launched. Recovery: isolate the operations into explicit PTY/process and explicit-path move/test/restore steps.
- Event: the frontend-absent suite initially had one failure. Cause: the open-source scrub correctly fails closed when Git candidates are missing. Recovery: retain that result as negative evidence, exclude only Demo-dependent/publication-integrity tests for the boundary run, then restore and pass the full suite.

## Assumptions and decisions

- Correct: Mock/in-memory development could complete all credential-free architecture work.
- Correct: direct DeepSeek Web UI reuse was too coupled for V1; the independent Demo preserved the stable API boundary.
- Correct: existing Dify sessions must retain their provider binding when an API key switches apps; fresh sessions prove switching safely.
- Highest impact: D-007 maintenance compaction separation, D-010 commit boundary, maintained PSL classification, and one shared durable provider-key maximum.

## Quality and coordination

- Checks that caught defects: fragment-built hostile inputs, exact length boundaries, composed public-route tests, candidate scrub, full XL audit and scoped independent re-review.
- Patterns that reduced overhead: exclusive path ownership, Main-Agent-only controls, exact hashes and one concentrated final fix wave.
- Patterns that created overhead: heuristic-by-heuristic scrub repairs and attempting complex filesystem/process orchestration in one policy-screened command.

## Repeat and prevent

- Repeat: freeze interfaces, test negative boundaries at composition points, keep external checks explicit, and preserve a durable progress ledger.
- Prevent: use maintained standards data instead of ad hoc public-suffix logic; validate composed identities at the earliest resource boundary; use explicit filesystem paths and separate reversible steps on Windows.

## Reusable extraction

| Category | Candidate | Evidence | Recommended destination |
|---|---|---|---|
| ARCHITECTURE_DECISION | Provider adapters and profiles stay outside headless Core | boundary scans and independent acceptance | project docs/decision log |
| RISK_CONTROL | A public URL exemption requires demonstrably public authority | XL-01 and hostile suffix regressions | scrub test checklist |
| TEST_OR_EVAL | Test durable identity limits after composition, before I/O | XL-02 exact 191/192 and no-I/O tests | integration-test pattern |
| FAILURE_PATTERN | A candidate scrub should fail closed while tracked files are temporarily absent | frontend-removal negative result | release/boundary SOP |
| TOOL_OR_COMMAND | On Windows, verify and move explicit paths in separate reversible steps | final frontend-boundary run | project execution notes |
