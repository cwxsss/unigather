mod db;
mod models;

use models::{MailboxConfig, SyncResult, TaskInput, TaskSummary};
use rusqlite::Connection;
use std::sync::Mutex;
use tauri::State;

pub struct AppState {
    pub database: Mutex<Connection>,
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
fn task_create(input: TaskInput, state: State<'_, AppState>) -> Result<TaskSummary, String> {
    let id = format!("task-{}", chrono_like_id());
    let name = input.name.clone();
    let deadline = input.deadline.clone();
    let company_count = input.company_ids.len() as u32;
    let connection = state.database.lock().map_err(|e| e.to_string())?;
    connection
        .execute(
            "INSERT INTO tasks (id,name,status,deadline,poll_minutes,save_directory,filename_template,subject_keywords,body_keywords,ai_enabled,created_at) VALUES (?1,?2,'active',?3,?4,?5,?6,?7,?8,?9,datetime('now'))",
            rusqlite::params![id, name, deadline, input.poll_minutes, input.save_directory, input.filename_template, serde_json::to_string(&input.subject_keywords).map_err(|e| e.to_string())?, serde_json::to_string(&input.body_keywords).map_err(|e| e.to_string())?, input.ai_enabled],
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
fn task_list(state: State<'_, AppState>) -> Result<Vec<TaskSummary>, String> {
    let connection = state.database.lock().map_err(|e| e.to_string())?;
    let mut statement = connection
        .prepare("SELECT id,name,status,deadline FROM tasks ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(TaskSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                status: row.get(2)?,
                deadline: row.get(3)?,
                total_companies: 0,
                confirmed_companies: 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.map(|row| row.map_err(|e| e.to_string())).collect()
}

#[tauri::command]
fn sync_run(_task_id: String) -> Result<SyncResult, String> {
    Ok(SyncResult {
        run_id: format!("sync-{}", chrono_like_id()),
        received: 0,
        matched: 0,
        needs_review: 0,
        errors: vec!["邮箱适配器尚未连接".into()],
    })
}

#[tauri::command]
fn company_import(csv_text: String, state: State<'_, AppState>) -> Result<u32, String> {
    let connection = state.database.lock().map_err(|e| e.to_string())?;
    let mut imported = 0u32;
    for (index, line) in csv_text.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || (index == 0 && trimmed.contains("单位")) {
            continue;
        }
        let mut columns = trimmed.splitn(2, ',');
        let name = columns.next().unwrap_or_default().trim();
        let emails = columns.next().unwrap_or_default();
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
        for email in emails.split([';', '，', ' ', '\t']) {
            let email = email.trim();
            if email.is_empty() {
                continue;
            }
            connection
                .execute(
                    "INSERT OR IGNORE INTO company_contacts (id,company_id,email,created_at) VALUES (?1,?2,?3,datetime('now'))",
                    rusqlite::params![format!("contact-{}-{}", chrono_like_id(), imported), company_id, email],
                )
                .map_err(|e| e.to_string())?;
        }
        imported += 1;
    }
    Ok(imported)
}

#[tauri::command]
fn sync_history(_task_id: Option<String>) -> Result<Vec<SyncResult>, String> {
    Ok(Vec::new())
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
    Ok(path)
}

#[tauri::command]
fn report_export(_task_id: String, _status: String) -> Result<String, String> {
    Ok("待反馈清单导出接口已就绪".to_string())
}

#[tauri::command]
fn settings_update(_key: String, _value: String) -> Result<(), String> {
    Ok(())
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
        .manage(AppState {
            database: Mutex::new(connection),
        })
        .invoke_handler(tauri::generate_handler![
            mailbox_test,
            task_create,
            task_delete,
            task_list,
            sync_run,
            company_import,
            sync_history,
            match_resolve,
            material_open,
            report_export,
            settings_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running UniGather");
}
