# Native Hatch Workflow

## 1. Gate and identity

Call `ImageManager(action="doctor")` and continue only when ready. If connection configuration is missing, use api2img's chat flow to collect Base URL, API Key, and model and save them with `configure_connection`; do not echo the key. If needed, complete api2img's AI-configured sync/async adapter flow first.

Choose:

- display name and portable ASCII id;
- one-sentence description;
- visual style and identity notes;
- user reference paths;
- a pure chroma key not used by the character;
- an absolute run directory inside the active workspace.

Before calling an image tool, use `Write` to create `<run_dir>/rows/run.json`. Store the chosen id, display name, description, chroma key, and fixed row/frame-count plan in that small manifest. Also use `Write` to create `<run_dir>/package/build.json`; this creates the package parent. Do not pre-create `<run_dir>/package/<id>` on the first build. `Write` creates the needed parents without shell commands.

Use `ImageGenerate` for a prompt-only identity or `ImageEdit` when references exist. Set `destination_dir=<run_dir>/rows`. Ask for one centered full-body neutral character on the selected flat chroma background, with no text, scenery, detached effects, or shadow. Inspect the returned exported workspace path with `Image`; do not continue until identity is approved.

## 2. Generate standard rows

Generate rows 0-8 with `ImageEdit`. Every call includes the approved exported identity image and all relevant user references and sets the same workspace `destination_dir`. Prompt for one horizontal equal-slot strip and include the exact state, row index, frame count, chroma hex, animation sequence, identity lock, and forbidden elements.

Required jobs:

| Row | State | Frames |
| ---: | --- | ---: |
| 0 | idle | 6 |
| 1 | running-right | 8 |
| 2 | running-left | 8 |
| 3 | waving | 4 |
| 4 | jumping | 5 |
| 5 | failed | 8 |
| 6 | waiting | 6 |
| 7 | running | 6 |
| 8 | review | 6 |

After each result, inspect:

- exact visible pose count;
- equal spacing and one pose per slot;
- complete uncropped body with padding;
- correct state and loop progression;
- stable identity, scale, palette, lighting, and prop construction;
- same flat background with no key color inside the pet;
- no labels, grids, borders, shadows, scenery, or detached effects.

Regenerate a failed complete row before moving on. Keep the selected exported absolute workspace path for the final call. If a completed job's automatic export failed and its job id is known, retry only the export with `ImageManager(action="export", job_id=..., destination_dir=<run_dir>/rows)`.

## 3. Generate look rows

Generate row 9 through `ImageEdit`, grounded by the identity and user references and exported to the same `destination_dir`. Request exactly these eight clockwise directions:

```text
000 up, 022.5 up-right, 045 up-right, 067.5 up-right,
090 screen-right, 112.5 down-right, 135 down-right, 157.5 down-right
```

Inspect direction order and smooth identity-preserving change. Then generate row 10 grounded by the identity, user references, and approved exported row 9, again with the same `destination_dir`:

```text
180 down, 202.5 down-left, 225 down-left, 247.5 down-left,
270 screen-left, 292.5 up-left, 315 up-left, 337.5 up-left
```

Review the two strips as a continuous 16-pose clockwise loop. Cardinal directions must be unmistakable. Each diagonal needs both the correct horizontal and vertical landmark movement. If one pose fails, regenerate its complete eight-pose row.

## 4. Native build, validation, and installation

Construct all 11 row objects with their exact indices, frame counts, and selected absolute source paths. Call:

```text
PetManager(action="build_generated_and_install", id=..., display_name=..., description=..., chroma_key="#RRGGBB", rows=[...], output_dir=<absolute <run_dir>/package/<id> path>, activate=true)
```

The `output_dir` final component must equal the id, its parent must already exist, and its first-build target must not be pre-created. The native operation performs equal-slot extraction, chroma removal, fitting, atlas assembly, hidden-RGB cleanup, v2 validation, workspace packaging, conflict-safe atomic installation, library refresh, and activation.

Treat any native error as specific evidence. Correct the referenced metadata, path, row, frame count, source strip, or chroma key and retry the native call. Do not bypass it with manual file operations.

## 5. Completion

Report:

- installed pet id and display name;
- activated state;
- workspace output/package path returned by the tool;
- any row that was regenerated and why.

Do not claim completion from successful image generation alone. The successful native `PetManager` response closes the workflow.
