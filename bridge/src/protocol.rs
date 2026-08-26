use std::{collections::HashMap, sync::Arc, time::Duration};

use anyhow::{Context, Result, anyhow};
use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{Mutex, oneshot},
    time::timeout,
};
use uuid::Uuid;

pub const PROTOCOL_VERSION: u64 = 2;
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub trait AsyncStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T> AsyncStream for T where T: AsyncRead + AsyncWrite + Unpin + Send {}
pub type BoxStream = Box<dyn AsyncStream>;

#[derive(Debug)]
pub struct RpcError {
    pub code: String,
    pub message: String,
}

impl RpcError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[async_trait]
pub trait RequestHandler: Send + Sync {
    async fn handle(
        &self,
        peer: Arc<RpcPeer>,
        method: String,
        params: Value,
    ) -> Result<Value, RpcError>;

    async fn disconnected(&self, _peer: Arc<RpcPeer>) {}
}

type PendingSender = oneshot::Sender<Result<Value, RpcError>>;

pub struct RpcPeer {
    pub id: Uuid,
    writer: Mutex<tokio::io::WriteHalf<BoxStream>>,
    pending: Mutex<HashMap<String, PendingSender>>,
}

impl RpcPeer {
    pub fn start(stream: BoxStream, handler: Arc<dyn RequestHandler>) -> Arc<Self> {
        let (reader, writer) = tokio::io::split(stream);
        let peer = Arc::new(Self {
            id: Uuid::new_v4(),
            writer: Mutex::new(writer),
            pending: Mutex::new(HashMap::new()),
        });
        let task_peer = Arc::clone(&peer);
        tokio::spawn(async move {
            let _ = read_loop(Arc::clone(&task_peer), reader, Arc::clone(&handler)).await;
            task_peer
                .fail_pending("BRIDGE_DISCONNECTED", "The bridge connection closed.")
                .await;
            handler.disconnected(task_peer).await;
        });
        peer
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), sender);
        if let Err(error) = self
            .send(&json!({
                "type": "request",
                "id": id,
                "method": method,
                "params": params,
            }))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(RpcError::new("BRIDGE_WRITE_FAILED", error.to_string()));
        }
        match timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(RpcError::new(
                "BRIDGE_DISCONNECTED",
                "The bridge connection closed.",
            )),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(RpcError::new(
                    "BRIDGE_TIMEOUT",
                    "The bridge request timed out.",
                ))
            }
        }
    }

    async fn send(&self, message: &Value) -> Result<()> {
        let mut encoded = serde_json::to_vec(message).context("serialize bridge message")?;
        encoded.push(b'\n');
        if encoded.len() > MAX_MESSAGE_BYTES {
            return Err(anyhow!("bridge message exceeds the size limit"));
        }
        let mut writer = self.writer.lock().await;
        writer
            .write_all(&encoded)
            .await
            .context("write bridge message")?;
        writer.flush().await.context("flush bridge message")
    }

    async fn respond(&self, id: String, result: Result<Value, RpcError>) -> Result<()> {
        let message = match result {
            Ok(value) => json!({
                "type": "response",
                "id": id,
                "ok": true,
                "result": value,
            }),
            Err(error) => json!({
                "type": "response",
                "id": id,
                "ok": false,
                "error": {
                    "code": error.code,
                    "message": error.message,
                },
            }),
        };
        self.send(&message).await
    }

    async fn resolve_response(&self, message: &Value) -> Result<()> {
        let id = required_string(message, "id")?;
        let sender = self
            .pending
            .lock()
            .await
            .remove(&id)
            .ok_or_else(|| anyhow!("unknown bridge response"))?;
        let result = if message.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(message.get("result").cloned().unwrap_or(Value::Null))
        } else {
            let error = message
                .get("error")
                .and_then(Value::as_object)
                .ok_or_else(|| anyhow!("invalid bridge error response"))?;
            Err(RpcError::new(
                error
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("BRIDGE_REQUEST_FAILED"),
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("The bridge request failed."),
            ))
        };
        let _ = sender.send(result);
        Ok(())
    }

    async fn fail_pending(&self, code: &str, message: &str) {
        let pending = std::mem::take(&mut *self.pending.lock().await);
        for sender in pending.into_values() {
            let _ = sender.send(Err(RpcError::new(code, message)));
        }
    }
}

async fn read_loop<R>(peer: Arc<RpcPeer>, reader: R, handler: Arc<dyn RequestHandler>) -> Result<()>
where
    R: AsyncRead + Unpin,
{
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    loop {
        line.clear();
        if !read_bounded_line(&mut reader, &mut line).await? {
            return Ok(());
        }
        if line.is_empty() {
            continue;
        }
        let message: Value = serde_json::from_slice(&line).context("parse bridge message")?;
        match message.get("type").and_then(Value::as_str) {
            Some("response") => peer.resolve_response(&message).await?,
            Some("request") => {
                let id = required_string(&message, "id")?;
                let method = required_string(&message, "method")?;
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                let request_peer = Arc::clone(&peer);
                let request_handler = Arc::clone(&handler);
                tokio::spawn(async move {
                    let result = request_handler
                        .handle(Arc::clone(&request_peer), method, params)
                        .await;
                    let _ = request_peer.respond(id, result).await;
                });
            }
            _ => return Err(anyhow!("invalid bridge message type")),
        }
    }

    async fn read_bounded_line<R>(reader: &mut BufReader<R>, line: &mut Vec<u8>) -> Result<bool>
    where
        R: AsyncRead + Unpin,
    {
        loop {
            let available = reader.fill_buf().await.context("read bridge message")?;
            if available.is_empty() {
                return Ok(!line.is_empty());
            }
            let newline = available.iter().position(|value| *value == b'\n');
            let take = newline.unwrap_or(available.len());
            if line.len() + take > MAX_MESSAGE_BYTES {
                return Err(anyhow!("bridge message exceeds the size limit"));
            }
            line.extend_from_slice(&available[..take]);
            reader.consume(take + usize::from(newline.is_some()));
            if newline.is_some() {
                return Ok(true);
            }
        }
    }
}

fn required_string(value: &Value, name: &str) -> Result<String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow!("invalid bridge {name}"))
}

pub struct RejectRequests;

#[async_trait]
impl RequestHandler for RejectRequests {
    async fn handle(
        &self,
        _peer: Arc<RpcPeer>,
        _method: String,
        _params: Value,
    ) -> Result<Value, RpcError> {
        Err(RpcError::new(
            "UNKNOWN_METHOD",
            "The bridge daemon requested an unsupported operation.",
        ))
    }
}
