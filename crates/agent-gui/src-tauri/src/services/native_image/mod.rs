mod adapter;
mod store;
mod types;

pub use types::{
    NativeImageAdapterBodyType, NativeImageAdapterExtract, NativeImageAdapterFileSource,
    NativeImageAdapterHttpRequest, NativeImageAdapterMode, NativeImageAdapterOperation,
    NativeImageAdapterPublic, NativeImageAdapterSpec, NativeImageConfigPublic,
    NativeImageConfigUpdate, NativeImageDoctorResponse, NativeImageEditRequest,
    NativeImageEndpointMode, NativeImageGenerateRequest, NativeImageJobKind,
    NativeImageJobSnapshot, NativeImageJobStatus, NativeImageOutput, NativeImageOutputFormat,
};

use std::{
    collections::HashMap,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose, Engine as _};
use futures_util::StreamExt;
use image::{ImageFormat, ImageReader};
use reqwest::{
    header::{CONTENT_LENGTH, CONTENT_TYPE},
    multipart::{Form, Part},
    Client, Response, Url,
};
use serde_json::{json, Map, Value};
use tempfile::NamedTempFile;
use tokio::io::AsyncReadExt;
use tokio::task::AbortHandle;
use uuid::Uuid;

use self::{
    adapter::{call_adapter_edit, call_adapter_generate, validate_adapter_spec},
    store::NativeImageConfigStore,
    types::NativeImageConfig,
};

const MAX_PROMPT_BYTES: usize = 32 * 1024;
const MAX_MODEL_BYTES: usize = 256;
const MAX_INPUT_IMAGES: usize = 8;
const MAX_IMAGES_PER_JOB: u8 = 4;
const MAX_INPUT_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_INPUT_TOTAL_BYTES: usize = 100 * 1024 * 1024;
const MAX_OUTPUT_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const MAX_API_RESPONSE_BYTES: usize = 128 * 1024 * 1024;
const MAX_API_ERROR_BYTES: usize = 32 * 1024;
const MAX_IMAGE_PIXELS: u64 = 64_000_000;
const MAX_ERROR_CHARS: usize = 4_096;
const MAX_RETAINED_JOBS: usize = 128;
const MAX_CONCURRENT_JOBS: usize = 4;

struct JobEntry {
    snapshot: NativeImageJobSnapshot,
    cancelled: Arc<AtomicBool>,
    abort_handle: Option<AbortHandle>,
}

#[derive(Default)]
struct NativeImageJobRegistry {
    jobs: Mutex<HashMap<String, JobEntry>>,
}

enum JobWork {
    Generate(NativeImageGenerateRequest),
    Edit(NativeImageEditRequest),
}

enum RemoteImage {
    Base64 {
        encoded: String,
        declared_mime: Option<String>,
    },
    Url(String),
}

struct ValidatedImage {
    bytes: Vec<u8>,
    format: ImageFormat,
    mime_type: &'static str,
    width: u32,
    height: u32,
}

struct InputImage {
    bytes: Vec<u8>,
    file_name: String,
    mime_type: &'static str,
    width: u32,
    height: u32,
}

pub struct NativeImageService {
    config_store: NativeImageConfigStore,
    output_dir: PathBuf,
    jobs: NativeImageJobRegistry,
}

impl NativeImageService {
    pub fn app_default() -> Result<Self, String> {
        let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
        let output_dir = home
            .join(format!(".{}", env!("CARGO_PKG_NAME")))
            .join("generated_images");
        Self::with_store(NativeImageConfigStore::app_default()?, output_dir)
    }

    fn with_store(
        config_store: NativeImageConfigStore,
        output_dir: PathBuf,
    ) -> Result<Self, String> {
        std::fs::create_dir_all(&output_dir)
            .map_err(|error| format!("创建 LiveAgent 图片输出目录失败：{error}"))?;
        secure_output_directory(&output_dir)?;
        let output_dir = std::fs::canonicalize(&output_dir)
            .map_err(|error| format!("解析 LiveAgent 图片输出目录失败：{error}"))?;
        Ok(Self {
            config_store,
            output_dir,
            jobs: NativeImageJobRegistry::default(),
        })
    }

    #[cfg(test)]
    fn test_service(root: &Path) -> Result<Self, String> {
        Self::with_store(
            NativeImageConfigStore::open(root.join("config.sqlite"))?,
            root.join("generated_images"),
        )
    }

    pub fn config_get(&self) -> Result<NativeImageConfigPublic, String> {
        Ok(self.config_store.load()?.public())
    }

    pub fn config_save(
        &self,
        update: NativeImageConfigUpdate,
    ) -> Result<NativeImageConfigPublic, String> {
        self.config_store.update(update)
    }

    pub fn config_clear(&self) -> Result<NativeImageConfigPublic, String> {
        self.config_store.clear()
    }

    pub fn adapter_get(&self) -> Result<NativeImageAdapterPublic, String> {
        self.config_store.adapter_get()
    }

    pub fn adapter_save(
        &self,
        adapter: NativeImageAdapterSpec,
    ) -> Result<NativeImageAdapterPublic, String> {
        self.config_store.adapter_save(adapter)
    }

    pub fn adapter_clear(&self) -> Result<NativeImageAdapterPublic, String> {
        self.config_store.adapter_clear()
    }

