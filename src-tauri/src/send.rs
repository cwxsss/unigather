use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use native_tls::{TlsConnector, TlsStream};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;

use crate::models::MailboxConfig;
use crate::proxy;

#[derive(Debug, Clone)]
pub struct SmtpSendConfig {
    pub host: String,
    pub port: u16,
    pub encryption: String,
    pub username: String,
    pub password: String,
    pub sender_name: String,
    pub proxy_url: Option<String>,
    pub proxy_username: String,
    pub proxy_password: String,
}

#[derive(Debug, Clone)]
pub struct SendAttachment {
    pub name: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct SendTarget {
    pub company_id: String,
    pub company_name: String,
    pub recipients: Vec<String>,
    pub attachments: Vec<SendAttachment>,
}

pub fn valid_email(value: &str) -> bool {
    let value = value.trim();
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !value.chars().any(char::is_whitespace)
}

enum SmtpStream {
    Plain(TcpStream),
    Tls(TlsStream<TcpStream>),
}

impl Read for SmtpStream {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Self::Plain(stream) => stream.read(buffer),
            Self::Tls(stream) => stream.read(buffer),
        }
    }
}

impl Write for SmtpStream {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        match self {
            Self::Plain(stream) => stream.write(buffer),
            Self::Tls(stream) => stream.write(buffer),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Self::Plain(stream) => stream.flush(),
            Self::Tls(stream) => stream.flush(),
        }
    }
}

pub struct SmtpClient {
    config: SmtpSendConfig,
    stream: SmtpStream,
}

impl SmtpClient {
    pub fn connect(config: SmtpSendConfig) -> Result<Self, String> {
        if config.host.trim().is_empty() || config.port == 0 {
            return Err("SMTP 服务器和端口不能为空".to_string());
        }
        if config.username.trim().is_empty() || config.password.trim().is_empty() {
            return Err("发送账号或密码未配置".to_string());
        }
        let mailbox = MailboxConfig {
            id: None,
            name: "SMTP 发送".to_string(),
            protocol: "SMTP".to_string(),
            host: config.host.clone(),
            port: config.port,
            username: config.username.clone(),
            password_key: config.username.clone(),
            password: config.password.clone(),
            encryption: config.encryption.clone(),
            proxy_url: config.proxy_url.clone(),
            proxy_username: config.proxy_username.clone(),
            proxy_password: config.proxy_password.clone(),
            smtp_host: String::new(),
            smtp_port: 0,
            smtp_encryption: String::new(),
            smtp_sender_name: String::new(),
            enabled: true,
        };
        let tcp = proxy::connect(&mailbox)?;
        let encryption = config.encryption.to_ascii_uppercase();
        let mut client = if encryption.contains("SSL") {
            let connector = TlsConnector::builder()
                .build()
                .map_err(|error| format!("SMTP TLS 初始化失败：{error}"))?;
            let stream = connector
                .connect(config.host.trim(), tcp)
                .map_err(|error| format!("SMTP TLS 握手失败：{error}"))?;
            Self {
                config,
                stream: SmtpStream::Tls(stream),
            }
        } else if encryption.contains("STARTTLS") {
            Self {
                config,
                stream: SmtpStream::Plain(tcp),
            }
        } else {
            return Err("SMTP 加密方式只能是 SSL/TLS 或 STARTTLS".to_string());
        };

        client.expect_code(220, "读取 SMTP 欢迎信息")?;
        client.ehlo()?;
        if encryption.contains("STARTTLS") {
            client.command("STARTTLS")?;
            client.expect_code(220, "SMTP STARTTLS")?;
            let plain = match client.stream {
                SmtpStream::Plain(stream) => stream,
                SmtpStream::Tls(_) => return Err("SMTP STARTTLS 状态错误".to_string()),
            };
            let connector = TlsConnector::builder()
                .build()
                .map_err(|error| format!("SMTP TLS 初始化失败：{error}"))?;
            let stream = connector
                .connect(client.config.host.trim(), plain)
                .map_err(|error| format!("SMTP STARTTLS 握手失败：{error}"))?;
            client.stream = SmtpStream::Tls(stream);
            client.ehlo()?;
        }
        client.authenticate()?;
        Ok(client)
    }

    fn command(&mut self, command: &str) -> Result<(), String> {
        self.stream
            .write_all(format!("{command}\r\n").as_bytes())
            .map_err(|error| format!("SMTP 发送命令失败：{error}"))?;
        self.stream
            .flush()
            .map_err(|error| format!("SMTP 刷新命令失败：{error}"))
    }

