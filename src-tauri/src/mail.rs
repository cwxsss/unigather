use chrono::{DateTime, Utc};
use mailparse::{dateparse, parse_mail, MailHeaderMap, ParsedMail};
use native_tls::{TlsConnector, TlsStream};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpStream;

use crate::models::MailboxConfig;
use crate::proxy;

#[derive(Debug, Clone)]
pub struct RawMail {
    pub external_id: String,
    pub raw: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct ParsedAttachment {
    pub name: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct ParsedMessage {
    pub external_id: String,
    pub content_hash: String,
    pub sender: String,
    pub recipients: String,
    pub cc: String,
    pub subject: String,
    pub body: String,
    pub received_at: String,
    pub attachments: Vec<ParsedAttachment>,
}

pub fn fetch_messages_streaming<F>(
    config: &MailboxConfig,
    since: DateTime<Utc>,
    mut on_message: F,
) -> Result<(), String>
where
    F: FnMut(RawMail) -> Result<(), String>,
{
    if config.host.trim().is_empty() || config.username.trim().is_empty() {
        return Err("请先配置收件服务器和账号".to_string());
    }
    if config.password.trim().is_empty() {
        return Err("请输入邮箱密码或授权码后再收件".to_string());
    }
    match config.protocol.to_uppercase().as_str() {
        "IMAP" => fetch_imap(config, since, &mut on_message),
        "POP3" => fetch_pop3(config, since, &mut on_message),
        _ => Err("仅支持 IMAP 和 POP3 收件协议".to_string()),
    }
}

fn fetch_imap<F>(
    config: &MailboxConfig,
    since: DateTime<Utc>,
    on_message: &mut F,
) -> Result<(), String>
where
    F: FnMut(RawMail) -> Result<(), String>,
{
    let tls = TlsConnector::builder()
        .build()
        .map_err(|error| format!("TLS 初始化失败：{error}"))?;
    let stream = proxy::connect(config)?;
    let tls_stream = tls
        .connect(config.host.trim(), stream)
        .map_err(|error| format!("IMAP TLS 握手失败：{error}"))?;
    let mut client = imap::Client::new(tls_stream);
    client
        .read_greeting()
        .map_err(|error| format!("读取 IMAP 欢迎信息失败：{error}"))?;
    let mut session = client
        .login(&config.username, &config.password)
        .map_err(|error| format!("IMAP 登录失败：{}", error.0))?;
    session
        .select("INBOX")
        .map_err(|error| format!("打开 INBOX 失败：{error}"))?;
    let date = since.format("%d-%b-%Y").to_string();
    let uids = session
        .uid_search(format!("SINCE {date}"))
        .map_err(|error| format!("搜索 IMAP 邮件失败：{error}"))?;
    let mut uid_list: Vec<u32> = uids.into_iter().collect();
    uid_list.sort_unstable();
    if uid_list.len() > 500 {
        uid_list = uid_list[uid_list.len() - 500..].to_vec();
    }
    if uid_list.is_empty() {
        let _ = session.logout();
        return Ok(());
    }
    for uid in uid_list {
        let fetched = session
            .uid_fetch(uid.to_string(), "RFC822 UID")
            .map_err(|error| format!("读取 IMAP 邮件失败：{error}"))?;
        if let Some(message) = fetched.iter().next() {
            if let Some(raw) = message.body() {
                on_message(RawMail {
                    external_id: message.uid.unwrap_or(message.message).to_string(),
                    raw: raw.to_vec(),
                })?;
            }
        }
    }
    let _ = session.logout();
    Ok(())
}

fn fetch_pop3<F>(
    config: &MailboxConfig,
    since: DateTime<Utc>,
    on_message: &mut F,
) -> Result<(), String>
where
    F: FnMut(RawMail) -> Result<(), String>,
{
    if !config.encryption.to_uppercase().contains("SSL") && config.port != 995 {
        return Err("POP3 收件目前要求 SSL/TLS（通常端口 995）".to_string());
    }
    let stream = proxy::connect(config)?;
    let tls = TlsConnector::builder()
        .build()
        .map_err(|error| format!("TLS 初始化失败：{error}"))?;
    let stream = tls
        .connect(config.host.trim(), stream)
        .map_err(|error| format!("POP3 TLS 握手失败：{error}"))?;
    let mut connection = Pop3Client { stream };
    connection.read_status("读取 POP3 欢迎信息")?;
    connection.command_status(&format!("USER {}\r\n", config.username), "POP3 用户认证")?;
    connection.command_status(&format!("PASS {}\r\n", config.password), "POP3 密码认证")?;
    let uidl_lines = connection.command_multiline("UIDL\r\n", "读取 POP3 邮件列表")?;
    let mut ids = uidl_lines
        .into_iter()
        .filter_map(|line| {
            let line = String::from_utf8_lossy(&line).into_owned();
            let mut fields = line.split_whitespace().map(str::to_string);
            let number = fields.next()?.parse::<u32>().ok()?;
            let uid = fields.next().unwrap_or_else(|| number.to_string());
            Some((number, uid))
        })
        .collect::<Vec<_>>();
    ids.reverse();
    for (number, unique_id) in ids.into_iter().take(500) {
        let raw = connection.command_bytes(&format!("RETR {number}\r\n"), "读取 POP3 邮件")?;
        if let Ok(parsed) = parse_message(&raw, unique_id.clone()) {
            if parsed
                .received_at
                .parse::<DateTime<Utc>>()
                .map(|date| date >= since)
                .unwrap_or(true)
            {
                on_message(RawMail {
                    external_id: unique_id,
                    raw,
                })?;
            }
        }
    }
    Ok(())
}

struct Pop3Client {
    stream: TlsStream<TcpStream>,
}

impl Pop3Client {
    fn read_line(&mut self) -> Result<Vec<u8>, String> {
        let mut line = Vec::new();
        let mut byte = [0u8; 1];
        while line.len() < 1024 * 1024 {
            self.stream
                .read_exact(&mut byte)
                .map_err(|error| format!("读取 POP3 响应失败：{error}"))?;
            line.push(byte[0]);
            if byte[0] == b'\n' {
                return Ok(line);
            }
        }
        Err("POP3 响应行过长".to_string())
    }

    fn read_status(&mut self, context: &str) -> Result<(), String> {
        let line = self.read_line()?;
        if line.starts_with(b"+OK") {
            Ok(())
        } else {
            Err(format!(
                "{context}失败：{}",
                String::from_utf8_lossy(&line).trim()
            ))
        }
    }

    fn command_status(&mut self, command: &str, context: &str) -> Result<(), String> {
        self.stream
            .write_all(command.as_bytes())
            .map_err(|error| format!("{context}发送失败：{error}"))?;
        self.read_status(context)
    }

    fn command_multiline(&mut self, command: &str, context: &str) -> Result<Vec<Vec<u8>>, String> {
        self.stream
            .write_all(command.as_bytes())
            .map_err(|error| format!("{context}发送失败：{error}"))?;
        self.read_status(context)?;
        let mut lines = Vec::new();
        loop {
            let mut line = self.read_line()?;
            if line == b".\r\n" || line == b".\n" {
                break;
            }
            if line.starts_with(b"..") {
                line.remove(0);
            }
            lines.push(line);
        }
        Ok(lines)
    }

    fn command_bytes(&mut self, command: &str, context: &str) -> Result<Vec<u8>, String> {
        let lines = self.command_multiline(command, context)?;
        Ok(lines.into_iter().flatten().collect())
    }
}

pub fn parse_message(raw: &[u8], fallback_id: String) -> Result<ParsedMessage, String> {
    let parsed = parse_mail(raw).map_err(|error| format!("邮件 MIME 解析失败：{error}"))?;
    let sender = parsed.headers.get_first_value("From").unwrap_or_default();
    let recipients = parsed.headers.get_first_value("To").unwrap_or_default();
    let cc = parsed.headers.get_first_value("Cc").unwrap_or_default();
    let subject = parsed
        .headers
        .get_first_value("Subject")
        .unwrap_or_else(|| "(无主题)".to_string());
    let date_header = parsed.headers.get_first_value("Date").unwrap_or_default();
    let received_at = dateparse(&date_header)
        .ok()
        .and_then(|seconds| DateTime::from_timestamp(seconds, 0))
        .unwrap_or_else(Utc::now)
        .to_rfc3339();
    let body = find_body(&parsed).unwrap_or_default();
    let attachments = collect_attachments(&parsed);
    let external_id = parsed
        .headers
        .get_first_value("Message-ID")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback_id);
    let mut digest = Sha256::new();
    digest.update(raw);
    let content_hash = format!("{:x}", digest.finalize());
    Ok(ParsedMessage {
        external_id,
        content_hash,
        sender,
        recipients,
        cc,
        subject,
        body,
        received_at,
        attachments,
    })
}

fn find_body(mail: &ParsedMail<'_>) -> Option<String> {
    if mail.ctype.mimetype.eq_ignore_ascii_case("text/plain") {
        return mail.get_body().ok();
    }
    mail.subparts.iter().find_map(find_body).or_else(|| {
        if mail.ctype.mimetype.eq_ignore_ascii_case("text/html") {
            mail.get_body().ok()
        } else {
            None
        }
    })
}

fn collect_attachments(mail: &ParsedMail<'_>) -> Vec<ParsedAttachment> {
    let mut result = Vec::new();
    let disposition = mail.headers.get_first_value("Content-Disposition");
    let filename = disposition
        .as_deref()
        .and_then(extract_filename)
        .or_else(|| mail.ctype.params.get("name").cloned());
    if let Some(name) = filename {
        if let Ok(bytes) = mail.get_body_raw() {
            result.push(ParsedAttachment {
                name: name.trim().to_string(),
                mime_type: mail.ctype.mimetype.clone(),
                bytes,
            });
        }
    }
    for part in &mail.subparts {
        result.extend(collect_attachments(part));
    }
    result
}

fn extract_filename(value: &str) -> Option<String> {
    value.split(';').find_map(|part| {
        let (key, filename) = part.split_once('=')?;
        if key.trim().eq_ignore_ascii_case("filename") {
            Some(filename.trim().trim_matches('"').to_string())
        } else {
            None
        }
    })
}

pub fn write_attachment(
    directory: &std::path::Path,
    message_id: &str,
    attachment: &ParsedAttachment,
) -> Result<String, String> {
    std::fs::create_dir_all(directory).map_err(|error| format!("创建材料目录失败：{error}"))?;
    let safe_name = attachment
        .name
        .chars()
        .map(|character| {
            if "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    let safe_name = if safe_name.trim().is_empty() {
        "未命名附件"
    } else {
        safe_name.as_str()
    };
    let prefix = message_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(16)
        .collect::<String>();
    let base_path = directory.join(format!(
        "{}_{}",
        if prefix.is_empty() { "mail" } else { &prefix },
        safe_name
    ));
    let mut path = base_path.clone();
    let mut suffix = 1u32;
    while path.exists() {
        let stem = base_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("attachment");
        let extension = base_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let filename = if extension.is_empty() {
            format!("{stem}_{suffix}")
        } else {
            format!("{stem}_{suffix}.{extension}")
        };
        path = directory.join(filename);
        suffix += 1;
    }
    let mut file =
        std::fs::File::create(&path).map_err(|error| format!("保存附件失败：{error}"))?;
    file.write_all(&attachment.bytes)
        .map_err(|error| format!("写入附件失败：{error}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::parse_message;

    #[test]
    fn parses_headers_and_plain_text_body() {
        let raw = b"From: sender@example.com\r\nTo: team@example.com\r\nSubject: Hello\r\nDate: Sun, 09 Aug 2026 10:00:00 +0800\r\nMessage-ID: <m-1@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody text";
        let parsed = parse_message(raw, "fallback".to_string()).expect("parse");
        assert_eq!(parsed.external_id, "<m-1@example.com>");
        assert_eq!(parsed.sender, "sender@example.com");
        assert_eq!(parsed.body, "Body text");
    }
}
