import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";
import { type TProperties, Type } from "typebox";

import { type BuiltinToolBundle, createBuiltinMetadataMap } from "./builtinTypes";

export type NativeImageJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type NativeImageOutput = {
  path: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
};

export type NativeImageJobSnapshot = {
  id: string;
  kind: "generate" | "edit";
  status: NativeImageJobStatus;
  createdAt: number;
  updatedAt: number;
  outputs: NativeImageOutput[];
  error?: string | null;
};

export type NativeImageDoctorResult = {
  ok: boolean;
  baseUrl: string;
  endpoint: string;
  statusCode?: number | null;
  latencyMs: number;
  apiKeyConfigured: boolean;
  message: string;
};

type NativeImageAdapterPublic = {
  configured: boolean;
  adapter?: {
    version: number;
    name: string;
    generate: unknown;
    edit?: unknown;
  } | null;
};

type NativeImageConfigPublic = {
  baseUrl: string;
  generationModel: string;
  editModel: string;
  endpointMode: "images" | "responses";
  timeoutSeconds: number;
  apiKeyConfigured: boolean;
  adapterConfigured: boolean;
  adapterName?: string | null;
};

const ADAPTER_SCHEMA_GUIDE = `LiveAgent AI image adapter schema (version 1):
{
  "version": 1,
  "name": "human-readable relay name",
  "generate": <operation>,
  "edit": <optional operation>
}
operation:
{
  "mode": "sync" | "async",
  "submit": <httpRequest>,
  "poll": <httpRequest, required for async>,
  "extract": {                         // optional compatibility hints; omit for adaptive parsing
    "taskId": "$.path",
    "status": "$.path",
    "outputs": ["$.path[*]"],
    "error": "$.path",
    "successStatuses": ["completed"],
    "failureStatuses": ["failed"],
    "pollIntervalMs": 1500,
    "maxPollAttempts": 1200
  }
}
httpRequest:
{
  "method": "GET" | "POST" | "PUT" | "PATCH",
  "path": "/same-origin/path/{{taskId}}",
  "bodyType": "json" | "multipart",
  "headers": {"Authorization": "Bearer {{apiKey}}"},
  "query": {},
  "body": {"model": "{{model}}", "prompt": "{{prompt}}"},
  "files": [{"field": "image", "source": "inputImages"}, {"field": "mask", "source": "mask"}]
}
Allowed variables: {{apiKey}}, {{model}}, {{prompt}}, {{size}}, {{width}}, {{height}}, {{quality}}, {{background}}, {{count}}, {{outputFormat}}, {{inputImages}}, {{inputImagesBase64}}, {{mask}}, {{maskBase64}}, {{taskId}}.
Exact-value placeholders preserve JSON types; embedded placeholders render as strings. LiveAgent automatically scans JSON and SSE responses for image URLs/base64 and common async task/status fields, so do not add extract JSON paths unless automatic parsing needs an explicit compatibility hint. Paths must stay under the configured Base URL. Do not include a real API key in adapter_json.`;

const TERMINAL_JOB_STATUSES = new Set<NativeImageJobStatus>(["succeeded", "failed", "cancelled"]);
const JOB_POLL_INTERVAL_MS = 750;
const JOB_WAIT_LIMIT_MS = 30 * 60 * 1_000;

function strictObject(properties: TProperties) {
  return Type.Object(properties, { additionalProperties: false });
}

function toolArgs(toolCall: ToolCall) {
  return toolCall.arguments &&
    typeof toolCall.arguments === "object" &&
    !Array.isArray(toolCall.arguments)
    ? (toolCall.arguments as Record<string, unknown>)
    : {};
}

function requiredString(args: Record<string, unknown>, key: string) {
  const value = typeof args[key] === "string" ? args[key].trim() : "";
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string) {
  const value = typeof args[key] === "string" ? args[key].trim() : "";
  return value || undefined;
}

function optionalNumber(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Cancelled"));
      return;
    }
    const timer = globalThis.setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        globalThis.clearTimeout(timer);
        reject(new Error("Cancelled"));
      },
      { once: true },
    );
  });
}

