# 修复：空闲一段时间后「无法保存本地状态：Waku daemon is disconnected」

日期：2026-08-21
分支：log2
涉及文件：

- `crates/waku-core/src/server.rs`（守护进程侧 WebSocket 读循环）
- `crates/waku-client/src/client.rs`（桌面端 WebSocket 客户端）
- `crates/waku-client/src/process.rs`（daemon supervisor）

## 现象

应用闲置一段时间（无操作、无任务）后，界面反复弹出「无法保存本地状态：Waku daemon is disconnected」，直到重启应用才恢复。`daemon.log` 中对应记录：

```
[WARN] [waku_core::server] connection ended: Waku daemon WebSocket failed:
IO error: 重叠 I/O 操作在进行中。 (os error 997)
```

## 根因

两层问题叠加：

1. **误杀连接（根因）**：双方稳态读都依赖 `SO_RCVTIMEO` 轮询（守护进程 25ms、客户端 25ms）。Windows 上 std 的阻塞 socket 读内部走重叠 I/O，超时与重叠完成竞争时读操作会以原始错误码 **997（ERROR_IO_INCOMPLETE / WSA_IO_PENDING）** 冒出，而不是 `ErrorKind::TimedOut`。`retryable_error()` 只认 WouldBlock/TimedOut/Interrupted（unix 另加 EAGAIN），997 被当成致命错误 → 守护进程主动断开健康空闲连接。同类的公开先例：ALVR #1814「os error 997 causes disconnection randomly」，上游以 PR #2522「Ignore error 997 (overlapped IO)」修复。
2. **无自愈（放大器）**：`monitor_daemon` 只在「子进程退出」或「二进制变化（dev 热重建）」时重启 daemon。socket 断了但进程还活着时，supervisor 永远不会恢复连接，客户端的 `disconnected` 标志一直置位，之后每次保存草稿/会话状态都报错。

## 修复

### 1. os error 997 视为可重试

`server.rs` 与 `client.rs` 的 `retryable_error()` 各加一个 `#[cfg(windows)]` 分支：`raw_os_error() == Some(997)` 时重试。997 表示重叠操作仍在进行、未消费任何数据，重试读取安全；若连接确实已死，下一次读会返回 ConnectionReset/ConnectionClosed 并正常退出循环。

新增测试：`overlapped_io_incomplete_timeouts_are_retryable`（两个 crate 各一份）。

### 2. supervisor 断线自愈（兜底）

- `DaemonClient::is_disconnected()`：暴露读线程退出标志。
- `DaemonProcess` 保存 `address`/`token`，新增 `reconnect()`：携带旧连接的 replay 游标（`last_sequences()`）重新握手，守护进程可重放断线期间的事件；**不杀子进程**，避免误伤 daemon 内可能仍在运行的任务。
- `monitor_daemon` 重构为三态 `Recovery { None, ReconnectSocket, Respawn }`：
  - 进程退出或二进制变化 → 原有整体重启；
  - 进程存活但 socket 断开 → 先尝试 socket 重连并 `publish_client()` 广播新连接（task-state sync 等订阅者自动换线）；失败（僵死/握手被拒）再回退整体重启。

## 验证

- `cargo check --workspace` 通过；`cargo test -p waku-client` 全绿（11 passed）。
- 新增的两个 997 测试通过。
- waku-core 有 6 个既有失败（checkpoint/skills/worktree 等，CRLF 与本机 git 环境相关），已用 `git stash` 验证与本次改动无关。

## 备注

- 远程 daemon（`DaemonTarget::Remote`）仍无自动重连，本次未覆盖。
- 若后续仍观察到空闲断连，可在 WAKU_LOG=info 下观察重连日志确认自愈路径生效。
