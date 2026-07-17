# AI-Configured Image Protocol

Use this flow when the provider is not a standard OpenAI-compatible Images or Responses endpoint.

## Information boundary

- Collect the Base URL, API Key, and model from the user in chat and save them together with `ImageManager(action="configure_connection", base_url=..., api_key=..., model=...)`.
- The API Key may be passed only to `configure_connection`. Never echo it in tool-facing text or a reply, include it in `adapter_json`, or write it to a file. Use only the `{{apiKey}}` placeholder in adapter headers, query parameters, or bodies.
- Ask the user for redacted API documentation, a redacted curl example, or representative request and response JSON. A complete pet requires both text-to-image generation and reference-image editing; obtain examples for both operations even when they share one URL. For an asynchronous API, obtain submit and poll examples for each operation. Do not ask the user to provide JSON extraction paths.

## Workflow

1. Call `ImageManager(action="adapter_status")`.
2. If protocol details are needed, call `ImageManager(action="adapter_schema")` for the authoritative version-1 schema.
3. Translate only the user's documented request fields into a declarative adapter. Do not invent endpoints, poll paths, or request parameters.
   - Define `generate` for prompt-only text-to-image requests.
   - Define `edit` for requests that upload reference images. It may reuse the same endpoint as `generate`, but its request must map `inputImages` (and `mask` when supported) into the provider's documented file or image fields.
4. Omit `extract` initially. Native parsing automatically scans JSON and SSE response events for image URLs, Base64 images, common task IDs, and common statuses.
5. Call `ImageManager(action="configure_adapter", adapter_json=<JSON string>)`.
6. Call `ImageManager(action="doctor")`.
7. Run the single image operation the user already requested. Its real response is the capability test; do not issue an extra paid generation merely for probing.
8. If execution fails, inspect the returned response diagnostic yourself. Update only the request template or, when necessary, add minimal `extract` compatibility hints; then re-run the original requested image operation once with the corrected adapter. Do not ask the user to decipher response fields.

## Adapter example: synchronous JSON

```json
{
  "version": 1,
  "name": "Example synchronous relay",
  "generate": {
    "mode": "sync",
    "submit": {
      "method": "POST",
      "path": "/api/generate",
      "bodyType": "json",
      "headers": { "Authorization": "Bearer {{apiKey}}" },
      "body": {
        "model_name": "{{model}}",
        "text": "{{prompt}}",
        "width": "{{width}}",
        "height": "{{height}}",
        "num_images": "{{count}}"
      }
    }
  }
}
```

## Adapter example: asynchronous JSON

```json
{
  "version": 1,
  "name": "Example asynchronous relay",
  "generate": {
    "mode": "async",
    "submit": {
      "method": "POST",
      "path": "/api/generate",
      "bodyType": "json",
      "headers": { "X-API-Key": "{{apiKey}}" },
      "body": { "model": "{{model}}", "prompt": "{{prompt}}" }
    },
    "poll": {
      "method": "GET",
      "path": "/api/tasks/{{taskId}}",
      "bodyType": "json",
      "headers": { "X-API-Key": "{{apiKey}}" },
      "body": {}
    }
  }
}
```

For multipart edits, set `bodyType` to `multipart`, put scalar fields in `body`, and declare binary parts with `files`, for example `{"field":"image","source":"inputImages"}` and `{"field":"mask","source":"mask"}`.

The adapter is data, not code. Never place JavaScript, Python, shell commands, absolute provider URLs, cookies, or credential values in it.
