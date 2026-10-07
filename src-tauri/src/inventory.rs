//! Whole-project inventory (`project_inventory`): which files exist and which technologies the
//! dependency manifests *name*. Rust reports facts only; what they mean (areas, hints) is decided in the
//! renderer. Manifest facts are names, never values or versions, and only a fixed list of manifest files is
//! ever opened (never `.env*`, keys or certificates). Nothing is written to disk.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::rc::Rc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ignore::gitignore::Gitignore;
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::core::Core;
use crate::imports::{is_cloud_placeholder, list_entries, Entry, MAX_DEPTH};
use crate::watch::Filter;

pub const MAX_FILES: usize = 20_000;
pub const BUDGET: Duration = Duration::from_secs(2);
pub const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
pub const MAX_MANIFESTS: usize = 200;

/// Bounds of one inventory.
#[derive(Clone, Debug)]
pub struct Limits {
    pub max_files: usize,
    pub budget: Duration,
    pub max_manifest_bytes: u64,
    pub max_manifests: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { max_files: MAX_FILES, budget: BUDGET, max_manifest_bytes: MAX_MANIFEST_BYTES, max_manifests: MAX_MANIFESTS }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Npm,
    Python,
    Go,
    Rust,
    Compose,
    Prisma,
}

pub type Facts = BTreeMap<String, Vec<String>>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub path: String,
    pub kind: Kind,
    pub facts: Facts,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    pub files: Vec<String>,
    pub truncated: bool,
    pub skipped: usize,
    pub scanned_at_ms: i64,
    pub manifests: Vec<Manifest>,
}

/* which files are manifests ------------------------------------------------ */

/// The only files this module ever opens. Anything else (`.env*`, keys, certificates, lockfiles, source)
/// is listed by name at most and never read.
fn manifest_kind(name: &str) -> Option<Kind> {
    let lower = name.to_ascii_lowercase();
    match lower.as_str() {
        "package.json" => return Some(Kind::Npm),
        "pyproject.toml" => return Some(Kind::Python),
        "go.mod" => return Some(Kind::Go),
        "cargo.toml" => return Some(Kind::Rust),
        "schema.prisma" => return Some(Kind::Prisma),
        _ => {}
    }
    // `requirements.txt`, `requirements-dev.txt`, `compose.prod.yaml`, `docker-compose.override.yml`, ...
    let variant = |prefix: &str, exts: &[&str]| {
        let rest = lower.strip_prefix(prefix)?;
        let stem = exts.iter().find_map(|ext| rest.strip_suffix(ext))?;
        (stem.is_empty() || stem.starts_with(['-', '_', '.'])).then_some(())
    };
    if variant("requirements", &[".txt"]).is_some() {
        Some(Kind::Python)
    } else if variant("docker-compose", &[".yml", ".yaml"]).or_else(|| variant("compose", &[".yml", ".yaml"])).is_some() {
        Some(Kind::Compose)
    } else {
        None
    }
}

/* names -------------------------------------------------------------------- */

/// Most names reported per list, and longest name: anything beyond is noise or abuse.
const MAX_NAMES: usize = 1_000;
const MAX_NAME_BYTES: usize = 256;

/// An ordered set of names, bounded and without control characters.
#[derive(Default)]
struct Names {
    list: Vec<String>,
    seen: HashSet<String>,
}

impl Names {
    fn add(&mut self, name: &str) {
        if self.list.len() >= MAX_NAMES || name.is_empty() || name.len() > MAX_NAME_BYTES || name.chars().any(char::is_control) {
            return;
        }
        if self.seen.insert(name.to_string()) {
            self.list.push(name.to_string());
        }
    }
}

fn put(facts: &mut Facts, key: &str, names: Names) {
    if !names.list.is_empty() {
        facts.insert(key.to_string(), names.list);
    }
}

/// The scan deadline is looked at once per this many lines of a manifest (a clock read per line would dominate).
const BUDGET_CHECK_EVERY: u32 = 256;

/// Counts the lines of a manifest being read and says when the scan deadline has passed.
struct Budget {
    deadline: Instant,
    ticks: u32,
}

impl Budget {
    fn new(deadline: Instant) -> Self {
        Budget { deadline, ticks: 0 }
    }

    fn over(&mut self) -> bool {
        self.ticks = self.ticks.wrapping_add(1);
        self.ticks.is_multiple_of(BUDGET_CHECK_EVERY) && Instant::now() >= self.deadline
    }
}

/// Facts of one manifest, from its text. What cannot be understood gives no facts; `None`: the deadline passed
/// while reading it (a manifest of fewer than 256 lines is always finished).
fn facts_of(kind: Kind, text: &str, deadline: Instant) -> Option<Facts> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let budget = &mut Budget::new(deadline);
    match kind {
        Kind::Npm => Some(npm_facts(text)),
        Kind::Python => python_facts(text, budget),
        Kind::Go => go_facts(text, budget),
        Kind::Rust => cargo_facts(text, budget),
        Kind::Compose => compose_facts(text, budget),
        Kind::Prisma => prisma_facts(text, budget),
    }
}

/* npm ---------------------------------------------------------------------- */

fn npm_facts(text: &str) -> Facts {
    let mut facts = Facts::new();
    let Ok(Value::Object(root)) = serde_json::from_str::<Value>(text) else { return facts };
    for key in ["dependencies", "devDependencies", "peerDependencies", "scripts"] {
        if let Some(Value::Object(map)) = root.get(key) {
            let mut names = Names::default();
            map.keys().for_each(|name| names.add(name));
            put(&mut facts, key, names);
        }
    }
    let globs = match root.get("workspaces") {
        Some(Value::Array(list)) => Some(list),
        Some(Value::Object(map)) => map.get("packages").and_then(Value::as_array), // yarn: { packages: [...] }
        _ => None,
    };
    if let Some(list) = globs {
        let mut names = Names::default();
        list.iter().filter_map(Value::as_str).for_each(|glob| names.add(glob));
        put(&mut facts, "workspaces", names);
    }
    facts
}

/* python ------------------------------------------------------------------- */

/// The package name of a requirement (`uvicorn[standard]>=0.29`, `Flask @ https://...`). A line that is
/// an option, a path or a URL has no name (a URL may carry credentials, so it is never looked into).
fn requirement_name(spec: &str) -> Option<&str> {
    let spec = spec.trim();
    let end = spec.find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))).unwrap_or(spec.len());
    let name = &spec[..end];
    if !name.starts_with(|c: char| c.is_ascii_alphanumeric()) {
        return None;
    }
    match spec[end..].chars().next() {
        None => Some(name),
        Some(c) if c.is_whitespace() || matches!(c, '[' | '<' | '>' | '=' | '!' | '~' | ';' | '@' | ',' | '(') => Some(name),
        Some(_) => None,
    }
}

fn python_facts(text: &str, budget: &mut Budget) -> Option<Facts> {
    let mut names = Names::default();
    // `pyproject.toml` has tables; `requirements*.txt` has one requirement per line.
    if text.lines().any(|line| line.trim_start().starts_with('[')) {
        for entry in toml_entries(text, budget)? {
            let section: Vec<&str> = entry.section.iter().map(String::as_str).collect();
            let key: Vec<&str> = entry.key.iter().map(String::as_str).collect();
            match (section.as_slice(), key.as_slice()) {
                (["project"], ["dependencies"]) | (["project", "optional-dependencies"], [_]) | (["dependency-groups"], [_]) => {
                    toml_strings(&entry.value).iter().filter_map(|s| requirement_name(s)).for_each(|n| names.add(n));
                }
                (["tool", "poetry", "dependencies" | "dev-dependencies"], [name, ..]) | (["tool", "poetry", "group", _, "dependencies"], [name, ..]) if *name != "python" => names.add(name),
                _ => {}
            }
        }
    } else {
        for line in text.lines() {
            if budget.over() {
                return None;
            }
            let line = cut_hash_comment(line);
            requirement_name(line).into_iter().for_each(|n| names.add(n));
        }
    }
    let mut facts = Facts::new();
    put(&mut facts, "packages", names);
    Some(facts)
}

/// The line without a `# comment` (a `#` at the start or after whitespace).
fn cut_hash_comment(line: &str) -> &str {
    let mut previous_blank = true;
    for (i, c) in line.char_indices() {
        if c == '#' && previous_blank {
            return &line[..i];
        }
        previous_blank = c.is_whitespace();
    }
    line
}

