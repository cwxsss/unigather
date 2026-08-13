mod archive;
mod db;
mod mail;
mod models;
mod proxy;
mod send;

use chrono::{DateTime, Duration, Local, NaiveDateTime, TimeZone, Utc};
use models::{
    AiConfigInput, AiConfigView, AttachmentCandidate, CompanyContact, CompanyContactInput,
    CompanyDeleteResult, CompanyImportRow, CompanySummary, ConnectionTestResult, DashboardEvent,
    DashboardSummary, MailAttachment, MailMessage, MailboxConfig, MailboxTestReport,
    SendBatchInput, SendBatchItemInput, SendBatchSummary, SendHistoryDetail, SendHistoryItem,
    SendHistoryRun, SendInput, SyncResult, TaskFeedbackCompany, TaskFeedbackPage, TaskInput,
    TaskMatchAttachment, TaskMatchDetail, TaskMatchMessage, TaskSummary, TaskSyncRunSummary,
};
use rusqlite::{Connection, OptionalExtension};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::State;

use send::{valid_email, SendAttachment, SendTarget, SmtpClient, SmtpSendConfig};

pub struct AppState {
    pub database: Arc<Mutex<Connection>>,
    pub syncs: Arc<Mutex<HashMap<String, SyncProgress>>>,
    pub sends: Arc<Mutex<HashMap<String, SendProgress>>>,
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
    pub matched: u32,
    pub needs_review: u32,
    pub errors: Vec<String>,
    pub message: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendProgress {
    pub run_id: String,
    pub status: String,
    pub total: u32,
    pub processed: u32,
    pub success: u32,
    pub failure: u32,
    pub current_company: String,
    pub message: String,
    pub errors: Vec<String>,
}

#[tauri::command]
fn mailbox_test(config: MailboxConfig) -> Result<MailboxTestReport, String> {
    let config = load_mailbox_credentials(config);
    let incoming_started = std::time::Instant::now();
    let incoming_result = mail::test_connection(&config);
    let incoming = ConnectionTestResult {
        status: if incoming_result.is_ok() {
            "success"
        } else {
            "error"
        }
        .to_string(),
        message: incoming_result
            .err()
            .unwrap_or_else(|| "收件服务器连接和认证成功".to_string()),
        elapsed_ms: incoming_started.elapsed().as_millis() as u64,
    };
    let outgoing = if config.smtp_host.trim().is_empty() || config.smtp_port == 0 {
        ConnectionTestResult {
            status: "not_configured".into(),
            message: "尚未配置 SMTP 服务器".into(),
            elapsed_ms: 0,
        }
    } else {
        let started = std::time::Instant::now();
        let result = SmtpClient::connect(SmtpSendConfig {
            host: config.smtp_host.clone(),
            port: config.smtp_port,
            encryption: config.smtp_encryption.clone(),
            username: config.username.clone(),
            password: config.password.clone(),
            sender_name: config.smtp_sender_name.clone(),
            proxy_url: config.proxy_url.clone(),
            proxy_username: config.proxy_username.clone(),
            proxy_password: config.proxy_password.clone(),
        })
        .map(|mut client| client.close());
        ConnectionTestResult {
            status: if result.is_ok() { "success" } else { "error" }.to_string(),
            message: result
                .err()
                .unwrap_or_else(|| "发件服务器连接和认证成功".to_string()),
            elapsed_ms: started.elapsed().as_millis() as u64,
        }
    };
    Ok(MailboxTestReport { incoming, outgoing })
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
    if !password.trim().is_empty() {
        mailbox_entry
            .set_password(password.trim())
            .map_err(|error| error.to_string())?;
    }
    let proxy_entry = keyring::Entry::new("com.unigather.app", &format!("proxy:{username}"))
        .map_err(|error| error.to_string())?;
    if !proxy_password.trim().is_empty() {
        proxy_entry
            .set_password(proxy_password.trim())
            .map_err(|error| error.to_string())?;
    }
    let _ = proxy_username;
    Ok(())
}

#[tauri::command]
fn mailbox_credentials_status(username: String) -> Result<bool, String> {
    let username = username.trim();
    if username.is_empty() {
        return Ok(false);
    }
    let entry = keyring::Entry::new("com.unigather.app", &format!("mailbox:{username}"))
        .map_err(|error| error.to_string())?;
    Ok(entry
        .get_password()
        .map(|password| !password.trim().is_empty())
        .unwrap_or(false))
}

#[tauri::command]
fn mailbox_credentials_clear(username: String) -> Result<(), String> {
    let username = username.trim();
    if username.is_empty() {
        return Err("收件账号不能为空".to_string());
    }
    for key in [format!("mailbox:{username}"), format!("proxy:{username}")] {
        let entry =
            keyring::Entry::new("com.unigather.app", &key).map_err(|error| error.to_string())?;
        let _ = entry.delete_credential();
    }
    Ok(())
}

#[tauri::command]
fn mailbox_config_save(config: MailboxConfig, state: State<'_, AppState>) -> Result<(), String> {
    if config.username.trim().is_empty() || config.host.trim().is_empty() {
        return Err("收件服务器和账号不能为空".to_string());
    }
    let mut safe = config;
    safe.password.clear();
    safe.proxy_password.clear();
    let json = serde_json::to_string(&safe).map_err(|error| error.to_string())?;
    let connection = state.database.lock().map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO app_settings (key,value,updated_at) VALUES ('mailbox.config',?1,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
            rusqlite::params![json],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn mailbox_config_get(state: State<'_, AppState>) -> Result<Option<MailboxConfig>, String> {
    let connection = state.database.lock().map_err(|error| error.to_string())?;
    let value: Option<String> = connection
        .query_row(
            "SELECT value FROM app_settings WHERE key='mailbox.config'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    value
        .map(|json| serde_json::from_str(&json).map_err(|error| error.to_string()))
        .transpose()
}

fn supported_send_extension(path: &std::path::Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "pdf"
            | "doc"
            | "docx"
            | "xls"
            | "xlsx"
            | "csv"
            | "txt"
            | "png"
            | "jpg"
            | "jpeg"
            | "bmp"
            | "tif"
            | "tiff"
    )
}

fn scan_send_directory(
    root: &std::path::Path,
    current: &std::path::Path,
    recursive: bool,
    items: &mut Vec<AttachmentCandidate>,
) -> Result<(), String> {
    for entry in std::fs::read_dir(current).map_err(|error| format!("读取材料目录失败：{error}"))?
    {
        let entry = entry.map_err(|error| format!("读取材料目录项失败：{error}"))?;
        let path = entry.path();
        let metadata = entry
            .metadata()
            .map_err(|error| format!("读取材料属性失败：{error}"))?;
        if metadata.is_dir() && recursive {
            scan_send_directory(root, &path, recursive, items)?;
        } else if metadata.is_file() && supported_send_extension(&path) {
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string();
            items.push(AttachmentCandidate {
                id: next_unique_id("file"),
                name,
                path: path.to_string_lossy().to_string(),
                relative_path: relative,
                size: metadata.len(),
            });
        }
    }
    Ok(())
}

static UNIQUE_ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn next_unique_id(prefix: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = UNIQUE_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{nanos}-{sequence}")
}

#[tauri::command]
fn send_batch_scan(
    source_dir: String,
    recursive: bool,
) -> Result<Vec<AttachmentCandidate>, String> {
    let root = PathBuf::from(source_dir.trim());
    if !root.is_dir() {
        return Err("材料目录不存在或不是目录".to_string());
    }
    let mut items = Vec::new();
    scan_send_directory(&root, &root, recursive, &mut items)?;
    items.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(items)
}

fn send_batch_summary(connection: &Connection, id: &str) -> Result<SendBatchSummary, String> {
    connection
        .query_row(
            "SELECT b.id,b.name,b.source_dir,b.recursive,b.subject,b.body,b.signature,b.cc,b.status,b.created_at,b.updated_at,(SELECT COUNT(*) FROM send_batch_items i WHERE i.batch_id=b.id),(SELECT COALESCE((SELECT id FROM send_runs r WHERE r.batch_id=b.id ORDER BY r.started_at DESC LIMIT 1),'')),(SELECT COALESCE((SELECT COUNT(*) FROM send_items si JOIN send_runs sr ON sr.id=si.run_id WHERE sr.batch_id=b.id AND si.status IN ('failure','failed')),0)) FROM send_batches b WHERE b.id=?1",
            rusqlite::params![id],
            |row| {
                let cc_json: String = row.get(7)?;
                Ok(SendBatchSummary {
                    id: row.get(0)?, name: row.get(1)?, source_dir: row.get(2)?, recursive: row.get::<_, i64>(3)? != 0,
                    subject: row.get(4)?, body: row.get(5)?, signature: row.get(6)?, cc: serde_json::from_str(&cc_json).unwrap_or_default(),
                    status: row.get(8)?, created_at: row.get(9)?, updated_at: row.get(10)?, item_count: row.get::<_, u32>(11)?, last_run_id: row.get(12)?, failed_count: row.get(13)?,
                })
            },
        )
        .map_err(|error| format!("发送批次不存在：{error}"))
}

#[tauri::command]
fn send_batch_create(
    input: SendBatchInput,
    state: State<'_, AppState>,
) -> Result<SendBatchSummary, String> {
    if input.name.trim().is_empty() || input.source_dir.trim().is_empty() {
        return Err("发送批次名称和材料目录不能为空".to_string());
    }
    let id = next_unique_id("send-batch");
    let connection = state.database.lock().map_err(|error| error.to_string())?;
    connection.execute(
        "INSERT INTO send_batches (id,name,source_dir,recursive,subject,body,signature,cc,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'draft',datetime('now'),datetime('now'))",
        rusqlite::params![id, input.name.trim(), input.source_dir.trim(), input.recursive, input.subject, input.body, input.signature, serde_json::to_string(&input.cc).map_err(|error| error.to_string())?],
    ).map_err(|error| error.to_string())?;
    send_batch_summary(&connection, &id)
}

fn insert_send_batch_items(
    transaction: &rusqlite::Transaction<'_>,
    batch_id: &str,
    items: &[SendBatchItemInput],
) -> Result<(), String> {
    transaction
        .execute(
            "DELETE FROM send_batch_items WHERE batch_id=?1",
            rusqlite::params![batch_id],
        )
        .map_err(|error| error.to_string())?;
    for item in items {
        transaction.execute(
            "INSERT INTO send_batch_items (id,batch_id,file_name,file_path,company_id,company_name,recipients,match_method,confidence,status,error) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            rusqlite::params![item.id, batch_id, item.file_name, item.file_path, item.company_id, item.company_name, serde_json::to_string(&item.recipients).map_err(|error| error.to_string())?, item.match_method, item.confidence, item.status, item.error],
        ).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn replace_send_batch_items(
    connection: &mut Connection,
    batch_id: &str,
    items: &[SendBatchItemInput],
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    insert_send_batch_items(&transaction, batch_id, items)?;
    transaction
        .execute(
            "UPDATE send_batches SET status='ready',updated_at=datetime('now') WHERE id=?1",
            rusqlite::params![batch_id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn send_batch_match(
    batch_id: String,
    items: Vec<SendBatchItemInput>,
    state: State<'_, AppState>,
) -> Result<SendBatchSummary, String> {
    let mut connection = state.database.lock().map_err(|error| error.to_string())?;
    replace_send_batch_items(&mut connection, &batch_id, &items)?;
    send_batch_summary(&connection, &batch_id)
}

#[tauri::command]
fn send_batch_save(
    batch_id: String,
    input: SendBatchInput,
    items: Vec<SendBatchItemInput>,
    state: State<'_, AppState>,
) -> Result<SendBatchSummary, String> {
    if input.name.trim().is_empty() || input.source_dir.trim().is_empty() {
        return Err("发送批次名称和材料目录不能为空".to_string());
    }
    let id = if batch_id.trim().is_empty() {
        next_unique_id("send-batch")
    } else {
        batch_id
    };
    let mut connection = state.database.lock().map_err(|error| error.to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction.execute(
        "INSERT INTO send_batches (id,name,source_dir,recursive,subject,body,signature,cc,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'draft',datetime('now'),datetime('now')) ON CONFLICT(id) DO UPDATE SET name=excluded.name,source_dir=excluded.source_dir,recursive=excluded.recursive,subject=excluded.subject,body=excluded.body,signature=excluded.signature,cc=excluded.cc,status='draft',updated_at=datetime('now')",
        rusqlite::params![id, input.name.trim(), input.source_dir.trim(), input.recursive, input.subject, input.body, input.signature, serde_json::to_string(&input.cc).map_err(|error| error.to_string())?],
    ).map_err(|error| error.to_string())?;
    insert_send_batch_items(&transaction, &id, &items)?;
    transaction
        .execute(
            "UPDATE send_batches SET status='ready',updated_at=datetime('now') WHERE id=?1",
            rusqlite::params![id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    send_batch_summary(&connection, &id)
}

#[tauri::command]
fn send_batch_items(
    batch_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<SendBatchItemInput>, String> {
    let connection = state.database.lock().map_err(|error| error.to_string())?;
    let mut statement = connection.prepare("SELECT id,file_name,file_path,company_id,company_name,recipients,match_method,confidence,status,error FROM send_batch_items WHERE batch_id=?1 ORDER BY file_name").map_err(|error| error.to_string())?;
    let items = statement
        .query_map(rusqlite::params![batch_id], |row| {
            let recipients_json: String = row.get(5)?;
            Ok(SendBatchItemInput {
                id: row.get(0)?,
                file_name: row.get(1)?,
                file_path: row.get(2)?,
                company_id: row.get(3)?,
                company_name: row.get(4)?,
                recipients: serde_json::from_str(&recipients_json).unwrap_or_default(),
                match_method: row.get(6)?,
                confidence: row.get(7)?,
                status: row.get(8)?,
                error: row.get(9)?,
            })
        })
        .map_err(|error| error.to_string())?
        .map(|row| row.map_err(|error| error.to_string()))
        .collect();
    items
}

#[tauri::command]
fn send_batch_resolve(
    batch_id: String,
    item_id: String,
    company_id: Option<String>,
    decision: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let connection = state.database.lock().map_err(|error| error.to_string())?;
    let (company_name, recipients) = if let Some(company_id) = company_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        let name: String = connection
            .query_row(
                "SELECT name FROM companies WHERE id=?1",
                rusqlite::params![company_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let emails: Vec<String> = connection
            .prepare("SELECT email FROM company_contacts WHERE company_id=?1 ORDER BY email")
            .map_err(|error| error.to_string())?
            .query_map(rusqlite::params![company_id], |row| row.get(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|error| error.to_string())?;
        (name, emails)
    } else {
        (String::new(), Vec::new())
    };
    connection.execute("UPDATE send_batch_items SET company_id=?1,company_name=?2,recipients=?3,status=?4,match_method='manual',confidence=1,error='' WHERE batch_id=?5 AND id=?6", rusqlite::params![company_id.unwrap_or_default(), company_name, serde_json::to_string(&recipients).map_err(|error| error.to_string())?, decision, batch_id, item_id]).map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE send_batches SET updated_at=datetime('now') WHERE id=?1",
            rusqlite::params![batch_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn send_history(state: State<'_, AppState>) -> Result<Vec<SendBatchSummary>, String> {
    let connection = state.database.lock().map_err(|error| error.to_string())?;
    let ids: Vec<String> = connection
        .prepare("SELECT id FROM send_batches ORDER BY updated_at DESC")
        .map_err(|error| error.to_string())?
        .query_map([], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|error| error.to_string())?;
    ids.iter()
        .map(|id| send_batch_summary(&connection, id))
        .collect()
}

fn load_send_history_detail(
    connection: &Connection,
    batch_id: &str,
) -> Result<SendHistoryDetail, String> {
    let batch = send_batch_summary(connection, batch_id)?;
    let mut run_statement = connection.prepare(
        "SELECT id,mode,started_at,COALESCE(finished_at,''),status,total,processed,success_count,failure_count,COALESCE(error,'') FROM send_runs WHERE batch_id=?1 ORDER BY started_at DESC",
    ).map_err(|error| error.to_string())?;
    let raw_runs: Vec<(
        String,
        String,
        String,
        String,
        String,
        u32,
        u32,
        u32,
        u32,
        String,
    )> = run_statement
        .query_map(rusqlite::params![batch_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(run_statement);
    let mut runs = Vec::new();
    for (
        id,
        mode,
        started_at,
        finished_at,
        status,
        total,
        processed,
        success_count,
        failure_count,
        error,
    ) in raw_runs
    {
        let mut item_statement = connection.prepare(
            "SELECT company_name,recipients,attachments,status,COALESCE(error,''),COALESCE(sent_at,'') FROM send_items WHERE run_id=?1 ORDER BY company_name,id",
        ).map_err(|query_error| query_error.to_string())?;
        let items = item_statement
            .query_map(rusqlite::params![id], |row| {
                let recipients: String = row.get(1)?;
                let attachments: String = row.get(2)?;
                Ok(SendHistoryItem {
                    company_name: row.get(0)?,
                    recipients: serde_json::from_str(&recipients).unwrap_or_default(),
                    attachments: serde_json::from_str(&attachments).unwrap_or_default(),
                    status: row.get(3)?,
                    error: row.get(4)?,
                    sent_at: row.get(5)?,
                })
            })
            .map_err(|query_error| query_error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|query_error| query_error.to_string())?;
        runs.push(SendHistoryRun {
            id,
            mode,
            started_at,
            finished_at,
            status,
            total,
            processed,
            success_count,
            failure_count,
            error,
            items,
        });
    }
    Ok(SendHistoryDetail { batch, runs })
}

#[tauri::command]
fn send_history_detail(
    batch_id: String,
    state: State<'_, AppState>,
) -> Result<SendHistoryDetail, String> {
    let connection = state.database.lock().map_err(|error| error.to_string())?;
    load_send_history_detail(&connection, batch_id.trim())
}

#[tauri::command]
fn mail_signature_get(state: State<'_, AppState>) -> Result<String, String> {
    let connection = state.database.lock().map_err(|error| error.to_string())?;
    connection
        .query_row(
            "SELECT value FROM app_settings WHERE key='mail.signature'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
        .map(|value| value.unwrap_or_else(|| "中国联通总部数据安全工作组".to_string()))
}

#[tauri::command]
fn mail_signature_save(signature: String, state: State<'_, AppState>) -> Result<(), String> {
    let value = if signature.trim().is_empty() {
        "中国联通总部数据安全工作组"
    } else {
        signature.trim()
    };
    let connection = state.database.lock().map_err(|error| error.to_string())?;
    connection.execute("INSERT INTO app_settings (key,value,updated_at) VALUES ('mail.signature',?1,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", rusqlite::params![value]).map_err(|error| error.to_string())?;
    Ok(())
}

fn load_task_match_detail(
    connection: &Connection,
    task_id: &str,
) -> Result<TaskMatchDetail, String> {
    let latest_run = connection.query_row(
        "SELECT id,status,started_at,COALESCE(finished_at,''),processed,received,duplicates,matched,needs_review,COALESCE(error,'') FROM sync_runs WHERE task_id=?1 ORDER BY started_at DESC LIMIT 1",
        rusqlite::params![task_id],
        |row| Ok(TaskSyncRunSummary { id: row.get(0)?, status: row.get(1)?, started_at: row.get(2)?, finished_at: row.get(3)?, processed: row.get(4)?, received: row.get(5)?, duplicates: row.get(6)?, matched: row.get(7)?, needs_review: row.get(8)?, error: row.get(9)? }),
    ).optional().map_err(|error| error.to_string())?;
    let mut statement = connection.prepare(
        "SELECT m.id,msg.sender,msg.subject,msg.received_at,m.status,m.reason,COALESCE(c.name,''),msg.id FROM matches m JOIN messages msg ON msg.id=m.message_id LEFT JOIN companies c ON c.id=m.company_id WHERE m.task_id=?1 ORDER BY msg.received_at DESC",
    ).map_err(|error| error.to_string())?;
    let raw: Vec<(
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
    )> = statement
        .query_map(rusqlite::params![task_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    let mut messages = Vec::new();
    for (id, sender, subject, received_at, status, reason, company_name, message_id) in raw {
        let attachments = connection
            .prepare(
                "SELECT id,original_name,COALESCE(saved_path,''),parse_status FROM attachments WHERE message_id=?1 ORDER BY original_name",
            )
            .map_err(|error| error.to_string())?
            .query_map(rusqlite::params![message_id], |row| {
                let saved_path: String = row.get(2)?;
                Ok(TaskMatchAttachment {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    can_open: !saved_path.is_empty() && std::path::Path::new(&saved_path).exists(),
                    saved_path,
                    parse_status: row.get(3)?,
                })
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<TaskMatchAttachment>, _>>()
            .map_err(|error| error.to_string())?;
        messages.push(TaskMatchMessage {
            id,
            message_id,
            sender,
            subject,
            received_at,
            status,
            reason,
            company_name,
            attachments,
        });
    }
    let total_messages = connection
        .query_row(
            "SELECT COUNT(*) FROM messages msg JOIN tasks t ON t.id=?1 WHERE (COALESCE(t.start_time,'')='' OR datetime(msg.received_at)>=datetime(t.start_time)) AND (COALESCE(t.deadline,'')='' OR datetime(msg.received_at)<=datetime(t.deadline))",
            rusqlite::params![task_id],
            |row| row.get::<_, u32>(0),
        )
        .unwrap_or(messages.len() as u32)
        .max(messages.len() as u32);
    Ok(TaskMatchDetail {
        task_id: task_id.to_string(),
        matched: messages
            .iter()
            .filter(|item| item.status == "confirmed")
            .count() as u32,
        needs_review: messages
            .iter()
            .filter(|item| item.status == "needs_review")
            .count() as u32,
        unmatched: messages
            .iter()
            .filter(|item| item.status == "unmatched")
            .count() as u32,
        processed_messages: messages.len() as u32,
        total_messages,
        latest_run,
        messages,
    })
}

fn load_task_feedback_page(
    connection: &Connection,
    task_id: &str,
    status_filter: &str,
    requested_page: u32,
    requested_page_size: u32,
) -> Result<TaskFeedbackPage, String> {
    let page_size = match requested_page_size {
        10 | 20 | 31 | 40 | 50 => requested_page_size,
        _ => 20,
    };
    let status_filter = match status_filter {
        "confirmed" | "needs_review" | "unmatched" => status_filter,
        _ => "all",
    };
    let filter_sql = if status_filter == "all" {
        ""
    } else {
        " AND m.status=?2"
    };
    let total: u32 = if status_filter == "all" {
        connection.query_row(
            "SELECT COUNT(*) FROM matches m WHERE m.task_id=?1",
            rusqlite::params![task_id],
            |row| row.get(0),
        )
    } else {
        connection.query_row(
            &format!("SELECT COUNT(*) FROM matches m WHERE m.task_id=?1{filter_sql}"),
            rusqlite::params![task_id, status_filter],
            |row| row.get(0),
        )
    }
    .map_err(|error| error.to_string())?;
    let page_count = if total == 0 {
        1
    } else {
        total.div_ceil(page_size)
    };
    let page = requested_page.max(1).min(page_count);
    let offset = (page - 1) * page_size;
    let paging_sql = if status_filter == "all" {
        " LIMIT ?2 OFFSET ?3"
    } else {
        " LIMIT ?3 OFFSET ?4"
    };
    let query = format!("SELECT m.id,msg.sender,msg.subject,msg.received_at,m.status,m.reason,COALESCE(c.name,''),msg.id FROM matches m JOIN messages msg ON msg.id=m.message_id LEFT JOIN companies c ON c.id=m.company_id WHERE m.task_id=?1{filter_sql} ORDER BY msg.received_at DESC{paging_sql}");
    let mut statement = connection
        .prepare(&query)
        .map_err(|error| error.to_string())?;
    let raw: Vec<(
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
    )> = if status_filter == "all" {
        statement
            .query_map(rusqlite::params![task_id, page_size, offset], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    } else {
        statement
            .query_map(
                rusqlite::params![task_id, status_filter, page_size, offset],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ))
                },
            )
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    drop(statement);
    let mut messages = Vec::with_capacity(raw.len());
    for (id, sender, subject, received_at, status, reason, company_name, message_id) in raw {
        let attachments = connection.prepare("SELECT id,original_name,COALESCE(saved_path,''),parse_status FROM attachments WHERE message_id=?1 ORDER BY original_name")
            .map_err(|error| error.to_string())?
            .query_map(rusqlite::params![message_id], |row| {
                let saved_path: String = row.get(2)?;
                Ok(TaskMatchAttachment { id: row.get(0)?, name: row.get(1)?, can_open: !saved_path.is_empty() && std::path::Path::new(&saved_path).exists(), saved_path, parse_status: row.get(3)? })
            }).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        messages.push(TaskMatchMessage {
            id,
            message_id,
            sender,
            subject,
            received_at,
            status,
            reason,
            company_name,
            attachments,
        });
    }
    let count_status = |status: &str| -> Result<u32, String> {
        connection
            .query_row(
                "SELECT COUNT(*) FROM matches WHERE task_id=?1 AND status=?2",
                rusqlite::params![task_id, status],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
    };
    Ok(TaskFeedbackPage {
        task_id: task_id.to_string(),
        messages,
        total,
        page,
        page_count,
        page_size,
        matched: count_status("confirmed")?,
        needs_review: count_status("needs_review")?,
        unmatched: count_status("unmatched")?,
    })
}

#[tauri::command]
fn task_feedback_page(
    task_id: String,
    status_filter: String,
    page: u32,
    page_size: u32,
    state: State<'_, AppState>,
) -> Result<TaskFeedbackPage, String> {
    let connection = state.database.lock().map_err(|error| error.to_string())?;
    load_task_feedback_page(
        &connection,
        task_id.trim(),
        status_filter.trim(),
        page,
        page_size,
    )
}

#[tauri::command]
fn task_match_detail(
    task_id: String,
    state: State<'_, AppState>,
) -> Result<TaskMatchDetail, String> {
    let connection = state.database.lock().map_err(|error| error.to_string())?;
    load_task_match_detail(&connection, task_id.trim())
}

fn load_task_pending_companies(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<TaskFeedbackCompany>, String> {
    let company_rows: Vec<(String, String, String)> = connection
        .prepare("SELECT c.id,c.name,tc.feedback_status FROM task_companies tc JOIN companies c ON c.id=tc.company_id WHERE tc.task_id=?1 AND tc.feedback_status<>'confirmed' ORDER BY CASE tc.feedback_status WHEN 'pending' THEN 0 ELSE 1 END,c.name COLLATE NOCASE")
        .map_err(|error| error.to_string())?
        .query_map(rusqlite::params![task_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    company_rows
        .into_iter()
        .map(|(company_id, company_name, feedback_status)| {
            let contacts = connection
                .prepare("SELECT id,contact_name,email,phone FROM company_contacts WHERE company_id=?1 ORDER BY contact_name,email")
                .map_err(|error| error.to_string())?
                .query_map(rusqlite::params![company_id], |row| Ok(CompanyContact { id: row.get(0)?, contact_name: row.get(1)?, email: row.get(2)?, phone: row.get(3)? }))
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<CompanyContact>, _>>()
                .map_err(|error| error.to_string())?;
            Ok(TaskFeedbackCompany { company_id, company_name, feedback_status, contacts })
        })
        .collect()
}

#[tauri::command]
fn task_pending_companies(
    task_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<TaskFeedbackCompany>, String> {
    let connection = state.database.lock().map_err(|error| error.to_string())?;
    load_task_pending_companies(&connection, task_id.trim())
}

fn load_send_targets(
    connection: &Connection,
    input: &SendInput,
) -> Result<Vec<SendTarget>, String> {
    if !input.batch_id.trim().is_empty() {
        return load_batch_send_targets(connection, input);
    }
    let mut targets = Vec::new();
    for company_id in &input.company_ids {
        let company_name = connection
            .query_row(
                "SELECT name FROM companies WHERE id=?1",
                rusqlite::params![company_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("发送单位不存在：{company_id}"))?;
        let mut recipients = Vec::new();
        let mut contacts = connection
            .prepare("SELECT email FROM company_contacts WHERE company_id=?1 ORDER BY email")
            .map_err(|error| error.to_string())?;
        for row in contacts
            .query_map(rusqlite::params![company_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
        {
            let email = row
                .map_err(|error| error.to_string())?
                .trim()
                .to_ascii_lowercase();
            if !email.is_empty() && !recipients.contains(&email) {
                if !valid_email(&email) {
                    continue;
                }
                recipients.push(email);
            }
        }
        let mut attachments = Vec::new();
        if input.include_attachments {
            let mut statement = connection
                .prepare(
                    "SELECT DISTINCT a.original_name,a.saved_path FROM matches m JOIN attachments a ON a.message_id=m.message_id WHERE m.task_id=?1 AND m.company_id=?2 AND m.status='confirmed' AND a.saved_path IS NOT NULL AND a.saved_path != ''",
                )
                .map_err(|error| error.to_string())?;
            for row in statement
                .query_map(rusqlite::params![input.task_id, company_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|error| error.to_string())?
            {
                let (name, saved_path) = row.map_err(|error| error.to_string())?;
                let path = PathBuf::from(saved_path);
                if path.is_file() {
                    attachments.push(SendAttachment { name, path });
                }
            }
        }
        targets.push(SendTarget {
            company_id: company_id.clone(),
            company_name,
            recipients,
            attachments,
        });
    }
    Ok(targets)
}

fn load_batch_send_targets(
    connection: &Connection,
    input: &SendInput,
) -> Result<Vec<SendTarget>, String> {
    let mut grouped: HashMap<String, SendTarget> = HashMap::new();
    let mut statement = connection
        .prepare("SELECT company_id,company_name,recipients,file_name,file_path,status FROM send_batch_items WHERE batch_id=?1 AND company_id <> '' AND status NOT IN ('needs_review','unmatched','ignored') ORDER BY company_name,file_name")
        .map_err(|error| error.to_string())?;
    for row in statement
        .query_map(rusqlite::params![input.batch_id], |row| {
            let recipients_json: String = row.get(2)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                serde_json::from_str::<Vec<String>>(&recipients_json).unwrap_or_default(),
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|error| error.to_string())?
    {
        let (company_id, company_name, recipients, file_name, file_path) =
            row.map_err(|error| error.to_string())?;
        let target = grouped
            .entry(company_id.clone())
            .or_insert_with(|| SendTarget {
                company_id: company_id.clone(),
                company_name: company_name.clone(),
                recipients: Vec::new(),
                attachments: Vec::new(),
            });
        for recipient in recipients {
            if valid_email(&recipient) && !target.recipients.contains(&recipient) {
                target.recipients.push(recipient);
            }
        }
        let path = PathBuf::from(&file_path);
        if path.is_file()
            && !target
                .attachments
                .iter()
                .any(|attachment| attachment.path == path)
        {
            target.attachments.push(SendAttachment {
                name: file_name,
                path,
            });
        }
    }
    let mut targets: Vec<SendTarget> = if input.company_ids.is_empty() {
        grouped.into_values().collect()
    } else {
        input
            .company_ids
            .iter()
            .filter_map(|id| grouped.remove(id))
            .collect()
    };
    targets.sort_by(|left, right| left.company_name.cmp(&right.company_name));
    Ok(targets)
}

fn update_send_progress<F>(
    sends: &Arc<Mutex<HashMap<String, SendProgress>>>,
    run_id: &str,
    update: F,
) where
    F: FnOnce(&mut SendProgress),
{
    if let Ok(mut runs) = sends.lock() {
        if let Some(progress) = runs.get_mut(run_id) {
            update(progress);
        }
    }
}

fn update_send_database(
    database: &Arc<Mutex<Connection>>,
    run_id: &str,
    target: &SendTarget,
    status: &str,
    error: Option<&str>,
) {
    if let Ok(connection) = database.lock() {
        let _ = connection.execute(
            "UPDATE send_items SET status=?1,error=?2,sent_at=CASE WHEN ?1='success' THEN datetime('now') ELSE sent_at END WHERE run_id=?3 AND company_id=?4",
            rusqlite::params![status, error, run_id, target.company_id],
        );
    }
}

fn execute_send(
    run_id: String,
    input: SendInput,
    targets: Vec<SendTarget>,
    sends: Arc<Mutex<HashMap<String, SendProgress>>>,
    database: Arc<Mutex<Connection>>,
    password: String,
    proxy_password: String,
    proxy_url: Option<String>,
    proxy_username: String,
) {
    let config = SmtpSendConfig {
        host: input.smtp_host.clone(),
        port: input.smtp_port,
        encryption: input.encryption.clone(),
        username: input.username.clone(),
        password,
        sender_name: input.sender_name.clone(),
        proxy_url,
        proxy_username,
        proxy_password,
    };
    let mut client = match SmtpClient::connect(config) {
        Ok(client) => client,
        Err(error) => {
            update_send_progress(&sends, &run_id, |progress| {
                progress.status = "failed".into();
                progress.message = error.clone();
                progress.errors.push(error.clone());
            });
            if let Ok(connection) = database.lock() {
                let _ = connection.execute(
                    "UPDATE send_runs SET status='failed',finished_at=datetime('now'),error=?1 WHERE id=?2",
                    rusqlite::params![error, run_id],
                );
                let _ = connection.execute(
                    "UPDATE send_items SET status='failed',error=?1 WHERE run_id=?2 AND status='pending'",
                    rusqlite::params!["SMTP 连接失败", run_id],
                );
            }
            return;
        }
    };
    for target in targets {
        update_send_progress(&sends, &run_id, |progress| {
            progress.current_company = target.company_name.clone();
            progress.message = format!("正在发送给 {}", target.company_name);
        });
        match client.send(
            &target,
            &input.cc,
            &input.subject,
            &input.body,
            &input.signature,
        ) {
            Ok(()) => {
                update_send_database(&database, &run_id, &target, "success", None);
                update_send_progress(&sends, &run_id, |progress| {
                    progress.processed += 1;
                    progress.success += 1;
                    progress.message = format!("已发送给 {}", target.company_name);
                });
            }
            Err(error) => {
                update_send_database(&database, &run_id, &target, "failure", Some(&error));
                update_send_progress(&sends, &run_id, |progress| {
                    progress.processed += 1;
                    progress.failure += 1;
                    progress
                        .errors
                        .push(format!("{}：{}", target.company_name, error));
                    progress.message = format!("发送 {} 失败", target.company_name);
                });
            }
        }
    }
    client.close();
    update_send_progress(&sends, &run_id, |progress| {
        progress.status = if progress.failure == 0 {
            "completed"
        } else {
            "completedWithFailures"
        }
        .into();
        progress.current_company.clear();
        progress.message = if progress.failure == 0 {
            "发送完成"
        } else {
            "发送完成，但有失败项"
        }
        .into();
    });
    if let Ok(connection) = database.lock() {
        let _ = connection.execute(
            "UPDATE send_runs SET status=?1,finished_at=datetime('now'),processed=?2,success_count=?3,failure_count=?4 WHERE id=?5",
            rusqlite::params![if read_send_status(&sends, &run_id) == "completed" { "completed" } else { "completed_with_failures" }, progress_value(&sends, &run_id, |progress| progress.processed), progress_value(&sends, &run_id, |progress| progress.success), progress_value(&sends, &run_id, |progress| progress.failure), run_id],
        );
    }
}

fn read_send_status(sends: &Arc<Mutex<HashMap<String, SendProgress>>>, run_id: &str) -> String {
    sends
        .lock()
        .ok()
        .and_then(|runs| runs.get(run_id).map(|progress| progress.status.clone()))
        .unwrap_or_default()
}

fn progress_value<F>(
    sends: &Arc<Mutex<HashMap<String, SendProgress>>>,
    run_id: &str,
    read: F,
) -> u32
where
    F: FnOnce(&SendProgress) -> u32,
{
    sends
        .lock()
        .ok()
        .and_then(|runs| runs.get(run_id).map(read))
        .unwrap_or(0)
}

fn start_send(
    mut input: SendInput,
    mailbox: MailboxConfig,
    state: State<'_, AppState>,
    test_only: bool,
) -> Result<SendProgress, String> {
    let smtp_host = if input.smtp_host.trim().is_empty() {
        mailbox.smtp_host.clone()
    } else {
        input.smtp_host.clone()
    };
    let smtp_port = if input.smtp_port == 0 {
        mailbox.smtp_port
    } else {
        input.smtp_port
    };
    let encryption = if input.encryption.trim().is_empty() {
        mailbox.smtp_encryption.clone()
    } else {
        input.encryption.clone()
    };
    let username = if input.username.trim().is_empty() {
        mailbox.username.clone()
    } else {
        input.username.clone()
    };
    if smtp_host.trim().is_empty() || smtp_port == 0 {
        return Err("请先在邮箱配置中填写 SMTP 服务器和端口".to_string());
    }
    if username.trim().is_empty() {
        return Err("发件邮箱账号不能为空".to_string());
    }
    if !valid_email(&username) {
        return Err("发件邮箱账号格式不正确".to_string());
    }
    if input.subject.trim().is_empty() || input.body.trim().is_empty() {
        return Err("邮件主题和正文不能为空".to_string());
    }
    let mut credential_mailbox = mailbox.clone();
    credential_mailbox.username = username.clone();
    let credential_mailbox = load_mailbox_credentials(credential_mailbox);
    if credential_mailbox.password.trim().is_empty() {
        return Err("发件账号尚未保存密码，请在邮箱配置中保存该账号密码".to_string());
    }
    let connection = state.database.lock().map_err(|error| error.to_string())?;
    let mut targets = load_send_targets(&connection, &input)?;
    drop(connection);
    if test_only {
        if input.test_recipient.trim().is_empty() {
            return Err("测试发送邮箱不能为空".to_string());
        }
        if !valid_email(&input.test_recipient) {
            return Err("测试发送邮箱格式不正确".to_string());
        }
        if let Some(first) = targets.first_mut() {
            first.recipients = vec![input.test_recipient.trim().to_ascii_lowercase()];
            targets.truncate(1);
        }
    }
    if targets.is_empty() {
        return Err("请至少选择一家发送单位".to_string());
    }
    if targets.iter().any(|target| target.recipients.is_empty()) {
        let missing = targets
            .iter()
            .find(|target| target.recipients.is_empty())
            .map(|target| target.company_name.clone())
            .unwrap_or_default();
        return Err(format!("单位“{missing}”没有有效收件邮箱"));
    }
    let run_id = format!("send-{}", chrono_like_id());
    let initial = SendProgress {
        run_id: run_id.clone(),
        status: "running".into(),
        total: targets.len() as u32,
        processed: 0,
        success: 0,
        failure: 0,
        current_company: String::new(),
        message: if test_only {
            "正在发送测试邮件…".into()
        } else {
            "正在准备发送…".into()
        },
        errors: Vec::new(),
    };
    state
        .sends
        .lock()
        .map_err(|error| error.to_string())?
        .insert(run_id.clone(), initial.clone());
    let connection = state.database.lock().map_err(|error| error.to_string())?;
    connection.execute("INSERT INTO send_runs (id,task_id,batch_id,mode,started_at,status,total) VALUES (?1,?2,?3,?4,datetime('now'),'running',?5)", rusqlite::params![run_id, input.task_id, if input.batch_id.trim().is_empty() { None::<String> } else { Some(input.batch_id.clone()) }, if test_only { "test" } else { "formal" }, targets.len() as u32]).map_err(|error| error.to_string())?;
    for (index, target) in targets.iter().enumerate() {
        connection.execute("INSERT INTO send_items (id,run_id,company_id,company_name,recipients,attachments) VALUES (?1,?2,?3,?4,?5,?6)", rusqlite::params![format!("send-item-{}-{}", chrono_like_id(), index), initial.run_id, target.company_id, target.company_name, serde_json::to_string(&target.recipients).map_err(|error| error.to_string())?, serde_json::to_string(&target.attachments.iter().map(|attachment| attachment.name.clone()).collect::<Vec<_>>()).map_err(|error| error.to_string())?]).map_err(|error| error.to_string())?;
    }
    drop(connection);
    let sends = state.sends.clone();
    let database = state.database.clone();
    let proxy_url = mailbox.proxy_url.clone();
    let proxy_username = mailbox.proxy_username.clone();
    let sender_name = mailbox.smtp_sender_name.clone();
    let proxy_password = credential_mailbox.proxy_password.clone();
    let password = credential_mailbox.password.clone();
    std::thread::spawn(move || {
        input.smtp_host = smtp_host;
        input.smtp_port = smtp_port;
        input.encryption = encryption;
        input.username = username;
        if input.sender_name.trim().is_empty() {
            input.sender_name = sender_name;
        }
        execute_send(
            run_id,
            input,
            targets,
            sends,
            database,
            password,
            proxy_password,
            proxy_url,
            proxy_username,
        )
    });
    Ok(initial)
}

#[tauri::command]
fn send_test(
    input: SendInput,
    mailbox: MailboxConfig,
    state: State<'_, AppState>,
) -> Result<SendProgress, String> {
    start_send(input, mailbox, state, true)
}

#[tauri::command]
fn send_start(
    input: SendInput,
    mailbox: MailboxConfig,
    state: State<'_, AppState>,
) -> Result<SendProgress, String> {
    start_send(input, mailbox, state, false)
}

#[tauri::command]
fn send_retry(
    run_id: String,
    mailbox: MailboxConfig,
    state: State<'_, AppState>,
) -> Result<SendProgress, String> {
    let connection = state.database.lock().map_err(|error| error.to_string())?;
    let batch_id: String = connection
        .query_row(
            "SELECT COALESCE(batch_id,'') FROM send_runs WHERE id=?1",
            rusqlite::params![run_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("发送记录不存在：{error}"))?;
    if batch_id.trim().is_empty() {
        return Err("旧发送记录没有关联批次，无法自动重试".to_string());
    }
    let company_ids: Vec<String> = connection
        .prepare(
            "SELECT company_id FROM send_items WHERE run_id=?1 AND status IN ('failure','failed')",
        )
        .map_err(|error| error.to_string())?
        .query_map(rusqlite::params![run_id], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|error| error.to_string())?;
    if company_ids.is_empty() {
        return Err("该批次没有失败项可重试".to_string());
    }
    let (subject, body, signature, cc_json): (String, String, String, String) = connection
        .query_row(
            "SELECT subject,body,signature,cc FROM send_batches WHERE id=?1",
            rusqlite::params![batch_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|error| error.to_string())?;
    let cc = serde_json::from_str(&cc_json).unwrap_or_default();
    drop(connection);
    start_send(
        SendInput {
            task_id: String::new(),
            batch_id,
            smtp_host: String::new(),
            smtp_port: 0,
            encryption: String::new(),
            username: String::new(),
            sender_name: String::new(),
            subject,
            body,
            signature,
            include_attachments: true,
            company_ids,
            cc,
            test_recipient: String::new(),
        },
        mailbox,
        state,
        false,
    )
}

#[tauri::command]
fn send_status(run_id: String, state: State<'_, AppState>) -> Result<Option<SendProgress>, String> {
    state
        .sends
        .lock()
        .map_err(|error| error.to_string())
        .map(|runs| runs.get(&run_id).cloned())
}

#[tauri::command]
fn task_create(input: TaskInput, state: State<'_, AppState>) -> Result<TaskSummary, String> {
    let id = format!("task-{}", chrono_like_id());
    let name = input.name.clone();
    let deadline = input.deadline.clone();
    let material_name = if input.material_name.trim().is_empty() {
        name.trim().to_string()
    } else {
        input.material_name.trim().to_string()
    };
    let company_count = input.company_ids.len() as u32;
    let connection = state.database.lock().map_err(|e| e.to_string())?;
    let available_companies: u32 = connection
        .query_row("SELECT COUNT(*) FROM companies", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if available_companies == 0 {
        return Err("请先导入单位清单".to_string());
    }
    if input.company_ids.is_empty() {
        return Err("请至少选择一家单位".to_string());
    }
    for company_id in &input.company_ids {
        let exists: u32 = connection
            .query_row(
                "SELECT COUNT(*) FROM companies WHERE id=?1",
                rusqlite::params![company_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists == 0 {
            return Err(format!("所选单位不存在：{company_id}"));
        }
    }
    connection
        .execute(
            "INSERT INTO tasks (id,name,status,start_time,deadline,poll_minutes,save_directory,filename_template,material_name,subject_keywords,body_keywords,ai_enabled,created_at) VALUES (?1,?2,'active',?3,?4,?5,?6,?7,?8,?9,?10,?11,datetime('now'))",
            rusqlite::params![id, name, input.start_time, deadline, input.poll_minutes, input.save_directory, input.filename_template, material_name, serde_json::to_string(&input.subject_keywords).map_err(|e| e.to_string())?, serde_json::to_string(&input.body_keywords).map_err(|e| e.to_string())?, input.ai_enabled],
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
        material_name,
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
        company_ids: input.company_ids,
        deleted_at: String::new(),
    })
}

#[tauri::command]
fn task_delete(task_id: String, state: State<'_, AppState>) -> Result<(), String> {
    if task_id.trim().is_empty() {
        return Err("任务编号不能为空".to_string());
    }
    let mut connection = state.database.lock().map_err(|e| e.to_string())?;
    soft_delete_task_records(&mut connection, &task_id)
}

fn soft_delete_task_records(connection: &mut Connection, task_id: &str) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let changed = transaction
        .execute(
            "UPDATE tasks SET deleted_previous_status=status,status='deleted',deleted_at=datetime('now') WHERE id=?1 AND deleted_at IS NULL",
            rusqlite::params![task_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("任务不存在或已被删除".to_string());
    }
    transaction.commit().map_err(|e| e.to_string())
}

fn restore_task_records(connection: &mut Connection, task_id: &str) -> Result<(), String> {
    let changed = connection
        .execute(
            "UPDATE tasks SET status='paused',deleted_at=NULL,deleted_previous_status=NULL WHERE id=?1 AND deleted_at IS NOT NULL",
            rusqlite::params![task_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("任务不存在或未处于已删除状态".to_string());
    }
    Ok(())
}

#[tauri::command]
fn task_restore(task_id: String, state: State<'_, AppState>) -> Result<(), String> {
    if task_id.trim().is_empty() {
        return Err("任务编号不能为空".to_string());
    }
    let mut connection = state.database.lock().map_err(|e| e.to_string())?;
    restore_task_records(&mut connection, task_id.trim())
}

fn validate_task_status(status: &str) -> Result<&str, String> {
    match status.trim() {
        "active" | "paused" | "completed" => Ok(status.trim()),
        _ => Err("任务状态仅支持进行中、已中断或已完成".to_string()),
    }
}

#[tauri::command]
fn task_set_status(
    task_id: String,
    status: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if task_id.trim().is_empty() {
        return Err("任务编号不能为空".to_string());
    }
    let status = validate_task_status(&status)?;
    let connection = state.database.lock().map_err(|e| e.to_string())?;
    let changed = connection
        .execute(
            "UPDATE tasks SET status=?1 WHERE id=?2 AND deleted_at IS NULL",
            rusqlite::params![status, task_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("任务不存在或已被删除".to_string());
    }
    Ok(())
}

#[tauri::command]
fn task_rename(task_id: String, name: String, state: State<'_, AppState>) -> Result<(), String> {
    if task_id.trim().is_empty() {
        return Err("任务编号不能为空".to_string());
    }
    let name = name.trim();
    if name.is_empty() {
        return Err("任务名称不能为空".to_string());
    }
    let connection = state.database.lock().map_err(|e| e.to_string())?;
    let changed = connection
        .execute(
            "UPDATE tasks SET name=?1 WHERE id=?2 AND deleted_at IS NULL",
            rusqlite::params![name, task_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("任务不存在或已被删除".to_string());
    }
    Ok(())
}

fn recompute_task_feedback(connection: &Connection, task_id: &str) -> Result<(), String> {
    let company_ids = connection
        .prepare("SELECT company_id FROM task_companies WHERE task_id=?1")
        .map_err(|error| error.to_string())?
        .query_map(rusqlite::params![task_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    for company_id in company_ids {
        let confirmed: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM matches WHERE task_id=?1 AND company_id=?2 AND status='confirmed')",
                rusqlite::params![task_id, company_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let needs_review: bool = if confirmed {
            false
        } else {
            connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM matches m JOIN match_candidates mc ON mc.match_id=m.id WHERE m.task_id=?1 AND mc.company_id=?2 AND m.status='needs_review')",
                    rusqlite::params![task_id, company_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?
        };
        let status = if confirmed {
            "confirmed"
        } else if needs_review {
            "needs_review"
        } else {
            "pending"
        };
        connection
            .execute(
                "UPDATE task_companies SET feedback_status=?1 WHERE task_id=?2 AND company_id=?3",
                rusqlite::params![status, task_id, company_id],
            )
            .map_err(|error| error.to_string())?;
    }
    let all_confirmed: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM task_companies WHERE task_id=?1) AND NOT EXISTS(SELECT 1 FROM task_companies WHERE task_id=?1 AND feedback_status <> 'confirmed')",
            rusqlite::params![task_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if all_confirmed {
        connection
            .execute(
                "UPDATE tasks SET status='completed' WHERE id=?1 AND status='active'",
                rusqlite::params![task_id],
            )
            .map_err(|error| error.to_string())?;
    }
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
    let material_name = if input.material_name.trim().is_empty() {
        input.name.trim().to_string()
    } else {
        input.material_name.trim().to_string()
    };
    let connection = state.database.lock().map_err(|e| e.to_string())?;
    let available_companies: u32 = connection
        .query_row("SELECT COUNT(*) FROM companies", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if available_companies == 0 {
        return Err("请先导入单位清单".to_string());
    }
    if input.company_ids.is_empty() {
        return Err("请至少选择一家单位".to_string());
    }
    for company_id in &input.company_ids {
        let exists: u32 = connection
            .query_row(
                "SELECT COUNT(*) FROM companies WHERE id=?1",
                rusqlite::params![company_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists == 0 {
            return Err(format!("所选单位不存在：{company_id}"));
        }
    }
    let status: String = connection
        .query_row(
            "SELECT status FROM tasks WHERE id=?1",
            rusqlite::params![task_id],
            |row| row.get(0),
        )
        .map_err(|_| "任务不存在或已被删除".to_string())?;
    let changed = connection
        .execute(
            "UPDATE tasks SET name=?1,start_time=?2,deadline=?3,poll_minutes=?4,save_directory=?5,filename_template=?6,material_name=?7,subject_keywords=?8,body_keywords=?9,ai_enabled=?10 WHERE id=?11",
            rusqlite::params![input.name, input.start_time, input.deadline, input.poll_minutes, input.save_directory, input.filename_template, material_name, subject_keywords, body_keywords, input.ai_enabled, task_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("任务不存在或已被删除".to_string());
    }
    let existing_ids: Vec<String> = connection
        .prepare("SELECT company_id FROM task_companies WHERE task_id=?1")
        .map_err(|e| e.to_string())?
        .query_map(rusqlite::params![task_id], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for company_id in &existing_ids {
        if !input.company_ids.contains(company_id) {
            connection
                .execute(
                    "DELETE FROM task_companies WHERE task_id=?1 AND company_id=?2",
                    rusqlite::params![task_id, company_id],
                )
                .map_err(|e| e.to_string())?;
        }
    }
    for company_id in &input.company_ids {
        connection
            .execute(
                "INSERT OR IGNORE INTO task_companies (task_id,company_id) VALUES (?1,?2)",
                rusqlite::params![task_id, company_id],
            )
            .map_err(|e| e.to_string())?;
    }
    recompute_task_feedback(&connection, &task_id)?;
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
        material_name,
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
        company_ids: input.company_ids,
        deleted_at: String::new(),
    })
}

#[tauri::command]
fn task_list(
    include_deleted: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<TaskSummary>, String> {
    let connection = state.database.lock().map_err(|e| e.to_string())?;
    let deleted_filter = include_deleted.unwrap_or(false);
    let where_clause = if deleted_filter {
        "deleted_at IS NOT NULL"
    } else {
        "deleted_at IS NULL"
    };
    let mut statement = connection
        .prepare(&format!("SELECT id,name,COALESCE(NULLIF(material_name,''),name),status,deadline,start_time,poll_minutes,save_directory,subject_keywords,body_keywords,ai_enabled,(SELECT COUNT(*) FROM task_companies WHERE task_id=tasks.id),(SELECT COUNT(DISTINCT tc.company_id) FROM task_companies tc JOIN matches m ON m.task_id=tc.task_id AND m.company_id=tc.company_id AND m.status='confirmed' WHERE tc.task_id=tasks.id),(SELECT GROUP_CONCAT(company_id) FROM task_companies WHERE task_id=tasks.id),COALESCE(deleted_at,'') FROM tasks WHERE {where_clause} ORDER BY COALESCE(deleted_at,created_at) DESC"))
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let subject_keywords = row
                .get::<_, String>(8)
                .ok()
                .and_then(|value| serde_json::from_str(&value).ok())
                .unwrap_or_default();
            let body_keywords = row
                .get::<_, String>(9)
                .ok()
                .and_then(|value| serde_json::from_str(&value).ok())
                .unwrap_or_default();
            Ok(TaskSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                material_name: row.get(2)?,
                status: row.get(3)?,
                deadline: row.get(4)?,
                start_time: row.get(5)?,
                poll_minutes: row.get(6)?,
                save_directory: row.get(7)?,
                subject_keywords,
                body_keywords,
                ai_enabled: row.get::<_, i64>(10)? != 0,
                total_companies: row.get(11)?,
                confirmed_companies: row.get(12)?,
                company_ids: row
                    .get::<_, Option<String>>(13)?
                    .unwrap_or_default()
                    .split(',')
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
                    .collect(),
                deleted_at: row.get(14)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.map(|row| row.map_err(|e| e.to_string())).collect()
}

fn load_dashboard_summary(connection: &Connection) -> Result<DashboardSummary, String> {
    let count = |sql: &str| -> Result<u32, String> {
        connection
            .query_row(sql, [], |row| row.get(0))
            .map_err(|error| error.to_string())
    };
    let latest_receive_status = connection.query_row(
        "SELECT CASE status WHEN 'completed' THEN '最近收件已完成' WHEN 'running' THEN '正在收件' WHEN 'failed' THEN '最近收件失败' ELSE status END FROM sync_runs WHERE task_id IS NOT NULL ORDER BY started_at DESC LIMIT 1",
        [],
        |row| row.get::<_, String>(0),
    ).optional().map_err(|error| error.to_string())?.unwrap_or_else(|| "暂无收件记录".to_string());
    let mut statement = connection.prepare(
        "SELECT id,kind,title,detail,occurred_at,status,target_id FROM (
           SELECT sr.id AS id,'receive' AS kind,COALESCE(t.name,'收集任务') AS title,
                  '处理 ' || sr.processed || ' 封，新增 ' || sr.received || ' 封' AS detail,
                  COALESCE(sr.finished_at,sr.started_at) AS occurred_at,sr.status AS status,COALESCE(sr.task_id,'') AS target_id
           FROM sync_runs sr LEFT JOIN tasks t ON t.id=sr.task_id WHERE sr.task_id IS NOT NULL
           UNION ALL
           SELECT r.id AS id,'send' AS kind,COALESCE(b.name,'邮件发送批次') AS title,
                  '成功 ' || r.success_count || '，失败 ' || r.failure_count AS detail,
                  COALESCE(r.finished_at,r.started_at) AS occurred_at,r.status AS status,COALESCE(r.batch_id,'') AS target_id
           FROM send_runs r LEFT JOIN send_batches b ON b.id=r.batch_id WHERE r.mode='formal'
         ) ORDER BY occurred_at DESC LIMIT 8",
    ).map_err(|error| error.to_string())?;
    let recent_events = statement
        .query_map([], |row| {
            Ok(DashboardEvent {
                id: row.get(0)?,
                kind: row.get(1)?,
                title: row.get(2)?,
                detail: row.get(3)?,
                occurred_at: row.get(4)?,
                status: row.get(5)?,
                target_id: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(DashboardSummary {
        collection_task_count: count("SELECT COUNT(*) FROM tasks WHERE deleted_at IS NULL")?,
        active_collection_tasks: count("SELECT COUNT(*) FROM tasks WHERE status='active' AND deleted_at IS NULL")?,
        send_batch_count: count("SELECT COUNT(*) FROM send_batches")?,
        today_received: count("SELECT COUNT(*) FROM messages WHERE date(received_at,'localtime')=date('now','localtime')")?,
        today_sent_success: count("SELECT COUNT(*) FROM send_items i JOIN send_runs r ON r.id=i.run_id WHERE r.mode='formal' AND i.status='success' AND date(i.sent_at,'localtime')=date('now','localtime')")?,
        today_sent_failure: count("SELECT COUNT(*) FROM send_items i JOIN send_runs r ON r.id=i.run_id WHERE r.mode='formal' AND i.status='failed' AND date(COALESCE(i.sent_at,r.finished_at,r.started_at),'localtime')=date('now','localtime')")?,
        latest_receive_status,
        recent_events,
    })
}

#[tauri::command]
fn dashboard_summary(state: State<'_, AppState>) -> Result<DashboardSummary, String> {
    let connection = state.database.lock().map_err(|error| error.to_string())?;
    load_dashboard_summary(&connection)
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
    until: String,
    state: State<'_, AppState>,
) -> Result<SyncProgress, String> {
    let mailbox = load_mailbox_credentials(mailbox);
    let start_time = parse_sync_start(&since)?;
    let end_time = parse_sync_end(&until)?;
    let run_id = format!("sync-{}", chrono_like_id());
    let initial = SyncProgress {
        run_id: run_id.clone(),
        status: "running".into(),
        total: 0,
        processed: 0,
        received: 0,
        duplicates: 0,
        matched: 0,
        needs_review: 0,
        errors: Vec::new(),
        message: "正在连接邮箱…".into(),
    };
    state
        .syncs
        .lock()
        .map_err(|e| e.to_string())?
        .insert(run_id.clone(), initial.clone());
    {
        let connection = state.database.lock().map_err(|error| error.to_string())?;
        connection.execute(
            "INSERT INTO sync_runs (id,task_id,started_at,status) VALUES (?1,?2,datetime('now'),'running')",
            rusqlite::params![run_id, if task_id.trim().is_empty() { None::<String> } else { Some(task_id.clone()) }],
        ).map_err(|error| error.to_string())?;
    }
    let database = Arc::clone(&state.database);
    let syncs = Arc::clone(&state.syncs);
    std::thread::spawn(move || {
        let job_database = Arc::clone(&database);
        if let Err(error) = run_sync_job(
            task_id,
            mailbox,
            start_time,
            end_time,
            run_id.clone(),
            job_database,
            Arc::clone(&syncs),
        ) {
            if let Ok(connection) = database.lock() {
                let _ = connection.execute("UPDATE sync_runs SET status='failed',finished_at=datetime('now'),error=?1 WHERE id=?2", rusqlite::params![error, run_id]);
            }
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
    end_time: DateTime<Utc>,
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
    let task_rule = load_task_sync_rule(&task_id, &database)?;
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
        let received_at = parsed
            .received_at
            .parse::<DateTime<Utc>>()
            .map_err(|_| "邮件时间格式无效，无法执行任务时间范围过滤".to_string())?;
        if received_at < start_time || received_at > end_time {
            message_index += 1;
            continue;
        }
        let message_id = format!("mail-{}-{}", chrono_like_id(), message_index);
        let match_result = task_rule
            .as_ref()
            .map(|rule| evaluate_task_match(&parsed, rule));
        let (inserted, stored_message_id) = {
            let connection = database.lock().map_err(|e| e.to_string())?;
            let inserted = connection
                .execute(
                    "INSERT OR IGNORE INTO messages (id,mailbox_id,external_id,sender,recipients,cc,subject,body,received_at,content_hash) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                    rusqlite::params![message_id, mailbox_id, parsed.external_id, parsed.sender, parsed.recipients, parsed.cc, parsed.subject, parsed.body, parsed.received_at, parsed.content_hash],
                )
                .map_err(|e| e.to_string())?;
            let stored_id = if inserted == 0 {
                connection
                    .query_row(
                        "SELECT id FROM messages WHERE mailbox_id=?1 AND external_id=?2 AND content_hash=?3 LIMIT 1",
                        rusqlite::params![mailbox_id, parsed.external_id, parsed.content_hash],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(|e| e.to_string())?
            } else {
                message_id.clone()
            };
            (inserted, stored_id)
        };
        if inserted == 0 {
            duplicates += 1;
        } else {
            received += 1;
            let connection = database.lock().map_err(|e| e.to_string())?;
            for (attachment_index, attachment) in parsed.attachments.iter().enumerate() {
                let archive_result = match (&task_rule, &match_result) {
                    (Some(rule), Some((status, company_id, _, _))) => archive_task_attachment(
                        &connection,
                        &save_directory,
                        rule,
                        status,
                        company_id.as_deref(),
                        &parsed,
                        attachment,
                    ),
                    _ => mail::write_attachment(&save_directory, &message_id, attachment),
                };
                let saved_path = match archive_result {
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
            if parsed.attachments.is_empty() {
                let archive_result = match (&task_rule, &match_result) {
                    (Some(rule), Some((status, company_id, _, _))) => archive_task_body(
                        &connection,
                        &save_directory,
                        rule,
                        status,
                        company_id.as_deref(),
                        &parsed,
                    ),
                    _ => archive::write_message_body_docx(
                        &save_directory,
                        &format!("{}-邮件正文.docx", message_id),
                        &parsed.subject,
                        &parsed.sender,
                        &parsed.received_at,
                        &parsed.body,
                    )
                    .map(|path| path.to_string_lossy().to_string()),
                };
                let saved_path = match archive_result {
                    Ok(path) => path,
                    Err(error) => {
                        errors.push(error);
                        String::new()
                    }
                };
                connection
                    .execute(
                        "INSERT INTO attachments (id,message_id,original_name,saved_name,saved_path,mime_type,parse_status) VALUES (?1,?2,'邮件正文.docx','邮件正文.docx',?3,'application/vnd.openxmlformats-officedocument.wordprocessingml.document',?4)",
                        rusqlite::params![format!("body-{}-{}", chrono_like_id(), message_index), message_id, saved_path, if saved_path.is_empty() { "error" } else { "generated_body" }],
                    )
                    .map_err(|e| e.to_string())?;
            }
        }
        if let (Some(rule), Some((match_status, company_id, reason, candidate_ids))) =
            (&task_rule, match_result)
        {
            let match_id = format!("match-{}-{}", stored_message_id, rule.task_id);
            let connection = database.lock().map_err(|e| e.to_string())?;
            connection
                .execute(
                    "INSERT INTO matches (id,message_id,task_id,company_id,status,reason,confidence,reviewed_at) VALUES (?1,?2,?3,?4,?5,?6,NULL,NULL) ON CONFLICT(id) DO UPDATE SET company_id=excluded.company_id,status=excluded.status,reason=excluded.reason WHERE matches.reviewed_at IS NULL",
                    rusqlite::params![match_id, stored_message_id, rule.task_id, company_id, match_status, reason],
                )
                .map_err(|e| e.to_string())?;
            connection
                .execute(
                    "DELETE FROM match_candidates WHERE match_id=?1",
                    rusqlite::params![match_id],
                )
                .map_err(|error| error.to_string())?;
            for candidate_id in candidate_ids {
                connection
                    .execute(
                        "INSERT OR IGNORE INTO match_candidates (match_id,company_id) VALUES (?1,?2)",
                        rusqlite::params![match_id, candidate_id],
                    )
                    .map_err(|error| error.to_string())?;
            }
            recompute_task_feedback(&connection, &rule.task_id)?;
            let status_snapshot = match_status.clone();
            update_sync_progress(&syncs, &run_id, |progress| {
                if status_snapshot == "confirmed" {
                    progress.matched += 1;
                }
                if status_snapshot == "needs_review" {
                    progress.needs_review += 1;
                }
            });
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
    if let Ok(connection) = database.lock() {
        if !task_id.trim().is_empty() {
            recompute_task_feedback(&connection, &task_id)?;
        }
        let progress = syncs
            .lock()
            .ok()
            .and_then(|runs| runs.get(&run_id).cloned());
        if let Some(progress) = progress {
            connection.execute(
                "UPDATE sync_runs SET status='completed',finished_at=datetime('now'),processed=?1,received=?2,duplicates=?3,matched=?4,needs_review=?5,error=?6 WHERE id=?7",
                rusqlite::params![progress.processed, progress.received, progress.duplicates, progress.matched, progress.needs_review, progress.errors.join("；"), run_id],
            ).map_err(|error| error.to_string())?;
        }
    }
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

fn parse_sync_end(value: &str) -> Result<DateTime<Utc>, String> {
    let now = Utc::now();
    if value.trim().is_empty() {
        return Ok(now);
    }
    let requested = if let Ok(date) = DateTime::parse_from_rfc3339(value) {
        date.with_timezone(&Utc)
    } else {
        let naive = NaiveDateTime::parse_from_str(value.trim(), "%Y-%m-%dT%H:%M")
            .map_err(|_| "收件截止时间格式无效".to_string())?;
        Local
            .from_local_datetime(&naive)
            .single()
            .map(|date| date.with_timezone(&Utc))
            .ok_or_else(|| "收件截止时间无法转换".to_string())?
    };
    Ok(requested.min(now))
}

#[derive(Debug, Clone)]
struct TaskCompanyRule {
    id: String,
    name: String,
    aliases: Vec<String>,
    emails: Vec<String>,
}

#[derive(Debug, Clone)]
struct TaskSyncRule {
    task_id: String,
    task_name: String,
    material_name: String,
    subject_keywords: Vec<String>,
    body_keywords: Vec<String>,
    companies: Vec<TaskCompanyRule>,
}

fn load_task_sync_rule(
    task_id: &str,
    database: &Arc<Mutex<Connection>>,
) -> Result<Option<TaskSyncRule>, String> {
    if task_id.trim().is_empty() {
        return Ok(None);
    }
    let connection = database.lock().map_err(|e| e.to_string())?;
    let (task_name, material_name, subject_json, body_json): (String, String, String, String) = connection
        .query_row(
            "SELECT name,COALESCE(NULLIF(material_name,''),name),subject_keywords,body_keywords FROM tasks WHERE id=?1",
            rusqlite::params![task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|_| "任务不存在或已被删除".to_string())?;
    let subject_keywords = serde_json::from_str(&subject_json).unwrap_or_default();
    let body_keywords = serde_json::from_str(&body_json).unwrap_or_default();
    let mut statement = connection
        .prepare("SELECT tc.company_id,c.name,c.aliases,COALESCE(cc.email,'') FROM task_companies tc JOIN companies c ON c.id=tc.company_id LEFT JOIN company_contacts cc ON cc.company_id=tc.company_id WHERE tc.task_id=?1 ORDER BY tc.company_id")
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String, String)> = statement
        .query_map(rusqlite::params![task_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut companies: HashMap<String, TaskCompanyRule> = HashMap::new();
    for (company_id, name, aliases_json, email) in rows {
        let entry = companies
            .entry(company_id.clone())
            .or_insert_with(|| TaskCompanyRule {
                id: company_id,
                name,
                aliases: serde_json::from_str(&aliases_json).unwrap_or_default(),
                emails: Vec::new(),
            });
        if !email.trim().is_empty() {
            entry.emails.push(email);
        }
    }
    Ok(Some(TaskSyncRule {
        task_id: task_id.to_string(),
        task_name,
        material_name,
        subject_keywords,
        body_keywords,
        companies: companies.into_values().collect(),
    }))
}

fn normalize_sender(value: &str) -> String {
    let trimmed = value.trim().to_lowercase();
    trimmed
        .split_once('<')
        .and_then(|(_, rest)| {
            rest.split_once('>')
                .map(|(email, _)| email.trim().to_string())
        })
        .unwrap_or(trimmed)
}

fn normalize_match_name(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|character| character.is_alphanumeric())
        .collect()
}

fn sender_display_name(value: &str) -> String {
    value
        .split_once('<')
        .map(|(name, _)| name)
        .unwrap_or("")
        .trim()
        .to_string()
}

fn sender_name_candidates<'a>(
    sender: &str,
    companies: &'a [TaskCompanyRule],
) -> Vec<&'a TaskCompanyRule> {
    let display_name = normalize_match_name(&sender_display_name(sender));
    if display_name.is_empty() {
        return Vec::new();
    }
    companies
        .iter()
        .filter(|company| {
            std::iter::once(&company.name)
                .chain(company.aliases.iter())
                .map(|candidate| normalize_match_name(candidate))
                .filter(|candidate| candidate.chars().count() >= 2)
                .any(|candidate| display_name.contains(&candidate))
        })
        .collect()
}

fn keyword_match(value: &str, keywords: &[String]) -> bool {
    let normalized = value.to_lowercase();
    keywords.is_empty()
        || keywords
            .iter()
            .any(|keyword| normalized.contains(&keyword.to_lowercase()))
}

fn evaluate_task_match(
    message: &mail::ParsedMessage,
    rule: &TaskSyncRule,
) -> (String, Option<String>, String, Vec<String>) {
    let sender = normalize_sender(&message.sender);
    let email_candidates: Vec<&TaskCompanyRule> = rule
        .companies
        .iter()
        .filter(|company| {
            company
                .emails
                .iter()
                .any(|email| normalize_sender(email) == sender)
        })
        .collect();
    let matched_by_sender_name = email_candidates.is_empty();
    let candidates = if matched_by_sender_name {
        sender_name_candidates(&message.sender, &rule.companies)
    } else {
        email_candidates
    };
    let subject_matches = keyword_match(&message.subject, &rule.subject_keywords);
    let body_matches = keyword_match(&message.body, &rule.body_keywords);
    if candidates.is_empty() || !subject_matches || !body_matches {
        let identified_company = if candidates.len() == 1 {
            Some(candidates[0].id.clone())
        } else {
            None
        };
        let reason = if candidates.is_empty() {
            "sender_not_in_task"
        } else if !subject_matches {
            "subject_keyword_mismatch"
        } else {
            "body_keyword_mismatch"
        };
        return (
            "unmatched".to_string(),
            identified_company,
            reason.to_string(),
            Vec::new(),
        );
    }
    if candidates.len() > 1 {
        return (
            "needs_review".to_string(),
            None,
            "multiple_company_matches".to_string(),
            candidates
                .into_iter()
                .map(|company| company.id.clone())
                .collect(),
        );
    }
    (
        "confirmed".to_string(),
        Some(candidates[0].id.clone()),
        if matched_by_sender_name && rule.subject_keywords.is_empty() {
            "sender_name_and_body".to_string()
        } else if matched_by_sender_name {
            "sender_name_and_subject".to_string()
        } else if rule.subject_keywords.is_empty() {
            "sender_and_body".to_string()
        } else {
            "sender_and_subject".to_string()
        },
        vec![candidates[0].id.clone()],
    )
}

fn archive_task_attachment(
    connection: &Connection,
    save_directory: &Path,
    rule: &TaskSyncRule,
    status: &str,
    company_id: Option<&str>,
    message: &mail::ParsedMessage,
    attachment: &mail::ParsedAttachment,
) -> Result<String, String> {
    let task_root = archive::task_root(save_directory, &rule.task_name);
    let (bucket, filename) = if status == "confirmed" {
        let company_id = company_id.ok_or_else(|| "已匹配邮件缺少单位编号".to_string())?;
        let company_name: String = connection
            .query_row(
                "SELECT name FROM companies WHERE id=?1",
                rusqlite::params![company_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("读取匹配单位失败：{error}"))?;
        (
            archive::ArchiveBucket::Matched,
            archive::matched_name(&company_name, &rule.material_name, &attachment.name),
        )
    } else {
        (
            archive::ArchiveBucket::Unmatched,
            archive::unmatched_name(
                &message.received_at,
                &normalize_sender(&message.sender),
                &attachment.name,
            ),
        )
    };
    let directory = archive::bucket_directory(&task_root, bucket);
    archive::write_new_attachment(&directory, &filename, &attachment.bytes)
        .map(|path| path.to_string_lossy().to_string())
}

fn archive_task_body(
    connection: &Connection,
    save_directory: &Path,
    rule: &TaskSyncRule,
    status: &str,
    company_id: Option<&str>,
    message: &mail::ParsedMessage,
) -> Result<String, String> {
    let task_root = archive::task_root(save_directory, &rule.task_name);
    let (bucket, filename) = if status == "confirmed" {
        let company_id = company_id.ok_or_else(|| "已匹配邮件缺少单位编号".to_string())?;
        let company_name: String = connection
            .query_row(
                "SELECT name FROM companies WHERE id=?1",
                rusqlite::params![company_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("读取匹配单位失败：{error}"))?;
        (
            archive::ArchiveBucket::Matched,
            archive::matched_name(&company_name, &rule.material_name, "邮件正文.docx"),
        )
    } else {
        (
            archive::ArchiveBucket::Unmatched,
            archive::unmatched_name(
                &message.received_at,
                &normalize_sender(&message.sender),
                "邮件正文.docx",
            ),
        )
    };
    archive::write_message_body_docx(
        &archive::bucket_directory(&task_root, bucket),
        &filename,
        &message.subject,
        &message.sender,
        &message.received_at,
        &message.body,
    )
    .map(|path| path.to_string_lossy().to_string())
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
        let aliases: Vec<String> = row
            .aliases
            .split([';', ',', '，', '；', '、'])
            .map(str::trim)
            .filter(|alias| !alias.is_empty())
            .map(ToOwned::to_owned)
            .collect();
        if !aliases.is_empty() {
            let existing = connection
                .query_row(
                    "SELECT aliases FROM companies WHERE id=?1",
                    rusqlite::params![company_id],
                    |value| value.get::<_, String>(0),
                )
                .unwrap_or_else(|_| "[]".to_string());
            let mut merged: Vec<String> = serde_json::from_str(&existing).unwrap_or_default();
            for alias in aliases {
                if !merged.contains(&alias) && alias != name {
                    merged.push(alias);
                }
            }
            connection
                .execute(
                    "UPDATE companies SET aliases=?1 WHERE id=?2",
                    rusqlite::params![
                        serde_json::to_string(&merged).map_err(|e| e.to_string())?,
                        company_id
                    ],
                )
                .map_err(|e| e.to_string())?;
        }
        if email.is_empty() {
            continue;
        }
        connection
            .execute(
                "INSERT INTO company_contacts (id,company_id,email,contact_name,phone,created_at) VALUES (?1,?2,?3,?4,?5,datetime('now')) ON CONFLICT(email) DO UPDATE SET company_id=excluded.company_id, contact_name=excluded.contact_name, phone=excluded.phone",
                rusqlite::params![format!("contact-{}-{}", chrono_like_id(), index), company_id, email, row.contact_name.trim(), row.phone.trim()],
            )
            .map_err(|e| e.to_string())?;
        imported += 1;
    }
    Ok(imported)
}

#[tauri::command]
fn company_update(row: CompanyImportRow, state: State<'_, AppState>) -> Result<u32, String> {
    company_import(vec![row], state)
}

fn save_company_contact(
    connection: &mut Connection,
    input: &CompanyContactInput,
    create: bool,
) -> Result<CompanyContact, String> {
    let name = input.company_name.trim();
    let email = input.email.trim().to_ascii_lowercase();
    if name.is_empty() || !valid_email(&email) {
        return Err("单位名称不能为空，且邮箱必须为有效地址".to_string());
    }
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let company_id = if !input.company_id.trim().is_empty() {
        input.company_id.clone()
    } else {
        transaction
            .query_row(
                "SELECT id FROM companies WHERE name=?1 LIMIT 1",
                rusqlite::params![name],
                |row| row.get(0),
            )
            .unwrap_or_else(|_| next_unique_id("company"))
    };
    let aliases = serde_json::to_string(
        &input
            .aliases
            .iter()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>(),
    )
    .map_err(|error| error.to_string())?;
    transaction.execute("INSERT INTO companies (id,name,aliases,created_at) VALUES (?1,?2,?3,datetime('now')) ON CONFLICT(id) DO UPDATE SET name=excluded.name,aliases=excluded.aliases", rusqlite::params![company_id, name, aliases]).map_err(|error| error.to_string())?;
    let contact_id = if create || input.id.trim().is_empty() {
        next_unique_id("contact")
    } else {
        input.id.clone()
    };
    if create {
        transaction.execute("INSERT INTO company_contacts (id,company_id,email,contact_name,phone,created_at) VALUES (?1,?2,?3,?4,?5,datetime('now'))", rusqlite::params![contact_id, company_id, email, input.contact_name.trim(), input.phone.trim()]).map_err(|error| format!("保存联系人失败，邮箱可能已存在：{error}"))?;
    } else {
        let changed = transaction.execute("UPDATE company_contacts SET company_id=?1,email=?2,contact_name=?3,phone=?4 WHERE id=?5", rusqlite::params![company_id, email, input.contact_name.trim(), input.phone.trim(), contact_id]).map_err(|error| format!("更新联系人失败，邮箱可能已存在：{error}"))?;
        if changed == 0 {
            return Err("联系人不存在或已被删除".to_string());
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(CompanyContact {
        id: contact_id,
        contact_name: input.contact_name.trim().to_string(),
        email,
        phone: input.phone.trim().to_string(),
    })
}

#[tauri::command]
fn company_contact_create(
    input: CompanyContactInput,
    state: State<'_, AppState>,
) -> Result<CompanyContact, String> {
    let mut connection = state.database.lock().map_err(|error| error.to_string())?;
    save_company_contact(&mut connection, &input, true)
}

#[tauri::command]
fn company_contact_update(
    input: CompanyContactInput,
    state: State<'_, AppState>,
) -> Result<CompanyContact, String> {
    let mut connection = state.database.lock().map_err(|error| error.to_string())?;
    save_company_contact(&mut connection, &input, false)
}

#[tauri::command]
fn company_contact_delete(
    contact_id: String,
    state: State<'_, AppState>,
) -> Result<CompanyDeleteResult, String> {
    let mut connection = state.database.lock().map_err(|error| error.to_string())?;
    delete_company_contact(&mut connection, &contact_id)
}

fn delete_company_contact(
    connection: &mut Connection,
    contact_id: &str,
) -> Result<CompanyDeleteResult, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let company_id: String = transaction
        .query_row(
            "SELECT company_id FROM company_contacts WHERE id=?1",
            rusqlite::params![contact_id],
            |row| row.get(0),
        )
        .map_err(|_| "联系人不存在或已被删除".to_string())?;
    let contact_count: u32 = transaction
        .query_row(
            "SELECT COUNT(*) FROM company_contacts WHERE company_id=?1",
            rusqlite::params![company_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let affected_tasks: u32 = transaction
        .query_row(
            "SELECT COUNT(*) FROM task_companies WHERE company_id=?1",
            rusqlite::params![company_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let deleted_company = contact_count <= 1;
    if deleted_company {
        transaction
            .execute(
                "DELETE FROM companies WHERE id=?1",
                rusqlite::params![company_id],
            )
            .map_err(|error| error.to_string())?;
    } else {
        transaction
            .execute(
                "DELETE FROM company_contacts WHERE id=?1",
                rusqlite::params![contact_id],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(CompanyDeleteResult {
        deleted_company,
        affected_tasks,
    })
}

#[tauri::command]
fn company_list(state: State<'_, AppState>) -> Result<Vec<CompanySummary>, String> {
    let connection = state.database.lock().map_err(|e| e.to_string())?;
    let company_rows: Vec<(String, String)> = connection
        .prepare("SELECT id,name FROM companies ORDER BY name COLLATE NOCASE")
        .map_err(|e| e.to_string())?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    company_rows
        .into_iter()
        .map(|(id, name)| {
            let contacts = connection
                .prepare("SELECT id,contact_name,email,phone FROM company_contacts WHERE company_id=?1 ORDER BY contact_name,email")
                .map_err(|e| e.to_string())?
                .query_map(rusqlite::params![id], |row| Ok(CompanyContact { id: row.get(0)?, contact_name: row.get(1)?, email: row.get(2)?, phone: row.get(3)? }))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<CompanyContact>, _>>()
                .map_err(|e| e.to_string())?;
            let email_count = contacts.len() as u32;
            let phones = contacts.iter().map(|contact| contact.phone.clone()).filter(|phone| !phone.trim().is_empty()).collect();
            let aliases_json: String = connection
                .query_row("SELECT aliases FROM companies WHERE id=?1", rusqlite::params![id], |row| row.get(0))
                .unwrap_or_else(|_| "[]".to_string());
            let aliases = serde_json::from_str(&aliases_json).unwrap_or_default();
            Ok(CompanySummary { id, name, contacts, email_count, phones, aliases })
        })
        .collect()
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

fn rollback_attachment_moves(moves: &[(PathBuf, PathBuf)]) -> Vec<String> {
    let mut errors = Vec::new();
    for (source, target) in moves.iter().rev() {
        if !target.exists() {
            continue;
        }
        if source.exists() {
            if let Err(error) = std::fs::remove_file(target) {
                errors.push(format!("无法清理补偿文件 {}：{error}", target.display()));
            }
        } else if let Err(error) = archive::move_with_cross_volume_fallback(target, source) {
            errors.push(error);
        }
    }
    errors
}

fn resolve_match(
    connection: &mut Connection,
    match_id: &str,
    decision: &str,
    task_id: Option<&str>,
    company_id: Option<&str>,
) -> Result<(), String> {
    let (message_id, original_task_id): (String, Option<String>) = connection
        .query_row(
            "SELECT message_id,task_id FROM matches WHERE id=?1",
            rusqlite::params![match_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "匹配记录不存在或已被删除".to_string())?;
    if decision == "ignored" || decision == "ignore" {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE matches SET status='ignored',reviewed_at=datetime('now') WHERE id=?1",
                rusqlite::params![match_id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM match_candidates WHERE match_id=?1",
                rusqlite::params![match_id],
            )
            .map_err(|error| error.to_string())?;
        if let Some(task_id) = original_task_id.as_deref() {
            recompute_task_feedback(&transaction, task_id)?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let task_id = task_id
        .filter(|value| !value.trim().is_empty())
        .or(original_task_id.as_deref())
        .ok_or_else(|| "请选择归属任务".to_string())?;
    let company_id = company_id
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "请选择归属单位".to_string())?;
    let (task_name, material_name, save_directory): (String, String, String) = connection.query_row(
        "SELECT name,COALESCE(NULLIF(material_name,''),name),save_directory FROM tasks WHERE id=?1",
        rusqlite::params![task_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).map_err(|_| "所选任务不存在".to_string())?;
    let company_name: String = connection
        .query_row(
            "SELECT name FROM companies WHERE id=?1",
            rusqlite::params![company_id],
            |row| row.get(0),
        )
        .map_err(|_| "所选单位不存在".to_string())?;
    let attachments = connection.prepare("SELECT id,original_name,COALESCE(saved_path,'') FROM attachments WHERE message_id=?1 ORDER BY id")
        .map_err(|error| error.to_string())?
        .query_map(rusqlite::params![message_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let target_directory = archive::bucket_directory(
        &archive::task_root(Path::new(&save_directory), &task_name),
        archive::ArchiveBucket::Matched,
    );
    std::fs::create_dir_all(&target_directory)
        .map_err(|error| format!("无法创建已匹配目录 {}：{error}", target_directory.display()))?;
    let mut moves = Vec::new();
    let mut path_updates = Vec::new();
    for (attachment_id, original_name, saved_path) in attachments {
        if saved_path.trim().is_empty() {
            continue;
        }
        let source = PathBuf::from(&saved_path);
        let filename = archive::matched_name(&company_name, &material_name, &original_name);
        let target = archive::unique_destination(&target_directory, &filename);
        if source != target {
            if let Err(error) = archive::move_with_cross_volume_fallback(&source, &target) {
                let compensation = rollback_attachment_moves(&moves);
                return Err(if compensation.is_empty() {
                    error
                } else {
                    format!("{error}；补偿失败：{}", compensation.join("；"))
                });
            }
            moves.push((source, target.clone()));
        }
        path_updates.push((attachment_id, target.to_string_lossy().to_string()));
    }
    let database_result = (|| -> Result<(), String> {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction.execute(
            "UPDATE matches SET task_id=?1,company_id=?2,status='confirmed',reason='manual_resolution',reviewed_at=datetime('now') WHERE id=?3",
            rusqlite::params![task_id, company_id, match_id],
        ).map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM match_candidates WHERE match_id=?1",
                rusqlite::params![match_id],
            )
            .map_err(|error| error.to_string())?;
        for (attachment_id, saved_path) in &path_updates {
            transaction
                .execute(
                    "UPDATE attachments SET saved_path=?1,saved_name=?2 WHERE id=?3",
                    rusqlite::params![
                        saved_path,
                        Path::new(saved_path)
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or(""),
                        attachment_id
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
        if let Some(original_task_id) = original_task_id.as_deref() {
            recompute_task_feedback(&transaction, original_task_id)?;
        }
        if original_task_id.as_deref() != Some(task_id) {
            recompute_task_feedback(&transaction, task_id)?;
        }
        transaction.commit().map_err(|error| error.to_string())
    })();
    if let Err(error) = database_result {
        let compensation = rollback_attachment_moves(&moves);
        return Err(if compensation.is_empty() {
            error
        } else {
            format!("{error}；补偿失败：{}", compensation.join("；"))
        });
    }
    Ok(())
}

#[tauri::command]
fn match_resolve(
    match_id: String,
    decision: String,
    task_id: Option<String>,
    company_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut connection = state.database.lock().map_err(|error| error.to_string())?;
    resolve_match(
        &mut connection,
        match_id.trim(),
        decision.trim(),
        task_id.as_deref(),
        company_id.as_deref(),
    )
}

fn validate_archived_path(connection: &Connection, path: &str) -> Result<PathBuf, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("附件尚未归档到本地".to_string());
    }
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM attachments WHERE saved_path=?1)",
            rusqlite::params![path],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !exists {
        return Err("该路径不是系统已归档附件，已拒绝打开".to_string());
    }
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err(format!("附件不存在或已被移动：{}", path.display()));
    }
    Ok(path)
}

#[tauri::command]
fn material_open_location(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let connection = state.database.lock().map_err(|error| error.to_string())?;
    let path = validate_archived_path(&connection, &path)?;
    let display = path.to_string_lossy().to_string();
    let status = if path.is_dir() {
        std::process::Command::new("explorer.exe")
            .arg(&path)
            .spawn()
    } else {
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", path.display()))
            .spawn()
    };
    status.map_err(|error| format!("无法打开附件所在目录 {}：{error}", path.display()))?;
    Ok(display)
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

fn database_path_for_executable(executable: &Path) -> PathBuf {
    executable
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("unigather.db")
}

fn production_database_path() -> PathBuf {
    std::env::current_exe()
        .map(|path| database_path_for_executable(&path))
        .unwrap_or_else(|_| PathBuf::from("unigather.db"))
}

#[cfg(test)]
mod tests {
    use super::{
        archive_task_attachment, database_path_for_executable, delete_company_contact,
        evaluate_task_match, load_dashboard_summary, load_send_history_detail,
        load_task_feedback_page, load_task_match_detail, load_task_pending_companies,
        next_unique_id, recompute_task_feedback, replace_send_batch_items, resolve_match,
        restore_task_records, soft_delete_task_records, validate_archived_path,
        validate_task_status, TaskCompanyRule, TaskSyncRule,
    };
    use crate::mail::ParsedMessage;
    use crate::models::SendBatchItemInput;
    use rusqlite::Connection;
    use std::path::Path;

    fn message(sender: &str, subject: &str, body: &str) -> ParsedMessage {
        ParsedMessage {
            external_id: "test".into(),
            content_hash: "hash".into(),
            sender: sender.into(),
            recipients: String::new(),
            cc: String::new(),
            subject: subject.into(),
            body: body.into(),
            received_at: "2026-08-10T10:00:00Z".into(),
            attachments: Vec::new(),
        }
    }

    #[test]
    fn validates_task_lifecycle_statuses() {
        assert_eq!(validate_task_status("active").unwrap(), "active");
        assert_eq!(validate_task_status("paused").unwrap(), "paused");
        assert_eq!(validate_task_status("completed").unwrap(), "completed");
        assert!(validate_task_status("deleted").is_err());
    }

    #[test]
    fn confirms_company_when_sender_and_subject_match() {
        let rule = TaskSyncRule {
            task_id: "task-a".into(),
            task_name: "任务".into(),
            material_name: "材料".into(),
            subject_keywords: vec!["报名".into()],
            body_keywords: Vec::new(),
            companies: vec![TaskCompanyRule {
                id: "company-a".into(),
                name: "单位 A".into(),
                aliases: Vec::new(),
                emails: vec!["finance@example.com".into()],
            }],
        };
        let result = evaluate_task_match(
            &message("张三 <finance@example.com>", "报名表反馈", "已提交"),
            &rule,
        );
        assert_eq!(result.0, "confirmed");
        assert_eq!(result.1.as_deref(), Some("company-a"));
    }

    #[test]
    fn confirms_company_when_sender_display_name_matches_selected_unit() {
        let rule = TaskSyncRule {
            task_id: "task-a".into(),
            task_name: "任务".into(),
            material_name: "材料".into(),
            subject_keywords: vec!["报名".into()],
            body_keywords: Vec::new(),
            companies: vec![TaskCompanyRule {
                id: "shanxi".into(),
                name: "陕西省分公司".into(),
                aliases: vec!["陕西".into()],
                emails: vec!["contact@example.com".into()],
            }],
        };
        let result = evaluate_task_match(
            &message(
                "曹清华(联通陕西省分公司本部) <unknown@example.com>",
                "报名表反馈",
                "已提交",
            ),
            &rule,
        );
        assert_eq!(result.0, "confirmed");
        assert_eq!(result.1.as_deref(), Some("shanxi"));
        assert_eq!(result.2, "sender_name_and_subject");
    }

    #[test]
    fn keeps_identified_company_when_sender_name_matches_but_task_keyword_does_not() {
        let rule = TaskSyncRule {
            task_id: "task-a".into(),
            task_name: "任务".into(),
            material_name: "材料".into(),
            subject_keywords: vec!["报名".into()],
            body_keywords: Vec::new(),
            companies: vec![TaskCompanyRule {
                id: "shanxi".into(),
                name: "陕西".into(),
                aliases: vec!["陕西省分公司".into()],
                emails: vec![],
            }],
        };
        let result = evaluate_task_match(
            &message(
                "曹清华(联通陕西省分公司本部) <caoqh16@example.com>",
                "数据安全片区会参会人员",
                "请查收",
            ),
            &rule,
        );
        assert_eq!(result.0, "unmatched");
        assert_eq!(result.1.as_deref(), Some("shanxi"));
        assert_eq!(result.2, "subject_keyword_mismatch");
    }

    #[test]
    fn lists_pending_and_review_companies_but_not_confirmed_companies() {
        let connection = Connection::open_in_memory().expect("database");
        crate::db::initialize(&connection).expect("schema");
        connection.execute("INSERT INTO tasks (id,name,status,deadline,poll_minutes,save_directory,filename_template,subject_keywords,body_keywords,ai_enabled,created_at) VALUES ('t','任务','active','2026-08-20',30,'d','f','[]','[]',0,datetime('now'))", []).expect("task");
        for (id, name, status) in [
            ("pending", "陕西省分公司", "pending"),
            ("review", "北京分公司", "needs_review"),
            ("done", "总部", "confirmed"),
        ] {
            connection.execute("INSERT INTO companies (id,name,aliases,created_at) VALUES (?1,?2,'[]',datetime('now'))", rusqlite::params![id, name]).expect("company");
            connection.execute("INSERT INTO task_companies (task_id,company_id,feedback_status) VALUES ('t',?1,?2)", rusqlite::params![id, status]).expect("task company");
        }
        connection.execute("INSERT INTO company_contacts (id,company_id,email,contact_name,phone,created_at) VALUES ('c1','pending','shanxi@example.com','张三','010-1',datetime('now'))", []).expect("contact");
        let rows = load_task_pending_companies(&connection, "t").expect("pending companies");
        assert_eq!(
            rows.iter()
                .map(|item| item.company_name.as_str())
                .collect::<Vec<_>>(),
            vec!["陕西省分公司", "北京分公司"]
        );
        assert_eq!(rows[0].contacts[0].email, "shanxi@example.com");
    }

    #[test]
    fn flags_duplicate_sender_mapping_for_manual_review() {
        let rule = TaskSyncRule {
            task_id: "task-a".into(),
            task_name: "任务".into(),
            material_name: "材料".into(),
            subject_keywords: Vec::new(),
            body_keywords: Vec::new(),
            companies: vec![
                TaskCompanyRule {
                    id: "company-a".into(),
                    name: "单位 A".into(),
                    aliases: Vec::new(),
                    emails: vec!["same@example.com".into()],
                },
                TaskCompanyRule {
                    id: "company-b".into(),
                    name: "单位 B".into(),
                    aliases: Vec::new(),
                    emails: vec!["same@example.com".into()],
                },
            ],
        };
        let result = evaluate_task_match(&message("same@example.com", "材料", "已提交"), &rule);
        assert_eq!(result.0, "needs_review");
        assert_eq!(result.3, vec!["company-a", "company-b"]);
    }

    #[test]
    fn explains_why_a_task_message_did_not_match() {
        let rule = TaskSyncRule {
            task_id: "task-a".into(),
            task_name: "任务".into(),
            material_name: "材料".into(),
            subject_keywords: vec!["报名".into()],
            body_keywords: Vec::new(),
            companies: vec![TaskCompanyRule {
                id: "company-a".into(),
                name: "单位 A".into(),
                aliases: Vec::new(),
                emails: vec!["unit@example.com".into()],
            }],
        };
        assert_eq!(
            evaluate_task_match(&message("other@example.com", "报名材料", ""), &rule).2,
            "sender_not_in_task"
        );
        assert_eq!(
            evaluate_task_match(&message("unit@example.com", "其他材料", ""), &rule).2,
            "subject_keyword_mismatch"
        );
    }

    #[test]
    fn resolves_database_next_to_executable() {
        assert_eq!(
            database_path_for_executable(Path::new(r"E:\software\unigather\unigather.exe")),
            Path::new(r"E:\software\unigather\unigather.db")
        );
    }

    #[test]
    fn creates_unique_ids_for_files_created_in_the_same_batch() {
        let ids = (0..1000)
            .map(|_| next_unique_id("file"))
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(ids.len(), 1000);
    }

    #[test]
    fn batch_item_replacement_rolls_back_on_duplicate_ids() {
        let mut connection = Connection::open_in_memory().expect("database");
        crate::db::initialize(&connection).expect("schema");
        connection.execute("INSERT INTO send_batches (id,name,source_dir,recursive,subject,body,cc,status,created_at,updated_at) VALUES ('batch','b','.',0,'s','b','[]','draft',datetime('now'),datetime('now'))", []).expect("batch");
        let item = |id: &str, name: &str| SendBatchItemInput {
            id: id.into(),
            file_name: name.into(),
            file_path: name.into(),
            company_id: "company".into(),
            company_name: "单位".into(),
            recipients: vec!["a@example.com".into()],
            match_method: "manual".into(),
            confidence: 1.0,
            status: "matched".into(),
            error: String::new(),
        };
        replace_send_batch_items(&mut connection, "batch", &[item("existing", "old.docx")])
            .expect("initial items");
        assert!(replace_send_batch_items(
            &mut connection,
            "batch",
            &[item("same", "one.docx"), item("same", "two.docx")]
        )
        .is_err());
        let names: Vec<String> = connection
            .prepare(
                "SELECT file_name FROM send_batch_items WHERE batch_id='batch' ORDER BY file_name",
            )
            .expect("query")
            .query_map([], |row| row.get(0))
            .expect("rows")
            .collect::<Result<_, _>>()
            .expect("collect");
        assert_eq!(names, vec!["old.docx"]);
    }

    #[test]
    fn deleting_the_last_contact_removes_company_and_task_membership() {
        let mut connection = Connection::open_in_memory().expect("database");
        crate::db::initialize(&connection).expect("schema");
        connection.execute("INSERT INTO companies (id,name,aliases,created_at) VALUES ('c','单位','[]',datetime('now'))", []).expect("company");
        connection.execute("INSERT INTO company_contacts (id,company_id,email,created_at) VALUES ('p','c','a@example.com',datetime('now'))", []).expect("contact");
        connection.execute("INSERT INTO tasks (id,name,status,deadline,poll_minutes,save_directory,filename_template,created_at) VALUES ('t','任务','active','2026-08-31',30,'.','{原文件名}',datetime('now'))", []).expect("task");
        connection
            .execute(
                "INSERT INTO task_companies (task_id,company_id) VALUES ('t','c')",
                [],
            )
            .expect("membership");
        let result = delete_company_contact(&mut connection, "p").expect("delete");
        assert!(result.deleted_company);
        assert_eq!(result.affected_tasks, 1);
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM companies WHERE id='c'", [], |row| row
                    .get::<_, u32>(0))
                .expect("count"),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM task_companies WHERE company_id='c'",
                    [],
                    |row| row.get::<_, u32>(0)
                )
                .expect("count"),
            0
        );
    }

    #[test]
    fn loads_all_send_attempts_and_items_for_a_batch() {
        let connection = Connection::open_in_memory().expect("database");
        crate::db::initialize(&connection).expect("schema");
        connection.execute("INSERT INTO send_batches (id,name,source_dir,recursive,subject,body,signature,cc,status,created_at,updated_at) VALUES ('b','批次','D:/材料',0,'主题','正文','签名','[]','sent','2026-08-13','2026-08-13')", []).expect("batch");
        connection.execute("INSERT INTO send_runs (id,batch_id,mode,started_at,finished_at,status,total,processed,success_count,failure_count) VALUES ('r1','b','test','2026-08-13 10:00','2026-08-13 10:01','completed',1,1,1,0)", []).expect("run");
        connection.execute("INSERT INTO send_items (id,run_id,company_id,company_name,recipients,attachments,status,sent_at) VALUES ('i1','r1','c1','重庆','[\"a@example.com\"]','[\"重庆.docx\"]','success','2026-08-13 10:01')", []).expect("item");
        let detail = load_send_history_detail(&connection, "b").expect("history detail");
        assert_eq!(detail.batch.signature, "签名");
        assert_eq!(detail.runs.len(), 1);
        assert_eq!(detail.runs[0].mode, "test");
        assert_eq!(detail.runs[0].items[0].recipients, vec!["a@example.com"]);
    }

    #[test]
    fn task_match_detail_includes_rejected_messages_and_reasons() {
        let connection = Connection::open_in_memory().expect("database");
        crate::db::initialize(&connection).expect("schema");
        connection.execute("INSERT INTO tasks (id,name,status,start_time,deadline,poll_minutes,save_directory,filename_template,created_at) VALUES ('t','任务','active','2026-08-01','2026-08-10',30,'.','{原文件名}','2026-08-13')", []).expect("task");
        connection.execute("INSERT INTO messages (id,mailbox_id,external_id,sender,recipients,cc,subject,body,received_at,content_hash) VALUES ('m','box','e','other@example.com','[]','[]','报名材料','正文','2026-08-09T10:00:00Z','h')", []).expect("message");
        connection.execute("INSERT INTO matches (id,message_id,task_id,status,reason) VALUES ('x','m','t','unmatched','sender_not_in_task')", []).expect("match");
        connection.execute("INSERT INTO attachments (id,message_id,original_name,parse_status) VALUES ('a','m','报名表.docx','archive_only')", []).expect("attachment");
        let detail = load_task_match_detail(&connection, "t").expect("task detail");
        assert_eq!(detail.messages.len(), 1);
        assert_eq!(detail.messages[0].status, "unmatched");
        assert_eq!(detail.messages[0].message_id, "m");
        assert_eq!(detail.messages[0].attachments.len(), 1);
        assert_eq!(detail.messages[0].attachments[0].name, "报名表.docx");
        assert!(!detail.messages[0].attachments[0].can_open);
        assert_eq!(detail.unmatched, 1);
        assert_eq!(detail.processed_messages, 1);
        assert_eq!(detail.total_messages, 1);
    }

    #[test]
    fn task_feedback_page_returns_only_requested_rows_and_total() {
        let connection = Connection::open_in_memory().expect("database");
        crate::db::initialize(&connection).expect("schema");
        connection.execute("INSERT INTO tasks (id,name,status,deadline,poll_minutes,save_directory,filename_template,created_at) VALUES ('t','任务','active','2026-08-31',30,'.','旧','now')", []).expect("task");
        for index in 0..51 {
            let message_id = format!("m{index}");
            let match_id = format!("x{index}");
            connection.execute(
                "INSERT INTO messages (id,mailbox_id,external_id,sender,recipients,cc,subject,body,received_at,content_hash) VALUES (?1,'box',?2,'a@example.com','[]','[]',?3,'正文',printf('2026-08-13T10:%02d:00Z',?4),?5)",
                rusqlite::params![message_id, format!("e{index}"), format!("材料 {index}"), index, format!("h{index}")],
            ).expect("message");
            connection.execute(
                "INSERT INTO matches (id,message_id,task_id,status,reason) VALUES (?1,?2,'t','unmatched','sender_not_in_task')",
                rusqlite::params![match_id, message_id],
            ).expect("match");
        }

        let page = load_task_feedback_page(&connection, "t", "all", 2, 20).expect("page");
        assert_eq!(page.messages.len(), 20);
        assert_eq!(page.total, 51);
        assert_eq!(page.page_count, 3);
        assert_eq!(page.page, 2);
    }

    #[test]
    fn task_feedback_recomputes_from_distinct_confirmed_companies() {
        let connection = Connection::open_in_memory().expect("database");
        crate::db::initialize(&connection).expect("schema");
        connection.execute("INSERT INTO companies (id,name,aliases,created_at) VALUES ('c1','重庆','[]','now'),('c2','北京','[]','now')", []).expect("companies");
        connection.execute("INSERT INTO tasks (id,name,status,deadline,poll_minutes,save_directory,filename_template,created_at) VALUES ('t','任务','active','2026-08-31',30,'.','旧','now')", []).expect("task");
        connection
            .execute(
                "INSERT INTO task_companies (task_id,company_id) VALUES ('t','c1'),('t','c2')",
                [],
            )
            .expect("scope");
        for (id, external) in [("m1", "e1"), ("m2", "e2"), ("m3", "e3")] {
            connection.execute("INSERT INTO messages (id,mailbox_id,external_id,sender,recipients,cc,subject,body,received_at,content_hash) VALUES (?1,'box',?2,'a@example.com','[]','[]','材料','正文','2026-08-13','hash-' || ?1)", rusqlite::params![id, external]).expect("message");
        }
        connection.execute("INSERT INTO matches (id,message_id,task_id,company_id,status,reason) VALUES ('x1','m1','t','c1','confirmed','rule'),('x2','m2','t','c1','confirmed','rule'),('x3','m3','t',NULL,'needs_review','ambiguous')", []).expect("matches");
        connection
            .execute(
                "INSERT INTO match_candidates (match_id,company_id) VALUES ('x3','c2')",
                [],
            )
            .expect("candidate");

        recompute_task_feedback(&connection, "t").expect("recompute");
        assert_eq!(feedback_status(&connection, "t", "c1"), "confirmed");
        assert_eq!(feedback_status(&connection, "t", "c2"), "needs_review");
        assert_eq!(task_status(&connection, "t"), "active");

        connection
            .execute(
                "UPDATE matches SET status='confirmed', company_id='c2' WHERE id='x3'",
                [],
            )
            .expect("confirm second company");
        recompute_task_feedback(&connection, "t").expect("recompute complete");
        assert_eq!(feedback_status(&connection, "t", "c2"), "confirmed");
        assert_eq!(task_status(&connection, "t"), "completed");

        connection
            .execute(
                "UPDATE matches SET status='ignored' WHERE id IN ('x1','x2')",
                [],
            )
            .expect("ignore");
        recompute_task_feedback(&connection, "t").expect("recompute after ignore");
        assert_eq!(feedback_status(&connection, "t", "c1"), "pending");
    }

    #[test]
    fn deleting_a_task_keeps_its_matches_and_restore_pauses_it() {
        let mut connection = Connection::open_in_memory().expect("database");
        crate::db::initialize(&connection).expect("schema");
        connection
            .execute(
                "INSERT INTO companies (id,name,aliases,created_at) VALUES ('c','重庆','[]','now')",
                [],
            )
            .expect("company");
        connection.execute("INSERT INTO tasks (id,name,status,deadline,poll_minutes,save_directory,filename_template,created_at) VALUES ('t','任务','active','2026-08-31',30,'.','旧','now')", []).expect("task");
        connection
            .execute(
                "INSERT INTO task_companies (task_id,company_id) VALUES ('t','c')",
                [],
            )
            .expect("scope");
        connection.execute("INSERT INTO messages (id,mailbox_id,external_id,sender,recipients,cc,subject,body,received_at,content_hash) VALUES ('m','box','e','a@example.com','[]','[]','材料','正文','2026-08-13','h')", []).expect("message");
        connection.execute("INSERT INTO matches (id,message_id,task_id,company_id,status,reason) VALUES ('x','m','t','c','confirmed','rule')", []).expect("match");
        connection
            .execute(
                "INSERT INTO match_candidates (match_id,company_id) VALUES ('x','c')",
                [],
            )
            .expect("candidate");

        soft_delete_task_records(&mut connection, "t").expect("soft delete task");

        assert_eq!(task_status(&connection, "t"), "deleted");
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM matches WHERE task_id='t'",
                    [],
                    |row| row.get::<_, u32>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM match_candidates", [], |row| row
                    .get::<_, u32>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM messages WHERE id='m'", [], |row| row
                    .get::<_, u32>(
                    0
                ))
                .unwrap(),
            1
        );

        restore_task_records(&mut connection, "t").expect("restore task");
        assert_eq!(task_status(&connection, "t"), "paused");
    }

    fn feedback_status(connection: &Connection, task_id: &str, company_id: &str) -> String {
        connection
            .query_row(
                "SELECT feedback_status FROM task_companies WHERE task_id=?1 AND company_id=?2",
                rusqlite::params![task_id, company_id],
                |row| row.get(0),
            )
            .expect("feedback status")
    }

    fn task_status(connection: &Connection, task_id: &str) -> String {
        connection
            .query_row(
                "SELECT status FROM tasks WHERE id=?1",
                rusqlite::params![task_id],
                |row| row.get(0),
            )
            .expect("task status")
    }

    #[test]
    fn match_resolve_moves_an_unmatched_attachment_and_updates_progress() {
        let root =
            std::env::temp_dir().join(format!("unigather-resolve-{}", next_unique_id("test")));
        let unmatched = root.join("任务/未匹配");
        std::fs::create_dir_all(&unmatched).expect("unmatched directory");
        let source = unmatched.join("来源-报名表.docx");
        std::fs::write(&source, b"content").expect("source");
        let mut connection = Connection::open_in_memory().expect("database");
        crate::db::initialize(&connection).expect("schema");
        connection
            .execute(
                "INSERT INTO companies (id,name,aliases,created_at) VALUES ('c','重庆','[]','now')",
                [],
            )
            .expect("company");
        connection.execute("INSERT INTO tasks (id,name,material_name,status,deadline,poll_minutes,save_directory,filename_template,created_at) VALUES ('t','任务','统一报名表','active','2026-08-31',30,?1,'旧','now')", rusqlite::params![root.to_string_lossy()]).expect("task");
        connection
            .execute(
                "INSERT INTO task_companies (task_id,company_id) VALUES ('t','c')",
                [],
            )
            .expect("scope");
        connection.execute("INSERT INTO messages (id,mailbox_id,external_id,sender,recipients,cc,subject,body,received_at,content_hash) VALUES ('m','box','e','a@example.com','[]','[]','材料','正文','2026-08-13','h')", []).expect("message");
        connection.execute("INSERT INTO matches (id,message_id,task_id,status,reason) VALUES ('x','m','t','needs_review','ambiguous')", []).expect("match");
        connection
            .execute(
                "INSERT INTO match_candidates (match_id,company_id) VALUES ('x','c')",
                [],
            )
            .expect("candidate");
        connection.execute("INSERT INTO attachments (id,message_id,original_name,saved_path,parse_status) VALUES ('a','m','原件.docx',?1,'archive_only')", rusqlite::params![source.to_string_lossy()]).expect("attachment");

        resolve_match(&mut connection, "x", "confirmed", Some("t"), Some("c")).expect("resolve");
        let saved: String = connection
            .query_row(
                "SELECT saved_path FROM attachments WHERE id='a'",
                [],
                |row| row.get(0),
            )
            .expect("saved path");
        assert!(
            saved.ends_with("任务\\已匹配\\重庆-统一报名表.docx")
                || saved.ends_with("任务/已匹配/重庆-统一报名表.docx")
        );
        assert!(Path::new(&saved).exists());
        assert_eq!(feedback_status(&connection, "t", "c"), "confirmed");
        assert!(validate_archived_path(&connection, &saved).is_ok());
        assert!(
            validate_archived_path(&connection, &root.join("other.docx").to_string_lossy())
                .is_err()
        );
        std::fs::remove_dir_all(&root).expect("cleanup own directory");
    }

    #[test]
    fn dashboard_summary_combines_collection_and_formal_send_activity() {
        let connection = Connection::open_in_memory().expect("database");
        crate::db::initialize(&connection).expect("schema");
        connection.execute("INSERT INTO tasks (id,name,status,deadline,poll_minutes,save_directory,filename_template,created_at) VALUES ('t','报名任务','active','2026-08-31',30,'.','旧','now')", []).expect("task");
        connection.execute("INSERT INTO sync_runs (id,task_id,started_at,finished_at,status,processed,received) VALUES ('s','t',datetime('now'),datetime('now'),'completed',2,2)", []).expect("sync");
        connection.execute("INSERT INTO send_batches (id,name,source_dir,recursive,subject,body,created_at,updated_at) VALUES ('b','发送批次','.',0,'主题','正文',datetime('now'),datetime('now'))", []).expect("batch");
        connection.execute("INSERT INTO send_runs (id,batch_id,mode,started_at,finished_at,status,total,processed,success_count,failure_count) VALUES ('r','b','formal',datetime('now'),datetime('now'),'completed',1,1,1,0)", []).expect("run");
        connection.execute("INSERT INTO send_items (id,run_id,company_id,company_name,recipients,status,sent_at) VALUES ('i','r','c','重庆','[]','success',datetime('now'))", []).expect("item");
        let summary = load_dashboard_summary(&connection).expect("summary");
        assert_eq!(summary.collection_task_count, 1);
        assert_eq!(summary.active_collection_tasks, 1);
        assert_eq!(summary.send_batch_count, 1);
        assert_eq!(summary.today_sent_success, 1);
        assert_eq!(summary.recent_events.len(), 2);
    }

    #[test]
    fn task_sync_archive_routes_confirmed_and_unmatched_files() {
        let root = std::env::temp_dir().join(format!("unigather-sync-{}", next_unique_id("test")));
        let connection = Connection::open_in_memory().expect("database");
        crate::db::initialize(&connection).expect("schema");
        connection
            .execute(
                "INSERT INTO companies (id,name,aliases,created_at) VALUES ('c','重庆','[]','now')",
                [],
            )
            .expect("company");
        let rule = TaskSyncRule {
            task_id: "t".into(),
            task_name: "报名任务".into(),
            material_name: "统一报名表".into(),
            subject_keywords: Vec::new(),
            body_keywords: Vec::new(),
            companies: Vec::new(),
        };
        let message = message("a@example.com", "报名", "正文");
        let attachment = crate::mail::ParsedAttachment {
            name: "原件.docx".into(),
            mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                .into(),
            bytes: b"doc".to_vec(),
        };
        let matched = archive_task_attachment(
            &connection,
            &root,
            &rule,
            "confirmed",
            Some("c"),
            &message,
            &attachment,
        )
        .expect("matched archive");
        let unmatched = archive_task_attachment(
            &connection,
            &root,
            &rule,
            "unmatched",
            None,
            &message,
            &attachment,
        )
        .expect("unmatched archive");
        assert!(
            matched.ends_with("报名任务\\已匹配\\重庆-统一报名表.docx")
                || matched.ends_with("报名任务/已匹配/重庆-统一报名表.docx")
        );
        assert!(unmatched.contains("未匹配"));
        assert!(Path::new(&matched).exists());
        assert!(Path::new(&unmatched).exists());
        std::fs::remove_dir_all(&root).expect("cleanup own directory");
    }
}

pub fn run() {
    let database_path = production_database_path();
    let connection = Connection::open(&database_path)
        .unwrap_or_else(|error| panic!("open local database {}: {error}", database_path.display()));
    db::initialize(&connection).expect("initialize local database");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            database: Arc::new(Mutex::new(connection)),
            syncs: Arc::new(Mutex::new(HashMap::new())),
            sends: Arc::new(Mutex::new(HashMap::new())),
        })
        .invoke_handler(tauri::generate_handler![
            mailbox_test,
            mailbox_credentials_save,
            mailbox_credentials_status,
            mailbox_credentials_clear,
            mailbox_config_save,
            mailbox_config_get,
            send_batch_scan,
            send_batch_create,
            send_batch_match,
            send_batch_save,
            send_batch_items,
            send_batch_resolve,
            send_history,
            send_history_detail,
            mail_signature_get,
            mail_signature_save,
            send_test,
            send_start,
            send_retry,
            send_status,
            task_create,
            task_update,
            task_delete,
            task_restore,
            task_set_status,
            task_rename,
            task_list,
            dashboard_summary,
            task_match_detail,
            task_feedback_page,
            task_pending_companies,
            sync_start,
            sync_status,
            company_import,
            company_update,
            company_contact_create,
            company_contact_update,
            company_contact_delete,
            company_list,
            sync_history,
            mail_list,
            match_resolve,
            material_open,
            material_open_location,
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
