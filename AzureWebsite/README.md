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

The internal provider boundary separates retrieval from generation. Retrieval supplies indexed chunks with their Blob ETag and canonical article/heading identifiers; generation receives only server-validated, numbered evidence and returns answer text with `[n]` markers. The model cannot supply source URLs. Empty or stale retrieval produces a server-owned no-evidence response rather than uncited generated text.

The zero-cost Azure AI Search foundation is:

- Service: `cvkeresearch-search`
- Region: Canada Central
- Tier: Free
- Index: `research-chunks-v1`
- Authentication: Microsoft Entra ID only; local API-key authentication is disabled

The App Service managed identity has **Search Index Data Reader**. A separate indexing identity needs **Storage Blob Data Reader**, **Search Service Contributor**, and **Search Index Data Contributor**. Free Search cannot use an outbound managed identity, so the heading-aware indexing command reads Blob Storage and pushes chunks to Search using the caller's `DefaultAzureCredential`:

```sh
npm run research:index
```

The index includes a nullable 1,536-dimension vector field for a future embedding deployment. Until a text embedding and answer model are explicitly provisioned, the source chunks remain keyword-searchable and the public Ask controls remain disabled rather than presenting ungrounded output.

Index synchronization enumerates every existing document before removing stale chunks, checks each per-document result, and retries only transient Azure AI Search failures. The command exits unsuccessfully if any action remains failed; it must not be treated as successful from its HTTP status alone.

Assistant requests are limited to five per minute per client. On Azure App Service the application trusts the immediate platform proxy so client addresses remain distinct. The limiter is deliberately bounded and in-process for the current single-instance B1 plan; configure a shared limiter before scaling to multiple application instances.

### Local development

1. Install dependencies with `npm install`.
2. Sign in with `az login` and select a subscription with `az account set --subscription "<subscription name or id>"`.
3. Confirm that the signed-in identity can read blobs in the storage account.
4. Run `npm start`.

`DefaultAzureCredential` will use the Azure CLI session locally and the managed identity in App Service. Do not create a local account-key or connection-string file.

## Verification

Run the complete project gate with:

```sh
npm run check
```

The focused tests cover research listing, Markdown article rendering, missing-slug behavior, XSS sanitization, and storage failures with mocked Blob clients.
