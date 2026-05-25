import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const providers = loader.loadModule("src/lib/providers/llm.ts");
const proxy = loader.loadModule("src/lib/providers/proxy.ts");
const providerUtils = loader.loadModule("src/pages/settings/providerUtils.ts");

test("proxy base URL builder validates upstream URLs and carries origin separately", () => {
  assert.deepEqual(
    proxy.buildProxyBaseUrl("codex", "https://api.openai.com/v1/responses", "http://127.0.0.1:18080/"),
    {
      baseUrl: "http://127.0.0.1:18080/proxy/codex/v1/responses",
      upstreamOrigin: "https://api.openai.com",
    },
  );

  assert.throws(
    () => proxy.buildProxyBaseUrl("codex", "https://user:pass@example.com/v1", "http://proxy"),
    /embedded username or password/,
  );
  assert.throws(
    () => proxy.buildProxyBaseUrl("codex", "https://example.com/v1?x=1", "http://proxy"),
    /query parameters or fragments/,
  );
  assert.throws(
    () => proxy.buildProxyBaseUrl("codex", "not-a-url", "http://proxy"),
    /absolute URL/,
  );
});

test("image proxy URL builder encodes the source URL", () => {
  assert.equal(
    proxy.buildImageProxyUrl("https://example.com/path/photo.png?size=large#view", "http://127.0.0.1:18080/"),
    "http://127.0.0.1:18080/image-proxy?url=https%3A%2F%2Fexample.com%2Fpath%2Fphoto.png%3Fsize%3Dlarge%23view",
  );
  assert.throws(
    () => proxy.buildImageProxyUrl("file:///tmp/photo.png", "http://proxy"),
    /http:\/\/ or https:\/\//,
  );
  assert.throws(
    () => proxy.buildImageProxyUrl("https://user:pass@example.com/photo.png", "http://proxy"),
    /embedded username or password/,
  );
});

test("provider request helpers normalize auth, metadata, errors, and model values", () => {
  assert.deepEqual(providers.buildDualAuthHeaders("secret"), {
    Authorization: "Bearer secret",
    "x-api-key": "secret",
  });
  assert.deepEqual(providers.buildGeminiAuthHeaders("secret"), {
    "x-goog-api-key": "secret",
  });
  assert.deepEqual(providers.buildProviderAuthHeaders("gemini", "secret"), {
    "x-goog-api-key": "secret",
  });
  assert.deepEqual(providers.buildProviderAuthHeaders("codex", "secret"), {
    Authorization: "Bearer secret",
    "x-api-key": "secret",
  });
  assert.equal(providers.toSimpleStreamReasoning("off"), undefined);
  assert.equal(providers.toSimpleStreamReasoning("high"), "high");
  assert.deepEqual(providers.buildProviderRequestMetadata("claude_code", " session-1 "), {
    user_id: "session-1",
  });
  assert.equal(providers.buildProviderRequestMetadata("codex", "session-1"), undefined);
  assert.equal(
    providers.providerSupportsNativeWebSearch("codex", "openai-responses"),
    true,
  );
  assert.equal(
    providers.providerSupportsNativeWebSearch("claude_code", "anthropic-messages"),
    true,
  );
  assert.equal(
    providers.providerSupportsNativeWebSearch("gemini", "google-generative-ai"),
    true,
  );
  assert.equal(
    providers.providerSupportsNativeWebSearch("codex", "openai-completions"),
    false,
  );
  assert.equal(
    providers.providerSupportsNativeWebSearch("codex", "openai-completions", {
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-4o-search-preview",
    }),
    true,
  );
  assert.equal(
    providers.providerSupportsNativeWebSearch("codex", "openai-completions", {
      baseUrl: "https://api.example.test/v1",
      modelId: "gpt-4o-search-preview",
    }),
    true,
  );
  assert.equal(
    providers.providerSupportsNativeWebSearch("codex", "openai-completions", {
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-4o",
    }),
    false,
  );
  assert.equal(providers.toModelValue("provider", "model::with::separator"), "provider::model::with::separator");
  assert.deepEqual(providers.parseModelValue("provider::model::with::separator"), {
    customProviderId: "provider",
    model: "model::with::separator",
  });
  assert.equal(providers.parseModelValue("bad"), null);
  assert.equal(
    providers.normalizeErrorMessage('prefix {"error":{"message":"nested failure"}}'),
    "nested failure",
  );
});

