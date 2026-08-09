mod db;
mod mail;
mod models;
mod proxy;

use chrono::{DateTime, Duration, Local, NaiveDateTime, TimeZone, Utc};
use models::{
    AiConfigInput, AiConfigView, CompanyImportRow, MailAttachment, MailMessage, MailboxConfig,
    SyncResult, TaskInput, TaskSummary,
};
use rusqlite::{Connection, OptionalExtension};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::State;

pub struct AppState {
    pub database: Arc<Mutex<Connection>>,
    pub syncs: Arc<Mutex<HashMap<String, SyncProgress>>>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub run_id: String,
    pub status: String,
    pub total: u32,
    pub processed: u32,
    pub received: u32,
    pub duplicates: u32,
    pub errors: Vec<String>,
    pub message: String,
}

#[tauri::command]
fn mailbox_test(config: MailboxConfig) -> Result<String, String> {
    if config.host.trim().is_empty() || config.username.trim().is_empty() {
        return Err("服务器地址和收件账号不能为空".to_string());
    }
    if !matches!(config.protocol.to_uppercase().as_str(), "IMAP" | "POP3") {
        return Err("仅支持 IMAP 和 POP3".to_string());
    }
    if config.port == 0 {
        return Err("端口必须大于 0".to_string());
    }
    Ok("配置有效；真实邮箱连接将在适配器启用后执行".to_string())
}

#[tauri::command]
fn mailbox_credentials_save(
    username: String,
    password: String,
    proxy_username: String,
    proxy_password: String,
) -> Result<(), String> {
    let username = username.trim();
    if username.is_empty() {
        return Err("收件账号不能为空".to_string());
    }
    let mailbox_entry = keyring::Entry::new("com.unigather.app", &format!("mailbox:{username}"))
        .map_err(|error| error.to_string())?;
    if password.trim().is_empty() {
        let _ = mailbox_entry.delete_credential();
    } else {
        mailbox_entry
            .set_password(password.trim())
            .map_err(|error| error.to_string())?;
    }
    let proxy_entry = keyring::Entry::new("com.unigather.app", &format!("proxy:{username}"))
        .map_err(|error| error.to_string())?;
    if proxy_password.trim().is_empty() {
        let _ = proxy_entry.delete_credential();
    } else {
        proxy_entry
            .set_password(proxy_password.trim())
            .map_err(|error| error.to_string())?;
    }
    let _ = proxy_username;
    Ok(())
}

