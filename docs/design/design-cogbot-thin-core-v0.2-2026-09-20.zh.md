# CogBot 设计文档与场景可行性评估

日期:2026-09-20
状态:草案 v0.2(基于 v0.1 修订;2026-09-20 已用 S0 验证结果更新,见 `docs/design/s0-spike-results-2026-09-20.md`)
范围:对标 xAI Grok Bot 的"常驻 bot + 自有电脑 + 浏览器操作"产品,采用薄核自研路线;并评估该设计能否支撑三个业务场景。

---

## 0. 文档说明与 v0.2 变更

本文分两部分。第 1 到 9 节是设计文档,第 10 到 12 节是场景评估。

评估口径不变:

- **可行性等级**:高 / 中高 / 中 / 中低 / 低,指"在 6 个月内做出可交付、可度量的版本"的把握。
- **平台覆盖度**:通用底座能覆盖该场景工作量的比例。

### v0.2 相对 v0.1 的变更

| 编号 | 变更 | 原因 |
|---|---|---|
| C1 | 审批从"进程内挂起"改为"短等待 + 落盘续跑"双模式 | 人离线数小时时,长期挂起的进程不可靠 |
| C2 | 调度拆成交互道和后台道 | 聊天不能排在两小时的 cron 任务后面 |
| C3 | 浏览器增加人机交接协议、视觉回退、省 token 模式 | 无障碍树看不到 shadow DOM 和 canvas;长会话 token 成本高 |
| C4 | 凭证策略统一为一处描述 | v0.1 的 3.8 与 3.10 互相矛盾 |
| C5 | 出网策略改为默认拒绝、按 bot 白名单 | L0 浏览也能通过 URL 外泄数据,审批挡不住 |
| C6 | 执行面抽象为 Sandbox Provider 接口 | Docker 之外还要能跑在 Desktop VM 或托管沙箱 |
| C7 | 新增 S0 验证周,里程碑总长从 14 周调到 16 周 | 三个关键假设必须先证实 |
| C8 | 技术选型补充 Managed Agents 等被放弃的托管方案 | v0.1 没有说明为什么不用托管方案 |
| C9 | tty 交互工具从"领域层"移入底座 | 三个场景都需要跑交互式 CLI |
| C10 | 风险矩阵新增两项 | 无障碍树盲区;续跑失败 |

### v0.2.1 修订(2026-09-20,回答"容器模型怎么共享浏览器登录态")

| 编号 | 变更 | 原因 |
|---|---|---|
| C11 | 新增身份对象与身份主机,登录态归属从 bot 改为身份 | v0.2 的 3.8 写"后续 bot 直接用",与"一 bot 一沙箱、登录态只在沙箱卷"矛盾。实际只做到同一 bot 跨 run 持久,跨 bot 无法共享 |
| C12 | 共享方式定为 CDP 借用,明确否决共享卷 | Chromium 的 SingletonLock 与 Cookies/LevelDB 单写者限制,共享卷并发必然损坏 profile |
| C13 | 浏览器锁粒度从"整个浏览器"细化为"身份 × origin" | 多 bot 借用同一身份时,不同站点应可并行 |
| C14 | 数据模型新增 identities / identity_grants / identity_leases / identity_events | 授权、租约、审计需要落库 |
| C15 | 风险矩阵新增共享身份影响面与掉登录两项 | 共享登录态等于共享凭证 |

C11 的机制已被 S0 的 test-c 间接验证:一个 Chromium 被多个 CDP 客户端并发接入且状态互通。待验证的增量是跨沙箱接入和身份代理的 origin 拦截,建议并入 M1。

---

## 1. 背景与目标

### 1.1 对标对象

Grok Bot(2026-08-11 发布)的产品形态:一组有名字、有岗位的常驻 agent,每个 bot 独占一台持久云电脑(浏览器、文件系统、终端),登录用户现有的 SaaS 和网站,按计划或事件自动干活,只有需要审批时才回来找人。客户端覆盖 macOS、Windows、Linux、iOS、Android。

它的已知短板:不能自托管,模型单一供应商,记忆是黑盒且不可导出,多 bot 之间没有安全隔离,结构化任务约五分之一失败。

### 1.2 本设计的目标

