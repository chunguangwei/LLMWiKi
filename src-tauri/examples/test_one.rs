//! One-off test harness: parse a .one file and print the extraction.
//! Mirrors src/commands/fs.rs::extract_onenote_text exactly so we can
//! validate the user-facing output without launching the GUI.
//!
//! Run: cargo run --example test_one -- <path>

use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::Read;
use std::path::Path;

use onenote_parser::Parser;

fn main() {
    let path = env::args().nth(1).expect("usage: test_one <path-to-.one>");
    println!("=== Inspecting: {} ===\n", path);

    // Header fingerprint
    if let Some(fp) = fingerprint(&path) {
        println!("[fingerprint] {}\n", fp);
    }

    // Try structured parse
    let parser = Parser::new();
    match parser.parse_section(Path::new(&path)) {
        Ok(section) => {
            println!("[parse_section] OK — section name: {}", section.display_name());
            let mut npages = 0;
            for series in section.page_series() {
                npages += series.pages().len();
            }
            println!("[parse_section] page count: {npages}");
            println!("\n--- structured extraction succeeded; not running fallback ---");
        }
        Err(e) => {
            println!("[parse_section] FAILED: {}", e);
            println!("\n[fallback] running strings extraction...\n");
            match extract_strings(&path) {
                Ok(text) => {
                    let runs: Vec<&str> = text.lines().collect();
                    println!("[fallback] extracted {} text runs", runs.len());
                    println!("[fallback] first 40:\n");
                    for r in runs.iter().take(40) {
                        println!("  {}", r);
                    }
                    println!("\n--- end (showing 40 of {}) ---", runs.len());
                }
                Err(fe) => println!("[fallback] FAILED: {}", fe),
            }
        }
    }
}

fn fingerprint(path: &str) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    let size = meta.len();
    if size < 16 { return Some(format!("only {size} bytes — too small")); }
    let mut file = fs::File::open(path).ok()?;
    let mut buf = [0u8; 16];
    file.read_exact(&mut buf).ok()?;
    const ONE_SECTION_LE: [u8; 16] = [
        0xE4,0x52,0x5C,0x7B,0x8C,0xD8,0xA7,0x4D,0xAE,0xB1,0x53,0x78,0xD0,0x29,0x96,0xD3,
    ];
    const ONETOC2_LE: [u8; 16] = [
        0xA1,0x2F,0xFF,0x43,0xD9,0xEF,0x76,0x4C,0x9E,0xE2,0x10,0xEA,0x57,0x22,0x76,0x5F,
    ];
    if buf == ONE_SECTION_LE { return Some(format!("One.SectionContainer ({} bytes)", size)); }
    if buf == ONETOC2_LE { return Some(format!(".onetoc2 notebook index ({} bytes)", size)); }
    let hex: String = buf.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" ");
    Some(format!("unknown header: {hex} ({} bytes)", size))
}

fn extract_strings(path: &str) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    const MIN_ASCII: usize = 6;
    const MIN_UTF16: usize = 4;
    const MAX_RUNS: usize = 3000;

    let mut ascii: Vec<String> = Vec::new();
    let mut cur = String::new();
    for &b in &bytes {
        if (0x20..=0x7E).contains(&b) || b == 0x09 {
            cur.push(b as char);
        } else {
            if cur.chars().count() >= MIN_ASCII && plausible(&cur) {
                ascii.push(std::mem::take(&mut cur));
            } else {
                cur.clear();
            }
        }
    }
    if cur.chars().count() >= MIN_ASCII && plausible(&cur) { ascii.push(std::mem::take(&mut cur)); }

    let mut utf16: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut has_cjk = false;
    let mut i = 0;
    while i + 1 < bytes.len() {
        let cp = (bytes[i] as u32) | ((bytes[i+1] as u32) << 8);
        if real_cjk(cp) || (0x20..=0x7E).contains(&cp) {
            if let Some(c) = char::from_u32(cp) {
                cur.push(c);
                if real_cjk(cp) { has_cjk = true; }
            }
        } else {
            if cur.chars().count() >= MIN_UTF16 && has_cjk && plausible(&cur) {
                utf16.push(std::mem::take(&mut cur));
            } else { cur.clear(); }
            has_cjk = false;
        }
        i += 2;
    }
    if cur.chars().count() >= MIN_UTF16 && has_cjk && plausible(&cur) { utf16.push(cur); }

    let mut seen = HashSet::new();
    let mut all: Vec<String> = Vec::new();
    for r in ascii.into_iter().chain(utf16.into_iter()) {
        if seen.insert(r.clone()) { all.push(r); }
    }
    let total = all.len();
    all.sort_by(|a, b| b.chars().count().cmp(&a.chars().count()));
    let truncated = all.len() > MAX_RUNS;
    all.truncate(MAX_RUNS);
    let mut out = all.join("\n");
    if truncated {
        out.push_str(&format!(
            "\n\n— truncated: {} more runs not shown.",
            total - MAX_RUNS
        ));
    }
    Ok(out)
}

fn real_cjk(cp: u32) -> bool {
    (0x3000..=0x303F).contains(&cp) || (0x3040..=0x30FF).contains(&cp)
        || (0x4E00..=0x9FFF).contains(&cp) || (0xFF00..=0xFFEF).contains(&cp)
}

fn plausible(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() { return false; }
    if t.starts_with("http://") || t.starts_with("https://") || t.starts_with("urn:") { return false; }
    let stripped = t.trim_matches(|c| c == '{' || c == '}');
    if stripped.len() == 36 && stripped.chars().enumerate().all(|(i,c)|
        if [8,13,18,23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() }) {
        return false;
    }
    if !t.chars().any(|c| c.is_alphanumeric()) { return false; }
    // base64-looking
    if !t.contains(' ') && t.len() >= 30 {
        let b64 = t.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '+' || *c == '/' || *c == '=').count();
        if b64 * 100 >= t.len() * 95 { return false; }
    }
    // 2+ CJK
    let mut r = 0;
    for c in t.chars() {
        if real_cjk(c as u32) { r += 1; if r >= 2 { return true; } } else { r = 0; }
    }
    // space + 4-letter word
    if t.contains(' ') {
        let mut r = 0;
        for c in t.chars() {
            if c.is_ascii_alphabetic() { r += 1; if r >= 4 { return true; } } else { r = 0; }
        }
    }
    false
}
