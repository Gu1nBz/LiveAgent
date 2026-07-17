use std::{
    collections::BTreeMap,
    io::Cursor,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

use axum::{
    routing::{get, post},
    Json, Router,
};
use base64::Engine as _;
use image::{DynamicImage, ImageFormat};
use serde_json::{json, Value};
use tempfile::tempdir;

use super::types::{DEFAULT_BASE_URL, DEFAULT_IMAGE_MODEL, DEFAULT_TIMEOUT_SECONDS};
use super::*;

fn config_update(base_url: String, api_key: Option<&str>) -> NativeImageConfigUpdate {
    NativeImageConfigUpdate {
        base_url,
        generation_model: Some("test-image-model".to_string()),
        edit_model: Some("test-edit-model".to_string()),
        endpoint_mode: Some(NativeImageEndpointMode::Images),
        timeout_seconds: Some(30),
        api_key_update: api_key.map(str::to_string),
        clear_api_key: false,
    }
}

fn generate_request() -> NativeImageGenerateRequest {
    NativeImageGenerateRequest {
        prompt: "draw a tiny blue square".to_string(),
        model: None,
        size: Some("1024x1024".to_string()),
        quality: Some("medium".to_string()),
        background: Some("transparent".to_string()),
        output_format: NativeImageOutputFormat::Png,
        n: Some(1),
    }
}

fn png_bytes() -> Vec<u8> {
    let image = DynamicImage::new_rgba8(2, 3);
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, ImageFormat::Png).unwrap();
    bytes.into_inner()
}

fn adapter_request(path: &str, body: Value) -> NativeImageAdapterHttpRequest {
    NativeImageAdapterHttpRequest {
        method: "POST".to_string(),
        path: path.to_string(),
        body_type: NativeImageAdapterBodyType::Json,
        headers: BTreeMap::from([("Authorization".to_string(), "Bearer {{apiKey}}".to_string())]),
        query: BTreeMap::new(),
        body,
        files: Vec::new(),
    }
}

fn sync_adapter(path: &str) -> NativeImageAdapterSpec {
    NativeImageAdapterSpec {
        version: 1,
        name: "AI configured sync relay".to_string(),
        generate: NativeImageAdapterOperation {
            mode: NativeImageAdapterMode::Sync,
            submit: adapter_request(
                path,
                json!({
                    "model_name": "{{model}}",
                    "text": "{{prompt}}",
                    "width": "{{width}}",
                    "height": "{{height}}",
                    "count": "{{count}}"
                }),
            ),
            poll: None,
            extract: NativeImageAdapterExtract {
                task_id: None,
                status: None,
                outputs: vec!["$.result.images[*]".to_string()],
                error: Some("$.error.message".to_string()),
                success_statuses: Vec::new(),
                failure_statuses: Vec::new(),
                poll_interval_ms: None,
                max_poll_attempts: None,
            },
        },
        edit: None,
    }
}