    pub async fn doctor(&self) -> NativeImageDoctorResponse {
        let started = Instant::now();
        let config = match self.config_store.load() {
            Ok(config) => config,
            Err(error) => {
                return NativeImageDoctorResponse {
                    ok: false,
                    base_url: String::new(),
                    endpoint: String::new(),
                    status_code: None,
                    latency_ms: elapsed_ms(started),
                    api_key_configured: false,
                    message: safe_error(&error, None),
                };
            }
        };
        let endpoint = match endpoint_url(&config.base_url, "models") {
            Ok(value) => value,
            Err(error) => {
                return NativeImageDoctorResponse {
                    ok: false,
                    base_url: config.base_url,
                    endpoint: String::new(),
                    status_code: None,
                    latency_ms: elapsed_ms(started),
                    api_key_configured: !config.api_key.is_empty(),
                    message: safe_error(&error, Some(&config.api_key)),
                };
            }
        };
        if config.api_key.trim().is_empty() {
            return NativeImageDoctorResponse {
                ok: false,
                base_url: config.base_url,
                endpoint: endpoint.to_string(),
                status_code: None,
                latency_ms: elapsed_ms(started),
                api_key_configured: false,
                message: "API key 尚未配置".to_string(),
            };
        }
        if let Err(error) = validate_api_key(&config.api_key) {
            return NativeImageDoctorResponse {
                ok: false,
                base_url: config.base_url,
                endpoint: endpoint.to_string(),
                status_code: None,
                latency_ms: elapsed_ms(started),
                api_key_configured: true,
                message: error,
            };
        }
        if let Some(adapter) = &config.adapter {
            let adapter_endpoint = adapter_endpoint_url(
                &config.base_url,
                adapter.generate.submit.path.trim_start_matches('/'),
            )
            .map(|value| value.to_string())
            .unwrap_or_else(|_| config.base_url.clone());
            return NativeImageDoctorResponse {
                ok: true,
                base_url: config.base_url,
                endpoint: adapter_endpoint,
                status_code: None,
                latency_ms: elapsed_ms(started),
                api_key_configured: true,
                message: format!(
                    "AI 图片协议“{}”已配置，将在首次图片任务中验证真实请求与响应",
                    adapter.name
                ),
            };
        }

        let client = match build_client(config.timeout_seconds.min(30)) {
            Ok(client) => client,
            Err(error) => {
                return NativeImageDoctorResponse {
                    ok: false,
                    base_url: config.base_url,
                    endpoint: endpoint.to_string(),
                    status_code: None,
                    latency_ms: elapsed_ms(started),
                    api_key_configured: true,
                    message: safe_error(&error, Some(&config.api_key)),
                };
            }
        };
        match client
            .get(endpoint.clone())
            .bearer_auth(&config.api_key)
            .send()
            .await
        {
            Ok(response) => {
                let status = response.status();
                // A number of image-only OpenAI-compatible relays deliberately
                // omit `/models` while still implementing image generation and
                // editing. Treat an explicit "probe unsupported" response as a
                // reachable service; authentication and actual capabilities are
                // still validated by the first image job.
                let probe_unsupported = matches!(status.as_u16(), 404 | 405);
                NativeImageDoctorResponse {
                    ok: status.is_success() || probe_unsupported,
                    base_url: config.base_url,
                    endpoint: endpoint.to_string(),
                    status_code: Some(status.as_u16()),
                    latency_ms: elapsed_ms(started),
                    api_key_configured: true,
                    message: if status.is_success() {
                        "图片服务连接正常".to_string()
                    } else if probe_unsupported {
                        "图片服务可达，但未提供模型列表；将在首次图片任务中验证能力".to_string()
                    } else {
                        format!("图片服务返回 HTTP {}", status.as_u16())
                    },
                }
            }
            Err(error) => NativeImageDoctorResponse {
                ok: false,
                base_url: config.base_url,
                endpoint: endpoint.to_string(),
                status_code: None,
                latency_ms: elapsed_ms(started),
                api_key_configured: true,
                message: safe_error(&format!("图片服务连接失败：{error}"), Some(&config.api_key)),
            },
        }
    }

    pub fn start_generate(
        self: &Arc<Self>,
        request: NativeImageGenerateRequest,
    ) -> Result<NativeImageJobSnapshot, String> {
        validate_generate_request(&request)?;
        self.start_job(NativeImageJobKind::Generate, JobWork::Generate(request))
    }

    pub fn start_edit(
        self: &Arc<Self>,
        request: NativeImageEditRequest,
    ) -> Result<NativeImageJobSnapshot, String> {
        validate_edit_request(&request)?;
        self.start_job(NativeImageJobKind::Edit, JobWork::Edit(request))
    }

    fn start_job(
        self: &Arc<Self>,
        kind: NativeImageJobKind,
        work: JobWork,
    ) -> Result<NativeImageJobSnapshot, String> {
        let config = self.config_store.load()?;
        if config.api_key.trim().is_empty() {
            return Err("图片服务 API key 尚未配置".to_string());
        }
        validate_api_key(&config.api_key)?;
        normalize_base_url(&config.base_url)?;
        validate_model(&config.generation_model, "generationModel")?;
        validate_model(&config.edit_model, "editModel")?;
        if let Some(adapter) = &config.adapter {
            validate_adapter_spec(adapter)?;
        }

        let id = Uuid::new_v4().to_string();
        let now = now_ms();
        let snapshot = NativeImageJobSnapshot {
            id: id.clone(),
            kind,
            status: NativeImageJobStatus::Queued,
            created_at: now,
            updated_at: now,
            outputs: Vec::new(),
            error: None,
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut jobs = self
                .jobs
                .jobs
                .lock()
                .map_err(|_| "图片任务状态锁已损坏".to_string())?;
            prune_jobs(&mut jobs);
            let active_count = jobs
                .values()
                .filter(|entry| !entry.snapshot.status.is_terminal())
                .count();
            if active_count >= MAX_CONCURRENT_JOBS {
                return Err(format!(
                    "同时运行的图片任务不能超过 {MAX_CONCURRENT_JOBS} 个"
                ));
            }
            if jobs.len() >= MAX_RETAINED_JOBS {
                return Err("图片任务历史已满，请等待正在运行的任务结束后重试".to_string());
            }
            jobs.insert(
                id.clone(),
                JobEntry {
                    snapshot: snapshot.clone(),
                    cancelled: Arc::clone(&cancelled),
                    abort_handle: None,
                },
            );
        }

        let service = Arc::clone(self);
        let task_id = id.clone();
        let task_key = config.api_key.clone();
        // Tauri may dispatch synchronous commands on the macOS main thread,
        // which has no entered Tokio context. Always schedule through Tauri's
        // process-wide runtime instead of calling `tokio::spawn` directly.
        let handle = tauri::async_runtime::spawn(async move {
            service.mark_running(&task_id);
            if cancelled.load(Ordering::Acquire) {
                return;
            }
            let result = service.run_job(&task_id, &config, work, &cancelled).await;
            match result {
                Ok(outputs) => service.mark_succeeded(&task_id, outputs),
                Err(error) => {
                    if !cancelled.load(Ordering::Acquire) {
                        service.mark_failed(&task_id, safe_error(&error, Some(&task_key)));
                    }
                }
            }
        });
        let abort_handle = handle.inner().abort_handle();
        drop(handle);
        if let Ok(mut jobs) = self.jobs.jobs.lock() {
            if let Some(entry) = jobs.get_mut(&id) {
                if !entry.snapshot.status.is_terminal() {
                    entry.abort_handle = Some(abort_handle);
                }
            }
        }
        Ok(snapshot)
    }

    pub fn job_status(&self, job_id: &str) -> Result<NativeImageJobSnapshot, String> {
        let jobs = self
            .jobs
            .jobs
            .lock()
            .map_err(|_| "图片任务状态锁已损坏".to_string())?;
        jobs.get(job_id.trim())
            .map(|entry| entry.snapshot.clone())
            .ok_or_else(|| format!("图片任务不存在：{}", job_id.trim()))
    }

    pub fn cancel_job(&self, job_id: &str) -> Result<NativeImageJobSnapshot, String> {
        let (snapshot, abort_handle) = {
            let mut jobs = self
                .jobs
                .jobs
                .lock()
                .map_err(|_| "图片任务状态锁已损坏".to_string())?;
            let entry = jobs
                .get_mut(job_id.trim())
                .ok_or_else(|| format!("图片任务不存在：{}", job_id.trim()))?;
            if entry.snapshot.status.is_terminal() {
                return Ok(entry.snapshot.clone());
            }
            entry.cancelled.store(true, Ordering::Release);
            entry.snapshot.status = NativeImageJobStatus::Cancelled;
            entry.snapshot.updated_at = now_ms();
            entry.snapshot.error = None;
            (entry.snapshot.clone(), entry.abort_handle.take())
        };
        if let Some(handle) = abort_handle {
            handle.abort();
        }
        Ok(snapshot)
    }