#[tauri::command]
fn task_create(input: TaskInput, state: State<'_, AppState>) -> Result<TaskSummary, String> {
    let id = format!("task-{}", chrono_like_id());
    let name = input.name.clone();
    let deadline = input.deadline.clone();
    let company_count = input.company_ids.len() as u32;
    let connection = state.database.lock().map_err(|e| e.to_string())?;
    connection
        .execute(
            "INSERT INTO tasks (id,name,status,start_time,deadline,poll_minutes,save_directory,filename_template,subject_keywords,body_keywords,ai_enabled,created_at) VALUES (?1,?2,'active',?3,?4,?5,?6,?7,?8,?9,?10,datetime('now'))",
            rusqlite::params![id, name, input.start_time, deadline, input.poll_minutes, input.save_directory, input.filename_template, serde_json::to_string(&input.subject_keywords).map_err(|e| e.to_string())?, serde_json::to_string(&input.body_keywords).map_err(|e| e.to_string())?, input.ai_enabled],
        )
        .map_err(|e| e.to_string())?;
    for company_id in &input.company_ids {
        connection
            .execute(
                "INSERT OR IGNORE INTO task_companies (task_id,company_id) VALUES (?1,?2)",
                rusqlite::params![id, company_id],
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(TaskSummary {
        id,
        name,
        status: "active".into(),
        total_companies: company_count,
        confirmed_companies: 0,
        deadline,
        start_time: input.start_time,
        poll_minutes: input.poll_minutes,
        save_directory: input.save_directory,
        subject_keywords: input.subject_keywords,
        body_keywords: input.body_keywords,
        ai_enabled: input.ai_enabled,
    })
}

#[tauri::command]
fn task_delete(task_id: String, state: State<'_, AppState>) -> Result<(), String> {
    if task_id.trim().is_empty() {
        return Err("任务编号不能为空".to_string());
    }
    let connection = state.database.lock().map_err(|e| e.to_string())?;
    connection
        .execute(
            "DELETE FROM tasks WHERE id = ?1",
            rusqlite::params![task_id],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn task_update(
    task_id: String,
    input: TaskInput,
    state: State<'_, AppState>,
) -> Result<TaskSummary, String> {
    if task_id.trim().is_empty() {
        return Err("任务编号不能为空".to_string());
    }
    let subject_keywords =
        serde_json::to_string(&input.subject_keywords).map_err(|e| e.to_string())?;
    let body_keywords = serde_json::to_string(&input.body_keywords).map_err(|e| e.to_string())?;
    let connection = state.database.lock().map_err(|e| e.to_string())?;
    let status: String = connection
        .query_row(
            "SELECT status FROM tasks WHERE id=?1",
            rusqlite::params![task_id],
            |row| row.get(0),
        )
        .map_err(|_| "任务不存在或已被删除".to_string())?;
    let changed = connection
        .execute(
            "UPDATE tasks SET name=?1,start_time=?2,deadline=?3,poll_minutes=?4,save_directory=?5,filename_template=?6,subject_keywords=?7,body_keywords=?8,ai_enabled=?9 WHERE id=?10",
            rusqlite::params![input.name, input.start_time, input.deadline, input.poll_minutes, input.save_directory, input.filename_template, subject_keywords, body_keywords, input.ai_enabled, task_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("任务不存在或已被删除".to_string());
    }
    let total_companies = connection
        .query_row(
            "SELECT COUNT(*) FROM task_companies WHERE task_id=?1",
            rusqlite::params![task_id],
            |row| row.get::<_, u32>(0),
        )
        .unwrap_or(0);
    let confirmed_companies = connection
        .query_row(
            "SELECT COUNT(*) FROM task_companies WHERE task_id=?1 AND feedback_status='confirmed'",
            rusqlite::params![task_id],
            |row| row.get::<_, u32>(0),
        )
        .unwrap_or(0);
    Ok(TaskSummary {
        id: task_id,
        name: input.name,
        status,
        total_companies,
        confirmed_companies,
        deadline: input.deadline,
        start_time: input.start_time,
        poll_minutes: input.poll_minutes,
        save_directory: input.save_directory,
        subject_keywords: input.subject_keywords,
        body_keywords: input.body_keywords,
        ai_enabled: input.ai_enabled,
    })
}

#[tauri::command]
fn task_list(state: State<'_, AppState>) -> Result<Vec<TaskSummary>, String> {
    let connection = state.database.lock().map_err(|e| e.to_string())?;
    let mut statement = connection
        .prepare("SELECT id,name,status,deadline,start_time,poll_minutes,save_directory,subject_keywords,body_keywords,ai_enabled,(SELECT COUNT(*) FROM task_companies WHERE task_id=tasks.id),(SELECT COUNT(*) FROM task_companies WHERE task_id=tasks.id AND feedback_status='confirmed') FROM tasks ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let subject_keywords = row
                .get::<_, String>(7)
                .ok()
                .and_then(|value| serde_json::from_str(&value).ok())
                .unwrap_or_default();
            let body_keywords = row
                .get::<_, String>(8)
                .ok()
                .and_then(|value| serde_json::from_str(&value).ok())
                .unwrap_or_default();
            Ok(TaskSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                status: row.get(2)?,
                deadline: row.get(3)?,
                start_time: row.get(4)?,
                poll_minutes: row.get(5)?,
                save_directory: row.get(6)?,
                subject_keywords,
                body_keywords,
                ai_enabled: row.get::<_, i64>(9)? != 0,
                total_companies: row.get(10)?,
                confirmed_companies: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.map(|row| row.map_err(|e| e.to_string())).collect()
}

fn load_mailbox_credentials(mut mailbox: MailboxConfig) -> MailboxConfig {
    if mailbox.password.trim().is_empty() {
        if let Ok(entry) = keyring::Entry::new(
            "com.unigather.app",
            &format!("mailbox:{}", mailbox.username.trim()),
        ) {
            mailbox.password = entry.get_password().unwrap_or_default();
        }
    }
    if mailbox.proxy_password.trim().is_empty() {
        if let Ok(entry) = keyring::Entry::new(
            "com.unigather.app",
            &format!("proxy:{}", mailbox.username.trim()),
        ) {
            mailbox.proxy_password = entry.get_password().unwrap_or_default();
        }
    }
    mailbox
}

fn update_sync_progress<F>(
    syncs: &Arc<Mutex<HashMap<String, SyncProgress>>>,
    run_id: &str,
    update: F,
) where
    F: FnOnce(&mut SyncProgress),
{
    if let Ok(mut runs) = syncs.lock() {
        if let Some(progress) = runs.get_mut(run_id) {
            update(progress);
        }
    }
}

#[tauri::command]
fn sync_start(
    task_id: String,
    mailbox: MailboxConfig,
    since: String,
    state: State<'_, AppState>,
) -> Result<SyncProgress, String> {
    let mailbox = load_mailbox_credentials(mailbox);
    let start_time = parse_sync_start(&since)?;
    let run_id = format!("sync-{}", chrono_like_id());
    let initial = SyncProgress {
        run_id: run_id.clone(),
        status: "running".into(),
        total: 0,
        processed: 0,
        received: 0,
        duplicates: 0,
        errors: Vec::new(),
        message: "正在连接邮箱…".into(),
    };
    state
        .syncs
        .lock()
        .map_err(|e| e.to_string())?
        .insert(run_id.clone(), initial.clone());
    let database = Arc::clone(&state.database);
    let syncs = Arc::clone(&state.syncs);
    std::thread::spawn(move || {
        if let Err(error) = run_sync_job(
            task_id,
            mailbox,
            start_time,
            run_id.clone(),
            database,
            Arc::clone(&syncs),
        ) {
            update_sync_progress(&syncs, &run_id, |progress| {
                progress.status = "failed".into();
                progress.message = error.clone();
                progress.errors.push(error);
            });
        }
    });
    Ok(initial)
}

#[tauri::command]
fn sync_status(run_id: String, state: State<'_, AppState>) -> Result<Option<SyncProgress>, String> {
    state
        .syncs
        .lock()
        .map_err(|e| e.to_string())
        .map(|runs| runs.get(run_id.trim()).cloned())
}

fn run_sync_job(
    task_id: String,
    mailbox: MailboxConfig,
    start_time: DateTime<Utc>,
    run_id: String,
    database: Arc<Mutex<Connection>>,
    syncs: Arc<Mutex<HashMap<String, SyncProgress>>>,
) -> Result<(), String> {
    update_sync_progress(&syncs, &run_id, |progress| {
        progress.message = "正在读取邮箱邮件…".into()
    });
    let (sender, receiver) = std::sync::mpsc::channel();
    let fetch_mailbox = mailbox.clone();
    let fetch_thread = std::thread::spawn(move || {
        mail::fetch_messages_streaming(&fetch_mailbox, start_time, |raw| {
            sender.send(raw).map_err(|_| "收件任务已停止".to_string())
        })
    });
    let mailbox_id = format!("{}@{}", mailbox.username.trim(), mailbox.host.trim());
    let save_directory = archive_directory(&task_id, &database)?;
    let mut received = 0u32;
    let mut duplicates = 0u32;
    let mut errors = Vec::new();
    let mut message_index = 0usize;
    while let Ok(raw) = receiver.recv() {
        let parsed = match mail::parse_message(&raw.raw, raw.external_id.clone()) {
            Ok(message) => message,
            Err(error) => {
                errors.push(error);
                let errors_snapshot = errors.clone();
                update_sync_progress(&syncs, &run_id, |progress| {
                    progress.processed += 1;
                    progress.errors = errors_snapshot;
                    progress.message = format!("第 {} 封邮件解析失败", progress.processed);
                });
                message_index += 1;
                continue;
            }
        };
        let message_id = format!("mail-{}-{}", chrono_like_id(), message_index);
        let inserted = {
            let connection = database.lock().map_err(|e| e.to_string())?;
            connection
                .execute(
                    "INSERT OR IGNORE INTO messages (id,mailbox_id,external_id,sender,recipients,cc,subject,body,received_at,content_hash) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                    rusqlite::params![message_id, mailbox_id, parsed.external_id, parsed.sender, parsed.recipients, parsed.cc, parsed.subject, parsed.body, parsed.received_at, parsed.content_hash],
                )
                .map_err(|e| e.to_string())?
        };
        if inserted == 0 {
            duplicates += 1;
        } else {
            received += 1;
            let connection = database.lock().map_err(|e| e.to_string())?;
            for (attachment_index, attachment) in parsed.attachments.into_iter().enumerate() {
                let saved_path =
                    match mail::write_attachment(&save_directory, &message_id, &attachment) {
                        Ok(path) => path,
                        Err(error) => {
                            errors.push(error);
                            String::new()
                        }
                    };
                connection
                    .execute(
                        "INSERT INTO attachments (id,message_id,original_name,saved_name,saved_path,mime_type,parse_status) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                        rusqlite::params![format!("attachment-{}-{}-{}", chrono_like_id(), message_index, attachment_index), message_id, attachment.name, attachment.name, saved_path, attachment.mime_type, if saved_path.is_empty() { "error" } else { "archive_only" }],
                    )
                    .map_err(|e| e.to_string())?;
            }
        }
        let errors_snapshot = errors.clone();
        update_sync_progress(&syncs, &run_id, |progress| {
            progress.processed += 1;
            progress.received = received;
            progress.duplicates = duplicates;
            progress.errors = errors_snapshot;
            progress.message = format!("已保存第 {} 封邮件", progress.processed);
        });
        message_index += 1;
    }
    match fetch_thread.join() {
        Ok(result) => result?,
        Err(_) => return Err("收件线程异常中断".to_string()),
    }
    update_sync_progress(&syncs, &run_id, |progress| {
        progress.status = "completed".into();
        progress.total = progress.processed;
        progress.received = received;
        progress.duplicates = duplicates;
        progress.errors = errors;
        progress.message = format!("收件完成：新增 {} 封，重复 {} 封", received, duplicates);
    });
    Ok(())
}

fn parse_sync_start(value: &str) -> Result<DateTime<Utc>, String> {
    if value.trim().is_empty() {
        return Ok(Utc::now() - Duration::days(7));
    }
    if let Ok(date) = DateTime::parse_from_rfc3339(value) {
        return Ok(date.with_timezone(&Utc));
    }
    let naive = NaiveDateTime::parse_from_str(value.trim(), "%Y-%m-%dT%H:%M")
        .map_err(|_| "收件起始时间格式无效".to_string())?;
    Local
        .from_local_datetime(&naive)
        .single()
        .map(|date| date.with_timezone(&Utc))
        .ok_or_else(|| "收件起始时间无法转换".to_string())
}

fn archive_directory(
    task_id: &str,
    database: &Arc<Mutex<Connection>>,
) -> Result<std::path::PathBuf, String> {
    let connection = database.lock().map_err(|e| e.to_string())?;
    if !task_id.trim().is_empty() {
        if let Ok(path) = connection.query_row(
            "SELECT save_directory FROM tasks WHERE id = ?1",
            rusqlite::params![task_id],
            |row| row.get::<_, String>(0),
        ) {
            if !path.trim().is_empty() {
                return Ok(std::path::PathBuf::from(path));
            }
        }
    }
    let path: Option<String> = connection
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'material_save_path'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(std::path::PathBuf::from(
        path.filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "D:\\UniGather\\Materials".to_string()),
    ))
}

#[tauri::command]
fn company_import(rows: Vec<CompanyImportRow>, state: State<'_, AppState>) -> Result<u32, String> {
    let connection = state.database.lock().map_err(|e| e.to_string())?;
    let mut imported = 0u32;
    for (index, row) in rows.iter().enumerate() {
        let name = row.company_name.trim();
        let email = row.email.trim();
        if name.is_empty() {
            continue;
        }
        let company_id = connection
            .query_row(
                "SELECT id FROM companies WHERE name = ?1 LIMIT 1",
                rusqlite::params![name],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_else(|_| format!("company-{}-{}", chrono_like_id(), index));
        connection
            .execute(
                "INSERT OR IGNORE INTO companies (id,name,aliases,created_at) VALUES (?1,?2,'[]',datetime('now'))",
                rusqlite::params![company_id, name],
            )
            .map_err(|e| e.to_string())?;
        if email.is_empty() {
            continue;
        }
        connection
            .execute(
                "INSERT INTO company_contacts (id,company_id,email,contact_name,created_at) VALUES (?1,?2,?3,?4,datetime('now')) ON CONFLICT(email) DO UPDATE SET company_id=excluded.company_id, contact_name=excluded.contact_name",
                rusqlite::params![format!("contact-{}-{}", chrono_like_id(), index), company_id, email, row.contact_name.trim()],
            )
            .map_err(|e| e.to_string())?;
        imported += 1;
    }
    Ok(imported)
}

#[tauri::command]
fn sync_history(_task_id: Option<String>) -> Result<Vec<SyncResult>, String> {
    Ok(Vec::new())
}

#[tauri::command]
fn mail_list(state: State<'_, AppState>) -> Result<Vec<MailMessage>, String> {
    let connection = state.database.lock().map_err(|e| e.to_string())?;
    let mut statement = connection
        .prepare("SELECT id,sender,recipients,cc,subject,body,received_at FROM messages ORDER BY received_at DESC")
        .map_err(|e| e.to_string())?;
    let mut messages: Vec<MailMessage> = statement
        .query_map([], |row| {
            Ok(MailMessage {
                id: row.get(0)?,
                sender: row.get(1)?,
                recipients: row.get(2)?,
                cc: row.get(3)?,
                subject: row.get(4)?,
                body: row.get(5)?,
                received_at: row.get(6)?,
                attachments: Vec::new(),
            })
        })
        .map_err(|e| e.to_string())?
        .map(|row| row.map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for message in &mut messages {
        let mut attachment_statement = connection
            .prepare("SELECT original_name,COALESCE(mime_type,''),COALESCE(saved_path,''),parse_status FROM attachments WHERE message_id = ?1 ORDER BY original_name")
            .map_err(|e| e.to_string())?;
        message.attachments = attachment_statement
            .query_map(rusqlite::params![message.id], |row| {
                Ok(MailAttachment {
                    original_name: row.get(0)?,
                    mime_type: row.get(1)?,
                    saved_path: row.get(2)?,
                    parse_status: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .map(|row| row.map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
    }
    Ok(messages)
}

#[tauri::command]
fn match_resolve(
    _match_id: String,
    _decision: String,
    _task_id: Option<String>,
    _company_id: Option<String>,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn material_open(path: String) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("材料路径不能为空".to_string());
    }
    let target = std::path::PathBuf::from(path.trim());
    if !target.exists() {
        return Err("材料文件不存在，可能已被移动或删除".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        let result = if target.is_dir() {
            std::process::Command::new("explorer.exe")
                .arg(&target)
                .status()
        } else {
            std::process::Command::new("cmd")
                .args(["/C", "start", ""])
                .arg(&target)
                .status()
        };
        result
            .map_err(|error| format!("打开材料失败：{error}"))?
            .success()
            .then_some(path)
            .ok_or_else(|| "Windows 未能打开材料".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = target;
        Err("当前平台不支持打开本地材料".to_string())
    }
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let is_github_url = url.starts_with("https://github.com/")
        || url.starts_with("https://githubusercontent.com/")
        || url.starts_with("https://release-assets.githubusercontent.com/");
    if !is_github_url {
        return Err("仅允许打开 GitHub 下载地址".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", ""])
            .arg(&url)
            .status()
            .map_err(|error| format!("打开浏览器失败：{error}"))?
            .success()
            .then_some(())
            .ok_or_else(|| "Windows 未能打开浏览器".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = url;
        Err("当前平台不支持打开外部下载地址".to_string())
    }
}

#[tauri::command]
fn report_export(_task_id: String, _status: String) -> Result<String, String> {
    Ok("待反馈清单导出接口已就绪".to_string())
}

#[tauri::command]
fn settings_update(key: String, value: String, state: State<'_, AppState>) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("设置键不能为空".to_string());
    }
    let connection = state.database.lock().map_err(|e| e.to_string())?;
    connection
        .execute(
            "INSERT INTO app_settings (key,value,updated_at) VALUES (?1,?2,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            rusqlite::params![key, value],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn settings_get(key: String, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let connection = state.database.lock().map_err(|e| e.to_string())?;
    connection
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            rusqlite::params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn ai_config_save(config: AiConfigInput, state: State<'_, AppState>) -> Result<(), String> {
    let connection = state.database.lock().map_err(|e| e.to_string())?;
    for (key, value) in [
        ("ai_enabled", config.enabled.to_string()),
        ("ai_endpoint", config.endpoint.clone()),
        ("ai_model", config.model.clone()),
    ] {
        connection
            .execute(
                "INSERT INTO app_settings (key,value,updated_at) VALUES (?1,?2,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                rusqlite::params![key, value],
            )
            .map_err(|e| e.to_string())?;
    }
    drop(connection);
    let credential =
        keyring::Entry::new("com.unigather.app", "ai_api_key").map_err(|e| e.to_string())?;
    if config.api_key.trim().is_empty() {
        let _ = credential.delete_credential();
    } else {
        credential
            .set_password(config.api_key.trim())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn ai_config_get(state: State<'_, AppState>) -> Result<AiConfigView, String> {
    let connection = state.database.lock().map_err(|e| e.to_string())?;
    let read_setting = |key: &str, default: &str| -> Result<String, String> {
        Ok(connection
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                rusqlite::params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| default.to_string()))
    };
    let enabled = read_setting("ai_enabled", "false")? == "true";
    let endpoint = read_setting("ai_endpoint", "https://api.openai.com/v1")?;
    let model = read_setting("ai_model", "gpt-4o-mini")?;
    drop(connection);
    let api_key_present = keyring::Entry::new("com.unigather.app", "ai_api_key")
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .is_some();
    Ok(AiConfigView {
        enabled,
        endpoint,
        model,
        api_key_present,
    })
}

fn chrono_like_id() -> String {
    format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    )
}

pub fn run() {
    let connection = Connection::open("unigather.db").expect("open local database");
    db::initialize(&connection).expect("initialize local database");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            database: Arc::new(Mutex::new(connection)),
            syncs: Arc::new(Mutex::new(HashMap::new())),
        })
        .invoke_handler(tauri::generate_handler![
            mailbox_test,
            mailbox_credentials_save,
            task_create,
            task_update,
            task_delete,
            task_list,
            sync_start,
            sync_status,
            company_import,
            sync_history,
            mail_list,
            match_resolve,
            material_open,
            open_external_url,
            report_export,
            settings_update,
            settings_get,
            ai_config_save,
            ai_config_get
        ])
        .run(tauri::generate_context!())
        .expect("error while running UniGather");
}
