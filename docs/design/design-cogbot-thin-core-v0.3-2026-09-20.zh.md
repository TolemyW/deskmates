# CogBot 架构蓝图 v0.3

日期:2026-09-20
状态:草案 v0.3,取代 v0.2 / v0.2.1 作为架构真相源
范围:架构蓝图。场景可行性评估仍以 v0.2 第 10 到 12 节为准,本文第 11 节只保留结论表。

依据:
- `design-cogbot-thin-core-v0.2-2026-09-20.md`(含 v0.2.1 身份模型修订)
- `s0-spike-results-2026-09-20.md`(三项架构假设已验证)
- `../adr/0002-sidecar-is-the-sdk-host-process.md`
- `../adr/0003-identity-model-and-browser-borrowing.md`(已被 ADR-0004 取代)
- `../adr/0004-shared-workspace-by-default.md`(当前生效:默认共享一个环境)
- `../adr/0005-group-threads-and-mention-wake.md`(当前生效:线程有成员,bot 在线程内靠 @ 互相唤醒)

---

## 0. v0.3 相对 v0.2 / v0.2.1 的变更

| 编号 | 变更 | 来源 |
|---|---|---|
| C16 | sidecar 定义为 SDK 宿主进程本身;风险分级直接映射到 SDK 的 hook 与回调 | ADR-0002,S0 test-b |
| C17 | 模型是部署配置,不是设计常量;成本由 Gateway 按 token 计价 | ADR-0002,S0 test-a |
| C18 | ~~身份主机上不做 CDP 代理~~ | 整条已被 ADR-0004 取代:身份主机不再存在 |
| C19 | ~~身份主机、授权、租约、探活~~ | 整条已被 ADR-0004 取代:身份主机不再存在 |
| C20 | ~~按 origin 的授权定性为运营控制~~ | 整条已被 ADR-0004 取代:身份主机不再存在 |
| C21 | ~~删除"卷挂载切换的独占租约"方案~~ | 整条已被 ADR-0004 取代:身份主机不再存在 |
| C22 | ~~一个镜像两种角色~~ | 已被 C25 取代:只剩 workspace 一种 |
| C23 | ~~身份选择显式化,工具名带身份前缀~~ | 已被 C26 取代:只有一组浏览器工具 |
| C24 | 数据模型:run 用量按模型拆表,新增价格表,`run_events` 增加 `thinking` | ADR-0002 |

### v0.3.1 修订(2026-09-20,产品决定:默认共享一个环境)

| 编号 | 变更 | 原因 |
|---|---|---|
| C25 | 环境单位从"每 bot 一个沙箱"改为"一组 bot 一个 workspace" | 产品形态是一组 bot 坐在同一台电脑前,共享是默认而不是需要机制去实现的特性 |
| C26 | 删除身份对象、grant、origin 白名单、per-grant MCP 实例、身份主机角色、`waiting_identity` | 这套机制是为了在共享浏览器里限制 bot 之间的访问,而这在共享电脑模型下既不必要也挡不住 |
| C27 | bot 之间靠执行上下文区分:SOUL、工作目录、提示、账本归属。明确写明这不是安全边界 | 与 Grok Bot 一致;按 bot 配权限会带来大量复杂度 |
| C28 | 隔离单位是 workspace:要隔离就开第二个,不在 bot 之间做访问控制 | 一个容器的成本,换掉一个子系统 |
| C29 | 浏览器协调降为 workspace 级一把锁加 tab 归属,去掉 origin 维度 | 并发是正确性问题,不是权限问题 |
| C30 | 未决问题 2 与 7 关闭;M2 重心改为同一 workspace 内多 bot 并发 | origin 过滤已不在设计里;真正的风险转移到多 bot 互相踩 |
| C31 | 目标 2 从"四点超越"改为"三点超越,隔离与 Grok Bot 同级" | ADR-0004 放弃了 bot 级隔离这一差异点;文档如实陈述,不把 workspace 划分包装成超越 |
| C32 | 修正三处在共享模型下不再成立的表述:TOTP 对 agent 不可见、连接器按 bot 白名单、跨沙箱与 origin 两项待验证 | 同一容器同一用户下,有 shell 的 bot 能读任何进程环境与任何文件 |
| C33 | 新增 workspace 默认分组规则与内存估算 | 场景 1 的 bot 暴露于注入,场景 2 的 bot 持有生产凭证,不能同 workspace;每 run 一个 sidecar 进程需要按 1 GiB 量级预算 |

### v0.3.2 修订(2026-09-20,群聊:线程有成员,bot 靠 @ 互相唤醒)

依据 ADR-0005。凡设计未定的行为,抄 Grok Bot 的公开文档;抄与不抄的清单见 ADR 的 Precedent 一节。

