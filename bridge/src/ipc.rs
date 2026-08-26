#[cfg(unix)]
use std::path::Path;

#[cfg(unix)]
use anyhow::Context;
use anyhow::{Result, anyhow};

use crate::protocol::BoxStream;

pub async fn connect(endpoint: &str) -> Result<BoxStream> {
    validate_endpoint(endpoint)?;
    connect_platform(endpoint).await
}

pub fn validate_endpoint(endpoint: &str) -> Result<()> {
    if endpoint.is_empty() || endpoint.len() > 32_768 || endpoint.contains('\0') {
        return Err(anyhow!("invalid bridge endpoint"));
    }
    #[cfg(unix)]
    if !Path::new(endpoint).is_absolute() {
        return Err(anyhow!("the bridge socket path must be absolute"));
    }
    #[cfg(windows)]
    if !endpoint.starts_with(r"\\.\pipe\inreview-") {
        return Err(anyhow!("the bridge named pipe is invalid"));
    }
    Ok(())
}

#[cfg(unix)]
async fn connect_platform(endpoint: &str) -> Result<BoxStream> {
    let stream = tokio::net::UnixStream::connect(endpoint)
        .await
        .with_context(|| format!("connect to bridge socket {endpoint}"))?;
    Ok(Box::new(stream))
}

#[cfg(windows)]
async fn connect_platform(endpoint: &str) -> Result<BoxStream> {
    use std::time::Duration;
    use tokio::net::windows::named_pipe::ClientOptions;
    use tokio::time::sleep;

    let mut last_error = None;
    for _ in 0..100 {
        match ClientOptions::new().open(endpoint) {
            Ok(client) => return Ok(Box::new(client)),
            Err(error) => {
                last_error = Some(error);
                sleep(Duration::from_millis(50)).await;
            }
        }
    }
    Err(last_error
        .map(anyhow::Error::from)
        .unwrap_or_else(|| anyhow!("could not connect to the bridge named pipe")))
}
