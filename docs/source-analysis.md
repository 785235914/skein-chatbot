# Source Analysis

## Scope and handling

Three local Dify application exports supplied for integration reference were parsed completely in a read-only process. Only protocol-relevant structure is recorded here. Prompts, business rules, variable names, URLs, credentials, user data, and organization-specific content were intentionally not copied.

The source hashes were verified before and after analysis and did not change:

| Local alias | SHA-256 |
|---|---|
| Reference A | `0E7A69EC8D99C463683F38FDB0E1C297C9679C914384BCED82BC288118BE0DD7` |
| Reference B | `A0FCDA0A5092477AEE981D4413772FE90512F3919C255718BB7F9F849E622E47` |
| Reference C | `4E9168FC7E089E0449D375BB9944A889482326F23D3F885492A2AF57A6AFD758` |

## Security finding

The exports are secret-bearing local material. At least six non-placeholder API-key-like values were detected under credential fields, together with private URL/host and email-like values. None were printed, copied, tested, or committed. These credentials should be rotated or revoked by their owner. The exports must remain outside this repository.

Real-provider smoke tests must use a separately supplied `.env.local`; embedded values from the exports are not an authorized credential source.

## Structural findings

| Fact | Reference A | Reference B | Reference C |
|---|---:|---:|---:|
| Dify DSL version | 0.6.0 | 0.6.0 | 0.6.0 |
| Application mode | `advanced-chat` | `advanced-chat` | `advanced-chat` |
| Start inputs | 5 | 4 | 3 |
| Conversation variables | 20 | 0 | 16 |
| Workflow nodes | 67 | 10 | 13 |
| File-upload feature enabled | yes | no | no |
| Retriever-resource feature enabled | yes | yes | yes |

The start inputs are text/paragraph inputs. Conversation state contains string, boolean, integer, string-array, and object-array values. This supports a configuration-driven `inputs` mapping and a generic JSON `workflow.state`; it does not justify hard-coding any observed business variable into Runtime Core.

References A and B contain nested Dify HTTP calls using API-key/Bearer authentication and the `/chat-messages` path. Their request structures contain the standard field vocabulary `inputs`, `query`, `response_mode`, `conversation_id`, and `user`. Internal nodes read `answer` and `conversation_id`. These are calls made by exported workflows, not a complete description of the exports' own published API.

## Adapter contract

The implementation uses the current public Dify chat-message contract as the adapter default and keeps every field configurable at the adapter/profile boundary. Official reference: <https://docs.dify.ai/en/api-reference/chat-messages/send-chat-message>.

| Concern | Adapter default | Local evidence | Confidence / treatment |
|---|---|---|---|
| Base URL | `DIFY_BASE_URL` | Private values exist but are not copied | Required configuration; exact local value `UNKNOWN` |
| Endpoint | `POST /chat-messages` | Path occurs in nested calls | High; adapter-owned |
| Authentication | `Authorization: Bearer <app key>` | API-key/Bearer auth occurs in nested calls | High; secret never logged |
| Query | `query` | Present | High |
| App inputs | `inputs` object | Present | High; profile maps canonical fields |
| Response mode | `blocking` or `streaming` | `response_mode` present | High |
| User | stable opaque string | Present | High; no personal data required |
| Conversation binding | request/response `conversation_id` | Present and consumed internally | High; stored separately from Skein session ID |
| Files | optional `files` | Feature is enabled in one export; no safe local request example | Supported by adapter transport, not exposed by V1 public request |
| Blocking answer | `answer` | Consumed internally | High |
| Sources | `metadata.retriever_resources` by default | Retriever feature enabled; exact public payload absent | Official-contract default plus profile normalization |
| Streaming | SSE data frames and terminal `message_end` | Export DSL does not describe inbound streaming frames | Official-contract implementation; mock-server integration tests required |
| Errors | HTTP status plus provider JSON | Export DSL does not define published API error schema | Exact local payload `UNKNOWN`; map defensively to canonical errors |
| Structured output | profile-selected response paths | Internal structured output exists but is business-specific | Never copied into Core; profile/normalizer only |

## Conversation and context boundary

- `sessionId` is a Skein identifier.
- Dify `conversation_id` is an external binding keyed by provider plus logical provider key.
- A provider result may propose a provider-neutral `providerConversationId`; Runtime persists it only during the successful commit.
- Dify conversation variables and workflow internals are not public Skein fields.
- Canonical context remains `conversation`, generic `workflow.state`, and runtime-owned metadata.

## Unknowns

- The base URL, deployment version, network reachability, and TLS policy of any real Dify installation.
- Whether a real target app returns additional proprietary fields or nonstandard stream events.
- Whether a real target app requires file inputs or custom app variables.
- Real API credentials suitable for smoke testing.

Unknowns do not block provider-free implementation. They block only the real Dify smoke test, which must remain sanitized and opt-in through `.env.local`.