    /// Atomically exports a completed job into an existing directory under a
    /// canonical workspace root. Existing files are never overwritten.
    pub fn export_job(
        &self,
        job_id: &str,
        workspace_root: &str,
        destination_dir: Option<&str>,
    ) -> Result<Vec<NativeImageOutput>, String> {
        let snapshot = self.job_status(job_id)?;
        if snapshot.status != NativeImageJobStatus::Succeeded || snapshot.outputs.is_empty() {
            return Err("只能导出已成功且包含输出的图片任务".to_string());
        }
        let workspace = canonical_directory(workspace_root, "workspaceRoot")?;
        let destination = match destination_dir
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(value) => {
                let value = Path::new(value);
                let candidate = if value.is_absolute() {
                    value.to_path_buf()
                } else {
                    workspace.join(value)
                };
                canonical_directory_path(&candidate, "destinationDir")?
            }
            None => workspace.clone(),
        };
        if !destination.starts_with(&workspace) {
            return Err("destinationDir 必须位于 workspaceRoot 内".to_string());
        }

        let mut exported = Vec::with_capacity(snapshot.outputs.len());
        for output in snapshot.outputs {
            let result = (|| {
                let source = std::fs::canonicalize(&output.path)
                    .map_err(|error| format!("解析图片输出路径失败：{error}"))?;
                if !source.starts_with(&self.output_dir) || !source.is_file() {
                    return Err("图片任务输出路径无效".to_string());
                }
                let metadata = std::fs::symlink_metadata(&source)
                    .map_err(|error| format!("读取图片输出元数据失败：{error}"))?;
                if metadata.file_type().is_symlink()
                    || metadata.len() == 0
                    || metadata.len() > MAX_OUTPUT_IMAGE_BYTES as u64
                {
                    return Err("图片任务输出不是可导出的普通图片文件".to_string());
                }
                let file_name = source
                    .file_name()
                    .ok_or_else(|| "图片任务输出缺少文件名".to_string())?;
                let target = destination.join(file_name);
                if target.parent() != Some(destination.as_path()) || target.exists() {
                    return Err(format!("导出目标已存在或路径无效：{}", target.display()));
                }
                let file = std::fs::File::open(&source)
                    .map_err(|error| format!("打开待导出图片失败：{error}"))?;
                let mut bytes = Vec::with_capacity(metadata.len() as usize);
                file.take(MAX_OUTPUT_IMAGE_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|error| format!("读取待导出图片失败：{error}"))?;
                if bytes.len() > MAX_OUTPUT_IMAGE_BYTES {
                    return Err("待导出图片在读取期间超过大小限制".to_string());
                }
                let validated = validate_image_bytes(bytes, Some(&output.mime_type))?;
                let mut temporary = NamedTempFile::new_in(&destination)
                    .map_err(|error| format!("创建导出临时文件失败：{error}"))?;
                temporary
                    .write_all(&validated.bytes)
                    .map_err(|error| format!("写入导出临时文件失败：{error}"))?;
                temporary
                    .as_file()
                    .sync_all()
                    .map_err(|error| format!("同步导出临时文件失败：{error}"))?;
                temporary
                    .persist_noclobber(&target)
                    .map_err(|error| format!("原子导出图片失败：{}", error.error))?;
                Ok(NativeImageOutput {
                    path: target.to_string_lossy().into_owned(),
                    mime_type: validated.mime_type.to_string(),
                    width: validated.width,
                    height: validated.height,
                    size_bytes: validated.bytes.len() as u64,
                })
            })();
            match result {
                Ok(output) => exported.push(output),
                Err(error) => {
                    cleanup_outputs(&exported);
                    return Err(error);
                }
            }
        }
        Ok(exported)
    }

    fn mark_running(&self, job_id: &str) {
        if let Ok(mut jobs) = self.jobs.jobs.lock() {
            if let Some(entry) = jobs.get_mut(job_id) {
                if entry.snapshot.status == NativeImageJobStatus::Queued {
                    entry.snapshot.status = NativeImageJobStatus::Running;
                    entry.snapshot.updated_at = now_ms();
                }
            }
        }
    }

    fn mark_succeeded(&self, job_id: &str, outputs: Vec<NativeImageOutput>) {
        if let Ok(mut jobs) = self.jobs.jobs.lock() {
            if let Some(entry) = jobs.get_mut(job_id) {
                if !entry.cancelled.load(Ordering::Acquire) {
                    entry.snapshot.status = NativeImageJobStatus::Succeeded;
                    entry.snapshot.outputs = outputs;
                    entry.snapshot.error = None;
                    entry.snapshot.updated_at = now_ms();
                    entry.abort_handle = None;
                }
            }
        }
    }

    fn mark_failed(&self, job_id: &str, error: String) {
        if let Ok(mut jobs) = self.jobs.jobs.lock() {
            if let Some(entry) = jobs.get_mut(job_id) {
                if !entry.cancelled.load(Ordering::Acquire) {
                    entry.snapshot.status = NativeImageJobStatus::Failed;
                    entry.snapshot.error = Some(error);
                    entry.snapshot.updated_at = now_ms();
                    entry.abort_handle = None;
                }
            }
        }
    }

    async fn run_job(
        &self,
        job_id: &str,
        config: &NativeImageConfig,
        work: JobWork,
        cancelled: &AtomicBool,
    ) -> Result<Vec<NativeImageOutput>, String> {
        let client = build_client(config.timeout_seconds)?;
        let (images, output_format, expected_count) = match work {
            JobWork::Generate(request) => {
                let count = request.n.unwrap_or(1);
                let images = match &config.adapter {
                    Some(adapter) => {
                        call_adapter_generate(&client, config, &request, adapter, cancelled).await?
                    }
                    None => match config.endpoint_mode {
                        NativeImageEndpointMode::Images => {
                            call_images_generate(&client, config, &request).await?
                        }
                        NativeImageEndpointMode::Responses => {
                            call_responses_generate(&client, config, &request, cancelled).await?
                        }
                    },
                };
                (images, request.output_format, count)
            }
            JobWork::Edit(request) => {
                let count = request.n.unwrap_or(1);
                let images = match &config.adapter {
                    Some(adapter) => {
                        call_adapter_edit(
                            &client,
                            config,
                            &request,
                            adapter,
                            &self.output_dir,
                            cancelled,
                        )
                        .await?
                    }
                    None => match config.endpoint_mode {
                        NativeImageEndpointMode::Images => {
                            call_images_edit(&client, config, &request, &self.output_dir).await?
                        }
                        NativeImageEndpointMode::Responses => {
                            call_responses_edit(
                                &client,
                                config,
                                &request,
                                &self.output_dir,
                                cancelled,
                            )
                            .await?
                        }
                    },
                };
                (images, request.output_format, count)
            }
        };
        if cancelled.load(Ordering::Acquire) {
            return Err("图片任务已取消".to_string());
        }
        if images.is_empty() {
            return Err("图片服务响应中没有图片".to_string());
        }
        if images.len() > usize::from(expected_count) {
            return Err(format!(
                "图片服务返回了过多图片（期望最多 {expected_count}，实际 {}）",
                images.len()
            ));
        }

        let mut outputs = Vec::with_capacity(images.len());
        for (index, remote) in images.into_iter().enumerate() {
            if cancelled.load(Ordering::Acquire) {
                cleanup_outputs(&outputs);
                return Err("图片任务已取消".to_string());
            }
            let validated = match materialize_remote_image(&client, remote).await {
                Ok(validated) => validated,
                Err(error) => {
                    cleanup_outputs(&outputs);
                    return Err(error);
                }
            };
            if cancelled.load(Ordering::Acquire) {
                cleanup_outputs(&outputs);
                return Err("图片任务已取消".to_string());
            }
            match write_validated_image(&self.output_dir, job_id, index, validated, output_format) {
                Ok(output) => outputs.push(output),
                Err(error) => {
                    cleanup_outputs(&outputs);
                    return Err(error);
                }
            }
        }
        if cancelled.load(Ordering::Acquire) {
            cleanup_outputs(&outputs);
            return Err("图片任务已取消".to_string());
        }
        Ok(outputs)
    }
}