| 编号 | 变更 | 原因 |
|---|---|---|
| C34 | 线程从"属于一个 bot"改为"有成员、属于一个 workspace";单成员线程即 M0 的聊天,一条代码路径 | 群聊需要一个线程里有多个 bot;M0 就按这个模型建表,免去日后迁移 |
| C35 | 对话记录归 Gateway(`thread_messages`);每个 bot 在每个线程各有一个 SDK session(`bot_sessions`);唤醒时投递该 bot 未见过的消息切片 | 真相源在控制面,与知识库同一原则;bot 的 session 只是它自己对这段对话的记忆 |
| C36 | 唤醒规则:@ 到谁唤醒谁,并行;`@everyone` 或没 @ 任何人则按加入顺序轮流唤醒全员,每个 bot 可沉默 | 抄 Grok Bot;成本随成员数线性增长,与 Grok Bot 相同,M2 实测后再定省钱手段 |
| C37 | Bot Bus 并入线程模型:`message_bot` 即向一个 `bus` 线程投递并唤醒对方;删除 `bot_messages` 表;发起 run 所在的 chat 线程插一条交接 system 消息 | 两套机制变一套;人在自己看的地方看到交接,抄 Grok Bot |
| C38 | 两道闸:`relay_count` 上限 5(链深)加线程级 `turn_budget` 8(两条人类消息之间的 bot 消息数);道跟线程走,chat 线程唤醒进交互道;新增 `thread_post` 工具与 run 终态 `silent` | Grok Bot 无闸,用户反馈正是循环与空耗;人在看的线程不该排后台队列 |
| C39 | 所有 ADR 增加 Verification 表(ADR-0001 定为必填);补齐无固定含义的词:人在线、短期 token、未知模型计价、浏览器锁 v1(tab 归属)、完全隔离四断言、`last_seen_seq` 推进时机、`thread_post` 为 L1、轮流唤醒遇忙成员、闸告警形态、载荷截断预算、`turn_budget` 校准规则;X03 预言改为无丢失更新 | 审阅发现若干决策没有可判定的含义或没有会失败的测试;不能判定的决策只是偏好 |

---

## 1. 目标与非目标

### 1.1 目标

1. 达到 Grok Bot 的八项核心能力:持久电脑、浏览器操作、常驻触发、连接器、审批门禁、多 bot 协作、记忆、客户端。
2. 在三点上超越:可自托管、模型可换、记忆可查可改可导出。隔离与 Grok Bot 同级:bot 之间不设防,信任域以 workspace 划分;可以开多个 workspace,这是配置选项,不是差异点(ADR-0004)。
3. 底座尽量薄:agent 循环、浏览器驱动、屏幕接管都用标准件,自研代码集中在 Gateway 和 sidecar 的胶水层。
4. 与现有资产衔接:桌面端 VM、外部模型代理与 skill 市场、数据库 MCP Server 与 数据库 skill。
5. 执行面可替换:同一套 Gateway 能把沙箱跑在 Docker、Desktop VM 或托管沙箱上。
6. 同组 bot 默认共享登录态与文件,共享不依赖任何额外机制。

### 1.2 非目标

- 不做多公司治理平台。需要时把本底座作为 Paperclip 的 adapter 接入。
- 不自研 agent 推理循环、不自研浏览器 DOM 理解、不自研 CDP 代理。
- 第一阶段不做移动客户端。
- 不承诺替代人做业务判断。
- 不做交易执行。

---

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────────────────┐
│  客户端:Web UI(首选) · 桌面客户端 · Slack / Telegram(M3)  │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ HTTPS + SSE
┌───────────────────────────────▼──────────────────────────────────────┐
│  Gateway(控制面,单进程,Node.js + Fastify + SQLite)                  │
│  ├─ Bot Registry       名字 / 岗位 / SOUL / MEMORY / 所属 workspace     │
│  ├─ Workspace Registry workspace 定义、出网白名单、浏览器锁             │
│  ├─ Run Scheduler      交互道 + 后台道;线程 · cron · webhook · 审批    │
│  ├─ Approval Broker    短等待 / defer 续跑;Allow once / Always / Deny  │
│  ├─ Run Ledger         run、事件(含 thinking)、截图、按模型 token、计价│
│  ├─ Knowledge Store    团队知识库,markdown + FTS5                      │
│  ├─ Thread Router      线程、成员、@ 唤醒、两道闸(原 Bot Bus)          │
│  ├─ Secrets Store      加密的 refresh token / TOTP;签发短期 token      │
│  ├─ Egress Policy      每 workspace 出网白名单,默认拒绝                │
│  └─ Connector Hub      MCP 注册表 · Composio                           │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ SandboxProvider 接口
                                │ create / exec / attach / snapshot / destroy / injectEnv