/* a small TOML reader ------------------------------------------------------ */

/// One `key = value` pair (value as raw text, possibly spanning lines) in its table, or a table header
/// (empty key and value, `section` being the header's path).
struct TomlEntry {
    /// Shared by every pair of the table: a header is stored once, however many pairs follow it.
    section: Rc<[String]>,
    key: Vec<String>,
    value: String,
}

/// Most segments of a dotted table or key path that are kept.
const MAX_SEGMENTS: usize = 16;
/// The only segment of a path deeper than that. No real key is this (TOML keys cannot hold NUL), so a table
/// or key marked with it matches nothing.
const TOO_DEEP: &str = "\u{0}";

/// Where a (possibly multi-line) value ends: tracks brackets, braces and strings across lines.
#[derive(Default)]
struct ValueScan {
    depth: i32,
    triple: Option<u8>,
}

impl ValueScan {
    fn open(&self) -> bool {
        self.depth > 0 || self.triple.is_some()
    }

    fn feed(&mut self, line: &str) {
        let b = line.as_bytes();
        let mut i = 0;
        while i < b.len() {
            if let Some(q) = self.triple {
                if b[i] == q && b.get(i + 1) == Some(&q) && b.get(i + 2) == Some(&q) {
                    self.triple = None;
                    i += 3;
                } else {
                    i += 1;
                }
                continue;
            }
            match b[i] {
                b'#' => break,
                q @ (b'"' | b'\'') => {
                    if b.get(i + 1) == Some(&q) && b.get(i + 2) == Some(&q) {
                        self.triple = Some(q);
                        i += 3;
                    } else {
                        i += 1;
                        while i < b.len() && b[i] != q {
                            i += if q == b'"' && b[i] == b'\\' { 2 } else { 1 };
                        }
                        i += 1;
                    }
                }
                b'[' | b'{' => {
                    self.depth += 1;
                    i += 1;
                }
                b']' | b'}' => {
                    self.depth -= 1;
                    i += 1;
                }
                _ => i += 1,
            }
        }
    }
}

/// `a."b.c".d` -> `["a", "b.c", "d"]`; more than 16 segments -> `[TOO_DEEP]`, without reading the rest.
fn split_dotted(text: &str) -> Vec<String> {
    let (mut parts, mut current, mut quote) = (Vec::new(), String::new(), None);
    for c in text.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => current.push(c),
            (None, '"' | '\'') => quote = Some(c),
            (None, '.') if parts.len() + 1 >= MAX_SEGMENTS => return vec![TOO_DEEP.to_string()],
            (None, '.') => parts.push(std::mem::take(&mut current).trim().to_string()),
            (None, c) => current.push(c),
        }
    }
    parts.push(current.trim().to_string());
    parts
}

/// Byte index of the first `terminator` outside quotes.
fn find_outside_quotes(text: &str, terminator: char) -> Option<usize> {
    let mut quote = None;
    for (i, c) in text.char_indices() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c == terminator => return Some(i),
            None => {}
        }
    }
    None
}

/// `None`: the deadline passed.
fn toml_entries(text: &str, budget: &mut Budget) -> Option<Vec<TomlEntry>> {
    let mut out = Vec::new();
    let mut section: Rc<[String]> = Rc::from(Vec::new());
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        if budget.over() {
            return None;
        }
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            let inner = line.trim_start_matches('[');
            section = split_dotted(&inner[..find_outside_quotes(inner, ']').unwrap_or(inner.len())]).into();
            out.push(TomlEntry { section: Rc::clone(&section), key: Vec::new(), value: String::new() });
            continue;
        }
        let Some(eq) = find_outside_quotes(line, '=') else { continue };
        let mut value = line[eq + 1..].to_string();
        let mut scan = ValueScan::default();
        scan.feed(&value);
        while scan.open() {
            if budget.over() {
                return None;
            }
            let Some(next) = lines.next() else { break };
            value.push('\n');
            value.push_str(next);
            scan.feed(next);
        }
        out.push(TomlEntry { section: Rc::clone(&section), key: split_dotted(&line[..eq]), value });
    }
    Some(out)
}

/// String literals of a value that are not inside an inline table (`["a", {include-group = "b"}, "c"]` -> a, c).
fn toml_strings(value: &str) -> Vec<&str> {
    let (b, mut found, mut braces, mut i) = (value.as_bytes(), Vec::new(), 0i32, 0);
    while i < b.len() {
        match b[i] {
            b'#' => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            q @ (b'"' | b'\'') => {
                let start = i + 1;
                i = start;
                while i < b.len() && b[i] != q && b[i] != b'\n' {
                    i += if q == b'"' && b[i] == b'\\' { 2 } else { 1 };
                }
                if braces == 0 && i < b.len() && b[i] == q {
                    found.push(&value[start..i]);
                }
                i += 1;
            }
            b'{' => {
                braces += 1;
                i += 1;
            }
            b'}' => {
                braces -= 1;
                i += 1;
            }
            _ => i += 1,
        }
    }
    found
}

/* go ----------------------------------------------------------------------- */

fn go_path(text: &str) -> Option<&str> {
    let token = text.split_whitespace().next()?.trim_matches(['"', '`']);
    (!token.is_empty()).then_some(token)
}

fn go_facts(text: &str, budget: &mut Budget) -> Option<Facts> {
    let (mut module, mut require) = (Names::default(), Names::default());
    enum Block {
        None,
        Require,
        Other,
    }
    let mut block = Block::None;
    for raw in text.lines() {
        if budget.over() {
            return None;
        }
        let line = raw.split("//").next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        match block {
            Block::Require | Block::Other if line == ")" => block = Block::None,
            Block::Require => go_path(line).into_iter().for_each(|p| require.add(p)),
            Block::Other => {}
            Block::None => {
                let (word, rest) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
                let rest = rest.trim();
                match word {
                    "module" => go_path(rest).into_iter().for_each(|p| module.add(p)),
                    "require" if rest == "(" => block = Block::Require,
                    "require" => go_path(rest).into_iter().for_each(|p| require.add(p)),
                    _ if rest == "(" => block = Block::Other,
                    _ => {}
                }
            }
        }
    }
    let mut facts = Facts::new();
    put(&mut facts, "module", module);
    put(&mut facts, "require", require);
    Some(facts)
}

/* rust --------------------------------------------------------------------- */

/// Whether a section path is a dependency table: `Some(None)` for `[dependencies]` (also dev, build, workspace
/// and `target.*` variants), `Some(Some(name))` for `[dependencies.name]`.
fn cargo_table<'a>(section: &[&'a str]) -> Option<Option<&'a str>> {
    let rest = match section {
        ["target", _, rest @ ..] | ["workspace", rest @ ..] => rest,
        rest => rest,
    };
    match rest {
        ["dependencies" | "dev-dependencies" | "build-dependencies"] => Some(None),
        ["dependencies" | "dev-dependencies" | "build-dependencies", name] => Some(Some(*name)),
        _ => None,
    }
}

fn cargo_facts(text: &str, budget: &mut Budget) -> Option<Facts> {
    let (mut dependencies, mut members) = (Names::default(), Names::default());
    for entry in toml_entries(text, budget)? {
        let section: Vec<&str> = entry.section.iter().map(String::as_str).collect();
        match (cargo_table(&section), entry.key.first()) {
            (Some(Some(name)), None) => dependencies.add(name),
            (Some(None), Some(name)) => dependencies.add(name),
            _ if section == ["workspace"] && entry.key == ["members"] => toml_strings(&entry.value).into_iter().for_each(|m| members.add(m)),
            _ => {}
        }
    }
    let mut facts = Facts::new();
    put(&mut facts, "dependencies", dependencies);
    put(&mut facts, "members", members);
    Some(facts)
}

/* compose ------------------------------------------------------------------ */

/// The line without a trailing `# comment` (outside quotes, after whitespace).
fn cut_yaml_comment(line: &str) -> &str {
    let (mut quote, mut previous_blank) = (None, true);
    for (i, c) in line.char_indices() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c == '#' && previous_blank => return &line[..i],
            None => {}
        }
        previous_blank = c.is_whitespace();
    }
    line
}