async function cancelJobQuietly(jobId: string) {
  try {
    await invoke<NativeImageJobSnapshot>("native_image_job_cancel", { jobId });
  } catch {
    // Cancellation is best effort; the original error remains authoritative.
  }
}

async function waitForJob(initial: NativeImageJobSnapshot, signal?: AbortSignal) {
  let snapshot = initial;
  const deadline = Date.now() + JOB_WAIT_LIMIT_MS;
  while (!TERMINAL_JOB_STATUSES.has(snapshot.status)) {
    if (signal?.aborted) {
      await cancelJobQuietly(snapshot.id);
      throw new Error("Cancelled");
    }
    if (Date.now() >= deadline) {
      await cancelJobQuietly(snapshot.id);
      throw new Error(`Image job ${snapshot.id} exceeded the 30 minute client wait limit`);
    }
    await wait(JOB_POLL_INTERVAL_MS, signal);
    snapshot = await invoke<NativeImageJobSnapshot>("native_image_job_status", {
      jobId: snapshot.id,
    });
  }
  return snapshot;
}

function imageRequest(args: Record<string, unknown>) {
  return {
    prompt: requiredString(args, "prompt"),
    model: optionalString(args, "model"),
    size: optionalString(args, "size"),
    quality: optionalString(args, "quality"),
    background: optionalString(args, "background"),
    outputFormat: optionalString(args, "output_format"),
    n: optionalNumber(args, "n"),
  };
}

async function exportJobOutputs(jobId: string, workspaceRoot: string, destinationDir: string) {
  return await invoke<NativeImageOutput[]>("native_image_job_export", {
    jobId,
    workspaceRoot,
    destinationDir,
  });
}

function formatJob(snapshot: NativeImageJobSnapshot) {
  const lines = [`job_id=${snapshot.id}`, `kind=${snapshot.kind}`, `status=${snapshot.status}`];
  for (const output of snapshot.outputs ?? []) {
    lines.push(
      `output=${output.path}`,
      `mime_type=${output.mimeType}`,
      `dimensions=${output.width}x${output.height}`,
      `size_bytes=${output.sizeBytes}`,
    );
  }
  if (snapshot.error) lines.push(`error=${snapshot.error}`);
  return lines.join("\n");
}

function resultMessage(
  toolCall: ToolCall,
  text: string,
  details: object,
  isError = false,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    details,
    isError,
    timestamp: Date.now(),
  };
}

const IMAGE_OUTPUT_FORMAT = Type.Union([
  Type.Literal("png"),
  Type.Literal("jpeg"),
  Type.Literal("webp"),
]);

const COMMON_IMAGE_PARAMETERS = {
  prompt: Type.String({
    description:
      "The complete authoritative visual prompt. Pass it directly, without shell quoting.",
  }),
  model: Type.Optional(Type.String()),
  size: Type.Optional(Type.String({ description: "Requested image size, for example 1024x1024." })),
  quality: Type.Optional(Type.String()),
  background: Type.Optional(
    Type.String({ description: "Background mode supported by the configured image endpoint." }),
  ),
  output_format: Type.Optional(IMAGE_OUTPUT_FORMAT),
  n: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
  destination_dir: Type.Optional(
    Type.String({
      description:
        "Existing directory inside the current workspace where completed outputs should be exported.",
    }),
  ),
};

