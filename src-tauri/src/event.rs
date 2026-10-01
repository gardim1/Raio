//! Raio event contract v1 (mirrors src/features/ingest/raioEvent.ts). Records are minimised
//! before they are written anywhere: no prompts, file contents, tool output or full command lines.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const SCHEMA: u32 = 1;
pub const OUTSIDE_PROJECT: &str = "outside-project";

pub const KINDS: [&str; 10] = [
    "session.started",
    "session.ended",
    "turn.ended",
    "file.inspected",
    "file.edit.attempted",
    "file.edit.reported",
    "file.edit.failed",
    "file.changed",
    "command.observed",
    "command.result",
];

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub program: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// A record as produced (hook, watcher) before ingestion assigns `observedAt` and `seq`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RaioEvent {
    pub schema: u32,
    pub id: String,
    pub source: String,
    pub provenance: String,
    pub attribution: String,
    pub project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subagent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_at: Option<i64>,
    #[serde(default)]
    pub observed_at: i64,
    #[serde(default)]
    pub seq: i64,
    pub kind: String,
    pub paths: Vec<String>,
    pub evidence: Evidence,
}

/// Limits applied to every record, whoever wrote it (the inbox is ordinary files in the user's profile).
const MAX_PATHS: usize = 64;
const MAX_FIELD: usize = 512;

/// True for anything that is not a project-relative path: drive letters and other `:` forms (also
/// `\\?\C:`), UNC and verbatim prefixes, a leading separator, and home-relative `~`, `~/` and `~\`.
/// A name that merely starts with `~` (Office lock files such as `~$report.docx`) is an ordinary file.
fn is_absolute_form(p: &str) -> bool {
    p.contains(':') || p.starts_with(['/', '\\'])|| p == "~" || p.starts_with("~/") || p.starts_with("~\\")
}

impl RaioEvent {
    /// Structural validation of an untrusted record.
    pub fn validate(&self) -> Result<(), String> {
        if self.schema != SCHEMA {
            return Err(format!("unsupported schema {}", self.schema));
        }
        if !KINDS.contains(&self.kind.as_str()) {
            return Err(format!("unknown kind {}", self.kind));
        }
        if !matches!(self.source.as_str(), "claude-hook" | "fs-watch" | "fixture") {
            return Err("unknown source".into());
        }
        if !matches!(self.provenance.as_str(), "agent-reported" | "filesystem-observed" | "fixture") {
            return Err("unknown provenance".into());
        }
        if !matches!(self.attribution.as_str(), "session" | "unassigned") {
            return Err("unknown attribution".into());
        }
        if !matches!(self.agent.as_str(), "claude" | "codex" | "unknown") {
            return Err("unknown agent".into());
        }
        if self.id.is_empty() || self.id.len() > 64 || self.project_id.is_empty() || self.project_id.len() > 64 {
            return Err("bad id".into());
        }
        if self.paths.len() > MAX_PATHS || self.paths.iter().any(|p| p.len() > MAX_FIELD || p != OUTSIDE_PROJECT && is_absolute_form(p)) {
            return Err("bad paths".into());
        }
        let e = &self.evidence;
        for field in [&e.tool_use_id, &e.tool_name, &e.exit_code_source, &e.command_class, &e.program, &e.change, &e.detail].into_iter().flatten() {
            if field.len() > MAX_FIELD {
                return Err("evidence field too long".into());
            }
        }
        Ok(())
    }
}

/// Stable id from the parts that identify one occurrence (hex, 32 chars).
pub fn stable_id(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0u8]);
    }
    hasher.finalize().iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// Project id: hash of the canonical, case-folded root path (the path itself stays local).
pub fn project_id(root: &std::path::Path) -> String {
    let canonical = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let text = canonical.to_string_lossy().replace('\\', "/").to_lowercase();
    stable_id(&["project", text.trim_start_matches("//?/")])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> RaioEvent {
        RaioEvent {
            schema: 1,
            id: stable_id(&["a"]),
            source: "claude-hook".into(),
            provenance: "agent-reported".into(),
            attribution: "session".into(),
            project_id: "p".into(),
            session_id: Some("s".into()),
            agent: "claude".into(),
            subagent_id: None,
            source_at: Some(1),
            observed_at: 0,
            seq: 0,
            kind: "file.edit.reported".into(),
            paths: vec!["src/a.ts".into()],
            evidence: Evidence::default(),
        }
    }

    #[test]
    fn accepts_a_well_formed_record() {
        assert_eq!(sample().validate(), Ok(()));
    }

    #[test]
    fn rejects_unknown_kinds_schemas_and_absolute_paths() {
        assert!(RaioEvent { kind: "file.deleted.everything".into(), ..sample() }.validate().is_err());
        assert!(RaioEvent { schema: 2, ..sample() }.validate().is_err());
        assert!(RaioEvent { paths: vec!["C:/Users/someone/secret.txt".into()], ..sample() }.validate().is_err());
        assert!(RaioEvent { paths: vec![OUTSIDE_PROJECT.into()], ..sample() }.validate().is_ok());
    }

    #[test]
    fn rejects_every_absolute_or_home_relative_path_form() {
        for bad in [
            "C:/Users/someone/secret.txt",
            "c:\\Users\\someone\\secret.txt",
            "\\\\server\\share\\file.txt",
            "//server/share/file.txt",
            "\\\\?\\C:\\Users\\someone\\file.txt",
            "\\\\?\\UNC\\server\\share\\file.txt",
            "/etc/passwd",
            "\\Windows\\win.ini",
            "~",
            "~/.ssh/config",
            "~\\.ssh\\config",
        ] {
            assert!(RaioEvent { paths: vec![bad.into()], ..sample() }.validate().is_err(), "{bad}");
        }
        // Names that merely start with `~` (Office lock files, backups) are ordinary project files.
        for fine in ["~$report.docx", "~backup.txt", "src/~tmp/a.ts", "docs/readme.md", "a b/c.ts"] {
            assert!(RaioEvent { paths: vec![fine.into()], ..sample() }.validate().is_ok(), "{fine}");
        }
    }

    #[test]
    fn ids_are_stable_and_distinct() {
        assert_eq!(stable_id(&["x", "y"]), stable_id(&["x", "y"]));
        assert_ne!(stable_id(&["x", "y"]), stable_id(&["xy", ""]));
        assert_eq!(stable_id(&["x"]).len(), 32);
    }
}
