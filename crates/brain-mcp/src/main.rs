use brain_core::health_check;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("--version") => {
            println!("brain-mcp {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Some("--check") => match health_check() {
            Ok(health) => match serde_json::to_string_pretty(&health) {
                Ok(json) => {
                    println!("{json}");
                    ExitCode::SUCCESS
                }
                Err(err) => {
                    eprintln!("brain-mcp: failed to serialize health check: {err}");
                    ExitCode::FAILURE
                }
            },
            Err(err) => {
                eprintln!("brain-mcp: health check failed ({:?}): {err}", err.code());
                ExitCode::FAILURE
            }
        },
        _ => {
            eprintln!("brain-mcp: stdio MCP tools arrive in Phase 6 (PB-022); run with --check or --version");
            ExitCode::SUCCESS
        }
    }
}
