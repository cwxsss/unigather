use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailboxConfig {
    pub id: Option<String>,
    pub name: String,
    pub protocol: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password_key: String,
    #[serde(default)]
    pub password: String,
    pub encryption: String,
    pub proxy_url: Option<String>,
    #[serde(default)]
    pub proxy_username: String,
    #[serde(default)]
    pub proxy_password: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompanyImportRow {
    pub company_name: String,
    #[serde(default)]
    pub contact_name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfigInput {
    pub enabled: bool,
    pub endpoint: String,
    pub model: String,
    #[serde(default)]
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfigView {
    pub enabled: bool,
    pub endpoint: String,
    pub model: String,
    pub api_key_present: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailAttachment {
    pub original_name: String,
    pub mime_type: String,
    pub saved_path: String,
    pub parse_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailMessage {
    pub id: String,
    pub sender: String,
    pub recipients: String,
    pub cc: String,
    pub subject: String,
    pub body: String,
    pub received_at: String,
    pub attachments: Vec<MailAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskInput {
    pub name: String,
    pub company_ids: Vec<String>,
    pub subject_keywords: Vec<String>,
    pub body_keywords: Vec<String>,
    #[serde(default)]
    pub start_time: String,
    pub deadline: String,
    pub poll_minutes: u32,
    pub save_directory: String,
    pub filename_template: String,
    pub ai_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSummary {
    pub id: String,
    pub name: String,
    pub status: String,
    pub total_companies: u32,
    pub confirmed_companies: u32,
    pub deadline: String,
    #[serde(default)]
    pub start_time: String,
    #[serde(default)]
    pub poll_minutes: u32,
    #[serde(default)]
    pub save_directory: String,
    #[serde(default)]
    pub subject_keywords: Vec<String>,
    #[serde(default)]
    pub body_keywords: Vec<String>,
    #[serde(default)]
    pub ai_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    pub run_id: String,
    pub received: u32,
    pub duplicates: u32,
    pub matched: u32,
    pub needs_review: u32,
    pub errors: Vec<String>,
}
