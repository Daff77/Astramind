use brain_core::domain::errors::ErrorCode;
use brain_core::vault::lock::VaultLock;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;
use uuid::Uuid;

#[test]
fn two_process_lock_contention_and_crash_recovery() {
    // Child branch executed when spawned by parent test process.
    if let Ok(lock_path_str) = std::env::var("PB_LOCK_CHILD_PATH") {
        let lock_path = PathBuf::from(lock_path_str);
        let _guard = VaultLock::acquire(&lock_path, Duration::from_secs(2))
            .expect("child process should acquire lock");
        println!("PB_CHILD_LOCKED");
        std::thread::sleep(Duration::from_secs(30));
        return;
    }

    let temp_dir = std::env::temp_dir().join(format!("pb-lock-test-{}", Uuid::new_v4()));
    let lock_path = temp_dir.join("vault.lock");
    std::fs::create_dir_all(&temp_dir).expect("create temp lock dir");

    let exe = std::env::current_exe().expect("current test exe");
    let mut child = Command::new(exe)
        .arg("--exact")
        .arg("two_process_lock_contention_and_crash_recovery")
        .arg("--nocapture")
        .env("PB_LOCK_CHILD_PATH", &lock_path)
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn child lock holder");

    let stdout = child.stdout.take().expect("child stdout");
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let mut locked = false;
    for _ in 0..50 {
        line.clear();
        if reader.read_line(&mut line).unwrap_or(0) > 0 && line.contains("PB_CHILD_LOCKED") {
            locked = true;
            break;
        }
    }
    assert!(locked, "child process did not confirm lock acquisition");

    // Parent must receive BUSY while child holds exclusive LockFileEx.
    let err = VaultLock::acquire(&lock_path, Duration::from_millis(120))
        .expect_err("parent must fail with Busy while child holds lock");
    assert_eq!(err.code(), ErrorCode::Busy);

    // Simulate abrupt termination of the holder process.
    child.kill().expect("kill child lock holder");
    let _ = child.wait();

    // OS automatically releases LockFileEx on process exit; parent can immediately re-acquire.
    let guard = VaultLock::acquire(&lock_path, Duration::from_secs(2))
        .expect("parent should acquire lock after holder terminates");
    drop(guard);

    let _ = std::fs::remove_dir_all(&temp_dir);
}
