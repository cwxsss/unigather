use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use crate::models::MailboxConfig;

pub fn parse_proxy_endpoint(value: &str) -> Result<(String, String, u16), String> {
    let (scheme, remainder) = value
        .trim()
        .split_once("://")
        .ok_or_else(|| "代理地址必须包含协议，例如 http://127.0.0.1:7890".to_string())?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" && scheme != "socks5" && scheme != "socks5h" {
        return Err(format!("不支持的代理协议：{scheme}"));
    }
    let authority = remainder.split('/').next().unwrap_or_default();
    let authority = authority
        .rsplit_once('@')
        .map(|(_, value)| value)
        .unwrap_or(authority);
    let (host, port) = if let Some((host, port)) = authority.rsplit_once(':') {
        let port = port
            .parse::<u16>()
            .map_err(|_| "代理端口无效".to_string())?;
        (host.trim_matches(['[', ']']).to_string(), port)
    } else {
        (
            authority.to_string(),
            if scheme.starts_with("socks") {
                1080
            } else {
                8080
            },
        )
    };
    if host.trim().is_empty() || port == 0 {
        return Err("代理地址或端口不能为空".to_string());
    }
    Ok((scheme, host, port))
}

pub fn connect(config: &MailboxConfig) -> Result<TcpStream, String> {
    let proxy_url = config.proxy_url.as_deref().unwrap_or_default().trim();
    let (target_host, target_port) = (config.host.trim(), config.port);
    let stream = if proxy_url.is_empty() {
        TcpStream::connect((target_host, target_port))
            .map_err(|error| format!("连接邮箱服务器失败：{error}"))?
    } else {
        let (scheme, proxy_host, proxy_port) = parse_proxy_endpoint(proxy_url)?;
        let mut stream = TcpStream::connect((proxy_host.as_str(), proxy_port))
            .map_err(|error| format!("连接代理服务器失败：{error}"))?;
        stream.set_read_timeout(Some(Duration::from_secs(30))).ok();
        stream.set_write_timeout(Some(Duration::from_secs(30))).ok();
        if scheme == "http" || scheme == "https" {
            http_connect(
                &mut stream,
                target_host,
                target_port,
                &config.proxy_username,
                &config.proxy_password,
            )?;
        } else {
            socks5_connect(
                &mut stream,
                target_host,
                target_port,
                &config.proxy_username,
                &config.proxy_password,
            )?;
        }
        stream
    };
    stream.set_read_timeout(Some(Duration::from_secs(60))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(60))).ok();
    Ok(stream)
}

fn http_connect(
    stream: &mut TcpStream,
    target_host: &str,
    target_port: u16,
    username: &str,
    password: &str,
) -> Result<(), String> {
    let mut request = format!(
        "CONNECT {target_host}:{target_port} HTTP/1.1\r\nHost: {target_host}:{target_port}\r\n"
    );
    if !username.trim().is_empty() {
        let token = BASE64.encode(format!("{username}:{password}"));
        request.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    request.push_str("Connection: Keep-Alive\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("发送 HTTP 代理连接请求失败：{error}"))?;
    let response = read_until_headers_end(stream)?;
    let status_line = String::from_utf8_lossy(&response)
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    if !status_line.contains(" 200 ") && !status_line.ends_with(" 200") {
        return Err(format!("HTTP 代理连接失败：{status_line}"));
    }
    Ok(())
}

fn socks5_connect(
    stream: &mut TcpStream,
    target_host: &str,
    target_port: u16,
    username: &str,
    password: &str,
) -> Result<(), String> {
    let has_auth = !username.trim().is_empty();
    let methods = if has_auth {
        vec![0x00, 0x02]
    } else {
        vec![0x00]
    };
    let mut greeting = vec![0x05, methods.len() as u8];
    greeting.extend_from_slice(&methods);
    stream
        .write_all(&greeting)
        .map_err(|error| format!("发送 SOCKS5 握手失败：{error}"))?;
    let mut response = [0u8; 2];
    stream
        .read_exact(&mut response)
        .map_err(|error| format!("读取 SOCKS5 握手失败：{error}"))?;
    if response[0] != 0x05 || response[1] == 0xff {
        return Err("SOCKS5 代理不接受当前认证方式".to_string());
    }
    if response[1] == 0x02 {
        let user = username.as_bytes();
        let pass = password.as_bytes();
        if user.len() > 255 || pass.len() > 255 {
            return Err("SOCKS5 代理账号或密码过长".to_string());
        }
        let mut auth = vec![0x01, user.len() as u8];
        auth.extend_from_slice(user);
        auth.push(pass.len() as u8);
        auth.extend_from_slice(pass);
        stream
            .write_all(&auth)
            .map_err(|error| format!("发送 SOCKS5 认证失败：{error}"))?;
        let mut auth_response = [0u8; 2];
        stream
            .read_exact(&mut auth_response)
            .map_err(|error| format!("读取 SOCKS5 认证失败：{error}"))?;
        if auth_response[1] != 0x00 {
            return Err("SOCKS5 代理认证失败".to_string());
        }
    }
    let host = target_host.as_bytes();
    if host.len() > 255 {
        return Err("邮箱服务器地址过长".to_string());
    }
    let mut request = vec![0x05, 0x01, 0x00, 0x03, host.len() as u8];
    request.extend_from_slice(host);
    request.extend_from_slice(&target_port.to_be_bytes());
    stream
        .write_all(&request)
        .map_err(|error| format!("发送 SOCKS5 连接请求失败：{error}"))?;
    let mut header = [0u8; 4];
    stream
        .read_exact(&mut header)
        .map_err(|error| format!("读取 SOCKS5 连接响应失败：{error}"))?;
    if header[1] != 0x00 {
        return Err(format!("SOCKS5 连接邮箱服务器失败，错误码 {}", header[1]));
    }
    let address_length = match header[3] {
        0x01 => 4,
        0x03 => {
            let mut length = [0u8; 1];
            stream
                .read_exact(&mut length)
                .map_err(|error| error.to_string())?;
            length[0] as usize
        }
        0x04 => 16,
        _ => return Err("SOCKS5 返回未知地址类型".to_string()),
    };
    let mut address = vec![0u8; address_length + 2];
    stream
        .read_exact(&mut address)
        .map_err(|error| format!("读取 SOCKS5 地址失败：{error}"))?;
    Ok(())
}

fn read_until_headers_end(stream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut response = Vec::new();
    let mut buffer = [0u8; 1];
    while response.len() < 16 * 1024 {
        stream
            .read_exact(&mut buffer)
            .map_err(|error| format!("读取代理响应失败：{error}"))?;
        response.push(buffer[0]);
        if response.ends_with(b"\r\n\r\n") {
            return Ok(response);
        }
    }
    Err("代理响应头过长".to_string())
}

#[cfg(test)]
mod tests {
    use super::parse_proxy_endpoint;

    #[test]
    fn parses_http_and_socks_proxy_endpoints() {
        assert_eq!(
            parse_proxy_endpoint("http://127.0.0.1:7890").unwrap(),
            ("http".to_string(), "127.0.0.1".to_string(), 7890)
        );
        assert_eq!(
            parse_proxy_endpoint("socks5://proxy.local:1080").unwrap(),
            ("socks5".to_string(), "proxy.local".to_string(), 1080)
        );
    }
}