/// `key: rest` of a YAML mapping line whose key is a plain name (`[A-Za-z0-9._-]+`, optionally quoted).
fn yaml_key(body: &str) -> Option<(&str, &str)> {
    let (key, rest) = match body.chars().next()? {
        q @ ('"' | '\'') => {
            let close = body[1..].find(q)? + 1;
            (&body[1..close], body[close + 1..].strip_prefix(':')?)
        }
        _ => {
            let colon = body.char_indices().find(|&(i, c)| c == ':' && body[i + 1..].chars().next().is_none_or(char::is_whitespace))?.0;
            (&body[..colon], &body[colon + 1..])
        }
    };
    let plain = !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    plain.then_some((key, rest.trim()))
}

/// The name of an image: the last segment of its repository path, without registry, credentials, tag or
/// digest (`user:pw@registry:5000/team/web:1` -> `web`). A variable gives nothing.
fn image_name(value: &str) -> Option<&str> {
    let value = value.trim();
    let value = ['"', '\''].iter().find_map(|q| value.strip_prefix(*q)?.strip_suffix(*q)).unwrap_or(value);
    // A digest follows the last `@` and holds no `/`; credentials come before an `@` that is followed by a path.
    let value = match value.rsplit_once('@') {
        Some((before, after)) if !after.contains('/') => before,
        _ => value,
    };
    let value = value.rsplit_once('@').map_or(value, |(_, after)| after);
    let name = value.rsplit('/').next()?.split(':').next()?;
    (!name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))).then_some(name)
}

fn compose_facts(text: &str, budget: &mut Budget) -> Option<Facts> {
    let (mut services, mut images) = (Names::default(), Names::default());
    let (mut in_services, mut service_indent, mut field_indent) = (false, None, None);
    for raw in text.lines() {
        if budget.over() {
            return None;
        }
        let line = cut_yaml_comment(raw).trim_end();
        let body = line.trim_start();
        if body.is_empty() || body == "---" {
            continue;
        }
        let indent = line.len() - body.len();
        if line[..indent].contains('\t') {
            continue; // YAML does not allow tabs to indent: not read
        }
        if indent == 0 {
            in_services = matches!(yaml_key(body), Some(("services", _)));
            (service_indent, field_indent) = (None, None);
            continue;
        }
        if !in_services {
            continue;
        }
        let service_at = *service_indent.get_or_insert(indent);
        if indent < service_at {
            in_services = false;
        } else if indent == service_at {
            field_indent = None;
            if let Some((name, _)) = yaml_key(body) {
                services.add(name);
            }
        } else {
            let field_at = *field_indent.get_or_insert(indent);
            if indent == field_at && let Some(("image", value)) = yaml_key(body) {
                image_name(value).into_iter().for_each(|image| images.add(image));
            }
        }
    }
    let mut facts = Facts::new();
    put(&mut facts, "services", services);
    put(&mut facts, "images", images);
    Some(facts)
}

/* prisma ------------------------------------------------------------------- */

/// The line without a `// comment` (outside quotes: a connection string holds `//`).
fn cut_slash_comment(line: &str) -> &str {
    let (mut quote, mut previous_slash) = (None, false);
    for (i, c) in line.char_indices() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '"' => quote = Some(c),
            None if c == '/' && previous_slash => return &line[..i - 1],
            None => {}
        }
        previous_slash = quote.is_none() && c == '/';
    }
    line
}

/// Opening minus closing braces of a line, outside strings.
fn brace_delta(line: &str) -> i32 {
    let mut quote = false;
    line.chars()
        .map(|c| match c {
            '"' => {
                quote = !quote;
                0
            }
            '{' if !quote => 1,
            '}' if !quote => -1,
            _ => 0,
        })
        .sum()
}

fn prisma_facts(text: &str, budget: &mut Budget) -> Option<Facts> {
    let (mut providers, mut models) = (Names::default(), Names::default());
    #[derive(PartialEq)]
    enum Block {
        Datasource,
        Other,
    }
    let (mut depth, mut block) = (0i32, Block::Other);
    for raw in text.lines() {
        if budget.over() {
            return None;
        }
        let line = cut_slash_comment(raw).trim();
        if depth == 0 {
            let mut words = line.split_whitespace();
            match words.next() {
                Some("datasource") => block = Block::Datasource,
                Some("model") => {
                    block = Block::Other;
                    let name = words.next().unwrap_or("").split('{').next().unwrap_or("");
                    if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                        models.add(name);
                    }
                }
                // The `{` of a header may sit on a line of its own: it belongs to the header above.
                Some(word) if word.starts_with('{') => {}
                Some(_) => block = Block::Other,
                None => {}
            }
        } else if depth == 1 && block == Block::Datasource && let Some(value) = line.strip_prefix("provider").map(str::trim_start).and_then(|rest| rest.strip_prefix('=')) {
            // `provider = "postgresql"`: a quoted literal; `env("X")` or anything else is not a provider name.
            if let Some(quoted) = value.trim().strip_prefix('"').and_then(|v| v.split_once('"')) {
                providers.add(quoted.0);
            }
        }
        depth = (depth + brace_delta(line)).max(0);
    }
    let mut facts = Facts::new();
    put(&mut facts, "provider", providers);
    put(&mut facts, "models", models);
    Some(facts)
}

/* walk --------------------------------------------------------------------- */

struct Walk<'a> {
    limits: &'a Limits,
    filter: Filter,
    deadline: Instant,
    files: Vec<String>,
    manifests: Vec<Manifest>,
    skipped: usize,
    truncated: bool,
    /// The `.gitignore` rules of the directories above the one being listed, from the root down. Carried down
    /// the walk, so judging an entry costs no filesystem access of its own.
    rules: Vec<Gitignore>,
}

impl Walk<'_> {
    fn dir(&mut self, abs: &Path, rel: &str, depth: usize) {
        let entries = list_entries(abs, &mut self.skipped, |_, _| true);
        let inherited = self.rules.len();
        // The listing says whether this folder has a `.gitignore`: it is read once, here.
        if entries.iter().any(|e| e.name == ".gitignore" && e.kind.is_file())
            && let Some(rules) = self.filter.rules_for(abs)
        {
            self.rules.push(rules);
        }
        for entry in entries {
            if self.truncated {
                break;
            }
            if Instant::now() >= self.deadline {
                self.truncated = true;
                break;
            }
            self.visit(abs, rel, depth, entry);
        }
        self.rules.truncate(inherited);
    }

    fn visit(&mut self, abs: &Path, rel: &str, depth: usize, entry: Entry) {
        let Entry { name, kind, attributes, len } = entry;
        if kind.is_symlink() || !(kind.is_dir() || kind.is_file()) {
            return;
        }
        // An online-only OneDrive placeholder would be downloaded by reading it (or listing the folder).
        if is_cloud_placeholder(attributes) {
            self.skipped += 1;
            return;
        }
        // Same verdict as `Filter::ignored`, whose folder checks already held for every ancestor of this entry.
        // `is_noise` takes the project-relative path, exactly as `Filter::ignored` does (a folder named like the
        // `outside-project` marker deeper in the tree is not noise).
        let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        if Filter::is_noise(&child) || Filter::gitignored(&self.rules, &abs.join(&name), kind.is_dir()) {
            return;
        }
        if kind.is_dir() {
            if depth >= MAX_DEPTH {
                self.truncated = true;
                return;
            }
            self.dir(&abs.join(&name), &child, depth + 1);
        } else {
            self.file(&abs.join(&name), child, &name, len);
        }
    }

    fn file(&mut self, abs: &Path, rel: String, name: &str, len: u64) {
        if self.files.len() >= self.limits.max_files {
            self.truncated = true;
            return;
        }
        self.files.push(rel.clone());
        let Some(kind) = manifest_kind(name) else { return };
        if self.manifests.len() >= self.limits.max_manifests {
            self.skipped += 1;
            return;
        }
        let facts = self.read_facts(abs, kind, len);
        self.manifests.push(Manifest { path: rel, kind, facts });
    }

    /// Facts of a manifest; none when it is too big, unreadable or not understood. The read is bounded even if
    /// the file grew since the listing. Out of time while parsing: no facts, and the scan is truncated.
    fn read_facts(&mut self, abs: &Path, kind: Kind, len: u64) -> Facts {
        let cap = self.limits.max_manifest_bytes;
        if len > cap {
            return Facts::new();
        }
        let mut bytes = Vec::new();
        let read = fs::File::open(abs).and_then(|f| f.take(cap + 1).read_to_end(&mut bytes));
        if read.is_err() || bytes.len() as u64 > cap {
            return Facts::new();
        }
        facts_of(kind, &String::from_utf8_lossy(&bytes), self.deadline).unwrap_or_else(|| {
            self.truncated = true;
            Facts::new()
        })
    }
}

