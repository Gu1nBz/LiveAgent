use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::{
    io::Read,
    process::{Command, Stdio},
};

use rusqlite::{params, Connection, OptionalExtension};

use super::{
    types::{
        NativeImageAdapterPublic, NativeImageAdapterSpec, NativeImageConfig,
        NativeImageEndpointMode,
    },
    validate_adapter_spec, validate_config_update,
};
use crate::services::native_image::types::{NativeImageConfigPublic, NativeImageConfigUpdate};

const CONFIG_ID: &str = "default";

pub(crate) struct NativeImageConfigStore {
    db_path: PathBuf,
}

impl NativeImageConfigStore {
    pub(crate) fn app_default() -> Result<Self, String> {
        let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
        let config_dir = home.join(format!(".{}", env!("CARGO_PKG_NAME")));
        fs::create_dir_all(&config_dir)
            .map_err(|error| format!("创建 LiveAgent 配置目录失败：{error}"))?;
        secure_directory_permissions(&config_dir)?;
        let store = Self::open(config_dir.join("config.sqlite"))?;
        // One-time, non-destructive upgrade path from the previously bundled
        // api2img CLI. Migration only runs before a native row exists and never
        // exposes the imported key through a public response.
        if let Err(error) = store.migrate_legacy_api2img_if_empty(&home) {
            eprintln!("failed to migrate legacy api2img configuration: {error}");
        }
        Ok(store)
    }

    pub(crate) fn open(db_path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("创建图片服务配置目录失败：{error}"))?;
        }
        let store = Self { db_path };
        let conn = store.connection()?;
        initialize_schema(&conn)?;
        drop(conn);
        secure_file_permissions(&store.db_path)?;
        Ok(store)
    }

    fn connection(&self) -> Result<Connection, String> {
        let conn = Connection::open(&self.db_path)
            .map_err(|error| format!("打开 LiveAgent 图片服务配置失败：{error}"))?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|error| format!("设置图片服务配置 busy_timeout 失败：{error}"))?;
        initialize_schema(&conn)?;
        Ok(conn)
    }

    pub(crate) fn load(&self) -> Result<NativeImageConfig, String> {
        let conn = self.connection()?;
        let row = conn
            .query_row(
                "SELECT base_url, api_key, generation_model, edit_model, endpoint_mode, timeout_seconds, adapter_json
                 FROM native_image_settings WHERE config_id = ?1",
                [CONFIG_ID],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, Option<String>>(6)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("读取 LiveAgent 图片服务配置失败：{error}"))?;

        let Some((
            base_url,
            api_key,
            generation_model,
            edit_model,
            endpoint_mode,
            timeout,
            adapter_json,
        )) = row
        else {
            return Ok(NativeImageConfig::default());
        };
        Ok(NativeImageConfig {
            base_url,
            api_key,
            generation_model,
            edit_model,
            endpoint_mode: NativeImageEndpointMode::from_db_str(&endpoint_mode),
            timeout_seconds: u64::try_from(timeout).unwrap_or_default().clamp(10, 600),
            adapter: adapter_json
                .as_deref()
                .map(serde_json::from_str::<NativeImageAdapterSpec>)
                .transpose()
                .map_err(|error| format!("读取 AI 图片协议配置失败：{error}"))?,
        })
    }

    pub(crate) fn update(
        &self,
        update: NativeImageConfigUpdate,
    ) -> Result<NativeImageConfigPublic, String> {
        let mut config = self.load()?;
        validate_config_update(&update)?;

        config.base_url = super::normalize_base_url(&update.base_url)?;
        if let Some(model) = update.generation_model {
            config.generation_model = model.trim().to_string();
        }
        if let Some(model) = update.edit_model {
            config.edit_model = model.trim().to_string();
        }
        if let Some(mode) = update.endpoint_mode {
            config.endpoint_mode = mode;
        }
        if let Some(timeout) = update.timeout_seconds {
            config.timeout_seconds = timeout;
        }
        if update.clear_api_key {
            config.api_key.clear();
        } else if let Some(api_key) = update.api_key_update {
            let api_key = api_key.trim();
            if !api_key.is_empty() {
                config.api_key = api_key.to_string();
            }
        }

        self.write_config(&config)?;
        Ok(config.public())
    }

    pub(crate) fn adapter_get(&self) -> Result<NativeImageAdapterPublic, String> {
        let adapter = self.load()?.adapter;
        Ok(NativeImageAdapterPublic {
            configured: adapter.is_some(),
            adapter,
        })
    }

    pub(crate) fn adapter_save(
        &self,
        adapter: NativeImageAdapterSpec,
    ) -> Result<NativeImageAdapterPublic, String> {
        validate_adapter_spec(&adapter)?;
        let mut config = self.load()?;
        config.adapter = Some(adapter);
        self.write_config(&config)?;
        self.adapter_get()
    }

    pub(crate) fn adapter_clear(&self) -> Result<NativeImageAdapterPublic, String> {
        let mut config = self.load()?;
        config.adapter = None;
        self.write_config(&config)?;
        self.adapter_get()
    }

    pub(crate) fn clear(&self) -> Result<NativeImageConfigPublic, String> {
        let config = NativeImageConfig::default();
        self.write_config(&config)?;
        Ok(config.public())
    }

    fn write_config(&self, config: &NativeImageConfig) -> Result<(), String> {
        let adapter_json = config
            .adapter
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| format!("序列化 AI 图片协议配置失败：{error}"))?;
        let conn = self.connection()?;
        conn.execute(
            "INSERT INTO native_image_settings (
                config_id, base_url, api_key, generation_model, edit_model,
                endpoint_mode, timeout_seconds, adapter_json, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, strftime('%s','now') * 1000)
             ON CONFLICT(config_id) DO UPDATE SET
                base_url = excluded.base_url,
                api_key = excluded.api_key,
                generation_model = excluded.generation_model,
                edit_model = excluded.edit_model,
                endpoint_mode = excluded.endpoint_mode,
                timeout_seconds = excluded.timeout_seconds,
                adapter_json = excluded.adapter_json,
                updated_at = excluded.updated_at",
            params![
                CONFIG_ID,
                config.base_url,
                config.api_key,
                config.generation_model,
                config.edit_model,
                config.endpoint_mode.as_db_str(),
                i64::try_from(config.timeout_seconds).unwrap_or(180),
                adapter_json,
            ],
        )
        .map_err(|error| format!("保存 LiveAgent 图片服务配置失败：{error}"))?;
        secure_file_permissions(&self.db_path)?;
        Ok(())
    }

    fn migrate_legacy_api2img_if_empty(&self, home: &Path) -> Result<(), String> {
        let conn = self.connection()?;
        let exists = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM native_image_settings WHERE config_id = ?1)",
                [CONFIG_ID],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| format!("检查旧 api2img 迁移状态失败：{error}"))?;
        drop(conn);
        if exists {
            return Ok(());
        }

        let legacy_dir = home.join(".api2img");
        let config_value = read_small_json(&legacy_dir.join("config.json"));
        let base_url = config_value
            .as_ref()
            .and_then(|value| value.get("baseUrl"))
            .and_then(serde_json::Value::as_str)
            .and_then(|value| super::normalize_base_url(value).ok());
        let file_key = read_small_json(&legacy_dir.join("secret.json"))
            .as_ref()
            .and_then(|value| value.get("apiKey"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let api_key = legacy_platform_secret().or(file_key).and_then(|key| {
            let key = key.trim();
            if super::validate_api_key(key).is_err() {
                None
            } else {
                Some(key.to_string())
            }
        });
        if base_url.is_none() && api_key.is_none() {
            return Ok(());
        }
        let defaults = NativeImageConfig::default();
        self.update(NativeImageConfigUpdate {
            base_url: base_url.unwrap_or(defaults.base_url),
            generation_model: None,
            edit_model: None,
            endpoint_mode: None,
            timeout_seconds: None,
            api_key_update: api_key,
            clear_api_key: false,
        })?;
        Ok(())
    }
}

