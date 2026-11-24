export type ErrorCode =
  | "INVALID_INPUT"
  | "VAULT_UNAVAILABLE"
  | "ACCESS_DENIED"
  | "NOTE_NOT_FOUND"
  | "AMBIGUOUS_LINK"
  | "CONFLICT"
  | "BUSY"
  | "DISK_FULL"
  | "IO_FAILED"
  | "PARSE_WARNING"
  | "INDEX_STALE"
  | "STATE_UNAVAILABLE"
  | "RECOVERY_REQUIRED"
  | "PROVIDER_UNAVAILABLE"
  | "CONSENT_REQUIRED"
  | "CANCELLED"
  | "LIMIT_EXCEEDED";

export interface ErrorEnvelope {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  operation_id: string | null;
  safe_details: unknown;
}

export type VerificationStatus =
  | "unverified"
  | "user_verified"
  | "outdated"
  | "superseded";

export type NoteOrigin = "imported" | "user_created" | "ai_proposal";

export interface AppPathsDto {
  app_data_dir: string;
  registry_db: string;
  vaults_dir: string;
}

export interface SqliteHealthDto {
  sqlite_version: string;
  fts5_enabled: boolean;
  fts5_probe_hits: number;
}

export interface AppHealthDto {
  app_name: string;
  core_version: string;
  platform: string;
  paths: AppPathsDto;
  sqlite: SqliteHealthDto;
}
