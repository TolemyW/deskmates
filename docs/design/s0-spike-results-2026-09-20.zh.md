# S0 验证周结果

日期:2026-09-20
对应文档:`docs/design/design-cogbot-thin-core-v0.2-2026-09-20.md` 第 8 节 S0
代码与日志:`spikes/s0/`(test-a、test-b、test-c 三个目录,可重复运行)

环境:macOS,Node 23.6,`@anthropic-ai/claude-agent-sdk` 0.3.278(内置 Claude Code 2.1.278),`@playwright/mcp` 0.0.82,`@playwright/cli` 0.1.21,Docker 28.3(colima,linux/arm64),容器镜像基于 `mcr.microsoft.com/playwright:v1.58.2-noble`。模型调用用 `claude-haiku-4-5-20251001` 降本,每次 run 约 0.03 到 0.05 美元。

## 结论一览

| 假设 | 结果 | 证据 |
|---|---|---|
| (b) L2 动作停下、进程退出、session resume 续跑 | **通过** | test-b:step1 进程退出后,step2 新进程 resume,被推迟的命令在批准后执行,agent 回复 DONE |
| (b') 短等待:回调进程内阻塞 20 秒后放行 | **通过** | test-b/short-wait:回调等待 20004 ms,AbortSignal 未触发,工具执行,run 成功 |
| (c) 一个 Chromium 同时被 Playwright MCP 和 noVNC 使用 | **通过** | test-c:8 项检查全部符合预期(见下) |
| (c') Playwright CLI 也能接入同一个浏览器 | **通过(文档级)** | `playwright-cli attach --cdp=http://localhost:9222` 是官方支持的命令 |
| (a) SDK 经 Base URL 代理跑通流式 + 工具 + cache | **通过** | test-a/run-endpoint:经模型网关(Anthropic 协议)用 glm-5.3 和 deepseek-v4.1-flash 各跑一次,两次工具调用都执行,agent 回复 DONE,`cache_read_input_tokens` 非零 |
| (a') 模型可换 | **通过** | 同一脚本只改 `SPIKE_MODEL`,两个非 Anthropic 模型都完成任务 |

## (a) 模型代理:细节

分两步。第一步用本地反向代理(`test-a/proxy.mjs`)记录 SDK 发出的每个请求;第二步用真实的模型网关(Anthropic 协议,URL 不在此记录)跑完整 agent 循环(`test-a/run-endpoint.mjs`)。

### 第二步:真实网关端到端

| 项 | glm-5.3 | deepseek-v4.1-flash |
|---|---|---|
| 工具调用次数(hook 观测) | 2 | 2 |
| 标记文件写出并回读 | 是 | 是 |
| 最终回复 | DONE | DONE |
| SDK 报告的 `cache_read_input_tokens` | 18176 | 18560 |
| 壁钟时间 | 14.0 s | 7.0 s |

网关行为观测:

- 认证只接受 `Authorization: Bearer <key>`,`x-api-key` 返回 `Authorization required`。SDK 侧对应环境变量是 `ANTHROPIC_AUTH_TOKEN`,不是 `ANTHROPIC_API_KEY`。
- 流式响应是标准 Anthropic SSE:`message_start`、`content_block_start`(含 `thinking` 和 `tool_use` 两种块)、`input_json_delta`、`message_delta` 带 `stop_reason: tool_use`、`message_stop`。
- 单次 curl 请求的 `usage` 只有 `input_tokens` 和 `output_tokens`,没有 cache 字段;但 SDK 多轮之后报告了非零 `cache_read_input_tokens`,说明网关在后续轮次会回传 cache 命中。
- 响应里的 `model` 字段是网关内部名(如 `glm53-internal`),SDK 的 `modelUsage` 仍按请求的模型名记账,`costBasis` 为 `unknown`,成本数字不可信,需 Gateway 自己按 token 计价。

### 第一步:本地代理观测

SDK 发出的请求特征,模型代理必须原样透传:

- 路径 `POST /v1/messages?beta=true`
- 请求体 `stream: true`,含 `system`、`tools`(29 个内置工具定义)、`cache_control` 块(2 处)
- 请求头 `anthropic-beta`,值为逗号分隔的多个 beta 标记,包括 `prompt-caching-scope-2026-01-05`、`extended-cache-ttl-2025-04-11`、`interleaved-thinking-2025-05-14`、`claude-code-20250219` 等
- 请求头 `anthropic-version: 2023-06-01`
- 响应必须是 SSE 流,代理不能缓冲整段再返回

附带发现:本机 SDK 默认用的是 Claude Code 登录态的 OAuth Bearer token。同一 token 直连成功(test-b 就是直连),经本地代理转发到 Anthropic 则返回 `403 Request not allowed`。这说明**订阅 OAuth 凭证不能经第三方 Base URL 转发**,模型代理必须自己持有 API key 并在出口注入。这与 v0.2 第 3.2 节"bot 不持有上游 key"的设计一致。第二步改用 模型网关的 key 后问题消失。

## (b) 审批落盘续跑:细节

SDK 原生支持这个流程,不需要 v0.2 里写的"结构化拒绝"变通:`PreToolUse` hook 返回 `permissionDecision: "defer"`,query 立即结束并返回 session id;之后用 `resume: sessionId` 重开,SDK 会把被推迟的工具调用重新走一遍 hook,此时放行即执行。

观测到的时序(test-b):

| 步骤 | 事件 |
|---|---|
| step1 | agent 执行 L0 命令(hook 放行),文件 `L0-DONE.txt` 写出 |
| step1 | agent 请求 L2 命令,hook 返回 `defer`,run 以 `success` 结束,`L2-DONE.txt` 不存在,进程退出 |
| step2(新进程) | `resume` 同一 session,hook 再次收到同一条 L2 命令,放行 |
| step2 | `L2-DONE.txt` 写出,agent 回复 DONE |

短等待模式(test-b/short-wait):`canUseTool` 回调 `await` 20 秒后返回 allow,SDK 没有超时,工具正常执行。文档说明回调可以无限期挂起。

对 v0.2 的修正:第 3.5 节"落盘续跑"改为直接使用 `defer`,不再需要让 agent 输出中途摘要;中途摘要可以作为可选的用户提示由 sidecar 自己生成。

## (c) 共享浏览器:细节

test-c 在一个容器里启动 Xvfb、fluxbox、x11vnc、noVNC(websockify)和一个带 `--remote-debugging-port=9222 --user-data-dir=/profile` 的 headed Chromium,然后:

| 检查 | 结果 | 说明 |
|---|---|---|
| Playwright MCP `--cdp-endpoint` 接入已运行的 Chromium | 通过 | 31 个工具,含 `--caps vision` 带来的 `browser_mouse_click_xy` 等 3 个坐标工具 |
| MCP 导航并取无障碍树快照 | 通过 | |
| 无障碍树能否看到 closed shadow root 里的按钮 | **看不到**(符合预期) | 证实 v0.2 C3 的盲区假设 |
| 人在 X11 层点击(xdotool,等价于 noVNC 用户点击) | 通过 | 页面标题变为 PLAIN CLICKED |
| agent 随后的 MCP 快照能看到人的操作结果 | 通过 | 同一浏览器、同一页面,状态共享 |
| 视觉回退:MCP 坐标点击命中 shadow 按钮 | 通过 | 页面标题变为 SHADOW CLICKED |
| VNC 帧可抓取,noVNC 在 6080 监听 | 通过 | |
| MCP 写入的 cookie 落到 `/profile/Default/Cookies` | 通过 | 登录态跨 run 持久的前提成立 |

第一次运行超时,原因是容器内用 `npx @playwright/mcp@latest` 触发下载。生产镜像必须预装 MCP,不能在 run 时拉包。

Playwright CLI:`playwright-cli attach --cdp=<url>` 官方支持,`--persistent` 和 `--profile` 支持持久 profile,`-s=<session>` 支持多会话。三种驱动方式共用一个 Chromium 的前提成立。

## 对 v0.2 的修改建议

1. 第 3.5 节:落盘续跑直接用 SDK 的 `defer`;删除"agent 输出中途摘要"这一步。
2. 第 3.2 节:明确 模型代理必须持有 API key 并在出口注入,订阅 OAuth 凭证不可转发。沙箱侧用 `ANTHROPIC_AUTH_TOKEN` 注入网关短期 token。成本以 Gateway 自己按 token 计价为准,不信 SDK 的 `costUSD`。
3. 第 3.3 节:MCP 启动参数固定为 `--cdp-endpoint http://127.0.0.1:9222 --caps vision`;CLI 用 `attach --cdp`。
4. 第 8 节 S0:(a)(b)(c) 全部标记已验证。
5. 第 12 节风险"审批落盘后 session resume 失败":概率从"中"降到"低"。

## 未验证的部分

- session 文件跨主机:test-b 两步在同一台机器。跨容器重建需要 `SessionStore` 适配器或把 `~/.claude/projects/<cwd>/<id>.jsonl` 挂到持久卷,v0.2 的沙箱设计里 `/home/bot` 是持久卷,可满足,但没跑过。
- 人接管期间给浏览器"加锁"让 MCP 工具返回等待:这是 sidecar 逻辑,不是 SDK 或 Playwright 的能力,本次没有实现。
- 长时间(小时级)的 `defer` 后 resume:本次间隔约 3 分钟。
- 出网白名单在容器网络层的实现。
