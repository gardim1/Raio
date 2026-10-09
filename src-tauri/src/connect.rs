//! Opt-in, project-scoped Claude Code connection through `<project>/.claude/settings.local.json`.
//! Shows the exact before/after, backs up the original, preserves every existing setting and hook,
//! marks Raio's handlers (`--raio-managed`) and removes only those on disconnect.

use std::fs;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

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
    #[serde(default)]
    pub usage: Option<crate::usage_connect::Preview>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HooksState {
    Current,
    Outdated,
    Unknown,
}

/// Read-only comparison of managed handlers/matchers with this build's installation.
pub fn hooks_state(settings: &Value, command: &str) -> HooksState {
    let actual = managed_handlers(settings);
    if actual.is_empty() { return HooksState::Unknown; }
    let Ok(expected) = with_raio(json!({}), command) else { return HooksState::Unknown };
    let mut expected = managed_handlers(&expected);
    if actual.len() != expected.len() { return HooksState::Outdated; }
    // Group/event order and unrelated user hooks do not change Raio's configuration.
    for handler in actual {
        let Some(index) = expected.iter().position(|h| *h == handler) else { return HooksState::Outdated };
        expected.swap_remove(index);
    }
    if settings.get("statusLine").is_some_and(crate::usage_connect::owned)
        && settings["statusLine"]["command"].as_str() != crate::usage_connect::command(command).as_deref() { return HooksState::Outdated; }
    HooksState::Current
}

fn managed_handlers(settings: &Value) -> Vec<(String, Option<Value>, Value)> {
    let mut handlers = Vec::new();
    if let Some(hooks) = settings.get("hooks").and_then(Value::as_object) {
        for (event, groups) in hooks {
            let Some(groups) = groups.as_array() else { continue };
            for group in groups {
                let Some(list) = group.get("hooks").and_then(Value::as_array) else { continue };
                for handler in list.iter().filter(|h| is_raio_handler(h)) {
                    handlers.push((event.clone(), group.get("matcher").cloned(), handler.clone()));
                }
            }
        }
    }
    handlers
}

pub fn has_raio_handlers(settings: &Value) -> bool {
    !managed_handlers(settings).is_empty()
}

pub fn read_hooks_state(root: &Path, command: &str) -> HooksState {
    match read_settings(&settings_path(root)) {
        Ok((Some(_), settings)) => hooks_state(&settings, command),
        _ => HooksState::Unknown,
    }
}

pub fn settings_path(root: &Path) -> PathBuf {
    root.join(".claude").join("settings.local.json")
}

/// Hook command as Claude Code runs it (through Git Bash on Windows): forward slashes, quoted.
pub fn hook_command(hook_exe: &Path, project_id: &str, root: &Path) -> String {
    managed_command(hook_exe, project_id, root, "claude")
}

pub(crate) fn managed_command(hook_exe: &Path, project_id: &str, root: &Path, mode: &str) -> String {
    // POSIX single quotes: nothing inside is expanded by Git Bash or sh ($, backticks, double quotes).
    let q = |p: &Path| format!("'{}'", p.to_string_lossy().replace('\\', "/").replace('\'', "'\\''"));
    format!("{} {mode} --project {project_id} --root {} {MARKER}", q(hook_exe), q(root))
}

fn is_raio_handler(h: &Value) -> bool {
    if h.get("type").and_then(Value::as_str) != Some("command") {
        return false;
    }
    let Some(command) = h.get("command").and_then(Value::as_str) else { return false };
    owned_command(command, "claude")
}

pub(crate) fn owned_command(command: &str, expected_mode: &str) -> bool {
    let command = command.trim();
    if !command.ends_with(&format!(" {MARKER}")) {
        return false;
    }
    let Some(words) = handler_words(command) else { return false };
    let [exe, mode, project_flag, project, root_flag, root, marker] = words.as_slice() else { return false };
    let executable = exe.rsplit(['/', '\\']).next().unwrap_or(exe);
    matches!(executable, "raio-hook" | "raio-hook.exe") && mode == expected_mode
        && project_flag == "--project" && !project.is_empty()
        && project.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')) && !project.starts_with('-')
        && root_flag == "--root" && !root.is_empty() && marker == MARKER
}