fn prune_jobs(jobs: &mut HashMap<String, JobEntry>) {
    if jobs.len() < MAX_RETAINED_JOBS {
        return;
    }
    let mut terminal = jobs
        .iter()
        .filter(|(_, entry)| entry.snapshot.status.is_terminal())
        .map(|(id, entry)| (id.clone(), entry.snapshot.updated_at))
        .collect::<Vec<_>>();
    terminal.sort_by_key(|(_, updated_at)| *updated_at);
    let remove_count = jobs
        .len()
        .saturating_sub(MAX_RETAINED_JOBS.saturating_sub(1));
    for (id, _) in terminal.into_iter().take(remove_count) {
        jobs.remove(&id);
    }
}

pub(crate) fn validate_config_update(update: &NativeImageConfigUpdate) -> Result<(), String> {
    normalize_base_url(&update.base_url)?;
    if let Some(model) = &update.generation_model {
        validate_model(model, "generationModel")?;
    }
    if let Some(model) = &update.edit_model {
        validate_model(model, "editModel")?;
    }
    if let Some(timeout) = update.timeout_seconds {
        if !(10..=600).contains(&timeout) {
            return Err("timeoutSeconds 必须在 10 到 600 之间".to_string());
        }
    }
    if update.clear_api_key
        && update
            .api_key_update
            .as_ref()
            .is_some_and(|key| !key.is_empty())
    {
        return Err("clearApiKey 与 apiKeyUpdate 不能同时设置".to_string());
    }
    if let Some(key) = &update.api_key_update {
        if !key.trim().is_empty() {
            validate_api_key(key.trim())?;
        }
    }
    Ok(())
}

fn validate_api_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 8_192 {
        return Err("API key 不能为空且不能超过 8192 字节".to_string());
    }
    if !key
        .bytes()
        .all(|byte| byte.is_ascii() && !byte.is_ascii_control() && !byte.is_ascii_whitespace())
    {
        return Err("API key 只能包含不带空白的 ASCII 可打印字符".to_string());
    }
    Ok(())
}

