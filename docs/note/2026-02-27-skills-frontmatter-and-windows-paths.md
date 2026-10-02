# Skills 页三项修复:块标量解析 / Windows 下 reveal 失效 / 路径分隔符混乱

日期:2026-02-27

## 问题与根因

### 1. Skill 列表不解析 YAML Literal Block Scalar

- 现象:`description: |` 的 skill(firecrawl-scrape 等)在列表里显示孤立的 `|`。
- 根因:`waku-core` 中两个手写 frontmatter 解析器(`skills.rs::parse_skill_frontmatter`
  与 `composer_complete.rs::parse_frontmatter`)只处理扁平的 `key: value` 行,
  遇到块标量指示符时把 `|` 本身当成了值。
- 顺带发现:旧解析器同样丢弃 `- item` 列表形式的 `allowed-tools`。

### 2. 「在文件管理器中显示」按钮在 Windows 下无效

- 根因(已经 Win32 实验证实):skill 根目录用 `home.join(".agents/skills")`
  这类扁平 join 构建,Windows 下产生混合分隔符路径
  (`C:\Users\ArnoChen\.agents/skills\...`)。GPUI 的
  `open_target_in_explorer` 走 `SHParseDisplayName` /
  `SHOpenFolderAndSelectItems`,而 Shell API 对含 `/` 的路径直接返回
  `E_INVALIDARG (0x80070057)` —— 实测:混合分隔符 → 解析失败;纯反斜杠 → OK。
- 按钮静默失败(GPUI 内部 `.log_err()`),无任何提示。

### 3. 复制路径出现正反斜杠混排

- 同一根因:`PathBuf` 里烘焙了 `/`,复制时 `dir.display()` 原样输出
  `C:\Users\ArnoChen\.agents/skills\exa-search`。

## 修复

1. 新增共享模块 `crates/waku-core/src/frontmatter.rs`:
   - 支持顶层 `key: value`(去引号)、literal(`|`)、folded(`>`)块标量、
     `- item` 列表(逗号连接)。
   - 块标量内容统一 collapse 为单行 prose(UI 各处均按单行渲染)。
   - 顶层键必须顶格;缩进行不会误判为键;块标量体内的冒号不再是键。
   - `skills.rs` 与 `composer_complete.rs` 两处解析器都改走该模块。
2. `skills.rs` 全部扁平 join 改为逐段嵌套 join(`&[".agents", "skills"]`),
   存储路径的分隔符全程平台原生 —— 列表展示、复制路径、reveal 同时受益。
   `every_ecosystem_root_is_listed` 测试改为按组件比较(Path::ends_with /
   组件相等),不再依赖分隔符文本。
3. `platform.rs::reveal_in_file_manager` 在 Windows 下把 `/` 规范化为 `\`,
   兜底其他来源(browser 下载、附件等)可能带入的混合分隔符路径。

## 验证

- `cargo test -p waku-core`:新增 9 个测试全绿(frontmatter 8 个 +
  skills 块标量扫描 1 个);既有测试除 5 个环境性失败外全部通过(见下)。
- `cargo check -p waku`:通过;dev watcher 重编译并重启了调试版应用。
- PowerShell P/Invoke 实验复现并确认根因(SHParseDisplayName 对混合分隔符
  返回 0x80070057)。

## 本机已知的环境性测试失败(非本次引入)

- `checkpoint` / `worktree` / `driver::{codex,opencode}` 共 4 个:CRLF
  (`\r\n`)与 git 环境差异导致。
- `composer_complete::every_provider_offers_slash_commands_out_of_the_box`:
  该测试非密封 —— user-scope 扫描会读到真实主目录,本机存在
  `~/.claude/commands/commit.md`(expand=false,template=None),按 User >
  Builtin 的去重优先级遮蔽了内置 `commit`(template=Some),断言失败。
  CI 空环境下可通过。