/// Recognises only the generated argument shape, never executes shell text. Supports the original
/// double-quoted paths (312479d) and POSIX single quotes/apostrophe escaping (d4f93d6 onward).
pub(crate) fn handler_words(command: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut started = false;
    let mut chars = command.chars();
    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else {
                word.push(c);
            }
            continue;
        }
        match c {
            '\'' | '"' => {
                quote = Some(c);
                started = true;
            }
            '\\' => {
                // The only unquoted escape Raio emits: an apostrophe between quoted path fragments.
                if chars.next() != Some('\'') {
                    return None;
                }
                word.push('\'');
                started = true;
            }
            '\n' | '\r' | ';' | '&' | '|' | '<' | '>' | '$' | '`' | '(' | ')' => return None,
            c if c.is_whitespace() => {
                if started {
                    words.push(std::mem::take(&mut word));
                    if words.len() >= 7 {
                        return None;
                    }
                    started = false;
                }
            }
            _ => {
                word.push(c);
                started = true;
            }
        }
    }
    if quote.is_some() {
        return None;
    }
    if started {
        words.push(word);
    }
    Some(words)
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

const GIT_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const GIT_PREVIEW_CACHE_TTL: Duration = Duration::from_secs(30);
type GitIgnoreCacheKey = (PathBuf, PathBuf);
type GitIgnoreCacheValue = (Instant, Option<bool>);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
struct GitIgnoreCache {
    values: Mutex<HashMap<GitIgnoreCacheKey, GitIgnoreCacheValue>>,
}

impl GitIgnoreCache {
    fn get_or_probe(&self, root: &Path, file: &Path, now: Instant, probe: impl FnOnce() -> Option<bool>) -> Option<bool> {
        let key = (root.to_path_buf(), file.to_path_buf());
        if let Ok(mut values) = self.values.lock() {
            values.retain(|_, (at, _)| now.saturating_duration_since(*at) <= GIT_PREVIEW_CACHE_TTL);
            if let Some((_, result)) = values.get(&key) { return *result; }
            let result = probe();
            if values.len() >= 128 { values.clear(); }
            values.insert(key, (now, result));
            result
        } else {
            probe()
        }
    }
}

static GIT_IGNORE_CACHE: OnceLock<GitIgnoreCache> = OnceLock::new();

fn git_ignore_command(root: &Path, file: &Path) -> Command {
    let mut command = Command::new("git");
    command.arg("-C").arg(root).arg("check-ignore").arg("-q").arg(file)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(git_command_creation_flags());
    }
    command
}

fn wait_git(mut child: Child, deadline: Instant) -> Option<bool> {
    loop {
        match child.try_wait().ok()? {
            Some(status) => return match status.code() { Some(0) => Some(true), Some(1) => Some(false), _ => None },
            None if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            None => { let _ = child.kill(); let _ = child.wait(); return None; }
        }
    }
}

fn git_ignored_uncached(root: &Path, file: &Path) -> Option<bool> {
    let child = git_ignore_command(root, file).spawn().ok()?;
    wait_git(child, Instant::now() + GIT_PROBE_TIMEOUT)
}

fn git_ignored(root: &Path, file: &Path) -> Option<bool> {
    GIT_IGNORE_CACHE.get_or_init(GitIgnoreCache::default)
        .get_or_probe(root, file, Instant::now(), || git_ignored_uncached(root, file))
}

#[cfg(windows)]
fn git_command_creation_flags() -> u32 { CREATE_NO_WINDOW }

pub fn preview(root: &Path, command: &str) -> Result<Preview, String> {
    preview_usage(root, command, None, &crate::usage_connect::Layers::default())
}

