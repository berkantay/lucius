use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub ts: u64,
}

#[derive(Clone, Serialize)]
pub struct Version {
    pub id: String,
    pub label: String,
    pub ts: u64,
}

#[derive(Clone, Serialize)]
pub struct Comment {
    pub id: String,
    pub version_id: Option<String>,
    pub author: String,
    pub text: String,
    pub anchor: Option<String>,
    pub ts: u64,
}

#[derive(Clone, Serialize, Default)]
pub struct DbState {
    pub versions: Vec<Version>,
    pub comments: Vec<Comment>,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
  project_id TEXT NOT NULL REFERENCES projects(id),
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  label TEXT NOT NULL,
  html TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  version_id TEXT,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  anchor TEXT,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS publishes (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  slug TEXT NOT NULL,
  url TEXT NOT NULL,
  last_version INTEGER NOT NULL,
  ts INTEGER NOT NULL
);
";

pub const DEFAULT_PROJECT: &str = "default";

pub struct Store {
    conn: Connection,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        let conn = Connection::open(dir.join("lucius.db")).expect("failed to open lucius.db");
        conn.execute_batch(SCHEMA).expect("failed to create schema");
        let store = Store { conn };
        store.ensure_project(DEFAULT_PROJECT, DEFAULT_PROJECT);
        store.migrate_json(&dir);
        store
    }

    fn now() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn ensure_project(&self, id: &str, name: &str) {
        self.conn
            .execute(
                "INSERT OR IGNORE INTO projects (id, name, ts) VALUES (?1, ?2, ?3)",
                params![id, name, Self::now()],
            )
            .expect("failed to ensure project");
    }

    pub fn projects(&self) -> Vec<Project> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, name, ts FROM projects ORDER BY ts")
            .unwrap();
        stmt.query_map([], |r| {
            Ok(Project {
                id: r.get(0)?,
                name: r.get(1)?,
                ts: r.get(2)?,
            })
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
    }

    pub fn project_exists(&self, id: &str) -> bool {
        self.conn
            .query_row("SELECT 1 FROM projects WHERE id = ?1", params![id], |_| {
                Ok(())
            })
            .optional()
            .unwrap_or(None)
            .is_some()
    }

    pub fn create_project(&self, name: &str) -> Project {
        let base: String = name
            .to_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect::<String>()
            .split('-')
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        let base = if base.is_empty() { "project".into() } else { base };
        let mut id = base.clone();
        let mut n = 2;
        while self.project_exists(&id) {
            id = format!("{base}-{n}");
            n += 1;
        }
        let p = Project {
            id: id.clone(),
            name: name.to_string(),
            ts: Self::now(),
        };
        self.conn
            .execute(
                "INSERT INTO projects (id, name, ts) VALUES (?1, ?2, ?3)",
                params![p.id, p.name, p.ts],
            )
            .expect("failed to create project");
        p
    }

    pub fn state(&self, project: &str) -> DbState {
        let mut vstmt = self
            .conn
            .prepare("SELECT id, label, ts FROM versions WHERE project_id = ?1 ORDER BY seq")
            .unwrap();
        let versions = vstmt
            .query_map(params![project], |r| {
                Ok(Version {
                    id: r.get(0)?,
                    label: r.get(1)?,
                    ts: r.get(2)?,
                })
            })
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        let mut cstmt = self
            .conn
            .prepare(
                "SELECT id, version_id, author, text, anchor, ts FROM comments WHERE project_id = ?1 ORDER BY ts",
            )
            .unwrap();
        let comments = cstmt
            .query_map(params![project], |r| {
                Ok(Comment {
                    id: r.get(0)?,
                    version_id: r.get(1)?,
                    author: r.get(2)?,
                    text: r.get(3)?,
                    anchor: r.get(4)?,
                    ts: r.get(5)?,
                })
            })
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        DbState { versions, comments }
    }

    pub fn add_version(&self, project: &str, html: &str, label: Option<String>) -> Version {
        self.ensure_project(project, project);
        let seq: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM versions WHERE project_id = ?1",
                params![project],
                |r| r.get(0),
            )
            .unwrap();
        let v = Version {
            id: format!("v{seq}"),
            label: label.unwrap_or_else(|| format!("iteration {seq}")),
            ts: Self::now(),
        };
        self.conn
            .execute(
                "INSERT INTO versions (project_id, id, seq, label, html, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![project, v.id, seq, v.label, html, v.ts],
            )
            .expect("failed to insert version");
        v
    }

    pub fn version_html(&self, project: &str, id: &str) -> Option<String> {
        self.conn
            .query_row(
                "SELECT html FROM versions WHERE project_id = ?1 AND id = ?2",
                params![project, id],
                |r| r.get(0),
            )
            .optional()
            .unwrap_or(None)
    }

