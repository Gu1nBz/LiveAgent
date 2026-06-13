use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use russh::client;
use russh::keys::ssh_key::HashAlg;
use russh::keys::{PrivateKeyWithHashAlg, PublicKey, PublicKeyBase64};
use russh::ChannelMsg;
use russh::MethodKind;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::str;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use tokio::time::timeout;

use crate::commands::settings::{
    check_runtime_ssh_known_host, load_runtime_ssh_host, trust_runtime_ssh_known_host,
    RuntimeSshHostConfig, RuntimeSshKnownHostKey, RuntimeSshKnownHostStatus,
};
use crate::runtime::platform::expand_tilde_path;
#[cfg(windows)]
use crate::runtime::process::configure_child_process_group;

const DEFAULT_ROWS: u16 = 24;
const DEFAULT_COLS: u16 = 80;
const MAX_RING_CHUNKS: usize = 4096;
const MAX_TAIL_BYTES: usize = 256 * 1024;
const SSH_PROMPT_TIMEOUT: Duration = Duration::from_secs(120);
const SSH_RECONNECT_MAX_ATTEMPTS: u8 = 3;
const SSH_RECONNECT_DELAYS: [Duration; 3] = [
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
];
const SSH_STATUS_CONNECTED: &str = "connected";
const SSH_STATUS_RECONNECTING: &str = "reconnecting";
const SSH_STATUS_DISCONNECTED: &str = "disconnected";
pub const TERMINAL_EVENT_NAME: &str = "terminal:event";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionRecord {
    pub id: String,
    pub project_path_key: String,
    pub cwd: String,
    pub shell: String,
    pub title: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh: Option<TerminalSshMetadata>,
    pub pid: Option<u32>,
    pub cols: u16,
    pub rows: u16,
    pub created_at: u128,
    pub updated_at: u128,
    pub finished_at: Option<u128>,
    pub exit_code: Option<i32>,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSshMetadata {
    pub host_id: String,
    pub host_name: String,
    pub username: String,
    pub host: String,
    pub port: u16,
    pub auth_type: String,
    pub status: String,
    pub reconnect_attempt: u8,
    pub reconnect_max_attempts: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSshPrompt {
    pub id: String,
    pub kind: String,
    pub host_id: String,
    pub host_name: String,
    pub host: String,
    pub port: u16,
    pub message: String,
    pub fingerprint_sha256: String,
    pub key_type: String,
    pub answer_echo: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalListResponse {
    pub sessions: Vec<TerminalSessionRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshotResponse {
    pub session: TerminalSessionRecord,
    pub output: String,
    pub truncated: bool,
    pub output_start_offset: u64,
    pub output_end_offset: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSshCreateResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<TerminalSessionRecord>,
    pub output: String,
    pub truncated: bool,
    pub output_start_offset: u64,
    pub output_end_offset: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_prompt: Option<TerminalSshPrompt>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSshLatencyResponse {
    pub session_id: String,
    pub latency_ms: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalShellOption {
    pub id: String,
    pub label: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalShellOptionsResponse {
    pub options: Vec<TerminalShellOption>,
    pub default_shell: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEventPayload {
    pub kind: String,
    pub session_id: String,
    pub project_path_key: String,
    pub session: TerminalSessionRecord,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_start_offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_end_offset: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct TerminalEvent {
    pub payload: TerminalEventPayload,
}

#[derive(Debug, Clone, Copy)]
struct TerminalSize {
    cols: u16,
    rows: u16,
}

struct TerminalSessionEntry {
    backend: TerminalSessionBackend,
    record: Mutex<TerminalSessionRecord>,
    output: Mutex<TerminalOutputBuffer>,
}

enum TerminalSessionBackend {
    Local {
        master: Mutex<Box<dyn MasterPty + Send>>,
        writer: Mutex<Box<dyn Write + Send>>,
        child: Mutex<Box<dyn Child + Send + Sync>>,
    },
    Ssh {
        runtime: Arc<SshSessionRuntime>,
    },
}

struct SshSessionRuntime {
    handle: tokio::sync::Mutex<Option<client::Handle<LiveAgentSshClient>>>,
    input_tx: Mutex<Option<tokio::sync::mpsc::Sender<SshSessionInput>>>,
    shutdown_tx: Mutex<Option<tokio::sync::mpsc::Sender<()>>>,
    connection_id: AtomicUsize,
    closing: AtomicBool,
    reconnect_runner_active: AtomicBool,
}

impl SshSessionRuntime {
    fn new() -> Self {
        Self {
            handle: tokio::sync::Mutex::new(None),
            input_tx: Mutex::new(None),
            shutdown_tx: Mutex::new(None),
            connection_id: AtomicUsize::new(0),
            closing: AtomicBool::new(false),
            reconnect_runner_active: AtomicBool::new(false),
        }
    }

    async fn install_connection(
        &self,
        handle: client::Handle<LiveAgentSshClient>,
        input_tx: tokio::sync::mpsc::Sender<SshSessionInput>,
        shutdown_tx: tokio::sync::mpsc::Sender<()>,
    ) -> usize {
        let connection_id = self.connection_id.fetch_add(1, Ordering::SeqCst) + 1;
        *self.handle.lock().await = Some(handle);
        if let Ok(mut slot) = self.input_tx.lock() {
            *slot = Some(input_tx);
        }
        if let Ok(mut slot) = self.shutdown_tx.lock() {
            *slot = Some(shutdown_tx);
        }
        connection_id
    }

    async fn clear_connection_if_current(&self, connection_id: usize) {
        if self.connection_id.load(Ordering::SeqCst) != connection_id {
            return;
        }
        *self.handle.lock().await = None;
        if let Ok(mut slot) = self.input_tx.lock() {
            *slot = None;
        }
        if let Ok(mut slot) = self.shutdown_tx.lock() {
            *slot = None;
        }
    }

    fn input_sender(&self) -> Option<tokio::sync::mpsc::Sender<SshSessionInput>> {
        self.input_tx.lock().ok().and_then(|slot| slot.clone())
    }

    fn shutdown_sender(&self) -> Option<tokio::sync::mpsc::Sender<()>> {
        self.shutdown_tx.lock().ok().and_then(|slot| slot.clone())
    }

    fn close(&self) -> Option<tokio::sync::mpsc::Sender<()>> {
        self.closing.store(true, Ordering::SeqCst);
        self.shutdown_sender()
    }

    fn is_closing(&self) -> bool {
        self.closing.load(Ordering::SeqCst)
    }

    fn current_connection_id(&self) -> usize {
        self.connection_id.load(Ordering::SeqCst)
    }

    fn begin_reconnect_runner(&self) -> bool {
        !self.reconnect_runner_active.swap(true, Ordering::SeqCst)
    }

    fn finish_reconnect_runner(&self) {
        self.reconnect_runner_active.store(false, Ordering::SeqCst);
    }
}

enum SshSessionInput {
    Data(Vec<u8>),
    Resize(u32, u32),
}

#[derive(Debug, Clone)]
struct PendingSshConnectRequest {
    cwd: String,
    project_path_key: String,
    ssh_host_id: String,
    title: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
}

enum PendingSshPrompt {
    HostKey {
        request: PendingSshConnectRequest,
        host_key: RuntimeSshKnownHostKey,
    },
    KeyboardInteractive {
        request: PendingSshConnectRequest,
        host_config: RuntimeSshHostConfig,
        title: String,
        size: TerminalSize,
        handle: client::Handle<LiveAgentSshClient>,
    },
}

#[derive(Debug, Clone)]
struct KeyboardInteractivePromptData {
    name: String,
    instructions: String,
    prompt: String,
    echo: bool,
}

enum SshAuthOutcome {
    Authenticated,
    KeyboardInteractivePrompt(KeyboardInteractivePromptData),
}

#[derive(Debug, PartialEq, Eq)]
enum PasswordKbiPromptAction {
    RespondEmpty,
    SendPassword,
    PromptUser,
}

#[derive(Debug, Clone)]
struct CapturedHostKey {
    key: RuntimeSshKnownHostKey,
    status: RuntimeSshKnownHostStatus,
}

#[derive(Debug, Clone)]
struct TerminalOutputChunk {
    start_offset: u64,
    data: String,
}

#[derive(Debug, Default)]
struct TerminalOutputBuffer {
    chunks: VecDeque<TerminalOutputChunk>,
    next_offset: u64,
}

impl TerminalOutputBuffer {
    fn append(&mut self, data: String) -> (u64, u64) {
        let start_offset = self.next_offset;
        self.next_offset = self.next_offset.saturating_add(data.len() as u64);
        self.chunks
            .push_back(TerminalOutputChunk { start_offset, data });
        while self.chunks.len() > MAX_RING_CHUNKS {
            self.chunks.pop_front();
        }
        (start_offset, self.next_offset)
    }
}

#[derive(Debug, Clone)]
struct TerminalOutputTail {
    output: String,
    truncated: bool,
    output_start_offset: u64,
    output_end_offset: u64,
}

#[derive(Default)]
pub struct TerminalSessionRegistry {
    sessions: Mutex<HashMap<String, Arc<TerminalSessionEntry>>>,
    pending_ssh_prompts: Mutex<HashMap<String, PendingSshPrompt>>,
    app_handle: Mutex<Option<AppHandle>>,
    subscribers: Arc<Mutex<HashMap<usize, mpsc::Sender<TerminalEvent>>>>,
    next_subscriber_id: AtomicUsize,
}

impl Drop for TerminalSessionRegistry {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.get_mut() {
            for entry in sessions.values() {
                terminate_terminal_entry(entry);
            }
            sessions.clear();
        }
    }
}

impl TerminalSessionRegistry {
    pub fn attach_app_handle(&self, app_handle: AppHandle) {
        if let Ok(mut slot) = self.app_handle.lock() {
            *slot = Some(app_handle);
        }
    }

    pub fn subscribe(&self) -> (mpsc::Receiver<TerminalEvent>, TerminalSubscriberGuard) {
        let (tx, rx) = mpsc::channel();
        let id = self.next_subscriber_id.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.insert(id, tx);
        }
        (
            rx,
            TerminalSubscriberGuard {
                id,
                subscribers: Arc::clone(&self.subscribers),
            },
        )
    }

    pub fn list(&self, project_path_key: Option<String>) -> TerminalListResponse {
        let project_key = project_path_key
            .map(|value| workspace_project_path_key(&value))
            .filter(|value| !value.is_empty());
        let mut sessions = self
            .sessions
            .lock()
            .expect("terminal session registry poisoned")
            .values()
            .filter_map(|entry| entry.record.lock().ok().map(|record| record.clone()))
            .filter(|record| {
                project_key
                    .as_ref()
                    .is_none_or(|wanted| &record.project_path_key == wanted)
            })
            .collect::<Vec<_>>();
        sessions.sort_by(|a, b| {
            a.project_path_key
                .cmp(&b.project_path_key)
                .then(a.created_at.cmp(&b.created_at))
        });
        TerminalListResponse { sessions }
    }

    pub fn create(
        self: &Arc<Self>,
        cwd: String,
        project_path_key: Option<String>,
        shell: Option<String>,
        title: Option<String>,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<TerminalSnapshotResponse, String> {
        let cwd = canonicalize_workdir(&cwd)?;
        let project_key = project_path_key
            .map(|value| workspace_project_path_key(&value))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| workspace_project_path_key(&cwd.display().to_string()));
        if project_key.is_empty() {
            return Err("project_path_key is required".to_string());
        }

        let shell_spec = resolve_shell(shell)?;
        let size = TerminalSize {
            cols: cols.unwrap_or(DEFAULT_COLS).clamp(20, 400),
            rows: rows.unwrap_or(DEFAULT_ROWS).clamp(6, 200),
        };
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: size.rows,
                cols: size.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|err| format!("failed to open terminal pty: {err}"))?;

        let mut cmd = CommandBuilder::new(&shell_spec.command);
        for arg in &shell_spec.args {
            cmd.arg(arg);
        }
        cmd.cwd(&cwd);
        configure_terminal_shell_env(&mut cmd, &shell_spec.command);

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|err| format!("failed to spawn terminal shell: {err}"))?;
        let pid = child.process_id();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|err| format!("failed to open terminal reader: {err}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|err| format!("failed to open terminal writer: {err}"))?;

        let id = uuid::Uuid::new_v4().to_string();
        let title = title
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| self.next_terminal_title(&project_key));
        let now = now_ms();
        let record = TerminalSessionRecord {
            id: id.clone(),
            project_path_key: project_key,
            cwd: cwd.display().to_string(),
            shell: shell_spec.label,
            title,
            kind: "local".to_string(),
            ssh: None,
            pid,
            cols: size.cols,
            rows: size.rows,
            created_at: now,
            updated_at: now,
            finished_at: None,
            exit_code: None,
            running: true,
        };

        let entry = Arc::new(TerminalSessionEntry {
            backend: TerminalSessionBackend::Local {
                master: Mutex::new(pair.master),
                writer: Mutex::new(writer),
                child: Mutex::new(child),
            },
            record: Mutex::new(record),
            output: Mutex::new(TerminalOutputBuffer::default()),
        });
        self.sessions
            .lock()
            .expect("terminal session registry poisoned")
            .insert(id.clone(), Arc::clone(&entry));
        self.broadcast("created", &entry, None, None, None);

        let registry = Arc::clone(self);
        let reader_session_id = id.clone();
        thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            let mut decoder = TerminalUtf8Decoder::default();
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = decoder.push(&buffer[..n]);
                        if !data.is_empty() {
                            registry.append_output(&reader_session_id, data);
                        }
                    }
                    Err(_) => break,
                }
            }
            let data = decoder.finish();
            if !data.is_empty() {
                registry.append_output(&reader_session_id, data);
            }
            registry.mark_finished(&reader_session_id);
        });

        self.snapshot(id, Some(MAX_TAIL_BYTES))
    }

    pub async fn create_ssh(
        self: &Arc<Self>,
        cwd: String,
        project_path_key: Option<String>,
        ssh_host_id: String,
        title: Option<String>,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<TerminalSshCreateResponse, String> {
        let cwd = canonicalize_workdir(&cwd)?;
        let project_key = project_path_key
            .map(|value| workspace_project_path_key(&value))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| workspace_project_path_key(&cwd.display().to_string()));
        if project_key.is_empty() {
            return Err("project_path_key is required".to_string());
        }
        let request = PendingSshConnectRequest {
            cwd: cwd.display().to_string(),
            project_path_key: project_key,
            ssh_host_id,
            title,
            cols,
            rows,
        };
        self.create_ssh_from_request(request).await
    }

    pub async fn answer_ssh_prompt(
        self: &Arc<Self>,
        prompt_id: String,
        answer: Option<String>,
        trust_host_key: bool,
    ) -> Result<TerminalSshCreateResponse, String> {
        let prompt_id = prompt_id.trim().to_string();
        if prompt_id.is_empty() {
            return Err("prompt_id is required".to_string());
        }
        let pending = self
            .pending_ssh_prompts
            .lock()
            .map_err(|_| "ssh prompt registry poisoned".to_string())?
            .remove(&prompt_id)
            .ok_or_else(|| format!("ssh prompt not found: {prompt_id}"))?;
        match pending {
            PendingSshPrompt::HostKey { request, host_key } => {
                if !trust_host_key {
                    return Err("SSH host key trust was cancelled".to_string());
                }
                trust_runtime_ssh_known_host(&host_key)?;
                self.create_ssh_from_request(request).await
            }
            PendingSshPrompt::KeyboardInteractive {
                request,
                host_config,
                title,
                size,
                mut handle,
            } => {
                let response = handle
                    .authenticate_keyboard_interactive_respond(vec![answer.unwrap_or_default()])
                    .await
                    .map_err(|error| {
                        format!("SSH keyboard-interactive response failed: {error}")
                    })?;
                self.continue_ssh_keyboard_interactive(
                    request,
                    host_config,
                    title,
                    size,
                    handle,
                    response,
                    None,
                )
                .await
            }
        }
    }

    pub fn cancel_ssh_prompt(&self, prompt_id: String) -> Result<(), String> {
        let prompt_id = prompt_id.trim().to_string();
        if prompt_id.is_empty() {
            return Err("prompt_id is required".to_string());
        }
        let pending = self
            .pending_ssh_prompts
            .lock()
            .map_err(|_| "ssh prompt registry poisoned".to_string())?
            .remove(&prompt_id);
        if let Some(PendingSshPrompt::KeyboardInteractive { handle, .. }) = pending {
            tokio::spawn(async move {
                let _ = handle
                    .disconnect(
                        russh::Disconnect::ByApplication,
                        "Authentication cancelled",
                        "en",
                    )
                    .await;
            });
        }
        Ok(())
    }

    async fn create_ssh_from_request(
        self: &Arc<Self>,
        request: PendingSshConnectRequest,
    ) -> Result<TerminalSshCreateResponse, String> {
        let host_config = load_runtime_ssh_host(&request.ssh_host_id)?
            .ok_or_else(|| format!("SSH host not found: {}", request.ssh_host_id.trim()))?;
        if ssh_proxy_configured(&host_config) {
            return Err("SSH proxy is configured for this host, but V1 SSH terminal does not support proxy connections yet.".to_string());
        }
        if host_config.host.trim().is_empty() {
            return Err("SSH host is required".to_string());
        }
        if host_config.username.trim().is_empty() {
            return Err("SSH username is required".to_string());
        }

        let size = TerminalSize {
            cols: request.cols.unwrap_or(DEFAULT_COLS).clamp(20, 400),
            rows: request.rows.unwrap_or(DEFAULT_ROWS).clamp(6, 200),
        };
        let title = request
            .title
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| self.next_ssh_title(&request.project_path_key, &host_config.name));

        let auth = resolve_ssh_auth_material(&host_config)?;
        let captured_host_key = Arc::new(tokio::sync::Mutex::new(None::<CapturedHostKey>));
        let ssh_client = LiveAgentSshClient {
            host: host_config.host.clone(),
            port: host_config.port,
            captured_host_key: Arc::clone(&captured_host_key),
        };
        let config = Arc::new(client::Config {
            ..Default::default()
        });
        let mut handle = match client::connect(
            config,
            (host_config.host.as_str(), host_config.port),
            ssh_client,
        )
        .await
        {
            Ok(handle) => handle,
            Err(error) => {
                if let Some(captured) = captured_host_key.lock().await.clone() {
                    return self.ssh_host_key_response(request, &host_config, captured);
                }
                return Err(format!("SSH connection failed: {error}"));
            }
        };

        match authenticate_ssh_handle(&mut handle, &host_config, auth).await? {
            SshAuthOutcome::Authenticated => {
                self.finish_create_ssh_session(request, host_config, title, size, handle)
                    .await
            }
            SshAuthOutcome::KeyboardInteractivePrompt(prompt_data) => self
                .ssh_keyboard_interactive_response(
                    request,
                    host_config,
                    title,
                    size,
                    handle,
                    prompt_data,
                ),
        }
    }

    async fn finish_create_ssh_session(
        self: &Arc<Self>,
        request: PendingSshConnectRequest,
        host_config: RuntimeSshHostConfig,
        title: String,
        size: TerminalSize,
        handle: client::Handle<LiveAgentSshClient>,
    ) -> Result<TerminalSshCreateResponse, String> {
        let channel = open_ssh_shell_channel(&handle, size).await?;

        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let ssh = TerminalSshMetadata {
            host_id: host_config.id.clone(),
            host_name: host_config.name.clone(),
            username: host_config.username.clone(),
            host: host_config.host.clone(),
            port: host_config.port,
            auth_type: host_config.auth_type.clone(),
            status: SSH_STATUS_CONNECTED.to_string(),
            reconnect_attempt: 0,
            reconnect_max_attempts: SSH_RECONNECT_MAX_ATTEMPTS,
        };
        let record = TerminalSessionRecord {
            id: id.clone(),
            project_path_key: request.project_path_key.clone(),
            cwd: request.cwd.clone(),
            shell: "ssh".to_string(),
            title,
            kind: "ssh".to_string(),
            ssh: Some(ssh),
            pid: None,
            cols: size.cols,
            rows: size.rows,
            created_at: now,
            updated_at: now,
            finished_at: None,
            exit_code: None,
            running: true,
        };

        let runtime = Arc::new(SshSessionRuntime::new());
        let (input_tx, input_rx) = tokio::sync::mpsc::channel::<SshSessionInput>(256);
        let (shutdown_tx, shutdown_rx) = tokio::sync::mpsc::channel::<()>(1);
        let connection_id = runtime
            .install_connection(handle, input_tx, shutdown_tx)
            .await;
        let entry = Arc::new(TerminalSessionEntry {
            backend: TerminalSessionBackend::Ssh {
                runtime: Arc::clone(&runtime),
            },
            record: Mutex::new(record),
            output: Mutex::new(TerminalOutputBuffer::default()),
        });
        self.sessions
            .lock()
            .expect("terminal session registry poisoned")
            .insert(id.clone(), Arc::clone(&entry));
        self.broadcast("created", &entry, None, None, None);

        let registry = Arc::clone(self);
        tauri::async_runtime::spawn(run_ssh_session_io(
            registry,
            id.clone(),
            Arc::clone(&runtime),
            connection_id,
            channel,
            input_rx,
            shutdown_rx,
        ));

        self.snapshot(id, Some(MAX_TAIL_BYTES))
            .map(terminal_ssh_create_response_from_snapshot)
    }

    async fn reconnect_ssh_session(
        self: &Arc<Self>,
        entry: Arc<TerminalSessionEntry>,
        attempt: u8,
    ) -> Result<(), String> {
        let record = entry
            .record
            .lock()
            .map_err(|_| "terminal session lock poisoned".to_string())?
            .clone();
        let ssh = record
            .ssh
            .clone()
            .ok_or_else(|| "SSH session metadata is missing".to_string())?;
        let TerminalSessionBackend::Ssh { runtime } = &entry.backend else {
            return Err("terminal session is not an SSH connection".to_string());
        };
        if runtime.is_closing() {
            return Err("SSH session is closing".to_string());
        }
        let host_config = load_runtime_ssh_host(&ssh.host_id)?
            .ok_or_else(|| format!("SSH host not found: {}", ssh.host_id.trim()))?;
        if ssh_proxy_configured(&host_config) {
            return Err("SSH proxy is configured for this host, but V1 SSH terminal does not support proxy connections yet.".to_string());
        }

        let auth = resolve_ssh_auth_material(&host_config)?;
        let captured_host_key = Arc::new(tokio::sync::Mutex::new(None::<CapturedHostKey>));
        let ssh_client = LiveAgentSshClient {
            host: host_config.host.clone(),
            port: host_config.port,
            captured_host_key: Arc::clone(&captured_host_key),
        };
        let config = Arc::new(client::Config {
            ..Default::default()
        });
        let mut handle = match client::connect(
            config,
            (host_config.host.as_str(), host_config.port),
            ssh_client,
        )
        .await
        {
            Ok(handle) => handle,
            Err(error) => {
                if captured_host_key.lock().await.is_some() {
                    return Err(
                        "SSH host key requires confirmation before reconnecting".to_string()
                    );
                }
                return Err(format!("SSH connection failed: {error}"));
            }
        };

        match authenticate_ssh_handle(&mut handle, &host_config, auth).await? {
            SshAuthOutcome::Authenticated => {}
            SshAuthOutcome::KeyboardInteractivePrompt(_) => {
                let _ = handle
                    .disconnect(
                        russh::Disconnect::ByApplication,
                        "Keyboard-interactive reconnect requires user input",
                        "en",
                    )
                    .await;
                return Err(
                    "SSH reconnect requires keyboard-interactive input from the user".to_string(),
                );
            }
        }

        let size = TerminalSize {
            cols: record.cols,
            rows: record.rows,
        };
        let channel = open_ssh_shell_channel(&handle, size).await?;
        let (input_tx, input_rx) = tokio::sync::mpsc::channel::<SshSessionInput>(256);
        let (shutdown_tx, shutdown_rx) = tokio::sync::mpsc::channel::<()>(1);
        let connection_id = runtime
            .install_connection(handle, input_tx, shutdown_tx)
            .await;
        {
            let mut record = entry
                .record
                .lock()
                .map_err(|_| "terminal session lock poisoned".to_string())?;
            record.running = true;
            record.finished_at = None;
            record.exit_code = None;
            record.updated_at = now_ms();
            if let Some(ssh) = record.ssh.as_mut() {
                ssh.status = SSH_STATUS_CONNECTED.to_string();
                ssh.reconnect_attempt = 0;
                ssh.reconnect_max_attempts = SSH_RECONNECT_MAX_ATTEMPTS;
            }
        }
        self.append_output(
            &record.id,
            format!("\r\n[SSH] Reconnected after attempt {attempt}.\r\n"),
        );
        self.broadcast("reconnected", &entry, None, None, None);

        let registry = Arc::clone(self);
        tauri::async_runtime::spawn(run_ssh_session_io(
            registry,
            record.id,
            Arc::clone(runtime),
            connection_id,
            channel,
            input_rx,
            shutdown_rx,
        ));
        Ok(())
    }

    async fn handle_ssh_unexpected_disconnect(
        self: Arc<Self>,
        session_id: String,
        runtime: Arc<SshSessionRuntime>,
        connection_id: usize,
    ) {
        if !runtime.begin_reconnect_runner() {
            return;
        }
        if runtime.current_connection_id() != connection_id {
            runtime.finish_reconnect_runner();
            return;
        }
        runtime.clear_connection_if_current(connection_id).await;
        if runtime.is_closing() {
            runtime.finish_reconnect_runner();
            return;
        }
        let Ok(entry) = self.entry(&session_id) else {
            runtime.finish_reconnect_runner();
            return;
        };
        for attempt in 1..=SSH_RECONNECT_MAX_ATTEMPTS {
            if runtime.is_closing() {
                runtime.finish_reconnect_runner();
                return;
            }
            self.mark_ssh_reconnecting(&entry, attempt);
            self.append_output(
                &session_id,
                format!(
                    "\r\n[SSH] Connection lost. Reconnecting ({attempt}/{SSH_RECONNECT_MAX_ATTEMPTS})...\r\n"
                ),
            );
            let delay = SSH_RECONNECT_DELAYS
                .get(usize::from(attempt.saturating_sub(1)))
                .copied()
                .unwrap_or_else(|| Duration::from_secs(10));
            tokio::time::sleep(delay).await;
            if runtime.is_closing() {
                runtime.finish_reconnect_runner();
                return;
            }
            match self
                .reconnect_ssh_session(Arc::clone(&entry), attempt)
                .await
            {
                Ok(()) => {
                    runtime.finish_reconnect_runner();
                    return;
                }
                Err(error) => {
                    self.append_output(
                        &session_id,
                        format!(
                            "[SSH] Reconnect attempt {attempt}/{SSH_RECONNECT_MAX_ATTEMPTS} failed: {error}\r\n"
                        ),
                    );
                }
            }
        }
        self.mark_ssh_disconnected(&entry);
        self.append_output(
            &session_id,
            format!("[SSH] Reconnect failed after {SSH_RECONNECT_MAX_ATTEMPTS} attempts.\r\n"),
        );
        runtime.finish_reconnect_runner();
    }

    async fn continue_ssh_keyboard_interactive(
        self: &Arc<Self>,
        request: PendingSshConnectRequest,
        host_config: RuntimeSshHostConfig,
        title: String,
        size: TerminalSize,
        mut handle: client::Handle<LiveAgentSshClient>,
        response: client::KeyboardInteractiveAuthResponse,
        auto_password: Option<String>,
    ) -> Result<TerminalSshCreateResponse, String> {
        match continue_keyboard_interactive_auth(&mut handle, response, auto_password).await? {
            SshAuthOutcome::Authenticated => {
                self.finish_create_ssh_session(request, host_config, title, size, handle)
                    .await
            }
            SshAuthOutcome::KeyboardInteractivePrompt(prompt_data) => self
                .ssh_keyboard_interactive_response(
                    request,
                    host_config,
                    title,
                    size,
                    handle,
                    prompt_data,
                ),
        }
    }

    fn ssh_keyboard_interactive_response(
        self: &Arc<Self>,
        request: PendingSshConnectRequest,
        host_config: RuntimeSshHostConfig,
        title: String,
        size: TerminalSize,
        handle: client::Handle<LiveAgentSshClient>,
        prompt_data: KeyboardInteractivePromptData,
    ) -> Result<TerminalSshCreateResponse, String> {
        let prompt_id = uuid::Uuid::new_v4().to_string();
        let message = ssh_keyboard_interactive_message(&prompt_data);
        let prompt = TerminalSshPrompt {
            id: prompt_id.clone(),
            kind: "keyboardInteractive".to_string(),
            host_id: host_config.id.clone(),
            host_name: host_config.name.clone(),
            host: host_config.host.clone(),
            port: host_config.port,
            message,
            fingerprint_sha256: String::new(),
            key_type: String::new(),
            answer_echo: prompt_data.echo,
        };
        self.pending_ssh_prompts
            .lock()
            .map_err(|_| "ssh prompt registry poisoned".to_string())?
            .insert(
                prompt_id.clone(),
                PendingSshPrompt::KeyboardInteractive {
                    request,
                    host_config,
                    title,
                    size,
                    handle,
                },
            );
        self.schedule_ssh_prompt_timeout(prompt_id);
        Ok(TerminalSshCreateResponse {
            session: None,
            output: String::new(),
            truncated: false,
            output_start_offset: 0,
            output_end_offset: 0,
            ssh_prompt: Some(prompt),
        })
    }

    fn ssh_host_key_response(
        self: &Arc<Self>,
        request: PendingSshConnectRequest,
        host_config: &RuntimeSshHostConfig,
        captured: CapturedHostKey,
    ) -> Result<TerminalSshCreateResponse, String> {
        match captured.status {
            RuntimeSshKnownHostStatus::Known => {
                Err("SSH host key check failed unexpectedly".to_string())
            }
            RuntimeSshKnownHostStatus::Changed { stored_fingerprint } => Err(format!(
                "SSH host key changed for {}:{}. Stored fingerprint: {}. Received fingerprint: {}.",
                host_config.host,
                host_config.port,
                stored_fingerprint,
                captured.key.fingerprint_sha256
            )),
            RuntimeSshKnownHostStatus::Unknown => {
                let prompt_id = uuid::Uuid::new_v4().to_string();
                let prompt = TerminalSshPrompt {
                    id: prompt_id.clone(),
                    kind: "hostKey".to_string(),
                    host_id: host_config.id.clone(),
                    host_name: host_config.name.clone(),
                    host: host_config.host.clone(),
                    port: host_config.port,
                    message: format!(
                        "Trust SSH host key for {}:{}?",
                        host_config.host, host_config.port
                    ),
                    fingerprint_sha256: captured.key.fingerprint_sha256.clone(),
                    key_type: captured.key.key_type.clone(),
                    answer_echo: false,
                };
                self.pending_ssh_prompts
                    .lock()
                    .map_err(|_| "ssh prompt registry poisoned".to_string())?
                    .insert(
                        prompt_id.clone(),
                        PendingSshPrompt::HostKey {
                            request,
                            host_key: captured.key,
                        },
                    );
                self.schedule_ssh_prompt_timeout(prompt_id);
                Ok(TerminalSshCreateResponse {
                    session: None,
                    output: String::new(),
                    truncated: false,
                    output_start_offset: 0,
                    output_end_offset: 0,
                    ssh_prompt: Some(prompt),
                })
            }
        }
    }

    fn schedule_ssh_prompt_timeout(self: &Arc<Self>, prompt_id: String) {
        let registry = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(SSH_PROMPT_TIMEOUT).await;
            let pending = registry
                .pending_ssh_prompts
                .lock()
                .ok()
                .and_then(|mut prompts| prompts.remove(&prompt_id));
            if let Some(PendingSshPrompt::KeyboardInteractive { handle, .. }) = pending {
                let _ = handle
                    .disconnect(
                        russh::Disconnect::ByApplication,
                        "Authentication prompt timed out",
                        "en",
                    )
                    .await;
            }
        });
    }

    pub fn snapshot(
        &self,
        session_id: String,
        max_bytes: Option<usize>,
    ) -> Result<TerminalSnapshotResponse, String> {
        let entry = self.entry(&session_id)?;
        let session = entry
            .record
            .lock()
            .map_err(|_| "terminal session lock poisoned".to_string())?
            .clone();
        let tail = read_output_tail(&entry, max_bytes.unwrap_or(MAX_TAIL_BYTES));
        Ok(TerminalSnapshotResponse {
            session,
            output: tail.output,
            truncated: tail.truncated,
            output_start_offset: tail.output_start_offset,
            output_end_offset: tail.output_end_offset,
        })
    }

    pub fn session_record(&self, session_id: String) -> Result<TerminalSessionRecord, String> {
        self.record(session_id)
    }

    pub async fn ssh_latency(
        self: &Arc<Self>,
        session_id: String,
    ) -> Result<TerminalSshLatencyResponse, String> {
        let entry = self.entry(&session_id)?;
        let record = entry
            .record
            .lock()
            .map_err(|_| "terminal session lock poisoned".to_string())?
            .clone();
        if record.kind.trim() != "ssh" {
            return Err("terminal session is not an SSH connection".to_string());
        }
        if !record.running {
            return Err("SSH connection is not running".to_string());
        }
        let TerminalSessionBackend::Ssh { runtime } = &entry.backend else {
            return Err("terminal session is not an SSH connection".to_string());
        };
        let start = Instant::now();
        let ping = timeout(Duration::from_secs(3), async {
            let handle = runtime.handle.lock().await;
            let Some(handle) = handle.as_ref() else {
                return Err(russh::Error::Disconnect);
            };
            handle.send_ping().await
        })
        .await;
        match ping {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                spawn_ssh_reconnect_runner(
                    Arc::clone(self),
                    record.id.clone(),
                    Arc::clone(runtime),
                    runtime.current_connection_id(),
                );
                return Err(format!("SSH latency check failed: {error}"));
            }
            Err(_) => {
                spawn_ssh_reconnect_runner(
                    Arc::clone(self),
                    record.id.clone(),
                    Arc::clone(runtime),
                    runtime.current_connection_id(),
                );
                return Err("SSH latency check timed out".to_string());
            }
        }
        let elapsed = start.elapsed().as_millis().clamp(1, u128::from(u32::MAX)) as u32;
        Ok(TerminalSshLatencyResponse {
            session_id: record.id,
            latency_ms: elapsed,
        })
    }

    pub fn input(&self, session_id: String, data: String) -> Result<TerminalSessionRecord, String> {
        if data.is_empty() {
            return self.record(session_id);
        }
        let entry = self.entry(&session_id)?;
        let running = entry
            .record
            .lock()
            .map_err(|_| "terminal session lock poisoned".to_string())?
            .running;
        if !running {
            return Err("terminal session is not running".to_string());
        }
        match &entry.backend {
            TerminalSessionBackend::Local { writer, .. } => {
                writer
                    .lock()
                    .map_err(|_| "terminal writer lock poisoned".to_string())?
                    .write_all(data.as_bytes())
                    .map_err(|err| format!("failed to write terminal input: {err}"))?;
            }
            TerminalSessionBackend::Ssh { runtime } => {
                runtime
                    .input_sender()
                    .ok_or_else(|| "SSH connection is not connected".to_string())?
                    .try_send(SshSessionInput::Data(data.into_bytes()))
                    .map_err(|err| format!("failed to write ssh terminal input: {err}"))?;
            }
        }
        self.touch(&entry);
        self.record(session_id)
    }

    pub fn resize(
        &self,
        session_id: String,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalSessionRecord, String> {
        let entry = self.entry(&session_id)?;
        let cols = cols.clamp(20, 400);
        let rows = rows.clamp(6, 200);
        match &entry.backend {
            TerminalSessionBackend::Local { master, .. } => {
                master
                    .lock()
                    .map_err(|_| "terminal master lock poisoned".to_string())?
                    .resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(|err| format!("failed to resize terminal: {err}"))?;
            }
            TerminalSessionBackend::Ssh { runtime } => {
                if let Some(input_tx) = runtime.input_sender() {
                    input_tx
                        .try_send(SshSessionInput::Resize(u32::from(cols), u32::from(rows)))
                        .map_err(|err| format!("failed to resize ssh terminal: {err}"))?;
                }
            }
        }
        {
            let mut record = entry
                .record
                .lock()
                .map_err(|_| "terminal session lock poisoned".to_string())?;
            record.cols = cols;
            record.rows = rows;
            record.updated_at = now_ms();
        }
        self.broadcast("resized", &entry, None, None, None);
        self.record(session_id)
    }

    pub fn rename(
        &self,
        session_id: String,
        title: String,
    ) -> Result<TerminalSessionRecord, String> {
        let entry = self.entry(&session_id)?;
        let next_title = title.trim();
        if next_title.is_empty() {
            return Err("terminal title cannot be empty".to_string());
        }
        {
            let mut record = entry
                .record
                .lock()
                .map_err(|_| "terminal session lock poisoned".to_string())?;
            record.title = next_title.to_string();
            record.updated_at = now_ms();
        }
        self.broadcast("renamed", &entry, None, None, None);
        self.record(session_id)
    }

    pub fn close(&self, session_id: String) -> Result<TerminalSessionRecord, String> {
        let entry = self.entry(&session_id)?;
        terminate_terminal_entry(&entry);
        self.mark_finished(&session_id);
        self.sessions
            .lock()
            .expect("terminal session registry poisoned")
            .remove(session_id.trim());
        let session = entry
            .record
            .lock()
            .map_err(|_| "terminal session lock poisoned".to_string())?
            .clone();
        self.broadcast("closed", &entry, None, None, None);
        Ok(session)
    }

    pub fn close_all(&self) -> Result<TerminalListResponse, String> {
        let ids = self
            .sessions
            .lock()
            .expect("terminal session registry poisoned")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        self.close_ids(ids)
    }

    pub fn close_project(&self, project_path_key: String) -> Result<TerminalListResponse, String> {
        let project_key = workspace_project_path_key(&project_path_key);
        if project_key.is_empty() {
            return Err("project_path_key is required".to_string());
        }
        let ids = self
            .sessions
            .lock()
            .expect("terminal session registry poisoned")
            .iter()
            .filter_map(|(id, entry)| {
                entry
                    .record
                    .lock()
                    .ok()
                    .filter(|record| record.project_path_key == project_key)
                    .map(|_| id.clone())
            })
            .collect::<Vec<_>>();
        self.close_ids(ids)
    }

    pub fn running_session_count(&self) -> usize {
        self.sessions
            .lock()
            .ok()
            .map(|sessions| {
                sessions
                    .values()
                    .filter_map(|entry| entry.record.lock().ok())
                    .filter(|record| record.running)
                    .count()
            })
            .unwrap_or(0)
    }

    pub fn read_tail(
        &self,
        project_path_key: String,
        session_id: Option<String>,
        max_bytes: Option<usize>,
    ) -> Result<TerminalReadTailResponse, String> {
        let project_key = workspace_project_path_key(&project_path_key);
        if project_key.is_empty() {
            return Err("project_path_key is required".to_string());
        }
        let sessions = self.list(Some(project_key.clone())).sessions;
        if sessions.is_empty() {
            return Ok(TerminalReadTailResponse {
                sessions: Vec::new(),
                selected_session: None,
                output: String::new(),
                truncated: false,
            });
        }
        let requested_session_id = session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if requested_session_id.is_none() && sessions.len() > 1 {
            return Ok(TerminalReadTailResponse {
                sessions,
                selected_session: None,
                output: String::new(),
                truncated: false,
            });
        }
        let selected_id = requested_session_id.unwrap_or_else(|| sessions[0].id.clone());
        let snapshot = self.snapshot(selected_id, max_bytes)?;
        if snapshot.session.project_path_key != project_key {
            return Err("terminal session is outside the current project".to_string());
        }
        Ok(TerminalReadTailResponse {
            sessions,
            selected_session: Some(snapshot.session),
            output: snapshot.output,
            truncated: snapshot.truncated,
        })
    }

    fn close_ids(&self, ids: Vec<String>) -> Result<TerminalListResponse, String> {
        let mut sessions = Vec::new();
        for id in ids {
            sessions.push(self.close(id)?);
        }
        Ok(TerminalListResponse { sessions })
    }

    fn next_terminal_title(&self, project_path_key: &str) -> String {
        let count = self
            .sessions
            .lock()
            .ok()
            .map(|sessions| {
                sessions
                    .values()
                    .filter_map(|entry| entry.record.lock().ok())
                    .filter(|record| record.project_path_key == project_path_key)
                    .count()
            })
            .unwrap_or(0);
        format!("Terminal {}", count + 1)
    }

    fn next_ssh_title(&self, project_path_key: &str, host_name: &str) -> String {
        let base = host_name.trim();
        let base = if base.is_empty() { "SSH" } else { base };
        let count = self
            .sessions
            .lock()
            .ok()
            .map(|sessions| {
                sessions
                    .values()
                    .filter_map(|entry| entry.record.lock().ok())
                    .filter(|record| {
                        record.project_path_key == project_path_key
                            && record.kind == "ssh"
                            && record.title.starts_with(base)
                    })
                    .count()
            })
            .unwrap_or(0);
        if count == 0 {
            base.to_string()
        } else {
            format!("{base} {}", count + 1)
        }
    }

    fn entry(&self, session_id: &str) -> Result<Arc<TerminalSessionEntry>, String> {
        let id = session_id.trim();
        if id.is_empty() {
            return Err("terminal_id is required".to_string());
        }
        self.sessions
            .lock()
            .expect("terminal session registry poisoned")
            .get(id)
            .cloned()
            .ok_or_else(|| format!("terminal session not found: {id}"))
    }

    fn record(&self, session_id: String) -> Result<TerminalSessionRecord, String> {
        let entry = self.entry(&session_id)?;
        entry
            .record
            .lock()
            .map(|record| record.clone())
            .map_err(|_| "terminal session lock poisoned".to_string())
    }

    fn touch(&self, entry: &Arc<TerminalSessionEntry>) {
        if let Ok(mut record) = entry.record.lock() {
            record.updated_at = now_ms();
        }
    }

    fn append_output(&self, session_id: &str, data: String) {
        let Ok(entry) = self.entry(session_id) else {
            return;
        };
        let (output_start_offset, output_end_offset) = {
            let mut output = match entry.output.lock() {
                Ok(output) => output,
                Err(_) => return,
            };
            output.append(data.clone())
        };
        self.touch(&entry);
        self.broadcast(
            "output",
            &entry,
            Some(data),
            Some(output_start_offset),
            Some(output_end_offset),
        );
    }

    fn mark_finished(&self, session_id: &str) {
        let Ok(entry) = self.entry(session_id) else {
            return;
        };
        let mut exit_code = None;
        if let TerminalSessionBackend::Local { child, .. } = &entry.backend {
            if let Ok(mut child) = child.lock() {
                if let Ok(status) = child.try_wait() {
                    exit_code = status.map(|status| status.exit_code() as i32);
                }
            }
        }
        {
            let mut record = match entry.record.lock() {
                Ok(record) => record,
                Err(_) => return,
            };
            if record.running {
                record.running = false;
                record.finished_at = Some(now_ms());
                record.exit_code = exit_code;
                record.updated_at = now_ms();
            }
        }
        self.broadcast("exit", &entry, None, None, None);
    }

    fn mark_ssh_reconnecting(&self, entry: &Arc<TerminalSessionEntry>, attempt: u8) {
        {
            let mut record = match entry.record.lock() {
                Ok(record) => record,
                Err(_) => return,
            };
            record.running = false;
            record.finished_at = None;
            record.exit_code = None;
            record.updated_at = now_ms();
            if let Some(ssh) = record.ssh.as_mut() {
                ssh.status = SSH_STATUS_RECONNECTING.to_string();
                ssh.reconnect_attempt = attempt;
                ssh.reconnect_max_attempts = SSH_RECONNECT_MAX_ATTEMPTS;
            }
        }
        self.broadcast("reconnecting", entry, None, None, None);
    }

    fn mark_ssh_disconnected(&self, entry: &Arc<TerminalSessionEntry>) {
        {
            let mut record = match entry.record.lock() {
                Ok(record) => record,
                Err(_) => return,
            };
            record.running = false;
            record.finished_at = Some(now_ms());
            record.exit_code = None;
            record.updated_at = now_ms();
            if let Some(ssh) = record.ssh.as_mut() {
                ssh.status = SSH_STATUS_DISCONNECTED.to_string();
                ssh.reconnect_attempt = SSH_RECONNECT_MAX_ATTEMPTS;
                ssh.reconnect_max_attempts = SSH_RECONNECT_MAX_ATTEMPTS;
            }
        }
        self.broadcast("exit", entry, None, None, None);
    }

    fn broadcast(
        &self,
        kind: &str,
        entry: &Arc<TerminalSessionEntry>,
        data: Option<String>,
        output_start_offset: Option<u64>,
        output_end_offset: Option<u64>,
    ) {
        let Ok(record) = entry.record.lock().map(|record| record.clone()) else {
            return;
        };
        let payload = TerminalEventPayload {
            kind: kind.to_string(),
            session_id: record.id.clone(),
            project_path_key: record.project_path_key.clone(),
            session: record,
            data,
            output_start_offset,
            output_end_offset,
        };

        if let Ok(app_handle) = self.app_handle.lock() {
            if let Some(app_handle) = app_handle.as_ref() {
                let _ = app_handle.emit(TERMINAL_EVENT_NAME, &payload);
            }
        }

        let subscribers = self
            .subscribers
            .lock()
            .map(|subscribers| subscribers.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let event = TerminalEvent { payload };
        for subscriber in subscribers {
            let _ = subscriber.send(event.clone());
        }
    }
}

struct LiveAgentSshClient {
    host: String,
    port: u16,
    captured_host_key: Arc<tokio::sync::Mutex<Option<CapturedHostKey>>>,
}

impl client::Handler for LiveAgentSshClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let key_base64 =
            base64::engine::general_purpose::STANDARD.encode(server_public_key.public_key_bytes());
        let key = RuntimeSshKnownHostKey {
            host: self.host.clone(),
            port: self.port,
            key_type: server_public_key.algorithm().as_str().to_string(),
            key_base64,
            fingerprint_sha256: server_public_key.fingerprint(HashAlg::Sha256).to_string(),
        };
        match check_runtime_ssh_known_host(&key) {
            Ok(RuntimeSshKnownHostStatus::Known) => Ok(true),
            Ok(status) => {
                *self.captured_host_key.lock().await = Some(CapturedHostKey { key, status });
                Ok(false)
            }
            Err(error) => {
                *self.captured_host_key.lock().await = Some(CapturedHostKey {
                    key,
                    status: RuntimeSshKnownHostStatus::Changed {
                        stored_fingerprint: error,
                    },
                });
                Ok(false)
            }
        }
    }
}

