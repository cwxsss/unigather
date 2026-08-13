use chrono::{DateTime, Local, NaiveDateTime};
use docx_rs::{Docx, Paragraph, Run};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveBucket {
    Matched,
    Unmatched,
}

pub fn sanitize_segment(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches([' ', '.']);
    if cleaned.is_empty() {
        "未命名".to_string()
    } else {
        cleaned.to_string()
    }
}

pub fn task_root(save_directory: &Path, task_name: &str) -> PathBuf {
    save_directory.join(sanitize_segment(task_name))
}

pub fn bucket_directory(root: &Path, bucket: ArchiveBucket) -> PathBuf {
    root.join(match bucket {
        ArchiveBucket::Matched => "已匹配",
        ArchiveBucket::Unmatched => "未匹配",
    })
}

pub fn matched_name(company: &str, material: &str, original: &str) -> String {
    let extension = Path::new(original)
        .extension()
        .and_then(|value| value.to_str())
        .map(sanitize_segment)
        .filter(|value| value != "未命名");
    let base = format!(
        "{}-{}",
        sanitize_segment(company),
        sanitize_segment(material)
    );
    extension
        .map(|value| format!("{base}.{value}"))
        .unwrap_or(base)
}

pub fn unmatched_name(received_at: &str, sender: &str, original: &str) -> String {
    let stamp = DateTime::parse_from_rfc3339(received_at)
        .map(|value| value.format("%Y%m%d-%H%M%S").to_string())
        .or_else(|_| {
            NaiveDateTime::parse_from_str(received_at, "%Y-%m-%dT%H:%M:%S")
                .map(|value| value.format("%Y%m%d-%H%M%S").to_string())
        })
        .or_else(|_| {
            NaiveDateTime::parse_from_str(received_at, "%Y-%m-%d %H:%M:%S")
                .map(|value| value.format("%Y%m%d-%H%M%S").to_string())
        })
        .unwrap_or_else(|_| Local::now().format("%Y%m%d-%H%M%S").to_string());
    format!(
        "{}-{}-{}",
        stamp,
        sanitize_segment(sender),
        sanitize_segment(original)
    )
}

pub fn unique_destination(directory: &Path, filename: &str) -> PathBuf {
    let initial = directory.join(filename);
    if !initial.exists() {
        return initial;
    }
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("未命名");
    let extension = path.extension().and_then(|value| value.to_str());
    for suffix in 2u64.. {
        let candidate = match extension {
            Some(extension) => directory.join(format!("{stem}-{suffix}.{extension}")),
            None => directory.join(format!("{stem}-{suffix}")),
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

pub fn write_new_attachment(
    directory: &Path,
    filename: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("无法创建归档目录 {}：{error}", directory.display()))?;
    let target = unique_destination(directory, filename);
    fs::write(&target, bytes)
        .map_err(|error| format!("无法写入附件 {}：{error}", target.display()))?;
    Ok(target)
}

pub fn write_message_body_docx(
    directory: &Path,
    filename: &str,
    subject: &str,
    sender: &str,
    received_at: &str,
    body: &str,
) -> Result<PathBuf, String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("无法创建归档目录 {}：{error}", directory.display()))?;
    let target = unique_destination(directory, filename);
    let document = Docx::new()
        .add_paragraph(Paragraph::new().add_run(Run::new().add_text(subject)))
        .add_paragraph(Paragraph::new().add_run(Run::new().add_text(format!("发件人：{sender}"))))
        .add_paragraph(
            Paragraph::new().add_run(Run::new().add_text(format!("收件时间：{received_at}"))),
        )
        .add_paragraph(Paragraph::new().add_run(Run::new().add_text("邮件正文")))
        .add_paragraph(Paragraph::new().add_run(Run::new().add_text(body)));
    document
        .build()
        .pack(
            fs::File::create(&target)
                .map_err(|error| format!("无法创建 Word 文档 {}：{error}", target.display()))?,
        )
        .map_err(|error| format!("无法写入 Word 文档 {}：{error}", target.display()))?;
    Ok(target)
}

pub fn move_with_cross_volume_fallback(source: &Path, target: &Path) -> Result<(), String> {
    if !source.exists() {
        return Err(format!("源附件不存在：{}", source.display()));
    }
    if target.exists() {
        return Err(format!("目标附件已存在：{}", target.display()));
    }
    let parent = target
        .parent()
        .ok_or_else(|| format!("目标路径没有父目录：{}", target.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("无法创建目标目录 {}：{error}", parent.display()))?;
    if fs::rename(source, target).is_ok() {
        return Ok(());
    }
    let token = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let temporary = parent.join(format!(".unigather-{token}.tmp"));
    fs::copy(source, &temporary).map_err(|error| {
        format!(
            "无法复制附件 {} 到 {}：{error}",
            source.display(),
            temporary.display()
        )
    })?;
    let source_len = fs::metadata(source)
        .map_err(|error| error.to_string())?
        .len();
    let copied_len = fs::metadata(&temporary)
        .map_err(|error| error.to_string())?
        .len();
    if source_len != copied_len {
        let _ = fs::remove_file(&temporary);
        return Err(format!("附件复制校验失败：{}", source.display()));
    }
    fs::rename(&temporary, target)
        .map_err(|error| format!("无法完成附件写入 {}：{error}", target.display()))?;
    if let Err(error) = fs::remove_file(source) {
        return Err(format!(
            "附件已复制到 {}，但无法删除源文件 {}：{error}",
            target.display(),
            source.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn sanitizes_windows_segments() {
        assert_eq!(sanitize_segment("重庆/分公司:*?"), "重庆_分公司___");
        assert_eq!(sanitize_segment("..."), "未命名");
    }

    #[test]
    fn builds_matched_and_unmatched_names() {
        assert_eq!(
            matched_name("重庆", "数据安全报名表", "原件.docx"),
            "重庆-数据安全报名表.docx"
        );
        assert_eq!(
            unmatched_name("2026-08-13T10:20:30", "a@example.com", "报名表.xlsx"),
            "20260813-102030-a@example.com-报名表.xlsx"
        );
    }

    #[test]
    fn allocates_a_suffix_without_overwriting() {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("unigather-archive-{id}"));
        fs::create_dir_all(&directory).expect("directory");
        let first = directory.join("重庆-报名表.docx");
        fs::write(&first, b"original").expect("seed file");
        let target = unique_destination(&directory, "重庆-报名表.docx");
        assert_eq!(
            target.file_name().and_then(|value| value.to_str()),
            Some("重庆-报名表-2.docx")
        );
        assert_eq!(fs::read(&first).expect("original remains"), b"original");
        fs::remove_dir_all(&directory).expect("cleanup own directory");
    }

    #[test]
    fn writes_a_real_word_document_for_an_attachment_less_mail_body() {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("unigather-body-{id}"));
        let output = write_message_body_docx(
            &directory,
            "陕西-报名表.docx",
            "报名表",
            "张三 <a@example.com>",
            "2026-08-13 10:00",
            "邮件正文",
        )
        .expect("docx");
        let bytes = fs::read(&output).expect("docx bytes");
        assert_eq!(&bytes[..2], b"PK");
        assert!(output.exists());
        fs::remove_dir_all(&directory).expect("cleanup own directory");
    }
}
