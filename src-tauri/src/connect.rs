//! Opt-in, project-scoped Claude Code connection through `<project>/.claude/settings.local.json`.
//! Shows the exact before/after, backs up the original, preserves every existing setting and hook,
//! marks Raio's handlers (`--raio-managed`) and removes only those on disconnect.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

pub const MARKER: &str = "--raio-managed";

/// Hook events Raio listens to, with the tool matcher where one applies.
const HOOKS: [(&str, Option<&str>); 6] = [
    ("SessionStart", None),
    ("SessionEnd", None),
    ("Stop", None),
    ("PreToolUse", Some("Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell")),
    ("PostToolUse", Some("Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell|Read|Grep|Glob")),
    ("PostToolUseFailure", Some("Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell")),
];

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub settings_path: String,
    pub before: Option<String>,
    pub after: String,
    /// `Some(false)`: git does not ignore the file, so it could be committed with a personal path.
    pub git_ignored: Option<bool>,
}

pub fn settings_path(root: &Path) -> PathBuf {
    root.join(".claude").join("settings.local.json")
}

/// Hook command as Claude Code runs it (through Git Bash on Windows): forward slashes, quoted.
pub fn hook_command(hook_exe: &Path, project_id: &str, root: &Path) -> String {
    // POSIX single quotes: nothing inside is expanded by Git Bash or sh ($, backticks, double quotes).
    let q = |p: &Path| format!("'{}'", p.to_string_lossy().replace('\\', "/").replace('\'', "'\\''"));
    format!("{} claude --project {project_id} --root {} {MARKER}", q(hook_exe), q(root))
}

fn is_raio_handler(h: &Value) -> bool {
    h.get("command").and_then(Value::as_str).is_some_and(|c| c.contains(MARKER))
}

/// Removes Raio's handlers (and groups/events left empty by that) from a settings object.
pub fn without_raio(mut settings: Value) -> Value {
    if let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) {
        for groups in hooks.values_mut() {
            if let Some(list) = groups.as_array_mut() {
                for group in list.iter_mut() {
                    if let Some(handlers) = group.get_mut("hooks").and_then(Value::as_array_mut) {
                        handlers.retain(|h| !is_raio_handler(h));
                    }
                }
                list.retain(|g| g.get("hooks").and_then(Value::as_array).is_none_or(|h| !h.is_empty()));
            }
        }
        hooks.retain(|_, groups| groups.as_array().is_none_or(|g| !g.is_empty()));
        if hooks.is_empty() {
            // `shift_remove`: with `preserve_order`, plain `remove` would swap the last key into the gap.
            settings.as_object_mut().map(|o| o.shift_remove("hooks"));
        }
    }
    settings
}

/// Adds Raio's handlers to a settings object (idempotent: existing Raio handlers are replaced).
pub fn with_raio(settings: Value, command: &str) -> Result<Value, String> {
    let mut settings = without_raio(settings);
    let obj = settings.as_object_mut().ok_or("settings.local.json is not a JSON object")?;
    let hooks = obj.entry("hooks").or_insert_with(|| Value::Object(Map::new()));
    let hooks = hooks.as_object_mut().ok_or("\"hooks\" is not an object")?;
    for (event, matcher) in HOOKS {
        let groups = hooks.entry(event).or_insert_with(|| json!([]));
        let groups = groups.as_array_mut().ok_or_else(|| format!("hooks.{event} is not an array"))?;
        let mut group = json!({ "hooks": [{ "type": "command", "command": command, "async": true }] });
        if let Some(m) = matcher {
            group["matcher"] = json!(m);
        }
        groups.push(group);
    }
    Ok(settings)
}