1. 达到 Grok Bot 的八项核心能力(持久电脑、浏览器操作、常驻触发、连接器、审批门禁、多 bot 协作、记忆、客户端)。
2. 在四个短板上超越:可自托管、模型可换、记忆可查可改可导出、每 bot 独立隔离。
3. 底座尽量薄,agent 循环和浏览器操作都用标准件,自研代码集中在产品层。
4. 与现有资产衔接:桌面端 VM、外部模型代理与 skill 市场、数据库 MCP Server 与 数据库 skill。
5. 执行面可替换:同一套 Gateway 能把 bot 跑在 Docker、Desktop VM 或第三方托管沙箱上。

### 1.3 非目标

- 不做通用多公司治理平台(预算硬停、多人 RBAC、审计合规)。需要时把本底座作为 Paperclip 的一个 adapter 接入。
- 不自研 agent 推理循环、不自研浏览器 DOM 理解模型。
- 不做移动客户端(第一阶段)。
- 不承诺替代人做业务判断(见第 10 节)。
- 不做交易执行(量化场景只到研究,不到下单)。

---

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│  客户端                                                        │
│  Web UI(首选) · 桌面客户端 · Slack/Telegram   │
└───────────────┬──────────────────────────────────────────────┘
                │ HTTPS + SSE
┌───────────────▼──────────────────────────────────────────────┐
│  Gateway(控制面,单进程,Node.js + SQLite)                      │
│  ├─ Bot Registry     名字/岗位/SOUL.md/MEMORY.md/连接器白名单     │
│  ├─ Run Scheduler    交互道 + 后台道;chat · cron · webhook · bot │
│  ├─ Approval Broker  短等待 / 落盘续跑;Allow once / Always / Deny│
│  ├─ Bot Bus          bot 之间消息,允许列表 + 中继上限             │
│  ├─ Knowledge Store  团队共享知识库(markdown + SQLite FTS)        │
│  ├─ Run Ledger       run 记录、日志、截图、token 成本               │
│  ├─ Secrets Store    OAuth refresh token(加密),签发短期 token    │
│  ├─ Egress Policy    每 bot 出网白名单,默认拒绝                    │
│  └─ Connector Hub    MCP 注册表 · Composio                        │
└───────────────┬──────────────────────────────────────────────┘
                │ Sandbox Provider 接口(create / exec / attach / snapshot)
┌───────────────▼──────────────────────────────────────────────┐
│  Bot Computer(执行面,每 bot 一个沙箱)                          │
│  Provider: Docker(默认)· 桌面端 VM · 托管沙箱(后补)    │
│  ├─ Sidecar          run 生命周期、工具拦截、日志、截图、健康上报    │
│  ├─ Agent Loop       Claude Agent SDK,模型经模型代理        │
│  ├─ Browser Client   Playwright MCP / CLI,--cdp-endpoint 指向身份  │
│  │                   默认指向本沙箱私有身份;共享身份指向身份主机    │
│  ├─ Shell + FS + tty /work 持久卷,/home/bot 私有记忆,pty 工具    │
│  └─ Runtime Tools    连接器 MCP(数据库、GitHub、Slack…)          │
└───────────────┬──────────────────────────────────────────────┘
                │ CDP over 身份代理(认证 · origin 白名单 · 锁 · 审计)
