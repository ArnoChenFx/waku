use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::computer_use::ComputerAppGrant;
use crate::model::ProviderKind;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(default)]
pub struct DaemonSettings {
    pub computer_use_enabled: bool,
    pub computer_use_allowed_apps: Vec<ComputerAppGrant>,
    pub disabled_providers: Vec<ProviderKind>,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub provider_binary_overrides: HashMap<ProviderKind, String>,
    /// Per-provider custom launch arguments from the Providers settings,
    /// inserted right after the binary (e.g. codex --profile work).
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub provider_extra_args: HashMap<ProviderKind, Vec<String>>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Default for DaemonSettings {
    fn default() -> Self {
        Self {
            computer_use_enabled: false,
            computer_use_allowed_apps: Vec::new(),
            disabled_providers: Vec::new(),
            provider_binary_overrides: HashMap::new(),
            provider_extra_args: HashMap::new(),
            extra: BTreeMap::new(),
        }
    }
}

impl DaemonSettings {
    pub fn default_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join(".waku")
            .join("settings.json")
    }

    pub fn discard_legacy_app_keys(&mut self) {
        for key in ["analytics_enabled", "favorite_models", "theme", "language"] {
            self.extra.remove(key);
        }
    }
}

/// Splits a free-form launch-argument line into the argv tokens Waku appends
/// to a provider's binary.
///
/// Tokens are separated by runs of whitespace. A token wrapped in double
/// quotes keeps its inner spaces (`--config "my dir"`), so one quoted segment
/// reaches the CLI as a single argument. Quotes are not shell quoting: no
/// escaping, no expansion, and an unmatched quote simply delimits nothing.
pub fn parse_arg_list(text: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut has_token = false;
    for ch in text.chars() {
        match ch {
            '"' => in_quotes = !in_quotes,
            ch if ch.is_whitespace() && !in_quotes => {
                if has_token || !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            ch => {
                current.push(ch);
                has_token = true;
            }
        }
    }
    if has_token || !current.is_empty() {
        args.push(current);
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arg_list_splits_on_whitespace() {
        assert_eq!(parse_arg_list(""), Vec::<String>::new());
        assert_eq!(parse_arg_list("   "), Vec::<String>::new());
        assert_eq!(
            parse_arg_list("--profile  work"),
            vec!["--profile".to_owned(), "work".to_owned()]
        );
    }

    #[test]
    fn arg_list_keeps_quoted_segments_together() {
        assert_eq!(
            parse_arg_list("--config \"my dir\" -v"),
            vec![
                "--config".to_owned(),
                "my dir".to_owned(),
                "-v".to_owned(),
            ]
        );
    }

    #[test]
    fn daemon_settings_keep_provider_extra_args_across_round_trip() {
        let mut settings = DaemonSettings::default();
        settings
            .provider_extra_args
            .insert(ProviderKind::Codex, vec!["--profile".into(), "work".into()]);
        let encoded = serde_json::to_string(&settings).unwrap();
        let decoded: DaemonSettings = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, settings);

        // Old settings without the key still load, with the map empty.
        let legacy: DaemonSettings =
            serde_json::from_str(r#"{"provider_binary_overrides":{}}"#).unwrap();
        assert!(legacy.provider_extra_args.is_empty());
    }
}