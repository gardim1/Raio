//! Status-line precedence and explicit project-only opt-in. Global paths are read-only.
use crate::{connect, event::stable_id, usage::State};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub enabled: bool,
    pub replace_existing: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preview {
    pub enabled: bool,
    pub replace_existing: bool,
    pub effective: String,
    pub fingerprint: String,
    pub before: Option<Value>,
    pub after: Option<Value>,
    pub reason: Option<String>,
}
#[derive(Default)]
pub struct Layers {
    pub user: Option<PathBuf>,
    pub managed: Option<PathBuf>,
    /// Raio-owned hashes of the exact installed entry; injected with the settings paths in tests.
    pub receipts: Option<PathBuf>,
}
impl Layers {
    pub fn discover() -> Self {
        // Unit tests must inject disposable layer paths, never discover the owner's settings.
        #[cfg(test)]
        {
            Self::default()
        }
        #[cfg(not(test))]
        {
            let config = std::env::var_os("CLAUDE_CONFIG_DIR")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                        .map(|p| PathBuf::from(p).join(".claude"))
                });
            let managed = if cfg!(windows) {
                std::env::var_os("ProgramFiles")
                    .map(|p| PathBuf::from(p).join("ClaudeCode/managed-settings.json"))
            } else if cfg!(target_os = "macos") {
                Some(PathBuf::from(
                    "/Library/Application Support/ClaudeCode/managed-settings.json",
                ))
            } else {
                Some(PathBuf::from("/etc/claude-code/managed-settings.json"))
            };
            Self {
                user: config.map(|p| p.join("settings.json")),
                managed,
                receipts: crate::paths::data_dir().map(|p| p.join("backups")),
            }
        }
    }
}
#[derive(Deserialize)]
struct StatusKey {
    #[serde(rename = "statusLine")]
    status_line: Option<Value>,
}
fn read_key(path: &Path) -> Result<Option<Value>, String> {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot inspect status line settings.".into()),
    };
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot inspect status line settings.")?;
    if bytes.len() > 1024 * 1024 {
        return Err("Status line settings exceed the inspection limit.".into());
    }
    // Serde skips every other key with IgnoredAny; no env, permissions or credentials enter a Value.
    serde_json::from_slice::<StatusKey>(&bytes)
        .map(|k| k.status_line)
        .map_err(|_| "Cannot inspect status line settings JSON.".into())
}
pub fn owned(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.len() != 2 || value["type"] != "command" {
        return false;
    }
    let Some(command) = value["command"].as_str() else {
        return false;
    };
    connect::owned_command(command, "statusline")
}
pub fn receipt_path(root: &Path, backups: &Path) -> PathBuf {
    backups.join(format!(
        "statusline-{}.receipt",
        stable_id(&[&root.to_string_lossy()])
    ))
}
pub fn receipt_matches(root: &Path, backups: &Path, value: &Value) -> bool {
    if !owned(value) {
        return false;
    }
    let Ok(file) = fs::File::open(receipt_path(root, backups)) else {
        return false;
    };
    let mut stored = String::new();
    file.take(33).read_to_string(&mut stored).is_ok() && stored == entry_hash(value)
}
fn entry_hash(value: &Value) -> String {
    stable_id(&["raio-statusline", value["command"].as_str().unwrap_or("")])
}
pub fn save_receipt(root: &Path, backups: &Path, value: Option<&Value>) -> Result<(), String> {
    let path = receipt_path(root, backups);
    if let Some(v) = value.filter(|v| owned(v)) {
        fs::create_dir_all(backups).map_err(|_| "Could not save status line ownership receipt")?;
        crate::paths::write_atomic(&path, entry_hash(v).as_bytes())
            .map_err(|_| "Could not save status line ownership receipt")?;
    } else {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Could not remove status line ownership receipt".into()),
        }
    }
    Ok(())
}
fn owned_local(root: &Path, value: &Value, layers: &Layers) -> bool {
    owned(value)
        && layers
            .receipts
            .as_ref()
            .is_none_or(|dir| receipt_matches(root, dir, value))
}
pub fn command(hook_command: &str) -> String {
    hook_command.replacen(" claude ", " statusline ", 1)
}
fn entry(hook_command: &str) -> Value {
    json!({"type":"command", "command":command(hook_command)})
}
/// A previously started Claude session may still invoke its saved command after Disconnect.
/// Only inspect its project-local key here; the hook never reads user or managed settings.
pub fn reader_enabled(root: &Path, expected_hook: &str) -> bool {
    read_key(&connect::settings_path(root))
        .ok()
        .flatten()
        .is_some_and(|v| v == entry(expected_hook))
}
pub fn remove_owned(settings: &mut Value) {
    if settings.get("statusLine").is_some_and(owned)
        && let Some(object) = settings.as_object_mut()
    {
        object.shift_remove("statusLine");
    }
}
fn effective(
    root: &Path,
    local: &Value,
    layers: &Layers,
) -> Result<(String, Option<Value>), String> {
    if let Some(managed) = &layers.managed {
        match fs::metadata(managed) {
            Ok(_) => return Ok(("managed".into(), None)), // Presence only; do not read policy contents.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Cannot check managed settings presence.".into()),
        }
    }
    if let Some(v) = local.get("statusLine").filter(|v| !v.is_null()) {
        return Ok((
            if owned_local(root, v, layers) {
                "raio"
            } else {
                "project-local"
            }
            .into(),
            Some(v.clone()),
        ));
    }
    if let Some(v) = read_key(&root.join(".claude/settings.json"))? {
        return Ok(("shared-project".into(), Some(v)));
    }
    if let Some(user) = &layers.user
        && let Some(v) = read_key(user)?
    {
        return Ok(("user".into(), Some(v)));
    }
    Ok(("none".into(), None))
}
pub fn preview(
    root: &Path,
    local: &Value,
    hook: &str,
    options: Option<Options>,
    layers: &Layers,
) -> Preview {
    let (effective, found, inspection_error) = match effective(root, local, layers) {
        Ok((level, value)) => (level, value, None),
        Err(reason) => ("unavailable".into(), None, Some(reason)),
    };
    let options = options.unwrap_or(Options {
        enabled: effective == "raio",
        replace_existing: false,
    });
    let conflict = !matches!(effective.as_str(), "none" | "raio");
    let reason = inspection_error
        .or_else(|| {
            (effective == "managed")
                .then(|| "Managed Claude settings prevent a project status line override.".into())
        })
        .or_else(|| {
            (options.enabled && conflict && !options.replace_existing).then(|| {
                "An existing status line needs explicit project-only replacement consent.".into()
            })
        });
    let install = options.enabled && reason.is_none();
    let before = local.get("statusLine").cloned();
    let after = if install {
        Some(entry(hook))
    } else if before
        .as_ref()
        .is_some_and(|v| owned_local(root, v, layers))
        && !options.enabled
    {
        None
    } else {
        before.clone()
    };
    Preview {
        enabled: options.enabled,
        replace_existing: options.replace_existing,
        fingerprint: stable_id(&[&effective, &json!(found).to_string()]),
        effective,
        before,
        after,
        reason,
    }
}
pub fn apply(settings: &mut Value, preview: &Preview) -> Result<(), String> {
    if preview.enabled
        && let Some(reason) = &preview.reason
    {
        return Err(reason.clone());
    }
    let object = settings
        .as_object_mut()
        .ok_or("Settings must be an object")?;
    match &preview.after {
        Some(v) => {
            object.insert("statusLine".into(), v.clone());
        }
        None => {
            object.shift_remove("statusLine");
        }
    }
    Ok(())
}
pub fn configuration(root: &Path, expected_hook: &str, layers: &Layers) -> State {
    let local = match read_key(&connect::settings_path(root)) {
        Ok(Some(v)) => json!({"statusLine":v}),
        Ok(None) => json!({}),
        Err(reason) => return State::Error { reason },
    };
    let p = preview(root, &local, expected_hook, None, layers);
    if p.effective == "managed" || p.effective == "unavailable" {
        return State::Incompatible {
            reason: p
                .reason
                .unwrap_or_else(|| "Status line unavailable.".into()),
        };
    }
    if p.effective != "raio" {
        return State::Disabled;
    }
    if p.before != Some(entry(expected_hook)) {
        return State::Incompatible {
            reason: "Raio's status line command is outdated. Reconnect this project.".into(),
        };
    }
    State::Waiting
}