┌───────────────▼──────────────────────────────────────────────┐
│  Identity Host(每个共享身份一个沙箱,登录态的唯一所有者)         │
│  ├─ Chromium         单实例,--user-data-dir=/profile 持久卷      │
│  ├─ CDP Endpoint     多 bot 并发 attach,各开各的 tab            │
│  ├─ Screen           Xvfb + noVNC,人工登录 / MFA / 接管          │
│  └─ Keeper           会话保活、失效检测、storageState 加密快照     │
└──────────────────────────────────────────────────────────────┘
```

设计原则:

- **控制面薄**:Gateway 只做注册、调度、审批、消息、账本、密钥、出网策略,不碰模型推理。
- **执行面标准件**:agent 循环用 Claude Agent SDK,浏览器用 Playwright,桌面接管用 noVNC。
- **一 bot 一沙箱,一身份一 profile**:bot 的隔离边界和登录态的归属边界是两件事。私有身份的 profile 在 bot 沙箱卷里;共享身份的 profile 只在身份主机的卷里,bot 通过 CDP 借用,任何 bot 都拿不到 profile 文件本身。Gateway 只持有加密的 refresh token,签发短期 token 进沙箱。
- **一切 run 可追溯,可续跑**:每次触发落一条 run;run 可以因审批停下,几小时后从同一位置续跑。
- **默认不出网**:每个 bot 只能访问白名单域名,白名单由人维护,bot 不能自己改。

---

## 3. 核心组件

### 3.1 Bot 定义

| 项 | 位置 | 说明 |
|---|---|---|
| `SOUL.md` | 沙箱 `/home/bot/` | 身份、岗位、口吻、边界。人可编辑,版本化 |
| `MEMORY.md` | 沙箱 `/home/bot/` | 隐性规则。agent 可追加,人可删改 |
| `memory/YYYY-MM-DD.md` | 沙箱 `/home/bot/` | 每日工作笔记,run 结束自动追加 |
| `skills/` | 沙箱 `/home/bot/` | 安装的技能,来自 skill 市场或本地 |
| bot 行 | Gateway SQLite | 名字、岗位、模型、连接器白名单、出网白名单、审批规则、cron、sandbox provider |

记忆三层不变:bot 私有文件、团队共享知识库、run 账本。全部明文 markdown 或 SQLite。

### 3.2 Agent Loop

- 使用 Claude Agent SDK,默认模型 `claude-opus-5`,可按 bot 切到 `claude-sonnet-5` 降本。模型请求经模型代理转发,bot 不持有上游 key。
- **代理要求**:Proxy 必须透传 `POST /v1/messages?beta=true`、`stream: true` 的 SSE 响应、`tools` 定义、`cache_control` 块、`anthropic-beta` 与 `anthropic-version` 请求头。S0 已用本地代理确认 SDK 会把这些全部发到 `ANTHROPIC_BASE_URL`。
- **凭证结论(S0 验证)**:订阅 OAuth 凭证经第三方 Base URL 转发会被上游拒绝(403)。Proxy 必须自己持有上游 key,在出口注入。沙箱内只放 Proxy 签发的短期 token,通过 `ANTHROPIC_AUTH_TOKEN` 注入(Bearer),不放任何上游凭证。
- **端到端结论(S0 验证)**:已用模型网关(Anthropic 协议)跑通完整 agent 循环,glm-5.3 与 deepseek-v4.1-flash 各完成两次工具调用,`cache_read_input_tokens` 非零。模型可换这一目标成立。SDK 的 `costUSD` 对非 Anthropic 模型不可信,成本由 Gateway 按 token 自行计价。
- 每次 run 的输入:`SOUL.md` 作为系统提示、`MEMORY.md` 和最近 3 天日记、本次触发载荷、知识库检索前 5 条、可用工具清单。
- 输出:最终回复加结构化"run 摘要":做了什么、改了哪些文件、访问了哪些站点、待审批项、建议追加到 `MEMORY.md` 的规则。
- 会话续接:按 `(bot, thread)` 保存 SDK session id。审批续跑、同线程续聊都用 SDK 的 session resume。SOUL 变更后重开。

### 3.3 浏览器运行时

**单实例原则**:沙箱内只跑一个 headed Chromium,开 CDP 端口。Playwright、noVNC 里的人、截图 sidecar 都连同一个实例。profile 持久在卷上。

**三种驱动方式,按需切换**:

| 方式 | 用途 | 何时用 |
|---|---|---|
| Playwright MCP(无障碍树),启动参数 `--cdp-endpoint http://127.0.0.1:9222 --caps vision` | 探索未知页面 | 默认 |
| Playwright CLI,`attach --cdp=http://127.0.0.1:9222` | 长会话、回归、批量操作 | 稳定流程固化后;token 敏感任务 |
| 视觉回退(截图 + 坐标操作) | 无障碍树失效时 | shadow DOM、canvas、图片按钮、验证码前一步 |

S0 已验证:三者可以接到同一个 Chromium;closed shadow root 里的按钮在无障碍树中不可见,坐标点击可命中。镜像必须预装 MCP 和 CLI,run 时不能 `npx` 拉包。

切换规则由 sidecar 执行:MCP 连续两次找不到目标元素,自动附带截图并允许坐标点击;稳定流程由 agent 存成脚本到 `/work/scripts`,脚本失败才回到探索。

**人机交接协议**:

1. 人打开 noVNC 并点"接管",sidecar 给浏览器加锁,agent 的浏览器工具全部返回"人在操作中,请等待"。
2. 人完成验证码、扫码、二次验证后点"交还",锁释放,agent 收到一条系统消息说明人做了什么(由人一句话填写,可空)。
3. 接管期间的屏幕不截图、不入账本,避免记录人输入的密码。

