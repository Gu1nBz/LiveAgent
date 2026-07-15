use std::{collections::BTreeMap, path::Path, sync::atomic::Ordering, time::Duration};

use base64::{engine::general_purpose, Engine as _};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use reqwest::{header::CONTENT_TYPE, multipart::Form, Client, Method};
use serde_json::{Map, Number, Value};

use super::{
    adapter_endpoint_url, parse_base64_remote, read_input_image, read_response_limited, safe_error,
    InputImage, NativeImageAdapterBodyType, NativeImageAdapterExtract,
    NativeImageAdapterFileSource, NativeImageAdapterHttpRequest, NativeImageAdapterMode,
    NativeImageAdapterOperation, NativeImageAdapterSpec, NativeImageConfig, NativeImageEditRequest,
    NativeImageGenerateRequest, NativeImageOutputFormat, RemoteImage, MAX_API_ERROR_BYTES,
    MAX_API_RESPONSE_BYTES, MAX_ERROR_CHARS, MAX_INPUT_TOTAL_BYTES,
};

const MAX_ADAPTER_BYTES: usize = 64 * 1024;
const MAX_ADAPTER_OUTPUT_PATHS: usize = 8;
const MAX_ADAPTER_HEADERS: usize = 32;
const DEFAULT_POLL_INTERVAL_MS: u64 = 1_500;
const DEFAULT_MAX_POLL_ATTEMPTS: u32 = 1_200;

struct AdapterContext {
    values: BTreeMap<String, Value>,
    inputs: Vec<InputImage>,
    mask: Option<InputImage>,
}

enum AdapterResponse {
    Json(Value),
    Images(Vec<RemoteImage>),
}

pub(super) fn validate_adapter_spec(adapter: &NativeImageAdapterSpec) -> Result<(), String> {
    if adapter.version != 1 {
        return Err("AI 图片协议 version 当前只支持 1".to_string());
    }
    let name = adapter.name.trim();
    if name.is_empty() || name.len() > 80 || name.chars().any(char::is_control) {
        return Err("AI 图片协议 name 不能为空、不能超过 80 字节且不能包含控制字符".to_string());
    }
    let serialized =
        serde_json::to_vec(adapter).map_err(|error| format!("序列化 AI 图片协议失败：{error}"))?;
    if serialized.len() > MAX_ADAPTER_BYTES {
        return Err(format!("AI 图片协议不能超过 {MAX_ADAPTER_BYTES} 字节"));
    }
    validate_operation(&adapter.generate, "generate")?;
    if let Some(edit) = &adapter.edit {
        validate_operation(edit, "edit")?;
    }
    Ok(())
}

fn validate_operation(operation: &NativeImageAdapterOperation, field: &str) -> Result<(), String> {
    validate_http_request(&operation.submit, &format!("{field}.submit"))?;
    if operation.mode == NativeImageAdapterMode::Async {
        let poll = operation
            .poll
            .as_ref()
            .ok_or_else(|| format!("{field}.poll 是异步协议的必填项"))?;
        validate_http_request(poll, &format!("{field}.poll"))?;
        if operation.extract.task_id.is_none() || operation.extract.status.is_none() {
            return Err(format!(
                "{field}.extract.taskId 和 status 是异步协议的必填项"
            ));
        }
        if operation.extract.success_statuses.is_empty()
            || operation.extract.failure_statuses.is_empty()
        {
            return Err(format!(
                "{field}.extract 必须声明 successStatuses 和 failureStatuses"
            ));
        }
    }
    validate_extract(&operation.extract, field)
}