async fn wait_for_terminal(service: &NativeImageService, job_id: &str) -> NativeImageJobSnapshot {
    for _ in 0..200 {
        let snapshot = service.job_status(job_id).unwrap();
        if snapshot.status.is_terminal() {
            return snapshot;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("job did not become terminal");
}

#[test]
fn normalizes_openai_compatible_base_urls() {
    assert_eq!(
        normalize_base_url("https://api.openai.com").unwrap(),
        "https://api.openai.com"
    );
    assert_eq!(
        normalize_base_url("https://relay.example/openai/v1/").unwrap(),
        "https://relay.example/openai/v1"
    );
    assert_eq!(
        endpoint_url("https://api.openai.com", "images/generations")
            .unwrap()
            .as_str(),
        "https://api.openai.com/v1/images/generations"
    );
    assert_eq!(
        adapter_endpoint_url("https://relay.example", "api/generate")
            .unwrap()
            .as_str(),
        "https://relay.example/api/generate"
    );
    assert!(normalize_base_url("file:///tmp/api").is_err());
    assert!(normalize_base_url("https://user:secret@example.com/v1").is_err());
    assert!(normalize_base_url("https://example.com/v1?key=secret").is_err());
}

#[test]
fn config_never_exposes_api_key_and_supports_retain_and_clear() {
    let root = tempdir().unwrap();
    let service = NativeImageService::test_service(root.path()).unwrap();
    assert!(!service.config_get().unwrap().api_key_configured);

    let public = service
        .config_save(config_update(
            "https://relay.example".to_string(),
            Some("top-secret"),
        ))
        .unwrap();
    assert!(public.api_key_configured);
    let serialized = serde_json::to_string(&public).unwrap();
    assert!(!serialized.contains("top-secret"));

    let mut retain = config_update("https://relay.example/v1".to_string(), None);
    retain.generation_model = None;
    retain.edit_model = None;
    assert!(service.config_save(retain).unwrap().api_key_configured);

    let mut clear = config_update("https://relay.example/v1".to_string(), None);
    clear.clear_api_key = true;
    assert!(!service.config_save(clear).unwrap().api_key_configured);
    assert!(!service.config_get().unwrap().api_key_configured);
}

#[test]
fn clearing_configuration_restores_defaults_and_removes_adapter_and_key() {
    let root = tempdir().unwrap();
    let service = NativeImageService::test_service(root.path()).unwrap();
    service
        .config_save(config_update(
            "https://relay.example/custom/v1".to_string(),
            Some("configuration-secret"),
        ))
        .unwrap();
    let mut adapter = sync_adapter("/custom-generate");
    adapter.generate.extract = NativeImageAdapterExtract::default();
    service.adapter_save(adapter).unwrap();

    let cleared = service.config_clear().unwrap();
    assert_eq!(cleared.base_url, DEFAULT_BASE_URL);
    assert_eq!(cleared.generation_model, DEFAULT_IMAGE_MODEL);
    assert_eq!(cleared.edit_model, DEFAULT_IMAGE_MODEL);
    assert_eq!(cleared.endpoint_mode, NativeImageEndpointMode::Images);
    assert_eq!(cleared.timeout_seconds, DEFAULT_TIMEOUT_SECONDS);
    assert!(!cleared.api_key_configured);
    assert!(!cleared.adapter_configured);
    assert!(cleared.adapter_name.is_none());
    assert!(!serde_json::to_string(&cleared)
        .unwrap()
        .contains("configuration-secret"));

    let persisted = service.config_get().unwrap();
    assert_eq!(persisted.base_url, DEFAULT_BASE_URL);
    assert!(!persisted.api_key_configured);
    assert!(!persisted.adapter_configured);
}

#[test]
fn ai_adapter_is_validated_persisted_and_never_contains_the_real_key() {
    let root = tempdir().unwrap();
    let service = NativeImageService::test_service(root.path()).unwrap();
    service
        .config_save(config_update(
            "https://relay.example".to_string(),
            Some("adapter-secret-key"),
        ))
        .unwrap();
    let saved = service
        .adapter_save(sync_adapter("/custom-generate"))
        .unwrap();
    assert!(saved.configured);
    assert_eq!(saved.adapter.as_ref().unwrap().version, 1);
    let serialized = serde_json::to_string(&saved).unwrap();
    assert!(!serialized.contains("adapter-secret-key"));
    assert!(serialized.contains("{{apiKey}}"));
    let public = service.config_get().unwrap();
    assert!(public.adapter_configured);
    assert_eq!(
        public.adapter_name.as_deref(),
        Some("AI configured sync relay")
    );
    assert!(!service.adapter_clear().unwrap().configured);

    let mut unsafe_adapter = sync_adapter("https://evil.example/generate");
    unsafe_adapter.name = "unsafe".to_string();
    assert!(service.adapter_save(unsafe_adapter).is_err());
}

#[test]
fn image_job_can_start_from_a_thread_without_an_entered_tokio_runtime() {
    let root = tempdir().unwrap();
    let service = Arc::new(NativeImageService::test_service(root.path()).unwrap());
    service
        .config_save(config_update(
            "http://127.0.0.1:9".to_string(),
            Some("thread-start-key"),
        ))
        .unwrap();

    let thread_service = Arc::clone(&service);
    let snapshot = std::thread::spawn(move || {
        assert!(tokio::runtime::Handle::try_current().is_err());
        thread_service.start_generate(generate_request())
    })
    .join()
    .expect("starting a native image job must not panic")
    .expect("starting a native image job must return a snapshot");

    assert!(matches!(
        snapshot.status,
        NativeImageJobStatus::Queued | NativeImageJobStatus::Running
    ));
    let _ = service.cancel_job(&snapshot.id);
}

#[test]
fn validates_image_magic_mime_dimensions_and_full_decode() {
    let image = validate_image_bytes(png_bytes(), Some("image/png")).unwrap();
    assert_eq!(image.mime_type, "image/png");
    assert_eq!((image.width, image.height), (2, 3));
    assert!(validate_image_bytes(png_bytes(), Some("image/jpeg")).is_err());
    assert!(validate_image_bytes(b"not-an-image".to_vec(), None).is_err());
}

#[test]
fn parses_images_and_responses_payloads_without_accepting_missing_data() {
    let encoded = general_purpose::STANDARD.encode(png_bytes());
    let body = serde_json::to_vec(&json!({"data": [{"b64_json": encoded}]})).unwrap();
    assert_eq!(parse_images_api_body(&body).unwrap().len(), 1);
    assert!(parse_images_api_body(br#"{"created":1}"#).is_err());

    let response = serde_json::to_vec(&json!({
        "output": [{"type": "image_generation_call", "result": encoded}]
    }))
    .unwrap();
    assert_eq!(
        parse_responses_api_body(&response, "application/json")
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn errors_are_redacted_flattened_and_truncated() {
    let secret = "sk-super-secret";
    let error = format!(
        "upstream said {secret}\r\n{}",
        "x".repeat(MAX_ERROR_CHARS * 2)
    );
    let safe = safe_error(&error, Some(secret));
    assert!(!safe.contains(secret));
    assert!(!safe.contains('\r'));
    assert!(!safe.contains('\n'));
    assert!(safe.chars().count() <= MAX_ERROR_CHARS + 1);
}

#[tokio::test]
async fn input_images_are_confined_to_generated_or_workspace_roots() {
    let root = tempdir().unwrap();
    let generated = root.path().join("generated");
    let workspace = root.path().join("workspace");
    let outside = root.path().join("outside");
    std::fs::create_dir_all(&generated).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    let inside_path = workspace.join("inside.png");
    let outside_path = outside.join("outside.png");
    std::fs::write(&inside_path, png_bytes()).unwrap();
    std::fs::write(&outside_path, png_bytes()).unwrap();
    let allowed = vec![
        std::fs::canonicalize(&generated).unwrap(),
        std::fs::canonicalize(&workspace).unwrap(),
    ];
    assert!(read_input_image(inside_path.to_str().unwrap(), &allowed)
        .await
        .is_ok());
    assert!(read_input_image(outside_path.to_str().unwrap(), &allowed)
        .await
        .is_err());

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let link = workspace.join("linked.png");
        symlink(&inside_path, &link).unwrap();
        assert!(read_input_image(link.to_str().unwrap(), &allowed)
            .await
            .is_err());
    }
}

#[tokio::test]
async fn generation_job_writes_validated_output_and_exports_inside_workspace() {
    let encoded = general_purpose::STANDARD.encode(png_bytes());
    let app = Router::new().route(
        "/v1/images/generations",
        post(move || {
            let encoded = encoded.clone();
            async move { Json(json!({"data": [{"b64_json": encoded}]})) }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let root = tempdir().unwrap();
    let service = Arc::new(NativeImageService::test_service(root.path()).unwrap());
    service
        .config_save(config_update(format!("http://{address}"), Some("test-key")))
        .unwrap();
    let started = service.start_generate(generate_request()).unwrap();
    let snapshot = wait_for_terminal(&service, &started.id).await;
    assert_eq!(snapshot.status, NativeImageJobStatus::Succeeded);
    assert_eq!(snapshot.outputs.len(), 1);
    assert!(Path::new(&snapshot.outputs[0].path).starts_with(&service.output_dir));

    let workspace = root.path().join("workspace");
    let run = workspace.join("pet-run");
    std::fs::create_dir_all(&run).unwrap();
    let exported = service
        .export_job(&started.id, workspace.to_str().unwrap(), Some("pet-run"))
        .unwrap();
    assert_eq!(exported.len(), 1);
    assert!(Path::new(&exported[0].path).starts_with(std::fs::canonicalize(&run).unwrap()));
    assert!(service
        .export_job(&started.id, workspace.to_str().unwrap(), Some("pet-run"),)
        .is_err());
    let outside = root.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    assert!(service
        .export_job(
            &started.id,
            workspace.to_str().unwrap(),
            Some(outside.to_str().unwrap()),
        )
        .is_err());
    server.abort();
}

#[tokio::test]
async fn ai_adapter_automatically_scans_sse_response_events_for_images() {
    let encoded = general_purpose::STANDARD.encode(png_bytes());
    let app = Router::new().route(
        "/sse-generate",
        post(move || {
            let encoded = encoded.clone();
            async move {
                (
                    [("content-type", "text/event-stream")],
                    format!(
                        "event: response.created\ndata: {{\"type\":\"response.created\",\"response\":{{\"status\":\"in_progress\"}}}}\n\nevent: response.completed\ndata: {{\"type\":\"response.completed\",\"response\":{{\"status\":\"completed\",\"output\":[{{\"type\":\"image_generation_call\",\"result\":\"{encoded}\"}}]}}}}\n\n"
                    ),
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let root = tempdir().unwrap();
    let service = Arc::new(NativeImageService::test_service(root.path()).unwrap());
    service
        .config_save(config_update(format!("http://{address}"), Some("sse-key")))
        .unwrap();
    let mut adapter = sync_adapter("/sse-generate");
    adapter.generate.extract = NativeImageAdapterExtract::default();
    service.adapter_save(adapter).unwrap();

    let started = service.start_generate(generate_request()).unwrap();
    let snapshot = wait_for_terminal(&service, &started.id).await;
    assert_eq!(snapshot.status, NativeImageJobStatus::Succeeded);
    assert_eq!(snapshot.outputs.len(), 1);
    server.abort();
}

#[tokio::test]
async fn ai_adapter_sse_without_an_image_returns_a_response_diagnostic() {
    let app = Router::new().route(
        "/sse-without-image",
        post(|| async {
            (
                [("content-type", "text/event-stream")],
                "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_test\",\"status\":\"in_progress\"}}\n\n",
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let root = tempdir().unwrap();
    let service = Arc::new(NativeImageService::test_service(root.path()).unwrap());
    service
        .config_save(config_update(
            format!("http://{address}"),
            Some("diagnostic-secret"),
        ))
        .unwrap();
    let mut adapter = sync_adapter("/sse-without-image");
    adapter.generate.extract = NativeImageAdapterExtract::default();
    service.adapter_save(adapter).unwrap();

    let started = service.start_generate(generate_request()).unwrap();
    let snapshot = wait_for_terminal(&service, &started.id).await;
    assert_eq!(snapshot.status, NativeImageJobStatus::Failed);
    let error = snapshot.error.unwrap_or_default();
    assert!(error.contains("响应摘要"));
    assert!(error.contains("response.created"));
    assert!(!error.contains("diagnostic-secret"));
    server.abort();
}

#[tokio::test]
async fn ai_sync_adapter_maps_parameters_and_extracts_images() {
    let encoded = general_purpose::STANDARD.encode(png_bytes());
    let captured = Arc::new(Mutex::new(None::<Value>));
    let captured_for_route = Arc::clone(&captured);
    let app = Router::new().route(
        "/custom-generate",
        post(move |Json(payload): Json<Value>| {
            let encoded = encoded.clone();
            let captured = Arc::clone(&captured_for_route);
            async move {
                *captured.lock().unwrap() = Some(payload);
                Json(json!({"result": {"images": [encoded]}}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let root = tempdir().unwrap();
    let service = Arc::new(NativeImageService::test_service(root.path()).unwrap());
    service
        .config_save(config_update(format!("http://{address}"), Some("sync-key")))
        .unwrap();
    service
        .adapter_save(sync_adapter("/custom-generate"))
        .unwrap();
    let started = service.start_generate(generate_request()).unwrap();
    let snapshot = wait_for_terminal(&service, &started.id).await;
    assert_eq!(snapshot.status, NativeImageJobStatus::Succeeded);
    let payload = captured.lock().unwrap().clone().unwrap();
    assert_eq!(payload["model_name"], "test-image-model");
    assert_eq!(payload["text"], "draw a tiny blue square");
    assert_eq!(payload["width"], 1024);
    assert_eq!(payload["height"], 1024);
    assert_eq!(payload["count"], 1);
    server.abort();
}

#[tokio::test]
async fn ai_async_adapter_submits_polls_and_normalizes_completion() {
    let encoded = general_purpose::STANDARD.encode(png_bytes());
    let polls = Arc::new(AtomicUsize::new(0));
    let polls_for_route = Arc::clone(&polls);
    let app = Router::new()
        .route(
            "/async-generate",
            post(|| async { Json(json!({"job": {"id": "task-123"}})) }),
        )
        .route(
            "/tasks/{id}",
            get(move || {
                let encoded = encoded.clone();
                let count = polls_for_route.fetch_add(1, Ordering::SeqCst);
                async move {
                    if count == 0 {
                        Json(json!({"state": "running"}))
                    } else {
                        Json(json!({"state": "completed", "images": [encoded]}))
                    }
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let root = tempdir().unwrap();
    let service = Arc::new(NativeImageService::test_service(root.path()).unwrap());
    service
        .config_save(config_update(
            format!("http://{address}"),
            Some("async-key"),
        ))
        .unwrap();
    let mut poll = adapter_request("/tasks/{{taskId}}", json!({}));
    poll.method = "GET".to_string();
    let adapter = NativeImageAdapterSpec {
        version: 1,
        name: "AI configured async relay".to_string(),
        generate: NativeImageAdapterOperation {
            mode: NativeImageAdapterMode::Async,
            submit: adapter_request("/async-generate", json!({"prompt": "{{prompt}}"})),
            poll: Some(poll),
            extract: NativeImageAdapterExtract {
                poll_interval_ms: Some(250),
                max_poll_attempts: Some(5),
                ..Default::default()
            },
        },
        edit: None,
    };
    service.adapter_save(adapter).unwrap();
    let started = service.start_generate(generate_request()).unwrap();
    let snapshot = wait_for_terminal(&service, &started.id).await;
    assert_eq!(snapshot.status, NativeImageJobStatus::Succeeded);
    assert!(polls.load(Ordering::SeqCst) >= 2);
    server.abort();
}

#[tokio::test]
async fn doctor_checks_models_without_returning_the_key() {
    let app = Router::new().route("/v1/models", get(|| async { Json(json!({"data": []})) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let root = tempdir().unwrap();
    let service = NativeImageService::test_service(root.path()).unwrap();
    service
        .config_save(config_update(
            format!("http://{address}"),
            Some("doctor-key"),
        ))
        .unwrap();
    let doctor = service.doctor().await;
    assert!(doctor.ok);
    assert!(doctor.api_key_configured);
    assert!(!serde_json::to_string(&doctor)
        .unwrap()
        .contains("doctor-key"));
    server.abort();
}

#[tokio::test]
async fn doctor_accepts_reachable_image_only_relay_without_models_route() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, Router::new()).await.unwrap() });
    let root = tempdir().unwrap();
    let service = NativeImageService::test_service(root.path()).unwrap();
    service
        .config_save(config_update(
            format!("http://{address}"),
            Some("image-only-key"),
        ))
        .unwrap();
    let doctor = service.doctor().await;
    assert!(doctor.ok);
    assert_eq!(doctor.status_code, Some(404));
    assert!(doctor.message.contains("首次图片任务"));
    server.abort();
}

#[tokio::test]
async fn responses_mode_edits_with_workspace_images() {
    let encoded = general_purpose::STANDARD.encode(png_bytes());
    let app = Router::new().route(
        "/v1/responses",
        post(move || {
            let encoded = encoded.clone();
            async move {
                Json(json!({
                    "output": [{"type": "image_generation_call", "result": encoded}]
                }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let root = tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let input = workspace.join("source.png");
    std::fs::write(&input, png_bytes()).unwrap();
    let service = Arc::new(NativeImageService::test_service(root.path()).unwrap());
    let mut update = config_update(format!("http://{address}"), Some("responses-edit-key"));
    update.endpoint_mode = Some(NativeImageEndpointMode::Responses);
    service.config_save(update).unwrap();

    let started = service
        .start_edit(NativeImageEditRequest {
            prompt: "keep the square but make it green".to_string(),
            input_paths: vec![input.to_string_lossy().into_owned()],
            workspace_root: Some(workspace.to_string_lossy().into_owned()),
            mask_path: None,
            model: None,
            size: Some("1024x1024".to_string()),
            quality: Some("medium".to_string()),
            background: Some("transparent".to_string()),
            output_format: NativeImageOutputFormat::Png,
            n: Some(1),
        })
        .unwrap();
    let snapshot = wait_for_terminal(&service, &started.id).await;
    assert_eq!(snapshot.status, NativeImageJobStatus::Succeeded);
    assert_eq!(snapshot.outputs.len(), 1);
    server.abort();
}

#[tokio::test]
async fn cancellation_is_terminal_even_when_upstream_is_slow() {
    let app = Router::new().route(
        "/v1/images/generations",
        post(|| async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            Json(json!({"data": []}))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let root = tempdir().unwrap();
    let service = Arc::new(NativeImageService::test_service(root.path()).unwrap());
    service
        .config_save(config_update(
            format!("http://{address}"),
            Some("cancel-key"),
        ))
        .unwrap();
    let started = service.start_generate(generate_request()).unwrap();
    let cancelled = service.cancel_job(&started.id).unwrap();
    assert_eq!(cancelled.status, NativeImageJobStatus::Cancelled);
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(
        service.job_status(&started.id).unwrap().status,
        NativeImageJobStatus::Cancelled
    );
    server.abort();
}
