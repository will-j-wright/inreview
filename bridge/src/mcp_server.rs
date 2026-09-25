use std::{
    process::{Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow};
use async_trait::async_trait;
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
use tokio::{
    sync::Mutex,
    time::{sleep, timeout},
};
use uuid::Uuid;

use crate::{
    ipc,
    protocol::{BoxStream, PROTOCOL_VERSION, RejectRequests, RpcError, RpcPeer},
};

const START_TIMEOUT: Duration = Duration::from_secs(5);
const RETRY_DELAY: Duration = Duration::from_millis(50);
const WORKSPACE_WAIT_TIMEOUT: Duration = Duration::from_secs(15);
const WORKSPACE_RETRY_DELAY: Duration = Duration::from_millis(100);

#[derive(Clone)]
struct BridgeMcpServer {
    client: Arc<BridgeClient>,
}

#[derive(Clone)]
struct BridgeConnection {
    peer: Arc<RpcPeer>,
    session_id: Uuid,
}

#[derive(Default)]
struct BridgeClientState {
    connection: Option<BridgeConnection>,
    workspace_root: Option<String>,
    workspace_bound: bool,
}

#[async_trait]
trait BridgeConnector: Send + Sync {
    async fn connect(&self) -> Result<BoxStream>;
}

struct EndpointConnector {
    endpoint: String,
}

#[async_trait]
impl BridgeConnector for EndpointConnector {
    async fn connect(&self) -> Result<BoxStream> {
        connect_or_launch(&self.endpoint).await
    }
}

struct BridgeClient {
    connector: Arc<dyn BridgeConnector>,
    client_id: Uuid,
    state: Mutex<BridgeClientState>,
    reconnect: Mutex<()>,
}

impl BridgeClient {
    fn new(connector: Arc<dyn BridgeConnector>) -> Self {
        Self {
            connector,
            client_id: Uuid::new_v4(),
            state: Mutex::new(BridgeClientState::default()),
            reconnect: Mutex::new(()),
        }
    }

    async fn call_tool(&self, name: &str, arguments: Value) -> Result<Value, RpcError> {
        let retryable = is_retryable_tool(name);
        let mut retried = false;
        loop {
            let connection = self.connection().await?;
            if !matches!(name, "list_workspaces" | "connect_workspace") {
                match self.restore_workspace(&connection).await {
                    Ok(()) => {}
                    Err(error) if !retried && is_connection_error(&error) => {
                        self.invalidate(&connection).await;
                        retried = true;
                        continue;
                    }
                    Err(error) if is_connection_error(&error) => {
                        self.invalidate(&connection).await;
                        return Err(RpcError::new(
                            "BRIDGE_RECONNECT_REQUIRED",
                            "The InReview bridge reconnected, but the workspace connection could not be restored.",
                        ));
                    }
                    Err(error) => return Err(error),
                }
            }
            match self
                .request_tool(&connection, name, arguments.clone())
                .await
            {
                Ok(result) => {
                    let completed = if name == "list_workspaces" {
                        self.wait_for_workspace(&connection, result).await
                    } else if name == "connect_workspace" {
                        self.wait_for_workspace_connection(&connection, arguments.clone(), result)
                            .await
                    } else {
                        Ok(result)
                    };
                    match completed {
                        Ok(completed) => {
                            if name == "connect_workspace"
                                && tool_succeeded(&completed)
                                && let Some(root) = arguments
                                    .get("workspace_root")
                                    .and_then(Value::as_str)
                                    .map(ToOwned::to_owned)
                            {
                                let mut state = self.state.lock().await;
                                if state
                                    .connection
                                    .as_ref()
                                    .is_some_and(|current| current.peer.id == connection.peer.id)
                                {
                                    state.workspace_root = Some(root);
                                    state.workspace_bound = true;
                                }
                            }
                            return Ok(completed);
                        }
                        Err(error) if retryable && !retried && is_connection_error(&error) => {
                            self.invalidate(&connection).await;
                            retried = true;
                        }
                        Err(error) if is_connection_error(&error) => {
                            self.invalidate(&connection).await;
                            return Err(RpcError::new(
                                "BRIDGE_RECONNECT_REQUIRED",
                                "The InReview bridge reconnected, but the request could not be completed.",
                            ));
                        }
                        Err(error) => return Err(error),
                    }
                }
                Err(error) if retryable && !retried && is_connection_error(&error) => {
                    self.invalidate(&connection).await;
                    retried = true;
                }
                Err(error) if is_connection_error(&error) => {
                    self.invalidate(&connection).await;
                    return Err(RpcError::new(
                        "BRIDGE_RECONNECT_REQUIRED",
                        if retryable {
                            "The InReview bridge reconnected, but the request could not be completed."
                        } else {
                            "The InReview bridge disconnected while sending a change. The operation might have completed; reconnect and read the comments before retrying."
                        },
                    ));
                }
                Err(error) => return Err(error),
            }
        }
    }

    async fn connection(&self) -> Result<BridgeConnection, RpcError> {
        if let Some(connection) = self.live_connection().await {
            return Ok(connection);
        }
        let _guard = self.reconnect.lock().await;
        if let Some(connection) = self.live_connection().await {
            return Ok(connection);
        }
        for attempt in 0..2 {
            let stream = self.connector.connect().await.map_err(|_| {
                RpcError::new(
                    "BRIDGE_CONNECT_FAILED",
                    "The InReview bridge daemon could not be started or reached.",
                )
            })?;
            let peer = RpcPeer::start(stream, Arc::new(RejectRequests));
            match peer
                .request(
                    "mcp_hello",
                    json!({
                        "protocolVersion": PROTOCOL_VERSION,
                        "clientId": self.client_id,
                    }),
                )
                .await
            {
                Ok(_) => {
                    let connection = BridgeConnection {
                        peer,
                        session_id: Uuid::new_v4(),
                    };
                    let mut state = self.state.lock().await;
                    state.connection = Some(connection.clone());
                    state.workspace_bound = false;
                    return Ok(connection);
                }
                Err(error) if attempt == 0 && is_connection_error(&error) => {
                    peer.close().await;
                }
                Err(error) => {
                    peer.close().await;
                    return Err(error);
                }
            }
        }
        Err(RpcError::new(
            "BRIDGE_CONNECT_FAILED",
            "The InReview bridge daemon could not be started or reached.",
        ))
    }

    async fn live_connection(&self) -> Option<BridgeConnection> {
        let state = self.state.lock().await;
        state
            .connection
            .as_ref()
            .filter(|connection| !connection.peer.is_closed())
            .cloned()
    }

    async fn invalidate(&self, connection: &BridgeConnection) {
        let mut state = self.state.lock().await;
        if state
            .connection
            .as_ref()
            .is_some_and(|current| current.peer.id == connection.peer.id)
        {
            state.connection = None;
            state.workspace_bound = false;
        }
    }

    async fn restore_workspace(&self, connection: &BridgeConnection) -> Result<(), RpcError> {
        let root = {
            let state = self.state.lock().await;
            if state
                .connection
                .as_ref()
                .is_none_or(|current| current.peer.id != connection.peer.id)
                || state.workspace_bound
            {
                return Ok(());
            }
            state.workspace_root.clone()
        };
        let Some(root) = root else {
            return Ok(());
        };
        let arguments = json!({ "workspace_root": root });
        let first = self
            .request_tool(connection, "connect_workspace", arguments.clone())
            .await?;
        let result = self
            .wait_for_workspace_connection(connection, arguments, first)
            .await?;
        if !tool_succeeded(&result) {
            return Err(RpcError::new(
                "WORKSPACE_RECONNECT_FAILED",
                "The InReview workspace did not register after the bridge reconnected.",
            ));
        }
        let mut state = self.state.lock().await;
        if state
            .connection
            .as_ref()
            .is_some_and(|current| current.peer.id == connection.peer.id)
        {
            state.workspace_bound = true;
        }
        Ok(())
    }

    async fn request_tool(
        &self,
        connection: &BridgeConnection,
        name: &str,
        arguments: Value,
    ) -> Result<Value, RpcError> {
        connection
            .peer
            .request(
                "call_tool",
                json!({
                    "sessionId": connection.session_id,
                    "name": name,
                    "arguments": arguments,
                }),
            )
            .await
    }

    async fn wait_for_workspace(
        &self,
        connection: &BridgeConnection,
        initial: Value,
    ) -> Result<Value, RpcError> {
        if !workspace_list_is_empty(&initial) {
            return Ok(initial);
        }
        let wait = async {
            loop {
                sleep(WORKSPACE_RETRY_DELAY).await;
                let result = self
                    .request_tool(connection, "list_workspaces", json!({}))
                    .await?;
                if !workspace_list_is_empty(&result) {
                    return Ok(result);
                }
            }
        };
        match timeout(WORKSPACE_WAIT_TIMEOUT, wait).await {
            Ok(result) => result,
            Err(_) => Ok(initial),
        }
    }

    async fn wait_for_workspace_connection(
        &self,
        connection: &BridgeConnection,
        arguments: Value,
        initial: Value,
    ) -> Result<Value, RpcError> {
        if tool_succeeded(&initial) {
            return Ok(initial);
        }
        let wait = async {
            loop {
                sleep(WORKSPACE_RETRY_DELAY).await;
                let result = self
                    .request_tool(connection, "connect_workspace", arguments.clone())
                    .await?;
                if tool_succeeded(&result) {
                    return Ok(result);
                }
            }
        };
        match timeout(WORKSPACE_WAIT_TIMEOUT, wait).await {
            Ok(result) => result,
            Err(_) => Ok(initial),
        }
    }

    async fn close(&self) {
        let connection = self.state.lock().await.connection.take();
        if let Some(connection) = connection {
            let _ = connection
                .peer
                .request(
                    "close_session",
                    json!({ "sessionId": connection.session_id }),
                )
                .await;
            connection.peer.close().await;
        }
    }
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
            .client
            .call_tool(&name, arguments)
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
    let client = Arc::new(BridgeClient::new(Arc::new(EndpointConnector { endpoint })));
    client
        .connection()
        .await
        .map_err(|error| anyhow!(error.message))?;
    let server = BridgeMcpServer {
        client: Arc::clone(&client),
    };
    let service = server
        .serve(stdio())
        .await
        .context("start MCP stdio server")?;
    let result = service.waiting().await.context("run MCP stdio server");
    client.close().await;
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

fn is_retryable_tool(value: &str) -> bool {
    matches!(
        value,
        "list_workspaces" | "connect_workspace" | "read_review_metadata" | "read_comments"
    )
}

fn is_connection_error(error: &RpcError) -> bool {
    matches!(
        error.code.as_str(),
        "BRIDGE_DISCONNECTED" | "BRIDGE_WRITE_FAILED"
    )
}

fn tool_succeeded(value: &Value) -> bool {
    value.get("isError").and_then(Value::as_bool) != Some(true)
}

fn workspace_list_is_empty(value: &Value) -> bool {
    value
        .get("structuredContent")
        .and_then(|structured| structured.get("workspaces"))
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty)
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
    };

    use async_trait::async_trait;
    use serde_json::{Value, json};
    use tokio::{
        io::duplex,
        sync::Mutex,
        time::{Duration, sleep},
    };

    use super::*;
    use crate::protocol::RequestHandler;

    struct TestConnector {
        streams: Mutex<VecDeque<BoxStream>>,
        connections: AtomicUsize,
    }

    #[async_trait]
    impl BridgeConnector for TestConnector {
        async fn connect(&self) -> Result<BoxStream> {
            self.connections.fetch_add(1, Ordering::AcqRel);
            self.streams
                .lock()
                .await
                .pop_front()
                .ok_or_else(|| anyhow!("no test bridge stream is available"))
        }
    }

    struct TestDaemon {
        workspace_registered: AtomicBool,
        hellos: AtomicUsize,
        workspace_connections: AtomicUsize,
    }

    #[async_trait]
    impl RequestHandler for TestDaemon {
        async fn handle(
            &self,
            _peer: Arc<RpcPeer>,
            method: String,
            params: Value,
        ) -> Result<Value, RpcError> {
            match method.as_str() {
                "mcp_hello" => {
                    self.hellos.fetch_add(1, Ordering::AcqRel);
                    Ok(json!({}))
                }
                "call_tool"
                    if params.get("name").and_then(Value::as_str) == Some("list_workspaces") =>
                {
                    Ok(workspace_list_result(
                        self.workspace_registered.load(Ordering::Acquire),
                    ))
                }
                "call_tool"
                    if params.get("name").and_then(Value::as_str) == Some("connect_workspace") =>
                {
                    if self.workspace_registered.load(Ordering::Acquire) {
                        self.workspace_connections.fetch_add(1, Ordering::AcqRel);
                        Ok(successful_tool_result("connected"))
                    } else {
                        Ok(failed_tool_result("WORKSPACE_MISMATCH"))
                    }
                }
                "call_tool"
                    if params.get("name").and_then(Value::as_str)
                        == Some("read_review_metadata") =>
                {
                    Ok(successful_tool_result("success"))
                }
                "close_session" => Ok(json!({})),
                _ => Err(RpcError::new(
                    "UNEXPECTED_TEST_CALL",
                    "Unexpected test call.",
                )),
            }
        }
    }

    fn workspace_list_result(registered: bool) -> Value {
        let workspaces = if registered {
            vec![json!({
                "canonicalRoot": "/work/repo",
                "platform": "linux",
            })]
        } else {
            Vec::new()
        };
        let structured = json!({
            "status": "success",
            "workspaces": workspaces,
        });
        json!({
            "content": [{
                "type": "text",
                "text": structured.to_string(),
            }],
            "structuredContent": structured,
            "isError": false,
        })
    }

    fn successful_tool_result(status: &str) -> Value {
        let structured = json!({ "status": status });
        json!({
            "content": [{
                "type": "text",
                "text": structured.to_string(),
            }],
            "structuredContent": structured,
            "isError": false,
        })
    }

    fn failed_tool_result(code: &str) -> Value {
        let structured = json!({
            "status": "error",
            "error": {
                "code": code,
                "message": "The workspace is not registered.",
                "reconnectRequired": false,
            },
        });
        json!({
            "content": [{
                "type": "text",
                "text": structured.to_string(),
            }],
            "structuredContent": structured,
            "isError": true,
        })
    }

    fn test_connection(daemon: Arc<TestDaemon>) -> (BoxStream, Arc<RpcPeer>) {
        let (client, server) = duplex(16 * 1024);
        let peer = RpcPeer::start(Box::new(server), daemon);
        (Box::new(client), peer)
    }

    #[tokio::test]
    async fn reconnects_after_the_daemon_connection_closes() {
        let daemon = Arc::new(TestDaemon {
            workspace_registered: AtomicBool::new(true),
            hellos: AtomicUsize::new(0),
            workspace_connections: AtomicUsize::new(0),
        });
        let (first_stream, first_peer) = test_connection(Arc::clone(&daemon));
        let (second_stream, _second_peer) = test_connection(Arc::clone(&daemon));
        let connector = Arc::new(TestConnector {
            streams: Mutex::new(VecDeque::from([first_stream, second_stream])),
            connections: AtomicUsize::new(0),
        });
        let client = BridgeClient::new(connector.clone());

        assert!(!workspace_list_is_empty(
            &client
                .call_tool("list_workspaces", json!({}))
                .await
                .unwrap()
        ));
        first_peer.close().await;
        for _ in 0..50 {
            if client.live_connection().await.is_none() {
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }
        assert!(!workspace_list_is_empty(
            &client
                .call_tool("list_workspaces", json!({}))
                .await
                .unwrap()
        ));
        assert_eq!(connector.connections.load(Ordering::Acquire), 2);
        assert_eq!(daemon.hellos.load(Ordering::Acquire), 2);
    }

    #[tokio::test]
    async fn waits_for_a_workspace_that_registers_after_copilot_starts() {
        let daemon = Arc::new(TestDaemon {
            workspace_registered: AtomicBool::new(false),
            hellos: AtomicUsize::new(0),
            workspace_connections: AtomicUsize::new(0),
        });
        let (stream, _peer) = test_connection(Arc::clone(&daemon));
        let connector = Arc::new(TestConnector {
            streams: Mutex::new(VecDeque::from([stream])),
            connections: AtomicUsize::new(0),
        });
        let client = BridgeClient::new(connector);
        let registering_daemon = Arc::clone(&daemon);
        tokio::spawn(async move {
            sleep(Duration::from_millis(150)).await;
            registering_daemon
                .workspace_registered
                .store(true, Ordering::Release);
        });

        let result = client
            .call_tool("list_workspaces", json!({}))
            .await
            .unwrap();

        assert!(!workspace_list_is_empty(&result));
        assert_eq!(daemon.hellos.load(Ordering::Acquire), 1);
    }

    #[tokio::test]
    async fn restores_the_workspace_binding_after_reconnecting() {
        let daemon = Arc::new(TestDaemon {
            workspace_registered: AtomicBool::new(true),
            hellos: AtomicUsize::new(0),
            workspace_connections: AtomicUsize::new(0),
        });
        let (first_stream, first_peer) = test_connection(Arc::clone(&daemon));
        let (second_stream, _second_peer) = test_connection(Arc::clone(&daemon));
        let connector = Arc::new(TestConnector {
            streams: Mutex::new(VecDeque::from([first_stream, second_stream])),
            connections: AtomicUsize::new(0),
        });
        let client = BridgeClient::new(connector);

        assert!(tool_succeeded(
            &client
                .call_tool(
                    "connect_workspace",
                    json!({ "workspace_root": "/work/repo" }),
                )
                .await
                .unwrap()
        ));
        first_peer.close().await;
        for _ in 0..50 {
            if client.live_connection().await.is_none() {
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }

        let result = client
            .call_tool("read_review_metadata", json!({}))
            .await
            .unwrap();

        assert!(tool_succeeded(&result));
        assert_eq!(daemon.workspace_connections.load(Ordering::Acquire), 2);
        assert_eq!(daemon.hellos.load(Ordering::Acquire), 2);
    }
}