pub(crate) fn normalize_base_url(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 2_048 {
        return Err("baseUrl 不能为空且不能超过 2048 字节".to_string());
    }
    let mut url = Url::parse(value).map_err(|error| format!("baseUrl 无效：{error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("baseUrl 仅支持 http 或 https".to_string());
    }
    if url.host_str().is_none() {
        return Err("baseUrl 必须包含主机名".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("baseUrl 不能包含用户名或密码".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("baseUrl 不能包含查询参数或片段".to_string());
    }
    let trimmed_path = url.path().trim_end_matches('/').to_string();
    url.set_path(if trimmed_path.is_empty() {
        "/"
    } else {
        &trimmed_path
    });
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn normalize_openai_base_url(value: &str) -> Result<String, String> {
    let value = normalize_base_url(value)?;
    let mut url = Url::parse(&value).map_err(|error| format!("baseUrl 无效：{error}"))?;
    let trimmed_path = url.path().trim_end_matches('/');
    let path = if trimmed_path.ends_with("/v1") || trimmed_path == "/v1" {
        trimmed_path.to_string()
    } else if trimmed_path.is_empty() {
        "/v1".to_string()
    } else {
        format!("{trimmed_path}/v1")
    };
    url.set_path(&path);
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn endpoint_url(base_url: &str, endpoint: &str) -> Result<Url, String> {
    let base = normalize_openai_base_url(base_url)?;
    Url::parse(&format!("{base}/{}", endpoint.trim_start_matches('/')))
        .map_err(|error| format!("图片服务 endpoint 无效：{error}"))
}

fn adapter_endpoint_url(base_url: &str, endpoint: &str) -> Result<Url, String> {
    let base = normalize_base_url(base_url)?;
    Url::parse(&format!("{base}/{}", endpoint.trim_start_matches('/')))
        .map_err(|error| format!("AI 图片协议 endpoint 无效：{error}"))
}

fn canonical_directory(value: &str, field: &str) -> Result<PathBuf, String> {
    let path = Path::new(value.trim());
    if value.trim().is_empty() || !path.is_absolute() {
        return Err(format!("{field} 必须是非空绝对路径"));
    }
    let canonical =
        std::fs::canonicalize(path).map_err(|error| format!("解析 {field} 失败：{error}"))?;
    if !canonical.is_dir() {
        return Err(format!("{field} 必须是已存在的目录"));
    }
    Ok(canonical)
}

fn canonical_directory_path(path: &Path, field: &str) -> Result<PathBuf, String> {
    let link_metadata =
        std::fs::symlink_metadata(path).map_err(|error| format!("读取 {field} 失败：{error}"))?;
    if link_metadata.file_type().is_symlink() {
        return Err(format!("{field} 不能是符号链接"));
    }
    let canonical =
        std::fs::canonicalize(path).map_err(|error| format!("解析 {field} 失败：{error}"))?;
    if !canonical.is_dir() {
        return Err(format!("{field} 必须是已存在的目录"));
    }
    Ok(canonical)
}

fn build_client(timeout_seconds: u64) -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(timeout_seconds.clamp(10, 600)))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent(format!("LiveAgent/{}", crate::app_version()))
        .build()
        .map_err(|error| format!("创建图片服务 HTTP client 失败：{error}"))
}

fn validate_generate_request(request: &NativeImageGenerateRequest) -> Result<(), String> {
    validate_common_request(
        &request.prompt,
        request.model.as_deref(),
        request.size.as_deref(),
        request.quality.as_deref(),
        request.background.as_deref(),
        request.n,
    )
}

fn validate_edit_request(request: &NativeImageEditRequest) -> Result<(), String> {
    validate_common_request(
        &request.prompt,
        request.model.as_deref(),
        request.size.as_deref(),
        request.quality.as_deref(),
        request.background.as_deref(),
        request.n,
    )?;
    if request.input_paths.is_empty() || request.input_paths.len() > MAX_INPUT_IMAGES {
        return Err(format!(
            "inputPaths 必须包含 1 到 {MAX_INPUT_IMAGES} 张图片"
        ));
    }
    for path in request.input_paths.iter().chain(request.mask_path.iter()) {
        if path.trim().is_empty() || !Path::new(path).is_absolute() {
            return Err("输入图片必须使用非空绝对路径".to_string());
        }
    }
    if let Some(workspace_root) = request.workspace_root.as_deref() {
        if workspace_root.trim().is_empty() || !Path::new(workspace_root).is_absolute() {
            return Err("workspaceRoot 必须是非空绝对路径".to_string());
        }
    }
    Ok(())
}

fn validate_common_request(
    prompt: &str,
    model: Option<&str>,
    size: Option<&str>,
    quality: Option<&str>,
    background: Option<&str>,
    n: Option<u8>,
) -> Result<(), String> {
    let prompt = prompt.trim();
    if prompt.is_empty() || prompt.len() > MAX_PROMPT_BYTES {
        return Err(format!("prompt 不能为空且不能超过 {MAX_PROMPT_BYTES} 字节"));
    }
    if prompt.contains('\0') {
        return Err("prompt 不能包含 NUL 字符".to_string());
    }
    if let Some(model) = model {
        validate_model(model, "model")?;
    }
    if let Some(size) = size {
        validate_size(size)?;
    }
    if let Some(quality) = quality {
        if !matches!(
            quality.trim().to_ascii_lowercase().as_str(),
            "auto" | "low" | "medium" | "high" | "standard" | "hd"
        ) {
            return Err("quality 不受支持".to_string());
        }
    }
    if let Some(background) = background {
        if !matches!(
            background.trim().to_ascii_lowercase().as_str(),
            "auto" | "transparent" | "opaque"
        ) {
            return Err("background 必须是 auto、transparent 或 opaque".to_string());
        }
    }
    if !(1..=MAX_IMAGES_PER_JOB).contains(&n.unwrap_or(1)) {
        return Err(format!("n 必须在 1 到 {MAX_IMAGES_PER_JOB} 之间"));
    }
    Ok(())
}

fn validate_model(model: &str, field: &str) -> Result<(), String> {
    let model = model.trim();
    if model.is_empty() || model.len() > MAX_MODEL_BYTES {
        return Err(format!("{field} 不能为空且不能超过 {MAX_MODEL_BYTES} 字节"));
    }
    if model.chars().any(char::is_control) {
        return Err(format!("{field} 不能包含控制字符"));
    }
    Ok(())
}

fn validate_size(size: &str) -> Result<(), String> {
    let size = size.trim().to_ascii_lowercase();
    if size == "auto" {
        return Ok(());
    }
    let Some((width, height)) = size.split_once('x') else {
        return Err("size 必须是 auto 或 WIDTHxHEIGHT".to_string());
    };
    let width = width
        .parse::<u32>()
        .map_err(|_| "size 宽度无效".to_string())?;
    let height = height
        .parse::<u32>()
        .map_err(|_| "size 高度无效".to_string())?;
    if !(64..=4096).contains(&width)
        || !(64..=4096).contains(&height)
        || u64::from(width) * u64::from(height) > 16_777_216
    {
        return Err("size 超出允许范围".to_string());
    }
    Ok(())
}

fn common_api_payload(
    prompt: &str,
    model: &str,
    size: Option<&str>,
    quality: Option<&str>,
    background: Option<&str>,
    output_format: NativeImageOutputFormat,
    n: u8,
) -> Map<String, Value> {
    let mut body = Map::new();
    body.insert("model".to_string(), json!(model.trim()));
    body.insert("prompt".to_string(), json!(prompt.trim()));
    body.insert("n".to_string(), json!(n));
    body.insert("size".to_string(), json!(size.unwrap_or("auto")));
    body.insert("quality".to_string(), json!(quality.unwrap_or("medium")));
    body.insert(
        "output_format".to_string(),
        json!(output_format.as_api_str()),
    );
    if let Some(background) = background {
        body.insert("background".to_string(), json!(background));
    }
    body
}

async fn call_images_generate(
    client: &Client,
    config: &NativeImageConfig,
    request: &NativeImageGenerateRequest,
) -> Result<Vec<RemoteImage>, String> {
    let model = request.model.as_deref().unwrap_or(&config.generation_model);
    let body = common_api_payload(
        &request.prompt,
        model,
        request.size.as_deref(),
        request.quality.as_deref(),
        request.background.as_deref(),
        request.output_format,
        request.n.unwrap_or(1),
    );
    let endpoint = endpoint_url(&config.base_url, "images/generations")?;
    let response = client
        .post(endpoint)
        .bearer_auth(&config.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("图片生成请求失败：{error}"))?;
    let body = read_success_body(response, &config.api_key).await?;
    parse_images_api_body(&body)
}

async fn call_responses_generate(
    client: &Client,
    config: &NativeImageConfig,
    request: &NativeImageGenerateRequest,
    cancelled: &AtomicBool,
) -> Result<Vec<RemoteImage>, String> {
    let endpoint = endpoint_url(&config.base_url, "responses")?;
    let model = request.model.as_deref().unwrap_or(&config.generation_model);
    let mut tool = Map::new();
    tool.insert("type".to_string(), json!("image_generation"));
    tool.insert(
        "size".to_string(),
        json!(request.size.as_deref().unwrap_or("auto")),
    );
    tool.insert(
        "quality".to_string(),
        json!(request.quality.as_deref().unwrap_or("medium")),
    );
    tool.insert(
        "output_format".to_string(),
        json!(request.output_format.as_api_str()),
    );
    if let Some(background) = &request.background {
        tool.insert("background".to_string(), json!(background));
    }
    let payload = json!({
        "model": model.trim(),
        "input": [{
            "role": "user",
            "content": [{"type": "input_text", "text": request.prompt.trim()}]
        }],
        "tools": [Value::Object(tool)],
        "stream": false
    });

    let mut result = Vec::new();
    for _ in 0..request.n.unwrap_or(1) {
        if cancelled.load(Ordering::Acquire) {
            return Err("图片任务已取消".to_string());
        }
        let response = client
            .post(endpoint.clone())
            .bearer_auth(&config.api_key)
            .json(&payload)
            .send()
            .await
            .map_err(|error| format!("Responses 图片生成请求失败：{error}"))?;
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let body = read_success_body(response, &config.api_key).await?;
        let mut images = parse_responses_api_body(&body, &content_type)?;
        let Some(first) = images.drain(..).next() else {
            return Err("Responses API 响应中没有生成图片".to_string());
        };
        result.push(first);
    }
    Ok(result)
}

async fn call_images_edit(
    client: &Client,
    config: &NativeImageConfig,
    request: &NativeImageEditRequest,
    generated_images_root: &Path,
) -> Result<Vec<RemoteImage>, String> {
    let mut allowed_roots = vec![generated_images_root.to_path_buf()];
    if let Some(workspace_root) = request.workspace_root.as_deref() {
        allowed_roots.push(canonical_directory(workspace_root, "workspaceRoot")?);
    }
    let mut inputs = Vec::with_capacity(request.input_paths.len());
    let mut total_input_bytes = 0usize;
    for path in &request.input_paths {
        let input = read_input_image(path, &allowed_roots).await?;
        total_input_bytes = total_input_bytes.saturating_add(input.bytes.len());
        if total_input_bytes > MAX_INPUT_TOTAL_BYTES {
            return Err("输入图片总大小不能超过 100 MiB".to_string());
        }
        inputs.push(input);
    }
    let mask = match request.mask_path.as_deref() {
        Some(path) => {
            let mask = read_input_image(path, &allowed_roots).await?;
            if total_input_bytes.saturating_add(mask.bytes.len()) > MAX_INPUT_TOTAL_BYTES {
                return Err("输入图片与 mask 总大小不能超过 100 MiB".to_string());
            }
            Some(mask)
        }
        None => None,
    };
    if let (Some(first), Some(mask)) = (inputs.first(), mask.as_ref()) {
        if first.width != mask.width || first.height != mask.height {
            return Err("mask 尺寸必须与第一张输入图片一致".to_string());
        }
    }

    let mut form = Form::new()
        .text(
            "model",
            request
                .model
                .as_deref()
                .unwrap_or(&config.edit_model)
                .trim()
                .to_string(),
        )
        .text("prompt", request.prompt.trim().to_string())
        .text("n", request.n.unwrap_or(1).to_string())
        .text(
            "size",
            request.size.as_deref().unwrap_or("auto").to_string(),
        )
        .text(
            "quality",
            request.quality.as_deref().unwrap_or("medium").to_string(),
        )
        .text(
            "output_format",
            request.output_format.as_api_str().to_string(),
        );
    if let Some(background) = &request.background {
        form = form.text("background", background.clone());
    }
    for input in inputs {
        let part = Part::bytes(input.bytes)
            .file_name(input.file_name)
            .mime_str(input.mime_type)
            .map_err(|error| format!("构建输入图片 multipart 失败：{error}"))?;
        form = form.part("image", part);
    }
    if let Some(mask) = mask {
        let part = Part::bytes(mask.bytes)
            .file_name(mask.file_name)
            .mime_str(mask.mime_type)
            .map_err(|error| format!("构建 mask multipart 失败：{error}"))?;
        form = form.part("mask", part);
    }

    let endpoint = endpoint_url(&config.base_url, "images/edits")?;
    let response = client
        .post(endpoint)
        .bearer_auth(&config.api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("图片编辑请求失败：{error}"))?;
    let body = read_success_body(response, &config.api_key).await?;
    parse_images_api_body(&body)
}

async fn call_responses_edit(
    client: &Client,
    config: &NativeImageConfig,
    request: &NativeImageEditRequest,
    generated_images_root: &Path,
    cancelled: &AtomicBool,
) -> Result<Vec<RemoteImage>, String> {
    if request.mask_path.is_some() {
        return Err(
            "Responses endpoint 模式不支持精确 mask 编辑；请切换到 Images endpoint 模式"
                .to_string(),
        );
    }

    let mut allowed_roots = vec![generated_images_root.to_path_buf()];
    if let Some(workspace_root) = request.workspace_root.as_deref() {
        allowed_roots.push(canonical_directory(workspace_root, "workspaceRoot")?);
    }
    let mut inputs = Vec::with_capacity(request.input_paths.len());
    let mut total_input_bytes = 0usize;
    for path in &request.input_paths {
        let input = read_input_image(path, &allowed_roots).await?;
        total_input_bytes = total_input_bytes.saturating_add(input.bytes.len());
        if total_input_bytes > MAX_INPUT_TOTAL_BYTES {
            return Err("输入图片总大小不能超过 100 MiB".to_string());
        }
        inputs.push(input);
    }

    let mut content = Vec::with_capacity(inputs.len() + 1);
    content.push(json!({"type": "input_text", "text": request.prompt.trim()}));
    for input in inputs {
        let encoded = general_purpose::STANDARD.encode(input.bytes);
        content.push(json!({
            "type": "input_image",
            "image_url": format!("data:{};base64,{encoded}", input.mime_type),
        }));
    }

    let mut tool = Map::new();
    tool.insert("type".to_string(), json!("image_generation"));
    tool.insert(
        "size".to_string(),
        json!(request.size.as_deref().unwrap_or("auto")),
    );
    tool.insert(
        "quality".to_string(),
        json!(request.quality.as_deref().unwrap_or("medium")),
    );
    tool.insert(
        "output_format".to_string(),
        json!(request.output_format.as_api_str()),
    );
    if let Some(background) = &request.background {
        tool.insert("background".to_string(), json!(background));
    }
    let payload = json!({
        "model": request.model.as_deref().unwrap_or(&config.edit_model).trim(),
        "input": [{"role": "user", "content": content}],
        "tools": [Value::Object(tool)],
        "stream": false,
    });
    let endpoint = endpoint_url(&config.base_url, "responses")?;

    let mut result = Vec::new();
    for _ in 0..request.n.unwrap_or(1) {
        if cancelled.load(Ordering::Acquire) {
            return Err("图片任务已取消".to_string());
        }
        let response = client
            .post(endpoint.clone())
            .bearer_auth(&config.api_key)
            .json(&payload)
            .send()
            .await
            .map_err(|error| format!("Responses 图片编辑请求失败：{error}"))?;
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let body = read_success_body(response, &config.api_key).await?;
        let mut images = parse_responses_api_body(&body, &content_type)?;
        let Some(first) = images.drain(..).next() else {
            return Err("Responses API 响应中没有编辑后的图片".to_string());
        };
        result.push(first);
    }
    Ok(result)
}

async fn read_input_image(path: &str, allowed_roots: &[PathBuf]) -> Result<InputImage, String> {
    let path = PathBuf::from(path);
    let link_metadata = tokio::fs::symlink_metadata(&path)
        .await
        .map_err(|error| format!("读取输入图片路径失败：{error}"))?;
    if link_metadata.file_type().is_symlink() {
        return Err("输入图片不能是符号链接".to_string());
    }
    let canonical = tokio::fs::canonicalize(&path)
        .await
        .map_err(|error| format!("读取输入图片路径失败：{error}"))?;
    if !allowed_roots.iter().any(|root| canonical.starts_with(root)) {
        return Err("输入图片必须位于 workspaceRoot 或 LiveAgent 图片输出目录内".to_string());
    }
    let metadata = tokio::fs::metadata(&canonical)
        .await
        .map_err(|error| format!("读取输入图片元数据失败：{error}"))?;
    if !metadata.is_file() {
        return Err("输入图片不是普通文件".to_string());
    }
    if metadata.len() == 0 || metadata.len() > MAX_INPUT_IMAGE_BYTES {
        return Err(format!(
            "输入图片必须大于 0 且不超过 {} MiB",
            MAX_INPUT_IMAGE_BYTES / 1024 / 1024
        ));
    }
    let file = tokio::fs::File::open(&canonical)
        .await
        .map_err(|error| format!("打开输入图片失败：{error}"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_INPUT_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| format!("读取输入图片失败：{error}"))?;
    if bytes.len() > MAX_INPUT_IMAGE_BYTES as usize {
        return Err("输入图片在读取期间超过大小限制".to_string());
    }
    let validated = validate_image_bytes(bytes, None)?;
    let file_name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("input.png")
        .to_string();
    Ok(InputImage {
        bytes: validated.bytes,
        file_name,
        mime_type: validated.mime_type,
        width: validated.width,
        height: validated.height,
    })
}

async fn read_success_body(response: Response, api_key: &str) -> Result<Vec<u8>, String> {
    let status = response.status();
    if !status.is_success() {
        let body = read_response_limited(response, MAX_API_ERROR_BYTES)
            .await
            .unwrap_or_default();
        let message = extract_api_error_message(&body);
        return Err(safe_error(
            &format!("图片服务返回 HTTP {}：{message}", status.as_u16()),
            Some(api_key),
        ));
    }
    read_response_limited(response, MAX_API_RESPONSE_BYTES).await
}

async fn read_response_limited(response: Response, limit: usize) -> Result<Vec<u8>, String> {
    if let Some(length) = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
    {
        if length > limit as u64 {
            return Err(format!("图片服务响应超过 {limit} 字节限制"));
        }
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("读取图片服务响应失败：{error}"))?;
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(format!("图片服务响应超过 {limit} 字节限制"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn extract_api_error_message(body: &[u8]) -> String {
    if let Ok(value) = serde_json::from_slice::<Value>(body) {
        if let Some(message) = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .or_else(|| value.get("message").and_then(Value::as_str))
        {
            return truncate_chars(message.trim(), MAX_ERROR_CHARS);
        }
    }
    let text = String::from_utf8_lossy(body);
    if text.trim().is_empty() {
        "无错误详情".to_string()
    } else {
        truncate_chars(text.trim(), MAX_ERROR_CHARS)
    }
}

fn parse_images_api_body(body: &[u8]) -> Result<Vec<RemoteImage>, String> {
    let value: Value = serde_json::from_slice(body)
        .map_err(|error| format!("图片服务响应不是有效 JSON：{error}"))?;
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "图片服务响应缺少 data 数组".to_string())?;
    if data.len() > usize::from(MAX_IMAGES_PER_JOB) {
        return Err("图片服务响应包含过多图片".to_string());
    }
    let mut result = Vec::with_capacity(data.len());
    for item in data {
        if let Some(encoded) = item.get("b64_json").and_then(Value::as_str) {
            result.push(parse_base64_remote(encoded)?);
        } else if let Some(url) = item.get("url").and_then(Value::as_str) {
            result.push(RemoteImage::Url(url.to_string()));
        } else {
            return Err("图片服务 data 项缺少 b64_json 或 url".to_string());
        }
    }
    Ok(result)
}

fn parse_responses_api_body(body: &[u8], content_type: &str) -> Result<Vec<RemoteImage>, String> {
    let mut values = Vec::new();
    if content_type.contains("text/event-stream") {
        let text = std::str::from_utf8(body)
            .map_err(|error| format!("Responses SSE 不是 UTF-8：{error}"))?;
        for block in text.split("\n\n") {
            let data = block
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(str::trim)
                .collect::<Vec<_>>()
                .join("\n");
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(&data) {
                values.push(value);
            }
        }
    } else {
        values.push(
            serde_json::from_slice(body)
                .map_err(|error| format!("Responses API 响应不是有效 JSON：{error}"))?,
        );
    }

    let mut complete = Vec::new();
    let mut partial = Vec::new();
    let mut urls = Vec::new();
    for value in &values {
        collect_response_images(value, &mut complete, &mut partial, &mut urls, 0)?;
    }
    if complete.is_empty() {
        complete.extend(partial.into_iter().rev().take(1));
    }
    let mut result = Vec::new();
    for encoded in complete {
        result.push(parse_base64_remote(&encoded)?);
    }
    for url in urls {
        result.push(RemoteImage::Url(url));
    }
    if result.len() > usize::from(MAX_IMAGES_PER_JOB) {
        result.truncate(usize::from(MAX_IMAGES_PER_JOB));
    }
    Ok(result)
}

fn collect_response_images(
    value: &Value,
    complete: &mut Vec<String>,
    partial: &mut Vec<String>,
    urls: &mut Vec<String>,
    depth: usize,
) -> Result<(), String> {
    if depth > 32 {
        return Err("Responses API 响应嵌套过深".to_string());
    }
    match value {
        Value::Array(items) => {
            for item in items {
                collect_response_images(item, complete, partial, urls, depth + 1)?;
            }
        }
        Value::Object(map) => {
            for (key, child) in map {
                match (key.as_str(), child) {
                    ("url", Value::String(url))
                        if url.starts_with("http://") || url.starts_with("https://") =>
                    {
                        urls.push(url.clone());
                    }
                    ("partial_image_b64", Value::String(encoded)) => partial.push(encoded.clone()),
                    (
                        "b64_json" | "result" | "image" | "image_b64" | "data",
                        Value::String(encoded),
                    ) if looks_like_base64_image(encoded) => complete.push(encoded.clone()),
                    _ => collect_response_images(child, complete, partial, urls, depth + 1)?,
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn looks_like_base64_image(value: &str) -> bool {
    if value.starts_with("data:image/") {
        return true;
    }
    let mut count = 0usize;
    for byte in value.bytes() {
        if byte.is_ascii_whitespace() {
            continue;
        }
        if !(byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'_' | b'-' | b'=')) {
            return false;
        }
        count += 1;
    }
    count >= 128
}

fn parse_base64_remote(value: &str) -> Result<RemoteImage, String> {
    if let Some((header, encoded)) = value.split_once(',') {
        if header.to_ascii_lowercase().starts_with("data:image/") {
            if !header.to_ascii_lowercase().ends_with(";base64") {
                return Err("图片 data URL 必须使用 base64".to_string());
            }
            let mime = header
                .strip_prefix("data:")
                .and_then(|value| value.split(';').next())
                .unwrap_or_default()
                .to_ascii_lowercase();
            return Ok(RemoteImage::Base64 {
                encoded: encoded.to_string(),
                declared_mime: Some(mime),
            });
        }
    }
    Ok(RemoteImage::Base64 {
        encoded: value.to_string(),
        declared_mime: None,
    })
}

async fn materialize_remote_image(
    client: &Client,
    remote: RemoteImage,
) -> Result<ValidatedImage, String> {
    match remote {
        RemoteImage::Base64 {
            encoded,
            declared_mime,
        } => {
            let bytes = decode_base64_image(&encoded)?;
            validate_image_bytes(bytes, declared_mime.as_deref())
        }
        RemoteImage::Url(url) => download_image(client, &url).await,
    }
}

fn decode_base64_image(encoded: &str) -> Result<Vec<u8>, String> {
    let compact = encoded
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect::<Vec<_>>();
    let max_encoded = MAX_OUTPUT_IMAGE_BYTES.saturating_mul(4) / 3 + 16;
    if compact.is_empty() || compact.len() > max_encoded {
        return Err("base64 图片为空或超过大小限制".to_string());
    }
    let decoded = general_purpose::STANDARD
        .decode(&compact)
        .or_else(|_| general_purpose::STANDARD_NO_PAD.decode(&compact))
        .or_else(|_| general_purpose::URL_SAFE.decode(&compact))
        .or_else(|_| general_purpose::URL_SAFE_NO_PAD.decode(&compact))
        .map_err(|error| format!("图片 base64 无效：{error}"))?;
    if decoded.is_empty() || decoded.len() > MAX_OUTPUT_IMAGE_BYTES {
        return Err("解码后的图片为空或超过大小限制".to_string());
    }
    Ok(decoded)
}

async fn download_image(client: &Client, value: &str) -> Result<ValidatedImage, String> {
    let url = Url::parse(value).map_err(|error| format!("图片下载 URL 无效：{error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("图片下载 URL 仅支持 http 或 https".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("图片下载 URL 不能包含凭据".to_string());
    }
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("下载生成图片失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载生成图片失败：HTTP {}", status.as_u16()));
    }
    let declared_mime = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_ascii_lowercase());
    let bytes = read_response_limited(response, MAX_OUTPUT_IMAGE_BYTES).await?;
    validate_image_bytes(bytes, declared_mime.as_deref())
}

fn validate_image_bytes(
    bytes: Vec<u8>,
    declared_mime: Option<&str>,
) -> Result<ValidatedImage, String> {
    if bytes.is_empty() || bytes.len() > MAX_OUTPUT_IMAGE_BYTES {
        return Err("图片为空或超过大小限制".to_string());
    }
    let reader = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|error| format!("无法识别图片格式：{error}"))?;
    let format = reader
        .format()
        .ok_or_else(|| "无法识别图片格式".to_string())?;
    let (mime_type, _extension) = format_metadata(format)?;
    if let Some(declared) = declared_mime {
        let declared = normalize_mime(declared);
        if declared != "application/octet-stream" && declared != mime_type {
            return Err(format!(
                "图片 MIME 与实际内容不一致（声明 {declared}，实际 {mime_type}）"
            ));
        }
    }
    let (width, height) = reader
        .into_dimensions()
        .map_err(|error| format!("读取图片尺寸失败：{error}"))?;
    if width == 0
        || height == 0
        || u64::from(width).saturating_mul(u64::from(height)) > MAX_IMAGE_PIXELS
    {
        return Err("图片尺寸无效或像素数超过限制".to_string());
    }
    image::load_from_memory_with_format(&bytes, format)
        .map_err(|error| format!("图片内容校验失败：{error}"))?;
    Ok(ValidatedImage {
        bytes,
        format,
        mime_type,
        width,
        height,
    })
}

fn normalize_mime(value: &str) -> &'static str {
    match value.trim().to_ascii_lowercase().as_str() {
        "image/png" => "image/png",
        "image/jpeg" | "image/jpg" => "image/jpeg",
        "image/webp" => "image/webp",
        "application/octet-stream" => "application/octet-stream",
        _ => "unsupported",
    }
}

fn format_metadata(format: ImageFormat) -> Result<(&'static str, &'static str), String> {
    match format {
        ImageFormat::Png => Ok(("image/png", "png")),
        ImageFormat::Jpeg => Ok(("image/jpeg", "jpg")),
        ImageFormat::WebP => Ok(("image/webp", "webp")),
        _ => Err("仅支持 PNG、JPEG 和 WebP 图片".to_string()),
    }
}

fn write_validated_image(
    output_dir: &Path,
    job_id: &str,
    index: usize,
    image: ValidatedImage,
    _requested_format: NativeImageOutputFormat,
) -> Result<NativeImageOutput, String> {
    let (_, extension) = format_metadata(image.format)?;
    let file_name = format!("{job_id}-{}.{}", index + 1, extension);
    let final_path = output_dir.join(file_name);
    if final_path.parent() != Some(output_dir) || !final_path.starts_with(output_dir) {
        return Err("图片输出路径越界".to_string());
    }
    let mut temporary = NamedTempFile::new_in(output_dir)
        .map_err(|error| format!("创建图片临时文件失败：{error}"))?;
    temporary
        .write_all(&image.bytes)
        .map_err(|error| format!("写入图片临时文件失败：{error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("同步图片临时文件失败：{error}"))?;
    temporary
        .persist_noclobber(&final_path)
        .map_err(|error| format!("原子保存图片失败：{}", error.error))?;
    secure_output_file(&final_path)?;
    Ok(NativeImageOutput {
        path: final_path.to_string_lossy().into_owned(),
        mime_type: image.mime_type.to_string(),
        width: image.width,
        height: image.height,
        size_bytes: image.bytes.len() as u64,
    })
}

fn cleanup_outputs(outputs: &[NativeImageOutput]) {
    for output in outputs {
        let _ = std::fs::remove_file(&output.path);
    }
}

fn safe_error(message: &str, api_key: Option<&str>) -> String {
    let mut redacted = message.replace(['\r', '\n'], " ");
    if let Some(api_key) = api_key.filter(|value| !value.is_empty()) {
        redacted = redacted.replace(api_key, "<redacted>");
    }
    truncate_chars(redacted.trim(), MAX_ERROR_CHARS)
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let mut result = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        result.push('…');
    }
    result
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().try_into().unwrap_or(u64::MAX)
}

#[cfg(unix)]
fn secure_output_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("设置图片输出目录权限失败：{error}"))
}

#[cfg(not(unix))]
fn secure_output_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn secure_output_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("设置图片文件权限失败：{error}"))
}

#[cfg(not(unix))]
fn secure_output_file(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests;
