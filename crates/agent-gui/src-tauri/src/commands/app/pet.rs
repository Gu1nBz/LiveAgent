use image::codecs::webp::WebPEncoder;
use image::imageops::{crop_imm, overlay, resize, FilterType};
use image::{ExtendedColorType, ImageFormat, ImageReader, RgbaImage};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Cursor;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
#[cfg(not(target_os = "macos"))]
use tauri::Position;
use tauri::{Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

const CELL_WIDTH: u32 = 192;
const CELL_HEIGHT: u32 = 208;
const ATLAS_WIDTH: u32 = CELL_WIDTH * 8;
const V1_HEIGHT: u32 = CELL_HEIGHT * 9;
const V2_HEIGHT: u32 = CELL_HEIGHT * 11;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_SPRITESHEET_BYTES: u64 = 32 * 1024 * 1024;
const MAX_SOURCE_STRIP_PIXELS: u64 = 32 * 1024 * 1024;
const PET_LIBRARY_CHANGED_EVENT: &str = "pet-library-changed";
const PET_INSTALLED_EVENT: &str = "pet-installed";
const PET_WINDOW_LABEL: &str = "pet";
const PET_WINDOW_WIDTH: f64 = 380.0;
const PET_WINDOW_HEIGHT: f64 = 420.0;
const PET_WINDOW_POSITION_FILENAME: &str = "pet-window-position.json";
const PET_WINDOW_EDGE_SNAP_LOGICAL_PX: f64 = 28.0;
const PET_WINDOW_POSITION_VERSION: u8 = 2;

#[derive(Clone)]
struct CachedPetInspection {
    manifest_signature: (u64, u128),
    spritesheet_signature: (u64, u128),
    payload: PetManifestPayload,
}

static PET_INSPECTION_CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedPetInspection>>> =
    OnceLock::new();
static PET_LIBRARY_MUTATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static PET_BUILD_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static PET_COORDINATE_DEBUG_SNAPSHOT: OnceLock<()> = OnceLock::new();

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PetWindowPosition {
    x: i32,
    y: i32,
    #[serde(default)]
    monitor_name: Option<String>,
    #[serde(default)]
    visible_bounds: Option<PetWindowVisibleBoundsInput>,
    #[serde(default)]
    coordinate_space_version: u8,
    saved_at: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetWindowVisibleBoundsInput {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetWindowCommitPositionInput {
    x: i32,
    y: i32,
    snap_to_edges: bool,
    #[serde(default)]
    visible_bounds: Option<PetWindowVisibleBoundsInput>,
    #[serde(default)]
    target_monitor_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetWindowPositionPayload {
    x: i32,
    y: i32,
    monitor_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetPointerSnapshotPayload {
    cursor_x: f64,
    cursor_y: f64,
    window_x: f64,
    window_y: f64,
    scale_factor: f64,
    monitor_x: i32,
    monitor_y: i32,
    monitor_width: u32,
    monitor_height: u32,
    monitors: Vec<PetMonitorWorkAreaPayload>,
    primary_button_pressed: Option<bool>,
    monitor_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetMonitorWorkAreaPayload {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    name: Option<String>,
}

#[derive(Debug, Clone, Copy)]
struct PetMonitorWorkArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RawPetManifest {
    id: String,
    display_name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    sprite_version_number: Option<u32>,
    spritesheet_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetManifestPayload {
    id: String,
    display_name: String,
    description: String,
    kind: Option<String>,
    sprite_version_number: u32,
    spritesheet_path: String,
    sprite_version: String,
    look_directions: bool,
    source: String,
    asset_version: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetInstallGeneratedInput {
    workspace_root: String,
    pet_directory: String,
    #[serde(default = "default_true")]
    activate: bool,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetBuildChromaKeyInput {
    r: u8,
    g: u8,
    b: u8,
    #[serde(default)]
    tolerance: u8,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetBuildRowInput {
    row: u32,
    frame_count: u32,
    path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetBuildGeneratedInput {
    workspace_root: String,
    output_directory: String,
    id: String,
    display_name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    chroma_key: Option<PetBuildChromaKeyInput>,
    rows: Vec<PetBuildRowInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetBuildGeneratedPayload {
    package_directory: String,
    pet: PetManifestPayload,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PetLibraryChangedPayload {
    action: String,
    id: String,
    pet: Option<PetManifestPayload>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PetInstalledPayload {
    pet: PetManifestPayload,
    activate: bool,
}

fn default_true() -> bool {
    true
}

fn pets_root() -> Result<PathBuf, String> {
    let root = crate::services::skills::app_storage_dir()?.join("pets");
    fs::create_dir_all(&root).map_err(|e| format!("Failed to create pets directory: {e}"))?;
    Ok(root)
}

fn codex_pets_root() -> Result<PathBuf, String> {
    let root = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
        .ok_or_else(|| "Failed to locate Codex home directory".to_string())?;
    Ok(root.join("pets"))
}

#[tauri::command]
pub async fn pet_library_path() -> Result<String, String> {
    Ok(pets_root()?.to_string_lossy().into_owned())
}

fn validate_pet_id(id: &str) -> Result<&str, String> {
    let id = id.trim();
    if id.is_empty() || id.len() > 96 {
        return Err("Pet id must contain 1-96 characters".to_string());
    }
    if !id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(format!("Invalid pet id: {id}"));
    }
    Ok(id)
}

fn safe_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value.trim());
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err("spritesheetPath must be a non-empty relative path".to_string());
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("spritesheetPath must stay inside the pet directory".to_string());
    }
    Ok(path.to_path_buf())
}

fn read_manifest(dir: &Path, source: &str) -> Result<(RawPetManifest, PathBuf), String> {
    let manifest_path = dir.join("pet.json");
    let manifest_metadata = fs::metadata(&manifest_path)
        .map_err(|e| format!("Failed to inspect {}: {e}", manifest_path.display()))?;
    if !manifest_metadata.is_file()
        || manifest_metadata.len() == 0
        || manifest_metadata.len() > MAX_MANIFEST_BYTES
    {
        return Err(format!(
            "pet.json must be a non-empty file no larger than {} KiB",
            MAX_MANIFEST_BYTES / 1024
        ));
    }
    let bytes = fs::read(&manifest_path)
        .map_err(|e| format!("Failed to read {}: {e}", manifest_path.display()))?;
    let manifest: RawPetManifest = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Invalid pet.json in {}: {e}", dir.display()))?;
    validate_pet_id(&manifest.id)?;
    if manifest.display_name.trim().is_empty() || manifest.display_name.len() > 160 {
        return Err("Pet displayName must contain 1-160 characters".to_string());
    }
    if manifest.description.len() > 4096 {
        return Err("Pet description must be no longer than 4096 characters".to_string());
    }
    if manifest
        .kind
        .as_ref()
        .is_some_and(|kind| kind.trim().len() > 96)
    {
        return Err("Pet kind must be no longer than 96 characters".to_string());
    }
    if manifest.spritesheet_path.len() > 512 {
        return Err("spritesheetPath must be no longer than 512 characters".to_string());
    }
    let relative = safe_relative_path(&manifest.spritesheet_path)?;
    let sheet = dir.join(relative);
    let canonical_dir = fs::canonicalize(dir)
        .map_err(|e| format!("Failed to resolve pet directory {}: {e}", dir.display()))?;
    let canonical_sheet = fs::canonicalize(&sheet)
        .map_err(|e| format!("Failed to resolve spritesheet {}: {e}", sheet.display()))?;
    if !canonical_sheet.starts_with(&canonical_dir) {
        return Err("spritesheetPath resolves outside the pet directory".to_string());
    }
    let metadata = fs::metadata(&canonical_sheet)
        .map_err(|e| format!("Failed to inspect spritesheet: {e}"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_SPRITESHEET_BYTES {
        return Err(format!(
            "Spritesheet must be a non-empty file no larger than {} MiB",
            MAX_SPRITESHEET_BYTES / 1024 / 1024
        ));
    }
    let _ = source;
    Ok((manifest, canonical_sheet))
}

fn inspect_pet(dir: &Path, source: &str) -> Result<PetManifestPayload, String> {
    let (manifest, sheet) = read_manifest(dir, source)?;
    let bytes = fs::read(&sheet).map_err(|e| format!("Failed to read spritesheet: {e}"))?;
    let reader = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|e| format!("Failed to identify spritesheet format: {e}"))?;
    let format = reader
        .format()
        .ok_or_else(|| "Failed to identify spritesheet format".to_string())?;
    if !matches!(format, ImageFormat::Png | ImageFormat::WebP) {
        return Err("Spritesheet must be a PNG or WebP image".to_string());
    }
    let (width, height) = reader
        .into_dimensions()
        .map_err(|e| format!("Failed to read spritesheet dimensions: {e}"))?;
    let (sprite_version, version_number, look_directions) = match (width, height) {
        (ATLAS_WIDTH, V1_HEIGHT) => ("codex-v1", 1, false),
        (ATLAS_WIDTH, V2_HEIGHT) => ("codex-v2", 2, true),
        _ => {
            return Err(format!(
                "Unsupported spritesheet size {width}x{height}; expected {ATLAS_WIDTH}x{V1_HEIGHT} or {ATLAS_WIDTH}x{V2_HEIGHT}"
            ))
        }
    };
    if let Some(declared_version) = manifest.sprite_version_number {
        if declared_version != version_number {
            return Err(format!(
                "spriteVersionNumber is {declared_version} but the spritesheet is version {version_number}"
            ));
        }
    }
    validate_used_sprite_cells(
        &sheet,
        if look_directions { 11 } else { 9 },
        look_directions,
    )?;
    let metadata =
        fs::metadata(&sheet).map_err(|e| format!("Failed to inspect spritesheet: {e}"))?;
    let digest = Sha256::digest(&bytes);
    let content_hash = digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(PetManifestPayload {
        id: manifest.id.trim().to_string(),
        display_name: manifest.display_name.trim().to_string(),
        description: manifest.description.trim().to_string(),
        kind: manifest
            .kind
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        sprite_version_number: version_number,
        spritesheet_path: manifest.spritesheet_path,
        sprite_version: sprite_version.to_string(),
        look_directions,
        source: source.to_string(),
        asset_version: format!("{}-{content_hash}", metadata.len()),
    })
}

const STANDARD_ROW_FRAME_COUNTS: [u32; 9] = [6, 8, 8, 4, 5, 8, 6, 6, 6];

fn validate_used_sprite_cells(
    path: &Path,
    rows: u32,
    require_unused_transparent: bool,
) -> Result<(), String> {
    let image = ImageReader::open(path)
        .map_err(|e| format!("Failed to open spritesheet for frame validation: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("Failed to identify spritesheet for frame validation: {e}"))?
        .decode()
        .map_err(|e| format!("Failed to decode spritesheet for frame validation: {e}"))?
        .to_rgba8();
    if image.width() != ATLAS_WIDTH || image.height() != CELL_HEIGHT * rows {
        return Err("Spritesheet dimensions changed during validation".to_string());
    }
    for row in 0..rows {
        let used_columns = if row < 9 {
            STANDARD_ROW_FRAME_COUNTS[row as usize]
        } else {
            8
        };
        for column in 0..8 {
            let start_x = column * CELL_WIDTH;
            let start_y = row * CELL_HEIGHT;
            let non_empty = (start_y..start_y + CELL_HEIGHT)
                .any(|y| (start_x..start_x + CELL_WIDTH).any(|x| image.get_pixel(x, y).0[3] > 0));
            if column < used_columns && !non_empty {
                return Err(format!(
                    "Spritesheet frame row {row}, column {column} is fully transparent"
                ));
            }
            if require_unused_transparent && column >= used_columns && non_empty {
                return Err(format!(
                    "Spritesheet unused frame row {row}, column {column} must be transparent"
                ));
            }
        }
    }
    Ok(())
}

fn file_signature(path: &Path) -> Option<(u64, u128)> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some((metadata.len(), modified))
}

fn inspect_pet_cached(dir: &Path, source: &str) -> Result<PetManifestPayload, String> {
    let key = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let manifest_signature = file_signature(&dir.join("pet.json"));
    let cache = PET_INSPECTION_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let (Some(manifest_signature), Ok(cache_guard)) = (manifest_signature, cache.lock()) {
        if let Some(cached) = cache_guard.get(&key) {
            let sheet = dir.join(&cached.payload.spritesheet_path);
            if cached.manifest_signature == manifest_signature
                && file_signature(&sheet) == Some(cached.spritesheet_signature)
            {
                return Ok(cached.payload.clone());
            }
        }
    }

    let payload = inspect_pet(dir, source)?;
    let sheet = dir.join(&payload.spritesheet_path);
    if let (Some(manifest_signature), Some(spritesheet_signature), Ok(mut cache_guard)) = (
        file_signature(&dir.join("pet.json")),
        file_signature(&sheet),
        cache.lock(),
    ) {
        cache_guard.insert(
            key,
            CachedPetInspection {
                manifest_signature,
                spritesheet_signature,
                payload: payload.clone(),
            },
        );
    }
    Ok(payload)
}

fn list_from_root(root: &Path, source: &str) -> Vec<PetManifestPayload> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut pets = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let directory_id = entry.file_name().to_string_lossy().into_owned();
            if directory_id.starts_with('.') || !path.is_dir() {
                return None;
            }
            match inspect_pet_cached(&path, source) {
                Ok(pet) if pet.id == directory_id => Some(pet),
                Ok(pet) => {
                    eprintln!(
                        "skip invalid pet {}: directory id {directory_id} does not match manifest id {}",
                        path.display(),
                        pet.id
                    );
                    None
                }
                Err(error) => {
                    eprintln!("skip invalid pet {}: {error}", path.display());
                    None
                }
            }
        })
        .collect::<Vec<_>>();
    pets.sort_by(|left, right| left.display_name.cmp(&right.display_name));
    pets
}

fn clear_pet_inspection_cache(paths: &[&Path]) {
    let Some(cache) = PET_INSPECTION_CACHE.get() else {
        return;
    };
    let keys = paths
        .iter()
        .map(|path| fs::canonicalize(path).unwrap_or_else(|_| (*path).to_path_buf()))
        .collect::<Vec<_>>();
    if let Ok(mut cache) = cache.lock() {
        cache.retain(|key, _| !keys.iter().any(|candidate| candidate == key));
    }
}

fn remove_path_if_exists(path: &Path) -> Result<(), String> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(path).map_err(|e| format!("Failed to remove {}: {e}", path.display()))
    } else {
        fs::remove_dir_all(path).map_err(|e| format!("Failed to remove {}: {e}", path.display()))
    }
}

fn spritesheet_extension(path: &Path) -> Result<&'static str, String> {
    let reader = ImageReader::open(path)
        .map_err(|e| format!("Failed to open spritesheet: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("Failed to identify spritesheet format: {e}"))?;
    match reader.format() {
        Some(ImageFormat::Png) => Ok("png"),
        Some(ImageFormat::WebP) => Ok("webp"),
        _ => Err("Spritesheet must be a PNG or WebP image".to_string()),
    }
}

fn write_canonical_pet_package(
    source_dir: &Path,
    staging: &Path,
) -> Result<PetManifestPayload, String> {
    let source_pet = inspect_pet(source_dir, "generated")?;
    let (_, source_sheet) = read_manifest(source_dir, "generated")?;
    let extension = spritesheet_extension(&source_sheet)?;
    let sheet_name = format!("spritesheet.{extension}");
    fs::copy(&source_sheet, staging.join(&sheet_name))
        .map_err(|e| format!("Failed to copy generated spritesheet: {e}"))?;
    let manifest = RawPetManifest {
        id: source_pet.id,
        display_name: source_pet.display_name,
        description: source_pet.description,
        kind: source_pet.kind,
        sprite_version_number: Some(source_pet.sprite_version_number),
        spritesheet_path: sheet_name,
    };
    fs::write(
        staging.join("pet.json"),
        serde_json::to_vec_pretty(&manifest)
            .map_err(|e| format!("Failed to encode canonical pet.json: {e}"))?,
    )
    .map_err(|e| format!("Failed to write canonical pet.json: {e}"))?;
    inspect_pet(staging, "liveagent")
}

fn install_pet_package(source_dir: &Path, root: &Path) -> Result<PetManifestPayload, String> {
    let _mutation_guard = PET_LIBRARY_MUTATION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Pet library mutation lock is poisoned".to_string())?;
    fs::create_dir_all(root).map_err(|e| format!("Failed to create pets directory: {e}"))?;

    // Inspect before creating staging so malformed generated output can never
    // leave partial entries in the LiveAgent library.
    let source_pet = inspect_pet(source_dir, "generated")?;
    let id = validate_pet_id(&source_pet.id)?.to_string();
    let staging = root.join(format!(".install-{id}-{}", Uuid::new_v4().simple()));
    fs::create_dir(&staging)
        .map_err(|e| format!("Failed to create pet installation staging directory: {e}"))?;

    let install_result = (|| {
        let staged_pet = write_canonical_pet_package(source_dir, &staging)?;
        if staged_pet.id != id {
            return Err("Generated pet id changed while staging the package".to_string());
        }

        let destination = root.join(&id);
        let backup = root.join(format!(".backup-{id}-{}", Uuid::new_v4().simple()));
        let had_existing = fs::symlink_metadata(&destination).is_ok();
        clear_pet_inspection_cache(&[&destination, &staging]);
        if had_existing {
            fs::rename(&destination, &backup)
                .map_err(|e| format!("Failed to stage existing pet for replacement: {e}"))?;
        }
        if let Err(error) = fs::rename(&staging, &destination) {
            if had_existing {
                if let Err(rollback_error) = fs::rename(&backup, &destination) {
                    return Err(format!(
                        "Failed to finish pet installation: {error}; rollback also failed: {rollback_error}"
                    ));
                }
            }
            return Err(format!("Failed to finish pet installation: {error}"));
        }

        clear_pet_inspection_cache(&[&destination, &staging, &backup]);
        let installed = match inspect_pet(&destination, "liveagent") {
            Ok(pet) => pet,
            Err(validation_error) => {
                let remove_error = remove_path_if_exists(&destination).err();
                let rollback_error = if had_existing {
                    fs::rename(&backup, &destination).err()
                } else {
                    None
                };
                clear_pet_inspection_cache(&[&destination, &backup]);
                return Err(format!(
                    "Installed pet failed final validation: {validation_error}{}{}",
                    remove_error
                        .map(|error| format!("; failed to remove invalid replacement: {error}"))
                        .unwrap_or_default(),
                    rollback_error
                        .map(|error| format!("; failed to restore previous pet: {error}"))
                        .unwrap_or_default()
                ));
            }
        };
        if had_existing {
            if let Err(error) = remove_path_if_exists(&backup) {
                eprintln!(
                    "failed to remove replaced pet backup {}: {error}",
                    backup.display()
                );
            }
        }
        clear_pet_inspection_cache(&[&destination, &backup]);
        // Re-read after clearing so the public cache is populated under the
        // final canonical destination rather than the temporary staging path.
        inspect_pet_cached(&destination, "liveagent").or(Ok(installed))
    })();

    if fs::symlink_metadata(&staging).is_ok() {
        if let Err(error) = remove_path_if_exists(&staging) {
            eprintln!(
                "failed to remove pet installation staging {}: {error}",
                staging.display()
            );
        }
    }
    install_result
}

fn resolve_canonical_workspace_root(value: &str) -> Result<PathBuf, String> {
    let requested_workspace = PathBuf::from(value.trim());
    if !requested_workspace.is_absolute() {
        return Err("workspaceRoot must be an absolute path".to_string());
    }
    let workspace = fs::canonicalize(&requested_workspace)
        .map_err(|e| format!("Failed to resolve workspaceRoot: {e}"))?;
    let workspace_metadata =
        fs::metadata(&workspace).map_err(|e| format!("Failed to inspect workspaceRoot: {e}"))?;
    if !workspace_metadata.is_dir() || workspace.parent().is_none() {
        return Err("workspaceRoot must be a non-root directory".to_string());
    }
    if dirs::home_dir()
        .and_then(|path| fs::canonicalize(path).ok())
        .is_some_and(|home| workspace == home)
    {
        return Err("workspaceRoot cannot be the user home directory".to_string());
    }
    let app_storage = fs::canonicalize(crate::services::skills::app_storage_dir()?)
        .map_err(|e| format!("Failed to resolve LiveAgent storage: {e}"))?;
    if workspace == app_storage {
        return Err("workspaceRoot cannot be the LiveAgent storage root".to_string());
    }
    Ok(workspace)
}

fn resolve_generated_pet_directory(input: &PetInstallGeneratedInput) -> Result<PathBuf, String> {
    let workspace = resolve_canonical_workspace_root(&input.workspace_root)?;
    let requested_pet = PathBuf::from(input.pet_directory.trim());
    if requested_pet.as_os_str().is_empty() {
        return Err("petDirectory cannot be empty".to_string());
    }
    let requested_pet = if requested_pet.is_absolute() {
        requested_pet
    } else {
        workspace.join(requested_pet)
    };
    let source = fs::canonicalize(&requested_pet)
        .map_err(|e| format!("Failed to resolve generated petDirectory: {e}"))?;
    if source == workspace || !source.starts_with(&workspace) {
        return Err("petDirectory must be a strict child of workspaceRoot".to_string());
    }
    if !fs::metadata(&source)
        .map_err(|e| format!("Failed to inspect generated petDirectory: {e}"))?
        .is_dir()
    {
        return Err("petDirectory must resolve to a directory".to_string());
    }
    let library = fs::canonicalize(pets_root()?)
        .map_err(|e| format!("Failed to resolve the pet library: {e}"))?;
    if source.starts_with(&library) {
        return Err("petDirectory cannot point into the installed pet library".to_string());
    }
    Ok(source)
}

const V2_ROW_FRAME_COUNTS: [u32; 11] = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8];

fn validate_pet_build_rows(rows: &[PetBuildRowInput]) -> Result<Vec<&PetBuildRowInput>, String> {
    if rows.len() != V2_ROW_FRAME_COUNTS.len() {
        return Err(format!(
            "rows must contain exactly {} entries (rows 0-10)",
            V2_ROW_FRAME_COUNTS.len()
        ));
    }
    let mut ordered = vec![None; V2_ROW_FRAME_COUNTS.len()];
    for row in rows {
        let row_index = usize::try_from(row.row)
            .ok()
            .filter(|index| *index < V2_ROW_FRAME_COUNTS.len())
            .ok_or_else(|| format!("Invalid atlas row {}; expected 0-10", row.row))?;
        if ordered[row_index].is_some() {
            return Err(format!("Atlas row {} is duplicated", row.row));
        }
        let expected = V2_ROW_FRAME_COUNTS[row_index];
        if row.frame_count != expected {
            return Err(format!(
                "Atlas row {} must contain {expected} frames, got {}",
                row.row, row.frame_count
            ));
        }
        if row.path.trim().is_empty() {
            return Err(format!("Atlas row {} path cannot be empty", row.row));
        }
        ordered[row_index] = Some(row);
    }
    ordered
        .into_iter()
        .enumerate()
        .map(|(row, value)| value.ok_or_else(|| format!("Atlas row {row} is missing")))
        .collect()
}

fn resolve_workspace_input_file(workspace: &Path, value: &str) -> Result<PathBuf, String> {
    let requested = PathBuf::from(value.trim());
    if requested.as_os_str().is_empty() {
        return Err("Generated frame strip path cannot be empty".to_string());
    }
    let requested = if requested.is_absolute() {
        requested
    } else {
        workspace.join(requested)
    };
    let source = fs::canonicalize(&requested)
        .map_err(|e| format!("Failed to resolve frame strip {}: {e}", requested.display()))?;
    if !source.starts_with(workspace) {
        return Err(format!(
            "Frame strip resolves outside workspaceRoot: {}",
            source.display()
        ));
    }
    let metadata = fs::metadata(&source)
        .map_err(|e| format!("Failed to inspect frame strip {}: {e}", source.display()))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_SPRITESHEET_BYTES {
        return Err(format!(
            "Frame strip must be a non-empty file no larger than {} MiB: {}",
            MAX_SPRITESHEET_BYTES / 1024 / 1024,
            source.display()
        ));
    }
    Ok(source)
}

fn existing_build_output_is_replaceable(target: &Path, id: &str) -> Result<bool, String> {
    let metadata = match fs::symlink_metadata(target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Failed to inspect outputDirectory {}: {error}",
                target.display()
            ))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(
            "Existing outputDirectory must be a real directory, not a file or symlink".to_string(),
        );
    }
    let manifest_path = target.join("pet.json");
    let manifest_metadata = fs::metadata(&manifest_path).map_err(|_| {
        "Refusing to replace an existing outputDirectory that is not a pet package".to_string()
    })?;
    if !manifest_metadata.is_file()
        || manifest_metadata.len() == 0
        || manifest_metadata.len() > MAX_MANIFEST_BYTES
    {
        return Err("Existing outputDirectory has an invalid pet.json".to_string());
    }
    let manifest: RawPetManifest = serde_json::from_slice(
        &fs::read(&manifest_path)
            .map_err(|e| format!("Failed to read existing output pet.json: {e}"))?,
    )
    .map_err(|e| format!("Existing outputDirectory has an invalid pet.json: {e}"))?;
    if manifest.id.trim() != id {
        return Err(format!(
            "Existing outputDirectory belongs to pet {}, not {id}",
            manifest.id.trim()
        ));
    }
    Ok(true)
}

fn resolve_pet_build_output_directory(
    workspace: &Path,
    value: &str,
    id: &str,
) -> Result<(PathBuf, bool), String> {
    let requested = PathBuf::from(value.trim());
    if requested.as_os_str().is_empty()
        || requested
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("outputDirectory must be a non-empty path without ..".to_string());
    }
    let requested = if requested.is_absolute() {
        requested
    } else {
        workspace.join(requested)
    };
    let file_name = requested
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "outputDirectory must end with the pet id".to_string())?;
    if file_name != id {
        return Err(format!("outputDirectory must end with the pet id '{id}'"));
    }
    let parent = requested
        .parent()
        .ok_or_else(|| "outputDirectory must have an existing parent directory".to_string())?;
    let parent = fs::canonicalize(parent)
        .map_err(|e| format!("Failed to resolve outputDirectory parent: {e}"))?;
    if !parent.starts_with(workspace) {
        return Err("outputDirectory must stay inside workspaceRoot".to_string());
    }
    let target = parent.join(id);
    let replacing = existing_build_output_is_replaceable(&target, id)?;
    Ok((target, replacing))
}

fn remove_chroma_key(frame: &mut RgbaImage, key: PetBuildChromaKeyInput) {
    for pixel in frame.pixels_mut() {
        let red_delta = pixel.0[0].abs_diff(key.r);
        let green_delta = pixel.0[1].abs_diff(key.g);
        let blue_delta = pixel.0[2].abs_diff(key.b);
        if red_delta.max(green_delta).max(blue_delta) <= key.tolerance {
            // Clear RGB as well as alpha so Lanczos resizing cannot bleed the
            // key color back into antialiased transparent edges.
            *pixel = image::Rgba([0, 0, 0, 0]);
        }
    }
}

fn alpha_bounds(frame: &RgbaImage) -> Option<(u32, u32, u32, u32)> {
    let mut left = frame.width();
    let mut top = frame.height();
    let mut right = 0;
    let mut bottom = 0;
    for (x, y, pixel) in frame.enumerate_pixels() {
        if pixel.0[3] <= 8 {
            continue;
        }
        left = left.min(x);
        top = top.min(y);
        right = right.max(x + 1);
        bottom = bottom.max(y + 1);
    }
    (right > left && bottom > top).then_some((left, top, right - left, bottom - top))
}

fn fit_frame_into_cell(frame: &RgbaImage, row: u32, column: u32) -> Result<RgbaImage, String> {
    let (left, top, width, height) = alpha_bounds(frame).ok_or_else(|| {
        format!("Generated frame row {row}, column {column} is fully transparent")
    })?;
    let cropped = crop_imm(frame, left, top, width, height).to_image();
    let scale = (CELL_WIDTH as f64 / width as f64).min(CELL_HEIGHT as f64 / height as f64);
    let target_width = ((width as f64 * scale).round() as u32).clamp(1, CELL_WIDTH);
    let target_height = ((height as f64 * scale).round() as u32).clamp(1, CELL_HEIGHT);
    let resized = resize(&cropped, target_width, target_height, FilterType::Lanczos3);
    let mut cell = RgbaImage::new(CELL_WIDTH, CELL_HEIGHT);
    overlay(
        &mut cell,
        &resized,
        i64::from((CELL_WIDTH - target_width) / 2),
        i64::from((CELL_HEIGHT - target_height) / 2),
    );
    Ok(cell)
}

fn decode_frame_strip(path: &Path, row: u32, frame_count: u32) -> Result<RgbaImage, String> {
    let reader = ImageReader::open(path)
        .map_err(|e| format!("Failed to open row {row} strip {}: {e}", path.display()))?
        .with_guessed_format()
        .map_err(|e| format!("Failed to identify row {row} strip format: {e}"))?;
    if !matches!(
        reader.format(),
        Some(ImageFormat::Png | ImageFormat::WebP | ImageFormat::Jpeg)
    ) {
        return Err(format!(
            "Row {row} strip must be PNG, WebP, or JPEG: {}",
            path.display()
        ));
    }
    let (width, height) = reader
        .into_dimensions()
        .map_err(|e| format!("Failed to inspect row {row} strip dimensions: {e}"))?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_SOURCE_STRIP_PIXELS {
        return Err(format!(
            "Row {row} strip dimensions are too large: {width}x{height}"
        ));
    }
    if width % frame_count != 0 {
        return Err(format!(
            "Row {row} strip width {width} is not evenly divisible by {frame_count} frames"
        ));
    }
    ImageReader::open(path)
        .map_err(|e| format!("Failed to reopen row {row} strip: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("Failed to identify row {row} strip format: {e}"))?
        .decode()
        .map_err(|e| format!("Failed to decode row {row} strip: {e}"))
        .map(|image| image.to_rgba8())
}

fn assemble_pet_atlas(
    workspace: &Path,
    rows: &[PetBuildRowInput],
    chroma_key: Option<PetBuildChromaKeyInput>,
) -> Result<RgbaImage, String> {
    let rows = validate_pet_build_rows(rows)?;
    let mut atlas = RgbaImage::new(ATLAS_WIDTH, V2_HEIGHT);
    for row in rows {
        let source = resolve_workspace_input_file(workspace, &row.path)?;
        let strip = decode_frame_strip(&source, row.row, row.frame_count)?;
        let frame_width = strip.width() / row.frame_count;
        for column in 0..row.frame_count {
            let mut frame =
                crop_imm(&strip, column * frame_width, 0, frame_width, strip.height()).to_image();
            if let Some(key) = chroma_key {
                remove_chroma_key(&mut frame, key);
            }
            let cell = fit_frame_into_cell(&frame, row.row, column)?;
            overlay(
                &mut atlas,
                &cell,
                i64::from(column * CELL_WIDTH),
                i64::from(row.row * CELL_HEIGHT),
            );
        }
    }
    Ok(atlas)
}

fn write_lossless_webp(path: &Path, atlas: &RgbaImage) -> Result<(), String> {
    let file = fs::File::create(path)
        .map_err(|e| format!("Failed to create generated spritesheet: {e}"))?;
    WebPEncoder::new_lossless(file)
        .encode(
            atlas.as_raw(),
            atlas.width(),
            atlas.height(),
            ExtendedColorType::Rgba8,
        )
        .map_err(|e| format!("Failed to encode lossless WebP spritesheet: {e}"))
}

fn rollback_built_package(
    target: &Path,
    backup: &Path,
    had_existing: bool,
) -> (Option<String>, Option<String>) {
    let remove_error = remove_path_if_exists(target).err();
    let rollback_error = if had_existing {
        fs::rename(backup, target)
            .err()
            .map(|error| error.to_string())
    } else {
        None
    };
    (remove_error, rollback_error)
}

fn build_generated_pet(input: PetBuildGeneratedInput) -> Result<PetBuildGeneratedPayload, String> {
    let _build_guard = PET_BUILD_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Pet build lock is poisoned".to_string())?;
    let id = validate_pet_id(&input.id)?.to_string();
    if input.display_name.trim().is_empty() || input.display_name.len() > 160 {
        return Err("Pet displayName must contain 1-160 characters".to_string());
    }
    if input.description.len() > 4096 {
        return Err("Pet description must be no longer than 4096 characters".to_string());
    }
    if input
        .kind
        .as_ref()
        .is_some_and(|kind| kind.trim().len() > 96)
    {
        return Err("Pet kind must be no longer than 96 characters".to_string());
    }
    let workspace = resolve_canonical_workspace_root(&input.workspace_root)?;
    let (target, replacing) =
        resolve_pet_build_output_directory(&workspace, &input.output_directory, &id)?;
    // Validate every row before allocating/encoding the atlas so row mistakes
    // never disturb a previous generated package.
    validate_pet_build_rows(&input.rows)?;
    let atlas = assemble_pet_atlas(&workspace, &input.rows, input.chroma_key)?;

    let parent = target
        .parent()
        .ok_or_else(|| "Generated pet output has no parent directory".to_string())?;
    let staging = parent.join(format!(".pet-build-{id}-{}", Uuid::new_v4().simple()));
    fs::create_dir(&staging)
        .map_err(|e| format!("Failed to create generated pet staging directory: {e}"))?;
    let build_result = (|| {
        let sheet_name = "spritesheet.webp";
        write_lossless_webp(&staging.join(sheet_name), &atlas)?;
        let manifest = RawPetManifest {
            id: id.clone(),
            display_name: input.display_name.trim().to_string(),
            description: input.description.trim().to_string(),
            kind: input
                .kind
                .map(|kind| kind.trim().to_string())
                .filter(|kind| !kind.is_empty()),
            sprite_version_number: Some(2),
            spritesheet_path: sheet_name.to_string(),
        };
        fs::write(
            staging.join("pet.json"),
            serde_json::to_vec_pretty(&manifest)
                .map_err(|e| format!("Failed to encode generated pet.json: {e}"))?,
        )
        .map_err(|e| format!("Failed to write generated pet.json: {e}"))?;
        inspect_pet(&staging, "generated")?;

        let backup = parent.join(format!(
            ".pet-build-backup-{id}-{}",
            Uuid::new_v4().simple()
        ));
        if replacing {
            fs::rename(&target, &backup)
                .map_err(|e| format!("Failed to stage previous generated pet: {e}"))?;
        }
        if let Err(error) = fs::rename(&staging, &target) {
            if replacing {
                if let Err(rollback_error) = fs::rename(&backup, &target) {
                    return Err(format!(
                        "Failed to publish generated pet: {error}; rollback also failed: {rollback_error}"
                    ));
                }
            }
            return Err(format!("Failed to publish generated pet: {error}"));
        }
        clear_pet_inspection_cache(&[&staging, &target, &backup]);
        let pet = match inspect_pet(&target, "generated") {
            Ok(pet) => pet,
            Err(error) => {
                let (remove_error, rollback_error) =
                    rollback_built_package(&target, &backup, replacing);
                return Err(format!(
                    "Published generated pet failed validation: {error}{}{}",
                    remove_error
                        .map(|error| format!("; failed to remove invalid package: {error}"))
                        .unwrap_or_default(),
                    rollback_error
                        .map(|error| format!("; failed to restore previous package: {error}"))
                        .unwrap_or_default()
                ));
            }
        };
        if replacing {
            if let Err(error) = remove_path_if_exists(&backup) {
                eprintln!(
                    "failed to remove generated pet backup {}: {error}",
                    backup.display()
                );
            }
        }
        clear_pet_inspection_cache(&[&target, &backup]);
        Ok(PetBuildGeneratedPayload {
            package_directory: target.to_string_lossy().into_owned(),
            pet,
        })
    })();
    if fs::symlink_metadata(&staging).is_ok() {
        if let Err(error) = remove_path_if_exists(&staging) {
            eprintln!(
                "failed to remove generated pet staging {}: {error}",
                staging.display()
            );
        }
    }
    build_result
}

fn emit_pet_library_changed(
    app: &tauri::AppHandle,
    action: &str,
    id: &str,
    pet: Option<PetManifestPayload>,
) {
    if let Err(error) = app.emit(
        PET_LIBRARY_CHANGED_EVENT,
        PetLibraryChangedPayload {
            action: action.to_string(),
            id: id.to_string(),
            pet,
        },
    ) {
        eprintln!("failed to publish pet library change: {error}");
    }
}

#[tauri::command]
pub async fn pet_list() -> Result<Vec<PetManifestPayload>, String> {
    Ok(list_from_root(&pets_root()?, "liveagent"))
}

#[tauri::command]
pub async fn pet_scan_codex() -> Result<Vec<PetManifestPayload>, String> {
    Ok(list_from_root(&codex_pets_root()?, "codex"))
}

#[tauri::command]
pub async fn pet_import_codex(
    app: tauri::AppHandle,
    id: String,
) -> Result<PetManifestPayload, String> {
    let id = validate_pet_id(&id)?.to_string();
    let source_root = codex_pets_root()?;
    let source_dir = source_root.join(&id);
    let source_pet = inspect_pet(&source_dir, "codex")?;
    if source_pet.id != id {
        return Err("Requested pet id does not match pet.json".to_string());
    }
    let root = pets_root()?;
    let pet = tauri::async_runtime::spawn_blocking(move || install_pet_package(&source_dir, &root))
        .await
        .map_err(|e| format!("pet import join failed: {e}"))??;
    emit_pet_library_changed(&app, "installed", &pet.id, Some(pet.clone()));
    if let Err(error) = app.emit(
        PET_INSTALLED_EVENT,
        PetInstalledPayload {
            pet: pet.clone(),
            activate: true,
        },
    ) {
        eprintln!("failed to publish imported pet activation: {error}");
    }
    Ok(pet)
}

#[tauri::command]
pub async fn pet_build_generated(
    input: PetBuildGeneratedInput,
) -> Result<PetBuildGeneratedPayload, String> {
    tauri::async_runtime::spawn_blocking(move || build_generated_pet(input))
        .await
        .map_err(|e| format!("generated pet build join failed: {e}"))?
}

#[tauri::command]
pub async fn pet_install_generated(
    app: tauri::AppHandle,
    input: PetInstallGeneratedInput,
) -> Result<PetManifestPayload, String> {
    let activate = input.activate;
    let source = resolve_generated_pet_directory(&input)?;
    let root = pets_root()?;
    let pet = tauri::async_runtime::spawn_blocking(move || install_pet_package(&source, &root))
        .await
        .map_err(|e| format!("generated pet installation join failed: {e}"))??;
    emit_pet_library_changed(&app, "installed", &pet.id, Some(pet.clone()));
    if let Err(error) = app.emit(
        PET_INSTALLED_EVENT,
        PetInstalledPayload {
            pet: pet.clone(),
            activate,
        },
    ) {
        eprintln!("failed to publish generated pet installation: {error}");
    }
    Ok(pet)
}

#[tauri::command]
pub async fn pet_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let id = validate_pet_id(&id)?.to_string();
    let target = pets_root()?.join(&id);
    let target_for_delete = target.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _mutation_guard = PET_LIBRARY_MUTATION_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| "Pet library mutation lock is poisoned".to_string())?;
        remove_path_if_exists(&target_for_delete)?;
        clear_pet_inspection_cache(&[&target_for_delete]);
        Ok(())
    })
    .await
    .map_err(|e| format!("pet delete join failed: {e}"))??;
    emit_pet_library_changed(&app, "deleted", &id, None);
    Ok(())
}

pub(crate) fn pet_asset_response(
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let response = (|| -> Result<tauri::http::Response<Vec<u8>>, String> {
        // Tauri's `convertFileSrc` percent-encodes the whole path, including `/`.
        let decoded_path = percent_decode_str(request.uri().path())
            .decode_utf8()
            .map_err(|_| "Pet asset path is not valid UTF-8".to_string())?;
        let segments = decoded_path
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>();
        if segments.len() != 2 || segments[1] != "spritesheet" {
            return Err("Unknown pet asset path".to_string());
        }
        let id = validate_pet_id(segments[0])?;
        let dir = pets_root()?.join(id);
        let (manifest, sheet) = read_manifest(&dir, "liveagent")?;
        if manifest.id.trim() != id {
            return Err("Pet directory id does not match pet.json".to_string());
        }
        let bytes = fs::read(&sheet).map_err(|e| format!("Failed to read spritesheet: {e}"))?;
        let extension = sheet
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let mime_type = if extension == "png" {
            "image/png"
        } else {
            "image/webp"
        };
        tauri::http::Response::builder()
            .status(tauri::http::StatusCode::OK)
            .header(tauri::http::header::CONTENT_TYPE, mime_type)
            .header(
                tauri::http::header::CACHE_CONTROL,
                "public, max-age=31536000, immutable",
            )
            .header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(bytes)
            .map_err(|e| format!("Failed to build pet asset response: {e}"))
    })();
    response.unwrap_or_else(|error| {
        tauri::http::Response::builder()
            .status(tauri::http::StatusCode::NOT_FOUND)
            .header(
                tauri::http::header::CONTENT_TYPE,
                "text/plain; charset=utf-8",
            )
            .body(error.into_bytes())
            .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
    })
}

fn pet_window_position_path() -> Result<PathBuf, String> {
    Ok(crate::services::skills::app_storage_dir()?.join(PET_WINDOW_POSITION_FILENAME))
}

fn read_saved_pet_window_position() -> Option<PetWindowPosition> {
    let path = pet_window_position_path().ok()?;
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn save_pet_window_position(position: &PetWindowPosition) -> Result<(), String> {
    let path = pet_window_position_path()?;
    let temporary = path.with_extension(format!("tmp-{}", Uuid::new_v4().simple()));
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(position)
            .map_err(|e| format!("Failed to encode pet window position: {e}"))?,
    )
    .map_err(|e| format!("Failed to write pet window position: {e}"))?;
    #[cfg(target_os = "windows")]
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|e| format!("Failed to replace saved pet window position: {e}"))?;
    }
    let result = fs::rename(&temporary, &path)
        .map_err(|e| format!("Failed to save pet window position: {e}"));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

