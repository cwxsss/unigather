use crate::archive;
use chrono::{DateTime, FixedOffset, NaiveDateTime};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialVersion {
    pub task_id: String,
    pub task_name: String,
    pub company_id: String,
    pub company_name: String,
    pub message_id: String,
    pub attachment_id: String,
    pub name: String,
    pub received_at: String,
    pub parse_status: String,
    pub saved_path: String,
    pub history_path: String,
    pub is_current: bool,
    #[serde(skip)]
    source_path: String,
    #[serde(skip)]
    save_directory: String,
}

/// The original attachment name is the identity, not the renamed archive file.
/// Sort by receipt time before choosing winners, so late downloads of old mail
/// cannot replace newer feedback. A missing newest file never revives an old one.
pub fn load(
    connection: &Connection,
    task_id: &str,
    company_id: &str,
) -> Result<Vec<MaterialVersion>, String> {
    let mut statement = connection.prepare(
        "SELECT t.id,t.name,c.id,c.name,msg.id,a.id,a.original_name,msg.received_at,a.parse_status,COALESCE(a.saved_path,''),t.save_directory,COALESCE(cp.history_path,''),COALESCE(cp.current_path,'') FROM matches m JOIN messages msg ON msg.id=m.message_id JOIN attachments a ON a.message_id=msg.id JOIN companies c ON c.id=m.company_id JOIN tasks t ON t.id=m.task_id LEFT JOIN material_copies cp ON cp.task_id=t.id AND cp.attachment_id=a.id WHERE m.task_id=?1 AND m.status='confirmed' AND (?2='' OR c.id=?2) ORDER BY julianday(msg.received_at) DESC,msg.received_at DESC,msg.id DESC,a.rowid DESC"
    ).map_err(|error| error.to_string())?;
    let raw = statement
        .query_map(params![task_id, company_id], |row| {
            let source_path: String = row.get(9)?;
            let history_path: String = row.get(11)?;
            let current_path: String = row.get(12)?;
            Ok(MaterialVersion {
                task_id: row.get(0)?,
                task_name: row.get(1)?,
                company_id: row.get(2)?,
                company_name: row.get(3)?,
                message_id: row.get(4)?,
                attachment_id: row.get(5)?,
                name: row.get(6)?,
                received_at: row.get(7)?,
                parse_status: row.get(8)?,
                save_directory: row.get(10)?,
                history_path: if history_path.is_empty() {
                    source_path.clone()
                } else {
                    history_path
                },
                saved_path: if current_path.is_empty() {
                    source_path.clone()
                } else {
                    current_path
                },
                source_path,
                is_current: false,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut seen = HashSet::new();
    Ok(raw
        .into_iter()
        .map(|mut version| {
            version.is_current = seen.insert((
                version.company_id.clone(),
                version.name.trim().to_lowercase(),
            ));
            if !version.is_current {
                version.saved_path = version.history_path.clone();
            }
            version
        })
        .collect())
}

fn token(value: &str) -> String {
    let hash = value.bytes().fold(0xcbf29ce484222325u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    });
    format!("{hash:016x}")
}

fn stamp(value: &str) -> String {
    DateTime::parse_from_rfc3339(value)
        .map(|date| {
            date.with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap())
                .format("%Y-%m-%d_%H%M%S")
                .to_string()
        })
        .or_else(|_| {
            NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S")
                .map(|date| date.format("%Y-%m-%d_%H%M%S").to_string())
        })
        .or_else(|_| {
            NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S")
                .map(|date| date.format("%Y-%m-%d_%H%M%S").to_string())
        })
        .unwrap_or_else(|_| archive::sanitize_segment(value))
}

fn disambiguate(name: &str, identity: &str) -> String {
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(name);
    let suffix = &token(identity)[..8];
    match path.extension().and_then(|value| value.to_str()) {
        Some(extension) => format!("{stem}-{suffix}.{extension}"),
        None => format!("{stem}-{suffix}"),
    }
}

fn same_path(left: &Path, right: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        left.to_string_lossy().replace('\\', "/").to_lowercase()
            == right.to_string_lossy().replace('\\', "/").to_lowercase()
    }
    #[cfg(not(target_os = "windows"))]
    {
        left == right
    }
}

fn safe_segment(value: &str) -> String {
    let segment = archive::sanitize_segment(value);
    let base = segment
        .split('.')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_uppercase();
    let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (base.len() == 4
            && (base.starts_with("COM") || base.starts_with("LPT"))
            && matches!(base.as_bytes()[3], b'1'..=b'9'));
    if reserved {
        format!("_{segment}")
    } else {
        segment
    }
}

/// Materialize a readable view without moving or deleting legacy originals.
/// History copies are immutable; every current replacement has a history copy.
fn copy_atomic(source: &Path, target: &Path, identity: &str) -> Result<(), String> {
    let parent = target.parent().ok_or("材料目标目录不存在")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let pending = parent.join(format!(".unigather-{}.pending", token(identity)));
    let copied = fs::copy(source, &pending).map_err(|error| error.to_string())?;
    if fs::metadata(source)
        .map_err(|error| error.to_string())?
        .len()
        != copied
    {
        return Err("材料副本大小校验失败".into());
    }
    fs::rename(pending, target).map_err(|error| error.to_string())
}

pub fn refresh_task(connection: &Connection, task_id: &str) -> Result<(), String> {
    let versions = load(connection, task_id, "")?;
    let root = if let Some(version) = versions.first() {
        let base = archive::task_root(Path::new(&version.save_directory), &version.task_name);
        let other_roots = connection
            .prepare("SELECT name,save_directory FROM tasks WHERE id!=?1")
            .map_err(|error| error.to_string())?
            .query_map(params![task_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        if other_roots.iter().any(|(name, directory)| {
            same_path(&archive::task_root(Path::new(directory), name), &base)
        }) {
            Some(base.with_file_name(format!(
                "{}-{}",
                archive::sanitize_segment(&version.task_name),
                &token(task_id)[..8]
            )))
        } else {
            Some(base)
        }
    } else {
        None
    };
    if let Some(root) = &root {
        fs::create_dir_all(root.join("当前材料")).map_err(|error| error.to_string())?;
    }
    let old_paths = connection.prepare("SELECT attachment_id,current_path FROM material_copies WHERE task_id=?1 AND current_path!=''")
        .map_err(|error| error.to_string())?
        .query_map(params![task_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    let mut copies = Vec::new();
    for version in &versions {
        let source = if Path::new(&version.history_path).is_file() {
            Path::new(&version.history_path)
        } else if Path::new(&version.source_path).is_file() {
            Path::new(&version.source_path)
        } else {
            Path::new(&version.saved_path)
        };
        if !source.is_file() {
            continue;
        }
        let root = root.as_ref().unwrap();
        let mut company = safe_segment(&version.company_name);
        if versions.iter().any(|other| {
            other.company_id != version.company_id
                && safe_segment(&other.company_name).to_lowercase() == company.to_lowercase()
        }) {
            company = format!("{company}-{}", &token(&version.company_id)[..8]);
        }
        let mut name = safe_segment(&version.name);
        if versions.iter().any(|other| {
            other.company_id == version.company_id
                && other.name.trim().to_lowercase() != version.name.trim().to_lowercase()
                && safe_segment(&other.name).to_lowercase() == name.to_lowercase()
        }) {
            name = disambiguate(&name, &version.name);
        }
        let history_directory = root.join("历史版本").join(&company).join(format!(
            "{}-{}",
            stamp(&version.received_at),
            &token(&version.message_id)[..8]
        ));
        let history_name = if versions.iter().any(|other| {
            other.message_id == version.message_id
                && other.attachment_id != version.attachment_id
                && safe_segment(&other.name).to_lowercase()
                    == safe_segment(&version.name).to_lowercase()
        }) {
            disambiguate(&name, &version.attachment_id)
        } else {
            name.clone()
        };
        let history = history_directory.join(history_name);
        fs::create_dir_all(&history_directory).map_err(|error| error.to_string())?;
        if !history.exists() {
            copy_atomic(source, &history, &version.attachment_id)
                .map_err(|error| format!("无法保留材料历史版本：{error}"))?;
        }
        let current = if version.is_current {
            root.join("当前材料")
                .join(&company)
                .join(format!("{company}-{name}"))
        } else {
            PathBuf::new()
        };
        copies.push((version.attachment_id.clone(), history, current));
    }
    // All histories are safely written before updating any current material.
    for (id, history, current) in &copies {
        if current.as_os_str().is_empty() {
            continue;
        }
        fs::create_dir_all(current.parent().unwrap()).map_err(|error| error.to_string())?;
        let unchanged = old_paths
            .iter()
            .any(|(old_id, old_path)| old_id == id && same_path(Path::new(old_path), current))
            && current.is_file();
        if !unchanged {
            if let Some((old_id, old_path)) = old_paths
                .iter()
                .find(|(_, path)| same_path(Path::new(path), current) && current.is_file())
            {
                let old_history: String = connection.query_row("SELECT history_path FROM material_copies WHERE task_id=?1 AND attachment_id=?2", params![task_id, old_id], |row| row.get(0)).map_err(|error| error.to_string())?;
                let edited = fs::read(old_path).map_err(|error| error.to_string())?;
                if fs::read(&old_history).ok().as_deref() != Some(edited.as_slice()) {
                    let parent = Path::new(&old_history).parent().ok_or("历史目录不存在")?;
                    let backup = archive::unique_destination(
                        parent,
                        &format!(
                            "本地修改-{}",
                            current.file_name().unwrap().to_string_lossy()
                        ),
                    );
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                    fs::write(backup, edited)
                        .map_err(|error| format!("无法保留本地修改：{error}"))?;
                }
            }
            copy_atomic(history, current, id)
                .map_err(|error| format!("无法更新当前材料（文件可能被占用）：{error}"))?;
        }
    }
    // Reassigned/rejected materials must disappear from the current view.
    // Move only registered copies, preserving them in history instead of deleting.
    for (id, path) in &old_paths {
        if copies
            .iter()
            .any(|(_, _, current)| same_path(current, Path::new(path)))
            || !Path::new(path).is_file()
        {
            continue;
        }
        let original_history: String = connection
            .query_row(
                "SELECT history_path FROM material_copies WHERE task_id=?1 AND attachment_id=?2",
                params![task_id, id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let parent = Path::new(&original_history)
            .parent()
            .ok_or("历史目录不存在")?;
        let target = archive::unique_destination(
            parent,
            &format!(
                "已撤回-{}",
                Path::new(path).file_name().unwrap().to_string_lossy()
            ),
        );
        fs::rename(path, target).map_err(|error| format!("无法归档已撤回的当前材料：{error}"))?;
    }
    connection
        .execute_batch("SAVEPOINT material_projection")
        .map_err(|error| error.to_string())?;
    let result = (|| {
        connection
            .execute(
                "UPDATE material_copies SET current_path='' WHERE task_id=?1",
                params![task_id],
            )
            .map_err(|error| error.to_string())?;
        for (id, history, current) in &copies {
            connection.execute("INSERT INTO material_copies(task_id,attachment_id,history_path,current_path) VALUES(?1,?2,?3,?4) ON CONFLICT(task_id,attachment_id) DO UPDATE SET history_path=excluded.history_path,current_path=excluded.current_path", params![task_id, id, history.to_string_lossy(), current.to_string_lossy()]).map_err(|error| error.to_string())?;
        }
        Ok::<(), String>(())
    })();
    if result.is_err() {
        let _ = connection.execute_batch("ROLLBACK TO material_projection");
    }
    connection
        .execute_batch("RELEASE material_projection")
        .map_err(|error| error.to_string())?;
    result?;
    if let Some(root) = &root {
        fs::write(
            root.join(".unigather-material-view"),
            b"current-materials-v1",
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Connection, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "unigather-material-versions-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("raw")).unwrap();
        let connection = Connection::open_in_memory().unwrap();
        crate::db::initialize(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO companies(id,name,created_at) VALUES('c','陕西','now')",
                [],
            )
            .unwrap();
        connection.execute("INSERT INTO tasks(id,name,status,deadline,poll_minutes,save_directory,filename_template,created_at) VALUES('t','目录收集','active','2026-12-31',30,?1,'','now')", params![root.to_string_lossy()]).unwrap();
        (connection, root)
    }

    fn mail(connection: &Connection, id: &str, time: &str) {
        connection.execute("INSERT INTO messages(id,mailbox_id,external_id,sender,recipients,cc,subject,body,received_at,content_hash) VALUES(?1,'box',?1,'person@example.com','[]','[]','反馈','正文',?2,?1)", params![id, time]).unwrap();
        connection.execute("INSERT INTO matches(id,message_id,task_id,company_id,status,reason) VALUES(?1,?1,'t','c','confirmed','rule')", params![id]).unwrap();
    }

    fn attachment(
        connection: &Connection,
        root: &Path,
        id: &str,
        message: &str,
        name: &str,
        content: Option<&[u8]>,
    ) {
        let path = root.join("raw").join(id);
        if let Some(content) = content {
            fs::write(&path, content).unwrap();
        }
        connection.execute("INSERT INTO attachments(id,message_id,original_name,saved_path,parse_status) VALUES(?1,?2,?3,?4,'archive_only')", params![id, message, name, path.to_string_lossy()]).unwrap();
    }

    #[test]
    fn same_name_updates_supplements_survive_and_refresh_is_idempotent() {
        let (connection, root) = fixture();
        mail(&connection, "first", "2026-09-29T01:00:00Z");
        attachment(&connection, &root, "a1", "first", "目录.xlsx", Some(b"old"));
        attachment(
            &connection,
            &root,
            "b1",
            "first",
            "补充.xlsx",
            Some(b"supplement"),
        );
        refresh_task(&connection, "t").unwrap();
        let old = load(&connection, "t", "c")
            .unwrap()
            .into_iter()
            .find(|v| v.name == "目录.xlsx")
            .unwrap();
        fs::write(&old.saved_path, b"locally edited").unwrap();
        mail(&connection, "second", "2026-09-29T10:00:00+08:00");
        attachment(
            &connection,
            &root,
            "a2",
            "second",
            "目录.xlsx",
            Some(b"new"),
        );
        mail(&connection, "body-only", "2026-09-29T03:00:00Z");
        // Existing body-only mail archiving is independent of real attachments.
        attachment(
            &connection,
            &root,
            "body",
            "body-only",
            "邮件正文.docx",
            Some(b"body"),
        );
        refresh_task(&connection, "t").unwrap();
        let versions = load(&connection, "t", "c").unwrap();
        assert_eq!(versions.iter().filter(|v| v.is_current).count(), 3);
        let supplement = versions.iter().find(|v| v.attachment_id == "b1").unwrap();
        assert!(supplement.is_current);
        assert_eq!(fs::read(&supplement.saved_path).unwrap(), b"supplement");
        let newest = versions.iter().find(|v| v.attachment_id == "a2").unwrap();
        assert_eq!(fs::read(&newest.saved_path).unwrap(), b"new");
        assert_eq!(newest.saved_path, old.saved_path);
        assert_eq!(fs::read(&old.history_path).unwrap(), b"old");
        let history_parent = Path::new(&old.history_path).parent().unwrap();
        assert!(fs::read_dir(history_parent)
            .unwrap()
            .any(
                |entry| fs::read(entry.unwrap().path()).ok().as_deref() == Some(b"locally edited")
            ));
        assert_eq!(fs::read(root.join("raw/a1")).unwrap(), b"old");
        let paths: Vec<_> = versions
            .iter()
            .map(|v| (&v.attachment_id, &v.saved_path, &v.history_path))
            .collect();
        refresh_task(&connection, "t").unwrap();
        let again = load(&connection, "t", "c").unwrap();
        assert_eq!(
            paths,
            again
                .iter()
                .map(|v| (&v.attachment_id, &v.saved_path, &v.history_path))
                .collect::<Vec<_>>()
        );
        // Two original attachments plus the user's local edit, no extra copy.
        assert_eq!(fs::read_dir(history_parent).unwrap().count(), 3);
    }

    #[test]
    fn receipt_time_controls_latest_and_missing_file_does_not_restore_an_old_version() {
        let (connection, root) = fixture();
        mail(&connection, "initial", "2026-09-29T02:00:00Z");
        attachment(
            &connection,
            &root,
            "initial",
            "initial",
            "report.xlsx",
            Some(b"initial"),
        );
        refresh_task(&connection, "t").unwrap();
        let initial_path = load(&connection, "t", "c").unwrap().remove(0).saved_path;
        mail(&connection, "new", "2026-09-29T12:00:00+08:00");
        attachment(&connection, &root, "a2", "new", "REPORT.xlsx", None);
        // The older message was downloaded later and uses a different time zone.
        mail(&connection, "late-old", "2026-09-29T03:00:00Z");
        attachment(
            &connection,
            &root,
            "a1",
            "late-old",
            "report.xlsx",
            Some(b"old"),
        );
        refresh_task(&connection, "t").unwrap();
        let versions = load(&connection, "t", "c").unwrap();
        let current: Vec<_> = versions.iter().filter(|v| v.is_current).collect();
        assert_eq!(current.len(), 1);
        assert_eq!(current[0].attachment_id, "a2");
        assert!(!Path::new(&current[0].saved_path).exists());
        assert!(!Path::new(&initial_path).exists());
        assert!(Path::new(
            &versions
                .iter()
                .find(|v| v.attachment_id == "a1")
                .unwrap()
                .history_path
        )
        .is_file());
    }

    #[test]
    fn directory_change_copies_files_and_rejected_material_leaves_current_view() {
        let (connection, root) = fixture();
        mail(&connection, "m", "2026-09-29T01:00:00Z");
        attachment(&connection, &root, "a", "m", "目录.xlsx", Some(b"material"));
        refresh_task(&connection, "t").unwrap();
        let old = load(&connection, "t", "c").unwrap().remove(0);
        let directory = root.join("new destination");
        connection
            .execute(
                "UPDATE tasks SET save_directory=?1 WHERE id='t'",
                params![directory.to_string_lossy()],
            )
            .unwrap();
        refresh_task(&connection, "t").unwrap();
        let current = load(&connection, "t", "c").unwrap().remove(0);
        assert!(Path::new(&current.saved_path).starts_with(&directory));
        assert_eq!(fs::read(&current.saved_path).unwrap(), b"material");
        assert!(Path::new(&old.history_path).exists());
        assert!(root.join("raw/a").exists());
        connection
            .execute("UPDATE matches SET status='ignored' WHERE id='m'", [])
            .unwrap();
        refresh_task(&connection, "t").unwrap();
        assert!(load(&connection, "t", "c").unwrap().is_empty());
        assert!(!Path::new(&current.saved_path).exists());
        assert!(Path::new(&current.history_path).exists());
    }

    #[test]
    fn case_changes_and_sanitized_filename_collisions_keep_the_correct_current_files() {
        let (connection, root) = fixture();
        mail(&connection, "old", "2026-09-29T01:00:00Z");
        attachment(
            &connection,
            &root,
            "old",
            "old",
            "REPORT.xlsx",
            Some(b"old"),
        );
        refresh_task(&connection, "t").unwrap();
        mail(&connection, "new", "2026-09-29T02:00:00Z");
        attachment(
            &connection,
            &root,
            "new",
            "new",
            "report.xlsx",
            Some(b"new"),
        );
        attachment(&connection, &root, "q", "new", "a?.xlsx", Some(b"question"));
        attachment(&connection, &root, "s", "new", "a*.xlsx", Some(b"star"));
        attachment(
            &connection,
            &root,
            "reserved",
            "new",
            "CON.xlsx",
            Some(b"reserved"),
        );
        refresh_task(&connection, "t").unwrap();
        let current: Vec<_> = load(&connection, "t", "c")
            .unwrap()
            .into_iter()
            .filter(|v| v.is_current)
            .collect();
        assert_eq!(current.len(), 4);
        assert_eq!(
            current
                .iter()
                .map(|v| &v.saved_path)
                .collect::<HashSet<_>>()
                .len(),
            4
        );
        let latest = current.iter().find(|v| v.attachment_id == "new").unwrap();
        assert_eq!(fs::read(&latest.saved_path).unwrap(), b"new");
        assert_eq!(
            fs::read_dir(Path::new(&latest.saved_path).parent().unwrap())
                .unwrap()
                .count(),
            4
        );
        for version in current {
            assert!(Path::new(&version.history_path).is_file());
        }
    }

    #[test]
    fn tasks_with_the_same_display_name_have_separate_current_materials() {
        let (connection, root) = fixture();
        connection.execute("INSERT INTO tasks(id,name,status,deadline,poll_minutes,save_directory,filename_template,created_at) VALUES('t2','目录收集','active','2026-12-31',30,?1,'','now')", params![root.to_string_lossy()]).unwrap();
        mail(&connection, "first-task", "2026-09-29T01:00:00Z");
        attachment(
            &connection,
            &root,
            "first",
            "first-task",
            "目录.xlsx",
            Some(b"task one"),
        );
        mail(&connection, "second-task", "2026-09-29T02:00:00Z");
        attachment(
            &connection,
            &root,
            "second",
            "second-task",
            "目录.xlsx",
            Some(b"task two"),
        );
        connection
            .execute("UPDATE matches SET task_id='t2' WHERE id='second-task'", [])
            .unwrap();
        refresh_task(&connection, "t").unwrap();
        refresh_task(&connection, "t2").unwrap();
        let first = load(&connection, "t", "c").unwrap().remove(0);
        let second = load(&connection, "t2", "c").unwrap().remove(0);
        assert_ne!(first.saved_path, second.saved_path);
        assert_eq!(fs::read(first.saved_path).unwrap(), b"task one");
        assert_eq!(fs::read(second.saved_path).unwrap(), b"task two");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn locked_current_file_keeps_previous_bytes_and_retries_after_unlocking() {
        use std::os::windows::fs::OpenOptionsExt;
        let (connection, root) = fixture();
        mail(&connection, "old", "2026-09-29T01:00:00Z");
        attachment(&connection, &root, "old", "old", "目录.xlsx", Some(b"old"));
        refresh_task(&connection, "t").unwrap();
        let current = load(&connection, "t", "c").unwrap().remove(0);
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&current.saved_path)
            .unwrap();
        mail(&connection, "new", "2026-09-29T02:00:00Z");
        attachment(&connection, &root, "new", "new", "目录.xlsx", Some(b"new"));
        assert!(refresh_task(&connection, "t").is_err());
        drop(lock);
        assert_eq!(fs::read(&current.saved_path).unwrap(), b"old");
        refresh_task(&connection, "t").unwrap();
        assert_eq!(fs::read(&current.saved_path).unwrap(), b"new");
        assert_eq!(fs::read(&current.history_path).unwrap(), b"old");
    }
}
