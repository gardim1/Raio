//! Local persistence: one SQLite file (WAL) in the app data directory. Migrations are embedded and
//! applied at open; `schema_version()` reports what was actually applied (`user_version`).

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::event::RaioEvent;

const MIGRATIONS: [&str; 1] = [
    "CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        root TEXT NOT NULL,
        name TEXT NOT NULL,
        connected_at INTEGER NOT NULL,
        disconnected_at INTEGER
     );
     CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        session_id TEXT,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        json TEXT NOT NULL
     );
     CREATE INDEX events_by_project ON events(project_id, seq);
     CREATE INDEX events_by_session ON events(session_id);",
];

pub const RETENTION_MS: i64 = 30 * 24 * 3600 * 1000;
pub const SESSION_CAP: i64 = 20_000;

pub struct Store {
    conn: Connection,
    /// Set when an unreadable database was moved aside at open; surfaced in the UI.
    pub reset_from: Option<PathBuf>,
}

#[derive(Debug, PartialEq)]
pub enum Insert {
    Inserted(i64),
    Duplicate,
    Capped,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub root: String,
    pub name: String,
    pub connected_at: i64,
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        conn.execute_batch(&format!("BEGIN; {sql}; PRAGMA user_version = {}; COMMIT;", i + 1))?;
    }
    Ok(())
}

fn healthy(conn: &Connection) -> bool {
    conn.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0)).map(|s| s == "ok").unwrap_or(false)
}

impl Store {
    /// Opens (creating if needed). A database that cannot be opened or fails `quick_check` is renamed
    /// aside (never deleted) and a fresh one is created.
    pub fn open(path: &Path, now_ms: i64) -> rusqlite::Result<Self> {
        let attempt = Connection::open(path).and_then(|c| if healthy(&c) { migrate(&c).map(|_| c) } else { Err(rusqlite::Error::InvalidQuery) });
        match attempt {
            Ok(conn) => Ok(Store { conn, reset_from: None }),
            Err(_) => {
                let aside = path.with_extension(format!("db.corrupt-{now_ms}"));
                let _ = std::fs::rename(path, &aside);
                for suffix in ["-wal", "-shm"] {
                    let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
                }
                let conn = Connection::open(path)?;
                migrate(&conn)?;
                Ok(Store { conn, reset_from: Some(aside) })
            }
        }
    }

    pub fn schema_version(&self) -> i64 {
        self.conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap_or(0)
    }

    pub fn insert(&self, event: &RaioEvent, observed_at: i64) -> rusqlite::Result<Insert> {
        if self.conn.query_row("SELECT 1 FROM events WHERE id = ?1", [&event.id], |_| Ok(())).optional()?.is_some() {
            return Ok(Insert::Duplicate);
        }
        if let Some(session) = &event.session_id {
            let count: i64 = self.conn.query_row("SELECT COUNT(*) FROM events WHERE session_id = ?1", [session], |r| r.get(0))?;
            if count >= SESSION_CAP {
                return Ok(Insert::Capped);
            }
        }
        let mut stored = event.clone();
        stored.observed_at = observed_at;
        let json = serde_json::to_string(&stored).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        self.conn.execute(
            "INSERT INTO events (id, project_id, session_id, kind, source, observed_at, json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![stored.id, stored.project_id, stored.session_id, stored.kind, stored.source, observed_at, json],
        )?;
        Ok(Insert::Inserted(self.conn.last_insert_rowid()))
    }

    /// Events of one project in ingestion order, with `seq` filled in.
    pub fn project_events(&self, project_id: &str) -> rusqlite::Result<Vec<RaioEvent>> {
        let mut stmt = self.conn.prepare("SELECT seq, json FROM events WHERE project_id = ?1 ORDER BY seq")?;
        let rows = stmt.query_map([project_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = vec![];
        for row in rows {
            let (seq, json) = row?;
            if let Ok(mut e) = serde_json::from_str::<RaioEvent>(&json) {
                e.seq = seq;
                out.push(e);
            }
        }
        Ok(out)
    }

    pub fn count_events(&self) -> rusqlite::Result<i64> {
        self.conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
    }

    pub fn apply_retention(&self, now_ms: i64) -> rusqlite::Result<usize> {
        self.conn.execute("DELETE FROM events WHERE observed_at < ?1", [now_ms - RETENTION_MS])
    }

    pub fn clear_history(&self) -> rusqlite::Result<usize> {
        self.conn.execute("DELETE FROM events", [])
    }

    pub fn upsert_project(&self, p: &Project) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO projects (id, root, name, connected_at, disconnected_at) VALUES (?1, ?2, ?3, ?4, NULL)
             ON CONFLICT(id) DO UPDATE SET root = excluded.root, name = excluded.name, connected_at = excluded.connected_at, disconnected_at = NULL",
            params![p.id, p.root, p.name, p.connected_at],
        )?;
        Ok(())
    }

