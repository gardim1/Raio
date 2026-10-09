//! Static import facts for a connected project (`project_imports`). Rust reports facts only: which
//! TS/JS files exist and which module specifiers (string literals) each one names. What a specifier
//! means (resolution, groups, edges) is decided in the renderer. File contents never leave this module
//! and nothing is written to disk.

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;

use crate::core::Core;
use crate::watch::Filter;

pub const MAX_FILE_BYTES: u64 = 512 * 1024;
pub const MAX_FILES: usize = 5_000;
pub const BUDGET: Duration = Duration::from_secs(2);

/// Bounds of one scan.
#[derive(Clone, Debug)]
pub struct Limits {
    pub max_file_bytes: u64,
    pub max_files: usize,
    pub budget: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { max_file_bytes: MAX_FILE_BYTES, max_files: MAX_FILES, budget: BUDGET }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFile {
    pub path: String,
    pub specifiers: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportScan {
    pub files: Vec<ImportFile>,
    pub truncated: bool,
    pub skipped: usize,
    pub scanned_at_ms: i64,
}

/* lexer ------------------------------------------------------------------ */

#[derive(Clone, Copy, Debug, PartialEq)]
enum Tok<'a> {
    Word(&'a [u8]),
    /// A string (or template without expressions) literal, without its quotes. Never holds an escape.
    Str(&'a [u8]),
    /// Anything that cannot be a specifier: a regex, a string with escapes, a template with expressions.
    Opaque,
    Punct(u8),
}

#[derive(Clone, Copy)]
enum Frame {
    Block,
    /// Inside `${ ... }` of a template literal.
    Subst,
}

fn is_word_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'$' || c >= 0x80
}

/// After these words a `/` starts a regular expression, after any other word it divides.
fn precedes_regex(word: &[u8]) -> bool {
    const KEYWORDS: [&[u8]; 16] = [
        b"return", b"typeof", b"instanceof", b"in", b"of", b"new", b"delete", b"void", b"throw", b"case", b"do", b"else", b"yield", b"await", b"extends", b"default",
    ];
    KEYWORDS.contains(&word)
}

/// End (exclusive) of a quoted string starting at `at`, whether it closed, and whether it holds an escape.
/// A string cannot span lines, so an unterminated one ends at the line break.
fn string_end(src: &[u8], at: usize) -> (usize, bool, bool) {
    let quote = src[at];
    let (mut j, mut escaped) = (at + 1, false);
    while j < src.len() {
        match src[j] {
            b'\\' => {
                escaped = true;
                j += 2;
            }
            b'\n' => return (j, false, escaped),
            c if c == quote => return (j + 1, true, escaped),
            _ => j += 1,
        }
    }
    (src.len(), false, escaped)
}

/// How far a regular expression literal is searched for its closing slash.
const REGEX_SEARCH: usize = 2_048;

/// End (exclusive) of a regular expression literal starting at `at`; `Err(stop)` is where the search gave up
/// (line break, end of input, or the search cap), so the caller does not start another search before it.
fn regex_end(src: &[u8], at: usize) -> Result<usize, usize> {
    let (mut j, mut in_class) = (at + 1, false);
    let limit = src.len().min(at + REGEX_SEARCH);
    while j < limit {
        match src[j] {
            b'\n' => return Err(j),
            b'\\' => j += 1,
            b'[' => in_class = true,
            b']' => in_class = false,
            b'/' if !in_class => {
                j += 1;
                while j < src.len() && is_word_byte(src[j]) {
                    j += 1;
                }
                return Ok(j);
            }
            _ => {}
        }
        j += 1;
    }
    Err(limit)
}

/// Scans template text from `from` (just after the opening backtick, or just after the `}` that closed a
/// `${`). `fresh` is true for the first stretch of a template. Returns where lexing of code resumes.
fn template_text<'a>(src: &'a [u8], from: usize, fresh: bool, out: &mut Vec<Tok<'a>>, stack: &mut Vec<Frame>) -> usize {
    let mut j = from;
    let mut escaped = false;
    while j < src.len() {
        match src[j] {
            b'\\' => {
                escaped = true;
                j += 2;
            }
            b'$' if src.get(j + 1) == Some(&b'{') => {
                if fresh {
                    out.push(Tok::Opaque);
                }
                stack.push(Frame::Subst);
                return j + 2;
            }
            b'`' => {
                if fresh {
                    out.push(if escaped { Tok::Opaque } else { Tok::Str(&src[from..j]) });
                }
                return j + 1;
            }
            _ => j += 1,
        }
    }
    src.len()
}

/// The deadline is checked this often (in input bytes, and in tokens while reading them).
const CHECK_EVERY: usize = 64 * 1024;
const PARSE_CHECK_EVERY: usize = 4_096;

/// A forgiving tokenizer: enough JavaScript to know which words are code, which text is a string, a
/// comment, a template or a regex. It never fails and every step consumes input, so it cannot hang.
fn tokens(src: &[u8], deadline: Instant) -> Option<Vec<Tok<'_>>> {
    let n = src.len();
    let mut i = if src.starts_with(&[0xEF, 0xBB, 0xBF]) { 3 } else { 0 };
    if src[i..].starts_with(b"#!") {
        while i < n && src[i] != b'\n' {
            i += 1;
        }
    }
    let mut out = Vec::new();
    let mut stack: Vec<Frame> = Vec::new();
    let mut regex_ok = true;
    // After a failed regex search every slash up to where it gave up is a division: no quadratic rescans.
    let mut regex_blocked_until = 0;
    let mut next_check = CHECK_EVERY;
    while i < n {
        if i >= next_check {
            if Instant::now() >= deadline {
                return None;
            }
            next_check = i + CHECK_EVERY;
        }
        let c = src[i];
        match c {
            b' ' | b'\t' | b'\r' | b'\n' => i += 1,
            b'/' => match src.get(i + 1) {
                Some(b'/') => {
                    while i < n && src[i] != b'\n' {
                        i += 1;
                    }
                }
                Some(b'*') => {
                    i += 2;
                    while i < n && !src[i..].starts_with(b"*/") {
                        i += 1;
                    }
                    i = (i + 2).min(n);
                }
                _ => match if regex_ok && i >= regex_blocked_until { Some(regex_end(src, i)) } else { None } {
                    Some(Ok(end)) => {
                        out.push(Tok::Opaque);
                        regex_ok = false;
                        i = end;
                    }
                    failed => {
                        if let Some(Err(stop)) = failed {
                            regex_blocked_until = stop;
                        }
                        out.push(Tok::Punct(b'/'));
                        regex_ok = true;
                        i += 1;
                    }
                },
            },
            b'\'' | b'"' => {
                let (end, closed, escaped) = string_end(src, i);
                out.push(if closed && !escaped { Tok::Str(&src[i + 1..end - 1]) } else { Tok::Opaque });
                regex_ok = false;
                i = end;
            }
            b'`' => {
                let depth = stack.len();
                i = template_text(src, i + 1, true, &mut out, &mut stack);
                // A substitution was entered: code follows.
                regex_ok = stack.len() > depth;
            }
            b'{' => {
                stack.push(Frame::Block);
                out.push(Tok::Punct(c));
                regex_ok = true;
                i += 1;
            }
            b'}' => {
                i += 1;
                if matches!(stack.pop(), Some(Frame::Subst)) {
                    let depth = stack.len();
                    i = template_text(src, i, false, &mut out, &mut stack);
                    regex_ok = stack.len() > depth;
                } else {
                    out.push(Tok::Punct(c));
                    regex_ok = true;
                }
            }
            c if is_word_byte(c) => {
                let start = i;
                while i < n && is_word_byte(src[i]) {
                    i += 1;
                }
                let word = &src[start..i];
                out.push(Tok::Word(word));
                regex_ok = precedes_regex(word);
            }
            _ => {
                out.push(Tok::Punct(c));
                regex_ok = c != b')' && c != b']';
                i += 1;
            }
        }
    }
    Some(out)
}