// Tauri/tao reports macOS global cursor coordinates using the primary
// monitor's backing scale, while window and monitor positions use their own
// backing scales. Those values cannot be compared directly on a mixed-DPI
// desktop. The pet runtime therefore uses macOS desktop points as its single
// coordinate space (and native physical pixels on the other platforms).
fn pet_monitor_work_area(monitor: &tauri::Monitor) -> PetMonitorWorkArea {
    let area = monitor.work_area();
    #[cfg(target_os = "macos")]
    {
        let factor = monitor.scale_factor().max(f64::EPSILON);
        return PetMonitorWorkArea {
            x: (area.position.x as f64 / factor).round() as i32,
            y: (area.position.y as f64 / factor).round() as i32,
            width: (area.size.width as f64 / factor).round().max(1.0) as u32,
            height: (area.size.height as f64 / factor).round().max(1.0) as u32,
        };
    }
    #[cfg(not(target_os = "macos"))]
    PetMonitorWorkArea {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width,
        height: area.size.height,
    }
}

fn pet_window_outer_position(window: &tauri::WebviewWindow) -> Result<(i32, i32), String> {
    let position = window
        .outer_position()
        .map_err(|e| format!("Failed to read pet window position: {e}"))?;
    #[cfg(target_os = "macos")]
    {
        let factor = window
            .scale_factor()
            .map_err(|e| format!("Failed to read pet window scale factor: {e}"))?
            .max(f64::EPSILON);
        return Ok((
            (position.x as f64 / factor).round() as i32,
            (position.y as f64 / factor).round() as i32,
        ));
    }
    #[cfg(not(target_os = "macos"))]
    Ok((position.x, position.y))
}

