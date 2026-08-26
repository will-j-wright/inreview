#[cfg(unix)]
use std::path::Path;
use std::{
    collections::{HashMap, HashSet},
    fs::{File, OpenOptions},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use anyhow::{Context, Result, anyhow};
use async_trait::async_trait;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
#[cfg(windows)]
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    ipc::validate_endpoint,
    protocol::{BoxStream, PROTOCOL_VERSION, RequestHandler, RpcError, RpcPeer},
};

const MAX_CONNECTIONS: usize = 64;
const IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registration {
    protocol_version: u64,
    bridge_version: String,
    instance_id: Uuid,
    canonical_workspace_root: String,
    repository_fingerprint: String,
    platform: Platform,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Platform {
    Win32,
    Linux,
    Darwin,
}

struct RegisteredWorkspace {
    registration_id: Uuid,
    registration: Registration,
    peer: Arc<RpcPeer>,
}

enum PeerRole {
    Extension { registration_id: Uuid },
    Mcp { client_id: Uuid },
}

#[derive(Default)]
struct DaemonData {
    roles: HashMap<Uuid, PeerRole>,
    workspaces: HashMap<String, RegisteredWorkspace>,
    session_bindings: HashMap<Uuid, Uuid>,
    session_owners: HashMap<Uuid, Uuid>,
    stale_sessions: HashSet<Uuid>,
}

#[derive(Default)]
struct DaemonState {
    data: Mutex<DaemonData>,
    connections: AtomicUsize,
}

#[async_trait]
impl RequestHandler for DaemonState {
    async fn handle(
        &self,
        peer: Arc<RpcPeer>,
        method: String,
        params: Value,
    ) -> Result<Value, RpcError> {
        match method.as_str() {
            "register_workspace" => self.register_workspace(peer, params).await,
            "mcp_hello" => self.mcp_hello(peer, params).await,
            "call_tool" => self.call_tool(peer, params).await,
            "close_session" => self.close_session(peer, params).await,
            _ => Err(RpcError::new(
                "UNKNOWN_METHOD",
                "The bridge operation is not supported.",
            )),
        }
    }

    async fn disconnected(&self, peer: Arc<RpcPeer>) {
        self.remove_peer(peer.id).await;
        self.connections.fetch_sub(1, Ordering::AcqRel);
    }
}

impl DaemonState {
    async fn register_workspace(
        &self,
        peer: Arc<RpcPeer>,
        params: Value,
    ) -> Result<Value, RpcError> {
        let registration: Registration = serde_json::from_value(params).map_err(|_| {
            RpcError::new(
                "INVALID_REGISTRATION",
                "The workspace registration is invalid.",
            )
        })?;
        if registration.protocol_version != PROTOCOL_VERSION {
            return Err(RpcError::new(
                "INCOMPATIBLE_PROTOCOL",
                "The extension and bridge protocol versions do not match.",
            ));
        }
        if registration.instance_id.is_nil()
            || registration.bridge_version.is_empty()
            || registration.bridge_version.len() > 64
            || registration.canonical_workspace_root.is_empty()
            || registration.canonical_workspace_root.len() > 32_768
            || registration.repository_fingerprint.len() != 64
            || !registration
                .repository_fingerprint
                .bytes()
                .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())
        {
            return Err(RpcError::new(
                "INVALID_REGISTRATION",
                "The workspace registration is invalid.",
            ));
        }
        let key = workspace_key(
            &registration.canonical_workspace_root,
            registration.platform,
        )
        .map_err(|_| {
            RpcError::new(
                "INVALID_REGISTRATION",
                "The workspace registration is invalid.",
            )
        })?;
        let mut data = self.data.lock().await;
        if data.roles.contains_key(&peer.id) {
            return Err(RpcError::new(
                "ALREADY_REGISTERED",
                "This bridge connection is already registered.",
            ));
        }
        if data.workspaces.contains_key(&key) {
            return Err(RpcError::new(
                "DUPLICATE_WORKSPACE",
                "Another extension instance already registered this workspace.",
            ));
        }
        if data
            .workspaces
            .values()
            .any(|workspace| workspace.registration.instance_id == registration.instance_id)
        {
            return Err(RpcError::new(
                "DUPLICATE_INSTANCE",
                "This extension instance is already registered.",
            ));
        }
        let registration_id = Uuid::new_v4();
        data.roles
            .insert(peer.id, PeerRole::Extension { registration_id });
        data.workspaces.insert(
            key,
            RegisteredWorkspace {
                registration_id,
                registration,
                peer,
            },
        );
        Ok(json!({ "registrationId": registration_id }))
    }

    async fn mcp_hello(&self, peer: Arc<RpcPeer>, params: Value) -> Result<Value, RpcError> {
        let protocol_version = params
            .get("protocolVersion")
            .and_then(Value::as_u64)
            .ok_or_else(|| RpcError::new("INVALID_CLIENT", "The MCP bridge client is invalid."))?;
        let client_id = params
            .get("clientId")
            .and_then(Value::as_str)
            .and_then(|value| Uuid::parse_str(value).ok())
            .ok_or_else(|| RpcError::new("INVALID_CLIENT", "The MCP bridge client is invalid."))?;
        if protocol_version != PROTOCOL_VERSION {
            return Err(RpcError::new(
                "INCOMPATIBLE_PROTOCOL",
                "The MCP frontend and bridge daemon protocol versions do not match.",
            ));
        }
        let mut data = self.data.lock().await;
        if data.roles.contains_key(&peer.id) {
            return Err(RpcError::new(
                "ALREADY_REGISTERED",
                "This bridge connection is already registered.",
            ));
        }
        data.roles.insert(peer.id, PeerRole::Mcp { client_id });
        Ok(json!({}))
    }

    async fn call_tool(&self, peer: Arc<RpcPeer>, params: Value) -> Result<Value, RpcError> {
        let session_id = parse_uuid(&params, "sessionId", "INVALID_SESSION")?;
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| is_tool_name(name))
            .ok_or_else(|| RpcError::new("INVALID_TOOL", "The MCP tool name is invalid."))?
            .to_owned();
        let arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()));

        let target = {
            let mut data = self.data.lock().await;
            let client_id = match data.roles.get(&peer.id) {
                Some(PeerRole::Mcp { client_id }) => *client_id,
                _ => {
                    return Err(RpcError::new(
                        "CLIENT_NOT_REGISTERED",
                        "The MCP frontend is not registered.",
                    ));
                }
            };
            if client_id == Uuid::nil() {
                return Err(RpcError::new(
                    "INVALID_CLIENT",
                    "The MCP frontend identity is invalid.",
                ));
            }
            match data.session_owners.get(&session_id) {
                Some(owner) if *owner != peer.id => {
                    return Err(RpcError::new(
                        "SESSION_CONFLICT",
                        "The MCP session belongs to another client.",
                    ));
                }
                Some(_) => {}
                None => {
                    data.session_owners.insert(session_id, peer.id);
                }
            }

            if name == "list_workspaces" {
                if arguments
                    .as_object()
                    .is_none_or(|arguments| !arguments.is_empty())
                {
                    return Err(RpcError::new(
                        "INVALID_TOOL",
                        "The list_workspaces arguments are invalid.",
                    ));
                }
                return Ok(workspace_list(&data.workspaces));
            } else if name == "connect_workspace" {
                let root = arguments
                    .get("workspace_root")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        RpcError::new("WORKSPACE_MISMATCH", "The workspace root is invalid.")
                    })?;
                find_workspace(&data.workspaces, root)
            } else {
                data.session_bindings
                    .get(&session_id)
                    .and_then(|registration_id| {
                        data.workspaces
                            .values()
                            .find(|workspace| workspace.registration_id == *registration_id)
                    })
                    .map(|workspace| (workspace.registration_id, Arc::clone(&workspace.peer)))
            }
        };

        let Some((registration_id, extension_peer)) = target else {
            let data = self.data.lock().await;
            let stale = data.stale_sessions.contains(&session_id);
            return Ok(tool_error(
                if stale {
                    "STALE_CONNECTION"
                } else if name == "connect_workspace" {
                    "WORKSPACE_MISMATCH"
                } else {
                    "NOT_CONNECTED"
                },
                if stale {
                    "The registered VS Code workspace disconnected. Call connect_workspace again."
                } else if name == "connect_workspace" {
                    "No open InReview workspace matches the requested root."
                } else {
                    "Call connect_workspace before using this tool."
                },
                stale,
            ));
        };

        let result = extension_peer
            .request(
                "call_tool",
                json!({
                    "sessionId": session_id,
                    "name": name,
                    "arguments": arguments,
                }),
            )
            .await?;
        if name == "connect_workspace" {
            let connected = result
                .get("structuredContent")
                .and_then(|value| value.get("status"))
                .and_then(Value::as_str)
                == Some("connected");
            let previous_extension = {
                let mut data = self.data.lock().await;
                let previous = data.session_bindings.remove(&session_id);
                if connected {
                    data.session_bindings.insert(session_id, registration_id);
                    data.stale_sessions.remove(&session_id);
                }
                previous
                    .filter(|previous| *previous != registration_id)
                    .and_then(|previous| {
                        data.workspaces
                            .values()
                            .find(|workspace| workspace.registration_id == previous)
                            .map(|workspace| Arc::clone(&workspace.peer))
                    })
            };
            if let Some(previous_extension) = previous_extension {
                let _ = previous_extension
                    .request("close_session", json!({ "sessionId": session_id }))
                    .await;
            }
        }
        Ok(result)
    }

    async fn close_session(&self, peer: Arc<RpcPeer>, params: Value) -> Result<Value, RpcError> {
        let session_id = parse_uuid(&params, "sessionId", "INVALID_SESSION")?;
        let extension = {
            let mut data = self.data.lock().await;
            if data.session_owners.get(&session_id) != Some(&peer.id) {
                return Ok(json!({}));
            }
            data.session_owners.remove(&session_id);
            data.stale_sessions.remove(&session_id);
            data.session_bindings
                .remove(&session_id)
                .and_then(|registration_id| {
                    data.workspaces
                        .values()
                        .find(|workspace| workspace.registration_id == registration_id)
                        .map(|workspace| Arc::clone(&workspace.peer))
                })
        };
        if let Some(extension) = extension {
            let _ = extension
                .request("close_session", json!({ "sessionId": session_id }))
                .await;
        }
        Ok(json!({}))
    }

    async fn remove_peer(&self, peer_id: Uuid) {
        let close_requests = {
            let mut data = self.data.lock().await;
            let role = data.roles.remove(&peer_id);
            match role {
                Some(PeerRole::Extension { registration_id }) => {
                    data.workspaces
                        .retain(|_, workspace| workspace.registration_id != registration_id);
                    let sessions: Vec<Uuid> = data
                        .session_bindings
                        .iter()
                        .filter_map(|(session, bound)| {
                            (*bound == registration_id).then_some(*session)
                        })
                        .collect();
                    for session in &sessions {
                        data.session_bindings.remove(session);
                        data.stale_sessions.insert(*session);
                    }
                    Vec::new()
                }
                Some(PeerRole::Mcp { .. }) => {
                    let sessions: Vec<Uuid> = data
                        .session_owners
                        .iter()
                        .filter_map(|(session, owner)| (*owner == peer_id).then_some(*session))
                        .collect();
                    let close_requests = sessions
                        .iter()
                        .filter_map(|session| {
                            data.session_bindings
                                .remove(session)
                                .and_then(|registration_id| {
                                    data.workspaces
                                        .values()
                                        .find(|workspace| {
                                            workspace.registration_id == registration_id
                                        })
                                        .map(|workspace| (Arc::clone(&workspace.peer), *session))
                                })
                        })
                        .collect::<Vec<_>>();
                    for session in &sessions {
                        data.session_owners.remove(session);
                        data.stale_sessions.remove(session);
                    }
                    close_requests
                }
                None => Vec::new(),
            }
        };
        for (extension, session_id) in close_requests {
            let _ = extension
                .request("close_session", json!({ "sessionId": session_id }))
                .await;
        }
    }
}