/// Walks `root` the way the watcher does (nested `.gitignore` files and the always-ignored folders), lists
/// every file and reads the names out of the dependency manifests. Stops at the file or time cap and says so.
pub fn scan(root: &Path, limits: &Limits) -> Result<Inventory, String> {
    if !root.is_dir() {
        return Err("project folder not found".into());
    }
    let mut walk = Walk { limits, filter: Filter::new(root), deadline: Instant::now() + limits.budget, files: Vec::new(), manifests: Vec::new(), skipped: 0, truncated: false, rules: Vec::new() };
    walk.dir(root, "", 0);
    walk.files.sort();
    walk.manifests.sort_by(|a, b| a.path.cmp(&b.path));
    let scanned_at_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    Ok(Inventory { files: walk.files, truncated: walk.truncated, skipped: walk.skipped, scanned_at_ms, manifests: walk.manifests })
}

/// The renderer's entry point. Async with the walk on the blocking pool: it never runs on the UI thread.
#[tauri::command]
pub async fn project_inventory(core: State<'_, Core>, project_id: String) -> Result<Inventory, String> {
    let root = core.connected_root(&project_id)?;
    tauri::async_runtime::spawn_blocking(move || scan(&root, &Limits::default())).await.map_err(|e| e.to_string())?
}

