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

Invoke-Checked "Frontend lint" { npm run lint }
Invoke-Checked "Frontend typecheck" { npm run typecheck }
Invoke-Checked "Frontend tests" { npm run test }
Invoke-Checked "Rust fmt check" { cargo fmt --all -- --check }
Invoke-Checked "Rust clippy" { cargo clippy --workspace --all-targets -- -D warnings }
Invoke-Checked "Rust workspace tests" { cargo test --workspace --locked }

Write-Host "ALL_PHASE_2_CHECKS_PASSED"