export function createNativeImageTools(params: { workdir: string }): BuiltinToolBundle {
  const tools: Tool[] = [
    {
      name: "ImageManager",
      description:
        "Inspect LiveAgent's native image service, configure its connection from a user-provided Base URL, API key, and model, configure a validated declarative sync/async HTTP adapter, read/cancel a job, or safely export a result. A user-provided API key may be passed only to configure_connection and must never be echoed in tool-facing text or placed in adapter_json.",
      parameters: strictObject({
        action: Type.Union([
          Type.Literal("doctor"),
          Type.Literal("status"),
          Type.Literal("cancel"),
          Type.Literal("export"),
          Type.Literal("adapter_status"),
          Type.Literal("adapter_schema"),
          Type.Literal("configure_adapter"),
          Type.Literal("configure_connection"),
          Type.Literal("clear_adapter"),
          Type.Literal("clear_configuration"),
        ]),
        job_id: Type.Optional(Type.String()),
        destination_dir: Type.Optional(Type.String()),
        adapter_json: Type.Optional(
          Type.String({
            description:
              "A version-1 declarative adapter JSON document produced from the user's redacted API documentation or request/response examples. Never include credentials.",
          }),
        ),
        base_url: Type.Optional(
          Type.String({ description: "Provider Base URL. This is not a credential." }),
        ),
        api_key: Type.Optional(
          Type.String({
            description:
              "Provider API key supplied by the user for local native image configuration. Never echo it in a response or place it in adapter_json.",
          }),
        ),
        model: Type.Optional(Type.String({ description: "Image model name." })),
      }),
    },
    {
      name: "ImageGenerate",
      description:
        "Generate bitmap images through LiveAgent's configured native image service. The request runs as a cancellable background job and this call waits for its terminal result. Outputs are written to LiveAgent-managed storage and returned as absolute paths.",
      parameters: strictObject(COMMON_IMAGE_PARAMETERS),
    },
    {
      name: "ImageEdit",
      description:
        "Edit or visually transform one or more existing images through LiveAgent's configured native image service. Use this for grounded pet pose/row generation so every listed reference image is uploaded. The call waits for the cancellable job and returns managed output paths.",
      parameters: strictObject({
        ...COMMON_IMAGE_PARAMETERS,
        input_paths: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }),
        mask_path: Type.Optional(Type.String()),
      }),
    },
  ];

  async function executeToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    try {
      const args = toolArgs(toolCall);
      if (toolCall.name === "ImageManager") {
        const action = requiredString(args, "action");
        if (action === "doctor") {
          const doctor = await invoke<NativeImageDoctorResult>("native_image_doctor");
          return resultMessage(
            toolCall,
            [
              `configured=${doctor.apiKeyConfigured && Boolean(doctor.baseUrl)}`,
              `ok=${doctor.ok}`,
              `endpoint=${doctor.endpoint || "(not configured)"}`,
              doctor.statusCode == null ? "" : `status_code=${doctor.statusCode}`,
              `latency_ms=${doctor.latencyMs}`,
              `message=${doctor.message}`,
            ]
              .filter(Boolean)
              .join("\n"),
            doctor,
            !doctor.ok,
          );
        }
        if (action === "adapter_schema") {
          return resultMessage(toolCall, ADAPTER_SCHEMA_GUIDE, { version: 1 });
        }
        if (action === "adapter_status") {
          const status = await invoke<NativeImageAdapterPublic>("native_image_adapter_get");
          return resultMessage(
            toolCall,
            status.configured
              ? `adapter_configured=true\nadapter_name=${status.adapter?.name ?? "(unnamed)"}\nadapter_version=${status.adapter?.version ?? 1}`
              : "adapter_configured=false\nBuilt-in OpenAI Images/Responses behavior remains available until an AI adapter is saved.",
            status,
          );
        }
        if (action === "configure_connection") {
          const current = await invoke<NativeImageConfigPublic>("native_image_config_get");
          const baseUrl = requiredString(args, "base_url");
          const apiKey = requiredString(args, "api_key");
          const model = requiredString(args, "model");
          let saved = await invoke<NativeImageConfigPublic>("native_image_config_save", {
            request: {
              baseUrl,
              generationModel: model,
              editModel: model,
              apiKeyUpdate: apiKey,
              endpointMode: current.endpointMode,
              timeoutSeconds: current.timeoutSeconds,
            },
          });
          if (current.adapterConfigured && saved.baseUrl !== current.baseUrl) {
            await invoke<NativeImageAdapterPublic>("native_image_adapter_clear");
            saved = { ...saved, adapterConfigured: false, adapterName: null };
          }
          return resultMessage(
            toolCall,
            [
              `base_url=${saved.baseUrl}`,
              `model=${saved.generationModel}`,
              `api_key_configured=${saved.apiKeyConfigured}`,
              saved.apiKeyConfigured
                ? "Connection and credential saved to LiveAgent's local image configuration."
                : "Connection metadata was saved, but the native service did not confirm a configured API key.",
            ].join("\n"),
            saved,
          );
        }
        if (action === "configure_adapter") {
          const adapterJson = requiredString(args, "adapter_json");
          let adapter: unknown;
          try {
            adapter = JSON.parse(adapterJson);
          } catch (error) {
            throw new Error(`adapter_json is not valid JSON: ${asErrorMessage(error)}`);
          }
          const saved = await invoke<NativeImageAdapterPublic>("native_image_adapter_save", {
            adapter,
          });
          return resultMessage(
            toolCall,
            `adapter_configured=true\nadapter_name=${saved.adapter?.name ?? "(unnamed)"}\nThe adapter passed native validation. Call doctor, then run one requested image job to validate the real upstream response.`,
            saved,
          );
        }
        if (action === "clear_adapter") {
          const cleared = await invoke<NativeImageAdapterPublic>("native_image_adapter_clear");
          return resultMessage(
            toolCall,
            "adapter_configured=false\nThe custom adapter was cleared; built-in OpenAI-compatible behavior is active.",
            cleared,
          );
        }
        if (action === "clear_configuration") {
          const cleared = await invoke<NativeImageConfigPublic>("native_image_config_clear");
          return resultMessage(
            toolCall,
            [
              "configuration_cleared=true",
              "configured=false",
              `api_key_configured=${cleared.apiKeyConfigured}`,
              `adapter_configured=${cleared.adapterConfigured}`,
              "The API key, custom adapter, and connection settings were reset. Generated images and installed pets were kept.",
            ].join("\n"),
            cleared,
          );
        }
        const jobId = requiredString(args, "job_id");
        if (action === "export") {
          const destinationDir = requiredString(args, "destination_dir");
          const outputs = await exportJobOutputs(jobId, params.workdir, destinationDir);
          return resultMessage(
            toolCall,
            [
              `job_id=${jobId}`,
              "exported=true",
              ...outputs.flatMap((output) => [
                `output=${output.path}`,
                `mime_type=${output.mimeType}`,
                `dimensions=${output.width}x${output.height}`,
                `size_bytes=${output.sizeBytes}`,
              ]),
            ].join("\n"),
            { jobId, outputs },
          );
        }
        const command = action === "cancel" ? "native_image_job_cancel" : "native_image_job_status";
        const snapshot = await invoke<NativeImageJobSnapshot>(command, { jobId });
        return resultMessage(toolCall, formatJob(snapshot), snapshot, snapshot.status === "failed");
      }

      const request = imageRequest(args);
      let initial: NativeImageJobSnapshot;
      if (toolCall.name === "ImageGenerate") {
        initial = await invoke<NativeImageJobSnapshot>("native_image_generate_start", { request });
      } else if (toolCall.name === "ImageEdit") {
        const inputPaths = Array.isArray(args.input_paths)
          ? args.input_paths
              .filter((value): value is string => typeof value === "string")
              .map((value) => value.trim())
              .filter(Boolean)
          : [];
        if (inputPaths.length === 0) throw new Error("input_paths must contain at least one image");
        initial = await invoke<NativeImageJobSnapshot>("native_image_edit_start", {
          request: {
            ...request,
            workspaceRoot: params.workdir,
            inputPaths,
            maskPath: optionalString(args, "mask_path"),
          },
        });
      } else {
        throw new Error(`Unknown tool: ${toolCall.name}`);
      }

      let snapshot = await waitForJob(initial, signal);
      const destinationDir = optionalString(args, "destination_dir");
      if (snapshot.status === "succeeded" && destinationDir) {
        const outputs = await exportJobOutputs(snapshot.id, params.workdir, destinationDir);
        snapshot = { ...snapshot, outputs };
      }
      const failed = snapshot.status !== "succeeded";
      return resultMessage(toolCall, formatJob(snapshot), snapshot, failed);
    } catch (error) {
      return resultMessage(toolCall, asErrorMessage(error), {}, true);
    }
  }

  return {
    groupId: "system",
    tools,
    executeToolCall,
    metadataByName: createBuiltinMetadataMap(
      tools.map((tool) => [
        tool.name,
        {
          groupId: "system" as const,
          kind: "native_image",
          // ImageManager also exposes cancellation, so the bundle must not be
          // admitted into readonly subagent contexts.
          isReadOnly: false,
          displayCategory: "system" as const,
        },
      ]),
    ),
  };
}