    fn read_line(&mut self) -> Result<String, String> {
        let mut bytes = Vec::new();
        let mut byte = [0u8; 1];
        while bytes.len() < 1024 * 1024 {
            self.stream
                .read_exact(&mut byte)
                .map_err(|error| format!("读取 SMTP 响应失败：{error}"))?;
            bytes.push(byte[0]);
            if byte[0] == b'\n' {
                return Ok(String::from_utf8_lossy(&bytes).trim_end().to_string());
            }
        }
        Err("SMTP 响应行过长".to_string())
    }

    fn response(&mut self) -> Result<(u16, String), String> {
        let first = self.read_line()?;
        let code = first
            .get(0..3)
            .and_then(|value| value.parse::<u16>().ok())
            .ok_or_else(|| format!("SMTP 响应格式无效：{first}"))?;
        let mut lines = vec![first.clone()];
        if first.as_bytes().get(3) == Some(&b'-') {
            loop {
                let line = self.read_line()?;
                let done = line.starts_with(&format!("{code} "));
                lines.push(line);
                if done {
                    break;
                }
            }
        }
        Ok((code, lines.join("\n")))
    }

    fn expect_code(&mut self, expected: u16, context: &str) -> Result<(), String> {
        let (code, response) = self.response()?;
        if code == expected {
            Ok(())
        } else {
            Err(format!("{context}失败：{response}"))
        }
    }

    fn ehlo(&mut self) -> Result<(), String> {
        self.command("EHLO localhost")?;
        self.expect_code(250, "SMTP EHLO")
    }

    fn authenticate(&mut self) -> Result<(), String> {
        self.command("AUTH LOGIN")?;
        let (code, _) = self.response()?;
        if code == 334 {
            self.command(&BASE64.encode(self.config.username.as_bytes()))?;
            self.expect_code(334, "SMTP 密码认证")?;
            self.command(&BASE64.encode(self.config.password.as_bytes()))?;
            return self.expect_code(235, "SMTP 登录");
        }
        self.command("AUTH PLAIN")?;
        let (plain_code, _) = self.response()?;
        if plain_code != 334 && plain_code != 235 {
            return Err("SMTP 服务器不支持 AUTH LOGIN 或 AUTH PLAIN".to_string());
        }
        if plain_code == 235 {
            return Ok(());
        }
        let token = BASE64.encode(format!(
            "\0{}\0{}",
            self.config.username, self.config.password
        ));
        self.command(&token)?;
        self.expect_code(235, "SMTP 登录")
    }

    pub fn send(
        &mut self,
        target: &SendTarget,
        cc: &[String],
        subject: &str,
        body: &str,
        signature: &str,
    ) -> Result<(), String> {
        if target.recipients.is_empty() {
            return Err(format!("单位“{}”没有收件邮箱", target.company_name));
        }
        self.command(&format!("MAIL FROM:<{}>", self.config.username))?;
        self.expect_code(250, "SMTP 发件人")?;
        for recipient in target.recipients.iter().chain(cc.iter()) {
            self.command(&format!("RCPT TO:<{}>", recipient))?;
            self.expect_code(250, "SMTP 收件人")?;
        }
        self.command("DATA")?;
        self.expect_code(354, "SMTP 邮件正文")?;
        let mime = build_mime_message(
            &self.config.username,
            &self.config.sender_name,
            &target.recipients,
            cc,
            subject,
            body,
            signature,
            &target.company_name,
            &target.attachments,
        )?;
        self.stream
            .write_all(&dot_stuff(&mime))
            .and_then(|_| self.stream.write_all(b"\r\n.\r\n"))
            .and_then(|_| self.stream.flush())
            .map_err(|error| format!("SMTP 写入邮件失败：{error}"))?;
        self.expect_code(250, "SMTP 投递邮件")
    }

    pub fn close(&mut self) {
        let _ = self.command("QUIT");
        let _ = self.response();
    }
}

