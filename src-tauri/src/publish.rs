use crate::store::Store;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// Publishing uses the user's own lucius Cloudflare deployment, provisioned
/// once by `lucius setup`: ~/.lucius/published.json holds the worker host +
/// upload token; the worker stores HTML in R2, serves it with the comment
/// overlay (GitHub-auth comments), and exposes comments at /api/comments.
pub struct PublishConfig {
    pub base: String,
    pub host: String,
    pub token: String,
}

pub fn config() -> Option<PublishConfig> {
    let home = std::env::var("HOME").ok()?;
    let raw = std::fs::read_to_string(format!("{home}/.lucius/published.json")).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let worker = v["worker"].as_str()?;
    let subdomain = v["subdomain"].as_str()?;
    let token = v["upload_token"].as_str()?.to_string();
    let workers_host = format!("{worker}.{subdomain}.workers.dev");
    let custom = v["custom_domain"].as_str().unwrap_or("");
    let public_host = v["public_host"].as_str().unwrap_or(&workers_host);
    let host = if !custom.is_empty() { custom } else { public_host };
    Some(PublishConfig {
        // uploads always target the workers.dev host (custom domains may lag)
        base: format!("https://{workers_host}"),
        host: host.to_string(),
        token,
    })
}

fn iso(ts: u64) -> String {
    // worker only displays this; second precision unix is acceptable input
    let secs = ts / 1000;
    format!("@{secs}")
}

pub fn slug_for(project: &str) -> String {
    // the domain is already lucius-branded, so the project id IS the slug
    project.to_string()
}

/// Upload every version of the project (latest last, like tdoc-publish, so
/// the meta ends up pointing at the newest). Returns the public URL.
pub fn publish_project(store: &Arc<Mutex<Store>>, project: &str) -> Result<String, String> {
    let cfg = config().ok_or(
        "Cloudflare publishing is not set up — no ~/.tdoc/published.json. Run /tdoc onboard once (it provisions your own Worker + R2 bucket), then publish again.",
    )?;
    let slug = slug_for(project);
    let versions = store.lock().unwrap().versions_full(project);
    if versions.is_empty() {
        return Err("nothing to publish — this project has no versions".into());
    }
    let latest = versions.last().unwrap().0;

    let meta = json!({
        "title": format!("{project} — lucius"),
        "slug": slug,
        "created": iso(versions[0].3),
        "versions": versions.iter().map(|(n, label, _, ts)| json!({
            "n": n, "created": iso(*ts), "prompt": label
        })).collect::<Vec<_>>(),
    });

    for (n, _label, html, _ts) in &versions {
        let payload = json!({ "slug": slug, "version": n, "html": html, "meta": meta });
        let resp = ureq::post(&format!("{}/api/upload", cfg.base))
            .set("Authorization", &format!("Bearer {}", cfg.token))
            .set("Content-Type", "application/json")
            .timeout(std::time::Duration::from_secs(120))
            .send_string(&payload.to_string());
        match resp {
            Ok(r) => {
                let body: Value = r.into_json().map_err(|e| e.to_string())?;
                if body["ok"].as_bool() != Some(true) {
                    // only the latest version is a hard failure, like tdoc
                    if *n == latest {
                        return Err(format!("upload of v{n} failed: {body}"));
                    }
                }
            }
            Err(e) => {
                if *n == latest {
                    return Err(format!("upload of v{n} failed: {e}"));
                }
            }
        }
    }

    let url = format!("https://{}/d/{}/v/{}", cfg.host, slug, latest);
    store
        .lock()
        .unwrap()
        .record_publish(project, &slug, &url, latest);
    Ok(url)
}

pub fn get_members() -> Result<Value, String> {
    let cfg = config().ok_or("publishing not set up — run `lucius setup`")?;
    ureq::get(&format!("{}/api/members", cfg.base))
        .set("Authorization", &format!("Bearer {}", cfg.token))
        .timeout(std::time::Duration::from_secs(20))
        .call()
        .map_err(|e| e.to_string())?
        .into_json()
        .map_err(|e| e.to_string())
}

pub fn set_members(members: Vec<String>) -> Result<Value, String> {
    let cfg = config().ok_or("publishing not set up — run `lucius setup`")?;
    ureq::post(&format!("{}/api/members", cfg.base))
        .set("Authorization", &format!("Bearer {}", cfg.token))
        .set("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(20))
        .send_string(&json!({ "members": members }).to_string())
        .map_err(|e| e.to_string())?
        .into_json()
        .map_err(|e| e.to_string())
}

pub fn get_acl(slug: &str) -> Result<Value, String> {
    let cfg = config().ok_or("publishing not set up — run `lucius setup`")?;
    ureq::get(&format!("{}/api/acl?slug={slug}", cfg.base))
        .set("Authorization", &format!("Bearer {}", cfg.token))
        .timeout(std::time::Duration::from_secs(20))
        .call()
        .map_err(|e| e.to_string())?
        .into_json()
        .map_err(|e| e.to_string())
}

pub fn set_acl(slug: &str, visibility: &str, members: Vec<String>) -> Result<Value, String> {
    let cfg = config().ok_or("publishing not set up — run `lucius setup`")?;
    ureq::post(&format!("{}/api/acl", cfg.base))
        .set("Authorization", &format!("Bearer {}", cfg.token))
        .set("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(20))
        .send_string(
            &json!({ "slug": slug, "visibility": visibility, "members": members }).to_string(),
        )
        .map_err(|e| e.to_string())?
        .into_json()
        .map_err(|e| e.to_string())
}

/// Background poller: every 60s pull comments for every published project
/// from the worker and merge new ones into the local store. New comments emit
/// a lucius://update (state refresh) and a lucius://remote-comments ping so
/// the UI can notify.
pub fn start_comment_poller(app: AppHandle, store: Arc<Mutex<Store>>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
        let Some(cfg) = config() else { continue };
        let published = store.lock().unwrap().publishes();
        for (project, slug, _url) in published {
            let resp = ureq::get(&format!(
                "{}/api/comments?slug={}&version=all",
                cfg.base, slug
            ))
            .timeout(std::time::Duration::from_secs(30))
            .call();
            let Ok(r) = resp else { continue };
            let Ok(list) = r.into_json::<Value>() else { continue };
            let Some(items) = list.as_array() else { continue };
            let mut new_count = 0u32;
            for c in items {
                let Some(id) = c["id"].as_str() else { continue };
                let text = c["text"].as_str().unwrap_or("");
                if text.is_empty() {
                    continue;
                }
                let author = c["author"]["login"]
                    .as_str()
                    .unwrap_or("viewer")
                    .to_string();
                let version_id = c["version"].as_i64().map(|n| format!("v{n}"));
                let anchor = if c["anchor"].is_null() {
                    None
                } else {
                    Some(c["anchor"].to_string())
                };
                let ts = c["created"]
                    .as_str()
                    .and_then(|_| None)
                    .unwrap_or_else(|| {
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0)
                    });
                let inserted = store.lock().unwrap().insert_remote_comment(
                    id,
                    &project,
                    version_id,
                    &format!("{author} (web)"),
                    text,
                    anchor,
                    ts,
                );
                if inserted {
                    new_count += 1;
                }
            }
            if new_count > 0 {
                let state = store.lock().unwrap().state(&project);
                let _ = app.emit(
                    "lucius://update",
                    json!({ "projectId": project, "state": state }),
                );
                let _ = app.emit(
                    "lucius://remote-comments",
                    json!({ "projectId": project, "count": new_count }),
                );
            }
        }
    });
}