/// The command's work without the Tauri state: the connected project's root, then the scan.
#[cfg(test)]
fn inventory_for(core: &Core, project_id: &str, limits: &Limits) -> Result<Inventory, String> {
    scan(&core.connected_root(project_id)?, limits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::fs;
    use std::time::Instant;

    use crate::watch::Filter;

    fn far() -> Instant {
        Instant::now() + Duration::from_secs(3600)
    }

    /// Facts with no practical deadline.
    fn facts_of(kind: Kind, text: &str) -> Facts {
        super::facts_of(kind, text, far()).expect("far deadline")
    }

    fn facts(kind: Kind, text: &str) -> Value {
        serde_json::to_value(facts_of(kind, text)).unwrap()
    }

    fn write(root: &Path, rel: &str, body: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    fn unhurried() -> Limits {
        Limits { budget: Duration::from_secs(60), ..Limits::default() }
    }

    fn files(inv: &Inventory) -> Vec<&str> {
        inv.files.iter().map(String::as_str).collect()
    }

    fn manifest<'a>(inv: &'a Inventory, path: &str) -> &'a Manifest {
        inv.manifests.iter().find(|m| m.path == path).unwrap_or_else(|| panic!("no manifest {path}: {:?}", inv.manifests.iter().map(|m| &m.path).collect::<Vec<_>>()))
    }

    /* which files are manifests -------------------------------------------- */

    #[test]
    fn only_the_listed_manifest_files_are_recognised() {
        for (name, kind) in [
            ("package.json", Kind::Npm),
            ("pyproject.toml", Kind::Python),
            ("requirements.txt", Kind::Python),
            ("requirements-dev.txt", Kind::Python),
            ("requirements_test.txt", Kind::Python),
            ("go.mod", Kind::Go),
            ("Cargo.toml", Kind::Rust),
            ("docker-compose.yml", Kind::Compose),
            ("docker-compose.override.yaml", Kind::Compose),
            ("compose.yml", Kind::Compose),
            ("compose.prod.yaml", Kind::Compose),
            ("schema.prisma", Kind::Prisma),
        ] {
            assert_eq!(manifest_kind(name), Some(kind), "{name}");
        }
        for name in [
            ".env", ".env.local", ".env.production", ".env.example", "server.key", "cert.pem", "id_rsa", "credentials.json", "package-lock.json", "go.sum", "Cargo.lock", "README.md",
            "requirements.txt.bak", "docker-compose.yml.example", "compose.json", "mypackage.json", "package.json5",
        ] {
            assert_eq!(manifest_kind(name), None, "{name} must never be opened");
        }
    }

    /* npm ------------------------------------------------------------------- */

    #[test]
    fn npm_facts_are_dependency_names_workspace_globs_and_script_names_only() {
        let text = r#"{
  "name": "acme", "version": "1.2.3",
  "scripts": { "dev": "next dev --token sk-live-do-not-leak", "build": "next build" },
  "dependencies": { "next": "^14.2.0", "@acme/db": "git+https://user:ghp_secrettoken@github.com/o/r.git", "zod": "*" },
  "devDependencies": { "typescript": "^5.4.0" },
  "peerDependencies": { "react": ">=18" },
  "workspaces": ["apps/*", "packages/*"]
}"#;
        let got = facts(Kind::Npm, text);
        assert_eq!(got, json!({ "dependencies": ["next", "@acme/db", "zod"], "devDependencies": ["typescript"], "peerDependencies": ["react"], "workspaces": ["apps/*", "packages/*"], "scripts": ["dev", "build"] }));
        let flat = got.to_string();
        assert!(!flat.contains("sk-live") && !flat.contains("ghp_") && !flat.contains("^14") && !flat.contains("1.2.3"), "{flat}");
    }

    #[test]
    fn npm_workspaces_may_be_the_yarn_object_form_and_empty_sections_are_left_out() {
        assert_eq!(facts(Kind::Npm, r#"{"workspaces":{"packages":["a/*","b"]},"dependencies":{},"scripts":{}}"#), json!({ "workspaces": ["a/*", "b"] }));
        assert_eq!(facts(Kind::Npm, "\u{feff}{\"scripts\":{\"x\":\"y\"}}"), json!({ "scripts": ["x"] }), "a byte order mark is tolerated");
    }

    #[test]
    fn npm_with_unexpected_shapes_or_broken_json_gives_empty_facts() {
        assert_eq!(facts(Kind::Npm, r#"{"dependencies":["next"],"scripts":"build","workspaces":5,"devDependencies":null,"peerDependencies":[]}"#), json!({}));
        for broken in ["", "{", r#"{"dependencies": "#, "[]", "null", "not json at all"] {
            assert_eq!(facts(Kind::Npm, broken), json!({}), "{broken:?}");
        }
    }

    #[test]
    fn a_manifest_reports_at_most_a_thousand_names_each_at_most_256_bytes() {
        let deps: Vec<String> = (0..1_500).map(|i| format!("\"p{i}\":\"1\"")).collect();
        let long = "x".repeat(257);
        let fine = "y".repeat(256);
        let text = format!("{{\"dependencies\":{{{},\"{long}\":\"1\",\"{fine}\":\"1\"}}}}", deps.join(","));
        let got = facts_of(Kind::Npm, &text);
        let names = &got["dependencies"];
        assert_eq!(names.len(), 1_000);
        assert_eq!(names[0], "p0");
        assert!(!names.contains(&long));
        let small = facts_of(Kind::Npm, &format!("{{\"dependencies\":{{\"{long}\":\"1\",\"{fine}\":\"1\"}}}}"));
        assert_eq!(small["dependencies"], [fine]);
    }

    /* python ---------------------------------------------------------------- */

    #[test]
    fn requirements_are_package_names_without_specifiers_extras_urls_or_options() {
        let text = "# production\nDjango>=5.0\npsycopg[binary]>=3.1  # driver\n-r base.txt\n--index-url https://user:pw-secret@example.com/simple\n\
git+https://user:tok-secret@github.com/o/r.git#egg=thing\nhttps://example.com/x.whl\nnumpy==1.26 ; python_version >= \"3.9\"\nFlask @ https://host/flask.zip\n-e .\n\n   \nPillow\r\nrequests~=2.31\n";
        let got = facts(Kind::Python, text);
        assert_eq!(got, json!({ "packages": ["Django", "psycopg", "numpy", "Flask", "Pillow", "requests"] }));
        assert!(!got.to_string().contains("secret"));
    }

    #[test]
    fn pyproject_pep621_lists_dependencies_and_optional_dependency_groups() {
        let text = r#"[project]
name = "inventory-api"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
  "fastapi>=0.110",
  "uvicorn[standard]>=0.29",  # server
  "sqlalchemy>=2.0",
  "alembic>=1.13",
  "psycopg[binary]>=3.1",
  "pydantic-settings>=2.2",
]

[project.optional-dependencies]
dev = ["pytest>=8.0", "httpx>=0.27"]

[tool.pytest.ini_options]
testpaths = ["tests"]
"#;
        assert_eq!(facts(Kind::Python, text), json!({ "packages": ["fastapi", "uvicorn", "sqlalchemy", "alembic", "psycopg", "pydantic-settings", "pytest", "httpx"] }));
    }

    #[test]
    fn pyproject_poetry_and_dependency_groups_are_read_and_python_itself_is_not_a_package() {
        let text = r#"[tool.poetry.dependencies]
python = "^3.11"
requests = "^2"
django = {version = "^5", extras = ["x"]}

[tool.poetry.group.dev.dependencies]
pytest = "^8"

[dependency-groups]
test = ["coverage>=7", {include-group = "lint"}]
lint = ["ruff"]
"#;
        assert_eq!(facts(Kind::Python, text), json!({ "packages": ["requests", "django", "pytest", "coverage", "ruff"] }));
    }

    #[test]
    fn pyproject_text_inside_multi_line_strings_and_other_sections_is_not_a_dependency() {
        let text = "[project]\ndescription = \"\"\"\nhas [brackets\nand dependencies = [\"fake\"]\n\"\"\"\ndependencies = [\"real>=1\"]\n\n[tool.other]\ndependencies = [\"not-a-dependency\"]\n";
        assert_eq!(facts(Kind::Python, text), json!({ "packages": ["real"] }));
    }

    /* go -------------------------------------------------------------------- */

    #[test]
    fn go_mod_gives_the_module_path_and_required_module_paths_without_versions() {
        let text = "module example.com/orders\n\ngo 1.22\n\nrequire (\n\tgithub.com/go-chi/chi/v5 v5.0.12\n\tgithub.com/jackc/pgx/v5 v5.5.5 // indirect\n)\nrequire golang.org/x/text v0.14.0\nreplace github.com/foo/bar => ../bar\nexclude github.com/bad/mod v1.0.0\n";
        let got = facts(Kind::Go, text);
        assert_eq!(got, json!({ "module": ["example.com/orders"], "require": ["github.com/go-chi/chi/v5", "github.com/jackc/pgx/v5", "golang.org/x/text"] }));
        assert!(!got.to_string().contains("v5.0.12"));
    }

    #[test]
    fn go_mod_accepts_a_quoted_module_path_and_crlf() {
        assert_eq!(facts(Kind::Go, "module \"example.com/q\"\r\nrequire (\r\n\texample.com/a v1.0.0\r\n)\r\n"), json!({ "module": ["example.com/q"], "require": ["example.com/a"] }));
    }

    /* rust ------------------------------------------------------------------ */

    #[test]
    fn cargo_toml_gives_every_dependency_name_in_one_list_and_the_workspace_members() {
        let text = r#"[package]
name = "raio"

[dependencies]
serde = { version = "1.0", features = ["derive"] }
tauri = { version = "2", features = [
  "tray-icon",
] }
ignore = "0.4"
tauri-plugin-dialog.workspace = true

[dev-dependencies]
tempfile = "3"

[build-dependencies]
tauri-build = "2"

[dependencies.sha2]
version = "0.10"

[target.'cfg(windows)'.dependencies]
winapi = "0.3"

[workspace]
members = ["crates/*", "tools/x"]

[workspace.dependencies]
anyhow = "1"
"#;
        assert_eq!(
            facts(Kind::Rust, text),
            json!({
                "dependencies": ["serde", "tauri", "ignore", "tauri-plugin-dialog", "tempfile", "tauri-build", "sha2", "winapi", "anyhow"],
                "members": ["crates/*", "tools/x"]
            })
        );
    }

    /* compose --------------------------------------------------------------- */

    #[test]
    fn compose_gives_service_names_and_image_names_without_tags_digests_or_values() {
        let text = "version: \"3.9\"\nx-common: &common\n  restart: always\nservices:\n  api:\n    build: .\n    image: \"ghcr.io/acme/api:1.2.3\"  # tag\n    environment:\n      DB_PASSWORD: hunter2-secret\n      image: not-an-image\n  postgres:\n    image: postgres:16-alpine\n  cache:\n    image: redis@sha256:abcdef\n  local:\n    image: localhost:5000/team/app:dev\n  dyn:\n    image: ${IMAGE}\nvolumes:\n  data: {}\n  image: nope\n";
        let got = facts(Kind::Compose, text);
        assert_eq!(got, json!({ "services": ["api", "postgres", "cache", "local", "dyn"], "images": ["api", "postgres", "redis", "app"] }));
        assert!(!got.to_string().contains("hunter2"));
    }

    #[test]
    fn an_image_is_named_by_the_last_segment_of_its_repository_path_only() {
        let text = "services:\n  a:\n    image: docker.io/library/postgres:16\n  b:\n    image: user:pass-secret@registry.example.com:5000/team/web:1\n  c:\n    image: registry.example.com/team/img@sha256:abc123\n  d:\n    image: ghcr.io/${ORG}/worker:${TAG}\n  e:\n    image: \"quay.io/x/y/z\"\n  f:\n    image: ${REGISTRY}\n  g:\n    image: bad name\n";
        let got = facts(Kind::Compose, text);
        assert_eq!(got["images"], json!(["postgres", "web", "img", "worker", "z"]));
        let flat = got.to_string();
        assert!(!flat.contains("secret") && !flat.contains("registry") && !flat.contains("docker.io") && !flat.contains("5000"), "{flat}");
    }

    #[test]
    fn compose_with_crlf_tabs_or_no_services_is_read_leniently() {
        assert_eq!(facts(Kind::Compose, "services:\r\n  db:\r\n    image: postgres:16\r\n"), json!({ "services": ["db"], "images": ["postgres"] }));
        assert_eq!(facts(Kind::Compose, "version: '2'\nweb:\n  image: nginx\n"), json!({}), "the old top-level form is not guessed");
        assert_eq!(facts(Kind::Compose, "services:\n\t- broken: [\n"), json!({}));
        assert_eq!(facts(Kind::Compose, ""), json!({}));
    }

    /* prisma ---------------------------------------------------------------- */

    #[test]
    fn prisma_gives_the_datasource_provider_and_model_names_never_the_url() {
        let text = "generator client {\n  provider = \"prisma-client-js\"\n}\n\ndatasource db {\n  provider = \"postgresql\" // engine\n  url      = \"postgres://user:pw-secret@host/db\"\n}\n\nmodel User {\n  id     String  @id\n  model  String\n  orders Order[]\n}\n\nmodel Order {\n  id String @id\n}\n\nenum Role {\n  ADMIN\n}\n";
        let got = facts(Kind::Prisma, text);
        assert_eq!(got, json!({ "provider": ["postgresql"], "models": ["User", "Order"] }));
        assert!(!got.to_string().contains("secret") && !got.to_string().contains("prisma-client-js"));
    }

    #[test]
    fn prisma_accepts_an_opening_brace_on_the_next_line_and_blank_lines_before_it() {
        let text = "generator client\n{\n  provider = \"prisma-client-js\"\n}\n\ndatasource db\n\n// where the data lives\n{\n  provider = \"mysql\"\n  url = env(\"DATABASE_URL\")\n}\n\nmodel User\n{\n  id String @id\n}\nmodel Order {\n  id String @id\n}\n";
        assert_eq!(facts(Kind::Prisma, text), json!({ "provider": ["mysql"], "models": ["User", "Order"] }));
    }

    #[test]
    fn prisma_provider_read_from_the_environment_is_not_a_provider_name() {
        let text = "datasource db {\n  provider = env(\"DB_PROVIDER\")\n  url = env(\"DATABASE_URL\")\n}\nmodel User {\n  id String @id\n}\n";
        assert_eq!(facts(Kind::Prisma, text), json!({ "models": ["User"] }));
    }

    #[test]
    fn deeply_nested_json_gives_empty_facts_instead_of_overflowing() {
        let deep = format!("{{\"dependencies\":{}{}}}", "[".repeat(100_000), "]".repeat(100_000));
        assert_eq!(facts(Kind::Npm, &deep), json!({}));
        let deep_objects = format!("{}1{}", "{\"a\":".repeat(100_000), "}".repeat(100_000));
        assert_eq!(facts(Kind::Npm, &deep_objects), json!({}));
    }

    #[test]
    fn an_unknown_project_is_an_error_at_the_command_seam() {
        let data = tempfile::tempdir().unwrap();
        let core = Core::open_at(data.path()).unwrap();
        assert_eq!(inventory_for(&core, "nope", &Limits::default()).unwrap_err(), "unknown project");
    }

    /* round c: hostile manifests and the cost of walking --------------------- */

    /// Runs `f` on a thread and fails the test (instead of hanging it) when it does not finish in time.
    fn finishes_within<T: Send + 'static>(seconds: u64, f: impl FnOnce() -> T + Send + 'static) -> T {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(f());
        });
        rx.recv_timeout(Duration::from_secs(seconds)).expect("did not finish in bounded time")
    }

    /// A manifest: one table header with `segments` dotted parts, then `entries` pairs below it.
    fn hostile_toml(segments: usize, entries: usize) -> String {
        let header = format!("[{}a]\n", "a.".repeat(segments));
        let pairs: String = (0..entries).map(|i| format!("k{i} = 1\n")).collect();
        format!("{header}{pairs}")
    }

    const HOSTILE_SEGMENTS: usize = 100_000;
    const HOSTILE_ENTRIES: usize = 40_000;

    #[test]
    fn a_huge_dotted_table_header_with_many_pairs_is_read_in_bounded_time_and_gives_nothing() {
        let (python, rust) = finishes_within(20, || {
            let text = hostile_toml(HOSTILE_SEGMENTS, HOSTILE_ENTRIES);
            (facts_of(Kind::Python, &text), facts_of(Kind::Rust, &text))
        });
        assert!(python.is_empty() && rust.is_empty(), "{python:?} {rust:?}");
    }

    #[test]
    fn real_tables_after_a_hostile_header_are_still_read() {
        let text = format!("{}[project]\ndependencies = [\"real>=1\"]\n", hostile_toml(HOSTILE_SEGMENTS, 10));
        assert_eq!(facts(Kind::Python, &text), json!({ "packages": ["real"] }));
        let cargo = format!("{}[dependencies]\nserde = \"1\"\n", hostile_toml(HOSTILE_SEGMENTS, 10));
        assert_eq!(facts(Kind::Rust, &cargo), json!({ "dependencies": ["serde"] }));
    }

    #[test]
    fn the_pairs_of_one_table_share_its_section_instead_of_copying_it() {
        let text = "[dependencies]\na = 1\nb = 1\nc = 1\n[dev-dependencies]\nd = 1\n";
        let entries = toml_entries(text, &mut Budget::new(far())).unwrap();
        let section_of = |key: &str| entries.iter().find(|e| e.key.first().map(String::as_str) == Some(key)).unwrap().section.clone();
        assert!(Rc::ptr_eq(&section_of("a"), &section_of("b")) && Rc::ptr_eq(&section_of("b"), &section_of("c")));
        assert!(!Rc::ptr_eq(&section_of("a"), &section_of("d")));
    }

    #[test]
    fn a_table_path_is_read_up_to_16_segments_and_a_deeper_one_matches_nothing() {
        let path = |n: usize| (0..n).map(|i| format!("s{i}")).collect::<Vec<_>>().join(".");
        let at = |n: usize| toml_entries(&format!("[{}]\nk = 1\n", path(n)), &mut Budget::new(far())).unwrap();
        assert_eq!(at(16)[0].section.len(), 16);
        assert_eq!(*at(17)[0].section, [TOO_DEEP.to_string()], "past the cap the section is a sentinel, not a 17-part path");
        assert_eq!(*at(17)[1].section, [TOO_DEEP.to_string()]);
        let deep_key = toml_entries(&format!("{} = 1\n", path(40)), &mut Budget::new(far())).unwrap();
        assert_eq!(*deep_key[0].key, [TOO_DEEP.to_string()]);
    }

    #[test]
    fn a_passed_deadline_stops_reading_a_big_manifest_and_a_small_one_is_finished() {
        let past = Instant::now() - Duration::from_secs(1);
        let lines = |n: usize, line: &str| line.repeat(n);
        let big: [(Kind, String); 6] = [
            (Kind::Python, lines(5_000, "requests\n")),
            (Kind::Python, format!("[project]\n{}", lines(5_000, "a = 1\n"))),
            (Kind::Rust, format!("[dependencies]\n{}", lines(5_000, "a = 1\n"))),
            (Kind::Go, format!("module m\nrequire (\n{})\n", lines(5_000, "example.com/a v1\n"))),
            (Kind::Compose, format!("services:\n{}", lines(3_000, "  s:\n    image: x\n"))),
            (Kind::Prisma, lines(5_000, "model A {\n}\n")),
        ];
        for (kind, text) in &big {
            assert_eq!(super::facts_of(*kind, text, past), None, "{kind:?}");
            assert!(super::facts_of(*kind, text, far()).is_some(), "{kind:?}");
        }
        assert_eq!(super::facts_of(Kind::Python, "django\nflask\n", past).unwrap()["packages"], ["django", "flask"]);
    }

    #[test]
    fn a_manifest_that_runs_out_of_time_marks_the_scan_truncated_and_keeps_its_path() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "requirements.txt", &"requests\n".repeat(5_000));
        let limits = Limits::default();
        let mut walk = Walk { limits: &limits, filter: Filter::new(dir.path()), deadline: Instant::now() - Duration::from_secs(1), files: vec![], manifests: vec![], skipped: 0, truncated: false, rules: vec![] };
        walk.file(&dir.path().join("requirements.txt"), "requirements.txt".into(), "requirements.txt", 45_000);
        assert!(walk.truncated);
        assert_eq!(walk.files, ["requirements.txt"]);
        assert_eq!((walk.manifests.len(), walk.manifests[0].facts.is_empty()), (1, true));
    }

    /// A reference walk with no shortcuts: every file of the tree through `Filter::ignored`, which re-reads the
    /// rules of every ancestor. The walk under test must list exactly these.
    fn reference_files(root: &Path) -> Vec<String> {
        fn visit(root: &Path, dir: &Path, filter: &Filter, out: &mut Vec<String>) {
            for entry in fs::read_dir(dir).unwrap() {
                let entry = entry.unwrap();
                let rel = entry.path().strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                if filter.ignored(&rel) {
                    continue;
                }
                if entry.file_type().unwrap().is_dir() {
                    visit(root, &entry.path(), filter, out);
                } else {
                    out.push(rel);
                }
            }
        }
        let mut out = Vec::new();
        visit(root, root, &Filter::new(root), &mut out);
        out.sort();
        out
    }

    #[test]
    fn nested_gitignore_rules_give_the_same_files_as_the_watchers_own_filter() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        write(r, ".gitignore", "*.log\n/build-out/\ncache/\n!keep.log\n");
        write(r, "a.log", "x");
        write(r, "keep.log", "x");
        write(r, "build-out/x.txt", "x");
        write(r, "src/build-out/y.txt", "x");
        write(r, "src/cache/z.txt", "x");
        write(r, "src/.gitignore", "*.tmp\n!important.log\n/only-here.txt\n");
        write(r, "src/a.tmp", "x");
        write(r, "src/important.log", "x");
        write(r, "src/only-here.txt", "x");
        write(r, "src/deep/only-here.txt", "x");
        write(r, "src/deep/.gitignore", "!a.tmp\nsecret/\n");
        write(r, "src/deep/a.tmp", "x");
        write(r, "src/deep/secret/s.txt", "x");
        write(r, "src/deep/more/.gitignore", "*\n!.gitignore\n");
        write(r, "src/deep/more/anything.txt", "x");
        write(r, "node_modules/p/index.js", "x");
        write(r, "pkg/dist/o.js", "x");
        write(r, "pkg/file.tmp.1234.abcdef", "x");
        write(r, "pkg/ok.txt", "x");
        let inv = scan(r, &unhurried()).unwrap();
        assert_eq!(inv.files, reference_files(r));
        assert!(inv.files.contains(&"src/deep/a.tmp".to_string()) && !inv.files.contains(&"src/a.tmp".to_string()), "{:?}", inv.files);
    }

    /// `n` files in nested folders 4 to 6 deep, with a `.gitignore` here and there. `sparse`: about 2 files per
    /// folder (many small folders, the slow case for any walk); otherwise about 20.
    fn big_tree(root: &Path, n: usize, sparse: bool) {
        let (a, b, c, d) = if sparse { (7, 11, 13, 5) } else { (5, 5, 4, 10) };
        for i in 0..n {
            let deeper = if i % 3 == 0 { format!("e{}/g{}/", i % 4, i % 3) } else { String::new() };
            write(root, &format!("a{}/b{}/c{}/d{}/{deeper}f{i}.txt", i % a, i % b, i % c, i % d), "x");
        }
        for rel in ["a1/.gitignore", "a2/b3/.gitignore", "a3/b4/c5/.gitignore", "a4/b5/c6/d2/.gitignore"] {
            write(root, rel, "*.skip\ne1/\n");
        }
        write(root, ".gitignore", "*.log\n");
    }

    /// Timing, not a pass/fail check: `RAIO_MEASURE_ROOT=<folder> cargo test inventory_timing -- --ignored --nocapture`
    /// also times a real folder (read-only). Prints files, manifests, truncated and the elapsed time of 3 runs.
    #[test]
    #[ignore = "timing measurement; run with --ignored --nocapture"]
    fn inventory_timing() {
        let (sparse, dense) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        big_tree(sparse.path(), 20_000, true);
        big_tree(dense.path(), 20_000, false);
        let mut targets = vec![("synthetic sparse (~2 files/folder)".to_string(), sparse.path().to_path_buf()), ("synthetic dense (~20 files/folder)".to_string(), dense.path().to_path_buf())];
        if let Ok(root) = std::env::var("RAIO_MEASURE_ROOT") {
            targets.push((format!("real folder {root}"), root.into()));
        }
        for (label, root) in targets {
            for run in 1..=3 {
                let started = Instant::now();
                let inv = scan(&root, &Limits::default()).unwrap();
                println!("{label} run {run}: {} files, {} manifests, truncated={}, skipped={}, {:?}", inv.files.len(), inv.manifests.len(), inv.truncated, inv.skipped, started.elapsed());
            }
            let started = Instant::now();
            let inv = scan(&root, &Limits { budget: Duration::from_secs(120), ..Limits::default() }).unwrap();
            println!("{label} unbounded budget: {} files, truncated={}, {:?}", inv.files.len(), inv.truncated, started.elapsed());
        }
    }

    /* scan ------------------------------------------------------------------ */

    fn project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        write(r, ".gitignore", "generated/\n");
        write(r, ".env", "API_TOKEN=sk-live-hunter2-do-not-leak\n");
        write(r, ".env.example", "API_TOKEN=\n");
        write(r, "package.json", r#"{"workspaces":["apps/*"],"scripts":{"dev":"node x --key sk-live-hunter2-do-not-leak"}}"#);
        write(r, "apps/web/package.json", r#"{"dependencies":{"next":"^14"}}"#);
        write(r, "apps/web/app/page.tsx", "export default function P() { return null }\n");
        write(r, "docker-compose.yml", "services:\n  postgres:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: hunter2-do-not-leak\n");
        write(r, "packages/db/prisma/schema.prisma", "datasource db {\n  provider = \"postgresql\"\n}\nmodel User {\n  id String @id\n}\n");
        write(r, "README.md", "# hi\n");
        write(r, "node_modules/pkg/package.json", r#"{"dependencies":{"left-pad":"1"}}"#);
        write(r, "generated/package.json", r#"{"dependencies":{"generated":"1"}}"#);
        write(r, "dist/out.js", "x\n");
        dir
    }

    #[test]
    fn lists_every_file_not_ignored_as_sorted_project_relative_posix_paths() {
        let dir = project();
        let inv = scan(dir.path(), &unhurried()).unwrap();
        assert_eq!(
            files(&inv),
            [".env", ".env.example", ".gitignore", "README.md", "apps/web/app/page.tsx", "apps/web/package.json", "docker-compose.yml", "package.json", "packages/db/prisma/schema.prisma"],
            "node_modules, dist and .gitignore'd folders are left out; every extension is listed"
        );
        assert!(!inv.truncated);
        assert_eq!(inv.skipped, 0);
        assert!(inv.scanned_at_ms > 1_700_000_000_000);
    }

    #[test]
    fn reads_only_the_listed_manifests_and_reports_them_by_path() {
        let dir = project();
        let inv = scan(dir.path(), &unhurried()).unwrap();
        let paths: Vec<&str> = inv.manifests.iter().map(|m| m.path.as_str()).collect();
        assert_eq!(paths, ["apps/web/package.json", "docker-compose.yml", "package.json", "packages/db/prisma/schema.prisma"]);
        assert_eq!(manifest(&inv, "package.json").kind, Kind::Npm);
        assert_eq!(serde_json::to_value(&manifest(&inv, "package.json").facts).unwrap(), json!({ "workspaces": ["apps/*"], "scripts": ["dev"] }));
        assert_eq!(serde_json::to_value(&manifest(&inv, "apps/web/package.json").facts).unwrap(), json!({ "dependencies": ["next"] }));
        assert_eq!(manifest(&inv, "docker-compose.yml").kind, Kind::Compose);
        assert_eq!(serde_json::to_value(&manifest(&inv, "docker-compose.yml").facts).unwrap(), json!({ "services": ["postgres"], "images": ["postgres"] }));
        assert_eq!(manifest(&inv, "packages/db/prisma/schema.prisma").kind, Kind::Prisma);
    }

    #[test]
    fn the_output_never_holds_a_value_from_a_manifest_or_an_env_file() {
        let dir = project();
        let inv = scan(dir.path(), &unhurried()).unwrap();
        let text = serde_json::to_string(&inv).unwrap();
        assert!(!text.contains("hunter2") && !text.contains("sk-live") && !text.contains("^14") && !text.contains("postgres:16"), "{text}");
    }

    #[test]
    fn the_output_shape_is_the_contract() {
        let dir = project();
        let json = serde_json::to_value(scan(dir.path(), &unhurried()).unwrap()).unwrap();
        let keys = |v: &Value| {
            let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
            k.sort();
            k
        };
        assert_eq!(keys(&json), ["files", "manifests", "scannedAtMs", "skipped", "truncated"]);
        assert_eq!(keys(&json["manifests"][0]), ["facts", "kind", "path"]);
        assert!(json["files"][0].is_string());
        assert_eq!(json["manifests"][0]["kind"], "npm");
    }

    #[test]
    fn a_malformed_or_oversized_manifest_is_listed_with_empty_facts() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "broken/package.json", "{ not json");
        write(dir.path(), "big/package.json", &format!("{{\"dependencies\":{{\"next\":\"1\"}},\"pad\":\"{}\"}}", "x".repeat(2_000)));
        write(dir.path(), "ok/package.json", r#"{"dependencies":{"next":"1"}}"#);
        let limits = Limits { max_manifest_bytes: 1_000, ..Limits::default() };
        let inv = scan(dir.path(), &limits).unwrap();
        assert!(manifest(&inv, "broken/package.json").facts.is_empty());
        assert!(manifest(&inv, "big/package.json").facts.is_empty(), "over the cap: never read");
        assert_eq!(manifest(&inv, "big/package.json").kind, Kind::Npm);
        assert_eq!(manifest(&inv, "ok/package.json").facts["dependencies"], ["next"]);
        assert_eq!(files(&inv).len(), 3, "an unreadable manifest is still a listed file");
    }

    #[test]
    fn manifests_beyond_the_cap_are_not_read_and_are_counted_as_skipped() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..5 {
            write(dir.path(), &format!("p{i}/package.json"), r#"{"scripts":{"a":"b"}}"#);
        }
        let inv = scan(dir.path(), &Limits { max_manifests: 3, ..Limits::default() }).unwrap();
        let paths: Vec<&str> = inv.manifests.iter().map(|m| m.path.as_str()).collect();
        assert_eq!(paths, ["p0/package.json", "p1/package.json", "p2/package.json"]);
        assert_eq!(inv.skipped, 2);
        assert_eq!(inv.files.len(), 5, "the files are still listed");
    }

    #[test]
    fn an_expired_budget_can_return_zero_even_when_the_file_cap_allows_every_file() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["d", "a", "c", "b", "e"] {
            write(dir.path(), &format!("{name}.txt"), "x");
        }
        let limits = Limits { max_files: 5, ..unhurried() };
        let mut walk = Walk { limits: &limits, filter: Filter::new(dir.path()), deadline: Instant::now() - Duration::from_secs(1),
            files: vec![], manifests: vec![], skipped: 0, truncated: false, rules: vec![] };
        walk.dir(dir.path(), "", 0);
        assert!(walk.files.is_empty());
        assert!(walk.truncated);
        assert_eq!(walk.skipped, 0, "directory enumeration succeeded; the deadline stopped visitation");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 5, "the same fixture still exists");
        let complete = scan(dir.path(), &limits).unwrap();
        assert_eq!(files(&complete), ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]);
        assert!(!complete.truncated);
    }

    #[test]
    fn more_files_than_the_cap_truncates_deterministically() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["d", "a", "c", "b", "e"] {
            write(dir.path(), &format!("{name}.txt"), "x");
        }
        // Exercise file-count truncation, independent of the production two-second time budget.
        // An expired deadline can otherwise return zero files under parallel filesystem contention.
        let first = scan(dir.path(), &Limits { max_files: 3, ..unhurried() }).unwrap();
        assert_eq!(files(&first), ["a.txt", "b.txt", "c.txt"]);
        assert!(first.truncated);
        let exactly = scan(dir.path(), &Limits { max_files: 5, ..unhurried() }).unwrap();
        assert_eq!(exactly.files.len(), 5);
        assert!(!exactly.truncated, "reaching the cap exactly is not truncation");
    }

    #[test]
    fn an_exhausted_time_budget_stops_the_walk_and_says_so() {
        let dir = project();
        let inv = scan(dir.path(), &Limits { budget: Duration::ZERO, ..Limits::default() }).unwrap();
        assert!(inv.truncated);
        assert!(inv.files.len() < 9);
    }

    #[test]
    fn the_default_caps_are_20000_files_2_seconds_and_1_mib_per_manifest() {
        let limits = Limits::default();
        assert_eq!((limits.max_files, limits.budget, limits.max_manifest_bytes), (20_000, Duration::from_secs(2), 1024 * 1024));
    }

    /// A directory link to `target` at `link`: a symlink where permitted, else (Windows) a junction, which needs
    /// no elevation. `None` when neither can be created.
    fn link_dir(target: &Path, link: &Path) -> Option<&'static str> {
        #[cfg(unix)]
        if std::os::unix::fs::symlink(target, link).is_ok() {
            return Some("symlink");
        }
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_dir(target, link).is_ok() {
                return Some("symlink");
            }
            let made = std::process::Command::new("cmd").arg("/C").arg("mklink").arg("/J").arg(link).arg(target).output().is_ok_and(|o| o.status.success());
            if made {
                return Some("junction");
            }
        }
        None
    }

    #[test]
    fn linked_folders_are_not_followed_or_listed() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write(outside.path(), "secret/package.json", r#"{"dependencies":{"outside":"1"}}"#);
        write(outside.path(), "secret/notes.txt", "x");
        write(dir.path(), "real.txt", "x");
        let Some(kind) = link_dir(&outside.path().join("secret"), &dir.path().join("link")) else {
            eprintln!("NOT RUN: neither a symlink nor a junction could be created here");
            return;
        };
        eprintln!("link kind exercised: {kind}");
        assert!(dir.path().join("link").join("notes.txt").exists(), "the link really leads to the outside folder");
        let inv = scan(dir.path(), &unhurried()).unwrap();
        assert_eq!(files(&inv), ["real.txt"], "a {kind} to another folder is neither followed nor listed");
        assert!(inv.manifests.is_empty());
    }

    #[test]
    fn a_missing_root_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(scan(&dir.path().join("gone"), &Limits::default()).is_err());
    }

    #[test]
    fn scanning_writes_nothing_to_the_project() {
        let dir = project();
        let listing = |root: &Path| {
            let mut all = vec![];
            let mut stack = vec![root.to_path_buf()];
            while let Some(d) = stack.pop() {
                for e in fs::read_dir(d).unwrap() {
                    let e = e.unwrap();
                    let meta = e.metadata().unwrap();
                    if meta.is_dir() {
                        stack.push(e.path());
                        all.push((e.path(), 0, std::time::UNIX_EPOCH));
                    } else {
                        all.push((e.path(), meta.len(), meta.modified().unwrap()));
                    }
                }
            }
            all.sort();
            all
        };
        let before = listing(dir.path());
        scan(dir.path(), &unhurried()).unwrap();
        assert_eq!(listing(dir.path()), before);
    }

    /// Writes the exact JSON `project_inventory` returns for each local MAP-FIX project to
    /// `.local/map-fixtures-real/<name>.json` (git-ignored), for review. Rewrites those five files only.
    #[test]
    #[ignore = "writes .local/map-fixtures-real/*.json from the local .local/map-fixtures; run with --ignored"]
    fn dump_the_local_map_fixtures_inventory_json() {
        let local = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.local");
        let out = local.join("map-fixtures-real");
        fs::create_dir_all(&out).unwrap();
        for name in ["django-shop", "express-react", "fastapi-sqlalchemy", "go-service", "next-prisma-monorepo"] {
            let inv = scan(&local.join("map-fixtures").join(name), &unhurried()).unwrap();
            fs::write(out.join(format!("{name}.json")), serde_json::to_string(&inv).unwrap()).unwrap();
        }
    }

    /// Runs the scan against the owner's local MAP-FIX projects (`.local/` is git-ignored, so CI cannot have it).
    #[test]
    #[ignore = "needs the local .local/map-fixtures projects; run with --ignored"]
    fn the_local_map_fixtures_give_the_documented_facts() {
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.local/map-fixtures");
        let started = Instant::now();
        let run = |name: &str| scan(&base.join(name), &unhurried()).unwrap();
        let facts_at = |inv: &Inventory, path: &str| serde_json::to_value(&manifest(inv, path).facts).unwrap();

        let next = run("next-prisma-monorepo");
        assert_eq!(facts_at(&next, "packages/ui/package.json"), json!({ "peerDependencies": ["react"] }));
        assert_eq!(facts_at(&next, "package.json")["workspaces"], json!(["apps/*", "packages/*"]));
        assert_eq!(facts_at(&next, "docker-compose.yml"), json!({ "services": ["postgres", "redis"], "images": ["postgres", "redis"] }));
        assert_eq!(facts_at(&next, "packages/db/prisma/schema.prisma"), json!({ "provider": ["postgresql"], "models": ["User", "Order"] }));
        assert!(next.files.iter().any(|f| f == ".env.example"));

        let express = run("express-react");
        let deps = facts_at(&express, "package.json");
        assert!(deps["dependencies"].as_array().unwrap().iter().any(|d| d == "bullmq") && deps["scripts"].as_array().unwrap().iter().any(|d| d == "worker"));
        assert!(express.manifests.iter().all(|m| m.kind == Kind::Npm));

        let fastapi = run("fastapi-sqlalchemy");
        let py = facts_at(&fastapi, "pyproject.toml");
        for want in ["fastapi", "sqlalchemy", "alembic", "pydantic-settings", "pytest"] {
            assert!(py["packages"].as_array().unwrap().iter().any(|d| d == want), "{want}");
        }

        let django = run("django-shop");
        let names: Vec<&str> = django.manifests.iter().map(|m| m.path.as_str()).collect();
        assert_eq!(names, ["requirements-dev.txt", "requirements.txt"]);
        assert!(facts_at(&django, "requirements.txt")["packages"].as_array().unwrap().iter().any(|d| d == "Django"));

        let go = run("go-service");
        assert_eq!(facts_at(&go, "go.mod"), json!({ "module": ["example.com/orders"], "require": ["github.com/go-chi/chi/v5", "github.com/jackc/pgx/v5"] }));
        assert_eq!(facts_at(&go, "docker-compose.yml"), json!({ "services": ["api", "postgres"], "images": ["postgres"] }));

        for inv in [&next, &express, &fastapi, &django, &go] {
            let text = serde_json::to_string(inv).unwrap();
            assert!(!text.contains("v5.0.12") && !text.contains("16-alpine") && !text.contains("^14"), "{text}");
        }
        assert!(started.elapsed() < Duration::from_secs(30));
    }
}
