# Visual Generation Rules

## Native tool routing

Call `ImageManager(action="doctor")` before any generation. When configuration is incomplete, follow api2img's chat configuration flow: collect the Base URL, API Key, and model, pass them only to `configure_connection`, and never echo or persist the key elsewhere. Use redacted protocol examples for any non-standard adapter.

Use only:

- `ImageGenerate` for a new prompt-only identity image;
- `ImageEdit` for an identity image with user references and for all 11 row strips.

For each row, pass the approved identity image and every user reference through `input_paths`. Pass approved row 9 as an additional input for row 10. Set `destination_dir` to the prepared `<run_dir>/rows` workspace directory on the identity and every row call. Do not use a CLI, direct HTTP request, browser renderer, drawing program, or local image-processing script.

Prefer `output_format="png"` because strips need lossless edges and deterministic chroma removal. Generate one candidate at a time unless comparison is genuinely useful. Use the exported absolute workspace path returned by the native tool in later `input_paths` and in the final row list.

## Strip geometry

Every row source is one horizontal image containing exactly the required number of equal-width slots. Each slot contains exactly one complete, centered, non-overlapping full-body pose. Keep generous empty chroma space around every pose and between neighboring slots.

Use the identical pure `#RRGGBB` chroma background across all strips. Choose a key absent from the character, props, highlights, and effects. The background must be flat and fully opaque: no gradient, texture, transparency checkerboard, scenery, floor, grid, label, separator, or shadow.

Do not put a title, frame number, direction label, guide line, or border in the image. Native assembly splits by equal slot width, so incorrect counts, irregular spacing, overlap, or a pose crossing a slot boundary will fail or animate badly.

## Identity lock

The approved identity image is the visual source of truth. Preserve:

- silhouette and body proportions;
- head, face, eyes, mouth, ears, hair, flame, or screen construction;
- palette, material, line quality, lighting, and shading;
- markings, clothing, accessories, and props;
- pet-safe scale and readability.

A later row must be the same individual, not a restyle or sibling.

## State semantics

- `idle`: calm breathing, blink, or tiny bob; six frames must not be identical.
- `running-right`: clear right-facing alternating locomotion with eight frames.
- `running-left`: clear left-facing alternating locomotion with eight frames; do not merely mirror text, asymmetric props, or directional lighting.
- `waving`: a four-frame greeting gesture using a limb.
- `jumping`: five frames showing anticipation, lift, peak, descent, and settle without a floor cue.
- `failed`: readable eight-frame deflated or sad reaction.
- `waiting`: six-frame expectant request for user input or approval.
- `running`: six-frame focused active task work, not literal running.
- `review`: six-frame focused inspection without inventing a new prop.

Avoid text, readable logos, UI, scenery, floor/cast shadows, glow, blur, speed lines, afterimages, detached stars/smoke/tears, floating punctuation, cropped limbs, merged poses, and key-colored details in the pet.

## Look mechanics

Rows 9 and 10 form one clockwise 16-pose loop. Preserve the pet's original eye construction; do not paste replacement or googly eyes. Convey direction through the pet's natural eye, head, muzzle/nose, screen-face, ear, body, appendage, or prop mechanics. Never rotate the entire sprite to fake gaze.

Generate row 9 as one coherent eight-pose family. After approval, use it with the identity image to ground row 10. Never splice an independently generated look cell into a family; regenerate the complete containing row.