/// How far ahead the clause of an `import`/`export` statement is followed before giving up.
const CLAUSE_TOKENS: usize = 4_096;

fn is_punct(tok: Option<&Tok>, c: u8) -> bool {
    matches!(tok, Some(Tok::Punct(p)) if *p == c)
}

fn is_word(tok: Option<&Tok>, word: &[u8]) -> bool {
    matches!(tok, Some(Tok::Word(w)) if *w == word)
}

/// The specifier that ends an `import ... from '…'` clause starting after token `at`.
fn import_clause_source<'a>(toks: &[Tok<'a>], at: usize) -> Option<&'a [u8]> {
    let mut depth = 0usize;
    for j in at + 1..toks.len().min(at + 1 + CLAUSE_TOKENS) {
        match toks[j] {
            Tok::Punct(b'{') if depth == 0 => depth = 1,
            Tok::Punct(b'}') => depth = depth.checked_sub(1)?,
            // A second `{`, or another statement starting inside the clause, cannot be part of an import.
            Tok::Punct(b'{' | b';' | b'=' | b'(') | Tok::Opaque => return None,
            Tok::Word(b"import" | b"export") if depth == 0 => return None,
            Tok::Word(b"from") if depth == 0 => {
                if let Some(Tok::Str(s)) = toks.get(j + 1) {
                    return Some(s);
                }
            }
            Tok::Str(_) if depth == 0 => return None,
            _ => {}
        }
    }
    None
}

