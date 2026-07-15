# Pet release checklist

## Automated gates

- TypeScript compilation passes.
- Vite production build passes.
- Pet frontend unit tests pass.
- Rust pet import/protocol tests pass.
- `cargo check -p liveagent` passes.
- Modified frontend files pass Biome.
- Modified Rust files pass rustfmt.
- `git diff --check` passes.

## Import acceptance

- Scan `$CODEX_HOME/pets` and the default `~/.codex/pets` fallback.
- Import one Codex v1 `1536x1872` atlas.
- Import one Codex v2 `1536x2288` atlas.
- Reject unsupported dimensions, malformed manifests, unsafe paths, oversized assets, and fully transparent used cells.
- Re-import an existing ID and verify the previous installation survives any failed replacement.
- Delete the original Codex directory and confirm the LiveAgent copy still works.
- Install a generated package through `pet_install_generated` and verify the
  canonical manifest/spritesheet names, library refresh, and optional automatic
  activation.
- Reject generated package paths outside `workspaceRoot`, workspace-root
  aliases, malformed/oversized manifests, mismatched sprite versions, missing
  used frames, and non-transparent unused v2 cells.
- Fail a generated replacement after an existing pet is installed and verify
  that the original package remains intact with no `.install-*` entry exposed
  by `pet_list`.

## Visual acceptance

Use **Settings → Pet** animation preview to inspect `idle`, `running`, `waiting`, `review`, `jumping`, and `failed`.

- Pet identity, scale, transparency, and frame registration remain stable.
- Drag/hover right uses the repeating row-1 walk, drag/hover left uses row 2,
  and row 7 is used only for real working state.
- No neighboring atlas cell leaks into the viewport.
- v1 pets animate without pointer look directions.
- v2 pets follow all four cardinal mouse directions and interpolate smoothly.
- Chat overlay stays above the composer without covering input controls.
- Desktop window has a transparent background and no native frame or shadow.
- No status bubble is rendered; the floating window contains only the pet.
- Reduced-motion mode displays a stable frame.

## Desktop lifecycle

- Switch between chat and desktop display modes without duplicate pets.
- Hide the main window and confirm the desktop pet remains active.
- Drag, lock, snap, reset, and restart to verify position persistence.
- Test mouse passthrough and restore interaction from the main settings window.
- Disconnect a secondary display and verify the pet returns to an available work area.
- Use tray show, hide, lock/unlock, and settings actions.
- Remove the active pet files and verify LiveAgent safely disables the missing pet.
- Quit LiveAgent and confirm every pet window closes.

## Platform matrix

- macOS: Intel and Apple Silicon, Retina and mixed-DPI displays, Spaces/full-screen apps.
- Windows: Windows 10/11, 100% and 150% DPI, taskbar and transparent-window behavior.
- Linux: X11 and Wayland where available; record unsupported compositor capabilities as graceful degradation.
