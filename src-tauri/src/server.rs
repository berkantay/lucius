use crate::store::{Store, DEFAULT_PROJECT};
use crate::Selection;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tiny_http::{Header, Method, Response, Server};

pub fn start(
    app: AppHandle,
    store: Arc<Mutex<Store>>,
    selection: Arc<Mutex<Option<Selection>>>,
    data_dir: PathBuf,
) {
    // Fixed port first so MCP clients can use a stable URL; fall back to ephemeral.
    let server = Server::http("127.0.0.1:7317")
        .or_else(|_| Server::http("127.0.0.1:0"))
        .expect("failed to bind lucius control server");
    let port = server
        .server_addr()
        .to_ip()
        .expect("tcp listener has an ip address")
        .port();
    let token = uuid::Uuid::new_v4().simple().to_string();

    let info = json!({
        "app": "lucius",
        "port": port,
        "token": token,
        "pid": std::process::id(),
    });
    std::fs::write(
        data_dir.join("server.json"),
        serde_json::to_string_pretty(&info).unwrap(),
    )
    .expect("failed to write server.json");

    std::thread::spawn(move || {
        for mut request in server.incoming_requests() {
            let (status, body) = handle(&app, &store, &selection, &token, &mut request);
            let response = Response::from_string(body)
                .with_status_code(status)
                .with_header(
                    Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
                );
            let _ = request.respond(response);
        }
    });
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| v.to_string())
    })
}

fn handle(
    app: &AppHandle,
    store: &Arc<Mutex<Store>>,
    selection: &Arc<Mutex<Option<Selection>>>,
    token: &str,
    request: &mut tiny_http::Request,
) -> (u16, String) {
    let method = request.method().clone();
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or("").to_string();

    if path == "/api/ping" {
        return (200, json!({ "ok": true, "app": "lucius" }).to_string());
    }

    // MCP endpoint: Streamable HTTP, loopback-only by construction, no bearer
    // (MCP client configs are static; the REST token rotates per launch).
    if path == "/mcp" {
        if method != Method::Post {
            return (405, json!({ "error": "POST only" }).to_string());
        }
        let mut body = String::new();
        let _ = std::io::Read::read_to_string(request.as_reader(), &mut body);
        let msg: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        return handle_mcp(app, store, selection, &msg);
    }

    let authed = request.headers().iter().any(|h| {
        h.field.as_str().as_str().eq_ignore_ascii_case("authorization")
            && h.value.as_str() == format!("Bearer {token}")
    });
    if !authed {
        return (401, json!({ "error": "missing or bad token" }).to_string());
    }

    let mut body = String::new();
    let _ = std::io::Read::read_to_string(request.as_reader(), &mut body);
    let payload: Value = serde_json::from_str(&body).unwrap_or(Value::Null);

    let project = payload["project_id"]
        .as_str()
        .map(String::from)
        .or_else(|| query_param(&url, "project"))
        .unwrap_or_else(|| DEFAULT_PROJECT.to_string());

    match (method, path.as_str()) {
        (Method::Get, "/api/projects") => {
            let projects = store.lock().unwrap().projects();
            (200, serde_json::to_string(&projects).unwrap())
        }
        (Method::Post, "/api/projects") => {
            let Some(name) = payload["name"].as_str() else {
                return (400, json!({ "error": "body must be {name}" }).to_string());
            };
            let p = store.lock().unwrap().create_project(name);
            let projects = store.lock().unwrap().projects();
            let _ = app.emit("lucius://projects", json!({ "projects": projects }));
            (200, serde_json::to_string(&p).unwrap())
        }
        (Method::Get, "/api/state") => {
            let state = store.lock().unwrap().state(&project);
            (200, serde_json::to_string(&state).unwrap())
        }
        (Method::Get, "/api/selection") => {
            let sel = selection.lock().unwrap().clone();
            (200, serde_json::to_string(&sel).unwrap())
        }
        (Method::Post, "/api/render") => {
            let Some(html) = payload["html"].as_str() else {
                return (
                    400,
                    json!({ "error": "body must be {html, label?, project_id?}" }).to_string(),
                );
            };
            let label = payload["label"].as_str().map(String::from);
            let (version, state, projects) = {
                let s = store.lock().unwrap();
                let v = s.add_version(&project, html, label);
                (v, s.state(&project), s.projects())
            };
            let _ = app.emit("lucius://projects", json!({ "projects": projects }));
            let _ = app.emit(
                "lucius://update",
                json!({ "projectId": project, "state": state, "focusId": version.id }),
            );
            (200, serde_json::to_string(&version).unwrap())
        }
        (Method::Post, "/api/comment") => {
            let Some(text) = payload["text"].as_str() else {
                return (
                    400,
                    json!({ "error": "body must be {text, author?, version_id?, anchor?, project_id?}" })
                        .to_string(),
                );
            };
            let author = payload["author"].as_str().map(String::from);
            let version_id = payload["version_id"].as_str().map(String::from);
            let anchor = payload["anchor"].as_str().map(String::from);
            let (comment, state) = {
                let s = store.lock().unwrap();
                let c = s.add_comment(&project, text, author, version_id, anchor);
                (c, s.state(&project))
            };
            let _ = app.emit(
                "lucius://update",
                json!({ "projectId": project, "state": state }),
            );
            (200, serde_json::to_string(&comment).unwrap())
        }
        (Method::Post, "/api/publish") => match crate::publish::publish_project(store, &project) {
            Ok(url) => (200, json!({ "ok": true, "url": url }).to_string()),
            Err(e) => (500, json!({ "ok": false, "error": e }).to_string()),
        },
        (Method::Post, "/api/focus") => {
            let Some(id) = payload["version_id"].as_str() else {
                return (400, json!({ "error": "body must be {version_id, project_id?}" }).to_string());
            };
            let state = store.lock().unwrap().state(&project);
            let _ = app.emit(
                "lucius://update",
                json!({ "projectId": project, "state": state, "focusId": id }),
            );
            (200, json!({ "ok": true }).to_string())
        }
        (Method::Get, p) if p.starts_with("/api/version/") => {
            let id = p.trim_start_matches("/api/version/");
            match store.lock().unwrap().version_html(&project, id) {
                Some(html) => (200, json!({ "id": id, "html": html }).to_string()),
                None => (404, json!({ "error": "no such version" }).to_string()),
            }
        }
        _ => (404, json!({ "error": "no such route" }).to_string()),
    }
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol) — minimal Streamable HTTP server.
// Handles: initialize, notifications/*, ping, tools/list, tools/call.
// ---------------------------------------------------------------------------

