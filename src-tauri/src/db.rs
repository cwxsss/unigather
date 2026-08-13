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
          email TEXT NOT NULL UNIQUE, contact_name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, deadline TEXT NOT NULL,
          start_time TEXT NOT NULL DEFAULT '', poll_minutes INTEGER NOT NULL, save_directory TEXT NOT NULL, filename_template TEXT NOT NULL,
          material_name TEXT NOT NULL DEFAULT '',
          subject_keywords TEXT NOT NULL DEFAULT '[]', body_keywords TEXT NOT NULL DEFAULT '[]',
          ai_enabled INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, deleted_previous_status TEXT, created_at TEXT NOT NULL
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
        CREATE TABLE IF NOT EXISTS match_candidates (
          match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
          company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          PRIMARY KEY(match_id, company_id)
        );
        CREATE INDEX IF NOT EXISTS idx_match_candidates_company ON match_candidates(company_id);
        CREATE TABLE IF NOT EXISTS sync_runs (
          id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, received INTEGER NOT NULL DEFAULT 0,
          matched INTEGER NOT NULL DEFAULT 0, needs_review INTEGER NOT NULL DEFAULT 0, error TEXT,
          task_id TEXT, status TEXT NOT NULL DEFAULT 'completed', processed INTEGER NOT NULL DEFAULT 0,
          duplicates INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS send_runs (
          id TEXT PRIMARY KEY, task_id TEXT, started_at TEXT NOT NULL, finished_at TEXT,
          status TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0,
          success_count INTEGER NOT NULL DEFAULT 0, failure_count INTEGER NOT NULL DEFAULT 0, error TEXT,
          mode TEXT NOT NULL DEFAULT 'unknown'
        );
        CREATE TABLE IF NOT EXISTS send_items (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES send_runs(id) ON DELETE CASCADE,
          company_id TEXT NOT NULL, company_name TEXT NOT NULL, recipients TEXT NOT NULL,
          attachments TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending',
          error TEXT, sent_at TEXT
        );
        CREATE TABLE IF NOT EXISTS send_batches (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, source_dir TEXT NOT NULL,
          recursive INTEGER NOT NULL DEFAULT 0, subject TEXT NOT NULL, body TEXT NOT NULL,
          signature TEXT NOT NULL DEFAULT '',
          cc TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'draft',
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS send_batch_items (
          id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES send_batches(id) ON DELETE CASCADE,
          file_name TEXT NOT NULL, file_path TEXT NOT NULL, company_id TEXT NOT NULL DEFAULT '',
          company_name TEXT NOT NULL DEFAULT '', recipients TEXT NOT NULL DEFAULT '[]',
          match_method TEXT NOT NULL DEFAULT '', confidence REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'unmatched', error TEXT NOT NULL DEFAULT ''
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
    let has_contact_phone: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('company_contacts') WHERE name = 'phone'",
        [],
        |row| row.get(0),
    )?;
    if has_contact_phone == 0 {
        connection.execute(
            "ALTER TABLE company_contacts ADD COLUMN phone TEXT NOT NULL DEFAULT ''",
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
    let has_material_name: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name = 'material_name'",
        [],
        |row| row.get(0),
    )?;
    if has_material_name == 0 {
        connection.execute(
            "ALTER TABLE tasks ADD COLUMN material_name TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    for (column, definition) in [("deleted_at", "TEXT"), ("deleted_previous_status", "TEXT")] {
        let exists: i64 = connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name = ?1",
            [column],
            |row| row.get(0),
        )?;
        if exists == 0 {
            connection.execute(
                &format!("ALTER TABLE tasks ADD COLUMN {column} {definition}"),
                [],
            )?;
        }
    }
    let has_send_batch_id: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('send_runs') WHERE name = 'batch_id'",
        [],
        |row| row.get(0),
    )?;
    if has_send_batch_id == 0 {
        connection.execute("ALTER TABLE send_runs ADD COLUMN batch_id TEXT", [])?;
    }
    for (table, column, definition) in [
        ("send_batches", "signature", "TEXT NOT NULL DEFAULT ''"),
        ("send_runs", "mode", "TEXT NOT NULL DEFAULT 'unknown'"),
        ("sync_runs", "task_id", "TEXT"),
        ("sync_runs", "status", "TEXT NOT NULL DEFAULT 'completed'"),
        ("sync_runs", "processed", "INTEGER NOT NULL DEFAULT 0"),
        ("sync_runs", "duplicates", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        let exists: i64 = connection.query_row(
            &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?1"),
            [column],
            |row| row.get(0),
        )?;
        if exists == 0 {
            connection.execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
                [],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initializes_task_material_and_match_candidate_schema() {
        let connection = Connection::open_in_memory().expect("database");
        initialize(&connection).expect("schema");
        let material_columns: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name='material_name'",
                [],
                |row| row.get(0),
            )
            .expect("material column");
        let candidate_tables: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='match_candidates'",
                [],
                |row| row.get(0),
            )
            .expect("candidate table");
        assert_eq!(material_columns, 1);
        assert_eq!(candidate_tables, 1);
    }
}
