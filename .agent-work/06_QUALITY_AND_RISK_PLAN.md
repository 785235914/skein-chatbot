# Quality and Risk Plan

## Quality gates

| Gate | Evidence | Status |
|---|---|---|
| G0 Context ready | Target, source analysis, environment and unknown classification | passed |
| G1 Plan ready | Complexity, team, traceability, plan and decisions | passed |
| G2 Workstreams ready | Output, drift check, local tests and handoff | passed |
| G3 Integration ready | Interfaces aligned and integrated four-command gate | passed |
| G4 Verification ready | Independent review and defects repaired | passed |
| G5 Delivery ready | Usable artifacts, docs, limitations and rollback | passed |
| G6 Learning ready | Retrospective and candidate decision | passed |

## Risks

| Risk | Detection | Mitigation / recovery | Owner |
|---|---|---|---|
| Secret leakage from local references | secret/business-string scan | never copy values; refs stay outside repo; rotate by owner | Main Agent |
| Core/provider coupling | imports and forbidden strings | dependency inversion and architecture tests | Architect / Main Agent |
| Partial state after provider failure | atomicity tests | snapshot then single repository commit | Core implementer |
| Concurrent context overwrite | revision-conflict test | optimistic compare-and-swap; canonical conflict | Persistence implementer |
| Broken/hostile stream | malformed/abort tests | bounded parser, canonical error and AbortSignal | Dify implementer |
| External services unavailable | preflight and smoke result | Mock/in-memory development; report real checks separately | Environment owner |
| UI dictates backend schema | dependency/import checks | public contract only; optional compatibility gateway | UI implementer |
| Public scrub misclassifies private/special-use authorities | hostile fragment-built URL/path regressions and candidate scrub | maintained ICANN/private PSL classification plus explicit special-use/loopback/example policy | Main Agent / scrub implementer |
| Composed provider identity exceeds durable storage bound | exact 191/192 tests and pre-persistence composition check | one Core-exported maximum enforced in Core, API composition and PostgreSQL codec | Main Agent / API implementer |
| Local tests are mistaken for external compatibility | separate evidence rows and explicit `NOT RUN` states | never use protected credentials; report Dify, real PostgreSQL and browser visual checks independently | Main Agent |

## Authorization gates

No production/external mutation is authorized. Creating a dedicated local database is in scope only when non-destructive authentication succeeds with separately authorized credentials; none were available, so real migration/restart remains `NOT RUN`. Real Dify smoke likewise remains `NOT RUN`. Credential rotation is owner action and is not performed by this project.