fn read_small_json(path: &Path) -> Option<serde_json::Value> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 64 * 1024 {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(target_os = "macos")]
fn legacy_platform_secret() -> Option<String> {
    command_secret(
        "/usr/bin/security",
        &[
            "find-generic-password",
            "-a",
            "default",
            "-s",
            "api2img",
            "-w",
        ],
    )
}

#[cfg(target_os = "linux")]
fn legacy_platform_secret() -> Option<String> {
    command_secret(
        "secret-tool",
        &["lookup", "service", "api2img", "account", "default"],
    )
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn legacy_platform_secret() -> Option<String> {
    None
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn command_secret(program: &str, args: &[&str]) -> Option<String> {
    use wait_timeout::ChildExt;

    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let status = match child.wait_timeout(Duration::from_secs(2)).ok()? {
        Some(status) => status,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    if !status.success() {
        return None;
    }
    let mut bytes = Vec::new();
    child
        .stdout
        .take()?
        .take(16 * 1024)
        .read_to_end(&mut bytes)
        .ok()?;
    String::from_utf8(bytes)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn initialize_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS native_image_settings (
            config_id TEXT PRIMARY KEY,
            base_url TEXT NOT NULL,
            api_key TEXT NOT NULL,
            generation_model TEXT NOT NULL,
            edit_model TEXT NOT NULL,
            endpoint_mode TEXT NOT NULL,
            timeout_seconds INTEGER NOT NULL,
            adapter_json TEXT,
            updated_at INTEGER NOT NULL
        );",
    )
    .map_err(|error| format!("初始化 LiveAgent 图片服务配置失败：{error}"))?;
    let mut statement = conn
        .prepare("PRAGMA table_info(native_image_settings)")
        .map_err(|error| format!("检查图片服务配置字段失败：{error}"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("读取图片服务配置字段失败：{error}"))?;
    let mut has_adapter_json = false;
    for column in columns {
        if column.map_err(|error| format!("读取图片服务配置字段失败：{error}"))? == "adapter_json"
        {
            has_adapter_json = true;
            break;
        }
    }
    drop(statement);
    if !has_adapter_json {
        conn.execute(
            "ALTER TABLE native_image_settings ADD COLUMN adapter_json TEXT",
            [],
        )
        .map_err(|error| format!("升级 AI 图片协议配置字段失败：{error}"))?;
    }
    Ok(())
}

#[cfg(unix)]
fn secure_directory_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("设置图片服务配置目录权限失败：{error}"))
}

#[cfg(not(unix))]
fn secure_directory_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn secure_file_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("设置图片服务配置文件权限失败：{error}"))
}

#[cfg(not(unix))]
fn secure_file_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}
