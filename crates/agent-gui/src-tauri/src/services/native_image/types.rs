use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
pub const DEFAULT_IMAGE_MODEL: &str = "gpt-image-2";
pub const DEFAULT_TIMEOUT_SECONDS: u64 = 180;

#[derive(Clone)]
pub(crate) struct NativeImageConfig {
    pub base_url: String,
    pub api_key: String,
    pub generation_model: String,
    pub edit_model: String,
    pub endpoint_mode: NativeImageEndpointMode,
    pub timeout_seconds: u64,
    pub adapter: Option<NativeImageAdapterSpec>,
}

impl Default for NativeImageConfig {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.to_string(),
            api_key: String::new(),
            generation_model: DEFAULT_IMAGE_MODEL.to_string(),
            edit_model: DEFAULT_IMAGE_MODEL.to_string(),
            endpoint_mode: NativeImageEndpointMode::Images,
            timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
            adapter: None,
        }
    }
}

impl NativeImageConfig {
    pub(crate) fn public(&self) -> NativeImageConfigPublic {
        NativeImageConfigPublic {
            base_url: self.base_url.clone(),
            generation_model: self.generation_model.clone(),
            edit_model: self.edit_model.clone(),
            endpoint_mode: self.endpoint_mode,
            timeout_seconds: self.timeout_seconds,
            api_key_configured: !self.api_key.trim().is_empty(),
            adapter_configured: self.adapter.is_some(),
            adapter_name: self.adapter.as_ref().map(|adapter| adapter.name.clone()),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NativeImageEndpointMode {
    #[default]
    Images,
    Responses,
}

impl NativeImageEndpointMode {
    pub(crate) fn as_db_str(self) -> &'static str {
        match self {
            Self::Images => "images",
            Self::Responses => "responses",
        }
    }

    pub(crate) fn from_db_str(value: &str) -> Self {
        match value {
            "responses" => Self::Responses,
            _ => Self::Images,
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeImageConfigUpdate {
    pub base_url: String,
    #[serde(default)]
    pub generation_model: Option<String>,
    #[serde(default)]
    pub edit_model: Option<String>,
    #[serde(default)]
    pub endpoint_mode: Option<NativeImageEndpointMode>,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
    #[serde(default)]
    pub api_key_update: Option<String>,
    #[serde(default)]
    pub clear_api_key: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeImageConfigPublic {
    pub base_url: String,
    pub generation_model: String,
    pub edit_model: String,
    pub endpoint_mode: NativeImageEndpointMode,
    pub timeout_seconds: u64,
    pub api_key_configured: bool,
    pub adapter_configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter_name: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NativeImageAdapterMode {
    #[default]
    Sync,
    Async,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NativeImageAdapterBodyType {
    #[default]
    Json,
    Multipart,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NativeImageAdapterFileSource {
    InputImages,
    Mask,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeImageAdapterFilePart {
    pub field: String,
    pub source: NativeImageAdapterFileSource,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeImageAdapterHttpRequest {
    #[serde(default = "default_adapter_method")]
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub body_type: NativeImageAdapterBodyType,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub query: BTreeMap<String, String>,
    #[serde(default = "default_adapter_body")]
    pub body: Value,
    #[serde(default)]
    pub files: Vec<NativeImageAdapterFilePart>,
}

fn default_adapter_method() -> String {
    "POST".to_string()
}

fn default_adapter_body() -> Value {
    Value::Object(Default::default())
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeImageAdapterExtract {
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    pub outputs: Vec<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub success_statuses: Vec<String>,
    #[serde(default)]
    pub failure_statuses: Vec<String>,
    #[serde(default)]
    pub poll_interval_ms: Option<u64>,
    #[serde(default)]
    pub max_poll_attempts: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeImageAdapterOperation {
    #[serde(default)]
    pub mode: NativeImageAdapterMode,
    pub submit: NativeImageAdapterHttpRequest,
    #[serde(default)]
    pub poll: Option<NativeImageAdapterHttpRequest>,
    pub extract: NativeImageAdapterExtract,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeImageAdapterSpec {
    pub version: u8,
    pub name: String,
    pub generate: NativeImageAdapterOperation,
    #[serde(default)]
    pub edit: Option<NativeImageAdapterOperation>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeImageAdapterPublic {
    pub configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter: Option<NativeImageAdapterSpec>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NativeImageOutputFormat {
    #[default]
    Png,
    Jpeg,
    Webp,
}

impl NativeImageOutputFormat {
    pub(crate) fn as_api_str(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpeg",
            Self::Webp => "webp",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeImageGenerateRequest {
    pub prompt: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub size: Option<String>,
    #[serde(default)]
    pub quality: Option<String>,
    #[serde(default)]
    pub background: Option<String>,
    #[serde(default)]
    pub output_format: NativeImageOutputFormat,
    #[serde(default)]
    pub n: Option<u8>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeImageEditRequest {
    pub prompt: String,
    pub input_paths: Vec<String>,
    #[serde(default)]
    pub workspace_root: Option<String>,
    #[serde(default)]
    pub mask_path: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub size: Option<String>,
    #[serde(default)]
    pub quality: Option<String>,
    #[serde(default)]
    pub background: Option<String>,
    #[serde(default)]
    pub output_format: NativeImageOutputFormat,
    #[serde(default)]
    pub n: Option<u8>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NativeImageJobKind {
    Generate,
    Edit,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NativeImageJobStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl NativeImageJobStatus {
    pub(crate) fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeImageOutput {
    pub path: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeImageJobSnapshot {
    pub id: String,
    pub kind: NativeImageJobKind,
    pub status: NativeImageJobStatus,
    pub created_at: i64,
    pub updated_at: i64,
    pub outputs: Vec<NativeImageOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeImageDoctorResponse {
    pub ok: bool,
    pub base_url: String,
    pub endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,
    pub latency_ms: u64,
    pub api_key_configured: bool,
    pub message: String,
}