fn validate_http_request(
    request: &NativeImageAdapterHttpRequest,
    field: &str,
) -> Result<(), String> {
    let method = request.method.trim().to_ascii_uppercase();
    if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH") {
        return Err(format!("{field}.method 只允许 GET、POST、PUT 或 PATCH"));
    }
    let path = request.path.trim();
    if !path.starts_with('/')
        || path.len() > 2_048
        || path.contains("://")
        || path.contains('?')
        || path.contains('#')
        || path.split('/').any(|part| part == "..")
    {
        return Err(format!(
            "{field}.path 必须是同一 Base URL 下不含 query、fragment 或 .. 的绝对路径"
        ));
    }
    validate_template(path, &format!("{field}.path"))?;
    if request.headers.len() > MAX_ADAPTER_HEADERS || request.query.len() > MAX_ADAPTER_HEADERS {
        return Err(format!("{field} 的 headers/query 数量过多"));
    }
    for (name, value) in &request.headers {
        if name.trim().is_empty()
            || name.len() > 128
            || value.len() > 4_096
            || name.chars().any(char::is_control)
            || value.contains(['\r', '\n'])
            || matches!(
                name.trim().to_ascii_lowercase().as_str(),
                "host" | "content-length" | "connection" | "cookie"
            )
        {
            return Err(format!("{field}.headers 包含不允许的名称或值"));
        }
        validate_template(value, &format!("{field}.headers.{name}"))?;
    }
    for (name, value) in &request.query {
        if name.trim().is_empty() || name.len() > 128 || value.len() > 4_096 {
            return Err(format!("{field}.query 包含无效字段"));
        }
        validate_template(value, &format!("{field}.query.{name}"))?;
    }
    validate_value_templates(&request.body, &format!("{field}.body"))?;
    if request.body_type == NativeImageAdapterBodyType::Multipart && !request.body.is_object() {
        return Err(format!(
            "{field}.body 在 multipart 模式下必须是 JSON object"
        ));
    }
    if request.body_type != NativeImageAdapterBodyType::Multipart && !request.files.is_empty() {
        return Err(format!("{field}.files 只能用于 multipart 请求"));
    }
    for file in &request.files {
        if file.field.trim().is_empty()
            || file.field.len() > 128
            || file.field.chars().any(char::is_control)
        {
            return Err(format!("{field}.files.field 无效"));
        }
    }
    Ok(())
}

fn validate_extract(extract: &NativeImageAdapterExtract, field: &str) -> Result<(), String> {
    if extract.outputs.is_empty() || extract.outputs.len() > MAX_ADAPTER_OUTPUT_PATHS {
        return Err(format!(
            "{field}.extract.outputs 必须包含 1 到 {MAX_ADAPTER_OUTPUT_PATHS} 个 JSON 路径"
        ));
    }
    for (label, path) in extract
        .outputs
        .iter()
        .map(|path| ("outputs", path))
        .chain(extract.task_id.iter().map(|path| ("taskId", path)))
        .chain(extract.status.iter().map(|path| ("status", path)))
        .chain(extract.error.iter().map(|path| ("error", path)))
    {
        parse_json_path(path).map_err(|error| format!("{field}.extract.{label}: {error}"))?;
    }
    let interval = extract.poll_interval_ms.unwrap_or(DEFAULT_POLL_INTERVAL_MS);
    if !(250..=30_000).contains(&interval) {
        return Err(format!(
            "{field}.extract.pollIntervalMs 必须在 250 到 30000 之间"
        ));
    }
    let attempts = extract
        .max_poll_attempts
        .unwrap_or(DEFAULT_MAX_POLL_ATTEMPTS);
    if !(1..=2_400).contains(&attempts) {
        return Err(format!(
            "{field}.extract.maxPollAttempts 必须在 1 到 2400 之间"
        ));
    }
    Ok(())
}