fn read_settings(path: &Path) -> Result<(Option<String>, Value), String> {
    match fs::read_to_string(path) {
        Ok(text) => {
            let value: Value = serde_json::from_str(&text).map_err(|e| format!("{} is not valid JSON ({e}); not changing it", path.display()))?;
            Ok((Some(text), value))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((None, json!({}))),
        Err(e) => Err(e.to_string()),
    }
}

fn git_ignored(root: &Path, file: &Path) -> Option<bool> {
    let out = Command::new("git").arg("-C").arg(root).arg("check-ignore").arg("-q").arg(file).output().ok()?;
    match out.status.code() {
        Some(0) => Some(true),
        Some(1) => Some(false),
        _ => None, // not a git repository, or git unavailable
    }
}

pub fn preview(root: &Path, command: &str) -> Result<Preview, String> {
    let path = settings_path(root);
    let (before, value) = read_settings(&path)?;
    let after = serde_json::to_string_pretty(&with_raio(value, command)?).map_err(|e| e.to_string())?;
    Ok(Preview { settings_path: path.to_string_lossy().into_owned(), before, after, git_ignored: git_ignored(root, &path) })
}

/// Writes through a temp file and rename, after checking the file did not change since the preview.
fn write_checked(path: &Path, expected_before: &Option<String>, content: &str) -> Result<(), String> {
    let (current, _) = read_settings(path)?;
    if &current != expected_before {
        return Err("settings.local.json changed since the preview; review the new diff".into());
    }
    let tmp = path.with_extension("json.raio-tmp");
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

fn backup(backup_dir: &Path, original: &str, now_ms: i64) -> Result<PathBuf, String> {
    fs::create_dir_all(backup_dir).map_err(|e| e.to_string())?;
    let b = backup_dir.join(format!("settings.local.json.{now_ms}.bak"));
    fs::write(&b, original).map_err(|e| e.to_string())?;
    Ok(b)
}

/// Applies the previewed change. The backup of the current file goes to Raio's own data directory
/// (outside the repository, so it cannot be committed by accident). Returns the backup path when an
/// original existed.
pub fn connect(root: &Path, command: &str, previewed: &Preview, backup_dir: &Path, now_ms: i64) -> Result<Option<PathBuf>, String> {
    let path = settings_path(root);
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let (current, value) = read_settings(&path)?;
    if current != previewed.before {
        return Err("settings.local.json changed since the preview; review the new diff".into());
    }
    let after = serde_json::to_string_pretty(&with_raio(value, command)?).map_err(|e| e.to_string())?;
    if after != previewed.after {
        return Err("settings.local.json changed since the preview; review the new diff".into());
    }
    let saved = current.as_deref().map(|original| backup(backup_dir, original, now_ms)).transpose()?;
    write_checked(&path, &current, &after)?;
    Ok(saved)
}

/// Removes only Raio's handlers (backing up first). Leaves the file so user settings are untouched,
/// and does not rewrite it when it holds no Raio handler.
pub fn disconnect(root: &Path, backup_dir: &Path, now_ms: i64) -> Result<(), String> {
    let path = settings_path(root);
    let (before, value) = read_settings(&path)?;
    let Some(original) = before.clone() else { return Ok(()) };
    let cleaned = without_raio(value.clone());
    if cleaned == value {
        return Ok(());
    }
    backup(backup_dir, &original, now_ms)?;
    let after = serde_json::to_string_pretty(&cleaned).map_err(|e| e.to_string())?;
    write_checked(&path, &before, &after)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CMD: &str = "\"C:/Raio/raio-hook.exe\" claude --project p --root \"C:/work/app\" --raio-managed";

    fn user_settings() -> Value {
        json!({
            "permissions": { "allow": ["Bash(npm test)"] },
            "hooks": { "PostToolUse": [{ "matcher": "Write", "hooks": [{ "type": "command", "command": "prettier --write" }] }] }
        })
    }

    #[test]
    fn adds_handlers_without_touching_existing_settings_or_hooks() {
        let merged = with_raio(user_settings(), CMD).unwrap();
        assert_eq!(merged["permissions"], user_settings()["permissions"]);
        let post = merged["hooks"]["PostToolUse"].as_array().unwrap();
        assert_eq!(post.len(), 2);
        assert_eq!(post[0]["hooks"][0]["command"], "prettier --write");
        assert_eq!(post[1]["hooks"][0]["async"], true);
        assert_eq!(merged["hooks"].as_object().unwrap().len(), HOOKS.len());
    }

    fn keys(v: &Value) -> Vec<&str> {
        v.as_object().unwrap().keys().map(String::as_str).collect()
    }

    #[test]
    fn an_untouched_file_round_trips_its_key_order() {
        // Deliberately not alphabetical, at the top level and inside `hooks`.
        let original = r#"{
  "zeta": 1,
  "permissions": { "deny": ["x"], "allow": ["y"] },
  "hooks": {
    "Stop": [ { "hooks": [ { "type": "command", "command": "mine" } ] } ],
    "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "mine2" } ] } ]
  },
  "alpha": 2
}"#;
        let value: Value = serde_json::from_str(original).unwrap();
        assert_eq!(keys(&value), ["zeta", "permissions", "hooks", "alpha"]);
        let connected = with_raio(value.clone(), CMD).unwrap();
        assert_eq!(keys(&connected), ["zeta", "permissions", "hooks", "alpha"]);
        assert_eq!(keys(&connected["permissions"]), ["deny", "allow"]);
        assert_eq!(keys(&connected["hooks"])[..2], ["Stop", "PreToolUse"]);
        let restored = without_raio(connected);
        assert_eq!(serde_json::to_string_pretty(&restored).unwrap(), serde_json::to_string_pretty(&value).unwrap());
    }

    #[test]
    fn removing_the_hooks_key_keeps_the_other_keys_in_place() {
        // A file where `hooks` sits in the middle and holds nothing but Raio's handlers.
        let only_raio = with_raio(json!({}), CMD).unwrap()["hooks"].clone();
        let connected = json!({ "b": 1, "hooks": only_raio, "a": 2, "c": 3 });
        assert_eq!(keys(&connected), ["b", "hooks", "a", "c"]);
        let restored = without_raio(connected);
        assert_eq!(keys(&restored), ["b", "a", "c"]);
    }

    #[test]
    fn is_idempotent_and_fully_reversible() {
        let once = with_raio(user_settings(), CMD).unwrap();
        assert_eq!(with_raio(once.clone(), CMD).unwrap(), once);
        assert_eq!(without_raio(once), user_settings());
        assert_eq!(without_raio(with_raio(json!({}), CMD).unwrap()), json!({}));
    }

    #[test]
    fn reconnect_replaces_bash_only_matchers_and_captures_powershell_once() {
        let mut old = with_raio(user_settings(), CMD).unwrap();
        for event in ["PreToolUse", "PostToolUse", "PostToolUseFailure"] {
            let groups = old["hooks"][event].as_array_mut().unwrap();
            let managed = groups.last_mut().unwrap();
            let matcher = managed["matcher"].as_str().unwrap().replace("|PowerShell", "");
            managed["matcher"] = json!(matcher);
        }
        let updated = with_raio(old, CMD).unwrap();
        for event in ["PreToolUse", "PostToolUse", "PostToolUseFailure"] {
            let managed: Vec<_> = updated["hooks"][event].as_array().unwrap().iter()
                .filter(|g| g["hooks"].as_array().unwrap().iter().any(is_raio_handler)).collect();
            assert_eq!(managed.len(), 1, "{event}");
            let tools: Vec<_> = managed[0]["matcher"].as_str().unwrap().split('|').collect();
            assert!(tools.contains(&"Bash") && tools.contains(&"PowerShell"), "{event}: {tools:?}");
        }
        assert_eq!(without_raio(updated), user_settings());
    }

    #[test]
    fn refuses_malformed_files() {
        assert!(with_raio(json!([1, 2]), CMD).is_err());
        assert!(with_raio(json!({ "hooks": { "Stop": "nope" } }), CMD).is_err());
    }

    #[test]
    fn connect_backs_up_then_disconnect_restores_the_user_settings() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(".claude")).unwrap();
        let original = serde_json::to_string_pretty(&user_settings()).unwrap();
        fs::write(settings_path(root), &original).unwrap();
        let p = preview(root, CMD).unwrap();
        assert_eq!(p.before.as_deref(), Some(original.as_str()));
        let backups = tempfile::tempdir().unwrap();
        let saved = connect(root, CMD, &p, backups.path(), 7).unwrap().unwrap();
        assert!(saved.starts_with(backups.path()), "backup must live outside the project");
        assert_eq!(fs::read_to_string(saved).unwrap(), original);
        assert!(!fs::read_dir(root.join(".claude")).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().contains("bak")));
        assert!(fs::read_to_string(settings_path(root)).unwrap().contains(MARKER));
        let connected: Value = serde_json::from_str(&fs::read_to_string(settings_path(root)).unwrap()).unwrap();
        for event in ["PreToolUse", "PostToolUse", "PostToolUseFailure"] {
            let group = connected["hooks"][event].as_array().unwrap().last().unwrap();
            assert!(group["matcher"].as_str().unwrap().split('|').any(|tool| tool == "PowerShell"));
        }
        disconnect(root, backups.path(), 8).unwrap();
        let restored: Value = serde_json::from_str(&fs::read_to_string(settings_path(root)).unwrap()).unwrap();
        assert_eq!(restored, user_settings());
    }

    #[test]
    fn refuses_to_overwrite_a_file_changed_after_the_preview() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let p = preview(root, CMD).unwrap();
        fs::create_dir_all(root.join(".claude")).unwrap();
        fs::write(settings_path(root), "{\"model\":\"x\"}").unwrap();
        assert!(connect(root, CMD, &p, dir.path(), 1).is_err());
        assert_eq!(fs::read_to_string(settings_path(root)).unwrap(), "{\"model\":\"x\"}");
    }

    #[test]
    fn hook_command_quotes_paths_with_spaces_for_git_bash() {
        let c = hook_command(Path::new("C:\\Program Files\\Raio\\raio-hook.exe"), "abc", Path::new("C:\\Area de Trabalho\\app"));
        assert_eq!(c, "'C:/Program Files/Raio/raio-hook.exe' claude --project abc --root 'C:/Area de Trabalho/app' --raio-managed");
        let tricky = hook_command(Path::new("C:\\h.exe"), "abc", Path::new("C:\\it's $HOME `x`"));
        assert!(tricky.ends_with("--root 'C:/it'\\''s $HOME `x`' --raio-managed"), "{tricky}");
    }
}