fn jsonrpc_result(id: &Value, result: Value) -> (u16, String) {
    (200, json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string())
}

fn jsonrpc_error(id: &Value, code: i64, message: &str) -> (u16, String) {
    (
        200,
        json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
            .to_string(),
    )
}

fn tool_text(id: &Value, text: String, is_error: bool) -> (u16, String) {
    jsonrpc_result(
        id,
        json!({ "content": [{ "type": "text", "text": text }], "isError": is_error }),
    )
}

fn mcp_tools() -> Value {
    let str_prop = |desc: &str| json!({ "type": "string", "description": desc });
    json!([
        {
            "name": "get_selection",
            "description": "Get the element the user currently has selected on the lucius canvas (project, version, CSS selector, tag, text snippet). Null if nothing is selected. Poll this when the user says 'this', 'here', 'what I selected'.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "list_projects",
            "description": "List lucius projects (tabs).",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "get_state",
            "description": "Versions + comments of a lucius project.",
            "inputSchema": { "type": "object", "properties": { "project": str_prop("project id, default 'default'") } }
        },
        {
            "name": "render",
            "description": "Push a new self-contained HTML artifact iteration to the lucius canvas. Creates an immutable version and shows it live.",
            "inputSchema": { "type": "object", "required": ["html"], "properties": {
                "html": str_prop("complete self-contained HTML document"),
                "label": str_prop("short human label for the version"),
                "project": str_prop("project id, default 'default'") } }
        },
        {
            "name": "add_comment",
            "description": "Record a note/comment, optionally anchored to a version and a CSS selector (e.g. the user's current selection).",
            "inputSchema": { "type": "object", "required": ["text"], "properties": {
                "text": str_prop("the note"),
                "version_id": str_prop("version to anchor to, e.g. 'v3'"),
                "anchor": str_prop("CSS selector of the element the note is about"),
                "project": str_prop("project id, default 'default'") } }
        },
        {
            "name": "focus",
            "description": "Make the lucius app show a specific version (switches tab if needed).",
            "inputSchema": { "type": "object", "required": ["version_id"], "properties": {
                "version_id": str_prop("version id, e.g. 'v2'"),
                "project": str_prop("project id, default 'default'") } }
        },
        {
            "name": "get_version_html",
            "description": "Read back the full HTML of a version.",
            "inputSchema": { "type": "object", "required": ["version_id"], "properties": {
                "version_id": str_prop("version id"),
                "project": str_prop("project id, default 'default'") } }
        }
    ])
}