fn validate_value_templates(value: &Value, field: &str) -> Result<(), String> {
    match value {
        Value::String(value) => validate_template(value, field),
        Value::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                validate_value_templates(value, &format!("{field}[{index}]"))?;
            }
            Ok(())
        }
        Value::Object(values) => {
            for (name, value) in values {
                validate_value_templates(value, &format!("{field}.{name}"))?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn validate_template(value: &str, field: &str) -> Result<(), String> {
    let mut rest = value;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let end = after
            .find("}}")
            .ok_or_else(|| format!("{field} 包含未闭合模板变量"))?;
        let name = after[..end].trim();
        if !is_allowed_variable(name) {
            return Err(format!("{field} 使用了不支持的模板变量：{name}"));
        }
        rest = &after[end + 2..];
    }
    if rest.contains("}}") {
        return Err(format!("{field} 包含多余的模板结束符"));
    }
    Ok(())
}

fn is_allowed_variable(name: &str) -> bool {
    matches!(
        name,
        "apiKey"
            | "model"
            | "prompt"
            | "size"
            | "width"
            | "height"
            | "quality"
            | "background"
            | "count"
            | "outputFormat"
            | "inputImages"
            | "inputImagesBase64"
            | "mask"
            | "maskBase64"
            | "taskId"
    )
}

pub(super) async fn call_adapter_generate(
    client: &Client,
    config: &NativeImageConfig,
    request: &NativeImageGenerateRequest,
    adapter: &NativeImageAdapterSpec,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<Vec<RemoteImage>, String> {
    let context = generate_context(config, request);
    execute_operation(client, config, &adapter.generate, &context, cancelled).await
}

pub(super) async fn call_adapter_edit(
    client: &Client,
    config: &NativeImageConfig,
    request: &NativeImageEditRequest,
    adapter: &NativeImageAdapterSpec,
    generated_images_root: &Path,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<Vec<RemoteImage>, String> {
    let operation = adapter
        .edit
        .as_ref()
        .ok_or_else(|| "当前 AI 图片协议没有配置图片编辑接口".to_string())?;
    let context = edit_context(config, request, generated_images_root).await?;
    execute_operation(client, config, operation, &context, cancelled).await
}

fn base_context(
    config: &NativeImageConfig,
    prompt: &str,
    model: &str,
    size: Option<&str>,
    quality: Option<&str>,
    background: Option<&str>,
    count: u8,
    output_format: NativeImageOutputFormat,
) -> BTreeMap<String, Value> {
    let mut values = BTreeMap::new();
    values.insert("apiKey".to_string(), Value::String(config.api_key.clone()));
    values.insert("model".to_string(), Value::String(model.to_string()));
    values.insert("prompt".to_string(), Value::String(prompt.to_string()));
    values.insert(
        "size".to_string(),
        Value::String(size.unwrap_or("auto").to_string()),
    );
    let (width, height) = size
        .and_then(|size| size.split_once('x'))
        .and_then(|(width, height)| Some((width.parse::<u64>().ok()?, height.parse::<u64>().ok()?)))
        .unwrap_or((1024, 1024));
    values.insert("width".to_string(), Value::Number(Number::from(width)));
    values.insert("height".to_string(), Value::Number(Number::from(height)));
    values.insert(
        "quality".to_string(),
        Value::String(quality.unwrap_or("medium").to_string()),
    );
    values.insert(
        "background".to_string(),
        Value::String(background.unwrap_or("auto").to_string()),
    );
    values.insert("count".to_string(), Value::Number(Number::from(count)));
    values.insert(
        "outputFormat".to_string(),
        Value::String(output_format.as_api_str().to_string()),
    );
    values.insert("inputImages".to_string(), Value::Array(Vec::new()));
    values.insert("inputImagesBase64".to_string(), Value::Array(Vec::new()));
    values.insert("mask".to_string(), Value::Null);
    values.insert("maskBase64".to_string(), Value::Null);
    values.insert("taskId".to_string(), Value::Null);
    values
}

fn generate_context(
    config: &NativeImageConfig,
    request: &NativeImageGenerateRequest,
) -> AdapterContext {
    AdapterContext {
        values: base_context(
            config,
            request.prompt.trim(),
            request.model.as_deref().unwrap_or(&config.generation_model),
            request.size.as_deref(),
            request.quality.as_deref(),
            request.background.as_deref(),
            request.n.unwrap_or(1),
            request.output_format,
        ),
        inputs: Vec::new(),
        mask: None,
    }
}

async fn edit_context(
    config: &NativeImageConfig,
    request: &NativeImageEditRequest,
    generated_images_root: &Path,
) -> Result<AdapterContext, String> {
    let mut allowed_roots = vec![generated_images_root.to_path_buf()];
    if let Some(workspace_root) = request.workspace_root.as_deref() {
        allowed_roots.push(super::canonical_directory(workspace_root, "workspaceRoot")?);
    }
    let mut inputs = Vec::with_capacity(request.input_paths.len());
    let mut total_bytes = 0usize;
    for path in &request.input_paths {
        let input = read_input_image(path, &allowed_roots).await?;
        total_bytes = total_bytes.saturating_add(input.bytes.len());
        if total_bytes > MAX_INPUT_TOTAL_BYTES {
            return Err("输入图片总大小不能超过 100 MiB".to_string());
        }
        inputs.push(input);
    }
    let mask = match request.mask_path.as_deref() {
        Some(path) => {
            let mask = read_input_image(path, &allowed_roots).await?;
            if total_bytes.saturating_add(mask.bytes.len()) > MAX_INPUT_TOTAL_BYTES {
                return Err("输入图片与 mask 总大小不能超过 100 MiB".to_string());
            }
            Some(mask)
        }
        None => None,
    };
    let mut values = base_context(
        config,
        request.prompt.trim(),
        request.model.as_deref().unwrap_or(&config.edit_model),
        request.size.as_deref(),
        request.quality.as_deref(),
        request.background.as_deref(),
        request.n.unwrap_or(1),
        request.output_format,
    );
    values.insert(
        "inputImages".to_string(),
        Value::Array(
            inputs
                .iter()
                .map(|input| {
                    Value::String(format!(
                        "data:{};base64,{}",
                        input.mime_type,
                        general_purpose::STANDARD.encode(&input.bytes)
                    ))
                })
                .collect(),
        ),
    );
    values.insert(
        "inputImagesBase64".to_string(),
        Value::Array(
            inputs
                .iter()
                .map(|input| Value::String(general_purpose::STANDARD.encode(&input.bytes)))
                .collect(),
        ),
    );
    if let Some(mask) = &mask {
        values.insert(
            "mask".to_string(),
            Value::String(format!(
                "data:{};base64,{}",
                mask.mime_type,
                general_purpose::STANDARD.encode(&mask.bytes)
            )),
        );
        values.insert(
            "maskBase64".to_string(),
            Value::String(general_purpose::STANDARD.encode(&mask.bytes)),
        );
    }
    Ok(AdapterContext {
        values,
        inputs,
        mask,
    })
}

async fn execute_operation(
    client: &Client,
    config: &NativeImageConfig,
    operation: &NativeImageAdapterOperation,
    context: &AdapterContext,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<Vec<RemoteImage>, String> {
    let submit = execute_request(client, config, &operation.submit, context).await?;
    if let AdapterResponse::Images(images) = submit {
        return Ok(images);
    }
    let AdapterResponse::Json(submit_json) = submit else {
        unreachable!();
    };
    if operation.mode == NativeImageAdapterMode::Sync {
        return extract_outputs(&submit_json, &operation.extract, &config.base_url);
    }
    if let Ok(outputs) = extract_outputs(&submit_json, &operation.extract, &config.base_url) {
        if !outputs.is_empty() && status_is_success(&submit_json, &operation.extract) {
            return Ok(outputs);
        }
    }
    let task_id_path = operation
        .extract
        .task_id
        .as_deref()
        .ok_or_else(|| "异步图片协议缺少 taskId 提取路径".to_string())?;
    let task_id = extract_first_text(&submit_json, task_id_path).ok_or_else(|| {
        format!(
            "提交响应中没有找到任务 ID：{task_id_path}；可用字段：{}",
            json_shape_summary(&submit_json)
        )
    })?;
    let poll = operation
        .poll
        .as_ref()
        .ok_or_else(|| "异步图片协议缺少 poll 请求".to_string())?;
    let interval = operation
        .extract
        .poll_interval_ms
        .unwrap_or(DEFAULT_POLL_INTERVAL_MS);
    let attempts = operation
        .extract
        .max_poll_attempts
        .unwrap_or(DEFAULT_MAX_POLL_ATTEMPTS);
    let mut poll_values = context.values.clone();
    poll_values.insert("taskId".to_string(), Value::String(task_id));
    let poll_context = AdapterContext {
        values: poll_values,
        inputs: Vec::new(),
        mask: None,
    };
    for attempt in 0..attempts {
        if cancelled.load(Ordering::Acquire) {
            return Err("图片任务已取消".to_string());
        }
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(interval)).await;
        }
        let response = execute_request(client, config, poll, &poll_context).await?;
        if let AdapterResponse::Images(images) = response {
            return Ok(images);
        }
        let AdapterResponse::Json(value) = response else {
            unreachable!();
        };
        let status_path = operation.extract.status.as_deref().unwrap_or("$.status");
        if extract_status(&value, &operation.extract).is_none() {
            return Err(format!(
                "轮询响应中没有找到状态字段：{status_path}；可用字段：{}",
                json_shape_summary(&value)
            ));
        }
        if status_is_failure(&value, &operation.extract) {
            let detail = operation
                .extract
                .error
                .as_deref()
                .and_then(|path| extract_first_text(&value, path))
                .unwrap_or_else(|| "远端异步图片任务失败".to_string());
            return Err(detail);
        }
        if status_is_success(&value, &operation.extract) {
            return extract_outputs(&value, &operation.extract, &config.base_url);
        }
    }
    Err("远端异步图片任务轮询超时".to_string())
}

async fn execute_request(
    client: &Client,
    config: &NativeImageConfig,
    request: &NativeImageAdapterHttpRequest,
    context: &AdapterContext,
) -> Result<AdapterResponse, String> {
    let rendered_path = render_string(&request.path, &context.values, true)?;
    let mut url = adapter_endpoint_url(&config.base_url, rendered_path.trim_start_matches('/'))?;
    {
        let mut pairs = url.query_pairs_mut();
        for (name, value) in &request.query {
            pairs.append_pair(name, &render_string(value, &context.values, false)?);
        }
    }
    let method = Method::from_bytes(request.method.trim().to_ascii_uppercase().as_bytes())
        .map_err(|error| format!("AI 图片协议 HTTP method 无效：{error}"))?;
    let mut builder = client.request(method, url);
    for (name, value) in &request.headers {
        builder = builder.header(name, render_string(value, &context.values, false)?);
    }
    builder = match request.body_type {
        NativeImageAdapterBodyType::Json => {
            builder.json(&render_value(&request.body, &context.values)?)
        }
        NativeImageAdapterBodyType::Multipart => {
            let mut form = Form::new();
            let fields = render_value(&request.body, &context.values)?;
            let fields = fields
                .as_object()
                .ok_or_else(|| "multipart body 必须是 object".to_string())?;
            for (name, value) in fields {
                form = form.text(name.clone(), scalar_text(value)?);
            }
            for file in &request.files {
                match file.source {
                    NativeImageAdapterFileSource::InputImages => {
                        for input in &context.inputs {
                            form = form.part(
                                file.field.clone(),
                                reqwest::multipart::Part::bytes(input.bytes.clone())
                                    .file_name(input.file_name.clone())
                                    .mime_str(input.mime_type)
                                    .map_err(|error| {
                                        format!("构建 AI 图片协议 multipart 失败：{error}")
                                    })?,
                            );
                        }
                    }
                    NativeImageAdapterFileSource::Mask => {
                        if let Some(mask) = &context.mask {
                            form = form.part(
                                file.field.clone(),
                                reqwest::multipart::Part::bytes(mask.bytes.clone())
                                    .file_name(mask.file_name.clone())
                                    .mime_str(mask.mime_type)
                                    .map_err(|error| {
                                        format!("构建 AI 图片协议 mask 失败：{error}")
                                    })?,
                            );
                        }
                    }
                }
            }
            builder.multipart(form)
        }
    };
    let response = builder
        .send()
        .await
        .map_err(|error| format!("AI 图片协议请求失败：{error}"))?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let limit = if status.is_success() {
        MAX_API_RESPONSE_BYTES
    } else {
        MAX_API_ERROR_BYTES
    };
    let body = read_response_limited(response, limit).await?;
    if !status.is_success() {
        let message = super::extract_api_error_message(&body);
        return Err(safe_error(
            &format!("AI 图片协议返回 HTTP {}：{message}", status.as_u16()),
            Some(&config.api_key),
        ));
    }
    if content_type.starts_with("image/") {
        return Ok(AdapterResponse::Images(vec![RemoteImage::Base64 {
            encoded: general_purpose::STANDARD.encode(body),
            declared_mime: Some(
                content_type
                    .split(';')
                    .next()
                    .unwrap_or("application/octet-stream")
                    .to_string(),
            ),
        }]));
    }
    let value: Value = serde_json::from_slice(&body).map_err(|error| {
        let preview = String::from_utf8_lossy(&body);
        format!(
            "AI 图片协议响应不是 JSON 或图片：{}；响应预览：{}",
            error,
            super::truncate_chars(preview.trim(), MAX_ERROR_CHARS.min(512))
        )
    })?;
    Ok(AdapterResponse::Json(value))
}

fn render_value(value: &Value, context: &BTreeMap<String, Value>) -> Result<Value, String> {
    match value {
        Value::String(value) => {
            let trimmed = value.trim();
            if trimmed.starts_with("{{") && trimmed.ends_with("}}") && trimmed.len() >= 4 {
                let name = trimmed[2..trimmed.len() - 2].trim();
                if trimmed == format!("{{{{{name}}}}}") {
                    return context
                        .get(name)
                        .cloned()
                        .ok_or_else(|| format!("缺少模板变量：{name}"));
                }
            }
            Ok(Value::String(render_string(value, context, false)?))
        }
        Value::Array(values) => values
            .iter()
            .map(|value| render_value(value, context))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Value::Object(values) => values
            .iter()
            .map(|(name, value)| Ok((name.clone(), render_value(value, context)?)))
            .collect::<Result<Map<_, _>, String>>()
            .map(Value::Object),
        _ => Ok(value.clone()),
    }
}

fn render_string(
    template: &str,
    context: &BTreeMap<String, Value>,
    encode_path_values: bool,
) -> Result<String, String> {
    let mut output = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        output.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after
            .find("}}")
            .ok_or_else(|| "模板变量未闭合".to_string())?;
        let name = after[..end].trim();
        let value = context
            .get(name)
            .ok_or_else(|| format!("缺少模板变量：{name}"))?;
        let value = scalar_text(value)?;
        if encode_path_values {
            output.push_str(&utf8_percent_encode(&value, NON_ALPHANUMERIC).to_string());
        } else {
            output.push_str(&value);
        }
        rest = &after[end + 2..];
    }
    output.push_str(rest);
    Ok(output)
}

fn scalar_text(value: &Value) -> Result<String, String> {
    match value {
        Value::Null => Ok(String::new()),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Number(value) => Ok(value.to_string()),
        Value::String(value) => Ok(value.clone()),
        _ => serde_json::to_string(value).map_err(|error| format!("模板值序列化失败：{error}")),
    }
}

fn status_is_success(value: &Value, extract: &NativeImageAdapterExtract) -> bool {
    extract_status(value, extract).is_some_and(|status| {
        extract
            .success_statuses
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(&status))
    })
}

