mod daemon;
mod ipc;
mod mcp_server;
mod protocol;

use anyhow::{Result, anyhow};

#[tokio::main]
async fn main() -> Result<()> {
    let mut arguments = std::env::args().skip(1);
    let mode = arguments
        .next()
        .ok_or_else(|| anyhow!("expected daemon or mcp mode"))?;
    if arguments.next().as_deref() != Some("--endpoint") {
        return Err(anyhow!("expected --endpoint"));
    }
    let endpoint = arguments
        .next()
        .ok_or_else(|| anyhow!("expected a bridge endpoint"))?;
    if arguments.next().is_some() {
        return Err(anyhow!("unexpected bridge arguments"));
    }
    match mode.as_str() {
        "daemon" => daemon::run(endpoint).await,
        "mcp" => mcp_server::run(endpoint).await,
        _ => Err(anyhow!("expected daemon or mcp mode")),
    }
}