enum ResolvedSshAuth {
    Password(String),
    PrivateKey {
        key: String,
        passphrase: Option<String>,
    },
}

fn ssh_proxy_configured(host: &RuntimeSshHostConfig) -> bool {
    !host.proxy.url.trim().is_empty()
        || host.proxy.port > 0
        || !host.proxy.username.trim().is_empty()
        || host.proxy.password_configured
}

fn resolve_ssh_auth_material(host: &RuntimeSshHostConfig) -> Result<ResolvedSshAuth, String> {
    if host.auth_type == "privateKey" {
        let key = if !host.private_key.trim().is_empty() {
            host.private_key.trim().to_string()
        } else {
            let path = host.private_key_path.trim();
            if path.is_empty() {
                return Err("SSH private key is not configured".to_string());
            }
            let expanded = expand_tilde_path(path);
            fs::read_to_string(&expanded)
                .map_err(|error| {
                    format!(
                        "failed to read SSH private key {}: {error}",
                        expanded.display()
                    )
                })?
                .trim()
                .to_string()
        };
        if key.is_empty() {
            return Err("SSH private key is empty".to_string());
        }
        let passphrase = host.private_key_passphrase.trim().to_string();
        Ok(ResolvedSshAuth::PrivateKey {
            key,
            passphrase: (!passphrase.is_empty()).then_some(passphrase),
        })
    } else {
        let password = host.password.trim().to_string();
        if password.is_empty() {
            return Err("SSH password is not configured".to_string());
        }
        Ok(ResolvedSshAuth::Password(password))
    }
}

