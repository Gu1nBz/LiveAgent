use std::sync::Arc;

use tauri::State;

use crate::services::native_image::{
    NativeImageAdapterPublic, NativeImageAdapterSpec, NativeImageConfigPublic,
    NativeImageConfigUpdate, NativeImageDoctorResponse, NativeImageEditRequest,
    NativeImageGenerateRequest, NativeImageJobSnapshot, NativeImageService,
};

#[tauri::command]
pub async fn native_image_config_get(
    service: State<'_, Arc<NativeImageService>>,
) -> Result<NativeImageConfigPublic, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.config_get())
        .await
        .map_err(|error| format!("native_image_config_get join failed: {error}"))?
}

#[tauri::command]
pub async fn native_image_config_save(
    service: State<'_, Arc<NativeImageService>>,
    request: NativeImageConfigUpdate,
) -> Result<NativeImageConfigPublic, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.config_save(request))
        .await
        .map_err(|error| format!("native_image_config_save join failed: {error}"))?
}

#[tauri::command]
pub async fn native_image_config_clear(
    service: State<'_, Arc<NativeImageService>>,
) -> Result<NativeImageConfigPublic, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.config_clear())
        .await
        .map_err(|error| format!("native_image_config_clear join failed: {error}"))?
}

#[tauri::command]
pub async fn native_image_adapter_get(
    service: State<'_, Arc<NativeImageService>>,
) -> Result<NativeImageAdapterPublic, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.adapter_get())
        .await
        .map_err(|error| format!("native_image_adapter_get join failed: {error}"))?
}

#[tauri::command]
pub async fn native_image_adapter_save(
    service: State<'_, Arc<NativeImageService>>,
    adapter: NativeImageAdapterSpec,
) -> Result<NativeImageAdapterPublic, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.adapter_save(adapter))
        .await
        .map_err(|error| format!("native_image_adapter_save join failed: {error}"))?
}

#[tauri::command]
pub async fn native_image_adapter_clear(
    service: State<'_, Arc<NativeImageService>>,
) -> Result<NativeImageAdapterPublic, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.adapter_clear())
        .await
        .map_err(|error| format!("native_image_adapter_clear join failed: {error}"))?
}

#[tauri::command]
pub async fn native_image_doctor(
    service: State<'_, Arc<NativeImageService>>,
) -> Result<NativeImageDoctorResponse, String> {
    let service = Arc::clone(service.inner());
    Ok(service.doctor().await)
}

#[tauri::command]
pub async fn native_image_job_export(
    service: State<'_, Arc<NativeImageService>>,
    job_id: String,
    workspace_root: String,
    destination_dir: Option<String>,
) -> Result<Vec<crate::services::native_image::NativeImageOutput>, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.export_job(&job_id, &workspace_root, destination_dir.as_deref())
    })
    .await
    .map_err(|error| format!("native_image_job_export join failed: {error}"))?
}

#[tauri::command]
pub fn native_image_generate_start(
    service: State<'_, Arc<NativeImageService>>,
    request: NativeImageGenerateRequest,
) -> Result<NativeImageJobSnapshot, String> {
    Arc::clone(service.inner()).start_generate(request)
}

#[tauri::command]
pub fn native_image_edit_start(
    service: State<'_, Arc<NativeImageService>>,
    request: NativeImageEditRequest,
) -> Result<NativeImageJobSnapshot, String> {
    Arc::clone(service.inner()).start_edit(request)
}

#[tauri::command]
pub fn native_image_job_status(
    service: State<'_, Arc<NativeImageService>>,
    job_id: String,
) -> Result<NativeImageJobSnapshot, String> {
    service.job_status(&job_id)
}

#[tauri::command]
pub fn native_image_job_cancel(
    service: State<'_, Arc<NativeImageService>>,
    job_id: String,
) -> Result<NativeImageJobSnapshot, String> {
    service.cancel_job(&job_id)
}