fn handle_mcp(
    app: &AppHandle,
    store: &Arc<Mutex<Store>>,
    selection: &Arc<Mutex<Option<Selection>>>,
    msg: &Value,
) -> (u16, String) {
    let method = msg["method"].as_str().unwrap_or("");
    let id = &msg["id"];

    // Notifications (no id) get 202 Accepted with no body.
    if id.is_null() {
        return (202, String::new());
    }

    match method {
        "initialize" => jsonrpc_result(
            id,
            json!({
                "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-03-26"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "lucius", "version": "0.1.0" }
            }),
        ),
        "ping" => jsonrpc_result(id, json!({})),
        "tools/list" => jsonrpc_result(id, json!({ "tools": mcp_tools() })),
        "tools/call" => {
            let name = msg["params"]["name"].as_str().unwrap_or("");
            let args = &msg["params"]["arguments"];
            let project = args["project"].as_str().unwrap_or(DEFAULT_PROJECT).to_string();
            match name {
                "get_selection" => {
                    let sel = selection.lock().unwrap().clone();
                    tool_text(id, serde_json::to_string_pretty(&sel).unwrap(), false)
                }
                "list_projects" => {
                    let p = store.lock().unwrap().projects();
                    tool_text(id, serde_json::to_string_pretty(&p).unwrap(), false)
                }
                "get_state" => {
                    let s = store.lock().unwrap().state(&project);
                    tool_text(id, serde_json::to_string_pretty(&s).unwrap(), false)
                }
                "render" => {
                    let Some(html) = args["html"].as_str() else {
                        return tool_text(id, "missing required arg: html".into(), true);
                    };
                    let label = args["label"].as_str().map(String::from);
                    let (version, state, projects) = {
                        let s = store.lock().unwrap();
                        let v = s.add_version(&project, html, label);
                        (v, s.state(&project), s.projects())
                    };
                    let _ = app.emit("lucius://projects", json!({ "projects": projects }));
                    let _ = app.emit(
                        "lucius://update",
                        json!({ "projectId": project, "state": state, "focusId": version.id }),
                    );
                    tool_text(id, serde_json::to_string(&version).unwrap(), false)
                }
                "add_comment" => {
                    let Some(text) = args["text"].as_str() else {
                        return tool_text(id, "missing required arg: text".into(), true);
                    };
                    let version_id = args["version_id"].as_str().map(String::from);
                    let anchor = args["anchor"].as_str().map(String::from);
                    let (c, state) = {
                        let s = store.lock().unwrap();
                        let c = s.add_comment(&project, text, Some("claude".into()), version_id, anchor);
                        (c, s.state(&project))
                    };
                    let _ = app.emit(
                        "lucius://update",
                        json!({ "projectId": project, "state": state }),
                    );
                    tool_text(id, serde_json::to_string(&c).unwrap(), false)
                }
                "focus" => {
                    let Some(v) = args["version_id"].as_str() else {
                        return tool_text(id, "missing required arg: version_id".into(), true);
                    };
                    let state = store.lock().unwrap().state(&project);
                    let _ = app.emit(
                        "lucius://update",
                        json!({ "projectId": project, "state": state, "focusId": v }),
                    );
                    tool_text(id, json!({ "ok": true }).to_string(), false)
                }
                "get_version_html" => {
                    let Some(v) = args["version_id"].as_str() else {
                        return tool_text(id, "missing required arg: version_id".into(), true);
                    };
                    match store.lock().unwrap().version_html(&project, v) {
                        Some(html) => tool_text(id, html, false),
                        None => tool_text(id, format!("no such version: {v}"), true),
                    }
                }
                other => tool_text(id, format!("unknown tool: {other}"), true),
            }
        }
        other => jsonrpc_error(id, -32601, &format!("method not found: {other}")),
    }
}
