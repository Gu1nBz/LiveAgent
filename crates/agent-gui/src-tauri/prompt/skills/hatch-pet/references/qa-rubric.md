# V2 Pet QA Rubric

Do not call the native builder until every visual section passes. Do not claim completion until its canonical validation and installation succeed.

## Metadata and inputs

- Id is portable ASCII, display name is preserved, and description is concise.
- Chroma key is one pure `#RRGGBB` value absent from the character and used consistently in all rows.
- All 11 paths are absolute, inside the active workspace, readable, and mapped to unique row indices 0-10.
- Frame counts are exactly `6,8,8,4,5,8,6,6,6,8,8`.

## Strip geometry

- Every strip is horizontal and contains exactly its declared number of equal-width slots.
- Each slot contains one centered complete pose with safe padding.
- No pose overlaps, crosses a slot boundary, or includes part of a neighbor.
- Background is flat chroma only; no transparency checker, gradient, grid, border, label, floor, scene, or shadow.

## Character and style

- Silhouette, proportions, face, eye construction, material, palette, lighting, markings, and props remain the same in all 11 rows.
- The character remains readable after fitting into `192x208`.
- No frame introduces another character, unintended object, readable logo, text, UI, or detached effect.

## Standard animation

- Rows 0-8 have recognizable and distinct state semantics.
- Idle contains visible low-distraction micro-motion rather than duplicate frames.
- Directional movement faces correctly and has a repeating alternating cadence.
- Waiting, active work, review, and failed reactions are visually distinct.
- Every loop returns without a severe pop or scale jump.

## Look directions

- All 16 directions appear in fixed clockwise order and remain the same pet.
- `000` is up, `090` screen-right, `180` down, and `270` screen-left.
- Each diagonal has both correct horizontal and vertical landmark movement.
- Adjacent directions change smoothly across the row 9/10 boundary and final-to-first loop boundary.
- No whole-sprite rotation, replacement eyes, reversed quadrant, transparent body hole, or clipped appendage.

## Native result

The run passes only when `PetManager(action="build_generated_and_install")` reports success. Its canonical result must confirm:

- an 8x11 v2 atlas at `1536x2288`;
- populated required cells;
- transparent unused cells, including row 0 columns 6-7;
- a two-file workspace package with v2 manifest and lossless WebP;
- atomic installation, library refresh, and requested activation.

Repair one complete standard row or one complete coherent look row, then rerun the native operation. Never manually patch the installed atlas.
