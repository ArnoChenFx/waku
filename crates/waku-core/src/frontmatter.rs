//! Minimal YAML-frontmatter key scanning shared by the slash-command picker
//! and the Skills page.
//!
//! Both surfaces need only a few top-level keys out of a `SKILL.md` or
//! command file's leading block. A real YAML parser is overkill — and a parse
//! failure must never cost an entry its listing — so this walks top-level
//! `key: value` lines plus the literal (`|`) and folded (`>`) block scalars
//! skill authors routinely use for long descriptions. Anything the scanner
//! does not understand is skipped; an unparsed extra key costs nothing.

/// Yield each top-level `(key, value)` pair of a frontmatter block, in order.
///
/// Inline values lose surrounding quotes. A header whose value is a block-
/// scalar indicator (`|`, `>`, with optional chomping `-`/`+`) collects the
/// more-indented lines beneath it and resolves them onto the key. Values
/// surface as one-line prose in every caller, so all whitespace — including
/// the breaks a literal scalar preserves — collapses to single spaces.
pub fn entries(block: &str) -> Vec<(String, String)> {
    let lines: Vec<&str> = block.lines().collect();
    let mut pairs = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        index += 1;
        // Top-level keys start in column zero; indented lines belong to a
        // list, a nested map, or a block scalar consumed below.
        if line.starts_with([' ', '\t']) {
            continue;
        }
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = rest.trim();
        if value.is_empty() {
            // A bare key may head a `- item` list; join its entries so keys
            // like `allowed-tools` survive the list form most skills use.
            let mut items: Vec<String> = Vec::new();
            while index < lines.len() {
                let next = lines[index];
                if !next.starts_with([' ', '\t']) {
                    break;
                }
                let Some(item) = next.trim().strip_prefix("-") else {
                    break;
                };
                items.push(
                    item.trim()
                        .trim_matches('"')
                        .trim_matches('\'')
                        .to_owned(),
                );
                index += 1;
            }
            if !items.is_empty() {
                pairs.push((key.to_owned(), items.join(", ")));
            }
            continue;
        }
        // Block scalars put their content on the following more-indented
        // lines; only the indicator sits after the colon.
        let literal = match value {
            "|" | "|-" | "|+" => true,
            ">" | ">-" | ">+" => false,
            _ => {
                let value = value.trim_matches('"').trim_matches('\'').to_owned();
                if !value.is_empty() {
                    pairs.push((key.to_owned(), value));
                }
                continue;
            }
        };
        let (text, consumed) = collect_block_scalar(&lines[index..], literal);
        index += consumed;
        let text = collapse_whitespace(&text);
        if !text.is_empty() {
            pairs.push((key.to_owned(), text));
        }
    }
    pairs
}

/// Collect the body of one block scalar from the lines after its header.
/// Returns the joined text and how many lines were consumed. The block's
/// indent comes from its first non-empty line; a less-indented later line
/// ends the block. Literal scalars join with line breaks, folded ones with
/// spaces.
fn collect_block_scalar(lines: &[&str], literal: bool) -> (String, usize) {
    let mut consumed = 0;
    // Blank lines before the first content line set no indent.
    while consumed < lines.len() && lines[consumed].trim().is_empty() {
        consumed += 1;
    }
    let Some(first) = lines.get(consumed) else {
        return (String::new(), consumed);
    };
    let indent = first.len() - first.trim_start().len();
    let mut pieces: Vec<&str> = Vec::new();
    while consumed < lines.len() {
        let line = lines[consumed];
        if line.trim().is_empty() {
            pieces.push("");
            consumed += 1;
            continue;
        }
        if line.len() - line.trim_start().len() < indent {
            break;
        }
        pieces.push(line.get(indent..).unwrap_or(line.trim()));
        consumed += 1;
    }
    // Clip chomping: trailing blank lines carry no content once whitespace
    // collapses anyway.
    while pieces.last().is_some_and(|piece| piece.is_empty()) {
        pieces.pop();
    }
    let joiner = if literal { "\n" } else { " " };
    (pieces.join(joiner), consumed)
}

/// Collapse every whitespace run — including the line breaks a literal block
/// scalar preserves — to single spaces. Descriptions render as one-line prose
/// everywhere they surface, so the distinction carries no information.
fn collapse_whitespace(text: &str) -> String {
    let mut collapsed = String::with_capacity(text.len());
    let mut pending_space = false;
    for character in text.chars() {
        if character.is_whitespace() {
            pending_space = !collapsed.is_empty();
        } else {
            if pending_space {
                collapsed.push(' ');
                pending_space = false;
            }
            collapsed.push(character);
        }
    }
    collapsed
}

