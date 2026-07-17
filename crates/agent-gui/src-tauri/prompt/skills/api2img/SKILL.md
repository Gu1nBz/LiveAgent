---
name: api2img
description: Generate or edit ordinary bitmap images with LiveAgent's native image tools. For LiveAgent pet creation or repair, hatch-pet is the orchestrator and api2img is only its image layer.
license: MIT
allowed-tools: ImageManager ImageGenerate ImageEdit Image Read Write
metadata:
  short-description: Native image generation and editing
---

# api2img

Use LiveAgent's structured image tools. Never install or invoke an external image CLI or runtime, shell HTTP client, browser automation, or an agent-specific image tool.

When the requested deliverable is a new, repaired, validated, packaged, or installed LiveAgent pet, load and follow `hatch-pet` first. Do not reduce that request to one image; this Skill provides only the visual generation/edit layer inside the hatch workflow.

## Required gate

1. Call `ImageManager(action="doctor")` before the first generation or edit in a task.
2. Continue only when the result reports that image generation is configured and ready.
3. If configuration is missing, ask the user in chat for the Base URL, API Key, and model, then save all three together with `ImageManager(action="configure_connection", base_url=..., api_key=..., model=...)`.
4. Pass the API Key only to `configure_connection`. Never repeat it in a reply, write it to a file, or include it in `adapter_json`; the native service stores it in LiveAgent's local configuration.
5. If the relay uses non-standard request parameters, synchronous responses, or asynchronous submit/poll responses, follow `references/ai-adapter.md`. Ask for redacted API documentation or redacted request/response examples, then create a declarative adapter with `ImageManager`; never write or execute adapter code.

LiveAgent automatically scans JSON and SSE responses for image URLs, Base64 images, common task IDs, and common status values. Do not require the user or pre-fill `$.data.images[*].url`, `taskId`, `status`, or similar response extraction paths. Use `extract` only as a compatibility hint after a real response proves automatic parsing insufficient.

## Clearing configuration

- When the user asks to clear only the custom relay protocol, adapter, or return to built-in OpenAI-compatible request behavior, call `ImageManager(action="clear_adapter")`. Keep the current Base URL, API Key, and model.
- When the user asks to clear, delete, reset, or replace the `api2img` configuration or image service credentials, call `ImageManager(action="clear_configuration")`. This resets the API Key, adapter, Base URL, models, endpoint mode, and timeout together. It does not delete generated images or installed pets.
- After `clear_configuration`, call `ImageManager(action="doctor")` before the next image workflow and collect a new Base URL, API Key, and model when needed. Do not direct the user to a Settings page.

## Required provider capabilities

A complete pet workflow needs both of these capabilities. Explain this distinction when collecting configuration so the user knows what provider documentation to supply:

1. **Text-to-image generation** creates the pet's initial identity image and is called through `ImageGenerate`.
2. **Reference-image editing** accepts one or more input images plus a prompt and is called through `ImageEdit`. Pet animation rows depend on it to preserve the same character across poses and directions.

These may be two endpoints, such as `/images/generations` and `/images/edits`, or one endpoint that changes behavior when reference images are attached. They may also use the same model or separate provider models. Do not assume that a provider advertising image generation also supports reference-image editing.

For ordinary prompt-only image work, generation alone is sufficient. For pet creation or repair, confirm that reference-image editing is available before starting paid generation. If the protocol is non-standard, collect redacted request and response examples for **both** generation and editing, including submit and poll examples for each asynchronous operation. If the user has only a generation endpoint, explain that ordinary images can be generated but a consistent complete animated pet cannot be produced yet.

## Choose the operation

- Use `ImageGenerate` for a new image that has no source image.
- Use `ImageEdit` whenever one or more source images define identity, composition, style, layout, or content. Pass every required source through `input_paths`.
- Use `mask_path` only when the user supplies or explicitly requests a mask-driven edit.
- Do not substitute screenshots, SVG, HTML/canvas rendering, or local procedural drawing when the request is for generated bitmap art.

## Native calls

`ImageGenerate` accepts `prompt` plus optional `model`, `size`, `quality`, `background`, `output_format`, `n`, and `destination_dir`.

`ImageEdit` accepts the same fields plus required `input_paths` and optional `mask_path`.

Use `png` when transparency or lossless downstream processing matters; otherwise use the user's requested format. Request only the number of outputs needed. Put the complete visual specification, constraints, and negative requirements in `prompt`.

When a later native workflow needs the file, pass an existing directory inside the active workspace as `destination_dir`. Create that directory through `Write` by writing a small workflow manifest inside it; do not create directories with shell commands. The native tool exports the completed output there and returns the workspace path. If a known completed job needs an export retry, use `ImageManager(action="export", job_id="...", destination_dir=<existing workspace directory>)`.

The tools wait for the native asynchronous job to finish and return absolute output paths. Use those exact paths in later `Image`, `ImageEdit`, or workflow-specific calls. `ImageManager(action="status", job_id="...")` and `ImageManager(action="cancel", job_id="...")` are for an explicitly known job id; do not invent one.

## Result handling

- Visually inspect outputs when quality or fidelity matters.
- For edits, preserve unmentioned identity and composition details.
- Report or attach the resulting file rather than only describing it.
- Never reveal provider credentials, internal authorization headers, or secret-storage values.

See `NOTICE.txt` and `LICENSE.txt` for the origin and license of this LiveAgent-native adaptation.