┌───────────────────────────────▼──────────────────────────────────────┐
│  Workspace(一组 bot 共用一台电脑;默认一个,需要隔离时才开第二个)      │
│  ├─ Chromium 单实例 + 持久 profile   所有 bot 共享 cookie 与登录态      │
│  │   每个 run 开自己的 tab;人接管时整个浏览器加锁                      │
│  ├─ Playwright MCP(一个实例)· CLI · 视觉回退                          │
│  ├─ noVNC:人工登录 / MFA / 接管,一次登录全组可用                      │
│  ├─ Shell · FS · tty · 连接器 MCP    所有 bot 共享                     │
│  ├─ /work:共享工作区与脚本                                            │
│  ├─ /home/<bot>:每个 bot 的 SOUL MEMORY 日记 .claude                   │
│  └─ Sidecar × N = SDK 宿主进程       每个 run 一个,cwd 指向该 bot      │
│        PreToolUse hook · canUseTool · 风险分级 · 脱敏 · 事件流          │
└──────────────────────────────────────────────────────────────────────┘
```

设计原则:

- **控制面薄**:Gateway 只做注册、调度、审批、账本、知识、消息、密钥、出网策略。它不调用模型。
- **执行面标准件**:agent 循环是 Claude Agent SDK,浏览器是 Playwright(MCP、CLI),屏幕接管是 noVNC。sidecar 是调用 SDK 的那个进程,不是额外一层。
- **一组 bot 一个 workspace,像坐在同一台电脑前**:浏览器、cookie、文件系统、shell 默认全部共享。共享不需要任何机制,它是默认状态。
- **bot 之间靠执行上下文区分,不靠基础设施**:区分一个 bot 的是它的 `SOUL.md`、工作目录、提示里给的工具、调度和账本归属。这些是软区分,不是安全边界,文档如实这样写。需要真隔离时升级为第二个 workspace,单位是 workspace 不是 bot。
- **凭证不落 Gateway 明文**:Gateway 只有加密的 refresh token 和 TOTP 密钥,向 workspace 签发短期 token。密码、cookie 只在 workspace 卷里。
- **一切 run 可追溯、可续跑**:每次触发先落一条 run;run 能因审批停下,几小时后从同一位置续跑。
- **默认不出网**:每个 workspace 只能访问人维护的域名白名单,agent 不能改。这防的是提示注入把数据拼进 URL 外泄,与哪个 bot 在跑无关。
- **模型是配置**:默认模型与降本模型来自部署配置;代码里不出现模型名。

---

## 3. 核心组件

### 3.1 Bot 定义

| 项 | 位置 | 说明 |
|---|---|---|
| `SOUL.md` | `/home/<bot>/` | 身份、岗位、口吻、边界。人可编辑,版本化 |
| `MEMORY.md` | `/home/<bot>/` | 隐性规则。agent 可追加,人可删改 |
| `memory/YYYY-MM-DD.md` | `/home/<bot>/` | 每日工作笔记,run 结束自动追加 |
| `skills/` | `/home/<bot>/` | 技能,来自 skill 市场或本地 |
| `.claude/` | `/home/<bot>/` | SDK 会话转录与配置。`CLAUDE_CONFIG_DIR` 指向这里,resume 依赖它 |
| bot 行 | Gateway SQLite | 名字、岗位、模型、`workspace_id`、连接器白名单、审批规则、cron |

`/home/<bot>/` 是同一个 workspace 文件系统里的一个目录,不是隔离卷。同组 bot 可以读到彼此的目录,这是有意的:一个 bot 可以查另一个 bot 的日记来了解它做过什么。真需要藏起来的东西不放在这里。

记忆三层:bot 自己的文件、团队共享知识库、run 账本。全部明文 markdown 或 SQLite。

### 3.2 Sidecar 与 Agent Loop

sidecar 是 workspace 内调用 SDK `query()` 的 Node 进程。**每个 run 一个 sidecar 进程**,同一 workspace 里可以同时跑多个,分属不同 bot。它负责:

- 组装上下文:该 bot 的 `SOUL.md` 作为系统提示,`MEMORY.md` 与最近 3 天日记,触发载荷,知识库检索前 5 条,可用工具清单。线程唤醒的载荷是该 bot 在这个线程里未见过的消息切片,每条带作者标签(人、某个 bot、系统);其他 bot 的消息以"来自 bot X"呈现,不是人的指令,是否照办由该 bot 的 `SOUL.md` 决定(ADR-0005 第 9 条)。
- 注册 MCP 服务器:浏览器 MCP 全组相同;连接器 MCP 按该 bot 定义里的清单注册。这是提示层的软选择,决定 agent 看到哪些工具,不是访问控制:同容器内的 bot 用 shell 可以调用任何连接器。
- 提供线程工具:`thread_post(body, attachments)` 在 run 中随时向当前线程发消息,进度、提问、交接都用它;`message_bot(to, body, attachments)` 向另一个 bot 发异步私信(见 3.7)。谁被唤醒由 Gateway 决定,sidecar 不做路由。
- 在 `PreToolUse` hook 里做风险分级、出网检查、浏览器锁检查、脱敏;在 `canUseTool` 回调里做短等待。
- 把事件流(工具调用、结果、thinking、截图、审批、接管)推回 Gateway,事件带 bot 归属。
- run 结束时输出结构化摘要:做了什么、改了哪些文件、访问了哪些站点、待审批项、建议追加到 `MEMORY.md` 的规则,以及 `reply`。`reply` 非空则作为该 bot 在线程里的最终消息发出;为空表示 bot 选择沉默,run 终态记为 `silent`。

SDK 配置固定项:`CLAUDE_CONFIG_DIR=/home/<bot>/.claude`、`settingSources: []`、`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`、`cwd=/work`。不同 bot 靠 `CLAUDE_CONFIG_DIR` 和系统提示区分,不靠进程隔离。

模型访问:sidecar 从 Gateway 收到 `ANTHROPIC_BASE_URL` 与短期 `ANTHROPIC_AUTH_TOKEN`(Bearer)。S0 已确认代理只接受 Bearer,且订阅 OAuth 凭证不可转发。默认模型与降本模型是部署配置。S0 已用 glm-5.3 与 deepseek-v4.1-flash 跑通完整循环;长会话质量待 M0 验收时在部署模型上重新基线。

会话续接:按 `(bot, thread)` 保存 session id(`bot_sessions` 表);审批续跑与同线程续聊都用 `resume`;SOUL 变更后重开。一个线程里有几个 bot 就有几个 session,线程的对话记录本身不在任何 session 里,在 Gateway 的 `thread_messages`。

### 3.3 浏览器与登录态

**单实例原则**:每个 workspace 内只跑一个 headed Chromium,`--user-data-dir` 指向卷,`--remote-debugging-port=9222`。Playwright、noVNC 里的人、截图都连同一个实例。S0 test-c 已验证三个客户端并发接入、状态互通、cookie 落盘。

**三种驱动方式**:

| 方式 | 用途 | 何时用 |
|---|---|---|
| Playwright MCP(无障碍树),`--cdp-endpoint … --caps vision` | 探索未知页面 | 默认 |
| Playwright CLI,`attach --cdp=…` | 长会话、回归、批量操作 | 稳定流程固化后;token 敏感任务 |
| 视觉回退(截图 + 坐标) | 无障碍树失效时 | shadow DOM、canvas、图片按钮 |

S0 已验证 closed shadow root 内的按钮在无障碍树中不可见,坐标点击可命中。切换规则由 sidecar 执行:MCP 连续两次找不到目标元素,自动附带截图并允许坐标点击;稳定流程由 agent 固化成脚本存到 `/work/scripts`,脚本失败才回探索。

**登录态属于 workspace,共享是默认状态。** workspace 里只有一个 Chromium、一个 profile,所以同组 bot 天然共用同一份 cookie、localStorage 和登录态。这里没有身份对象、没有授权、没有借用、没有代理,因为没有东西需要跨边界传递。人在 noVNC 登录一次,全组 bot 立刻都是已登录状态。

工具名只有一组:`mcp__browser__browser_navigate`。哪个 bot 调用的,记在账本的 bot 归属里,不体现在工具名里。

**为什么一个 workspace 只能有一个 Chromium**:Chromium 在 user data dir 里放 `SingletonLock`、`SingletonSocket`、`SingletonCookie`,同一 profile 起第二个实例会失败;Cookies 是 SQLite,Local Storage 是 LevelDB,都是单写者。这条约束是 ADR-0003 留下的有效结论:要共享 cookie,就必须共享那一个浏览器进程,不能靠复制 profile。

**并发是正确性问题,不是权限问题。** 多个 bot 同时用一个浏览器需要协调,但协调的目的是别互相踩,不是防谁。

| 情形 | 行为 |
|---|---|
| 每个 run 开自己的 tab | 默认。不同 tab 并行,互不干扰,共享 cookie |
| 人在 noVNC 点"接管" | Gateway 给该 workspace 记一条人持有的浏览器锁;所有 run 的浏览器工具返回"人在操作中,请等待";期间不截图 |
| 一个 run 要操作不属于自己的 tab | 后到者在 workspace 浏览器锁上排队。这是锁 v1 里唯一的 run 间排队;同站点、同记录但各在自己 tab 的 run 不互相等待,互相踩的比例用 `interference_rate` 度量,超 5% 才升级锁粒度(ADR-0004 定义) |
| 某个 tab 长期占用 | 锁带 TTL,每次工具调用续期,run 结束或超时释放 |

**需要隔离时开第二个 workspace。** 判断标准只有一条:两件工作是否应该共用登录态和文件。生产系统和个人账号不要放同一个 workspace。这比按 bot 配权限简单得多,而且是真边界,不是软约定。

**bot 之间不设防。** 同一个 workspace 里,任何 bot 都能访问这个浏览器登录过的任何站点、读写任何文件。这是产品形态决定的,和 Grok Bot 一样,bot 边界不是安全边界。真正的防线是三条:出网白名单挡数据外泄,L2 审批挡对外副作用,workspace 划分挡信任域混用。

**storageState 的角色**:只作备份与克隆,比如把登录态复制到一个一次性 workspace 做危险操作。它能带走 cookies、localStorage、IndexedDB、OPFS、虚拟 WebAuthn,但不含 sessionStorage。

**掉登录处理**:workspace 可选配一个探活 URL 与判定规则,sidecar 定期访问。检测到掉登录时置为 `needs_login`,该 workspace 的 run 进入等待,通知人重新登录。探活本身可能触发风控,默认关闭。

### 3.4 触发与调度

触发源:线程消息(人或 bot 在线程里发的消息,见 3.7)、cron、webhook(`/hooks/<bot>/<token>`)、审批回执。

| 道 | 触发源 | 并发 | 说明 |
|---|---|---|---|
| 交互道 | `chat` 线程的消息、审批回执 | 每 bot 1 | 有人在看,优先 |
| 后台道 | cron、webhook、`bus` 线程的消息 | 每 bot 1 | 长任务,排队 |

道跟线程走,不跟发消息的是人还是 bot 走:一个 bot 在人建的 `chat` 线程里 @ 另一个 bot,对方在交互道被唤醒,因为人在看。同一 `(bot, thread)` 的唤醒合并:已排队的不再重复入队;bot 正在跑时收到的 @ 在它跑完后合并成一次唤醒,载荷是期间所有新消息。

两道各跑一个独立 SDK session,共用 workspace、`/work` 和浏览器锁。交互 run 可以读账本回答"后台任务进度如何";要写 `/work` 或用浏览器时若被后台 run 占用,sidecar 返回"资源被占用",agent 告知用户并给出等待或取消后台 run 的选项。后台道队列有上限;cron 触发若上一轮未结束则跳过并记录。

### 3.5 审批与权限

风险三级:L0 只读默认放行;L1 可逆写默认放行可配审批;L2 外部副作用默认审批。

映射到 SDK(S0 已验证):

| 情形 | 机制 | run 状态 |
|---|---|---|
| L0 / L1 | `PreToolUse` hook 返回 `allow` | `running` |
| L2,人在线 | `canUseTool` 回调阻塞,默认 5 分钟 | `waiting_approval_live` |
| L2,超时或人离线 | hook 返回 `permissionDecision: "defer"`;query 结束并回报 session id;进程可退出 | `waiting_approval` |
| 审批到达 | Gateway 用 `resume: sessionId` 重开 run;SDK 把被推迟的调用重新交给 hook,此时放行或拒绝 | `running` |

"人在线"的判定(有活跃订阅或 60 秒内心跳)、短期 token 的 TTL 与吊销、未知模型的计价,见 ADR-0002 的 Definitions 一节。

决策选项:Allow once / Always allow(生成规则)/ Deny。规则存 SQLite,UI 可撤销。匹配维度:工具名、目标 origin、SQL 语句类型、金额阈值、文件路径、发起的 bot。

### 3.6 团队共享知识库

Gateway 管理的 markdown 目录,SQLite FTS5 全文索引,可选接入数据库向量检索。写入需人审,或由指定的知识维护 bot 蒸馏日记与 run 记录。所有 bot 通过 `knowledge_search` 与 `knowledge_read` 访问。真相源在控制面,不在任何 bot 的会话里。

### 3.7 多 bot 协作

同组 bot 本来就共用 `/work` 和整个文件系统,交换文件不需要额外机制,约定目录即可。对话层面的协作全部在**线程**里发生(ADR-0005)。

**线程有成员。** 一个线程属于一个 workspace,成员是该 workspace 里的 bot,按加入顺序排列。`kind` 分两种:`chat` 是人通过客户端建的,`bus` 是 bot 通过 `message_bot` 建的。单成员的 `chat` 线程就是 M0 的聊天。`chat` 线程最多 6 个 bot(抄 Grok Bot);标题按成员生成,可改;人 @ 一个同 workspace 的非成员 bot 即把它拉进来,它第一次被唤醒时收到全部历史。bot 不能拉人,只能 @ 成员。线程不跨 workspace:workspace 是信任域,跨域的消息应该先经人眼。

**对话记录归 Gateway。** `thread_messages` 是真相:人、bot、系统的每条消息按序落库,带作者。每个 bot 在每个线程各有一个 SDK session,那是它自己的记忆;唤醒时投递它未见过的切片,`thread_members.last_seen_seq` 记录进度。

**谁被唤醒。**

| 消息 | 唤醒谁 | 方式 |
|---|---|---|
| @ 了一个或多个 bot | 被 @ 的成员 | 并行,各一个 run |
| `@everyone`,或没 @ 任何人 | 全体成员 | 按加入顺序轮流:第 n+1 个在第 n 个跑完后才唤醒,所以它能看到前面有没有人答,可以沉默 |

轮流唤醒按消息进行;第二条没 @ 的消息排在当前一轮之后。明确 @ 的唤醒不被轮询挡住。这是 Grok Bot 的路由,连它的代价一起抄了:6 bot 群里一条没 @ 的消息最多 6 个 run 才有人真正回答。对策也和 Grok Bot 一样:点名一个 owner bot。更省的办法(先用 `CHEAP_MODEL` 判断该不该答、线程 owner 开关)是待测的旋钮,M2 实测后再定。

**bot 发消息是一个动作。** run 中随时可以 `thread_post`;run 结束时摘要里的 `reply` 作为最终消息;`reply` 为空即沉默,run 记 `silent`。`@<bot 名>` 由 Gateway 按成员表解析,渠道适配器映射原生 mention;未知名字和 @ 自己忽略。

**Bot Bus 就是线程。** `message_bot(to, body, attachments)` 仍是任何 run(含 cron、webhook 这类没有人的 run)都能调的工具,实现是:找到或新建调用者与 `to` 两个成员的 `bus` 线程,投递并 @ `to`,唤醒对方;对方在自己的 run 里处理,可以稍后在这个 `bus` 线程里 @ 回来。若调用者的 run 属于某个 `chat` 线程,那个线程插一条 system 消息"已交接给 `to`"并链接到 `bus` 线程,人在自己看的地方看到交接。bot 定义里的允许列表仍管 `message_bot`;`chat` 线程内成员即允许列表。两者都是路由配置,不是访问控制(ADR-0004)。

**两道闸。**

| 闸 | 范围 | 默认 | 超限时 |
|---|---|---|---|
| `relay_count` | 一条消息链:run 里发出的消息继承触发消息的计数加一,人的消息为 0 | 5 | 消息照存,其 @ 不唤醒任何人,告警 |
| `turn_budget` | 一个线程:自上一条人类消息以来 bot 发的消息数 | 8 | 同上,线程置 `paused` 并通知人;下一条人类消息复位 |

`relay_count` 管深度(A → B → C → …),`turn_budget` 管总量,因为 A 和 B 每轮都能另起新链。沉默的 run 两者都不计。`bus` 线程没有人来复位,超限即运营告警。Grok Bot 没有这两道闸,用户反馈正是"互相重复、无谓循环、把额度花在讨论上"。

**chief-of-staff 模式**不需要等待原语:chief @ 两个专家后结束 run;专家各自回复并 @ chief;chief 被合并唤醒一次拿到两条回复(若两条回复跨了它的 run 边界则两次)。拆解逻辑写在 chief 的 SOUL 里,底座只提供线程。运营文档沿用 Grok Bot 的建议:每个阶段一个 owner;知道该谁做就点名;没 @ 的消息按成员数计费。

**每一跳可追溯。** `thread_messages.run_id` 指向发出它的 run,`runs.trigger_ref` 指向唤醒它的消息。一段群聊回放为:人的消息 → run(A) → 消息(A,@B) → run(B) → 消息(B,@A) → run(A)。归属、用量、审批仍按 run 即按 bot。

### 3.8 连接器与凭证

| 类型 | 凭证放哪 | workspace 拿到什么 |
|---|---|---|
| 模型代理 | Gateway 持有上游 key | `ANTHROPIC_BASE_URL` + 每 run 签发的短期 `ANTHROPIC_AUTH_TOKEN` |
| MCP 服务 | Gateway 注册表,按 bot 定义注册到其 sidecar(软选择,见 3.2) | MCP 端点和短期 token;同容器其他 bot 可读到 |
| SaaS OAuth | Gateway Secrets Store,refresh token 加密 | 每 run 签发的短期 access token |
| 浏览器登录 | workspace 的 `/profile` 卷 | 人在 noVNC 登一次,该 workspace 全组 bot 立即可用 |
| TOTP | Gateway Secrets Store | 注入 supervisor 进程环境。同容器同用户下有 shell 的 bot 能读 `/proc` 里的环境,所以 TOTP 是 workspace 级秘密,只放属于该信任域的账号 |
| CLI 工具 | 镜像预装 psql、git、gh、python、node | 无凭证 |

规则:Gateway 数据库不存明文密码、不存 cookie;workspace 不存 refresh token;账本对 token 和 cookie 脱敏。workspace 内没有秘密对 bot 是不可见的:`/profile` 的 cookie 库、其他 bot 的会话转录、任何进程的环境,都在同一个信任域里。

### 3.9 可观测性与成本

run 账本记录:状态、道、触发源、起止时间、按模型的 input / output / cache_read / cache_create token、工具调用序列、thinking、截图、审批、接管、最终摘要。SSE 实时推日志。

成本由 Gateway 按价格表计算。SDK 对非 Anthropic 模型报告的 `costUSD` 不可信(S0:`costBasis: unknown`)。按 bot 按天汇总,可设软上限告警。每个 run 记录三种浏览器驱动方式的使用次数。

### 3.10 安全

安全边界是 workspace,不是 bot。同组 bot 之间不设防,这是产品形态的一部分。

- workspace 隔离:每 workspace 独立容器、独立卷、独立网络命名空间。一个 workspace 等于一个信任域。
- 出网:默认拒绝。每 workspace 一份域名白名单,人在 UI 维护,agent 无权修改。白名单外的导航即使是 L0 也拦下转审批。这防的是提示注入外泄数据。
- 提示注入:浏览器与外部工具返回的内容包在"不可信内容"标记里进模型上下文;L2 必须审批;接管期间不截图。
- 审计:所有 L1/L2 动作、审批决定、白名单变更、浏览器锁变更写入追加日志,并记录发起的 bot。
- 明确不做的事:不在 bot 之间做访问控制。要隔离就开新 workspace。按 bot 配权限会带来大量复杂度,却挡不住同一台电脑上的任何东西。
- **默认分组规则**:一个业务场景一个 workspace。浏览不受信站点的 bot(场景 1 测试)与持有生产凭证的 bot(场景 2 数据库、场景 3 数据源)永远不同 workspace。判断标准:如果其中一个 bot 被页面注入劫持,它能拿到的东西是否可接受。
- **容量**:每 run 一个 sidecar 进程,每 bot 两道,SDK 官方指引每会话约 1 GiB 起。一个 3 bot 的 workspace 峰值 6 个 sidecar 加 Chromium,容器内存按 8 GiB 起规划;M1 用真实 run 测峰值 RSS 后修正。

---

## 4. 数据模型(Gateway SQLite)

```
workspaces       id, name, sandbox_provider, status(ready|needs_login|disabled),
                 probe_url, probe_rule_json, created_at
