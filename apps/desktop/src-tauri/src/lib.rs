use brain_core::domain::errors::ErrorEnvelope;
use brain_core::domain::types::AppHealthDto;
use brain_core::health_check;

#[tauri::command]
fn app_health() -> Result<AppHealthDto, ErrorEnvelope> {
    health_check().map_err(|err| err.into_envelope(None))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_health])
        .run(tauri::generate_context!())
        .expect("error while running Personal Brain desktop application");
}