test("gemini models use native google api metadata", () => {
  const model = providers.createModelFromConfig(
    "gemini",
    "gemini-3.5-flash",
    "http://127.0.0.1:18080/proxy/gemini",
    undefined,
    { id: "gemini-3.5-flash", contextWindow: 123_456, maxOutputToken: 7_890 },
  );

  assert.equal(model.api, "google-generative-ai");
  assert.equal(model.provider, "google");
  assert.equal(model.baseUrl, "http://127.0.0.1:18080/proxy/gemini/v1beta");
  assert.equal(model.contextWindow, 123_456);
  assert.equal(model.maxTokens, 7_890);
  assert.deepEqual(model.input, ["text", "image"]);
});

test("custom Codex Responses models prefer native image-capable input metadata", () => {
  const model = providers.createModelFromConfig(
    "codex",
    "custom-responses-model",
    "https://api.openai.com/v1",
    "openai-responses",
  );

  assert.equal(model.api, "openai-responses");
  assert.deepEqual(model.input, ["text", "image"]);
});

test("custom Codex models append v1 to bare and prefixed base URLs", () => {
  const bare = providers.createModelFromConfig(
    "codex",
    "custom-responses-model",
    "https://api.openai.com",
    "openai-responses",
  );
  const prefixed = providers.createModelFromConfig(
    "codex",
    "custom-responses-model",
    "https://openrouter.ai/api",
    "openai-responses",
  );
  const proxied = providers.createModelFromConfig(
    "codex",
    "custom-chat-model",
    "http://127.0.0.1:18080/proxy/codex",
    "openai-completions",
    undefined,
    "https://api.openai.com",
  );

  assert.equal(bare.baseUrl, "https://api.openai.com/v1");
  assert.equal(prefixed.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(proxied.baseUrl, "http://127.0.0.1:18080/proxy/codex/v1");
});

test("custom Codex Chat Completions models keep text-only input metadata", () => {
  const model = providers.createModelFromConfig(
    "codex",
    "custom-chat-model",
    "https://api.openai.com/v1",
    "openai-completions",
  );

  assert.equal(model.api, "openai-completions");
  assert.deepEqual(model.input, ["text"]);
});

test("custom Codex Chat Completions GPT vision models infer image input metadata", () => {
  const model = providers.createModelFromConfig(
    "codex",
    "gpt-5.5",
    "https://api.openai.com/v1",
    "openai-completions",
  );

  assert.equal(model.api, "openai-completions");
  assert.deepEqual(model.input, ["text", "image"]);
});

test("custom Codex Chat Completions search preview models stay text-only", () => {
  const model = providers.createModelFromConfig(
    "codex",
    "gpt-4o-search-preview",
    "https://api.openai.com/v1",
    "openai-completions",
  );

  assert.equal(model.api, "openai-completions");
  assert.deepEqual(model.input, ["text"]);
});

test("custom Codex Chat Completions models infer reasoning-capable IDs", () => {
  const model = providers.createModelFromConfig(
    "codex",
    "deepseek-v4-flash",
    "https://api.example.test/v1",
    "openai-completions",
  );

  assert.equal(model.api, "openai-completions");
  assert.equal(model.reasoning, true);
  assert.equal(model.compat.supportsDeveloperRole, false);
  assert.equal(model.compat.supportsStore, false);
});

test("custom Codex Chat Completions models behind proxy use upstream compat detection", () => {
  const model = providers.createModelFromConfig(
    "codex",
    "deepseek-v4-flash",
    "http://127.0.0.1:18080/proxy/codex/v1",
    "openai-completions",
    undefined,
    "https://www.packyapi.com/v1",
  );

  assert.equal(model.api, "openai-completions");
  assert.equal(model.compat.supportsDeveloperRole, false);
  assert.equal(model.compat.supportsStore, false);
});

test("official OpenAI Chat Completions models behind proxy keep native compat", () => {
  const model = providers.createModelFromConfig(
    "codex",
    "gpt-5.5",
    "http://127.0.0.1:18080/proxy/codex/v1",
    "openai-completions",
    undefined,
    "https://api.openai.com/v1",
  );

  assert.equal(model.api, "openai-completions");
  assert.equal(model.compat, undefined);
});

test("Codex Chat Completions streams forward reasoning effort", () => {
  let captured;
  const localLoader = createTsModuleLoader({
    mocks: {
      "@mariozechner/pi-ai/openai-completions": {
        streamOpenAICompletions(model, context, options) {
          captured = { model, context, options };
          return { mocked: true };
        },
      },
    },
  });
  const localProviders = localLoader.loadModule("src/lib/providers/llm.ts");
  const model = localProviders.createModelFromConfig(
    "codex",
    "deepseek-v4-flash",
    "https://api.example.test/v1",
    "openai-completions",
  );

  const result = localProviders.streamSimpleByApi(
    model,
    { messages: [] },
    { reasoning: "high", toolChoice: "auto" },
  );

  assert.deepEqual(result, { mocked: true });
  assert.equal(captured.options.reasoningEffort, "high");
  assert.equal(captured.options.toolChoice, "auto");
});

test("gemini model base URL normalizes full generate endpoints", () => {
  const model = providers.createModelFromConfig(
    "gemini",
    "gemini-2.5-pro",
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
  );

  assert.equal(model.baseUrl, "https://generativelanguage.googleapis.com/v1beta");
});

test("gemini model list normalization uses models array metadata", () => {
  const models = providerUtils.normalizeFetchedModels(
    [
      {
        name: "models/gemini-3.5-flash",
        inputTokenLimit: 1_048_576,
        outputTokenLimit: 65_536,
        supportedGenerationMethods: ["generateContent", "countTokens"],
      },
      {
        name: "models/text-embedding-004",
        supportedGenerationMethods: ["embedContent"],
      },
      {
        name: "models/gemini-3.5-flash",
        supportedGenerationMethods: ["generateContent"],
      },
    ],
    "gemini",
  );

  assert.deepEqual(models, [
    {
      id: "gemini-3.5-flash",
      contextWindow: 1_048_576,
      maxOutputToken: 65_536,
    },
  ]);
});

test("codex responses payloads always opt into upstream storage after previous payload hooks", async () => {
  const options = providers.finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://api.openai.com/v1",
    options: {
      onPayload: async (payload) => ({ ...payload, previousHook: true }),
    },
  });

  const nextPayload = await options.onPayload(
    { input: "hello" },
    { api: "openai-responses", provider: "openai", id: "gpt-5" },
  );

  assert.deepEqual(nextPayload, {
    input: "hello",
    previousHook: true,
    store: true,
  });
});