每个 agent 动作自动截图,存入 run 账本,UI 可回放。

**身份与登录态共享**

登录态属于**身份**,不属于 bot。身份是一等对象,bot 通过显式授权借用,这样"谁在干活"和"用谁的号在干活"才能分开。身份分两类:

| 类型 | profile 位置 | 谁能用 | 典型场景 |
|---|---|---|---|
| 私有身份 | bot 沙箱自己的卷 | 只有该 bot | 测试账号、一次性登录 |
| 共享身份 | 独立的身份主机沙箱 | 被授权的多个 bot 并发借用 | 团队 Jira、企业邮箱、数据平台控制台 |

共享的机制是**借浏览器,不搬 profile**:

- 身份主机内单实例 Chromium,`--user-data-dir=/profile --remote-debugging-port=9222`,profile 在专属卷上。
- bot 沙箱的 Playwright MCP 用 `--cdp-endpoint` 指向身份代理而不是本地端口。`connectOverCDP` 拿到的是持久化的默认 context,也就是真实 profile 的 cookie jar;每个 bot `newPage()` 开自己的 tab,共享 cookie,各自导航互不干扰。
- S0 的 test-c 已验证一个 Chromium 被多个客户端并发接入且状态互通,这里只是把客户端从"同沙箱的三种驱动"扩展到"跨沙箱的多个 bot",机制相同。
- 人工登录、MFA、扫码走身份主机的 noVNC,登一次即可。TOTP 密钥存 Gateway Secrets Store 并只注入身份主机的 sidecar,不下发给任何 bot 沙箱。
- 出网 IP 天然一致:整个共享身份只有身份主机一个出口,不会出现同一会话在多个 IP 上活动而触发风控。

**为什么不用共享卷**:把同一 profile 卷挂进多个沙箱会直接损坏。Chromium 在 user data dir 里放 `SingletonLock`、`SingletonSocket`、`SingletonCookie`,第二个实例会尝试向第一个实例交接请求,跨网络命名空间交接不成;即使绕过锁,Cookies 是 SQLite、Local Storage 是 LevelDB,都不支持多写者。共享卷只能用于"同一时刻仅一个沙箱挂载"的独占租约模式。

**三种共享方式的取舍**:

| 方式 | 保真度 | 并发 | 用在哪 |
|---|---|---|---|
| 身份主机 + CDP 借用 | 完整,含 IndexedDB、Service Worker、扩展、设备指纹 | 支持 | 默认 |
| storageState 导出导入 | 有损,不含 sessionStorage | 支持但会互相踢下线 | 备份、克隆到一次性沙箱做危险操作 |
| 独占租约(卷挂载切换) | 完整 | 不支持,串行排队 | 券商、网银等设备绑定严格的站点 |

storageState 目前能捕获 cookies、localStorage、IndexedDB 快照、OPFS 和虚拟 WebAuthn 凭据,但明确排除 tab 级的 sessionStorage,依赖 sessionStorage 鉴权的站点注入后仍是未登录。另外 Playwright MCP 通过 CDP 连接时无法加载 storage-state,这也说明登录态应由身份主机持有而不是往远端浏览器里注入。

**锁的粒度**:从 v0.2 的"整个浏览器加锁"细化为**身份 × origin**。人接管时锁整个身份;两个 bot 同时操作同一站点的有状态流程(结账、向导、编辑同一条记录)时锁该 origin;不同站点的 tab 可以并行。

**授权的执行点在代理,不在浏览器**:同一个 profile 的 cookie jar 对所有 tab 可见,浏览器不会按 origin 隔离。因此"某 bot 只能用该身份访问某些域名"必须由身份代理在 CDP 层拦截导航目标,并与第 3.10 节的出网白名单取交集。这是软边界,页面内 JS 跳转可以绕。硬规则是:**一个身份等于一个信任域**,不要为了省事把个人邮箱和生产系统放进同一个 profile,需要隔离就开两个身份主机。

**失效处理**:身份主机的 Keeper 定期访问一个轻量的已登录端点探活。检测到掉登录时把身份置为 `needs_login`,所有借用该身份的 run 转入等待,并向人推送一条"需要重新登录"的通知,而不是让 bot 反复撞登录墙。

### 3.4 触发与调度

触发源不变:chat、cron、webhook、bot 消息、审批回执。

**两条调度道**:

| 道 | 触发源 | 并发 | 说明 |
|---|---|---|---|
| 交互道 | chat、审批回执 | 每 bot 1 | 用户在等,优先 |
| 后台道 | cron、webhook、bot 消息 | 每 bot 1 | 长任务,排队 |

两道可以同时各跑一个 run。规则:

- 交互 run 与后台 run 共用沙箱,但各自独立 SDK session。
- 交互 run 可以读 `/work` 和 run 账本,可以回答"后台任务进度如何"。
- 交互 run 要写 `/work` 或操作浏览器时,若后台 run 正在用,sidecar 返回"资源被占用",agent 告知用户并给出选项:等待、或让用户取消后台 run。
- 后台道队列有上限;cron 触发若上一轮未结束则跳过并记录。

### 3.5 审批与权限

风险三级不变:L0 只读默认放行;L1 可逆写默认放行可配审批;L2 外部副作用默认审批。

**审批的两种等待方式**:

1. **短等待**:sidecar 在 `canUseTool` 回调里拦住 L2 工具调用,进程内等待,默认 5 分钟。人在线时体验最好,run 状态 `waiting_approval_live`。S0 已验证回调可阻塞 20 秒以上且无 SDK 侧超时,文档说明可无限期挂起。
2. **落盘续跑**:超时或人离线,sidecar 的 `PreToolUse` hook 返回 `permissionDecision: "defer"`。这是 SDK 原生机制:query 立即结束并返回 session id,run 状态置 `waiting_approval`,待审批动作落盘,进程退出。人批准后 Gateway 用 `resume: sessionId` 重开 run,SDK 会把被推迟的那个工具调用重新交给 hook,此时放行即执行,agent 从原位置继续。S0 已在两个独立进程间验证通过。中途摘要由 sidecar 从 run 账本生成,不需要 agent 参与。

决策选项不变:Allow once / Always allow / Deny。Always allow 生成规则,规则存 SQLite,可在 UI 撤销。

Auto Review 规则匹配维度:工具名、目标域名、SQL 语句类型、金额阈值、文件路径。

### 3.6 团队共享知识库

不变。存储 markdown + FTS5,可选数据库向量检索;写入需人审或由知识维护 bot 蒸馏;所有 bot 通过 `knowledge_search` 和 `knowledge_read` 访问。

### 3.7 多 bot 协作

不变:Bot Bus、允许列表、中继上限 5、共享 `/shared` 卷、chief-of-staff 模式写在 SOUL 里。

补充:Bot Bus 消息格式采用 `{from, to, thread, body, attachments, relay_count}`,字段与主流 agent 间协议对齐,后续需要跨系统互通时可以做一层映射,不重写。

### 3.8 连接器与凭证(统一描述)

| 类型 | 凭证放哪 | 沙箱拿到什么 |
|---|---|---|
| MCP 服务 | Gateway 注册表,按 bot 白名单注入 | MCP 端点和短期 token |
| SaaS OAuth | Gateway Secrets Store,refresh token 加密存储 | 每次 run 签发的短期 access token,过期即失效 |
| 浏览器登录(私有身份) | 该 bot 沙箱的 profile 卷 | 人在该沙箱 noVNC 登一次,仅此 bot 后续可用 |
| 浏览器登录(共享身份) | 身份主机的 profile 卷 | 人在身份主机 noVNC 登一次;被授权的 bot 通过 CDP 借用,拿不到 profile 文件 |
| CLI 工具 | 镜像预装 psql、git、gh、python、node | 无凭证,凭证走上面三条 |

规则:Gateway 数据库不存明文密码、不存浏览器 cookie;沙箱不存 refresh token;run 账本对 token 和 cookie 做脱敏。

### 3.9 可观测性

不变:run 账本、SSE 实时日志、按 bot 按天成本汇总与软上限。

补充:每个 run 记录浏览器驱动方式的使用次数(MCP / CLI / 视觉),用于评估 token 开销和回退频率。

### 3.10 安全

- **沙箱隔离**:每 bot 独立沙箱、独立卷、独立网络命名空间。
- **出网策略**:默认拒绝。每 bot 一份域名白名单,由人在 UI 维护,agent 无权修改。白名单之外的导航即使是 L0 也会被拦下并转为审批,这样才能挡住"页面注入让 bot 把数据拼进 URL 发出去"。
- **提示注入**:浏览器读到的页面内容、工具返回的外部文本都包在"不可信内容"标记里进模型上下文;L2 动作必须过审批;接管期间不截图。
- **审计**:所有 L1/L2 动作、审批决定、白名单变更写入追加日志。

