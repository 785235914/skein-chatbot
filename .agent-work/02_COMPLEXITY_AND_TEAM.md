# Complexity and Team

## Score

| Dimension | Score | Evidence |
|---|---:|---|
| Scope | 3 | Eleven milestones and multiple packages |
| Ambiguity | 1 | Detailed specification; two external credential gaps |
| Dependencies | 2 | Dify, PostgreSQL, Prisma, web client |
| Technical difficulty | 2 | Streaming, safe commit, provider abstraction |
| Risk | 2 | Security-sensitive reference inputs plus persistence/guard boundaries |
| Verification | 3 | Unit, integration, E2E, persistence and security checks |
| Parallelism | 2 | Isolated adapters, core services, UI/docs |
| Context volume | 2 | Large specification and three large workflow exports |

- Raw total: 17 (`XL`)
- Risk floor: `L` because contracts, persistence, streaming and security cross packages.
- Final level: `XL`, not provisional. The score was raised after secret-bearing source material was directly confirmed.

## Team

| Role | Owner | Responsibility |
|---|---|---|
| Project Lead / Integration | Main Agent | Requirements, contracts, shared config, integration, delivery |
| Source Analyst | `dify_source_analysis` plus Main Agent safe parser | Reference evidence and leakage boundary |
| Environment Engineer | `environment_recon` | Toolchain, PostgreSQL and UI suitability |
| Solution Architect / QC Designer | `architecture_acceptance` | Package graph and frozen acceptance |
| Path-isolated implementers | Assigned after interface freeze | Core/persistence, Dify, demo/docs as bounded packages |
| Acceptance Owner | Separate Agent | Inspect original request, artifacts and rerun gates |

## Acceptance independence

- Required: physically independent auditor for level XL.
- Mechanism: fresh independent agent after implementation, followed by Main Agent defect integration. Completion is not claimed without that verdict.