test("provider native web search injection is opt-in", async () => {
  const codexOptions = providers.finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://api.openai.com/v1",
    options: {},
  });
  const codexPayload = await codexOptions.onPayload(
    { input: "hello" },
    { api: "openai-responses", provider: "openai", id: "gpt-5" },
  );
  assert.equal(codexPayload.store, true);
  assert.equal(codexPayload.tools, undefined);

  const anthropicOptions = providers.finalizeProviderStreamOptions({
    providerId: "claude_code",
    baseUrl: "https://api.anthropic.com/v1",
    options: {},
  });
  assert.equal(anthropicOptions.onPayload, undefined);

  const geminiOptions = providers.finalizeProviderStreamOptions({
    providerId: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    options: {},
  });
  assert.equal(geminiOptions.onPayload, undefined);
});

test("provider payload finalization enables native web search for hosted search providers", async () => {
  const codexOptions = providers.finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://api.openai.com/v1",
    nativeWebSearch: true,
    options: {},
  });
  const codexPayload = await codexOptions.onPayload(
    { input: "hello" },
    { api: "openai-responses", provider: "openai", id: "gpt-5" },
  );
  assert.equal(codexPayload.store, true);
  assert.deepEqual(codexPayload.tools, [{ type: "web_search" }]);

  const codexChatOptions = providers.finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://api.openai.com/v1",
    nativeWebSearch: true,
    options: {},
  });
  const codexChatPayload = await codexChatOptions.onPayload(
    { messages: [{ role: "user", content: "hello" }] },
    { api: "openai-completions", provider: "openai", id: "gpt-4o-search-preview" },
  );
  assert.deepEqual(codexChatPayload.web_search_options, {
    search_context_size: "medium",
  });
  assert.equal(codexChatPayload.tools, undefined);

  const codexChatCompatiblePayload = await codexChatOptions.onPayload(
    { messages: [{ role: "user", content: "hello" }] },
    { api: "openai-completions", provider: "openai", id: "deepseek-v4-flash" },
  );
  assert.equal(codexChatCompatiblePayload.web_search_options, undefined);

  const compatibleCodexChatOptions = providers.finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://api.example.test/v1",
    nativeWebSearch: true,
    options: {},
  });
  const compatibleCodexChatPayload = await compatibleCodexChatOptions.onPayload(
    { messages: [{ role: "user", content: "hello" }] },
    { api: "openai-completions", provider: "openai", id: "deepseek-v4-flash" },
  );
  assert.deepEqual(compatibleCodexChatPayload.tools, [
    {
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web for current information when the answer needs recent or external context.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The web search query.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
  ]);
  assert.equal(compatibleCodexChatPayload.web_search_options, undefined);

  const anthropicOptions = providers.finalizeProviderStreamOptions({
    providerId: "claude_code",
    baseUrl: "https://api.anthropic.com/v1",
    nativeWebSearch: true,
    options: {},
  });
  const anthropicPayload = await anthropicOptions.onPayload(
    { messages: [{ role: "user", content: "hello" }] },
    { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet" },
  );
  assert.deepEqual(anthropicPayload.tools, [
    { type: "web_search_20250305", name: "web_search" },
  ]);

  const geminiOptions = providers.finalizeProviderStreamOptions({
    providerId: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    nativeWebSearch: true,
    options: {},
  });
  const geminiPayload = await geminiOptions.onPayload(
    { contents: [], config: {} },
    { api: "google-generative-ai", provider: "google", id: "gemini-3.5-pro" },
  );
  assert.deepEqual(geminiPayload.config.tools, [{ googleSearch: {} }]);
});

