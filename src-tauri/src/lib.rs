mod publish;
mod server;
mod store;

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use store::{Comment, DbState, Project, Store};
use tauri::{Emitter, Manager};

#[derive(Clone, Serialize, Deserialize)]
pub struct Selection {
    pub project_id: String,
    pub version_id: Option<String>,
    pub selector: String,
    pub tag: String,
    pub text: String,
    pub ts: u64,
}

struct AppState(Arc<Mutex<Store>>, Arc<Mutex<Option<Selection>>>);

#[tauri::command]
fn get_projects(state: tauri::State<AppState>) -> Vec<Project> {
    state.0.lock().unwrap().projects()
}

#[tauri::command]
fn create_project(
    name: String,
    state: tauri::State<AppState>,
    app: tauri::AppHandle,
) -> Project {
    let (project, projects) = {
        let s = state.0.lock().unwrap();
        let p = s.create_project(&name);
        (p, s.projects())
    };
    let _ = app.emit("lucius://projects", serde_json::json!({ "projects": projects }));
    project
}

#[tauri::command]
fn get_state(project: String, state: tauri::State<AppState>) -> DbState {
    state.0.lock().unwrap().state(&project)
}

#[tauri::command]
fn get_version_html(
    project: String,
    id: String,
    state: tauri::State<AppState>,
) -> Option<String> {
    state.0.lock().unwrap().version_html(&project, &id)
}

#[tauri::command]
fn add_comment(
    project: String,
    text: String,
    author: Option<String>,
    version_id: Option<String>,
    anchor: Option<String>,
    state: tauri::State<AppState>,
    app: tauri::AppHandle,
) -> Comment {
    let (comment, snapshot) = {
        let s = state.0.lock().unwrap();
        let c = s.add_comment(&project, &text, author, version_id, anchor);
        (c, s.state(&project))
    };
    let _ = app.emit(
        "lucius://update",
        serde_json::json!({ "projectId": project, "state": snapshot }),
    );
    comment
}

#[tauri::command]
fn set_selection(
    project: String,
    version_id: Option<String>,
    selector: String,
    tag: String,
    text: String,
    state: tauri::State<AppState>,
) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    *state.1.lock().unwrap() = Some(Selection {
        project_id: project,
        version_id,
        selector,
        tag,
        text,
        ts,
    });
}

#[tauri::command]
fn clear_selection(state: tauri::State<AppState>) {
    *state.1.lock().unwrap() = None;
}

#[tauri::command]
fn publish_config() -> Option<serde_json::Value> {
    publish::config().map(|c| serde_json::json!({ "host": c.host }))
}

#[tauri::command]
fn publish_status(project: String, state: tauri::State<AppState>) -> Option<serde_json::Value> {
    state
        .0
        .lock()
        .unwrap()
        .publish_of(&project)
        .map(|(slug, url, last)| serde_json::json!({ "slug": slug, "url": url, "lastVersion": last }))
}

#[tauri::command]
async fn publish_project(
    project: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let store = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || publish::publish_project(&store, &project))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_acl(project: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || publish::get_acl(&project))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn set_acl(
    project: String,
    visibility: String,
    members: Vec<String>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || publish::set_acl(&project, &visibility, members))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn server_info(app: tauri::AppHandle) -> Option<serde_json::Value> {
    let dir = app.path().app_data_dir().ok()?;
    let raw = std::fs::read_to_string(dir.join("server.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir).ok();
            let store = Arc::new(Mutex::new(Store::new(dir.clone())));
            let selection: Arc<Mutex<Option<Selection>>> = Arc::new(Mutex::new(None));
            app.manage(AppState(store.clone(), selection.clone()));
            server::start(app.handle().clone(), store.clone(), selection, dir);
            publish::start_comment_poller(app.handle().clone(), store);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_projects,
            create_project,
            get_state,
            get_version_html,
            add_comment,
            set_selection,
            clear_selection,
            publish_config,
            publish_status,
            publish_project,
            get_acl,
            set_acl,
            server_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
