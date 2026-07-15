# LiveAgent V2 Pet Contract

## Native build input

`PetManager(action="build_generated_and_install")` accepts identity metadata, one chroma key, 11 horizontal source strips, an output directory inside the active workspace, and an activation flag.

Each row object contains:

- `row`: integer 0 through 10, exactly once;
- `frame_count`: the fixed count for that row;
- `path`: an absolute path to a readable generated PNG, JPEG, or WebP inside the workspace.

The native builder divides each source strip into equal-width slots, removes the configured chroma background, fits each complete pose into a `192x208` transparent cell, clears hidden RGB, and leaves unused cells transparent. It then assembles, validates, packages, atomically installs, refreshes the library, and optionally activates the pet.

## Final sprite atlas

- Version: `spriteVersionNumber: 2`.
- Format: transparent lossless WebP.
- Dimensions: `1536x2288`.
- Grid: 8 columns x 11 rows.
- Cell: `192x208`.
- Rows 0-8: standard animation states.
- Rows 9-10: 16 clockwise look directions.
- Every cell after a standard row's declared frame count is fully transparent with zero hidden RGB.
- Idle row 0 uses columns 0-5; columns 6 and 7 remain unused and transparent.
- Neutral/front is the idle fallback, not an extra atlas cell.

## Look directions

- Row 9: `000`, `022.5`, `045`, `067.5`, `090`, `112.5`, `135`, `157.5` degrees.
- Row 10: `180`, `202.5`, `225`, `247.5`, `270`, `292.5`, `315`, `337.5` degrees.
- `000` means up / 12 o'clock.
- Coordinates are screen-relative: `090` is screen-right and `270` is screen-left.

## Manifest and installation

The native builder creates the requested `output_dir`, which must end with the exact pet id and have an existing parent inside the workspace. A typical package contains:

```text
<workspace>/output/hatch-pet/<run>/package/<pet-id>/
|-- pet.json
`-- spritesheet.webp
```

Its manifest includes `id`, `displayName`, `description`, `spriteVersionNumber: 2`, and `spritesheetPath: "spritesheet.webp"`.

`id` uses only ASCII letters, digits, `_`, and `-`. Prefer a short meaningful ASCII slug. For a non-Latin-only name without an agreed transliteration, use a stable `pet-u<unicode-hex>` form derived from the name rather than an unrelated default.

Create the package parent with `Write`, but leave the final `<pet-id>` target absent for the first build. A later build may replace it only when it is already a valid generated package for the same id.

The native call is the only installation route. Never write to LiveAgent application data or its installed-pets directory yourself.