async fn authenticate_ssh_handle(
    handle: &mut client::Handle<LiveAgentSshClient>,
    host: &RuntimeSshHostConfig,
    auth: ResolvedSshAuth,
) -> Result<SshAuthOutcome, String> {
    match auth {
        ResolvedSshAuth::Password(password) => {
            let result = handle
                .authenticate_password(host.username.as_str(), password.clone())
                .await
                .map_err(|error| format!("SSH password authentication failed: {error}"))?;
            if result.success() {
                return Ok(SshAuthOutcome::Authenticated);
            }
            if auth_result_can_continue_with_kbi(&result) {
                let response = handle
                    .authenticate_keyboard_interactive_start(host.username.as_str(), None::<String>)
                    .await
                    .map_err(|error| {
                        format!("SSH keyboard-interactive authentication failed: {error}")
                    })?;
                return continue_keyboard_interactive_auth(handle, response, Some(password)).await;
            }
            Err("SSH authentication failed".to_string())
        }
        ResolvedSshAuth::PrivateKey { key, passphrase } => {
            let key_pair = russh::keys::decode_secret_key(&key, passphrase.as_deref())
                .map_err(|error| format!("Invalid SSH private key: {error}"))?;
            let key = PrivateKeyWithHashAlg::new(Arc::new(key_pair), Some(HashAlg::Sha256));
            let result = handle
                .authenticate_publickey(host.username.as_str(), key)
                .await
                .map_err(|error| format!("SSH private key authentication failed: {error}"))?;
            if result.success() {
                return Ok(SshAuthOutcome::Authenticated);
            }
            if auth_result_can_continue_with_kbi(&result) {
                let response = handle
                    .authenticate_keyboard_interactive_start(host.username.as_str(), None::<String>)
                    .await
                    .map_err(|error| {
                        format!("SSH keyboard-interactive authentication failed: {error}")
                    })?;
                return continue_keyboard_interactive_auth(handle, response, None).await;
            }
            Err("SSH authentication failed".to_string())
        }
    }
}