fn pet_window_outer_size(window: &tauri::WebviewWindow) -> Result<(i32, i32), String> {
    let size = window
        .outer_size()
        .map_err(|e| format!("Failed to read pet window size: {e}"))?;
    #[cfg(target_os = "macos")]
    {
        let factor = window
            .scale_factor()
            .map_err(|e| format!("Failed to read pet window scale factor: {e}"))?
            .max(f64::EPSILON);
        return Ok((
            (size.width as f64 / factor).round().max(1.0) as i32,
            (size.height as f64 / factor).round().max(1.0) as i32,
        ));
    }
    #[cfg(not(target_os = "macos"))]
    Ok((size.width as i32, size.height as i32))
}

fn pet_cursor_position(
    window: &tauri::WebviewWindow,
    cursor: PhysicalPosition<f64>,
) -> Result<(f64, f64), String> {
    #[cfg(target_os = "macos")]
    {
        let factor = window
            .primary_monitor()
            .map_err(|e| format!("Failed to read primary monitor: {e}"))?
            .map(|monitor| monitor.scale_factor())
            .unwrap_or(1.0)
            .max(f64::EPSILON);
        return Ok((cursor.x / factor, cursor.y / factor));
    }
    #[cfg(not(target_os = "macos"))]
    Ok((cursor.x, cursor.y))
}

