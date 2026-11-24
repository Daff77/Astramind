use crate::domain::ids::OperationId;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Stable error codes defined in SYSTEM_ARCHITECTURE.md §4.2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidInput,
    VaultUnavailable,
    AccessDenied,
    NoteNotFound,
    AmbiguousLink,
    Conflict,
    Busy,
    DiskFull,
    IoFailed,
    ParseWarning,
    IndexStale,
    StateUnavailable,
    RecoveryRequired,
    ProviderUnavailable,
    ConsentRequired,
    Cancelled,
    LimitExceeded,
}

/// Wire-safe error payload returned across IPC and MCP boundaries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorEnvelope {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    pub operation_id: Option<OperationId>,
    pub safe_details: Option<serde_json::Value>,
}

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("{0}")]
    InvalidInput(String),
    #[error("{0}")]
    VaultUnavailable(String),
    #[error("{0}")]
    AccessDenied(String),
    #[error("{0}")]
    NoteNotFound(String),
    #[error("{0}")]
    AmbiguousLink(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Busy(String),
    #[error("{0}")]
    DiskFull(String),
    #[error("{0}")]
    IoFailed(String),
    #[error("{0}")]
    StateUnavailable(String),
    #[error("{0}")]
    RecoveryRequired(String),
    #[error("{0}")]
    LimitExceeded(String),
}

impl CoreError {
    #[must_use]
    pub fn code(&self) -> ErrorCode {
        match self {
            Self::InvalidInput(_) => ErrorCode::InvalidInput,
            Self::VaultUnavailable(_) => ErrorCode::VaultUnavailable,
            Self::AccessDenied(_) => ErrorCode::AccessDenied,
            Self::NoteNotFound(_) => ErrorCode::NoteNotFound,
            Self::AmbiguousLink(_) => ErrorCode::AmbiguousLink,
            Self::Conflict(_) => ErrorCode::Conflict,
            Self::Busy(_) => ErrorCode::Busy,
            Self::DiskFull(_) => ErrorCode::DiskFull,
            Self::IoFailed(_) => ErrorCode::IoFailed,
            Self::StateUnavailable(_) => ErrorCode::StateUnavailable,
            Self::RecoveryRequired(_) => ErrorCode::RecoveryRequired,
            Self::LimitExceeded(_) => ErrorCode::LimitExceeded,
        }
    }

    #[must_use]
    pub fn into_envelope(&self, operation_id: Option<OperationId>) -> ErrorEnvelope {
        let code = self.code();
        let retryable = matches!(
            code,
            ErrorCode::Busy | ErrorCode::IndexStale | ErrorCode::ProviderUnavailable
        );
        ErrorEnvelope {
            code,
            message: self.to_string(),
            retryable,
            operation_id,
            safe_details: None,
        }
    }

    #[must_use]
    pub fn from_io(context: &str, err: &std::io::Error) -> Self {
        match err.kind() {
            std::io::ErrorKind::NotFound => Self::NoteNotFound(format!("{context}: not found")),
            _ => Self::from_io_common(context, err),
        }
    }

    #[must_use]
    pub fn from_io_dir(context: &str, err: &std::io::Error) -> Self {
        match err.kind() {
            std::io::ErrorKind::NotFound => {
                Self::IoFailed(format!("{context}: parent directory not found"))
            }
            _ => Self::from_io_common(context, err),
        }
    }

    #[must_use]
    pub fn from_io_vault(context: &str, err: &std::io::Error) -> Self {
        match err.kind() {
            std::io::ErrorKind::NotFound => {
                Self::VaultUnavailable(format!("{context}: vault root not found"))
            }
            _ => Self::from_io_common(context, err),
        }
    }

    fn from_io_common(context: &str, err: &std::io::Error) -> Self {
        match err.kind() {
            std::io::ErrorKind::PermissionDenied => {
                Self::AccessDenied(format!("{context}: access denied"))
            }
            _ if err.raw_os_error() == Some(112) || err.raw_os_error() == Some(39) => {
                Self::DiskFull(format!("{context}: insufficient disk space"))
            }
            _ => Self::IoFailed(format!("{context}: I/O operation failed")),
        }
    }
}
