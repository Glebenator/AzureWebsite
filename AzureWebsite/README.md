# AzureWebsite

Express and EJS portfolio site with a read-only research library backed by private Azure Blob Storage.

## Research storage

The `/research` routes read Markdown blobs server-side from the `research` container in the `cvkeresearch` storage account. Browser clients never receive Blob credentials or direct private Blob URLs. Blob names are enumerated before a route slug can resolve, and rendered Markdown is sanitized before it reaches the EJS view.

The application uses `DefaultAzureCredential`; it does not support account keys, storage connection strings, or SAS tokens.

### Azure App Service

The `cvkeWebsite` App Service needs a system-assigned managed identity with the **Storage Blob Data Reader** role scoped to the `cvkeresearch` storage account. No secret-bearing application setting is required for the default account and container.

Optional application settings:

- `AZURE_STORAGE_ACCOUNT_NAME`: storage account override. Defaults to `cvkeresearch`.
- `AZURE_STORAGE_CONTAINER`: Blob container override. Defaults to `research`.
- `RESEARCH_CACHE_TTL_MS`: catalog and article cache lifetime. Values are bounded to 10 seconds through 15 minutes; the default is 5 minutes.

## Research assistant foundation

The research pages include inline **Ask the archive** and **Ask this note** interfaces. They render an explicit unavailable state until a citation-validating research-assistant provider is configured. The public API contract is `POST /research/ask`; answers must cite internal `/research/:slug#heading` sources and are returned with `Cache-Control: no-store`.

The internal provider boundary separates retrieval from generation. Retrieval supplies indexed chunks with their Blob ETag and canonical article/heading identifiers; generation receives only server-validated, numbered evidence. Luna returns strict claim objects with evidence numbers, and the provider constructs `[n]` markers server-side. The model cannot supply source URLs or public follow-up text. Empty or stale retrieval produces a server-owned no-evidence response rather than uncited generated text.

The zero-cost Azure AI Search foundation is:

- Service: `cvkeresearch-search`
- Region: Canada Central
- Tier: Free
- Production index: `research-chunks-v2` (with `research-chunks-v1` retained for rollback)
- Authentication: Microsoft Entra ID only; local API-key authentication is disabled

The App Service managed identity has **Search Index Data Reader**. A separate indexing identity needs **Storage Blob Data Reader**, **Search Service Contributor**, and **Search Index Data Contributor**. Free Search cannot use an outbound managed identity, so the heading-aware indexing command reads Blob Storage and pushes chunks to Search using the caller's `DefaultAzureCredential`:

```sh
npm run research:index
```

Standard production retrieval uses one Azure AI Search hybrid request: the keyword query plus a 1,536-dimension `contentVector` query. Every v2 chunk is embedded from a deterministic title, heading path, heading label, and bounded chunk representation; the indexer validates every vector locally and again after upload. A deterministic nine-query evaluation requires every expected article to appear in the eight-chunk evidence window in both modes; hybrid retrieval currently ranks the primary expected article first for all nine queries, with no scope or stale-grounding leakage. `research-chunks-v1` remains the rollback index.

Library comparisons are catalog-aware. When a question explicitly names two or more published notes, retrieval runs one filtered hybrid search per note and interleaves their ranked chunks before the eight-evidence grounding limit. Ambiguous comparison wording expands to 32 candidates and caps any one article at half of the final evidence window. The retrieval evaluation includes a two-article vitamin C/vitamin D regression and fails unless every expected article is represented.

Index synchronization enumerates every existing document before removing stale chunks, checks each per-document result, and retries only transient Azure AI Search failures. The command exits unsuccessfully if any embedding or indexing action remains failed; it must not be treated as successful from its HTTP status alone.

### Luna answer generation

The answer provider uses a dedicated Azure OpenAI account and the pinned `research-luna-2026-07-09` deployment. The account has local authentication disabled, and the App Service managed identity has only **Cognitive Services OpenAI User** at the account scope. Responses use `store: false`, no tools, low reasoning effort, a bounded output budget, and a strict JSON schema. Global Standard inference can be processed outside the resource's Canada Central geography; do not describe this deployment as Canada-only processing.

The assistant is fail-closed and needs all of these nonsecret settings:

- `RESEARCH_ASSISTANT_ENABLED`: explicit rollout and rollback switch. Only `true` enables the provider; missing or `false` keeps the existing unavailable UI.
- `AZURE_OPENAI_ENDPOINT`: HTTPS endpoint for the Entra-only OpenAI account.
- `AZURE_OPENAI_DEPLOYMENT`: deployed model name, currently `research-luna-2026-07-09`.
- `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`: nonsecret embedding deployment name, currently `research-embedding-3-small`.
- `AZURE_SEARCH_ENDPOINT`: HTTPS endpoint for `cvkeresearch-search`.
- `AZURE_SEARCH_INDEX`: index name, currently `research-chunks-v2`.
- `RESEARCH_RETRIEVAL_MODE`: exactly `keyword` (safe default/rollback) or `hybrid` (current production mode). If an embedding request is unavailable, hybrid deliberately falls back to keyword retrieval and emits only mode/category/count/duration telemetry.
- `RESEARCH_ASSISTANT_DAILY_LIMIT`: optional attempted-provider-start limit per UTC day; defaults to 25 and is bounded from 1 through 250.

