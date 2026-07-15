---
name: hatch-pet
description: Create, repair, validate, package, install, and activate LiveAgent v2 animated pets from prompts, reference art, brands, or existing pet assets.
license: Apache-2.0
allowed-tools: Read Write Image ImageManager ImageGenerate ImageEdit PetManager
metadata:
  short-description: Hatch LiveAgent animated pets
---

# Hatch Pet

Create a production-ready LiveAgent pet, not a single mascot picture. A completed run has one approved identity image, 11 approved animation-row strips, and a successful native build, validation, atomic installation, and activation through `PetManager`.

## Read first

Read these with `Read` before generation:

- `skill://hatch-pet/references/liveagent-pet-contract.md`
- `skill://hatch-pet/references/animation-rows.md`
- `skill://hatch-pet/references/workflow.md`
- `skill://hatch-pet/references/visual-generation.md`
- `skill://hatch-pet/references/qa-rubric.md`

## Non-negotiable gates

1. Call `ImageManager(action="doctor")`. Continue only when it reports ready. A complete pet requires both text-to-image generation for the initial identity and reference-image editing for consistent animation rows. If connection metadata is missing, follow api2img's chat configuration flow: ask for Base URL, API Key, and model, then pass them to `configure_connection` without echoing the key. For a non-standard relay, explicitly collect and configure the documented request/response formats for both generation and editing; the two operations may use separate endpoints or one shared endpoint. Do not start pet generation when only prompt-only generation is available.
2. Keep the run and `output_dir` inside the active workspace, normally `output/hatch-pet/<pet-id>/`. Never write directly to LiveAgent application data or its installed pets directory.
3. Use `ImageGenerate` only when creating an identity image without references. Use `ImageEdit` whenever references exist and for every row strip; pass all identity and continuity references through `input_paths`. Always set `destination_dir` to the prepared workspace rows directory.
4. Do not install an external runtime, invoke an image CLI, call a provider with shell HTTP, or perform local raster assembly. LiveAgent's native tools own generation, chroma removal, frame fitting, atlas assembly, canonical validation, packaging, installation, refresh, and activation.
5. Finish only with `PetManager(action="build_generated_and_install", ...)`. Never manually create or overwrite an installed pet.

## Fixed v2 contract

- Final atlas: `1536x2288`, 8 columns x 11 rows, `192x208` cells, transparent lossless WebP.
- Row frame counts: `[6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8]`.
- Rows 0-8 are standard animation states; rows 9-10 are the 16 clockwise look directions.
- Row 0 columns 6-7 and every other unused standard-row cell remain transparent.
- Neutral/front uses the idle animation; it is not an extra cell.
- The manifest uses `spriteVersionNumber: 2`.

## User-visible plan

Maintain these four steps, one active at a time:

1. Getting `<Pet>` ready.
2. Imagining `<Pet>`'s main look.
3. Picturing `<Pet>`'s poses.
4. Hatching `<Pet>`.

## Core flow

1. Resolve a display name, a portable id, a one-sentence description, style, user references, a chroma key absent from the character, and an absolute workspace output directory. For a non-Latin-only name use a stable `pet-u<unicode-hex>` fallback or an agreed transliteration; never rename it to an unrelated default.
2. Use `Write` to create `<run_dir>/rows/run.json` with the chosen metadata and chroma key, plus `<run_dir>/package/build.json` with the fixed build plan. This creates the existing workspace rows directory for image export and the parent for the package target; do not use a shell directory command. Set `output_dir=<run_dir>/package/<id>` and leave that final `<id>` directory for `PetManager` to create.
3. Generate and visually approve one centered identity image with `destination_dir=<run_dir>/rows`. This is the source of truth for silhouette, face, proportions, palette, material, markings, lighting, and props.
4. Generate rows 0-8 as separate horizontal strips using `ImageEdit` and the same `destination_dir`. Each strip contains exactly its row's frame count in equal-width, non-overlapping slots on the same flat chroma background. Inspect every strip at full size and in sequence.
5. Generate row 9 as one coherent eight-pose family for directions `000` through `157.5`. Generate row 10 as one coherent eight-pose family for `180` through `337.5`, grounded by the identity image and approved row 9.
6. Repair the smallest failed scope: one complete standard row or one complete coherent look row. Never splice an independently generated look cell into a family.
7. Call native `PetManager` with all 11 approved exported strip paths, exact row indices and frame counts, metadata, chroma key, workspace output directory, and `activate=true`.
8. Treat the run as complete only when `PetManager` returns success. Its canonical validator is authoritative for dimensions, alpha, cell population, and unused-cell transparency.

## Native build call

Use this exact shape:

```text
PetManager(
  action="build_generated_and_install",
  id=<portable id>,
  display_name=<display name>,
  description=<one sentence>,
  chroma_key=<#RRGGBB>,
  rows=[
    {row: 0, frame_count: 6, path: <absolute idle strip>},
    {row: 1, frame_count: 8, path: <absolute running-right strip>},
    {row: 2, frame_count: 8, path: <absolute running-left strip>},
    {row: 3, frame_count: 4, path: <absolute waving strip>},
    {row: 4, frame_count: 5, path: <absolute jumping strip>},
    {row: 5, frame_count: 8, path: <absolute failed strip>},
    {row: 6, frame_count: 6, path: <absolute waiting strip>},
    {row: 7, frame_count: 6, path: <absolute running strip>},
    {row: 8, frame_count: 6, path: <absolute review strip>},
    {row: 9, frame_count: 8, path: <absolute look A strip>},
    {row: 10, frame_count: 8, path: <absolute look B strip>}
  ],
  output_dir=<absolute <run_dir>/package/<id> path inside workspace>,
  activate=true
)
```

Do not omit rows, duplicate an index, change a frame count, or pass a path outside the active workspace. `output_dir` must end with the exact pet id and have an existing workspace parent; do not pre-create the final id directory unless it is a valid package from a prior build of the same id.