browser_locks    workspace_id, holder_kind(run|human), holder_run_id, acquired_at, expires_at
bots             id, name, role, workspace_id, model, cheap_model, soul_version,
                 connectors_json, cron_json, created_at
threads          id, workspace_id, kind(chat|bus), channel, title, turn_budget,
                 status(active|paused), created_at, updated_at
thread_members   thread_id, bot_id, last_seen_seq, joined_at
thread_messages  id, thread_id, seq, author_kind(human|bot|system), author_id,
                 body, attachments_json, mentions_json, relay_count, run_id, ts
bot_sessions     bot_id, thread_id, sdk_session_id, updated_at
runs             id, bot_id, thread_id, lane(interactive|background),
                 trigger_kind(thread_message|cron|webhook|approval), trigger_ref,
                 status, sdk_session_id, resume_payload_json, started_at, finished_at, summary_json
run_usage        id, run_id, model, input_tokens, output_tokens, cache_read_tokens,
                 cache_create_tokens, cost_usd
prices           id, model, input_per_m, output_per_m, cache_read_per_m, cache_create_per_m, effective_from
run_events       id, run_id, seq, kind(tool_call|tool_result|thinking|screenshot|log|approval|takeover),
                 payload_json, ts
approvals        id, run_id, action_json, risk_level, decision, decided_by, decided_at, wait_mode(live|deferred)
approval_rules   id, bot_id, matcher_json, decision, created_from_approval_id
egress_rules     id, workspace_id, domain_pattern, created_by, created_at
knowledge_docs   id, path, title, body, source_run_id, approved_by, updated_at
knowledge_fts    FTS5 虚表
connectors       id, kind, name, config_json
secrets          id, owner_kind(connector|workspace|model), owner_id, encrypted_blob, rotated_at
```

`bot_messages` 已由 `thread_messages` 取代(ADR-0005):bot 私信是 `bus` 线程里的消息。

run 状态机:

```
queued → running → succeeded | silent | failed | cancelled
              ↓
   waiting_approval_live → running        (短等待,进程未退)
              ↓
   waiting_approval      → running        (defer 落盘,resume)
              ↓
   waiting_browser       → running        (人接管中或 workspace needs_login,解除后续跑)