/// The source of `export * from '…'`, `export * as ns from '…'` and `export { … } from '…'` (optionally `type`).
fn export_source<'a>(toks: &[Tok<'a>], at: usize) -> Option<&'a [u8]> {
    let mut j = at + 1;
    if is_word(toks.get(j), b"type") {
        j += 1;
    }
    match toks.get(j)? {
        Tok::Punct(b'*') => {
            j += 1;
            if is_word(toks.get(j), b"as") {
                j += 2;
            }
        }
        Tok::Punct(b'{') => {
            let limit = toks.len().min(j + CLAUSE_TOKENS);
            j += 1;
            while j < limit && !is_punct(toks.get(j), b'}') {
                if is_punct(toks.get(j), b';') || is_punct(toks.get(j), b'{') {
                    return None;
                }
                j += 1;
            }
            j += 1;
        }
        _ => return None,
    }
    match (toks.get(j), toks.get(j + 1)) {
        (Some(Tok::Word(b"from")), Some(Tok::Str(s))) => Some(s),
        _ => None,
    }
}

/// `import('…')` and `require('…')` with a literal argument (a second argument, e.g. import attributes, is fine).
fn call_source<'a>(toks: &[Tok<'a>], at: usize) -> Option<&'a [u8]> {
    match (toks.get(at + 1), toks.get(at + 2), toks.get(at + 3)) {
        (Some(Tok::Punct(b'(')), Some(Tok::Str(s)), Some(Tok::Punct(b')' | b','))) => Some(s),
        _ => None,
    }
}

/// Longest specifier reported, and most specifiers reported per file: anything beyond is noise or abuse.
const MAX_SPECIFIER_BYTES: usize = 1_024;
const MAX_SPECIFIERS: usize = 1_000;

pub(crate) fn is_cloud_placeholder(attributes: u32) -> bool {
    /// FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_RECALL_ON_OPEN (a folder).
    const CLOUD_ONLY: u32 = 0x0040_0000 | 0x0000_1000 | 0x0004_0000;
    attributes & CLOUD_ONLY != 0
}

/// String-literal module specifiers of a TS/JS source, in order of first appearance, without duplicates:
/// `import … from`, `import '…'`, `export … from`, `import('…')` and `require('…')`. Comments, strings,
/// regexes and templates are skipped; a specifier that needs unescaping, or is longer than 1 KiB, is not
/// reported; at most 1000 are. `None`: the deadline passed while reading the file.
pub fn specifiers_until(source: &[u8], deadline: Instant) -> Option<Vec<String>> {
    let toks = tokens(source, deadline)?;
    let mut found: Vec<String> = Vec::new();
    let mut seen: HashSet<&[u8]> = HashSet::new();
    for (at, tok) in toks.iter().enumerate() {
        if at % PARSE_CHECK_EVERY == PARSE_CHECK_EVERY - 1 && Instant::now() >= deadline {
            return None;
        }
        let Tok::Word(word) = tok else { continue };
        if at > 0 && is_punct(toks.get(at - 1), b'.') {
            continue; // a property: obj.import(...), x.require(...)
        }
        let source = match *word {
            b"import" => match toks.get(at + 1) {
                Some(Tok::Str(s)) => Some(*s),
                Some(Tok::Punct(b'(')) => call_source(&toks, at),
                Some(Tok::Punct(b'.')) => None, // import.meta
                _ => import_clause_source(&toks, at),
            },
            b"export" => export_source(&toks, at),
            b"require" => call_source(&toks, at),
            _ => None,
        };
        if let Some(s) = source.filter(|s| !s.is_empty() && s.len() <= MAX_SPECIFIER_BYTES)
            && seen.insert(s)
        {
            found.push(String::from_utf8_lossy(s).into_owned());
            if found.len() >= MAX_SPECIFIERS {
                break;
            }
        }
    }
    Some(found)
}

/// [`specifiers_until`] without a practical deadline.
pub fn specifiers(source: &[u8]) -> Vec<String> {
    specifiers_until(source, Instant::now() + Duration::from_secs(3600)).unwrap_or_default()
}

/* scan ------------------------------------------------------------------- */

const EXTENSIONS: [&str; 8] = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];
/// Deeper trees are cut off (and reported as truncated) rather than risking the stack.
pub(crate) const MAX_DEPTH: usize = 128;