fn auth_result_can_continue_with_kbi(result: &client::AuthResult) -> bool {
    matches!(
        result,
        client::AuthResult::Failure {
            remaining_methods,
            ..
        } if remaining_methods.contains(&MethodKind::KeyboardInteractive)
    )
}

fn prompt_looks_like_password(prompt: &str) -> bool {
    let normalized = prompt.trim().to_ascii_lowercase();
    normalized.contains("password") || prompt.contains("密码")
}

fn classify_password_kbi_prompts(
    prompts: &[client::Prompt],
    password_prompt_consumed: bool,
) -> PasswordKbiPromptAction {
    if prompts.is_empty() {
        PasswordKbiPromptAction::RespondEmpty
    } else if !password_prompt_consumed
        && prompts.len() == 1
        && !prompts[0].echo
        && prompt_looks_like_password(&prompts[0].prompt)
    {
        PasswordKbiPromptAction::SendPassword
    } else {
        PasswordKbiPromptAction::PromptUser
    }
}

async fn continue_keyboard_interactive_auth(
    handle: &mut client::Handle<LiveAgentSshClient>,
    mut response: client::KeyboardInteractiveAuthResponse,
    auto_password: Option<String>,
) -> Result<SshAuthOutcome, String> {
    let mut password_prompt_consumed = false;
    for _ in 0..5 {
        match response {
            client::KeyboardInteractiveAuthResponse::Success => {
                return Ok(SshAuthOutcome::Authenticated);
            }
            client::KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err("SSH keyboard-interactive authentication failed".to_string());
            }
            client::KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => match classify_password_kbi_prompts(&prompts, password_prompt_consumed) {
                PasswordKbiPromptAction::RespondEmpty => {
                    response = handle
                        .authenticate_keyboard_interactive_respond(Vec::new())
                        .await
                        .map_err(|error| {
                            format!("SSH keyboard-interactive response failed: {error}")
                        })?;
                }
                PasswordKbiPromptAction::SendPassword if auto_password.is_some() => {
                    password_prompt_consumed = true;
                    response = handle
                        .authenticate_keyboard_interactive_respond(vec![auto_password
                            .clone()
                            .unwrap_or_default()])
                        .await
                        .map_err(|error| {
                            format!("SSH keyboard-interactive response failed: {error}")
                        })?;
                }
                PasswordKbiPromptAction::SendPassword | PasswordKbiPromptAction::PromptUser => {
                    if prompts.len() != 1 {
                        return Err(
                            "SSH keyboard-interactive requested multiple prompts, which is not supported in V1."
                                .to_string(),
                        );
                    }
                    let prompt = prompts
                        .into_iter()
                        .next()
                        .ok_or_else(|| "SSH keyboard-interactive prompt is empty".to_string())?;
                    return Ok(SshAuthOutcome::KeyboardInteractivePrompt(
                        KeyboardInteractivePromptData {
                            name,
                            instructions,
                            prompt: prompt.prompt,
                            echo: prompt.echo,
                        },
                    ));
                }
            },
        }
    }
    Err("SSH keyboard-interactive exceeded maximum prompt rounds".to_string())
}