Do not add API-key settings. `DefaultAzureCredential` obtains Search and Cognitive Services bearer tokens.

Assistant requests are limited to five per minute per client, one provider call at a time globally, and 25 attempted provider starts per UTC day by default. Daily and concurrency state stores counts only. On Azure App Service the application trusts the immediate platform proxy so client addresses remain distinct. These controls are deliberately bounded and in-process for the current single-instance B1 plan; configure shared limits before scaling to multiple application instances. Provider throttling, upstream failures, timeouts, and invalid grounding return distinct public-safe JSON errors and never fall through to the HTML error page.

The browser waits for the complete validated JSON answer; model tokens are not streamed before citations are verified. It applies a 45-second deadline, exposes accessible busy/retry states, and never displays non-JSON upstream response bodies.

### Public guardrail modes

`POST /research/ask` accepts an optional `guardrailMode` field with exactly two values:

- `standard`: the default. It applies the assistant's conservative health-language restrictions and can return a server-owned guardrail refusal.
- `experimental`: a public experiment control for this personal research project. It relaxes only the answer-writing health-language restrictions so the project owner can compare grounded answer behavior.

Any other value is rejected with HTTP 400 and `invalid_guardrail_mode`. Successful JSON responses echo the selected `guardrailMode` and use one of three statuses: `answered`, `no_evidence`, or `guardrail_refusal`. No-evidence and refusal responses use different fixed server-owned messages, with no sources or generated follow-ups, so a policy refusal is not misrepresented as a retrieval miss.

Experimental mode is not a security, citation, or privacy bypass. Both modes use the same current-ETag and real-heading validation, article-scope enforcement, structured model output, server-constructed citations, managed identity, same-origin check, per-client rate limit, global concurrency limit, UTC daily cost limit, no-store response handling, and content-safe logging. The research-not-medical-advice notice also remains present in both modes. Do not submit personal medical details or use either mode for health decisions.

Example request:

```json
{
  "question": "What limitations does this note identify?",
  "scope": "article",
  "slug": "a-useful-research-note",
  "guardrailMode": "experimental"
}
```

### Local development

1. Install dependencies with `npm install`.
2. Sign in with `az login` and select a subscription with `az account set --subscription "<subscription name or id>"`.
3. Confirm that the signed-in identity has **Storage Blob Data Reader**, **Search Index Data Reader**, and **Cognitive Services OpenAI User** on the scoped research resources.
4. Leave `RESEARCH_ASSISTANT_ENABLED` unset for viewer-only development, or export the nonsecret settings above to exercise the live provider.
5. Run `npm start`.

`DefaultAzureCredential` will use the Azure CLI session locally and the managed identity in App Service. Do not create a local account-key or connection-string file.

## Verification

Run the complete project gate with:

```sh
npm run check
```

The tests are offline and inject credentials and HTTP clients. They cover research viewing, XSS sanitization, Search scoping, strict model output, citation validation, stale/cross-article evidence, provider failures, rate/cost guards, frontend timeouts, accessibility, and safe error rendering.

## User research submissions (local MVP)

The app now contains a feature-gated Google-only submission workflow. It is disabled unless `RESEARCH_SUBMISSIONS_ENABLED=true`. When enabled, authenticated users can upload one UTF-8 `.md` file, inspect the same sanitized renderer used by the public library, submit it for review, and see only their own records. The sole administrator is matched only by the immutable Google `sub` configured in `ADMIN_GOOGLE_SUB`.

Pending content is stored in the private submission repository and is never passed to the public Blob adapter, Search adapter, research repository, or assistant. The publication coordinator is the only promotion boundary. Approval validates and normalizes the reviewed Markdown, reserves a stable collision-safe slug, conditionally writes the Blob, reads its immutable operation/content metadata back, and durably marks the record `published`. The public library can list and render that verified Blob immediately.

Embeddings and Azure AI Search are a separate resumable phase with independent `pending`, `indexing`, `ready`, and `failed` states. A Search or embedding failure leaves the verified Markdown public. The assistant evidence resolver rejects reviewed-submission chunks until the record is both fully indexed and verified as `ready`, including when a failed Search request left partial documents behind. Embedding vectors are checkpointed in the private `SUBMISSION_DATA_FILE` after each completed section, never logged, reused after restart/retry, and erased after successful indexing or deletion. Deletion is permitted from partial states and removes all Search documents before removing the owned public Blob.

### Required configuration

Use App Service configuration or a private local environment; never commit values. The required setting names are listed below.