---

## 4. 数据模型(Gateway SQLite)

```
bots            id, name, role, model, soul_version, sandbox_provider,
                connectors_json, cron_json, created_at
threads         id, bot_id, channel, title, sdk_session_id, updated_at
runs            id, bot_id, thread_id, lane(interactive|background),
                trigger_kind, trigger_ref, status,
                sdk_session_id, resume_payload_json,
                started_at, finished_at, tokens_in, tokens_out, cost_usd, summary_json
run_events      id, run_id, seq, kind(tool_call|tool_result|screenshot|log|approval|takeover), payload_json, ts
approvals       id, run_id, action_json, risk_level, decision, decided_by, decided_at, wait_mode
approval_rules  id, bot_id, matcher_json, decision, created_from_approval_id
egress_rules    id, bot_id, domain_pattern, created_by, created_at
bot_messages    id, from_bot, to_bot, thread, run_id, body, relay_count, ts
knowledge_docs  id, path, title, body, source_run_id, approved_by, updated_at
knowledge_fts   FTS5 虚表
connectors      id, kind, name, config_json
secrets         id, connector_id, bot_id, encrypted_blob, rotated_at
identities      id, name, kind(private|shared), owner_bot_id, host_sandbox_id,
                profile_volume, exclusive, status(healthy|needs_login|locked), last_check_at
identity_grants id, bot_id, identity_id, origin_allowlist_json, granted_by, granted_at
identity_leases id, identity_id, origin, holder_run_id, holder_kind(bot|human),
                acquired_at, expires_at
identity_events id, identity_id, run_id, bot_id,
                kind(navigate|login_required|takeover|snapshot), payload_json, ts
```

run 状态机:

```
queued → running → succeeded | failed | cancelled
              ↓
   waiting_approval_live → running        (短等待,进程未退)
              ↓
   waiting_approval      → running        (落盘,session resume)
```

---

## 5. 一次 run 的时序

1. 触发到达 Gateway,按触发源落入交互道或后台道,写入 `runs` 状态 `queued`。
2. 调度器确认该 bot 该道无进行中 run,置 `running`,通过 Sandbox Provider 让 sidecar 启动 agent loop。
3. sidecar 组装上下文:SOUL、MEMORY、近期日记、触发载荷、知识库检索结果。
4. agent 执行。每次工具调用经 sidecar:检查出网白名单、检查风险等级、检查浏览器锁。L2 动作进入短等待。
5. 短等待超时则落盘,run 置 `waiting_approval`,进程退出。人决定后 Gateway 用 session resume 重开,注入决定,继续。
6. 结束后 agent 输出结构化摘要,sidecar 追加日记、上报成本、提交知识入库建议。
7. run 置终态,SSE 通知客户端。

---

## 6. 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| Gateway | Node.js + Fastify + SQLite(better-sqlite3) | 单进程好部署,和仓库其余部分技术栈一致 |
| Agent loop | Claude Agent SDK | 自带工具调用、规划、错误恢复、session resume;模型升级即产品升级 |
| 沙箱 | Sandbox Provider 接口;Docker 默认 | Docker 自托管最简单;接口留给 Desktop VM 和托管沙箱 |
| 浏览器 | 单实例 Chromium + Playwright MCP / CLI + 截图回退 | 树模式便宜可复现,CLI 省 token,视觉补盲区 |
| 屏幕 | Xvfb + noVNC | 人可接管,零客户端安装 |
| tty | node-pty 封装的 `tty_session` 工具 | 交互式 CLI、超时、控制符处理 |
| 连接器 | MCP 优先,Composio 补 SaaS | MCP 生态已成标准 |
| Web UI | React + Vite | 与 Cogbox 前端一致 |
| 渠道 | Slack Bolt、grammY(Telegram) | 成熟 SDK,后补 |

对比放弃的选项:

- **Claude Managed Agents**:Anthropic 托管的 agent 运行时,沙箱、会话日志都在 Anthropic 侧。省掉执行面开发,但不能自托管、不能换模型,与目标 2 冲突。保留为 Sandbox Provider 的一个未来实现,供不要求自托管的客户使用。
- **托管沙箱(Modal、Cloudflare Sandbox 等)**:比 Docker 省运维,但引入外部依赖。通过 Provider 接口后补。
- **fork OpenMausBot**:绑定 Electron 桌面形态,bot 跑在用户本机而非独立电脑。
- **基于 OpenClaw**:渠道和技能生态好,但共享主机模型与"一 bot 一电脑"冲突,且 2026 年的多份安全分析指出其隔离不足。
- **直接在 Paperclip 上做**:治理能力完整,但体量大、契约多,不适合快速试错。保留为上层选项。

---

## 7. 与现有资产的衔接

| 现有资产 | 衔接方式 |
|---|---|
| 桌面端 VM | 实现一个 `DesktopVMProvider`;桌面应用作为一个客户端 |
| 模型代理与 skill 市场 | 模型代理、用量计量、skill 市场直接复用;S0 验证代理透传 |
| 数据库 MCP Server | 内置连接器;bot 用 Gateway 签发的服务身份访问 |
| 数据库 skill / 数据库 guidance | 知识库初始内容和 bot 技能 |
| fund-tool | 量化场景的第一个 CLI 工具样例 |
| Paperclip | 需要多人治理时,把 Gateway 封成一个 Paperclip adapter |

---

## 8. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| S0(1 周) | 三个关键假设验证:(a) SDK 经模型代理跑通流式 + 工具调用 + cache;(b) L2 动作停下、进程退出、session resume 续跑成功;(c) 一个 Chromium 同时被 Playwright 和 noVNC 使用且交接不冲突 | **2026-09-20 结果:三项全部通过。** (a) 经模型网关用两个非 Anthropic 模型跑通;(b)(c) 见结果文档。脚本在 `spikes/s0/`,结论在 `docs/design/s0-spike-results-2026-09-20.md` |
| M0(2 周) | Gateway 骨架、Docker Provider、单 bot、SDK 循环、Playwright MCP、Web 聊天 | 一个 bot 能按聊天指令登录网站完成一个表单,截图入账本 |
| M1(4 周) | 两条调度道、cron、webhook、审批双模式、出网白名单、noVNC 交接协议、tty 工具 | bot 定时执行;遇 L2 动作短等待 5 分钟后落盘,次日批准后续跑成功;人接管完成验证码后 agent 继续 |
| M2(4 周) | 多 bot、Bot Bus、共享卷、知识库、MEMORY 规则、视觉回退、Playwright CLI 模式 | chief bot 拆解任务给两个专家 bot 并汇总;一个 shadow DOM 页面通过视觉回退完成操作 |
| M3(5 周) | 数据库连接器、场景镜像、Slack 渠道、成本看板、Desktop VM Provider | 三个场景各跑通一条端到端流程;成本看板能按驱动方式拆分 token |

总计 16 周。M3 比 v0.1 多一周,用于 Desktop VM Provider。

---

## 9. 未决问题

1. ~~模型代理是否透传 prompt cache 相关头~~ S0 已验证:模型网关透传,并在多轮后回传 cache 命中。若自建代理,按 S0 结果文档的清单实现。
2. 桌面端 VM 是一 VM 一 bot 还是一 VM 多容器;后者要求 VM 内有 Docker。
3. 数据库 MCP Server 的服务身份如何签发和轮换,是否需要数据库侧新增服务账号类型。
4. 知识库是否从第一天就用数据库做向量检索,还是先 FTS5。建议先 FTS5。
5. 视觉回退用哪个模型的 computer use 能力,以及是否经过同一个 Proxy。
6. 短等待默认 5 分钟是否合适,是否按 bot 可配。

---

## 10. 场景可行性评估

### 10.1 场景一:自动化产品测试(Web 服务 + CLI 服务)

| 子目标 | 覆盖情况 |
|---|---|
| 模拟用户在 Web 上走各种场景 | 底座已覆盖(树 + CLI + 视觉三模式) |
| 模拟用户在 CLI 上交互 | 底座已覆盖(`tty_session` 工具,v0.2 移入底座) |
| 从需求或 PRD 生成测试场景 | agent 能力已覆盖,需领域层提供用例模板 |
| 断言与判定 | 需领域层。必须有显式 oracle |
| 回归可重复 | 需领域层。探索结果固化为 Playwright 脚本或 CLI 脚本,由 CLI 模式执行 |
| 环境准备与重置 | 需领域层。测试数据种子、服务启停、数据库快照回滚 |
| 报告与缺陷单 | 底座已覆盖 |