pub fn build_mime_message(
    sender: &str,
    sender_name: &str,
    recipients: &[String],
    cc: &[String],
    subject_text: &str,
    body_text: &str,
    signature: &str,
    company_name: &str,
    attachments: &[SendAttachment],
) -> Result<Vec<u8>, String> {
    let boundary = format!(
        "=UniGather-{}",
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    );
    let subject_value = if subject_text.trim().is_empty() {
        format!("材料收集通知 - {company_name}")
    } else {
        subject_text.replace("{单位名称}", company_name)
    };
    let subject = encode_header(&subject_value);
    let from_name = if sender_name.trim().is_empty() {
        sender.to_string()
    } else {
        sender_name.to_string()
    };
    let cc_header = if cc.is_empty() {
        String::new()
    } else {
        format!("Cc: {}\r\n", cc.join(", "))
    };
    let mut text = format!(
        "From: {} <{}>\r\nTo: {}\r\n{}Subject: {}\r\nDate: {}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"{}\"\r\n\r\n",
        encode_header(&from_name), sender, recipients.join(", "), cc_header, subject, Utc::now().to_rfc2822(), boundary
    );
    let body_value = if body_text.trim().is_empty() {
        format!("您好，{company_name}：\n\n请查收材料并按要求反馈。")
    } else {
        body_text.replace("{单位名称}", company_name)
    };
    let html = build_html_body(&body_value, signature);
    text.push_str(&format!("--{boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n", wrap_base64(html.as_bytes())));
    for attachment in attachments {
        let bytes = std::fs::read(&attachment.path)
            .map_err(|error| format!("读取附件失败：{}；{error}", attachment.path.display()))?;
        let filename = percent_encode(&attachment.name);
        text.push_str(&format!("--{boundary}\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename*=UTF-8''{filename}\r\n\r\n{}\r\n", wrap_base64(&bytes)));
    }
    text.push_str(&format!("--{boundary}--\r\n"));
    Ok(text.into_bytes())
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn build_html_body(body: &str, signature: &str) -> String {
    let main = escape_html(body);
    let main = format!("<div style=\"font-family:'仿宋_GB2312','FangSong';font-size:14pt;line-height:1.8;white-space:pre-wrap\">{main}</div>");
    if signature.trim().is_empty() {
        main
    } else {
        format!("{main}<div style=\"font-family:'Microsoft YaHei','微软雅黑';font-size:9pt;line-height:1.6;white-space:pre-wrap;margin-top:18px\">{}</div>", escape_html(signature.trim()))
    }
}

fn encode_header(value: &str) -> String {
    if value.is_ascii() {
        value.to_string()
    } else {
        format!("=?UTF-8?B?{}?=", BASE64.encode(value.as_bytes()))
    }
}

fn wrap_base64(bytes: &[u8]) -> String {
    BASE64
        .encode(bytes)
        .as_bytes()
        .chunks(76)
        .map(|chunk| String::from_utf8_lossy(chunk).to_string())
        .collect::<Vec<_>>()
        .join("\r\n")
}

fn percent_encode(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => {
                (*byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn dot_stuff(bytes: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(bytes.len());
    let mut line_start = true;
    for byte in bytes {
        if line_start && *byte == b'.' {
            result.push(b'.');
        }
        result.push(*byte);
        line_start = *byte == b'\n';
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{
        build_mime_message, dot_stuff, encode_header, percent_encode, wrap_base64, SendAttachment,
    };

    #[test]
    fn encodes_non_ascii_headers_and_filenames() {
        assert!(encode_header("总部").starts_with("=?UTF-8?B?"));
        assert_eq!(percent_encode("附件 1.txt"), "%E9%99%84%E4%BB%B6%201.txt");
    }

    #[test]
    fn dot_stuffs_smtp_data_lines() {
        assert_eq!(dot_stuff(b"hello\n.world"), b"hello\n..world");
    }

    #[test]
    fn builds_point_to_point_mime_message_with_attachment() {
        let path = std::env::temp_dir().join("unigather-send-test.txt");
        std::fs::write(&path, b"attachment").expect("write fixture");
        let message = build_mime_message(
            "sender@example.com",
            "总部",
            &["a@example.com".to_string()],
            &["cc@example.com".to_string()],
            "报名材料 - {单位名称}",
            "您好，{单位名称}，请在今天前反馈。",
            "中国联通总部数据安全工作组",
            "甲公司",
            &[SendAttachment {
                name: "附件.txt".to_string(),
                path: path.clone(),
            }],
        )
        .expect("mime");
        let text = String::from_utf8(message).expect("utf8 mime");
        assert!(text.contains("To: a@example.com"));
        assert!(text.contains("Cc: cc@example.com"));
        assert!(text.contains(&encode_header("报名材料 - 甲公司")));
        assert!(text.contains("Content-Type: text/html; charset=UTF-8"));
        assert!(text.contains(&wrap_base64("<div style=\"font-family:'仿宋_GB2312','FangSong';font-size:14pt;line-height:1.8;white-space:pre-wrap\">您好，甲公司，请在今天前反馈。</div><div style=\"font-family:'Microsoft YaHei','微软雅黑';font-size:9pt;line-height:1.6;white-space:pre-wrap;margin-top:18px\">中国联通总部数据安全工作组</div>".as_bytes())));
        assert!(!text.contains("text/plain; charset=UTF-8"));
        assert!(text.contains("filename*=UTF-8''%E9%99%84%E4%BB%B6.txt"));
        assert!(text.contains("YXR0YWNobWVudA=="));
        let _ = std::fs::remove_file(path);
    }
}
