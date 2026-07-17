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
