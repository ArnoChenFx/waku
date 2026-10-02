# 合并上游 main 的冲突解决记录（2026-09-15）

- 分支：`provider-custom-args`（HEAD `f2ebac1`）合并 `github.com/main`（`f595218`）
- 合并提交：`eb94951`
- 合并基点：`b68baed`
- 上游带来的主要内容：Cua Driver 跨平台接入（`crates/waku-computer-use`、`scripts/cua-*.ts`、`resources/computer-use/*`）与 Cursor 模型发现/模型参数修复（`968d42d`）

## 冲突一：`crates/waku-core/src/driver/acp.rs`（`CommandMessage::Options`）

两侧都重写了触发 `apply_model` 的条件行：

- 本分支（ours）：去掉 `provider == ProviderKind::Grok` 门控，让 reasoning effort 变化对所有 provider 都生效。
- 上游（theirs，`968d42d`）：同样去掉了 Grok 门控，并追加 `service_tier` / `context_window` 的比较。

解决：取并集，四个字段都参与比较：

```rust
if options.model != current_model
    || options.reasoning_effort != current_effort
    || options.service_tier != current_tier
    || options.context_window != current_window
```

`apply_model` 本体（含 tier/window 参数）与 `run_sdk_connection` 中 `current_tier` / `current_window` 的声明都来自上游，未冲突；本分支的 `extra_args` 注入（`launch.args.splice(0..0, extra_args)`）与 Windows 版 `sdk_agent`（`#[cfg(windows)]` 直启二进制）也都完整保留。

## 冲突二：`crates/waku-core/src/model_catalog.rs`（`discover_cursor_models`）

- 本分支：签名加了 `extra_args: &[String]`，把自定义启动参数传给 `cursor-agent models`。
- 上游：加了 ACP 扩展探测 `discover_cursor_models_via_acp`（`cursor/list_available_models`，返回基础 slug + 每模型 config options），非空时直接返回。

解决：保留 `extra_args` 参数，探测顺序按上游——先 ACP，再回退 CLI；自定义参数只作用于 CLI 回退路径（`catalog_agent` 不接收 extra_args，探测走生产启动契约）。若后续希望 ACP 探测也遵循自定义参数，需要在 `driver::catalog_agent` 上开放参数并同步 `acp_session.rs` 的调用方。

## 冲突之外、合并后才暴露的缺口

上游新增/改动的测试构造 `DriverStartOptions` 时还没有本分支新增的 `extra_args` 字段，合并后 `cargo check --workspace --all-targets` 报 E0063/E0061，已补齐：

- `crates/waku-core/src/driver/codex.rs`：`fork_releases_its_writer_before_a_new_driver_sends_a_message`（`#[cfg(unix)]`）、`codex_fork_preserves_history_and_both_sessions_against_real_cli`
- `crates/waku-core/src/driver/opencode2.rs`：`opencode2_session_against_the_adopted_service`、Cua 双会话测试
- `crates/waku-core/src/model_catalog.rs`：`opencode_effort_smoke::discovers_reasoning_efforts_from_the_installed_cli` 调用 `discover_opencode_models` 补 `&[]`

另需注意：`WireDriverStartOptions`（waku-protocol）与 `waku_client::DriverStartOptions` 都不带 `extra_args`，自定义参数由 daemon 从 `DaemonSettings.provider_extra_args` 读取（`daemon.rs` → `DriverStartOptions.extra_args`），因此客户端/桌面端无需改动即保持生效。

## 验证结果（本机 Windows）

- `cargo check --workspace --all-targets`：通过（无 error）
- `cargo test --locked`：全绿（waku-core 455 passed / 0 failed，含 driver 与 app 测试）
- `bun run --filter @waku/client check`：通过
- `packages/waku-client` 下 `bun test`：23 pass / 0 fail
- `cargo run -p waku-protocol --bin export_types -- --check`：通过（见下方 EOL 说明）
- 未执行：`scripts/test-computer-use.ts`（需要先构建并 bundle Cua 二进制，且本机不跑 bundle）

EOL 说明：本机 `core.autocrlf=true` 且仓库无 `.gitattributes`，凡被 merge/checkout 重写过的 `packages/waku-client/src/generated/*` 在磁盘上变成 CRLF，而生成器输出 LF，`protocol:check` 会误报 "generated bindings are stale"。已用 index blob 与磁盘字节逐一比对确认内容未漂移（sha1 相同），并按 CI（Linux）习惯把文件写回 LF。`git status` 仍会把这类文件显示为 `M`，但 `git diff` 为空、`git add` 不产生新 blob。
