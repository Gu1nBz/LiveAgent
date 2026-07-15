# Pets

LiveAgent can import Codex-compatible pets and display them in a desktop floating window.

## Import format

Codex pets are scanned from `$CODEX_HOME/pets` or `~/.codex/pets` only after the user clicks **Import Codex pets**:

```text
<pet-id>/
├── pet.json
└── spritesheet.webp
```

Supported atlases use `192x208` cells:

- Codex v1: `1536x1872` (`8x9`), standard animation states.
- Codex v2: `1536x2288` (`8x11`), standard states plus 16 pointer-look directions.

Imported files are copied into `~/.liveagent/pets`; LiveAgent does not retain a live dependency on the Codex directory.

## Generated-pet installation

Pet generators must not write directly to `~/.liveagent/pets`. They finish a
standard package in a LiveAgent workspace. LiveAgent can assemble that package
without Python, Pillow, Node, or `jq` by calling `pet_build_generated`:

```json
{
  "input": {
    "workspaceRoot": "/absolute/path/to/workspace",
    "outputDirectory": "generated/my-pet",
    "id": "my-pet",
    "displayName": "我的宠物",
    "description": "LiveAgent companion",
    "kind": "mascot",
    "chromaKey": { "r": 0, "g": 255, "b": 0, "tolerance": 72 },
    "rows": [
      { "row": 0, "frameCount": 6, "path": "strips/row-0.png" },
      { "row": 1, "frameCount": 8, "path": "strips/row-1.png" },
      { "row": 2, "frameCount": 8, "path": "strips/row-2.png" },
      { "row": 3, "frameCount": 4, "path": "strips/row-3.png" },
      { "row": 4, "frameCount": 5, "path": "strips/row-4.png" },
      { "row": 5, "frameCount": 8, "path": "strips/row-5.png" },
      { "row": 6, "frameCount": 6, "path": "strips/row-6.png" },
      { "row": 7, "frameCount": 6, "path": "strips/row-7.png" },
      { "row": 8, "frameCount": 6, "path": "strips/row-8.png" },
      { "row": 9, "frameCount": 8, "path": "strips/row-9.png" },
      { "row": 10, "frameCount": 8, "path": "strips/row-10.png" }
    ]
  }
}
```

`rows` must cover rows 0 through 10 exactly once with frame counts
`[6,8,8,4,5,8,6,6,6,8,8]`. Each PNG/WebP/JPEG input is a horizontal strip
whose width divides evenly into its frame count. The native builder removes the
optional chroma key, computes each frame's alpha bounds, fits and centers it in
a transparent `192x208` cell, leaves every unused standard-row cell transparent,
and writes a lossless `1536x2288` WebP plus canonical `pet.json`. Build output is
staged and atomically replaced. The response is
`{ "packageDirectory": string, "pet": PetManifest }`.

The package is then passed to `pet_install_generated`:

```json
{
  "input": {
    "workspaceRoot": "/absolute/path/to/workspace",
    "petDirectory": "relative/output/pet-id",
    "activate": true
  }
}
```

`workspaceRoot` must be an existing absolute non-root directory.
`petDirectory` may be absolute or workspace-relative, but its canonical path
must be a strict child of that workspace and must not point into the installed
pet library. The command reads only `pet.json` and the declared spritesheet,
limits both file sizes, resolves symlinks, verifies the manifest, PNG/WebP
format, atlas dimensions, every used frame, and transparent unused v2 cells.

LiveAgent then writes a canonical `pet.json`, stages the two files inside the
library, validates the staged copy, and atomically replaces the destination.
An existing pet is moved to a unique backup first and restored if replacement
or final validation fails. Successful installs clear inspection/asset caches,
emit `pet-library-changed` and `pet-installed`, refresh an open Settings page,
and activate the pet when `activate` is true.

## Runtime behavior

The pet maps chat activity to Codex animation rows:

- idle → row 0
- moving right while dragged/hovered → row 1
- moving left while dragged/hovered → row 2
- completed → row 4
- failed → row 5
- waiting for approval → row 6
- working → row 7
- reviewing → row 8

Runtime state is produced by a dedicated event adapter. It inspects structured live tool calls, the current conversation run, context compaction, queued turns, background conversations, completion transitions, and failures. Higher-priority events preempt lower-priority animations; minimum hold times prevent rapid visual flicker.

Rows 1 and 2 are played as their own repeating eight-frame animations; left
movement is not synthesized by mirroring row 7. Row 7 is reserved for actual
agent work.

For v2 pets, idle pointer tracking uses rows 9 and 10 and follows the global mouse position. **Settings → Pet** intentionally exposes only pet selection, explicit Codex import, and pet size.

## Desktop floating window

Pets always use a transparent, frameless desktop window. The sprite itself remains fully opaque. The window stays on top, is hidden from the taskbar, and is visible across workspaces. It continues to receive pet runtime events when the main window is hidden and can be repositioned freely by dragging the pet.

Desktop positions are persisted under `~/.liveagent`, restored after restart, and clamped to an available monitor. Selecting or importing a pet shows it immediately; selected pets return on application startup, remain visible when the main window is hidden, and close with the application. Missing active-pet resources are detected and cleared instead of leaving an empty floating window.

## Performance and compatibility

Spritesheets are served through LiveAgent's read-only `liveagent-pet` protocol instead of being duplicated as Base64 strings in every webview. Versioned immutable URLs allow the webview cache to share decoded resources safely after re-imports. Manifest inspection is metadata-cached, animation uses `requestAnimationFrame`, pauses with hidden webviews, honors the operating system's reduced-motion preference, and deduplicates unchanged runtime events.

Release and visual acceptance steps are documented in [Pet release checklist](pets-release-checklist.md).
The latest executed results are recorded in [Pet validation report](pets-validation.md).
