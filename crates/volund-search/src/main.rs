use ignore::WalkBuilder;
use regex::RegexBuilder;
use serde_json::{json, Value};
use std::{
    fs,
    io::{self, BufRead, Write},
    path::Path,
};
use tree_sitter::{Language, Parser, Query, QueryCursor};

const HARD_LIMIT: usize = 10_000;

fn language(name: &str) -> Result<Language, String> {
    match name {
        "javascript" | "js" => Ok(tree_sitter_javascript::language()),
        "typescript" | "ts" => Ok(tree_sitter_typescript::language_typescript()),
        "tsx" => Ok(tree_sitter_typescript::language_tsx()),
        "python" | "py" => Ok(tree_sitter_python::language()),
        "rust" | "rs" => Ok(tree_sitter_rust::language()),
        _ => Err(format!("unsupported AST language: {name}")),
    }
}

fn walk_files(root: &Path, extra_ignores: &[String]) -> ignore::Walk {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .add_custom_ignore_filename(".volundignore");
    if !extra_ignores.is_empty() {
        let mut overrides = ignore::overrides::OverrideBuilder::new(root);
        for pattern in extra_ignores {
            let _ = overrides.add(&format!("!{pattern}"));
        }
        if let Ok(value) = overrides.build() {
            builder.overrides(value);
        }
    }
    builder.build()
}

fn search(params: &Value) -> Result<(Vec<Value>, bool), String> {
    let root = params
        .get("path")
        .or_else(|| params.get("cwd"))
        .and_then(Value::as_str)
        .unwrap_or(".");
    let pattern = params
        .get("pattern")
        .and_then(Value::as_str)
        .ok_or("missing string parameter: pattern")?;
    let regex = RegexBuilder::new(pattern)
        .case_insensitive(
            params
                .get("caseInsensitive")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        )
        .build()
        .map_err(|e| e.to_string())?;
    let limit = params
        .get("maxMatches")
        .and_then(Value::as_u64)
        .unwrap_or(HARD_LIMIT as u64)
        .min(HARD_LIMIT as u64) as usize;
    let ignores: Vec<String> = params
        .get("ignore")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    let mut output = Vec::new();
    let mut truncated = false;
    'files: for entry in walk_files(Path::new(root), &ignores)
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
    {
        let Ok(bytes) = fs::read(entry.path()) else { continue };
        if bytes.iter().take(8192).any(|b| *b == 0) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&bytes) else { continue };
        let mut offset = 0;
        for (line_index, line) in text.lines().enumerate() {
            for found in regex.find_iter(line) {
                if output.len() >= limit {
                    truncated = true;
                    break 'files;
                }
                output.push(json!({"path":entry.path(),"lineNumber":line_index+1,"line":line,"span":{"start":offset+found.start(),"end":offset+found.end()}}));
            }
            offset += line.len() + 1;
        }
    }
    Ok((output, truncated))
}

fn ast_query(params: &Value) -> Result<(Vec<Value>, bool), String> {
    let root = params
        .get("path")
        .or_else(|| params.get("cwd"))
        .and_then(Value::as_str)
        .unwrap_or(".");
    let lang = language(
        params
            .get("language")
            .and_then(Value::as_str)
            .ok_or("missing string parameter: language")?,
    )?;
    let query_text = params
        .get("query")
        .and_then(Value::as_str)
        .ok_or("missing string parameter: query")?;
    let query = Query::new(&lang, query_text).map_err(|e| format!("invalid AST query: {e}"))?;
    let limit = params
        .get("maxMatches")
        .and_then(Value::as_u64)
        .unwrap_or(HARD_LIMIT as u64)
        .min(HARD_LIMIT as u64) as usize;
    let mut parser = Parser::new();
    parser.set_language(&lang).map_err(|e| e.to_string())?;
    let mut output = Vec::new();
    let mut truncated = false;
    'files: for entry in walk_files(Path::new(root), &[])
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
    {
        let Ok(source) = fs::read(entry.path()) else { continue };
        let Some(tree) = parser.parse(&source, None) else { continue };
        let mut cursor = QueryCursor::new();
        for matched in cursor.matches(&query, tree.root_node(), source.as_slice()) {
            for capture in matched.captures {
                if output.len() >= limit {
                    truncated = true;
                    break 'files;
                }
                let node = capture.node;
                let start = node.start_position();
                let end = node.end_position();
                output.push(json!({"path":entry.path(),"capture":query.capture_names()[capture.index as usize],"text":String::from_utf8_lossy(&source[node.byte_range()]),"span":{"start":node.start_byte(),"end":node.end_byte()},"start":{"line":start.row+1,"column":start.column},"end":{"line":end.row+1,"column":end.column}}));
            }
        }
    }
    Ok((output, truncated))
}

fn main() {
    println!(
        "{}",
        json!({"jsonrpc":"2.0","method":"worker.ready","params":{"protocol":1,"kind":"search"}})
    );
    io::stdout().flush().ok();
    for line in io::stdin().lock().lines().map_while(Result::ok) {
        let Ok(request) = serde_json::from_str::<Value>(&line) else { continue };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(Value::as_str);
        let params = &request["params"];
        let result = match method {
            Some("search.query") => search(params),
            Some("search.ast_query") => ast_query(params),
            Some("search.abort") => continue,
            _ => {
                println!(
                    "{}",
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"method not found"}})
                );
                io::stdout().flush().ok();
                continue;
            }
        };
        match result {
            Ok((matches, truncated)) => println!(
                "{}",
                json!({"jsonrpc":"2.0","id":id,"result":{"matches":matches,"truncated":truncated}})
            ),
            Err(message) => println!(
                "{}",
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":message}})
            ),
        }
        io::stdout().flush().ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn languages_are_explicit() {
        assert!(language("typescript").is_ok());
        assert!(language("unknown").unwrap_err().contains("unsupported"));
    }
    #[test]
    fn invalid_regex_is_error() {
        assert!(search(&json!({"pattern":"[","path":"."})).is_err());
    }
}
