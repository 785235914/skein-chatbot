# Decision Log

## D-001 — Provider-neutral conversation ID result

- Context: Runtime must persist external conversation binding only after successful orchestration, but the base result shape omitted a returned external ID.
- Decision: add optional internal `providerConversationId` to orchestration results and terminal stream data.
- Rationale: preserves dependency inversion and atomic safe commit; it is never exposed as the Skein session ID.
- Reversible: yes, before public package publication.

## D-002 — API-key switch sessions

- Context: an API key can select another Dify app while `providerKey` remains the configured logical profile.
- Decision: the key-only switching acceptance test uses fresh Skein sessions. Existing bound sessions are not silently rebound.
- Rationale: avoids sending an app-specific external conversation ID to another app.
- Reversible: future app-identity namespaces may extend provider keys.

## D-003 — DeepSeek UI usage

- Evidence: official `deepseek-ai/deepseek-harness` commit `47f943859bef60e4160492346772ded9b24f765a` boots its Web entry through `AppWebEntry`; its shell depends on Cordis/plugin/slot services and React session/projection bindings rather than a standalone REST/SSE client.
- Decision: do not import or invasively fork it. Keep the independent Demo canonical and document only a future temporary thin gateway that translates the stable Skein REST/SSE contract.
- Rationale: Runtime and public API remain authoritative and replaceable.

## D-004 — Secret-bearing references

- Evidence: non-placeholder API-key-like values and private identifiers exist in local exports; hashes remained unchanged.
- Decision: use secret-safe structural analysis only, never embedded credentials, and keep the files outside the repository.
- Rationale: open-source hygiene and least authority.

## D-005 — Complexity rescore

- Context: the initial score treated risk as limited local risk; inspection confirmed secret-bearing input alongside persistence and guard boundaries.
- Decision: raise risk from 1 to 2, moving the reproducible total from 16/L to 17/XL.
- Rationale: the open-source leakage consequence requires an independent final auditor even though implementation changes are local and reversible.

## D-006 — Dependency build allowlist

- Context: pnpm 11 correctly blocked Prisma installation scripts after the M4 package entered the workspace.
- Decision: allow only `@prisma/engines`, `prisma`, and the already-required `esbuild` in workspace `allowBuilds`; keep all other dependency build scripts denied by default.
- Rationale: Prisma client generation requires its official engine setup while a narrow allowlist preserves the supply-chain boundary.
- Reversible: yes; removing the PostgreSQL package permits removing the two Prisma entries.

## D-007 — Compaction ordering and concurrent claims

- Context: compaction can fail independently of business orchestration, and two workers may load the same context revision and target the same active messages.
- Decision: compact before provider execution as an independent maintenance commit; keep context revision unchanged; atomically claim only active messages and make a duplicate claimant fail with `SESSION_CONFLICT`. A later provider, guard or abort failure forbids turn-specific message/context/provider-binding commit but does not roll back an already committed summary or compacted-message markers.
- Rationale: a compaction failure cannot follow an already committed chat response, full history is retained, and summaries cannot silently overwrite each other.
- Reversible: yes, but any alternative must preserve one-winner semantics and safe turn commit.

## D-008 — Reliability at the composition boundary

- Context: the provider-neutral decorator was implemented but the default API still injected raw adapters into `ChatRuntime`.
- Decision: wrap the selected Mock or Dify adapter exactly once at API composition, using RuntimeConfig and a `provider:providerKey` circuit identity; keep persistence binding identity unchanged.
- Rationale: every default API provider call now receives timeout, retry, circuit-breaker and abort behavior without provider logic entering Core Runtime or adapters.
- Reversible: yes; other composition roots may apply the same public decorator.

## D-009 — Untrusted Guard composition and buffered output

- Context: default and injected input/output guards must protect every public or durable text surface without introducing a provider dependency.
- Decision: build cloud-free default pipelines, run injected guards through the same result validator, reconstruct guard failures with fixed cause-free errors, and buffer all content-bearing stream events while output guarding is enabled.
- Rationale: split-chunk credentials and unsafe structured output cannot escape before terminal validation and commit; a malicious injected Guard cannot disclose its own backend message or cause.
- Reversible: yes; deployment stages can be replaced through `GuardPort` without changing Runtime Core.

## D-010 — Irreversible turn commit boundary

- Context: `RuntimeStore.commitTurn` is atomic but its frozen port has no `AbortSignal` or rollback contract.
- Decision: perform the final cancellation check immediately before calling `commitTurn`; treat call entry as irreversible and do not reclassify an already-started commit when cancellation arrives during storage latency or safe buffered release.
- Rationale: this makes the only enforceable cancellation boundary explicit and avoids reporting `ABORTED` after durable success.
- Tradeoff: a late stop can still produce a committed completed turn and already-approved buffered output.
- Reversible: only with a future store contract that provides cancellation-aware atomic rollback semantics.

## D-011 — Maintained public-suffix classification for scrub exemptions

- Context: the final XL audit proved that an unknown alphabetic suffix heuristic let special-use/private authorities suppress a local `/workspace` path finding.
- Evidence: `XL-01` in `final-xl-review.md`; fragment-built `home.arpa`, `.corp` and private-PSL regressions in the final fix report.
- Decision: use maintained `tldts` ICANN/private suffix classification for public-URL exemptions, keep explicit loopback/documentation-example allowances, and explicitly reject required special-use authorities.
- Rationale: a publication scrub exemption must be based on demonstrably public authority, not hostname syntax.
- Tradeoff: the scrub acquires a small MIT-licensed development dependency and its PSL data must be refreshed through normal dependency maintenance.
- Reversible: yes, if replaced by an equally maintained and regression-covered classifier.

## D-012 — Shared durable provider-key maximum

- Context: separately valid Dify prefix/profile components could compose a 192+ character identity that in-memory execution accepted but PostgreSQL rejected.
- Evidence: `XL-02` in `final-xl-review.md`; exact 191/192 Core, API composition and PostgreSQL tests in the final fix report.
- Decision: export a provider-neutral 191-character maximum from Core and enforce the final composed identity in Core, the API composition root before persistence/provider activity, and PostgreSQL decoding.
- Rationale: one durable identity contract removes storage-dependent behavior without moving Dify composition into Core or transforming identities.
- Reversible: partly; changing the maximum requires a coordinated schema/migration and compatibility decision.

## D-013 — External checks remain separately unclaimed

- Context: fixture/in-memory verification cannot prove compatibility with a real Dify app, real PostgreSQL driver/migration/restart behavior, or browser-rendered Demo visuals.
- Decision: keep real Dify and real PostgreSQL checks `NOT RUN`, and browser visual validation `PARTIAL / NOT RUN`, unless separately authorized environment evidence is actually executed.
- Rationale: protected reference credentials are not authorization and local deterministic substitutes must not be reported as external success.
- Reversible: yes; update only after a fresh authorized run with sanitized evidence.