pub fn preview_usage(root: &Path, command: &str, options: Option<crate::usage_connect::Options>, layers: &crate::usage_connect::Layers) -> Result<Preview, String> {
    let path = settings_path(root);
    let (before, value) = read_settings(&path)?;
    let usage = crate::usage_connect::preview(root, &value, command, options, layers);
    let mut after_value = with_raio(value, command)?;
    // A blocked opt-in still produces a reviewable diff, but apply refuses it until consent is explicit.
    if usage.reason.is_none() || !usage.enabled { crate::usage_connect::apply(&mut after_value, &usage)?; }
    let after = serde_json::to_string_pretty(&after_value).map_err(|e| e.to_string())?;
    Ok(Preview { settings_path: path.to_string_lossy().into_owned(), before, after, git_ignored: git_ignored(root, &path), usage: Some(usage) })
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
    connect_usage(root, command, previewed, backup_dir, now_ms, &crate::usage_connect::Layers::discover())
}

pub fn connect_usage(root: &Path, command: &str, previewed: &Preview, backup_dir: &Path, now_ms: i64, layers: &crate::usage_connect::Layers) -> Result<Option<PathBuf>, String> {
    let path = settings_path(root);
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let (current, value) = read_settings(&path)?;
    if current != previewed.before {
        return Err("settings.local.json changed since the preview; review the new diff".into());
    }
    let mut updated = with_raio(value.clone(), command)?;
    if let Some(approved) = &previewed.usage {
        let options = crate::usage_connect::Options { enabled: approved.enabled, replace_existing: approved.replace_existing };
        let current_usage = crate::usage_connect::preview(root, &value, command, Some(options), layers);
        if current_usage != *approved { return Err("Status line settings changed since the preview; review the new diff".into()) }
        crate::usage_connect::apply(&mut updated, &current_usage)?;
    } else if value.get("statusLine").is_some_and(crate::usage_connect::owned) {
        return Err("Review the usage opt-in before reconnecting this project".into());
    }
    let after = serde_json::to_string_pretty(&updated).map_err(|e| e.to_string())?;
    if after != previewed.after {
        return Err("settings.local.json changed since the preview; review the new diff".into());
    }
    let saved = current.as_deref().map(|original| backup(backup_dir, original, now_ms)).transpose()?;
    write_checked(&path, &current, &after)?;
    if previewed.usage.is_some() {
        crate::usage_connect::save_receipt(root, backup_dir, updated.get("statusLine").filter(|_| previewed.usage.as_ref().is_some_and(|p| p.enabled)))
            .map_err(|reason| format!("Project settings were saved, but {reason}. Review the connection again."))?;
    }
    Ok(saved)
}