fn primary_mouse_button_pressed() -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: NSEvent exposes this as a process-wide read-only bitmask and
        // does not require a retained Objective-C object.
        return Some(objc2_app_kit::NSEvent::pressedMouseButtons() & 1 != 0);
    }
    #[cfg(not(target_os = "macos"))]
    None
}

fn set_pet_window_position(window: &tauri::WebviewWindow, x: i32, y: i32) -> Result<(), String> {
    let debug_coordinates = std::env::var_os("LIVEAGENT_PET_DEBUG_COORDINATES").is_some();
    #[cfg(target_os = "macos")]
    {
        // Bypass tao's mixed-DPI Position conversion and place the NSWindow in
        // AppKit desktop points directly, matching Codex's native overlay path.
        let primary_height = window
            .primary_monitor()
            .map_err(|e| format!("Failed to read primary monitor: {e}"))?
            .map(|monitor| monitor.size().height as f64 / monitor.scale_factor().max(f64::EPSILON))
            .unwrap_or(0.0);
        let window = window.clone();
        let (result_tx, result_rx) = std::sync::mpsc::sync_channel(1);
        window
            .clone()
            .run_on_main_thread(move || {
                let result = (|| -> Result<(), String> {
                    let pointer = window
                        .ns_window()
                        .map_err(|error| format!("Failed to access native pet window: {error}"))?;
                    // SAFETY: Tauri owns this NSWindow for the lifetime of the
                    // cloned WebviewWindow, and the closure runs on AppKit's
                    // main thread as required by NSWindow.
                    let native_window = unsafe { &*pointer.cast::<objc2_app_kit::NSWindow>() };
                    native_window.setFrameTopLeftPoint(objc2_foundation::NSPoint::new(
                        x as f64,
                        primary_height - y as f64,
                    ));
                    if debug_coordinates {
                        eprintln!(
                            "pet native position applied: x={x} y={y} primary_height={primary_height}"
                        );
                    }
                    Ok(())
                })();
                if result_tx.send(result).is_err() {
                    eprintln!("pet window position result receiver was dropped");
                };
            })
            .map_err(|e| format!("Failed to queue native pet window position: {e}"))?;
        return result_rx
            .recv_timeout(Duration::from_millis(250))
            .map_err(|error| format!("Timed out positioning native pet window: {error}"))?;
    }
    #[cfg(not(target_os = "macos"))]
    window
        .set_position(Position::Physical(PhysicalPosition::new(x, y)))
        .map_err(|e| format!("Failed to position pet window: {e}"))
}

