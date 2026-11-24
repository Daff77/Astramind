$ErrorActionPreference = 'Stop'

# Ensure Cargo bin is on PATH in fresh PowerShell sessions
if (Test-Path "$env:USERPROFILE\.cargo\bin") {
    $env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
}

function Invoke-Checked {
    param(
        [string]$Label,
        [scriptblock]$Command
    )
    Write-Host "==> $Label"
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

Invoke-Checked "Frontend lint (ESLint)" { npm run lint }
Invoke-Checked "Frontend typecheck (tsc --noEmit)" { npm run typecheck }
Invoke-Checked "Frontend unit & component tests (Vitest)" { npm run test }
Invoke-Checked "Rust formatting check (cargo fmt)" { cargo fmt --all -- --check }
Invoke-Checked "Rust linter (cargo clippy -D warnings)" { cargo clippy --workspace --all-targets -- -D warnings }
Invoke-Checked "Rust workspace & Windows integration tests (cargo test --locked)" { cargo test --workspace --locked }

Write-Host "ALL_QUALITY_GATES_PASSED"