/// Removes only Raio's handlers (backing up first). Leaves the file so user settings are untouched,
/// and does not rewrite it when it holds no Raio handler.
pub fn disconnect(root: &Path, backup_dir: &Path, now_ms: i64) -> Result<(), String> {
    let path = settings_path(root);
    let (before, value) = read_settings(&path)?;
    let Some(original) = before.clone() else { return Ok(()) };
    let mut cleaned = without_raio(value.clone());
    if value.get("statusLine").is_some_and(|v| crate::usage_connect::receipt_matches(root, backup_dir, v)) {
        crate::usage_connect::remove_owned(&mut cleaned);
    }
    if cleaned == value {
        return crate::usage_connect::save_receipt(root, backup_dir, None);
    }
    backup(backup_dir, &original, now_ms)?;
    let after = serde_json::to_string_pretty(&cleaned).map_err(|e| e.to_string())?;
    write_checked(&path, &before, &after)?;
    crate::usage_connect::save_receipt(root, backup_dir, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_exposes_a_separate_disabled_usage_choice() {
        let dir = tempfile::tempdir().unwrap();
        let p = preview(dir.path(), CMD).unwrap();
        let value = serde_json::to_value(p).unwrap();
        assert_eq!(value["usage"]["enabled"], false);
        assert_eq!(value["usage"]["effective"], "none");
        assert!(value["after"].as_str().unwrap().find("statusLine").is_none());
    }

    #[test]
    fn usage_only_preview_change_reuses_the_git_verdict_for_the_same_root_and_settings() {
        let cache = GitIgnoreCache::default();
        let root = Path::new("C:/project");
        let settings = root.join(".claude/settings.local.json");
        let now = Instant::now();
        let mut calls = 0;
        assert_eq!(cache.get_or_probe(root, &settings, now, || { calls += 1; Some(true) }), Some(true));
        assert_eq!(cache.get_or_probe(root, &settings, now + Duration::from_secs(1), || { calls += 1; Some(false) }), Some(true));
        assert_eq!(calls, 1);
    }

    #[cfg(windows)]
    #[test]
    fn git_ignore_command_uses_create_no_window() {
        assert_eq!(git_command_creation_flags(), 0x0800_0000);
    }

    #[test]
    fn usage_apply_rechecks_inherited_line_and_exact_diff_then_backs_up_only_local_settings() {
        use crate::usage_connect::{Layers, Options};
        let project = tempfile::tempdir().unwrap(); let private = tempfile::tempdir().unwrap();
        let user = private.path().join("user.json"); let backups = private.path().join("backups");
        let layers = Layers { user:Some(user.clone()), managed:None, receipts:None };
        fs::write(&user, r#"{"env":{"secret":"PRIVATE"},"statusLine":{"type":"command","command":"mine"}}"#).unwrap();
        let original = fs::read(&user).unwrap();
        let options = Some(Options { enabled:true, replace_existing:false });
        let blocked = preview_usage(project.path(), CMD, options, &layers).unwrap();
        assert!(connect_usage(project.path(), CMD, &blocked, &backups, 1, &layers).is_err());
        assert!(!settings_path(project.path()).exists());
        let options = Some(Options { enabled:true, replace_existing:true });
        let p = preview_usage(project.path(), CMD, options, &layers).unwrap();
        fs::write(&user, r#"{"statusLine":{"type":"command","command":"newer"}}"#).unwrap();
        assert!(connect_usage(project.path(), CMD, &p, &backups, 2, &layers).is_err());
        fs::write(&user, &original).unwrap();
        let mut forged = preview_usage(project.path(), CMD, options, &layers).unwrap(); forged.after = "{}".into();
        assert!(connect_usage(project.path(), CMD, &forged, &backups, 3, &layers).is_err());
        connect_usage(project.path(), CMD, &p, &backups, 4, &layers).unwrap();
        let current: Value = serde_json::from_str(&fs::read_to_string(settings_path(project.path())).unwrap()).unwrap();
        assert_eq!(hooks_state(&current, CMD), HooksState::Current);
        assert_eq!(hooks_state(&current, &CMD.replace("C:/Raio", "C:/NewRaio")), HooksState::Outdated);
        let p = preview_usage(project.path(), &CMD.replace("C:/Raio", "C:/NewRaio"), None, &layers).unwrap();
        connect_usage(project.path(), &CMD.replace("C:/Raio", "C:/NewRaio"), &p, &backups, 5, &layers).unwrap();
        assert_eq!(fs::read_dir(&backups).unwrap().flatten().filter(|e| e.path().extension().is_some_and(|ext| ext == "bak")).count(), 1);
        assert_eq!(fs::read(&user).unwrap(), original);
        disconnect(project.path(), &backups, 6).unwrap();
        assert_eq!(fs::read(&user).unwrap(), original);
    }

    #[test]
    fn disconnect_removes_only_the_exact_generated_statusline_shape() {
        let dir = tempfile::tempdir().unwrap(); let backups = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".claude")).unwrap();
        let ours = json!({"type":"command","command":CMD.replacen(" claude ", " statusline ", 1)});
        fs::write(settings_path(dir.path()), json!({"statusLine":ours}).to_string()).unwrap();
        crate::usage_connect::save_receipt(dir.path(), backups.path(), Some(&ours)).unwrap();
        disconnect(dir.path(), backups.path(), 1).unwrap();
        let restored: Value = serde_json::from_str(&fs::read_to_string(settings_path(dir.path())).unwrap()).unwrap();
        assert!(restored.get("statusLine").is_none());
        for user in [json!({"type":"command","command":"echo --raio-managed"}),
            json!({"type":"command","command":ours["command"],"padding":0}),
            json!({"type":"command","command":ours["command"].as_str().unwrap().replace("--project p", "--project changed")})] {
            crate::usage_connect::save_receipt(dir.path(), backups.path(), Some(&ours)).unwrap();
            let text = json!({"statusLine":user}).to_string(); fs::write(settings_path(dir.path()), &text).unwrap();
            disconnect(dir.path(), backups.path(), 2).unwrap();
            assert_eq!(fs::read_to_string(settings_path(dir.path())).unwrap(), text);
        }
    }

    const CMD: &str = "\"C:/Raio/raio-hook.exe\" claude --project p --root \"C:/work/app\" --raio-managed";

    fn user_settings() -> Value {
        json!({
            "permissions": { "allow": ["Bash(npm test)"] },
            "hooks": { "PostToolUse": [{ "matcher": "Write", "hooks": [{ "type": "command", "command": "prettier --write" }] }] }
        })
    }

    #[test]
    fn hooks_state_current_ignores_user_hooks_settings_and_group_order() {
        let mut settings = with_raio(user_settings(), CMD).unwrap();
        settings["unrelated"] = json!({ "user": "setting" });
        settings["hooks"]["Stop"].as_array_mut().unwrap().insert(0,
            json!({ "matcher": "user-only", "hooks": [{ "type": "command", "command": "echo --raio-managed" }] }));
        for groups in settings["hooks"].as_object_mut().unwrap().values_mut() { groups.as_array_mut().unwrap().reverse(); }
        let before = settings.clone();
        assert_eq!(hooks_state(&settings, CMD), HooksState::Current);
        assert_eq!(settings, before, "pure comparison must not alter the caller's settings");
    }

    #[test]
    fn hooks_state_outdated_detects_old_matchers_missing_duplicate_and_changed_handlers() {
        let current = with_raio(user_settings(), CMD).unwrap();
        let mut old = current.clone();
        for event in ["PreToolUse", "PostToolUse", "PostToolUseFailure"] {
            let group = old["hooks"][event].as_array_mut().unwrap().last_mut().unwrap();
            group["matcher"] = json!(group["matcher"].as_str().unwrap().replace("|PowerShell", ""));
        }
        assert_eq!(hooks_state(&old, CMD), HooksState::Outdated);
        let mut missing = current.clone();
        missing["hooks"].as_object_mut().unwrap().shift_remove("SessionEnd");
        assert_eq!(hooks_state(&missing, CMD), HooksState::Outdated);
        let mut duplicate = current.clone();
        let handler = duplicate["hooks"]["Stop"][0]["hooks"][0].clone();
        duplicate["hooks"]["Stop"][0]["hooks"].as_array_mut().unwrap().push(handler);
        assert_eq!(hooks_state(&duplicate, CMD), HooksState::Outdated);
        let mut changed = current.clone();
        changed["hooks"]["Stop"][0]["hooks"][0]["async"] = json!(false);
        assert_eq!(hooks_state(&changed, CMD), HooksState::Outdated);
        assert_eq!(hooks_state(&current, &CMD.replace("--project p", "--project other")), HooksState::Outdated);
    }

    #[test]
    fn hooks_state_reads_are_unknown_for_missing_malformed_unreadable_or_user_only_settings() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_hooks_state(dir.path(), CMD), HooksState::Unknown);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0, "missing settings must not be created");
        fs::create_dir_all(dir.path().join(".claude")).unwrap();
        for text in ["{not json", "[]", "{}", &serde_json::to_string(&user_settings()).unwrap(),
            &serde_json::to_string(&with_raio(user_settings(), CMD).unwrap()).unwrap()] {
            fs::write(settings_path(dir.path()), text).unwrap();
            let expected = if text.contains("raio-hook.exe") { HooksState::Current } else { HooksState::Unknown };
            assert_eq!(read_hooks_state(dir.path(), CMD), expected);
            assert_eq!(fs::read_to_string(settings_path(dir.path())).unwrap(), text);
            assert_eq!(fs::read_dir(dir.path().join(".claude")).unwrap().count(), 1, "no backup or temp writes");
        }
        fs::remove_file(settings_path(dir.path())).unwrap();
        fs::create_dir(settings_path(dir.path())).unwrap();
        assert_eq!(read_hooks_state(dir.path(), CMD), HooksState::Unknown, "a directory is not a readable settings file");
    }

    #[test]
    fn hooks_state_serializes_as_the_contract_strings() {
        for (state, expected) in [(HooksState::Current, "current"), (HooksState::Outdated, "outdated"), (HooksState::Unknown, "unknown")] {
            assert_eq!(serde_json::to_value(state).unwrap(), json!(expected));
        }
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
    fn ownership_does_not_follow_a_marker_in_another_command() {
        for command in [
            "echo --raio-managed",
            "echo 'raio-hook.exe claude --project p --root /work --raio-managed'",
            "echo raio-hook.exe claude --project p --root /work --raio-managed",
            "other.exe claude --project p --root /work --raio-managed",
            "not-raio-hook.exe claude --project p --root /work --raio-managed",
            "raio-hook.exe.extra claude --project p --root /work --raio-managed",
            "raio-hook.exe --raio-managed",
            "raio-hook.exe claude --project p --root /work --raio-managed-extra",
            "raio-hook.exe claude --project p --root /work '--raio-managed'",
            "raio-hook.exe claude --project p --root '/work/--raio-managed'",
            "raio-hook.exe claude --project --raio-managed --root /work --raio-managed",
            "raio-hook.exe claude --project p --root /work --raio-managed && echo user",
            "raio-hook.exe claude --project p --root /work --raio-managed;",
            "raio-hook.exe claude --project p --root /work --raio-managed extra",
            "raio-hook.exe claude --project p --root '/work --raio-managed",
        ] {
            let handler = json!({ "type": "command", "command": command, "timeout": 12 });
            assert!(!is_raio_handler(&handler), "{command}");
            let user = json!({ "hooks": { "Stop": [{ "hooks": [handler] }] } });
            assert_eq!(without_raio(user.clone()), user, "{command}");
        }
        assert!(!is_raio_handler(&json!({ "type": "prompt", "command": CMD })));
    }

    #[test]
    fn ownership_removes_both_historical_raio_command_shapes() {
        let current = hook_command(Path::new("C:/Program Files/Raio/raio-hook.exe"), "old-id", Path::new("C:/it's $HOME `x`"));
        for command in [
            CMD.to_string(), // 312479d: double-quoted executable and root.
            current, // d4f93d6 onward: single quotes with POSIX apostrophe escaping.
            hook_command(Path::new("/opt/Raio/raio-hook"), "project-id", Path::new("/work/app")),
        ] {
            let handler = json!({ "type": "command", "command": command, "async": true });
            assert!(is_raio_handler(&handler), "{command}");
            let mut original = user_settings();
            original["hooks"]["PostToolUse"][0]["hooks"].as_array_mut().unwrap().push(handler);
            assert_eq!(without_raio(original.clone()), user_settings(), "{command}");
            let updated = with_raio(original, CMD).unwrap();
            assert_eq!(updated, with_raio(user_settings(), CMD).unwrap(), "{command}");
        }
    }

    #[test]
    fn ownership_preserves_a_user_marker_hook_through_connect_reconnect_disconnect() {
        let dir = tempfile::tempdir().unwrap();
        let backups = tempfile::tempdir().unwrap();
        let mut original = user_settings();
        original["hooks"]["PostToolUse"][0]["hooks"].as_array_mut().unwrap()
            .push(json!({ "type": "command", "command": "echo --raio-managed", "timeout": 12 }));
        fs::create_dir_all(dir.path().join(".claude")).unwrap();
        let original_text = serde_json::to_string_pretty(&original).unwrap();
        fs::write(settings_path(dir.path()), &original_text).unwrap();
        for now in [7, 8] {
            let p = preview(dir.path(), CMD).unwrap();
            let after: Value = serde_json::from_str(&p.after).unwrap();
            assert_eq!(after["hooks"]["PostToolUse"][0], original["hooks"]["PostToolUse"][0]);
            connect(dir.path(), CMD, &p, backups.path(), now).unwrap();
        }
        disconnect(dir.path(), backups.path(), 9).unwrap();
        assert_eq!(fs::read_to_string(settings_path(dir.path())).unwrap(), original_text);
        // A second disconnect must leave a user-only file byte-identical and create no backup.
        disconnect(dir.path(), backups.path(), 10).unwrap();
        assert_eq!(fs::read_to_string(settings_path(dir.path())).unwrap(), original_text);
        assert_eq!(fs::read_dir(backups.path()).unwrap().count(), 3);
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