fn migrate_pet_window_position(
    window: &tauri::WebviewWindow,
    mut position: PetWindowPosition,
) -> Result<PetWindowPosition, String> {
    if position.coordinate_space_version >= PET_WINDOW_POSITION_VERSION {
        return Ok(position);
    }
    #[cfg(target_os = "macos")]
    {
        let monitors = window
            .available_monitors()
            .map_err(|e| format!("Failed to list monitors: {e}"))?;
        let factor = position
            .monitor_name
            .as_ref()
            .and_then(|name| monitors.iter().find(|monitor| monitor.name() == Some(name)))
            .map(|monitor| monitor.scale_factor())
            .unwrap_or_else(|| window.scale_factor().unwrap_or(1.0))
            .max(f64::EPSILON);
        position.x = (position.x as f64 / factor).round() as i32;
        position.y = (position.y as f64 / factor).round() as i32;
        if let Some(bounds) = position.visible_bounds.as_mut() {
            bounds.left = (bounds.left as f64 / factor).round() as i32;
            bounds.top = (bounds.top as f64 / factor).round() as i32;
            bounds.right = (bounds.right as f64 / factor).round() as i32;
            bounds.bottom = (bounds.bottom as f64 / factor).round() as i32;
        }
    }
    position.coordinate_space_version = PET_WINDOW_POSITION_VERSION;
    Ok(position)
}