/// Parse the leading YAML frontmatter block used by commands and skills.
///
/// Unknown and unsupported values are ignored so a hand-written prompt still
/// stays listed. YAML syntax, including folded and literal block scalars, is
/// handled by `serde-saphyr`.
pub(crate) fn parse_frontmatter_fields<'a>(
    contents: &'a str,
    mut visit: impl FnMut(&str, String),
) -> &'a str {
    let Some(rest) = contents.strip_prefix("---") else {
        return contents;
    };
    let Some((block, body)) = rest.split_once("\n---") else {
        return contents;
    };

    if let Ok(fields) = serde_saphyr::from_str::<serde_json::Map<String, serde_json::Value>>(block)
    {
        for (key, value) in fields {
            if let Some(value) = frontmatter_value(value) {
                visit(&key, value);
            }
        }
    }

    body.trim_start_matches(['-']).trim_start()
}

fn frontmatter_value(value: serde_json::Value) -> Option<String> {
    let value = match value {
        serde_json::Value::String(value) => value,
        // Preserve the bracket notation historically accepted by command
        // metadata such as `argument-hint: [pr-number]`.
        serde_json::Value::Array(values) => {
            let values = values
                .into_iter()
                .map(|value| value.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()?;
            format!("[{}]", values.join(", "))
        }
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::Null | serde_json::Value::Object(_) => return None,
    };
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_pairs_lose_their_quotes() {
        let pairs = entries("\nname: deploy\ndescription: \"Ship it\"\nallowed-tools: Bash");
        assert_eq!(
            pairs,
            vec![
                ("name".into(), "deploy".into()),
                ("description".into(), "Ship it".into()),
                ("allowed-tools".into(), "Bash".into()),
            ]
        );
    }

    #[test]
    fn literal_block_scalar_joins_its_lines() {
        let pairs = entries(
            "\nname: scrape\ndescription: |\n  First line.\n  Second line.\nallowed-tools:\n  - Bash(x *)",
        );
        assert_eq!(
            pairs,
            vec![
                ("name".into(), "scrape".into()),
                ("description".into(), "First line. Second line.".into()),
                ("allowed-tools".into(), "Bash(x *)".into()),
            ]
        );
    }

    #[test]
    fn bare_key_without_a_list_stays_absent() {
        let pairs = entries("\nallowed-tools:\nnested:\n  key: value\nafter: yes");
        // `nested:`'s map is not a list; its indented lines are never pairs.
        assert_eq!(pairs, vec![("after".into(), "yes".into())]);
    }

    #[test]
    fn folded_block_scalar_joins_with_spaces() {
        let pairs = entries("\ndescription: >-\n  Para one\n  continues.\n\n  Para two.");
        assert_eq!(pairs, vec![("description".into(), "Para one continues. Para two.".into())]);
    }

    #[test]
    fn block_scalar_ends_at_less_indented_key() {
        let pairs = entries("\ndescription: |\n  Indented prose.\nname: after");
        assert_eq!(
            pairs,
            vec![
                ("description".into(), "Indented prose.".into()),
                ("name".into(), "after".into()),
            ]
        );
    }

    #[test]
    fn colons_inside_block_scalars_are_not_keys() {
        let pairs = entries("\ndescription: |\n  Use whenever: the user provides a URL\nname: x");
        assert_eq!(pairs.len(), 2);
        assert_eq!(pairs[0].1, "Use whenever: the user provides a URL");
    }

    #[test]
    fn list_items_join_onto_their_key() {
        let pairs = entries("\nallowed-tools:\n  - Bash(firecrawl *)\n  - Read\nskip: ok");
        assert_eq!(
            pairs,
            vec![
                ("allowed-tools".into(), "Bash(firecrawl *), Read".into()),
                ("skip".into(), "ok".into()),
            ]
        );
    }

    #[test]
    fn deeper_indented_lines_stay_in_the_block() {
        let pairs = entries("\ndescription: |\n  First.\n    Nested deeper.\nname: x");
        assert_eq!(pairs[0].1, "First. Nested deeper.");
    }

    #[test]
    fn quoted_inline_values_with_colons_keep_their_text() {
        let pairs = entries("\ndescription: \"Use it: always\"");
        assert_eq!(pairs, vec![("description".into(), "Use it: always".into())]);
    }
}
