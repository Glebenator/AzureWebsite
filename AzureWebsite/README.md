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

Production retrieval uses one Azure AI Search hybrid request: the keyword query plus a 1,536-dimension `contentVector` query. Every v2 chunk is embedded from a deterministic title, heading path, heading label, and bounded chunk representation; the indexer validates every vector locally and again after upload. A deterministic eight-query evaluation improved top-1 expected retrieval from 7/8 to 8/8, with no scope or stale-grounding leakage. `research-chunks-v1` remains the rollback index.

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
