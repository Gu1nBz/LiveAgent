import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function toolCall(action, extra = {}) {
  return {
    type: "toolCall",
    id: `call-${action}`,
    name: "ImageManager",
    arguments: { action, ...extra },
  };
}

test("ImageManager exposes AI-managed connection and declarative adapter actions", () => {
  const loader = createTsModuleLoader();
  const { createNativeImageTools } = loader.loadModule("src/lib/tools/nativeImageTools.ts");
  const bundle = createNativeImageTools({ workdir: "/workspace" });
  const manager = bundle.tools.find((tool) => tool.name === "ImageManager");
  assert.ok(manager);
  const actions = manager.parameters.properties.action.anyOf.map((item) => item.const);
  for (const action of [
    "configure_connection",
    "adapter_status",
    "adapter_schema",
    "configure_adapter",
    "clear_adapter",
  ]) {
    assert.ok(actions.includes(action), `missing ${action}`);
  }
  assert.ok(manager.parameters.properties.api_key);
});

test("AI connection configuration stores a user-provided key without echoing it", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          if (command === "native_image_config_get") {
            return {
              baseUrl: "https://old.example/v1",
              generationModel: "old-model",
              editModel: "old-model",
              endpointMode: "images",
              timeoutSeconds: 180,
              apiKeyConfigured: true,
              adapterConfigured: true,
              adapterName: "old adapter",
            };
          }
          if (command === "native_image_config_save") {
            return {
              baseUrl: args.request.baseUrl,
              generationModel: args.request.generationModel,
              editModel: args.request.editModel,
              endpointMode: args.request.endpointMode,
              timeoutSeconds: args.request.timeoutSeconds,
              apiKeyConfigured: true,
              adapterConfigured: false,
            };
          }
          if (command === "native_image_adapter_clear") {
            return { configured: false };
          }
          throw new Error(`unexpected command ${command}`);
        },
      },
    },
  });
  const { createNativeImageTools } = loader.loadModule("src/lib/tools/nativeImageTools.ts");
  const bundle = createNativeImageTools({ workdir: "/workspace" });
  const result = await bundle.executeToolCall(
    toolCall("configure_connection", {
      base_url: "https://relay.example/v1",
      api_key: "test-secret-key",
      model: "relay-image-model",
    }),
  );
  assert.equal(result.isError, false);
  const save = calls.find((call) => call.command === "native_image_config_save");
  assert.ok(save);
  assert.equal(save.args.request.baseUrl, "https://relay.example/v1");
  assert.equal(save.args.request.generationModel, "relay-image-model");
  assert.equal(save.args.request.apiKeyUpdate, "test-secret-key");
  assert.ok(!result.content[0].text.includes("test-secret-key"));
  assert.ok(calls.some((call) => call.command === "native_image_adapter_clear"));
});

test("AI adapter configuration parses JSON and forwards only declarative data", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          if (command === "native_image_adapter_save") {
            return { configured: true, adapter: args.adapter };
          }
          throw new Error(`unexpected command ${command}`);
        },
      },
    },
  });
  const { createNativeImageTools } = loader.loadModule("src/lib/tools/nativeImageTools.ts");
  const bundle = createNativeImageTools({ workdir: "/workspace" });
  const adapter = {
    version: 1,
    name: "Async relay",
    generate: {
      mode: "async",
      submit: { method: "POST", path: "/generate", body: { prompt: "{{prompt}}" } },
      poll: { method: "GET", path: "/task/{{taskId}}", body: {} },
      extract: {
        taskId: "$.id",
        status: "$.status",
        outputs: ["$.images[*]"],
        successStatuses: ["done"],
        failureStatuses: ["failed"],
      },
    },
  };
  const result = await bundle.executeToolCall(
    toolCall("configure_adapter", { adapter_json: JSON.stringify(adapter) }),
  );
  assert.equal(result.isError, false);
  assert.deepEqual(calls[0], {
    command: "native_image_adapter_save",
    args: { adapter },
  });
});