fn status_is_failure(value: &Value, extract: &NativeImageAdapterExtract) -> bool {
    extract_status(value, extract).is_some_and(|status| {
        extract
            .failure_statuses
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(&status))
    })
}

fn extract_status(value: &Value, extract: &NativeImageAdapterExtract) -> Option<String> {
    extract
        .status
        .as_deref()
        .and_then(|path| extract_first_text(value, path))
}

fn extract_first_text(value: &Value, path: &str) -> Option<String> {
    select_json_values(value, path)
        .ok()?
        .into_iter()
        .find_map(|value| match value {
            Value::String(value) => Some(value.clone()),
            Value::Number(value) => Some(value.to_string()),
            Value::Bool(value) => Some(value.to_string()),
            _ => None,
        })
}

fn extract_outputs(
    value: &Value,
    extract: &NativeImageAdapterExtract,
    base_url: &str,
) -> Result<Vec<RemoteImage>, String> {
    let mut outputs = Vec::new();
    for path in &extract.outputs {
        for value in select_json_values(value, path)? {
            collect_output_value(value, base_url, &mut outputs)?;
        }
    }
    if outputs.is_empty() {
        return Err(format!(
            "响应中没有找到图片输出；已检查路径：{}；可用字段：{}",
            extract.outputs.join(", "),
            json_shape_summary(value)
        ));
    }
    if outputs.len() > 4 {
        outputs.truncate(4);
    }
    Ok(outputs)
}