fn find_workspace(
    workspaces: &HashMap<String, RegisteredWorkspace>,
    requested_root: &str,
) -> Option<(Uuid, Arc<RpcPeer>)> {
    workspaces.values().find_map(|workspace| {
        let requested_key = workspace_key(requested_root, workspace.registration.platform).ok()?;
        let registered_key = workspace_key(
            &workspace.registration.canonical_workspace_root,
            workspace.registration.platform,
        )
        .ok()?;
        (requested_key == registered_key)
            .then(|| (workspace.registration_id, Arc::clone(&workspace.peer)))
    })
}

fn workspace_key(value: &str, platform: Platform) -> Result<String> {
    if value.is_empty()
        || value.len() > 32_768
        || value.contains('\0')
        || has_parent_segment(value, platform)
    {
        return Err(anyhow!("invalid workspace root"));
    }
    let separators: &[char] = match platform {
        Platform::Win32 => &['\\', '/'],
        Platform::Linux | Platform::Darwin => &['/'],
    };
    let normalized = value.trim_end_matches(separators);
    if normalized.is_empty() {
        return Ok(value.to_owned());
    }
    Ok(match platform {
        Platform::Win32 => normalized.to_lowercase(),
        Platform::Linux | Platform::Darwin => normalized.to_owned(),
    })
}