    pub fn disconnect_project(&self, id: &str, now_ms: i64) -> rusqlite::Result<()> {
        self.conn.execute("UPDATE projects SET disconnected_at = ?2 WHERE id = ?1", params![id, now_ms])?;
        Ok(())
    }

    pub fn connected_projects(&self) -> rusqlite::Result<Vec<Project>> {
        let mut stmt = self.conn.prepare("SELECT id, root, name, connected_at FROM projects WHERE disconnected_at IS NULL ORDER BY connected_at DESC")?;
        let rows = stmt.query_map([], |r| Ok(Project { id: r.get(0)?, root: r.get(1)?, name: r.get(2)?, connected_at: r.get(3)? }))?;
        rows.collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{stable_id, Evidence};

    fn event(n: u32, session: &str) -> RaioEvent {
        RaioEvent {
            schema: 1,
            id: stable_id(&["s", &n.to_string(), session]),
            source: "claude-hook".into(),
            provenance: "agent-reported".into(),
            attribution: "session".into(),
            project_id: "p".into(),
            session_id: Some(session.into()),
            agent: "claude".into(),
            subagent_id: None,
            source_at: Some(n as i64),
            observed_at: 0,
            seq: 0,
            kind: "turn.ended".into(),
            paths: vec![],
            evidence: Evidence::default(),
        }
    }

    #[test]
    fn applies_the_migration_and_reports_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("raio.db"), 0).unwrap();
        assert_eq!(store.schema_version(), 1);
        drop(store);
        let again = Store::open(&dir.path().join("raio.db"), 0).unwrap();
        assert_eq!(again.schema_version(), 1);
        assert!(again.reset_from.is_none());
    }

    #[test]
    fn deduplicates_by_id_and_keeps_ingestion_order() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("raio.db"), 0).unwrap();
        assert!(matches!(store.insert(&event(2, "a"), 10).unwrap(), Insert::Inserted(_)));
        assert!(matches!(store.insert(&event(1, "a"), 11).unwrap(), Insert::Inserted(_)));
        assert_eq!(store.insert(&event(2, "a"), 12).unwrap(), Insert::Duplicate);
        let got: Vec<(Option<i64>, i64)> = store.project_events("p").unwrap().into_iter().map(|e| (e.source_at, e.observed_at)).collect();
        assert_eq!(got, vec![(Some(2), 10), (Some(1), 11)]);
    }

    #[test]
    fn survives_restart_and_caps_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("raio.db");
        {
            let store = Store::open(&path, 0).unwrap();
            store.insert(&event(1, "a"), 1).unwrap();
        }
        let store = Store::open(&path, 0).unwrap();
        assert_eq!(store.count_events().unwrap(), 1);
        store.conn.execute_batch("BEGIN").unwrap();
        for n in 2..=(SESSION_CAP as u32) {
            store.insert(&event(n, "a"), 1).unwrap();
        }
        store.conn.execute_batch("COMMIT").unwrap();
        assert_eq!(store.insert(&event(999_999, "a"), 1).unwrap(), Insert::Capped);
        assert!(matches!(store.insert(&event(1, "b"), 1).unwrap(), Insert::Inserted(_)));
    }

    #[test]
    fn retention_removes_only_old_events() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("raio.db"), 0).unwrap();
        let now = RETENTION_MS * 2;
        store.insert(&event(1, "a"), now - RETENTION_MS - 1).unwrap();
        store.insert(&event(2, "a"), now - 1).unwrap();
        assert_eq!(store.apply_retention(now).unwrap(), 1);
        assert_eq!(store.count_events().unwrap(), 1);
    }

    #[test]
    fn moves_a_corrupt_database_aside_instead_of_deleting_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("raio.db");
        std::fs::write(&path, b"this is not a sqlite database, just bytes".repeat(200)).unwrap();
        let store = Store::open(&path, 42).unwrap();
        let aside = store.reset_from.clone().expect("reset reported");
        assert!(aside.exists());
        assert_eq!(store.schema_version(), 1);
        assert_eq!(store.count_events().unwrap(), 0);
    }
}