fn is_scannable(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let Some((stem, ext)) = lower.rsplit_once('.') else { return false };
    !stem.is_empty() && EXTENSIONS.contains(&ext) && !(stem.ends_with(".d") && matches!(ext, "ts" | "mts" | "cts"))
}

struct Walk<'a> {
    limits: &'a Limits,
    filter: Filter,
    deadline: Instant,
    files: Vec<ImportFile>,
    skipped: usize,
    truncated: bool,
}

/// Attribute bits of a directory entry (Windows only; 0 elsewhere).
pub(crate) fn attributes_of(meta: &fs::Metadata) -> u32 {
    #[cfg(windows)]
    {
        std::os::windows::fs::MetadataExt::file_attributes(meta)
    }
    #[cfg(not(windows))]
    {
        let _ = meta;
        0
    }
}

pub(crate) struct Entry {
    pub(crate) name: String,
    pub(crate) kind: fs::FileType,
    pub(crate) attributes: u32,
    pub(crate) len: u64,
    pub(crate) metadata_readable: bool,
}

/// Entries of `abs`, sorted by name. What cannot be listed or named is counted in `skipped`, never silently
/// lost; a name that is not valid Unicode cannot be reported and is counted when `counted(is_dir, lossy_name)`.
/// Shared by the import scan and the project inventory so both walk the same way.
pub(crate) fn list_entries(abs: &Path, skipped: &mut usize, unreadable: &mut usize, counted: impl Fn(bool, &str) -> bool) -> Vec<Entry> {
    let Ok(read) = fs::read_dir(abs) else {
        *skipped += 1;
        *unreadable += 1;
        return vec![];
    };
    let mut entries = Vec::new();
    for entry in read {
        let Ok(entry) = entry else {
            *skipped += 1;
            *unreadable += 1;
            continue;
        };
        let Ok(kind) = entry.file_type() else {
            *skipped += 1;
            *unreadable += 1;
            continue;
        };
        let meta = entry.metadata().ok();
        let (attributes, len) = meta.as_ref().map_or((0, u64::MAX), |m| (attributes_of(m), m.len()));
        match entry.file_name().into_string() {
            Ok(name) => {
                let metadata_readable = meta.is_some();
                if !metadata_readable && counted(kind.is_dir(), &name) { *unreadable += 1; }
                entries.push(Entry { name, kind, attributes, len, metadata_readable });
            }
            Err(raw) => {
                let count = usize::from(counted(kind.is_dir(), &raw.to_string_lossy()));
                *skipped += count;
                *unreadable += count;
            }
        }
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    entries
}

impl Walk<'_> {
    fn entries(&mut self, abs: &Path) -> Vec<Entry> {
        let mut unreadable = 0;
        list_entries(abs, &mut self.skipped, &mut unreadable, |is_dir, name| is_dir || is_scannable(name))
    }

    fn dir(&mut self, abs: &Path, rel: &str, depth: usize) {
        for entry in self.entries(abs) {
            if self.truncated {
                return;
            }
            if Instant::now() >= self.deadline {
                self.truncated = true;
                return;
            }
            self.visit(abs, rel, depth, entry);
        }
    }

    fn visit(&mut self, abs: &Path, rel: &str, depth: usize, entry: Entry) {
        let Entry { name, kind, attributes, len, metadata_readable } = entry;
        if kind.is_symlink() {
            return;
        }
        if !metadata_readable { self.skipped += 1; return; }
        let is_dir = kind.is_dir();
        if !is_dir && !(kind.is_file() && is_scannable(&name)) {
            return; // cheap check first: most files are not source files
        }
        // An online-only OneDrive placeholder would be downloaded by reading it (or listing the folder). Decided
        // from the entry's own attributes, before the filter, which reads `.gitignore` files and stats paths.
        // (An ignored placeholder is still counted: "not read" is true, and the count is only informational.)
        if is_cloud_placeholder(attributes) {
            self.skipped += 1;
            return;
        }
        let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        if self.filter.ignored(&child) {
            return;
        }
        if is_dir {
            if depth >= MAX_DEPTH {
                self.truncated = true;
                return;
            }
            self.dir(&abs.join(&name), &child, depth + 1);
        } else {
            self.file(&abs.join(&name), child, len);
        }
    }

    fn file(&mut self, abs: &Path, rel: String, len: u64) {
        if len > self.limits.max_file_bytes {
            self.skipped += 1;
            return;
        }
        if self.files.len() >= self.limits.max_files {
            self.truncated = true;
            return;
        }
        // Bounded read: a file that grew since the listing is skipped, not slurped.
        let mut source = Vec::new();
        let read = fs::File::open(abs).and_then(|f| f.take(self.limits.max_file_bytes + 1).read_to_end(&mut source));
        if read.is_err() || source.len() as u64 > self.limits.max_file_bytes {
            self.skipped += 1;
            return;
        }
        match specifiers_until(&source, self.deadline) {
            Some(specifiers) => self.files.push(ImportFile { path: rel, specifiers }),
            None => self.truncated = true, // out of time inside this file: it is not listed half-read
        }
    }
}