fn squared_distance_to_work_area(area: PetMonitorWorkArea, x: i32, y: i32) -> i64 {
    let right = area.x + area.width as i32;
    let bottom = area.y + area.height as i32;
    let dx = if x < area.x {
        area.x - x
    } else if x > right {
        x - right
    } else {
        0
    } as i64;
    let dy = if y < area.y {
        area.y - y
    } else if y > bottom {
        y - bottom
    } else {
        0
    } as i64;
    dx * dx + dy * dy
}

fn select_pet_monitor_index(
    monitor_names: &[Option<String>],
    areas: &[PetMonitorWorkArea],
    x: i32,
    y: i32,
    target_monitor_name: Option<&str>,
) -> Option<usize> {
    target_monitor_name
        .and_then(|name| {
            monitor_names
                .iter()
                .position(|monitor_name| monitor_name.as_deref() == Some(name))
        })
        .or_else(|| {
            areas.iter().position(|area| {
                x >= area.x
                    && x < area.x + area.width as i32
                    && y >= area.y
                    && y < area.y + area.height as i32
            })
        })
        .or_else(|| {
            areas
                .iter()
                .enumerate()
                .min_by_key(|(_, area)| squared_distance_to_work_area(**area, x, y))
                .map(|(index, _)| index)
        })
}

fn clamp_visible_content_to_work_area(
    area: PetMonitorWorkArea,
    requested_x: i32,
    requested_y: i32,
    content_left: i32,
    content_top: i32,
    content_right: i32,
    content_bottom: i32,
) -> (i32, i32, i32, i32, i32, i32) {
    let min_x = area.x - content_left;
    let min_y = area.y - content_top;
    let max_x = area.x + area.width as i32 - content_right;
    let max_y = area.y + area.height as i32 - content_bottom;
    (
        requested_x.clamp(min_x, max_x.max(min_x)),
        requested_y.clamp(min_y, max_y.max(min_y)),
        min_x,
        min_y,
        max_x.max(min_x),
        max_y.max(min_y),
    )
}

fn clamp_pet_window_position(
    window: &tauri::WebviewWindow,
    requested_x: i32,
    requested_y: i32,
    snap_to_edges: bool,
    visible_bounds: Option<&PetWindowVisibleBoundsInput>,
    target_monitor_name: Option<&str>,
) -> Result<PetWindowPositionPayload, String> {
    let monitors = window
        .available_monitors()
        .map_err(|e| format!("Failed to list monitors: {e}"))?;
    let (outer_width, outer_height) = pet_window_outer_size(window)?;
    let (content_left, content_top, content_right, content_bottom) = visible_bounds
        .map(|bounds| {
            let left = bounds.left.clamp(0, outer_width.saturating_sub(1));
            let top = bounds.top.clamp(0, outer_height.saturating_sub(1));
            let right = bounds.right.clamp(left + 1, outer_width);
            let bottom = bounds.bottom.clamp(top + 1, outer_height);
            (left, top, right, bottom)
        })
        .unwrap_or((0, 0, outer_width, outer_height));
    let center_x = requested_x + (content_left + content_right) / 2;
    let center_y = requested_y + (content_top + content_bottom) / 2;
    let monitor_areas = monitors
        .iter()
        .map(pet_monitor_work_area)
        .collect::<Vec<_>>();
    let monitor_names = monitors
        .iter()
        .map(|monitor| monitor.name().cloned())
        .collect::<Vec<_>>();
    let monitor_index = select_pet_monitor_index(
        &monitor_names,
        &monitor_areas,
        center_x,
        center_y,
        target_monitor_name,
    )
    .ok_or_else(|| "No monitor is available for the pet window".to_string())?;
    let monitor = &monitors[monitor_index];
    let area = monitor_areas[monitor_index];
    let (mut x, mut y, min_x, min_y, max_x, max_y) = clamp_visible_content_to_work_area(
        area,
        requested_x,
        requested_y,
        content_left,
        content_top,
        content_right,
        content_bottom,
    );
    if std::env::var_os("LIVEAGENT_PET_DEBUG_COORDINATES").is_some() {
        eprintln!(
            "pet clamp: requested=({requested_x},{requested_y}) outer=({outer_width},{outer_height}) content=({content_left},{content_top},{content_right},{content_bottom}) target={target_monitor_name:?} areas={monitor_areas:?} selected={monitor_index} result=({x},{y}) range=({min_x}..{max_x},{min_y}..{max_y})"
        );
    }
    if snap_to_edges {
        let threshold = (PET_WINDOW_EDGE_SNAP_LOGICAL_PX * monitor.scale_factor()).round() as i32;
        if (x - min_x).abs() <= threshold {
            x = min_x;
        } else if (max_x - x).abs() <= threshold {
            x = max_x;
        }
        if (y - min_y).abs() <= threshold {
            y = min_y;
        } else if (max_y - y).abs() <= threshold {
            y = max_y;
        }
    }
    Ok(PetWindowPositionPayload {
        x,
        y,
        monitor_name: monitor.name().cloned(),
    })
}

fn apply_pet_window_position(
    window: &tauri::WebviewWindow,
    requested_x: i32,
    requested_y: i32,
    snap_to_edges: bool,
    persist: bool,
    visible_bounds: Option<&PetWindowVisibleBoundsInput>,
    target_monitor_name: Option<&str>,
) -> Result<PetWindowPositionPayload, String> {
    let position = clamp_pet_window_position(
        window,
        requested_x,
        requested_y,
        snap_to_edges,
        visible_bounds,
        target_monitor_name,
    )?;
    let current = pet_window_outer_position(window)?;
    if current.0 != position.x || current.1 != position.y {
        set_pet_window_position(window, position.x, position.y)?;
    }
    if persist {
        save_pet_window_position(&PetWindowPosition {
            x: position.x,
            y: position.y,
            monitor_name: position.monitor_name.clone(),
            visible_bounds: visible_bounds.cloned(),
            coordinate_space_version: PET_WINDOW_POSITION_VERSION,
            saved_at: now_ms(),
        })?;
    }
    Ok(position)
}

fn default_pet_window_position(window: &tauri::WebviewWindow) -> Result<(i32, i32), String> {
    let Some(monitor) = window
        .primary_monitor()
        .map_err(|e| format!("Failed to read primary monitor: {e}"))?
    else {
        return Ok((0, 0));
    };
    let area = pet_monitor_work_area(&monitor);
    let (outer_width, outer_height) = pet_window_outer_size(window)?;
    Ok((
        area.x + area.width as i32 - outer_width - 28,
        area.y + area.height as i32 - outer_height - 28,
    ))
}

fn position_new_pet_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if let Some(position) = read_saved_pet_window_position() {
        let position = migrate_pet_window_position(window, position)?;
        if std::env::var_os("LIVEAGENT_PET_DEBUG_COORDINATES").is_some() {
            eprintln!("pet restoring saved position: {position:?}");
        }
        apply_pet_window_position(
            window,
            position.x,
            position.y,
            false,
            false,
            position.visible_bounds.as_ref(),
            position.monitor_name.as_deref(),
        )?;
    } else {
        let (x, y) = default_pet_window_position(window)?;
        apply_pet_window_position(window, x, y, false, false, None, None)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn pet_window_set_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    if !visible {
        if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
            window
                .destroy()
                .map_err(|e| format!("Failed to destroy pet window: {e}"))?;
        }
        return Ok(());
    }

    if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
        window
            .show()
            .map_err(|e| format!("Failed to show pet window: {e}"))?;
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(
        &app,
        PET_WINDOW_LABEL,
        WebviewUrl::App("index.html?window=pet".into()),
    )
    .title("")
    .inner_size(PET_WINDOW_WIDTH, PET_WINDOW_HEIGHT)
    .min_inner_size(PET_WINDOW_WIDTH, PET_WINDOW_HEIGHT)
    .max_inner_size(PET_WINDOW_WIDTH, PET_WINDOW_HEIGHT)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .focusable(false)
    .focused(false)
    .visible(false)
    .build()
    .map_err(|e| format!("Failed to create pet window: {e}"))?;
    position_new_pet_window(&window)?;
    Ok(())
}

