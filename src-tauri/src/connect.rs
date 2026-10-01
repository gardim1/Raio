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
    ("PreToolUse", Some("Write|Edit|MultiEdit|NotebookEdit|Bash")),
    ("PostToolUse", Some("Write|Edit|MultiEdit|NotebookEdit|Bash|Read|Grep|Glob")),
    ("PostToolUseFailure", Some("Write|Edit|MultiEdit|NotebookEdit|Bash")),
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
    let q = |p: &Path| format!("\"{}\"", p.to_string_lossy().replace('\\', "/"));
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
            settings.as_object_mut().map(|o| o.remove("hooks"));
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

/// Applies the previewed change. Returns the backup path when an original existed.
pub fn connect(root: &Path, command: &str, previewed: &Preview, now_ms: i64) -> Result<Option<PathBuf>, String> {
    let path = settings_path(root);
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let backup = match &previewed.before {
        Some(original) => {
            let b = path.with_extension(format!("json.raio-backup-{now_ms}"));
            fs::write(&b, original).map_err(|e| e.to_string())?;
            Some(b)
        }
        None => None,
    };
    let (_, value) = read_settings(&path)?;
    let after = serde_json::to_string_pretty(&with_raio(value, command)?).map_err(|e| e.to_string())?;
    if after != previewed.after {
        return Err("settings.local.json changed since the preview; review the new diff".into());
    }
    write_checked(&path, &previewed.before, &after)?;
    Ok(backup)
}

/// Removes only Raio's handlers. Leaves the file (possibly `{}`) so user settings are untouched.
pub fn disconnect(root: &Path) -> Result<(), String> {
    let path = settings_path(root);
    let (before, value) = read_settings(&path)?;
    if before.is_none() {
        return Ok(());
    }
    let after = serde_json::to_string_pretty(&without_raio(value)).map_err(|e| e.to_string())?;
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

    #[test]
    fn is_idempotent_and_fully_reversible() {
        let once = with_raio(user_settings(), CMD).unwrap();
        assert_eq!(with_raio(once.clone(), CMD).unwrap(), once);
        assert_eq!(without_raio(once), user_settings());
        assert_eq!(without_raio(with_raio(json!({}), CMD).unwrap()), json!({}));
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
        let backup = connect(root, CMD, &p, 7).unwrap().unwrap();
        assert_eq!(fs::read_to_string(backup).unwrap(), original);
        assert!(fs::read_to_string(settings_path(root)).unwrap().contains(MARKER));
        disconnect(root).unwrap();
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
        assert!(connect(root, CMD, &p, 1).is_err());
        assert_eq!(fs::read_to_string(settings_path(root)).unwrap(), "{\"model\":\"x\"}");
    }

    #[test]
    fn hook_command_quotes_paths_with_spaces_for_git_bash() {
        let c = hook_command(Path::new("C:\\Program Files\\Raio\\raio-hook.exe"), "abc", Path::new("C:\\Area de Trabalho\\app"));
        assert_eq!(c, "\"C:/Program Files/Raio/raio-hook.exe\" claude --project abc --root \"C:/Area de Trabalho/app\" --raio-managed");
    }
}