test("provider native web search avoids unsupported OpenAI minimal reasoning", async () => {
  const options = providers.finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://api.openai.com/v1",
    nativeWebSearch: true,
    options: {},
  });
  const payload = await options.onPayload(
    { input: "hello", reasoning: { effort: "minimal" } },
    { api: "openai-responses", provider: "openai", id: "gpt-5" },
  );
  assert.deepEqual(payload.reasoning, { effort: "low" });
  assert.deepEqual(payload.tools, [{ type: "web_search" }]);

  const newerModelPayload = await options.onPayload(
    { input: "hello", reasoning: { effort: "minimal" } },
    { api: "openai-responses", provider: "openai", id: "gpt-5.5" },
  );
  assert.deepEqual(newerModelPayload.reasoning, { effort: "minimal" });
  assert.deepEqual(newerModelPayload.tools, [{ type: "web_search" }]);
});

test("provider native web search injection preserves existing search tools", async () => {
  const codexOptions = providers.finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://api.openai.com/v1",
    nativeWebSearch: true,
    options: {},
  });
  const codexPayload = await codexOptions.onPayload(
    { tools: [{ type: "web_search_2025_08_26" }] },
    { api: "openai-responses", provider: "openai", id: "gpt-5" },
  );
  assert.deepEqual(codexPayload.tools, [{ type: "web_search_2025_08_26" }]);

  const compatibleCodexChatOptions = providers.finalizeProviderStreamOptions({
    providerId: "codex",
    baseUrl: "https://api.example.test/v1",
    nativeWebSearch: true,
    options: {},
  });
  const compatibleCodexChatPayload = await compatibleCodexChatOptions.onPayload(
    { tools: [{ type: "function", function: { name: "web_search" } }] },
    { api: "openai-completions", provider: "openai", id: "deepseek-v4-flash" },
  );
  assert.deepEqual(compatibleCodexChatPayload.tools, [
    { type: "function", function: { name: "web_search" } },
  ]);

  const anthropicOptions = providers.finalizeProviderStreamOptions({
    providerId: "claude_code",
    baseUrl: "https://api.anthropic.com/v1",
    nativeWebSearch: true,
    options: {},
  });
  const anthropicPayload = await anthropicOptions.onPayload(
    { tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2 }] },
    { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet" },
  );
  assert.deepEqual(anthropicPayload.tools, [
    { type: "web_search_20260209", name: "web_search", max_uses: 2 },
  ]);

  const geminiOptions = providers.finalizeProviderStreamOptions({
    providerId: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    nativeWebSearch: true,
    options: {},
  });
  const geminiPayload = await geminiOptions.onPayload(
    { config: { tools: [{ googleSearch: { searchTypes: ["WEB_SEARCH"] } }] } },
    { api: "google-generative-ai", provider: "google", id: "gemini-3.5-pro" },
  );
  assert.deepEqual(geminiPayload.config.tools, [
    { googleSearch: { searchTypes: ["WEB_SEARCH"] } },
  ]);
});