#[tauri::command]
pub async fn pet_window_mark_ready(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(PET_WINDOW_LABEL)
        .ok_or_else(|| "Pet window is not open".to_string())?;
    window
        .show()
        .map_err(|e| format!("Failed to show ready pet window: {e}"))
}

#[tauri::command]
pub async fn pet_window_set_interaction(
    app: tauri::AppHandle,
    click_through: bool,
    always_on_top: bool,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
        if let Err(error) = window.set_always_on_top(always_on_top) {
            eprintln!("pet window always-on-top is unavailable: {error}");
        }
        window
            .set_ignore_cursor_events(click_through)
            .map_err(|error| format!("Failed to update pet window mouse passthrough: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn pet_window_pointer_snapshot(
    app: tauri::AppHandle,
) -> Result<PetPointerSnapshotPayload, String> {
    let window = app
        .get_webview_window(PET_WINDOW_LABEL)
        .ok_or_else(|| "Pet window is not open".to_string())?;
    let cursor = window
        .cursor_position()
        .map_err(|e| format!("Failed to read cursor position: {e}"))?;
    let (cursor_x, cursor_y) = pet_cursor_position(&window, cursor)?;
    let (window_x, window_y) = pet_window_outer_position(&window)?;
    let monitors = window
        .available_monitors()
        .map_err(|e| format!("Failed to list monitors: {e}"))?;
    let cursor_point_x = cursor_x.round() as i32;
    let cursor_point_y = cursor_y.round() as i32;
    let monitor = monitors
        .iter()
        .find(|monitor| {
            let area = pet_monitor_work_area(monitor);
            cursor_point_x >= area.x
                && cursor_point_x < area.x + area.width as i32
                && cursor_point_y >= area.y
                && cursor_point_y < area.y + area.height as i32
        })
        .or_else(|| {
            monitors.iter().min_by_key(|monitor| {
                let area = pet_monitor_work_area(monitor);
                let right = area.x + area.width as i32;
                let bottom = area.y + area.height as i32;
                let dx = if cursor_point_x < area.x {
                    area.x - cursor_point_x
                } else if cursor_point_x > right {
                    cursor_point_x - right
                } else {
                    0
                } as i64;
                let dy = if cursor_point_y < area.y {
                    area.y - cursor_point_y
                } else if cursor_point_y > bottom {
                    cursor_point_y - bottom
                } else {
                    0
                } as i64;
                dx * dx + dy * dy
            })
        })
        .ok_or_else(|| "No monitor is available for the pet window".to_string())?;
    let work_area = pet_monitor_work_area(monitor);
    if std::env::var_os("LIVEAGENT_PET_DEBUG_COORDINATES").is_some() {
        PET_COORDINATE_DEBUG_SNAPSHOT.get_or_init(|| {
            let raw_window = window.outer_position().ok();
            let window_factor = window.scale_factor().ok();
            eprintln!(
                "pet coordinate snapshot: raw_cursor=({:.1},{:.1}) cursor=({cursor_x:.1},{cursor_y:.1}) raw_window={raw_window:?} window=({window_x},{window_y}) factor={window_factor:?}",
                cursor.x, cursor.y
            );
            for candidate in &monitors {
                eprintln!(
                    "pet monitor: name={:?} raw={:?} normalized={:?} scale={}",
                    candidate.name(),
                    candidate.work_area(),
                    pet_monitor_work_area(candidate),
                    candidate.scale_factor()
                );
            }
        });
    }
    #[cfg(target_os = "macos")]
    let webview_coordinate_factor = 1.0;
    #[cfg(not(target_os = "macos"))]
    let webview_coordinate_factor = window
        .scale_factor()
        .map_err(|e| format!("Failed to read pet window scale factor: {e}"))?;
    Ok(PetPointerSnapshotPayload {
        cursor_x,
        cursor_y,
        window_x: window_x as f64,
        window_y: window_y as f64,
        scale_factor: webview_coordinate_factor,
        monitor_x: work_area.x,
        monitor_y: work_area.y,
        monitor_width: work_area.width,
        monitor_height: work_area.height,
        monitors: monitors
            .iter()
            .map(|monitor| {
                let area = pet_monitor_work_area(monitor);
                PetMonitorWorkAreaPayload {
                    x: area.x,
                    y: area.y,
                    width: area.width,
                    height: area.height,
                    name: monitor.name().cloned(),
                }
            })
            .collect(),
        primary_button_pressed: primary_mouse_button_pressed(),
        monitor_name: monitor.name().cloned(),
    })
}

#[tauri::command]
pub async fn pet_window_commit_position(
    app: tauri::AppHandle,
    input: PetWindowCommitPositionInput,
) -> Result<PetWindowPositionPayload, String> {
    let window = app
        .get_webview_window(PET_WINDOW_LABEL)
        .ok_or_else(|| "Pet window is not open".to_string())?;
    apply_pet_window_position(
        &window,
        input.x,
        input.y,
        input.snap_to_edges,
        true,
        input.visible_bounds.as_ref(),
        input.target_monitor_name.as_deref(),
    )
}

#[tauri::command]
pub async fn pet_window_constrain_position(
    app: tauri::AppHandle,
    input: PetWindowCommitPositionInput,
) -> Result<PetWindowPositionPayload, String> {
    let window = app
        .get_webview_window(PET_WINDOW_LABEL)
        .ok_or_else(|| "Pet window is not open".to_string())?;
    apply_pet_window_position(
        &window,
        input.x,
        input.y,
        false,
        false,
        input.visible_bounds.as_ref(),
        input.target_monitor_name.as_deref(),
    )
}

#[tauri::command]
pub async fn pet_window_reset_position(
    app: tauri::AppHandle,
) -> Result<PetWindowPositionPayload, String> {
    let window = app
        .get_webview_window(PET_WINDOW_LABEL)
        .ok_or_else(|| "Pet window is not open".to_string())?;
    let (x, y) = default_pet_window_position(&window)?;
    apply_pet_window_position(&window, x, y, false, true, None, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_test_pet_package(dir: &Path, id: &str, blank_cell: Option<(u32, u32)>) {
        fs::create_dir_all(dir).expect("create package");
        let path = dir.join("source-atlas.png");
        let mut atlas = image::RgbaImage::new(ATLAS_WIDTH, V1_HEIGHT);
        for row in 0..9 {
            for column in 0..STANDARD_ROW_FRAME_COUNTS[row as usize] {
                if blank_cell == Some((row, column)) {
                    continue;
                }
                atlas.put_pixel(
                    column * CELL_WIDTH + CELL_WIDTH / 2,
                    row * CELL_HEIGHT + CELL_HEIGHT / 2,
                    image::Rgba([255, 255, 255, 255]),
                );
            }
        }
        atlas.save(&path).expect("save atlas");
        fs::write(
            dir.join("pet.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "id": id,
                "displayName": "Generated Pet",
                "description": "generated in a workspace",
                "spriteVersionNumber": 1,
                "spritesheetPath": "source-atlas.png"
            }))
            .expect("manifest json"),
        )
        .expect("write manifest");
    }

    fn write_test_build_strips(workspace: &Path) -> Vec<PetBuildRowInput> {
        let strips = workspace.join("strips");
        fs::create_dir_all(&strips).expect("create strips");
        V2_ROW_FRAME_COUNTS
            .iter()
            .enumerate()
            .map(|(row, frame_count)| {
                let frame_width = 12;
                let frame_height = 16;
                let mut strip = RgbaImage::from_pixel(
                    frame_width * *frame_count,
                    frame_height,
                    image::Rgba([0, 255, 0, 255]),
                );
                for column in 0..*frame_count {
                    for y in 3..14 {
                        for x in 3..9 {
                            strip.put_pixel(
                                column * frame_width + x,
                                y,
                                image::Rgba([200, row as u8, column as u8, 255]),
                            );
                        }
                    }
                }
                let relative_path = format!("strips/row-{row}.png");
                strip
                    .save(workspace.join(&relative_path))
                    .expect("save frame strip");
                PetBuildRowInput {
                    row: row as u32,
                    frame_count: *frame_count,
                    path: relative_path,
                }
            })
            .collect()
    }

    #[test]
    fn validates_pet_ids_and_relative_paths() {
        assert!(validate_pet_id("friendly-pet_2").is_ok());
        assert!(validate_pet_id("../escape").is_err());
        assert!(safe_relative_path("spritesheet.webp").is_ok());
        assert!(safe_relative_path("../spritesheet.webp").is_err());
        assert!(safe_relative_path("/tmp/spritesheet.webp").is_err());
    }

    #[test]
    fn pet_asset_protocol_rejects_unknown_and_unsafe_paths() {
        for uri in [
            "liveagent-pet://localhost/unknown",
            "liveagent-pet://localhost/../spritesheet",
            "liveagent-pet://localhost/%2E%2E/spritesheet",
        ] {
            let request = tauri::http::Request::builder()
                .uri(uri)
                .body(Vec::new())
                .expect("request");
            let response = pet_asset_response(request);
            assert_eq!(response.status(), tauri::http::StatusCode::NOT_FOUND);
        }
    }

    #[test]
    fn frame_validation_requires_every_used_cell_to_be_non_empty() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("atlas.png");
        let mut atlas = image::RgbaImage::new(ATLAS_WIDTH, V1_HEIGHT);
        for row in 0..9 {
            for column in 0..8 {
                atlas.put_pixel(
                    column * CELL_WIDTH + CELL_WIDTH / 2,
                    row * CELL_HEIGHT + CELL_HEIGHT / 2,
                    image::Rgba([255, 255, 255, 255]),
                );
            }
        }
        atlas.save(&path).expect("save valid atlas");
        validate_used_sprite_cells(&path, 9, false).expect("all frames should be non-empty");

        atlas.put_pixel(
            3 * CELL_WIDTH + CELL_WIDTH / 2,
            4 * CELL_HEIGHT + CELL_HEIGHT / 2,
            image::Rgba([0, 0, 0, 0]),
        );
        atlas.save(&path).expect("save invalid atlas");
        let error = validate_used_sprite_cells(&path, 9, false).expect_err("blank frame must fail");
        assert!(error.contains("row 4, column 3"), "{error}");
    }

    #[test]
    fn v2_frame_validation_requires_unused_cells_to_be_transparent() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("atlas-v2.png");
        let mut atlas = image::RgbaImage::new(ATLAS_WIDTH, V2_HEIGHT);
        for row in 0..11 {
            let count = if row < 9 {
                STANDARD_ROW_FRAME_COUNTS[row as usize]
            } else {
                8
            };
            for column in 0..count {
                atlas.put_pixel(
                    column * CELL_WIDTH + CELL_WIDTH / 2,
                    row * CELL_HEIGHT + CELL_HEIGHT / 2,
                    image::Rgba([255, 255, 255, 255]),
                );
            }
        }
        atlas.save(&path).expect("save valid v2 atlas");
        validate_used_sprite_cells(&path, 11, true).expect("valid v2 atlas");

        atlas.put_pixel(
            6 * CELL_WIDTH + CELL_WIDTH / 2,
            CELL_HEIGHT / 2,
            image::Rgba([255, 255, 255, 255]),
        );
        atlas.save(&path).expect("save invalid v2 atlas");
        let error = validate_used_sprite_cells(&path, 11, true)
            .expect_err("non-transparent unused frame must fail");
        assert!(error.contains("row 0, column 6"), "{error}");
    }

    #[test]
    fn generated_install_canonicalizes_and_atomically_preserves_previous_pet() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("workspace/output/pet-one");
        let library = temp.path().join("library");
        write_test_pet_package(&source, "pet-one", None);

        let installed = install_pet_package(&source, &library).expect("install generated pet");
        assert_eq!(installed.id, "pet-one");
        assert_eq!(installed.source, "liveagent");
        assert_eq!(installed.spritesheet_path, "spritesheet.png");
        let installed_dir = library.join("pet-one");
        assert!(installed_dir.join("pet.json").is_file());
        assert!(installed_dir.join("spritesheet.png").is_file());
        assert!(!installed_dir.join("source-atlas.png").exists());
        assert_eq!(list_from_root(&library, "liveagent").len(), 1);
        let original_sheet = fs::read(installed_dir.join("spritesheet.png")).expect("old sheet");

        write_test_pet_package(&source, "pet-one", Some((4, 3)));
        let error = install_pet_package(&source, &library)
            .expect_err("invalid generated replacement must fail");
        assert!(error.contains("row 4, column 3"), "{error}");
        assert_eq!(
            fs::read(installed_dir.join("spritesheet.png")).expect("preserved sheet"),
            original_sheet
        );
        assert_eq!(list_from_root(&library, "liveagent").len(), 1);

        write_test_pet_package(&library.join("bad-pet"), "bad-pet", Some((0, 0)));
        assert_eq!(
            list_from_root(&library, "liveagent").len(),
            1,
            "pet_list must not expose manually copied packages that fail frame validation"
        );
    }

    #[test]
    fn generated_source_must_be_a_canonical_workspace_child() {
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().join("workspace");
        let source = workspace.join("output/pet-one");
        write_test_pet_package(&source, "pet-one", None);
        let valid = PetInstallGeneratedInput {
            workspace_root: workspace.to_string_lossy().into_owned(),
            pet_directory: "output/pet-one".to_string(),
            activate: true,
        };
        assert_eq!(
            resolve_generated_pet_directory(&valid).expect("workspace child"),
            fs::canonicalize(&source).expect("canonical source")
        );

        let outside = temp.path().join("outside");
        write_test_pet_package(&outside, "outside", None);
        let escape = PetInstallGeneratedInput {
            workspace_root: workspace.to_string_lossy().into_owned(),
            pet_directory: outside.to_string_lossy().into_owned(),
            activate: true,
        };
        assert!(resolve_generated_pet_directory(&escape).is_err());
    }

    #[test]
    fn native_builder_creates_valid_lossless_v2_package_with_chinese_display_name() {
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(workspace.join("generated")).expect("create output parent");
        let rows = write_test_build_strips(&workspace);
        let result = build_generated_pet(PetBuildGeneratedInput {
            workspace_root: workspace.to_string_lossy().into_owned(),
            output_directory: "generated/safe-pet-id".to_string(),
            id: "safe-pet-id".to_string(),
            display_name: "小桥的桌面伙伴".to_string(),
            description: "纯 Rust 组装".to_string(),
            kind: Some("mascot".to_string()),
            chroma_key: Some(PetBuildChromaKeyInput {
                r: 0,
                g: 255,
                b: 0,
                tolerance: 0,
            }),
            rows,
        })
        .expect("build generated pet");

        let package = PathBuf::from(&result.package_directory);
        assert_eq!(result.pet.id, "safe-pet-id");
        assert_eq!(result.pet.display_name, "小桥的桌面伙伴");
        assert_eq!(result.pet.sprite_version_number, 2);
        assert_eq!(result.pet.spritesheet_path, "spritesheet.webp");
        assert!(package.join("spritesheet.webp").is_file());
        assert_eq!(
            inspect_pet(&package, "generated")
                .expect("builder output validates")
                .sprite_version_number,
            2
        );

        let atlas = ImageReader::open(package.join("spritesheet.webp"))
            .expect("open webp")
            .decode()
            .expect("decode webp")
            .to_rgba8();
        let unused_cell_is_empty = (0..CELL_HEIGHT)
            .all(|y| (6 * CELL_WIDTH..7 * CELL_WIDTH).all(|x| atlas.get_pixel(x, y).0[3] == 0));
        assert!(
            unused_cell_is_empty,
            "unused v2 cells must remain transparent"
        );

        let installed = install_pet_package(&package, &temp.path().join("library"))
            .expect("builder output installs through native closure");
        assert_eq!(installed.id, "safe-pet-id");
        assert_eq!(installed.sprite_version_number, 2);
    }

    #[test]
    fn native_builder_rejects_unsafe_ids_and_incomplete_row_contracts() {
        assert!(validate_pet_id("中文宠物").is_err());
        let rows = vec![PetBuildRowInput {
            row: 0,
            frame_count: 6,
            path: "row-0.png".to_string(),
        }];
        let error = validate_pet_build_rows(&rows).expect_err("all 11 rows are required");
        assert!(error.contains("exactly 11"), "{error}");

        let mut duplicate_rows = (0..11)
            .map(|row| PetBuildRowInput {
                row,
                frame_count: V2_ROW_FRAME_COUNTS[row as usize],
                path: format!("row-{row}.png"),
            })
            .collect::<Vec<_>>();
        duplicate_rows[10].row = 9;
        let error = validate_pet_build_rows(&duplicate_rows).expect_err("duplicate row must fail");
        assert!(error.contains("duplicated"), "{error}");
    }

    #[test]
    fn monitor_selection_uses_target_then_containment_then_nearest_gap() {
        let names = vec![Some("retina".to_string()), Some("external".to_string())];
        let adjacent = vec![
            PetMonitorWorkArea {
                x: 0,
                y: 0,
                width: 1680,
                height: 1025,
            },
            PetMonitorWorkArea {
                x: 1680,
                y: 0,
                width: 1920,
                height: 1055,
            },
        ];
        assert_eq!(
            select_pet_monitor_index(&names, &adjacent, 1700, 500, None),
            Some(1)
        );
        assert_eq!(
            select_pet_monitor_index(&names, &adjacent, 400, 500, Some("external")),
            Some(1)
        );

        let with_gap = vec![
            adjacent[0],
            PetMonitorWorkArea {
                x: 1800,
                ..adjacent[1]
            },
        ];
        assert_eq!(
            select_pet_monitor_index(&names, &with_gap, 1760, 500, None),
            Some(1)
        );
    }

    #[test]
    fn visible_content_clamps_to_all_four_work_area_edges() {
        let area = PetMonitorWorkArea {
            x: 1680,
            y: 25,
            width: 1920,
            height: 1055,
        };
        let (left_x, top_y, min_x, min_y, max_x, max_y) =
            clamp_visible_content_to_work_area(area, -10_000, -10_000, 227, 260, 293, 408);
        assert_eq!((left_x, top_y), (min_x, min_y));
        assert_eq!(left_x + 227, area.x);
        assert_eq!(top_y + 260, area.y);

        let (right_x, bottom_y, _, _, _, _) =
            clamp_visible_content_to_work_area(area, 10_000, 10_000, 227, 260, 293, 408);
        assert_eq!((right_x, bottom_y), (max_x, max_y));
        assert_eq!(right_x + 293, area.x + area.width as i32);
        assert_eq!(bottom_y + 408, area.y + area.height as i32);
    }

    #[test]
    fn nearest_monitor_supports_negative_and_vertical_layouts() {
        let names = vec![Some("main".to_string()), Some("upper".to_string())];
        let areas = vec![
            PetMonitorWorkArea {
                x: 0,
                y: 0,
                width: 1680,
                height: 1025,
            },
            PetMonitorWorkArea {
                x: -500,
                y: -1200,
                width: 1920,
                height: 1080,
            },
        ];
        assert_eq!(
            select_pet_monitor_index(&names, &areas, -100, -500, None),
            Some(1)
        );
        assert_eq!(
            select_pet_monitor_index(&names, &areas, 100, -60, None),
            Some(0)
        );
    }
}