#[cfg(test)]
mod tests {
    use super::*;
    const CMD: &str =
        "'C:/Raio/raio-hook.exe' claude --project p --root 'C:/fixture' --raio-managed";
    fn put(path: &Path, value: Value) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, value.to_string()).unwrap();
    }
    #[test]
    fn precedence_default_no_replacement_and_only_statusline_key_is_retained() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        fs::create_dir_all(&root).unwrap();
        let user = dir.path().join("user/settings.json");
        let managed = dir.path().join("managed.json");
        let layers = Layers {
            user: Some(user.clone()),
            managed: Some(managed.clone()),
            receipts: None,
        };
        let mine = json!({"type":"command","command":"my-status"});
        put(
            &user,
            json!({"env":{"SECRET":"do-not-retain"},"statusLine":mine}),
        );
        let original = fs::read(&user).unwrap();
        for (local, level) in [
            (json!({}), "user"),
            (json!({"statusLine":mine}), "project-local"),
        ] {
            let p = preview(&root, &local, CMD, None, &layers);
            assert_eq!(p.effective, level);
            assert!(!p.enabled);
            assert_eq!(p.before, p.after);
            let p = preview(
                &root,
                &local,
                CMD,
                Some(Options {
                    enabled: true,
                    replace_existing: false,
                }),
                &layers,
            );
            assert!(p.reason.is_some());
            let p = preview(
                &root,
                &local,
                CMD,
                Some(Options {
                    enabled: true,
                    replace_existing: true,
                }),
                &layers,
            );
            assert!(p.reason.is_none());
            assert_eq!(p.after, Some(entry(CMD)));
            assert!(!serde_json::to_string(&p).unwrap().contains("do-not-retain"));
        }
        put(
            &root.join(".claude/settings.json"),
            json!({"statusLine":mine}),
        );
        assert_eq!(
            preview(&root, &json!({}), CMD, None, &layers).effective,
            "shared-project"
        );
        fs::write(&managed, "not even JSON: presence only").unwrap();
        let p = preview(
            &root,
            &json!({"statusLine":entry(CMD)}),
            CMD,
            Some(Options {
                enabled: true,
                replace_existing: true,
            }),
            &layers,
        );
        assert_eq!(p.effective, "managed");
        assert!(p.reason.is_some());
        assert!(
            !preview(&root, &json!({"statusLine":entry(CMD)}), CMD, None, &layers).enabled,
            "managed settings must leave a hooks-only connection available by default"
        );
        assert_eq!(fs::read(&user).unwrap(), original);
    }
    #[test]
    fn reconnect_updates_ours_and_foreign_or_changed_entries_are_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let old = json!({"statusLine":entry(CMD)});
        let new = CMD.replace("C:/Raio/", "C:/New Raio/");
        let p = preview(dir.path(), &old, &new, None, &Layers::default());
        assert!(p.enabled);
        assert_eq!(p.effective, "raio");
        assert_eq!(p.after, Some(entry(&new)));
        let mut settings = old.clone();
        apply(&mut settings, &p).unwrap();
        remove_owned(&mut settings);
        assert_eq!(settings, json!({}));
        let mut changed = old;
        changed["statusLine"]["command"] = json!(format!("{} extra", command(CMD)));
        let original = changed.clone();
        remove_owned(&mut changed);
        assert_eq!(changed, original);
    }

    #[test]
    fn exact_receipt_allows_reconnect_but_user_edits_require_explicit_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let backups = dir.path().join("receipts");
        let layers = Layers {
            receipts: Some(backups.clone()),
            ..Layers::default()
        };
        let mut value = json!({"statusLine":entry(CMD)});
        save_receipt(dir.path(), &backups, value.get("statusLine")).unwrap();
        let p = preview(
            dir.path(),
            &value,
            &CMD.replace("C:/Raio", "C:/NewRaio"),
            None,
            &layers,
        );
        assert_eq!(p.effective, "raio");
        assert!(p.enabled);
        value["statusLine"]["command"] =
            json!(command(&CMD.replace("--project p", "--project changed")));
        let p = preview(dir.path(), &value, CMD, None, &layers);
        assert_eq!(p.effective, "project-local");
        assert!(!p.enabled);
        assert_eq!(p.before, p.after);
        assert!(!receipt_matches(dir.path(), &backups, &value["statusLine"]));
        let p = preview(
            dir.path(),
            &value,
            CMD,
            Some(Options {
                enabled: true,
                replace_existing: false,
            }),
            &layers,
        );
        assert!(p.reason.is_some());
    }
}