test("anthropic automatic caching uses top-level cache control for Anthropic origin", async () => {
  const options = providers.finalizeProviderStreamOptions({
    providerId: "claude_code",
    baseUrl: "https://api.anthropic.com/v1",
    options: {
      cacheRetention: "long",
    },
  });

  const payload = await options.onPayload(
    {
      messages: [{ role: "user", content: "hello" }],
    },
    { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet" },
  );

  assert.deepEqual(payload.cache_control, { type: "ephemeral", ttl: "1h" });
  assert.deepEqual(payload.messages, [
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ]);
});

test("anthropic-compatible proxies get an explicit cache breakpoint on the last cacheable block", async () => {
  const options = providers.finalizeProviderStreamOptions({
    providerId: "claude_code",
    baseUrl: "https://proxy.example.com/anthropic",
    options: {
      cacheRetention: "short",
    },
  });

  const payload = await options.onPayload(
    {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private", cache_control: { type: "old" } },
            { type: "text", text: "visible" },
          ],
        },
      ],
    },
    { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet" },
  );

  assert.equal(payload.cache_control, undefined);
  assert.equal(payload.messages[0].content[0].cache_control, undefined);
  assert.deepEqual(payload.messages[0].content[1].cache_control, { type: "ephemeral" });
});

test("deepseek anthropic replay keeps empty thinking blocks before tool use", () => {
  const context = {
    messages: [
      { role: "user", content: "inspect", timestamp: 1 },
      {
        role: "assistant",
        api: "anthropic-messages",
        provider: "anthropic",
        model: "deepseek-v4-pro",
        content: [
          { type: "thinking", thinking: "", thinkingSignature: "sig-empty-thinking" },
          {
            type: "toolCall",
            id: "call_1",
            name: "Read",
            arguments: { path: "README.md" },
          },
        ],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "Read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 3,
      },
    ],
  };
  const payload = {
    model: "deepseek-v4-pro",
    thinking: { type: "enabled", budget_tokens: 8192 },
    messages: [
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "Read",
            input: { path: "README.md" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }],
      },
    ],
  };

  const repaired = providers.repairDeepSeekAnthropicThinkingReplayPayload(
    payload,
    context,
    {
      id: "deepseek-v4-pro",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://proxy.example.com",
    },
  );

  assert.deepEqual(repaired.messages[1].content, [
    { type: "thinking", thinking: "", signature: "sig-empty-thinking" },
    {
      type: "tool_use",
      id: "call_1",
      name: "Read",
      input: { path: "README.md" },
    },
  ]);
});

test("deepseek anthropic replay repair leaves non-deepseek payloads untouched", () => {
  const payload = {
    model: "claude-sonnet-4-5",
    thinking: { type: "enabled", budget_tokens: 8192 },
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "Read", input: {} }],
      },
    ],
  };
  const repaired = providers.repairDeepSeekAnthropicThinkingReplayPayload(
    payload,
    {
      messages: [
        {
          role: "assistant",
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          content: [
            { type: "thinking", thinking: "", thinkingSignature: "sig" },
            { type: "toolCall", id: "call_1", name: "Read", arguments: {} },
          ],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          stopReason: "toolUse",
          timestamp: 1,
        },
      ],
    },
    {
      id: "claude-sonnet-4-5",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
    },
  );

  assert.equal(repaired, payload);
});

test("streaming text reconciler emits only missing final text suffixes", () => {
  const reconciler = providers.createStreamingTextReconciler();
  assert.equal(reconciler.appendDelta("round-1", "hel"), "hel");
  assert.equal(reconciler.appendDelta("round-1", "lo"), "lo");
  assert.equal(reconciler.reconcileFinalText("round-1", "hello world"), " world");
  assert.equal(reconciler.reconcileFinalText("round-1", "different"), "");
  assert.equal(reconciler.reconcileFinalText("round-2", "new"), "new");
});