/// Walks `root` the way the watcher does (nested `.gitignore` files and the always-ignored folders) and
/// lists the TS/JS files with the specifiers they name. Stops at the file or time cap and says so.
pub fn scan(root: &Path, limits: &Limits) -> Result<ImportScan, String> {
    if !root.is_dir() {
        return Err("project folder not found".into());
    }
    let mut walk = Walk { limits, filter: Filter::new(root), deadline: Instant::now() + limits.budget, files: Vec::new(), skipped: 0, truncated: false };
    walk.dir(root, "", 0);
    walk.files.sort_by(|a, b| a.path.cmp(&b.path));
    let scanned_at_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    Ok(ImportScan { files: walk.files, truncated: walk.truncated, skipped: walk.skipped, scanned_at_ms })
}

/// The renderer's entry point. Async with the walk on the blocking pool: it never runs on the UI thread.
#[tauri::command]
pub async fn project_imports(core: State<'_, Core>, project_id: String) -> Result<ImportScan, String> {
    let root = core.connected_root(&project_id)?;
    tauri::async_runtime::spawn_blocking(move || scan(&root, &Limits::default())).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn spec(src: &str) -> Vec<String> {
        specifiers(src.as_bytes())
    }

    fn strs(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /* lexer ---------------------------------------------------------------- */

    #[test]
    fn extracts_every_static_import_syntax_in_source_order() {
        let src = r#"
import a from './a';
import * as b from "./b";
import { c, d as e } from './c';
import type { T } from './types';
import f, { g } from './fg';
import './side-effect';
export * from './re-all';
export * as ns from './re-ns';
export { h } from './re-h';
export type { U } from './re-type';
const i = await import('./dyn');
const j = require('./req');
import k = require('./eq');
import pkg from 'pkg';
"#;
        assert_eq!(
            spec(src),
            strs(&["./a", "./b", "./c", "./types", "./fg", "./side-effect", "./re-all", "./re-ns", "./re-h", "./re-type", "./dyn", "./req", "./eq", "pkg"])
        );
    }

    #[test]
    fn handles_multi_line_clauses_and_binding_names_that_look_like_keywords() {
        let src = "import {\n  a,\n  b as c,\n} from\n  './multi';\nimport { from } from './named-from';\nimport from from './default-from';\nexport {\n  x,\n} from './re';\nexport type * from './type-star';\n";
        assert_eq!(spec(src), strs(&["./multi", "./named-from", "./default-from", "./re", "./type-star"]));
    }

    #[test]
    fn local_exports_and_other_uses_of_the_words_are_not_imports() {
        let src = "export const a = 1;\nexport default function f() {}\nexport { a as b };\nconst o = { import: 1, require: 2 };\nimport.meta.url;\nrequire.resolve('./nope');\nobj.import('./nope');\nobj.require('./nope');\nrequire(name);\nimport(name);\nexport function g() { return from('./nope'); }\n";
        assert_eq!(spec(src), Vec::<String>::new());
    }

    #[test]
    fn ignores_imports_inside_comments_and_strings() {
        let src = "// import x from './line';\n/* import y from './block';\n   require('./block2'); */\nconst s = \"import z from './in-string'\";\nconst t = 'require(\"./in-single\")';\nimport real from './real'; // import w from './trailing'\n";
        assert_eq!(spec(src), strs(&["./real"]));
    }

    #[test]
    fn template_literals_with_expressions_give_nothing_and_their_text_is_not_code() {
        let src = "const a = `import x from './in-template'`;\nconst b = await import(`./dynamic/${name}`);\nconst c = require(`${base}/x`);\nconst d = `outer ${ `inner ${ require('./nested') }` } text import q from './text'`;\nimport ok from './ok';\n";
        assert_eq!(spec(src), strs(&["./nested", "./ok"]));
    }

    #[test]
    fn a_template_without_expressions_is_a_static_specifier() {
        assert_eq!(spec("const m = await import(`./static`);"), strs(&["./static"]));
    }

    #[test]
    fn regex_literals_and_division_do_not_derail_the_lexer() {
        let src = "const r = /['\"`]/g;\nconst q = a / b / c;\nconst e = /\\/\\/ not a comment/;\nconst s = x.replace(/\"/g, '');\nimport after from './after-regex';\n";
        assert_eq!(spec(src), strs(&["./after-regex"]));
    }

    #[test]
    fn a_byte_order_mark_and_a_hashbang_are_tolerated() {
        assert_eq!(spec("\u{feff}import a from './bom';"), strs(&["./bom"]));
        assert_eq!(spec("#!/usr/bin/env node\nimport a from './shebang';"), strs(&["./shebang"]));
    }

    #[test]
    fn specifiers_with_escapes_are_not_reported_and_duplicates_collapse() {
        assert_eq!(spec("import a from './a\\u0062';\nimport b from './b';\nimport type { B } from './b';\nrequire('./b');"), strs(&["./b"]));
    }

    #[test]
    fn jsx_and_typescript_syntax_do_not_hide_later_imports() {
        let src = "import React from 'react';\nconst A = <p>it's {x} // text</p>;\ntype X = typeof import('./type-only');\nenum E { A }\nimport last from './last';\n";
        let got = spec(src);
        assert!(got.contains(&"react".to_string()) && got.contains(&"./type-only".to_string()), "{got:?}");
    }

    #[test]
    fn broken_and_hostile_input_terminates() {
        let hostile = [
            "import a from './unterminated",
            "/* never closed import x from './x'",
            "`never closed ${ import(",
            "const r = /[unterminated",
            "import {",
            "export",
            "import",
            "require(",
            "\"\\",
            "${${${}}}}}}}}",
            "`${`${`${`${`",
        ];
        for src in hostile {
            let _ = spec(src);
        }
        let deep = "{".repeat(100_000) + &"}".repeat(100_000);
        let _ = spec(&deep);
        let noise: Vec<u8> = (0..200_000u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 24) as u8).collect();
        let _ = specifiers(&noise);
        let long_clause = format!("import {{ {} }} from './long';", "a, ".repeat(50_000));
        let _ = spec(&long_clause);
    }

    /* scan ----------------------------------------------------------------- */

    fn write(root: &Path, rel: &str, body: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    fn paths(scan: &ImportScan) -> Vec<&str> {
        scan.files.iter().map(|f| f.path.as_str()).collect()
    }

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        write(r, ".gitignore", "generated/\n*.log.ts\n");
        write(r, "src/app.ts", "import { a } from './a';\nexport * from './b';\n");
        write(r, "src/a.tsx", "import './side';\n");
        write(r, "src/b.mts", "const x = await import('./a');\n");
        write(r, "src/c.cts", "const y = require('./b');\n");
        write(r, "src/d.js", "import z from 'pkg';\n");
        write(r, "src/e.jsx", "export { q } from './d';\n");
        write(r, "src/f.mjs", "// nothing here\n");
        write(r, "src/g.cjs", "module.exports = {};\n");
        write(r, "src/types.d.ts", "import { T } from './a';\n");
        write(r, "src/readme.md", "import x from './nope';\n");
        write(r, "src/data.json", "{}");
        write(r, "node_modules/pkg/index.js", "require('./x');\n");
        write(r, "dist/out.js", "require('./x');\n");
        write(r, "generated/client.ts", "import x from './nope';\n");
        write(r, "src/debug.log.ts", "import x from './nope';\n");
        write(r, "packages/web/.gitignore", "gen/\n");
        write(r, "packages/web/gen/api.ts", "import x from './nope';\n");
        write(r, "packages/web/src/page.ts", "import { a } from '../../../src/a';\n");
        dir
    }

    /// Content tests must not depend on machine load; the 2 s production budget is tested on its own.
    fn unhurried() -> Limits {
        Limits { budget: Duration::from_secs(60), ..Limits::default() }
    }

    #[test]
    fn scans_the_listed_extensions_with_project_relative_posix_paths_and_their_specifiers() {
        let dir = fixture();
        let scan = scan(dir.path(), &unhurried()).unwrap();
        assert_eq!(
            paths(&scan),
            ["packages/web/src/page.ts", "src/a.tsx", "src/app.ts", "src/b.mts", "src/c.cts", "src/d.js", "src/e.jsx", "src/f.mjs", "src/g.cjs"],
            "declaration files, other extensions and ignored folders are left out; order is by path"
        );
        let of = |p: &str| scan.files.iter().find(|f| f.path == p).unwrap().specifiers.clone();
        assert_eq!(of("src/app.ts"), strs(&["./a", "./b"]));
        assert_eq!(of("src/a.tsx"), strs(&["./side"]));
        assert_eq!(of("src/b.mts"), strs(&["./a"]));
        assert_eq!(of("src/c.cts"), strs(&["./b"]));
        assert_eq!(of("src/d.js"), strs(&["pkg"]));
        assert_eq!(of("src/e.jsx"), strs(&["./d"]));
        assert_eq!(of("src/f.mjs"), Vec::<String>::new(), "a scanned file without imports is still listed: the renderer resolves against the scanned set");
        assert_eq!(of("packages/web/src/page.ts"), strs(&["../../../src/a"]));
        assert!(!scan.truncated);
        assert_eq!(scan.skipped, 0);
        assert!(scan.scanned_at_ms > 1_700_000_000_000);
    }

    #[test]
    fn a_file_over_the_size_cap_is_counted_as_skipped_and_never_read() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "small.ts", "import a from './a';\n");
        write(dir.path(), "big.ts", &format!("import b from './b';\n{}", "x".repeat(2_000)));
        let limits = Limits { max_file_bytes: 1_000, ..Limits::default() };
        let scan = scan(dir.path(), &limits).unwrap();
        assert_eq!(paths(&scan), ["small.ts"]);
        assert_eq!(scan.skipped, 1);
        assert!(!scan.truncated);
    }

    #[test]
    fn the_default_cap_is_512_kib_per_file_and_5000_files() {
        let limits = Limits::default();
        assert_eq!((limits.max_file_bytes, limits.max_files, limits.budget), (512 * 1024, 5_000, Duration::from_secs(2)));
    }

    #[test]
    fn more_files_than_the_cap_truncates_deterministically() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["d", "a", "c", "b", "e"] {
            write(dir.path(), &format!("{name}.ts"), "export {};\n");
        }
        let limits = Limits { max_files: 3, ..Limits::default() };
        let first = scan(dir.path(), &limits).unwrap();
        assert_eq!(paths(&first), ["a.ts", "b.ts", "c.ts"]);
        assert!(first.truncated);
        let exactly = scan(dir.path(), &Limits { max_files: 5, ..Limits::default() }).unwrap();
        assert_eq!(exactly.files.len(), 5);
        assert!(!exactly.truncated, "reaching the cap exactly is not truncation");
    }

    #[test]
    fn an_exhausted_time_budget_stops_the_scan_and_says_so() {
        let dir = fixture();
        let scan = scan(dir.path(), &Limits { budget: Duration::ZERO, ..Limits::default() }).unwrap();
        assert!(scan.truncated);
        assert!(scan.files.len() < 9);
    }

    #[test]
    fn the_output_carries_paths_and_specifiers_only_never_contents() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "src/secret.ts", "const TOKEN = 'hunter2-do-not-leak';\n// private note about the customer\nimport a from './a';\n");
        let scan = scan(dir.path(), &unhurried()).unwrap();
        let json = serde_json::to_value(&scan).unwrap();
        let text = json.to_string();
        assert!(!text.contains("hunter2") && !text.contains("customer") && !text.contains("TOKEN"), "{text}");
        let keys = |v: &serde_json::Value| {
            let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
            k.sort();
            k
        };
        assert_eq!(keys(&json), ["files", "scannedAtMs", "skipped", "truncated"]);
        assert_eq!(keys(&json["files"][0]), ["path", "specifiers"]);
    }

    #[test]
    fn scanning_writes_nothing_to_the_project() {
        let dir = fixture();
        let listing = |root: &Path| {
            let mut all = vec![];
            let mut stack = vec![root.to_path_buf()];
            while let Some(d) = stack.pop() {
                for e in fs::read_dir(d).unwrap() {
                    let e = e.unwrap();
                    let meta = e.metadata().unwrap();
                    if meta.is_dir() {
                        // Directory timestamps move on their own on NTFS; only names and file stamps are compared.
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

    #[test]
    fn a_missing_root_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(scan(&dir.path().join("gone"), &Limits::default()).is_err());
    }

    /* round b: bounded work ------------------------------------------------ */

    /// Runs `f` on a thread and fails the test (instead of hanging it) when it does not finish in time.
    fn finishes_within<T: Send + 'static>(seconds: u64, f: impl FnOnce() -> T + Send + 'static) -> T {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(f());
        });
        rx.recv_timeout(Duration::from_secs(seconds)).expect("did not finish in bounded time")
    }

    #[test]
    fn a_long_line_of_failed_regex_candidates_is_lexed_in_bounded_time() {
        let hostile = "/\\".repeat(256 * 1024); // 512 KiB of `/\`: every slash looks like a regex start that never closes
        assert_eq!(hostile.len(), 512 * 1024);
        let got = finishes_within(5, move || specifiers(hostile.as_bytes()));
        assert!(got.is_empty());
    }

    #[test]
    fn repeated_statement_keywords_do_not_make_clause_following_quadratic() {
        let imports = "import ".repeat(70_000);
        let exports = "export { ".repeat(60_000);
        let got = finishes_within(5, move || (specifiers(imports.as_bytes()), specifiers(exports.as_bytes())));
        assert!(got.0.is_empty() && got.1.is_empty());
    }

    #[test]
    fn a_passed_deadline_aborts_a_large_file_and_a_future_one_does_not() {
        let big = "a;
".repeat(100_000); // 400 KB, well past the 64 KiB check interval
        assert_eq!(specifiers_until(big.as_bytes(), Instant::now() - Duration::from_secs(1)), None);
        assert_eq!(specifiers_until(big.as_bytes(), Instant::now() + Duration::from_secs(60)), Some(vec![]));
        assert_eq!(specifiers_until(b"import a from './a';", Instant::now() - Duration::from_secs(1)), Some(strs(&["./a"])), "a file smaller than the check interval is finished");
    }

    #[test]
    fn an_exhausted_budget_in_the_middle_of_a_file_marks_the_scan_truncated() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "big.ts", &"a;
".repeat(100_000));
        let limits = Limits { budget: Duration::from_millis(1), ..Limits::default() };
        std::thread::sleep(Duration::from_millis(5)); // the clock starts in `scan`; the file is big enough to cross a check anyway
        let scan = scan(dir.path(), &limits).unwrap();
        assert!(scan.truncated);
        assert!(scan.files.is_empty(), "an aborted file is not listed half-read");
    }

    #[test]
    fn cloud_placeholders_are_recognised_by_attribute() {
        const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
        const OFFLINE: u32 = 0x0000_1000;
        const RECALL_ON_OPEN: u32 = 0x0004_0000;
        assert!(is_cloud_placeholder(RECALL_ON_DATA_ACCESS));
        assert!(is_cloud_placeholder(OFFLINE));
        assert!(is_cloud_placeholder(RECALL_ON_OPEN), "an online-only folder");
        assert!(is_cloud_placeholder(0x20 | RECALL_ON_DATA_ACCESS), "archive + placeholder");
        assert!(!is_cloud_placeholder(0));
        assert!(!is_cloud_placeholder(0x20), "archive");
        assert!(!is_cloud_placeholder(0x80), "normal");
        assert!(!is_cloud_placeholder(0x10), "directory");
    }

    #[test]
    fn an_unreadable_directory_is_counted_as_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let limits = Limits::default();
        let mut walk = Walk { limits: &limits, filter: Filter::new(dir.path()), deadline: Instant::now() + Duration::from_secs(5), files: vec![], skipped: 0, truncated: false };
        walk.dir(&dir.path().join("vanished"), "vanished", 1);
        assert_eq!(walk.skipped, 1);
    }

    #[test]
    fn oversized_specifiers_are_dropped_and_a_file_reports_at_most_a_thousand() {
        let long = "x".repeat(1025);
        assert_eq!(spec(&format!("import a from '{long}';
import b from './b';")), strs(&["./b"]));
        let fine = "y".repeat(1024);
        assert_eq!(spec(&format!("import a from '{fine}';")).len(), 1, "exactly 1 KiB is kept");
        let many: String = (0..1_500).map(|i| format!("import './m{i}';
")).collect();
        let got = spec(&many);
        assert_eq!(got.len(), 1_000);
        assert_eq!(got[0], "./m0");
        assert_eq!(got[999], "./m999");
    }

    #[test]
    fn a_cloud_placeholder_is_counted_before_any_ignore_rule_is_consulted() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), ".gitignore", "ignored.ts\n");
        write(dir.path(), "ignored.ts", "export {};\n");
        let kind = fs::metadata(dir.path().join("ignored.ts")).unwrap().file_type();
        let limits = Limits::default();
        let walk = || Walk { limits: &limits, filter: Filter::new(dir.path()), deadline: Instant::now() + Duration::from_secs(60), files: vec![], skipped: 0, truncated: false };
        let entry = |attributes| Entry { name: "ignored.ts".into(), kind, attributes, len: 10, metadata_readable: true };

        let mut placeholder = walk();
        placeholder.visit(dir.path(), "", 0, entry(0x0040_0000));
        assert_eq!(placeholder.skipped, 1, "cloud-only is decided from the entry's own attributes, before the filter reads any .gitignore");
        assert!(placeholder.files.is_empty());

        let mut ordinary = walk();
        ordinary.visit(dir.path(), "", 0, entry(0));
        assert_eq!((ordinary.skipped, ordinary.files.len()), (0, 0), "an ordinary ignored file is neither listed nor counted");
    }
}
