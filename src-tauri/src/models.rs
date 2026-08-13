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
    #[serde(default)]
    pub smtp_host: String,
    #[serde(default)]
    pub smtp_port: u16,
    #[serde(default)]
    pub smtp_encryption: String,
    #[serde(default)]
    pub smtp_sender_name: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompanyImportRow {
    pub company_name: String,
    #[serde(default)]
    pub contact_name: String,
    pub email: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub aliases: String,
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
#[serde(rename_all = "camelCase")]
pub struct CompanyContact {
    pub id: String,
    pub contact_name: String,
    pub email: String,
    pub phone: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyContactInput {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub company_id: String,
    pub company_name: String,
    #[serde(default)]
    pub contact_name: String,
    pub email: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyDeleteResult {
    pub deleted_company: bool,
    pub affected_tasks: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub status: String,
    pub message: String,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxTestReport {
    pub incoming: ConnectionTestResult,
    pub outgoing: ConnectionTestResult,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanySummary {
    pub id: String,
    pub name: String,
    pub contacts: Vec<CompanyContact>,
    pub email_count: u32,
    #[serde(default)]
    pub phones: Vec<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskInput {
    pub name: String,
    #[serde(default)]
    pub material_name: String,
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
    #[serde(default)]
    pub material_name: String,
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
    #[serde(default)]
    pub company_ids: Vec<String>,
    #[serde(default)]
    pub deleted_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendInput {
    #[serde(default)]
    pub task_id: String,
    #[serde(default)]
    pub batch_id: String,
    #[serde(default)]
    pub smtp_host: String,
    #[serde(default)]
    pub smtp_port: u16,
    #[serde(default)]
    pub encryption: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub sender_name: String,
    pub subject: String,
    pub body: String,
    #[serde(default)]
    pub signature: String,
    #[serde(default)]
    pub include_attachments: bool,
    #[serde(default)]
    pub company_ids: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub test_recipient: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentCandidate {
    pub id: String,
    pub name: String,
    pub path: String,
    pub relative_path: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendBatchInput {
    pub name: String,
    pub source_dir: String,
    #[serde(default)]
    pub recursive: bool,
    pub subject: String,
    pub body: String,
    #[serde(default)]
    pub signature: String,
    #[serde(default)]
    pub cc: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendBatchItemInput {
    pub id: String,
    pub file_name: String,
    pub file_path: String,
    #[serde(default)]
    pub company_id: String,
    #[serde(default)]
    pub company_name: String,
    #[serde(default)]
    pub recipients: Vec<String>,
    #[serde(default)]
    pub match_method: String,
    #[serde(default)]
    pub confidence: f32,
    pub status: String,
    #[serde(default)]
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendBatchSummary {
    pub id: String,
    pub name: String,
    pub source_dir: String,
    pub recursive: bool,
    pub subject: String,
    pub body: String,
    pub signature: String,
    pub cc: Vec<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub item_count: u32,
    #[serde(default)]
    pub last_run_id: String,
    #[serde(default)]
    pub failed_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendHistoryItem {
    pub company_name: String,
    pub recipients: Vec<String>,
    pub attachments: Vec<String>,
    pub status: String,
    pub error: String,
    pub sent_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendHistoryRun {
    pub id: String,
    pub mode: String,
    pub started_at: String,
    pub finished_at: String,
    pub status: String,
    pub total: u32,
    pub processed: u32,
    pub success_count: u32,
    pub failure_count: u32,
    pub error: String,
    pub items: Vec<SendHistoryItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendHistoryDetail {
    pub batch: SendBatchSummary,
    pub runs: Vec<SendHistoryRun>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskMatchAttachment {
    pub id: String,
    pub name: String,
    pub saved_path: String,
    pub parse_status: String,
    pub can_open: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskMatchMessage {
    pub id: String,
    pub message_id: String,
    pub sender: String,
    pub subject: String,
    pub received_at: String,
    pub status: String,
    pub reason: String,
    pub company_name: String,
    pub attachments: Vec<TaskMatchAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSyncRunSummary {
    pub id: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: String,
    pub processed: u32,
    pub received: u32,
    pub duplicates: u32,
    pub matched: u32,
    pub needs_review: u32,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskMatchDetail {
    pub task_id: String,
    pub latest_run: Option<TaskSyncRunSummary>,
    pub messages: Vec<TaskMatchMessage>,
    pub matched: u32,
    pub needs_review: u32,
    pub unmatched: u32,
    pub processed_messages: u32,
    pub total_messages: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFeedbackPage {
    pub task_id: String,
    pub messages: Vec<TaskMatchMessage>,
    pub total: u32,
    pub page: u32,
    pub page_count: u32,
    pub page_size: u32,
    pub matched: u32,
    pub needs_review: u32,
    pub unmatched: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFeedbackCompany {
    pub company_id: String,
    pub company_name: String,
    pub feedback_status: String,
    pub contacts: Vec<CompanyContact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardEvent {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub occurred_at: String,
    pub status: String,
    pub target_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSummary {
    pub collection_task_count: u32,
    pub active_collection_tasks: u32,
    pub send_batch_count: u32,
    pub today_received: u32,
    pub today_sent_success: u32,
    pub today_sent_failure: u32,
    pub latest_receive_status: String,
    pub recent_events: Vec<DashboardEvent>,
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