fn has_parent_segment(value: &str, platform: Platform) -> bool {
    let segments = match platform {
        Platform::Win32 => value.split(['\\', '/']).collect::<Vec<_>>(),
        Platform::Linux | Platform::Darwin => value.split('/').collect::<Vec<_>>(),
    };
    segments.contains(&"..")
}

fn parse_uuid(value: &Value, field: &str, code: &str) -> Result<Uuid, RpcError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(|| RpcError::new(code, "The bridge session identifier is invalid."))
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

fn workspace_list(workspaces: &HashMap<String, RegisteredWorkspace>) -> Value {
    let mut listed = workspaces
        .values()
        .map(|workspace| {
            json!({
                "canonicalRoot": workspace.registration.canonical_workspace_root,
                "platform": workspace.registration.platform,
            })
        })
        .collect::<Vec<_>>();
    listed.sort_by(|left, right| {
        left["canonicalRoot"]
            .as_str()
            .cmp(&right["canonicalRoot"].as_str())
    });
    let structured = json!({
        "status": "success",
        "workspaces": listed,
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

fn tool_error(code: &str, message: &str, reconnect_required: bool) -> Value {
    let structured = json!({
        "status": "error",
        "error": {
            "code": code,
            "message": message,
            "reconnectRequired": reconnect_required,
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

pub async fn run(endpoint: String) -> Result<()> {
    validate_endpoint(&endpoint)?;
    let Some(_lock) = acquire_daemon_lock(&endpoint).await? else {
        return Ok(());
    };
    let state = Arc::new(DaemonState::default());
    listen(endpoint, state).await
}

async fn acquire_daemon_lock(endpoint: &str) -> Result<Option<File>> {
    let lock_path = daemon_lock_path(endpoint);
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)
        .context("open bridge daemon lock")?;
    if FileExt::try_lock_exclusive(&file).is_ok() {
        return Ok(Some(file));
    }
    for _ in 0..100 {
        if crate::ipc::connect(endpoint).await.is_ok() {
            return Ok(None);
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Err(anyhow!("another bridge daemon is starting"))
}

#[cfg(unix)]
fn daemon_lock_path(endpoint: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(format!("{endpoint}.lock"))
}

#[cfg(windows)]
fn daemon_lock_path(endpoint: &str) -> std::path::PathBuf {
    let digest = Sha256::digest(endpoint.as_bytes());
    std::env::temp_dir().join(format!("inreview-{digest:x}.lock"))
}

async fn serve_connection(stream: BoxStream, state: Arc<DaemonState>) {
    RpcPeer::start(stream, state);
}

fn reserve_connection(state: &DaemonState) -> bool {
    if state.connections.fetch_add(1, Ordering::AcqRel) >= MAX_CONNECTIONS {
        state.connections.fetch_sub(1, Ordering::AcqRel);
        return false;
    }
    true
}

#[cfg(unix)]
async fn listen(endpoint: String, state: Arc<DaemonState>) -> Result<()> {
    use tokio::net::{UnixListener, UnixStream};

    if Path::new(&endpoint).exists() {
        if UnixStream::connect(&endpoint).await.is_ok() {
            return Ok(());
        }

        std::fs::remove_file(&endpoint).context("remove stale bridge socket")?;
    }
    let listener = UnixListener::bind(&endpoint).context("bind bridge socket")?;
    let permissions = std::os::unix::fs::PermissionsExt::from_mode(0o600);
    std::fs::set_permissions(&endpoint, permissions).context("secure bridge socket")?;
    loop {
        tokio::select! {
            biased;
            accepted = listener.accept() => {
                let (stream, _) = accepted.context("accept bridge connection")?;
                if reserve_connection(&state) {
                    tokio::spawn(serve_connection(Box::new(stream), Arc::clone(&state)));
                }
            }
            () = tokio::time::sleep(IDLE_TIMEOUT) => {
                if state.connections.load(Ordering::Acquire) == 0 {
                    std::fs::remove_file(&endpoint).context("remove bridge socket")?;
                    return Ok(());
                }
            }
        }
    }
}

#[cfg(windows)]
async fn listen(endpoint: String, state: Arc<DaemonState>) -> Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;

    let mut first = true;
    loop {
        let server = match ServerOptions::new()
            .first_pipe_instance(first)
            .create(&endpoint)
        {
            Ok(server) => server,
            Err(error) if first => {
                if crate::ipc::connect(&endpoint).await.is_ok() {
                    return Ok(());
                }
                return Err(error).context("create bridge named pipe");
            }
            Err(error) => return Err(error).context("create bridge named pipe"),
        };
        first = false;
        tokio::select! {
            biased;
            connected = server.connect() => {
                connected.context("accept bridge named pipe")?;
                if reserve_connection(&state) {
                    tokio::spawn(serve_connection(Box::new(server), Arc::clone(&state)));
                }
            }
            () = tokio::time::sleep(IDLE_TIMEOUT) => {
                if state.connections.load(Ordering::Acquire) == 0 {
                    return Ok(());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_keys_follow_target_platform_path_rules() {
        assert_eq!(
            workspace_key(r"C:\Work\Repo\\", Platform::Win32).unwrap(),
            r"c:\work\repo"
        );
        assert_eq!(
            workspace_key("/Work/Repo/", Platform::Linux).unwrap(),
            "/Work/Repo"
        );
        assert_ne!(
            workspace_key("/Work/Repo", Platform::Linux).unwrap(),
            workspace_key("/work/repo", Platform::Linux).unwrap()
        );
    }

    #[test]
    fn workspace_keys_reject_traversal_segments() {
        assert!(workspace_key("/work/child/..", Platform::Linux).is_err());
        assert!(workspace_key(r"C:\work\child\..", Platform::Win32).is_err());
    }

    #[test]
    fn tool_errors_do_not_expose_storage_paths() {
        let value = tool_error("NOT_CONNECTED", "Connect first.", false);
        assert_eq!(value["structuredContent"]["error"]["code"], "NOT_CONNECTED");
        assert_eq!(value["isError"], true);
        assert!(!value.to_string().contains("/home/"));
    }
}
