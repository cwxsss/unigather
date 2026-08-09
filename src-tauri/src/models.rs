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
    pub encryption: String,
    pub proxy_url: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskInput {
    pub name: String,
    pub company_ids: Vec<String>,
    pub subject_keywords: Vec<String>,
    pub body_keywords: Vec<String>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    pub run_id: String,
    pub received: u32,
    pub matched: u32,
    pub needs_review: u32,
    pub errors: Vec<String>,
}