fn json_shape_summary(value: &Value) -> String {
    fn visit(value: &Value, path: &str, depth: usize, output: &mut Vec<String>) {
        if depth > 4 || output.len() >= 64 {
            return;
        }
        match value {
            Value::Object(values) => {
                for (name, child) in values {
                    let next = format!("{path}.{name}");
                    output.push(next.clone());
                    visit(child, &next, depth + 1, output);
                    if output.len() >= 64 {
                        break;
                    }
                }
            }
            Value::Array(values) => {
                let next = format!("{path}[*]");
                output.push(next.clone());
                if let Some(first) = values.first() {
                    visit(first, &next, depth + 1, output);
                }
            }
            _ => {}
        }
    }
    let mut paths = Vec::new();
    visit(value, "$", 0, &mut paths);
    if paths.is_empty() {
        "(none)".to_string()
    } else {
        paths.join(", ")
    }
}

fn collect_output_value(
    value: &Value,
    base_url: &str,
    outputs: &mut Vec<RemoteImage>,
) -> Result<(), String> {
    match value {
        Value::String(value) => outputs.push(output_from_string(value, base_url)?),
        Value::Array(values) => {
            for value in values {
                collect_output_value(value, base_url, outputs)?;
            }
        }
        Value::Object(values) => {
            for key in [
                "url",
                "image_url",
                "output",
                "b64_json",
                "base64",
                "image",
                "image_b64",
                "result",
                "data",
            ] {
                if let Some(value) = values.get(key) {
                    collect_output_value(value, base_url, outputs)?;
                    if !outputs.is_empty() {
                        break;
                    }
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn output_from_string(value: &str, base_url: &str) -> Result<RemoteImage, String> {
    let value = value.trim();
    if value.starts_with("http://") || value.starts_with("https://") {
        Ok(RemoteImage::Url(value.to_string()))
    } else if value.starts_with('/') {
        let base = super::normalize_base_url(base_url)?;
        let base = reqwest::Url::parse(&format!("{base}/"))
            .map_err(|error| format!("解析图片输出 Base URL 失败：{error}"))?;
        let url = base
            .join(value.trim_start_matches('/'))
            .map_err(|error| format!("解析相对图片输出 URL 失败：{error}"))?;
        Ok(RemoteImage::Url(url.to_string()))
    } else {
        parse_base64_remote(value)
    }
}

#[derive(Debug)]
enum JsonPathToken {
    Key(String),
    Index(usize),
    Wildcard,
}

fn parse_json_path(path: &str) -> Result<Vec<JsonPathToken>, String> {
    let bytes = path.as_bytes();
    if bytes.first() != Some(&b'$') {
        return Err("JSON 路径必须以 $ 开头".to_string());
    }
    let mut tokens = Vec::new();
    let mut index = 1usize;
    while index < bytes.len() {
        match bytes[index] {
            b'.' => {
                index += 1;
                let start = index;
                while index < bytes.len() && !matches!(bytes[index], b'.' | b'[') {
                    index += 1;
                }
                if start == index {
                    return Err("JSON 路径包含空字段".to_string());
                }
                tokens.push(JsonPathToken::Key(path[start..index].to_string()));
            }
            b'[' => {
                let close = path[index + 1..]
                    .find(']')
                    .map(|offset| index + 1 + offset)
                    .ok_or_else(|| "JSON 路径数组选择器未闭合".to_string())?;
                let selector = &path[index + 1..close];
                if selector == "*" {
                    tokens.push(JsonPathToken::Wildcard);
                } else {
                    tokens.push(JsonPathToken::Index(
                        selector
                            .parse::<usize>()
                            .map_err(|_| "JSON 路径数组下标无效".to_string())?,
                    ));
                }
                index = close + 1;
            }
            _ => return Err("JSON 路径只支持 .field、[index] 和 [*]".to_string()),
        }
    }
    Ok(tokens)
}

fn select_json_values<'a>(root: &'a Value, path: &str) -> Result<Vec<&'a Value>, String> {
    let tokens = parse_json_path(path)?;
    let mut current = vec![root];
    for token in tokens {
        let mut next = Vec::new();
        for value in current {
            match &token {
                JsonPathToken::Key(key) => {
                    if let Some(value) = value.get(key) {
                        next.push(value);
                    }
                }
                JsonPathToken::Index(index) => {
                    if let Some(value) = value.as_array().and_then(|values| values.get(*index)) {
                        next.push(value);
                    }
                }
                JsonPathToken::Wildcard => {
                    if let Some(values) = value.as_array() {
                        next.extend(values);
                    }
                }
            }
        }
        current = next;
    }
    Ok(current)
}