**可行性:高。平台覆盖度约 75%。**(tty 工具入底座后从 70% 上调)

限制不变:agent 实时探索不能当回归;断言必须由人定义或从规格派生;探索模式要设预算;视觉回退能缓解但不能消除对 canvas 类页面的不稳定。

**验证指标**:脚本自愈成功率、误报率、单条用例从描述到可执行脚本的时间、探索模式发现的真实缺陷数、视觉回退触发率。

### 10.2 场景二:数据平台开发(导入、治理、分析)

| 子目标 | 覆盖情况 |
|---|---|
| 连接数据库并执行 SQL | 底座 + 现有资产已覆盖 |
| 数据导入 | 需领域层。导入向导工具 |
| 治理 | 需领域层。规则先由人定义 |
| 分析 | agent 能力已覆盖,准确率取决于 schema 知识 |
| schema 与业务术语知识 | 底座知识库可承载 |
| 长任务异步执行 | 底座后台道已覆盖;交互道可随时查询进度(v0.2 改进) |
| 破坏性操作防护 | 底座审批 broker 已覆盖,按 SQL 类型配 L2 规则 |

**可行性:中高。平台覆盖度约 55%。**(两条调度道解决了长任务期间不能问进度的问题)

限制不变:NL 到 SQL 准确率是上限;治理规则要人先定;数据库引擎错误要与 SQL 错误区分;导入向导与 数据库版本绑定。

### 10.3 场景三:量化投研小组

覆盖表与 v0.1 相同。

**可行性:中低(自主产出策略);中高(投研助理小组)。平台覆盖度约 30%。**

限制不变:统计严谨只能靠工具强制;报告数字必须来自 run 产物;数据成本;研究与交易物理隔离。

---

## 11. 总体结论

| 场景 | 可行性 | 平台覆盖 | 领域层主要工作 | 最大风险 |
|---|---|---|---|---|
| 自动化产品测试 | 高 | 约 75% | oracle 定义、脚本固化、环境重置 | 把非确定性探索误当回归 |
| 数据平台开发 | 中高 | 约 55% | schema 知识库、导入向导、治理规则 | NL 到 SQL 在复杂库上的准确率 |
| 量化投研小组 | 中低 / 中高 | 约 30% | 确定性回测引擎、偏差校验工具、数据源 | 统计不严谨与结果幻觉 |

三点判断不变:底座 16 周内可到 Grok Bot 形态并在四点上超越;场景价值由领域层决定;推进顺序一、二、三。

新增第四点:**S0 是整个计划的闸门。** 三个假设中任一失败,改的是架构而不是排期。这一周的成本远低于在 M1 发现审批续跑不可靠。

---

## 12. 风险矩阵

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 浏览器 agent 可靠性不足 | 高 | 中 | 三模式驱动,脚本承担回归 |
| 无障碍树看不到 shadow DOM / canvas | 中 | 中 | 视觉回退;M2 验收含一个 shadow DOM 页面 |
| 审批落盘后 session resume 失败 | 低(S0 已验证) | 高 | resume 失败时用 run 账本摘要 + 审批结果重开新 session;跨主机需 SessionStore 或持久卷 |
| 提示注入通过网页内容攻击 bot | 中 | 高 | 出网默认拒绝;不可信内容标记;L2 审批 |
| token 成本失控 | 中 | 中 | 按 bot 日预算;CLI 模式替代 MCP 长会话;Sonnet 承担低复杂度任务 |
| 数据库引擎不稳定被归咎于 bot | 中 | 中 | 错误分类,引擎错误走缺陷单 |
| 量化结果不可复现 | 高 | 高 | 报告数字必须来自 run 产物 |
| 多 bot 互相唤醒失控 | 低 | 中 | 允许列表 + 中继上限 |
| 模型代理不支持工具流式或 cache | 低(S0 已验证) | 高 | 按 S0 清单实现;不支持则短期直连,key 以短期 token 注入 |
| 人接管期间 agent 误操作 | 低 | 高 | 浏览器锁;接管期间不截图 |
| 共享身份放大单个 bot 被注入后的影响面 | 中 | 高 | 一身份一信任域;按 bot 按 origin 授权;代理层拦截导航;共享身份内 L2 仍需审批 |
| 共享身份掉登录导致多个 bot 连环失败 | 中 | 中 | Keeper 探活;置 `needs_login` 后统一等待并通知人,不让 bot 反复撞登录墙 |
