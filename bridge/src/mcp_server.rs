use std::{
    process::{Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow};
use rmcp::{
    ErrorData, ServerHandler, ServiceExt,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, Implementation, ListToolsResult,
        PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
    },
    service::{RequestContext, RoleServer},
    transport::stdio,
};
use serde_json::{Map, Value, json};
use tokio::time::sleep;
use uuid::Uuid;

use crate::{
    ipc,
    protocol::{PROTOCOL_VERSION, RejectRequests, RpcPeer},
};

const START_TIMEOUT: Duration = Duration::from_secs(5);
const RETRY_DELAY: Duration = Duration::from_millis(50);

#[derive(Clone)]
struct BridgeMcpServer {
    peer: Arc<RpcPeer>,
    session_id: Uuid,
}

impl ServerHandler for BridgeMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("inreview", env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "Call list_workspaces to discover open InReview workspaces, then connect to one exact root before reading or changing review comments.",
            )
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult {
            tools: tool_definitions(),
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let name = request.name.to_string();
        if !is_tool_name(&name) {
            return Err(ErrorData::invalid_params("Unknown InReview tool.", None));
        }
        let arguments = request
            .arguments
            .map(Value::Object)
            .unwrap_or_else(|| Value::Object(Map::new()));
        let result = self
            .peer
            .request(
                "call_tool",
                json!({
                    "sessionId": self.session_id,
                    "name": name,
                    "arguments": arguments,
                }),
            )
            .await
            .map_err(|error| {
                ErrorData::internal_error(format!("InReview bridge error: {}", error.message), None)
            })?;
        let tool_result: CallToolResult = serde_json::from_value(result).map_err(|_| {
            ErrorData::internal_error("The InReview extension returned an invalid result.", None)
        })?;
        Ok(tool_result.into())
    }
}

pub async fn run(endpoint: String) -> Result<()> {
    let stream = connect_or_launch(&endpoint).await?;
    let peer = RpcPeer::start(stream, Arc::new(RejectRequests));
    let client_id = Uuid::new_v4();
    peer.request(
        "mcp_hello",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "clientId": client_id,
        }),
    )
    .await
    .map_err(|error| anyhow!(error.message))?;

    let session_id = Uuid::new_v4();
    let server = BridgeMcpServer {
        peer: Arc::clone(&peer),
        session_id,
    };
    let service = server
        .serve(stdio())
        .await
        .context("start MCP stdio server")?;
    let result = service.waiting().await.context("run MCP stdio server");
    let _ = peer
        .request("close_session", json!({ "sessionId": session_id }))
        .await;
    result.map(|_| ())
}

async fn connect_or_launch(endpoint: &str) -> Result<crate::protocol::BoxStream> {
    if let Ok(stream) = ipc::connect(endpoint).await {
        return Ok(stream);
    }
    let executable = std::env::current_exe().context("find bridge executable")?;
    Command::new(executable)
        .arg("daemon")
        .arg("--endpoint")
        .arg(endpoint)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("start bridge daemon")?;

    let deadline = Instant::now() + START_TIMEOUT;
    let mut last_error = None;
    while Instant::now() < deadline {
        match ipc::connect(endpoint).await {
            Ok(stream) => return Ok(stream),
            Err(error) => {
                last_error = Some(error);
                sleep(RETRY_DELAY).await;
            }
        }
    }
    let _ = last_error;
    Err(anyhow!("the InReview bridge daemon did not start"))
}

fn tool_definitions() -> Vec<Tool> {
    vec![
        tool(
            "list_workspaces",
            "List the canonical roots and host platforms of open workspaces registered with this InReview bridge.",
            json!({ "type": "object", "additionalProperties": false }),
        ),
        tool(
            "connect_workspace",
            "Connect this MCP session to the exact absolute jj workspace root registered by an open InReview extension.",
            json!({
                "type": "object",
                "properties": {
                    "workspace_root": { "type": "string", "minLength": 1, "maxLength": 32768 }
                },
                "required": ["workspace_root"],
                "additionalProperties": false
            }),
        ),
        tool(
            "read_review_metadata",
            "Read the connected active review identity, changes, snapshot, safe file manifest, and comment counts.",
            json!({ "type": "object", "additionalProperties": false }),
        ),
        tool(
            "read_comments",
            "Read bounded current, outdated, open, or resolved review comments. A side of old refers to immutable pre-change snapshot content; use the returned target line and exact stored context instead of the current working-tree line.",
            json!({
                "type": "object",
                "properties": {
                    "status": { "type": "string", "enum": ["open", "resolved", "all"] },
                    "outdated": { "type": "boolean" },
                    "file": { "type": "string", "minLength": 1, "maxLength": 32768 },
                    "comment_ids": { "type": "array", "items": { "type": "string", "format": "uuid" }, "maxItems": 100 },
                    "cursor": { "type": "string", "minLength": 1, "maxLength": 4096 },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100 }
                },
                "additionalProperties": false
            }),
        ),
        tool(
            "reply_comment",
            "Reply to one open review thread as Agent without resolving it.",
            json!({
                "type": "object",
                "properties": {
                    "comment_id": { "type": "string", "format": "uuid" },
                    "body": { "type": "string", "maxLength": 65536 }
                },
                "required": ["comment_id", "body"],
                "additionalProperties": false
            }),
        ),
        tool(
            "close_comments",
            "Atomically resolve one or more open review threads with optional Agent resolution notes.",
            json!({
                "type": "object",
                "properties": {
                    "comments": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 100,
                        "items": {
                            "type": "object",
                            "properties": {
                                "comment_id": { "type": "string", "format": "uuid" },
                                "resolution_note": { "type": "string", "maxLength": 65536 }
                            },
                            "required": ["comment_id"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["comments"],
                "additionalProperties": false
            }),
        ),
    ]
}

fn tool(name: &str, description: &str, schema: Value) -> Tool {
    Tool::new(
        name.to_owned(),
        description.to_owned(),
        Arc::new(serde_json::from_value(schema).expect("static tool schema must be valid")),
    )
}

fn is_tool_name(value: &str) -> bool {
    matches!(
        value,
        "list_workspaces"
            | "connect_workspace"
            | "read_review_metadata"
            | "read_comments"
            | "reply_comment"
            | "close_comments"
    )
}