```

`silent`:线程唤醒的 run 正常结束但 `reply` 为空,bot 选择不回;账本里与 `succeeded` 分开,两道闸都不计它。

---

## 5. 一次 run 的时序

1. 触发到达 Gateway。线程消息先落 `thread_messages`,再按 3.7 的规则决定唤醒谁、是否并行或轮流、有没有触到闸;每个被唤醒的 bot 按线程 kind(`chat` 交互道、`bus` 后台道)或触发源落道,写 `runs` 状态 `queued`,同 `(bot, thread)` 已排队则合并。
2. 调度器确认该 bot 该道无进行中 run,置 `running`。在该 bot 所属 workspace 里起一个 sidecar 进程,传入载荷与短期模型 token。同一 workspace 里可能已有其他 bot 的 sidecar 在跑。
3. sidecar 组装上下文,注册 workspace 的 MCP,调用 `query()`。
4. 每次工具调用进 `PreToolUse` hook:出网白名单、浏览器锁、风险分级、脱敏。L0/L1 放行;L2 进 `canUseTool` 短等待。
5. 短等待超时则 hook 返回 `defer`,run 置 `waiting_approval`,进程退出。人决定后 Gateway 用 `resume` 重开,注入决定,继续。
6. 浏览器若被人接管或 workspace 处于 `needs_login`,浏览器工具返回等待信息,必要时 run 置 `waiting_browser`。
7. 结束后 agent 输出结构化摘要;sidecar 追加日记、上报按模型用量、提交知识入库建议。
8. Gateway 把摘要里的 `reply` 作为该 bot 的消息发进线程(为空则 run 记 `silent`),解析其中的 @ 并回到第 1 步唤醒下一个 bot;计价、置终态、SSE 通知客户端。

---

## 6. 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| Gateway | Node.js + Fastify + SQLite(better-sqlite3) | 单进程好部署,与仓库其余部分技术栈一致 |
| Agent loop | Claude Agent SDK(0.3.278 已验证) | 工具调用、规划、错误恢复、defer 与 resume 都是内置 |
| 沙箱 | SandboxProvider 接口;Docker 默认。一个 workspace 一个容器 | Docker 自托管最简;接口留给 Desktop VM 与托管沙箱 |
| 镜像 | `mcr.microsoft.com/playwright:v1.58.2-noble` + Xvfb、x11vnc、noVNC、xdotool | S0 已验证;MCP、CLI、SDK 必须预装 |
| 浏览器 | 单实例 Chromium + Playwright MCP / CLI + 截图回退,全组共用 | 树模式便宜可复现,CLI 省 token,视觉补盲区;共用是产品要求 |
| 屏幕 | Xvfb + noVNC | 人可接管,零客户端安装 |
| tty | node-pty 封装的 `tty_session` 工具 | 交互式 CLI、超时、控制符 |
| 连接器 | MCP 优先,Composio 补 SaaS | MCP 已成标准 |
| Web UI | React + Vite | 与 Cogbox 前端一致 |
| 渠道 | Slack Bolt、grammY | 成熟 SDK,M3 |

放弃的选项:Claude Managed Agents(不能自托管、不能换模型,保留为未来 Provider);托管沙箱(Provider 接口后补);fork OpenMausBot(绑定桌面形态);直接在 Paperclip 上做(体量大,保留为上层);自研 CDP 代理(违反标准件原则);共享 profile 卷(必然损坏);身份对象加按 bot 授权(ADR-0004:复杂度高,且在同一台电脑上挡不住任何东西)。

---

## 7. 与现有资产的衔接

| 现有资产 | 衔接方式 |
|---|---|
| 桌面端 VM | 实现 `DesktopVMProvider`;桌面应用作为一个客户端 |
| 模型代理与 skill 市场 | 模型代理、用量计量、skill 市场;代理需满足 S0 结果文档的透传清单,只接受 Bearer |
| Anthropic 协议模型网关 | 已验证可作为模型代理;GLM / DeepSeek / Qwen 可用 |
| 数据库 MCP Server | 内置连接器;bot 用 Gateway 签发的服务身份访问 |
| 数据库 skill / 数据库 guidance | 知识库初始内容和 bot 技能 |
| fund-tool | 量化场景第一个 CLI 工具样例 |
| Paperclip | 需要多人治理时,把 Gateway 封成 adapter |

---

## 8. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| S0(已完成,2026-09-20) | 模型代理透传;defer 与 resume;共享浏览器 | 三项通过,见 S0 结果文档 |
| M0(2 周) | `contracts`;Gateway 骨架与 SQLite 迁移;Docker Provider;单 workspace 单 bot;sidecar 的 SDK 循环与 hook 骨架;Chromium + Playwright MCP;Web 聊天;**浏览器端点与模型来自配置** | 一个 bot 按聊天指令登录网站完成一个表单,截图入账本;换模型只改 `.env` |
| M1(4 周) | 两条调度道;cron;webhook;审批双模式与规则;出网白名单;noVNC 接管与浏览器锁;tty 工具;按模型计价;账本回放 | bot 定时执行;L2 短等待 5 分钟后落盘,次日批准续跑;人接管完成验证码后 agent 继续;成本看板按模型拆分 |
| M2(4 周) | **同一 workspace 内多 bot 并发**;群线程:@ 唤醒、轮流唤醒、两道闸、`thread_post`、`message_bot`;知识库;MEMORY 规则;视觉回退;CLI 模式;第二个 workspace 与隔离切换 | 人登录一次,两个 bot 各开 tab 并行在同一站点上作业,共用登录态;人在群里 @ 两个 bot 同时开工;chief bot 在群里拆解任务给两个专家 bot 并汇总;一条没 @ 的消息只有一个成员回答,其余沉默;人接管时全部等待;shadow DOM 页面通过视觉回退完成 |
| M3(5 周) | 数据库连接器;场景镜像;Slack 渠道;Desktop VM Provider;成本告警 | 三个场景各跑通一条端到端流程 |

S0 之后共 15 周。ADR-0004 砍掉的身份主机工作量回补给 M2 的多 bot 并发,那才是真正的风险点。

---

## 9. 未决问题

1. 模型路径:模型代理前置 Claude,还是 Anthropic 协议网关前置 GLM / DeepSeek / Qwen。影响 v0.2 第 10 节评级的基线。
2. ~~Playwright MCP 的 `--allowed-origins` 范围~~。ADR-0004 后不再需要:该参数已不在设计里。存档结论:读 `@playwright/mcp` 0.0.82 源码,实现是 `context.route()`,即 context 级,多实例共用一个 context 会互相冲突;官方文档也写明它不是安全边界且对重定向无效。
3. 桌面端 VM 是一 VM 一 workspace 还是一 VM 多容器。
4. 数据库 MCP Server 的服务身份签发与轮换。
5. 知识库先 FTS5 还是从第一天接数据库向量。建议先 FTS5。
6. 短等待默认 5 分钟是否按 bot 可配。
7. ~~跨容器 CDP 的监听地址与来源限制~~。ADR-0004 后不再需要:MCP 与 Chromium 同在一个 workspace 容器内,CDP 只在 `127.0.0.1` 上。
8. 同一 workspace 内多个 bot 并发时,浏览器锁的粒度够不够。当前设计只有 workspace 级一把锁,可能把本可并行的 tab 也串起来。M2 第一周按真实场景校准。
9. workspace 容器的内存上限与每 bot 并发 sidecar 数的关系。M1 实测。
10. 群线程里没 @ 的消息按成员数轮流唤醒,成本随成员数线性增长。省钱手段(先用 `CHEAP_MODEL` 判断该不该答;可选的线程 owner)是待测旋钮,M2 在 `acceptance/m2-group` 上实测后再定;`turn_budget` 默认 8 同期校准。
11. 运行中收到 @ 是跑完再唤醒,还是用 SDK 的流式输入喂进当前 session。M2 看重唤醒延迟是否可感再定。

---

## 10. 已验证与待验证

| 假设 | 状态 | 依据 |
|---|---|---|
| SDK 经自定义 Base URL 跑通流式、工具、cache | 已验证 | S0 test-a,glm-5.3 与 deepseek-v4.1-flash |
| L2 动作 defer、进程退出、resume 续跑 | 已验证 | S0 test-b,两个独立进程 |
| 回调可长时间阻塞 | 已验证 | S0 test-b short-wait,20 秒 |
| 一个 Chromium 被 MCP、人、截图并发接入 | 已验证 | S0 test-c |
| 无障碍树看不到 closed shadow root,坐标可命中 | 已验证 | S0 test-c |
| cookie 落到 profile 卷 | 已验证 | S0 test-c |
| Playwright CLI 可 attach 到同一 CDP | 文档级 | `attach --cdp` |
| ~~跨沙箱借用远端 MCP~~ | 不再需要 | ADR-0004 后 MCP 与 Chromium 同容器 |
| ~~MCP origin 过滤的作用范围~~ | 已归档 | 源码为 `context.route()`,context 级;设计里已不使用 |
| 同一 workspace 内多个 sidecar 并发共用一个 Chromium 与一把锁 | 待验证 | M2 第一周 |
| workspace 内存峰值 | 待验证 | M1 |
| 小时级 defer 后 resume | 待验证 | M1 |
| 跨主机 session 转录 | 待验证 | M1,持久卷或 SessionStore |
| 容器网络层出网白名单 | 待验证 | M1 |

---

## 11. 场景结论(摘自 v0.2 第 11 节)

| 场景 | 可行性 | 平台覆盖 | 领域层主要工作 | 最大风险 |
|---|---|---|---|---|
| 自动化产品测试 | 高 | 约 75% | oracle 定义、脚本固化、环境重置 | 把非确定性探索误当回归 |
| 数据平台开发 | 中高 | 约 55% | schema 知识库、导入向导、治理规则 | NL 到 SQL 在复杂库上的准确率 |
| 量化投研小组 | 中低 / 中高 | 约 30% | 确定性回测引擎、偏差校验工具、数据源 | 统计不严谨与结果幻觉 |

推进顺序一、二、三。评级假设 Claude 级模型;若部署模型是 GLM / DeepSeek,M0 验收时重新基线。

---

## 12. 风险矩阵

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 浏览器 agent 可靠性不足 | 高 | 中 | 三模式驱动,脚本承担回归 |
| 无障碍树盲区 | 中 | 中 | 视觉回退;M2 验收含 shadow DOM 页面 |
| 部署模型在长任务上不及 Claude 级 | 中 | 高 | M0 验收在部署模型上重新基线;关键 bot 可配 Claude |
| 审批落盘后 resume 失败 | 低(已验证) | 高 | 账本摘要 + 审批结果重开新 session;持久卷 |
| 提示注入通过网页内容 | 中 | 高 | 出网默认拒绝;不可信内容标记;L2 审批 |
| 单个 bot 被注入后影响整个 workspace | 中 | 高 | 接受的产品代价。一 workspace 一信任域;出网默认拒绝;L2 仍审批;按 3.10 默认分组,场景 1 与场景 2/3 不同 workspace |
| 同组 bot 可读彼此的会话转录与 `/profile` 的 cookie 库 | 高(必然) | 中 | 接受:同一信任域。不在 workspace 里放不属于该信任域的账号;账本与转录脱敏降低泄露面 |
| workspace 内存不足导致 sidecar 被杀 | 中 | 中 | 按 3.10 容量规划;M1 实测;调度器按 workspace 限制并发 sidecar 数 |
| workspace 掉登录导致全组停摆 | 中 | 中 | 探活;`needs_login` 统一等待并通知人 |
| 多 bot 在同一浏览器和文件系统上互相踩 | 中 | 中 | 每 run 独立 tab;workspace 浏览器锁;工作目录约定;M2 第一周校准锁粒度 |
| token 成本失控 | 中 | 中 | 按 bot 日预算;CLI 替代 MCP 长会话;降本模型 |
| 数据库引擎不稳定被归咎于 bot | 中 | 中 | 错误分类,引擎错误走缺陷单 |
| 量化结果不可复现 | 高 | 高 | 报告数字必须来自 run 产物 |
| 多 bot 互相唤醒失控 | 低 | 中 | 允许列表 + 中继上限 |
| 模型代理不透传 | 低(已验证) | 高 | 按 S0 清单实现 |
| 人接管期间 agent 误操作 | 低 | 高 | workspace 级浏览器锁;接管期间不截图 |