fn ssh_keyboard_interactive_message(prompt_data: &KeyboardInteractivePromptData) -> String {
    let mut parts = Vec::new();
    if !prompt_data.name.trim().is_empty() {
        parts.push(prompt_data.name.trim().to_string());
    }
    if !prompt_data.instructions.trim().is_empty() {
        parts.push(prompt_data.instructions.trim().to_string());
    }
    if !prompt_data.prompt.trim().is_empty() {
        parts.push(prompt_data.prompt.trim().to_string());
    }
    if parts.is_empty() {
        "SSH keyboard-interactive authentication requires input.".to_string()
    } else {
        parts.join("\n")
    }
}

async fn open_ssh_shell_channel(
    handle: &client::Handle<LiveAgentSshClient>,
    size: TerminalSize,
) -> Result<russh::Channel<client::Msg>, String> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("SSH channel open failed: {error}"))?;
    channel
        .request_pty(
            false,
            "xterm-256color",
            u32::from(size.cols),
            u32::from(size.rows),
            0,
            0,
            &[],
        )
        .await
        .map_err(|error| format!("SSH PTY request failed: {error}"))?;
    channel
        .request_shell(false)
        .await
        .map_err(|error| format!("SSH shell request failed: {error}"))?;
    Ok(channel)
}

async fn run_ssh_session_io(
    registry: Arc<TerminalSessionRegistry>,
    session_id: String,
    runtime: Arc<SshSessionRuntime>,
    connection_id: usize,
    channel: russh::Channel<client::Msg>,
    mut input_rx: tokio::sync::mpsc::Receiver<SshSessionInput>,
    mut shutdown_rx: tokio::sync::mpsc::Receiver<()>,
) {
    let (mut read_half, write_half) = channel.split();
    let mut writer = write_half.make_writer();
    let mut decoder = TerminalUtf8Decoder::default();
    loop {
        tokio::select! {
            _ = shutdown_rx.recv() => {
                let handle = runtime.handle.lock().await;
                if let Some(handle) = handle.as_ref() {
                    let _ = handle.disconnect(russh::Disconnect::ByApplication, "User disconnected", "en").await;
                }
                break;
            }
            input = input_rx.recv() => {
                match input {
                    Some(SshSessionInput::Data(data)) => {
                        if writer.write_all(&data).await.is_err() {
                            break;
                        }
                    }
                    Some(SshSessionInput::Resize(cols, rows)) => {
                        let _ = write_half.window_change(cols, rows, 0, 0).await;
                    }
                    None => break,
                }
            }
            message = read_half.wait() => {
                match message {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let text = decoder.push(data.as_ref());
                        if !text.is_empty() {
                            registry.append_output(&session_id, text);
                        }
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    let text = decoder.finish();
    if !text.is_empty() {
        registry.append_output(&session_id, text);
    }
    spawn_ssh_reconnect_runner(registry, session_id, runtime, connection_id);
}

fn spawn_ssh_reconnect_runner(
    registry: Arc<TerminalSessionRegistry>,
    session_id: String,
    runtime: Arc<SshSessionRuntime>,
    connection_id: usize,
) {
    thread::spawn(move || {
        let Ok(rt) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        else {
            return;
        };
        rt.block_on(async move {
            registry
                .handle_ssh_unexpected_disconnect(session_id, runtime, connection_id)
                .await;
        });
    });
}

fn terminal_ssh_create_response_from_snapshot(
    snapshot: TerminalSnapshotResponse,
) -> TerminalSshCreateResponse {
    TerminalSshCreateResponse {
        session: Some(snapshot.session),
        output: snapshot.output,
        truncated: snapshot.truncated,
        output_start_offset: snapshot.output_start_offset,
        output_end_offset: snapshot.output_end_offset,
        ssh_prompt: None,
    }
}

pub struct TerminalSubscriberGuard {
    id: usize,
    subscribers: Arc<Mutex<HashMap<usize, mpsc::Sender<TerminalEvent>>>>,
}

impl Drop for TerminalSubscriberGuard {
    fn drop(&mut self) {
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.remove(&self.id);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalReadTailResponse {
    pub sessions: Vec<TerminalSessionRecord>,
    pub selected_session: Option<TerminalSessionRecord>,
    pub output: String,
    pub truncated: bool,
}

fn read_output_tail(entry: &TerminalSessionEntry, max_bytes: usize) -> TerminalOutputTail {
    let output = match entry.output.lock() {
        Ok(output) => output,
        Err(_) => {
            return TerminalOutputTail {
                output: String::new(),
                truncated: false,
                output_start_offset: 0,
                output_end_offset: 0,
            }
        }
    };
    read_output_chunks_tail(&output, max_bytes)
}

fn read_output_chunks_tail(output: &TerminalOutputBuffer, max_bytes: usize) -> TerminalOutputTail {
    let output_end_offset = output.next_offset;
    if max_bytes == 0 {
        return TerminalOutputTail {
            output: String::new(),
            truncated: output_end_offset > 0,
            output_start_offset: output_end_offset,
            output_end_offset,
        };
    }
    let mut remaining = max_bytes;
    let mut chunks = VecDeque::new();
    let mut truncated = false;
    for chunk in output.chunks.iter().rev() {
        if remaining == 0 {
            truncated = true;
            break;
        }
        let len = chunk.data.len();
        if len > remaining {
            let start = chunk
                .data
                .char_indices()
                .map(|(index, _)| index)
                .find(|index| len.saturating_sub(*index) <= remaining)
                .unwrap_or(len);
            chunks.push_front(TerminalOutputChunk {
                start_offset: chunk.start_offset.saturating_add(start as u64),
                data: chunk.data[start..].to_string(),
            });
            truncated = true;
            break;
        }
        remaining = remaining.saturating_sub(len);
        chunks.push_front(chunk.clone());
    }
    let output_start_offset = chunks
        .front()
        .map(|chunk| chunk.start_offset)
        .unwrap_or(output_end_offset);
    let output_text = chunks
        .into_iter()
        .map(|chunk| chunk.data)
        .collect::<String>();
    TerminalOutputTail {
        output: output_text,
        truncated: truncated || output_start_offset > 0,
        output_start_offset,
        output_end_offset,
    }
}

fn terminate_terminal_entry(entry: &Arc<TerminalSessionEntry>) {
    match &entry.backend {
        TerminalSessionBackend::Local { child, .. } => {
            let pid = entry.record.lock().ok().and_then(|record| record.pid);
            terminate_process_tree_best_effort(pid);
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
            }
        }
        TerminalSessionBackend::Ssh { runtime } => {
            if let Some(shutdown_tx) = runtime.close() {
                let _ = shutdown_tx.try_send(());
            }
        }
    }
}

fn terminate_process_tree_best_effort(pid: Option<u32>) {
    let Some(pid) = pid else {
        return;
    };
    if pid == 0 {
        return;
    }

    #[cfg(windows)]
    {
        // `taskkill` is a console app; hide its window so app exit stays clean.
        let mut command = std::process::Command::new("taskkill");
        configure_child_process_group(&mut command);
        let _ = command
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }

    #[cfg(unix)]
    {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn workspace_project_path_key(path: &str) -> String {
    path.trim().to_string()
}

fn canonicalize_workdir(workdir: &str) -> Result<PathBuf, String> {
    let raw = workdir.trim();
    if raw.is_empty() {
        return Err("workdir is required".to_string());
    }
    let path = expand_tilde_path(raw);
    if !path.is_absolute() {
        return Err(format!("workdir must be absolute: {workdir}"));
    }
    let metadata = fs::metadata(&path).map_err(|_| format!("workdir does not exist: {workdir}"))?;
    if !metadata.is_dir() {
        return Err(format!("workdir must be a directory: {workdir}"));
    }
    let canonical =
        fs::canonicalize(&path).map_err(|err| format!("failed to canonicalize workdir: {err}"))?;
    Ok(strip_windows_unc_prefix(canonical))
}

fn strip_windows_unc_prefix(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    path
}

fn is_program_on_path(program: &str) -> bool {
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path_var) {
        if dir.join(program).is_file() {
            return true;
        }
    }
    false
}

fn scrub_terminal_shell_env(cmd: &mut CommandBuilder) {
    for key in ["npm_config_prefix", "NPM_CONFIG_PREFIX"] {
        cmd.env_remove(key);
    }
}

fn configure_terminal_shell_env(cmd: &mut CommandBuilder, shell_command: &str) {
    scrub_terminal_shell_env(cmd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if is_zsh_shell(shell_command) {
        configure_zsh_colored_prompt(cmd);
    }
}

fn configure_zsh_colored_prompt(cmd: &mut CommandBuilder) {
    let colored_prompt = "%F{green}%n%f%F{yellow}@%f%F{blue}%m%f %F{magenta}%1~%f %F{cyan}%#%f ";
    let zdotdir = create_zsh_prompt_overlay(colored_prompt);
    if let Some(dir) = zdotdir {
        cmd.env("ZDOTDIR", dir.to_string_lossy().as_ref());
    }
}

fn create_zsh_prompt_overlay(prompt: &str) -> Option<PathBuf> {
    let base = dirs::cache_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    let zdotdir = base.join("liveagent-zsh");
    if fs::create_dir_all(&zdotdir).is_err() {
        return None;
    }

    let home = dirs::home_dir().unwrap_or_default();
    let user_zshrc = home.join(".zshrc");
    let user_zshenv = home.join(".zshenv");

    let zshenv_content = format!(
        "export _LIVEAGENT_REAL_ZDOTDIR=\"$HOME\"\n\
         [[ -f \"{}\" ]] && source \"{}\"\n",
        user_zshenv.display(),
        user_zshenv.display(),
    );
    let zshrc_content = format!(
        "[[ -f \"{}\" ]] && source \"{}\"\n\
         PROMPT='{}'\n\
         unset ZDOTDIR\n",
        user_zshrc.display(),
        user_zshrc.display(),
        prompt,
    );

    if fs::write(zdotdir.join(".zshenv"), zshenv_content).is_err() {
        return None;
    }
    if fs::write(zdotdir.join(".zshrc"), zshrc_content).is_err() {
        return None;
    }
    Some(zdotdir)
}

#[derive(Default)]
struct TerminalUtf8Decoder {
    pending: Vec<u8>,
}

impl TerminalUtf8Decoder {
    fn push(&mut self, bytes: &[u8]) -> String {
        if bytes.is_empty() {
            return String::new();
        }
        let mut input = if self.pending.is_empty() {
            bytes.to_vec()
        } else {
            self.pending.extend_from_slice(bytes);
            std::mem::take(&mut self.pending)
        };

        let mut output = String::new();
        loop {
            match str::from_utf8(&input) {
                Ok(text) => {
                    output.push_str(text);
                    return output;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    output.push_str(&String::from_utf8_lossy(&input[..valid_up_to]));
                    let tail = &input[valid_up_to..];
                    let Some(error_len) = error.error_len() else {
                        self.pending.extend_from_slice(tail);
                        return output;
                    };
                    let invalid_end = error_len.min(tail.len());
                    output.push_str(&String::from_utf8_lossy(&tail[..invalid_end]));
                    input = tail[invalid_end..].to_vec();
                    if input.is_empty() {
                        return output;
                    }
                }
            }
        }
    }

    fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            return String::new();
        }
        String::from_utf8_lossy(&std::mem::take(&mut self.pending)).to_string()
    }
}

struct ShellSpec {
    label: String,
    command: String,
    args: Vec<String>,
}

fn resolve_shell(shell: Option<String>) -> Result<ShellSpec, String> {
    let requested = shell
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "default".to_string());

    if cfg!(windows) {
        let powershell_args = vec![
            "-NoLogo".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
        ];
        match requested.as_str() {
            "pwsh" => Ok(ShellSpec {
                label: "PowerShell 7".to_string(),
                command: "pwsh.exe".to_string(),
                args: powershell_args,
            }),
            "powershell" | "default" => Ok(ShellSpec {
                label: "PowerShell".to_string(),
                command: "powershell.exe".to_string(),
                args: powershell_args,
            }),
            "cmd" => Ok(ShellSpec {
                label: "Cmd".to_string(),
                command: "cmd.exe".to_string(),
                args: Vec::new(),
            }),
            other => Err(format!("unsupported Windows terminal shell: {other}")),
        }
    } else {
        let command = std::env::var("SHELL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty() && Path::new(value).is_absolute())
            .or_else(resolve_unix_shell_fallback)
            .ok_or_else(|| "failed to resolve login shell".to_string())?;
        let label = Path::new(&command)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("shell")
            .to_string();
        Ok(ShellSpec {
            label,
            args: unix_shell_args(&command),
            command,
        })
    }
}

fn unix_shell_args(command: &str) -> Vec<String> {
    if is_zsh_shell(command) {
        return vec!["-o".to_string(), "NO_PROMPT_SP".to_string()];
    }
    Vec::new()
}

fn is_zsh_shell(command: &str) -> bool {
    Path::new(command)
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("zsh"))
        .unwrap_or(false)
}

fn resolve_unix_shell_fallback() -> Option<String> {
    let candidates: &[&str] = if cfg!(target_os = "macos") {
        &["/bin/zsh", "/bin/bash", "/bin/sh"]
    } else {
        &["/bin/bash", "/bin/zsh", "/bin/sh"]
    };
    candidates
        .iter()
        .find(|candidate| Path::new(candidate).exists())
        .map(|value| (*value).to_string())
}

pub fn terminal_shell_options() -> TerminalShellOptionsResponse {
    if cfg!(windows) {
        let mut options = vec![
            TerminalShellOption {
                id: "powershell".to_string(),
                label: "PowerShell".to_string(),
                command: "powershell.exe".to_string(),
            },
            TerminalShellOption {
                id: "cmd".to_string(),
                label: "Cmd".to_string(),
                command: "cmd.exe".to_string(),
            },
        ];
        if is_program_on_path("pwsh.exe") {
            options.insert(
                0,
                TerminalShellOption {
                    id: "pwsh".to_string(),
                    label: "PowerShell 7".to_string(),
                    command: "pwsh.exe".to_string(),
                },
            );
        }
        TerminalShellOptionsResponse {
            default_shell: "powershell".to_string(),
            options,
        }
    } else {
        let shell = resolve_shell(None).unwrap_or_else(|_| ShellSpec {
            label: "sh".to_string(),
            command: "/bin/sh".to_string(),
            args: Vec::new(),
        });
        TerminalShellOptionsResponse {
            default_shell: "default".to_string(),
            options: vec![TerminalShellOption {
                id: "default".to_string(),
                label: shell.label,
                command: shell.command,
            }],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_options_include_default() {
        let options = terminal_shell_options();
        assert!(!options.default_shell.trim().is_empty());
        assert!(!options.options.is_empty());
    }

    #[test]
    fn output_tail_respects_byte_limit_inside_large_chunk() {
        let mut output = TerminalOutputBuffer::default();
        output.append("prefix".to_string());
        output.append("abcdefghijklmnopqrstuvwxyz".to_string());

        let tail = read_output_chunks_tail(&output, 8);

        assert_eq!(tail.output, "stuvwxyz");
        assert_eq!(tail.output_start_offset, 24);
        assert_eq!(tail.output_end_offset, 32);
        assert!(tail.truncated);
    }

    #[test]
    fn output_tail_keeps_offsets_for_repeated_text() {
        let mut output = TerminalOutputBuffer::default();
        output.append("uploads\n".to_string());
        output.append("uploads\n".to_string());

        let tail = read_output_chunks_tail(&output, MAX_TAIL_BYTES);

        assert_eq!(tail.output, "uploads\nuploads\n");
        assert_eq!(tail.output_start_offset, 0);
        assert_eq!(tail.output_end_offset, 16);
        assert!(!tail.truncated);
    }

    #[test]
    fn terminal_utf8_decoder_preserves_split_multibyte_character() {
        let mut decoder = TerminalUtf8Decoder::default();

        assert_eq!(decoder.push(&[0xe4, 0xb8]), "");
        assert_eq!(decoder.push(&[0xad]), "中");
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn ssh_auth_result_detects_keyboard_interactive_continuation() {
        let mut methods = russh::MethodSet::empty();
        methods.push(MethodKind::KeyboardInteractive);
        assert!(auth_result_can_continue_with_kbi(
            &client::AuthResult::Failure {
                remaining_methods: methods,
                partial_success: false,
            }
        ));

        let mut password_only = russh::MethodSet::empty();
        password_only.push(MethodKind::Password);
        assert!(!auth_result_can_continue_with_kbi(
            &client::AuthResult::Failure {
                remaining_methods: password_only,
                partial_success: false,
            },
        ));
        assert!(!auth_result_can_continue_with_kbi(
            &client::AuthResult::Success
        ));
    }

    #[test]
    fn ssh_password_kbi_prompt_classification_uses_saved_password_once() {
        let prompts = vec![client::Prompt {
            prompt: "Password:".to_string(),
            echo: false,
        }];
        assert_eq!(
            classify_password_kbi_prompts(&prompts, false),
            PasswordKbiPromptAction::SendPassword
        );
        assert_eq!(
            classify_password_kbi_prompts(&prompts, true),
            PasswordKbiPromptAction::PromptUser
        );
        assert_eq!(
            classify_password_kbi_prompts(&[], false),
            PasswordKbiPromptAction::RespondEmpty
        );
        assert_eq!(
            classify_password_kbi_prompts(
                &[client::Prompt {
                    prompt: "OTP:".to_string(),
                    echo: false,
                }],
                false,
            ),
            PasswordKbiPromptAction::PromptUser
        );
    }

    #[test]
    fn ssh_keyboard_interactive_message_combines_server_fields() {
        let message = ssh_keyboard_interactive_message(&KeyboardInteractivePromptData {
            name: "Verification".to_string(),
            instructions: "Enter code".to_string(),
            prompt: "OTP:".to_string(),
            echo: false,
        });

        assert_eq!(message, "Verification\nEnter code\nOTP:");
    }

    #[test]
    fn terminal_shell_env_scrubs_npm_prefix() {
        let mut command = CommandBuilder::new("/bin/sh");
        command.env("npm_config_prefix", "/tmp/npm-prefix");
        command.env("NPM_CONFIG_PREFIX", "/tmp/npm-prefix");
        command.env("TERM", "dumb");

        configure_terminal_shell_env(&mut command, "/bin/sh");

        assert!(command.get_env("npm_config_prefix").is_none());
        assert!(command.get_env("NPM_CONFIG_PREFIX").is_none());
        assert_eq!(
            command.get_env("TERM").and_then(|value| value.to_str()),
            Some("xterm-256color")
        );
        assert_eq!(
            command
                .get_env("COLORTERM")
                .and_then(|value| value.to_str()),
            Some("truecolor")
        );
        assert!(command.get_env("PROMPT_EOL_MARK").is_none());
    }

    #[test]
    fn zsh_terminal_shell_disables_prompt_sp() {
        assert_eq!(
            unix_shell_args("/bin/zsh"),
            vec!["-o".to_string(), "NO_PROMPT_SP".to_string()]
        );
        assert!(unix_shell_args("/bin/bash").is_empty());
    }

    #[test]
    fn registry_creates_lists_renames_and_closes_session() {
        let registry = Arc::new(TerminalSessionRegistry::default());
        let tempdir = tempfile::tempdir().expect("tempdir");
        let cwd = tempdir.path().display().to_string();

        let created = registry
            .create(
                cwd.clone(),
                Some(cwd.clone()),
                None,
                Some("Test Terminal".to_string()),
                Some(80),
                Some(24),
            )
            .expect("create terminal session");
        assert!(created.session.running);
        assert_eq!(created.session.title, "Test Terminal");

        let listed = registry.list(Some(cwd.clone())).sessions;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.session.id);

        let resized = registry
            .resize(created.session.id.clone(), 100, 30)
            .expect("resize terminal session");
        assert_eq!(resized.cols, 100);
        assert_eq!(resized.rows, 30);

        let renamed = registry
            .rename(created.session.id.clone(), "Renamed Terminal".to_string())
            .expect("rename terminal session");
        assert_eq!(renamed.title, "Renamed Terminal");

        let closed = registry
            .close(created.session.id.clone())
            .expect("close terminal session");
        assert!(!closed.running);
        assert!(registry.list(Some(cwd)).sessions.is_empty());
    }

    #[test]
    fn registry_closes_project_sessions() {
        let registry = Arc::new(TerminalSessionRegistry::default());
        let project_a = tempfile::tempdir().expect("project a");
        let project_b = tempfile::tempdir().expect("project b");
        let cwd_a = project_a.path().display().to_string();
        let cwd_b = project_b.path().display().to_string();

        registry
            .create(
                cwd_a.clone(),
                Some(cwd_a.clone()),
                None,
                Some("A".to_string()),
                Some(80),
                Some(24),
            )
            .expect("create project a terminal");
        registry
            .create(
                cwd_b.clone(),
                Some(cwd_b.clone()),
                None,
                Some("B".to_string()),
                Some(80),
                Some(24),
            )
            .expect("create project b terminal");
        assert_eq!(registry.running_session_count(), 2);

        let closed = registry
            .close_project(cwd_a.clone())
            .expect("close project a terminals");
        assert_eq!(closed.sessions.len(), 1);
        assert!(registry.list(Some(cwd_a)).sessions.is_empty());
        assert_eq!(registry.list(Some(cwd_b)).sessions.len(), 1);

        registry.close_all().expect("close remaining terminals");
        assert_eq!(registry.running_session_count(), 0);
    }

    #[test]
    fn read_tail_requires_terminal_id_when_project_has_multiple_sessions() {
        let registry = Arc::new(TerminalSessionRegistry::default());
        let tempdir = tempfile::tempdir().expect("tempdir");
        let cwd = tempdir.path().display().to_string();

        let first = registry
            .create(
                cwd.clone(),
                Some(cwd.clone()),
                None,
                Some("First".to_string()),
                Some(80),
                Some(24),
            )
            .expect("create first terminal session");
        registry
            .create(
                cwd.clone(),
                Some(cwd.clone()),
                None,
                Some("Second".to_string()),
                Some(80),
                Some(24),
            )
            .expect("create second terminal session");

        let ambiguous = registry
            .read_tail(cwd.clone(), None, Some(1024))
            .expect("read ambiguous terminal tail");
        assert_eq!(ambiguous.sessions.len(), 2);
        assert!(ambiguous.selected_session.is_none());
        assert!(ambiguous.output.is_empty());

        let selected = registry
            .read_tail(cwd, Some(first.session.id), Some(1024))
            .expect("read selected terminal tail");
        assert!(selected.selected_session.is_some());
        assert_eq!(selected.sessions.len(), 2);

        registry.close_all().expect("close terminal sessions");
    }
}