- `RESEARCH_SUBMISSIONS_ENABLED=true` enables routes and the archive call to action.
- `GOOGLE_OIDC_CLIENT_ID`, `GOOGLE_OIDC_CLIENT_SECRET`, and `GOOGLE_OIDC_REDIRECT_URI` configure an authorization-code Google OIDC client. Production redirect URIs must use HTTPS.
- `ADMIN_GOOGLE_SUB` is the one administrator's immutable Google subject, not an email or display name.
- `SUBMISSION_DATA_FILE` is an absolute path on the App Service private persistent data mount. The repository writes with directory mode `0700`, file mode `0600`, and atomic replacement.
- `SUBMISSION_PUBLISHING_ENABLED=true` enables the managed-identity public Blob and Search adapters. Blob publication can succeed while AI indexing is unavailable, but the configured identity still needs the scoped permissions for both phases.
- `SUBMISSION_ACCOUNT_DAILY_LIMIT`, `SUBMISSION_IP_DAILY_LIMIT`, `SUBMISSION_SESSION_TTL_MS`, and `SUBMISSION_MAX_SESSIONS` are optional and strictly bounded.

Publishing uses the existing `AZURE_STORAGE_ACCOUNT_NAME`, `AZURE_STORAGE_CONTAINER`, `AZURE_SEARCH_ENDPOINT`, `AZURE_SEARCH_INDEX`, `AZURE_OPENAI_ENDPOINT`, and `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` settings. It rejects API keys, SAS tokens, and storage connection strings. The App Service managed identity needs the least-privilege data-plane roles required to write/delete reviewed public blobs, write/delete Search documents, and call the embedding deployment. Those role changes are not part of this local implementation and must be reviewed before deployment.

### Security, deletion, and retention

- Sessions are opaque, server-side, bounded, rotated after login, expire after eight hours by default, and use `HttpOnly`, `SameSite=Lax`, production-`Secure` cookies. Login attempts expire after ten minutes and bind state, nonce, and S256 PKCE through `openid-client`.
- Every state-changing browser form requires a session-bound CSRF token and a same-origin `Origin` or `Referer`. Production submission routes reject a non-HTTPS request behind the trusted App Service proxy.
- Upload parsing permits one file and one CSRF field, enforces 3 MiB while streaming, then validates the actual bytes as fatal UTF-8 text with no NUL/binary controls and bounded front matter. Original filenames are never persisted.
- The in-process account/IP quota defaults to 5/20 upload attempts per 24 hours. Sessions and quotas assume the current single App Service instance; replace them with a shared store before horizontal scaling.
- Pending records remain private until submitted, replaced, or deleted. Rejected and pre-publication failed records remain private. A published record remains readable during pending, active, or failed AI indexing. Owner/admin status views show public availability separately from AI readiness.
- Publication and indexing telemetry contains only stage, safe category, count, duration, and status fields. Markdown, embedding inputs, vectors, answers, credentials, and raw Azure response bodies are not logged.
- Deletion retains only an opaque tombstone needed for state/slug safety. It scrubs the owner identifier, Markdown, parsed metadata, and rejection reason. Deleted records are excluded from normal owner/admin lists.
- The file repository is the smallest durable single-instance MVP abstraction. Before multi-instance or higher-volume use, replace it behind the existing repository interface with a concurrency-safe private store; do not use the failed/unused Cosmos account by default.

No Azure resources are provisioned or mutated merely by installing or testing this code. All tests use injected repositories and fake publication adapters.

### Version-1 record recovery

The version-2 repository reads existing version-1 files and adds independent publication/indexing checkpoints without changing owner data or slug reservations. Existing `published` records migrate to public + AI-ready. Legacy `embedding_pending`/`embedding` records are resumed through the public-Blob phase first. A legacy `publishing` + `cleanup_required` record migrates conservatively to public verification required + AI indexing failed; it is not assumed public merely from the old checkpoint.

For the current production recovery record, after an independently reviewed deployment:

1. Back up the private `SUBMISSION_DATA_FILE` and keep the existing App Service managed-identity roles and settings unchanged.
2. Start the upgraded single instance. Startup recovery will read the reserved slug, verify the Blob's operation hash and normalized-content hash, write it only when absent, then durably activate public visibility.
3. If automatic recovery remains at **Publishing public Markdown**, use the admin **Retry public publication** action. A metadata collision is fail-closed; inspect the existing Blob ownership rather than deleting or overwriting it.
4. Once the UI shows **Published**, the note is readable. If it also shows **AI indexing failed**, use **Retry AI indexing**; the retry reuses any durable embedding checkpoint and repairs/verifies Search without rewriting or unpublishing the Blob.
5. Confirm the public `/research` listing and article route separately from the **AI ready** state before treating assistant retrieval as recovered.

These are deployment-time recovery steps only. This repository change does not perform them, deploy code, or alter Azure/production state.