    pub fn add_comment(
        &self,
        project: &str,
        text: &str,
        author: Option<String>,
        version_id: Option<String>,
        anchor: Option<String>,
    ) -> Comment {
        self.ensure_project(project, project);
        let c = Comment {
            id: uuid::Uuid::new_v4().to_string(),
            version_id,
            author: author.unwrap_or_else(|| "claude".into()),
            text: text.into(),
            anchor,
            ts: Self::now(),
        };
        self.conn
            .execute(
                "INSERT INTO comments (id, project_id, version_id, author, text, anchor, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![c.id, project, c.version_id, c.author, c.text, c.anchor, c.ts],
            )
            .expect("failed to insert comment");
        c
    }

    /// All versions of a project including html and seq, oldest first.
    pub fn versions_full(&self, project: &str) -> Vec<(i64, String, String, u64)> {
        let mut stmt = self
            .conn
            .prepare("SELECT seq, label, html, ts FROM versions WHERE project_id = ?1 ORDER BY seq")
            .unwrap();
        stmt.query_map(params![project], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
    }

    pub fn record_publish(&self, project: &str, slug: &str, url: &str, last_version: i64) {
        self.conn
            .execute(
                "INSERT INTO publishes (project_id, slug, url, last_version, ts) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(project_id) DO UPDATE SET slug=?2, url=?3, last_version=?4, ts=?5",
                params![project, slug, url, last_version, Self::now()],
            )
            .expect("failed to record publish");
    }

    /// (project_id, slug, url) for every published project.
    pub fn publishes(&self) -> Vec<(String, String, String)> {
        let mut stmt = self
            .conn
            .prepare("SELECT project_id, slug, url FROM publishes")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .filter_map(Result::ok)
            .collect()
    }

    pub fn publish_of(&self, project: &str) -> Option<(String, String, i64)> {
        self.conn
            .query_row(
                "SELECT slug, url, last_version FROM publishes WHERE project_id = ?1",
                params![project],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .unwrap_or(None)
    }

    /// Insert a comment that originated on the published page. Keyed by the
    /// worker's comment id — re-inserting is a no-op. Returns true if new.
    pub fn insert_remote_comment(
        &self,
        id: &str,
        project: &str,
        version_id: Option<String>,
        author: &str,
        text: &str,
        anchor: Option<String>,
        ts: u64,
    ) -> bool {
        self.conn
            .execute(
                "INSERT OR IGNORE INTO comments (id, project_id, version_id, author, text, anchor, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, project, version_id, author, text, anchor, ts],
            )
            .map(|n| n > 0)
            .unwrap_or(false)
    }

    /// One-time import of the pre-SQLite JSON store (db.json + versions/*.html)
    /// into the default project. Renames db.json afterwards so it never re-runs.
    fn migrate_json(&self, dir: &Path) {
        let json_path = dir.join("db.json");
        if !json_path.exists() {
            return;
        }
        let have_versions: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM versions WHERE project_id = ?1",
                params![DEFAULT_PROJECT],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if have_versions == 0 {
            if let Ok(raw) = std::fs::read_to_string(&json_path) {
                if let Ok(db) = serde_json::from_str::<serde_json::Value>(&raw) {
                    for (i, v) in db["versions"].as_array().unwrap_or(&vec![]).iter().enumerate() {
                        let id = v["id"].as_str().unwrap_or_default().to_string();
                        let html = std::fs::read_to_string(
                            dir.join("versions").join(format!("{id}.html")),
                        )
                        .unwrap_or_default();
                        let _ = self.conn.execute(
                            "INSERT OR IGNORE INTO versions (project_id, id, seq, label, html, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                            params![
                                DEFAULT_PROJECT,
                                id,
                                (i + 1) as i64,
                                v["label"].as_str().unwrap_or(""),
                                html,
                                v["ts"].as_u64().unwrap_or(0)
                            ],
                        );
                    }
                    for c in db["comments"].as_array().unwrap_or(&vec![]) {
                        let _ = self.conn.execute(
                            "INSERT OR IGNORE INTO comments (id, project_id, version_id, author, text, anchor, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                            params![
                                c["id"].as_str().unwrap_or_default(),
                                DEFAULT_PROJECT,
                                c["version_id"].as_str(),
                                c["author"].as_str().unwrap_or("claude"),
                                c["text"].as_str().unwrap_or(""),
                                c["anchor"].as_str(),
                                c["ts"].as_u64().unwrap_or(0)
                            ],
                        );
                    }
                }
            }
        }
        let _ = std::fs::rename(&json_path, dir.join("db.json.migrated"));
    }
}
