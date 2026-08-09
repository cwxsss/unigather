use rusqlite::{Connection, Result};

pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS companies (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS company_contacts (
          id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          email TEXT NOT NULL UNIQUE, contact_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, deadline TEXT NOT NULL,
          start_time TEXT NOT NULL DEFAULT '', poll_minutes INTEGER NOT NULL, save_directory TEXT NOT NULL, filename_template TEXT NOT NULL,
          subject_keywords TEXT NOT NULL DEFAULT '[]', body_keywords TEXT NOT NULL DEFAULT '[]',
          ai_enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS task_companies (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          feedback_status TEXT NOT NULL DEFAULT 'pending',
          PRIMARY KEY(task_id, company_id)
        );
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL, external_id TEXT NOT NULL,
          sender TEXT NOT NULL, recipients TEXT NOT NULL, cc TEXT NOT NULL, subject TEXT NOT NULL,
          body TEXT NOT NULL, received_at TEXT NOT NULL, content_hash TEXT NOT NULL,
          UNIQUE(mailbox_id, external_id, content_hash)
        );
        CREATE TABLE IF NOT EXISTS attachments (
          id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          original_name TEXT NOT NULL, saved_name TEXT, saved_path TEXT, mime_type TEXT,
          extracted_text TEXT, parse_status TEXT NOT NULL DEFAULT 'pending'
        );
        CREATE TABLE IF NOT EXISTS matches (
          id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          task_id TEXT REFERENCES tasks(id), company_id TEXT REFERENCES companies(id),
          status TEXT NOT NULL, reason TEXT NOT NULL, confidence REAL, reviewed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS sync_runs (
          id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, received INTEGER NOT NULL DEFAULT 0,
          matched INTEGER NOT NULL DEFAULT 0, needs_review INTEGER NOT NULL DEFAULT 0, error TEXT
        );
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        "#,
    )?;
    let has_contact_name: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('company_contacts') WHERE name = 'contact_name'",
        [],
        |row| row.get(0),
    )?;
    if has_contact_name == 0 {
        connection.execute(
            "ALTER TABLE company_contacts ADD COLUMN contact_name TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    let has_start_time: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name = 'start_time'",
        [],
        |row| row.get(0),
    )?;
    if has_start_time == 0 {
        connection.execute(
            "ALTER TABLE tasks ADD COLUMN start_time TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    Ok(())
}
