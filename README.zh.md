# lark-channel 技术文档

将飞书群聊与 Claude Code Agent 深度打通，每个群拥有独立的 Agent 会话，支持实时流式卡片输出。每个群是一个工作空间：Agent 持有持续会话上下文，对话历史不断；工作目录是磁盘上专属的文件夹，所有文件操作都落在这里。

```
用户: 最近有什么新 issue？
       |
       v  ~100ms
[EYES reaction]       ← Agent 已收到
       |
       v
[文字卡片]             ← 实时流式，逐 token 推送
  我来查一下...
       |
       v
[Bash 卡片]           ← 工具调用
  gh issue list --state open
  ─────────────────────────────
  #142 Fix streaming bug · 2h ago
  #141 Add webhook support · 5h ago
       |
       v
[文字卡片]             ← 流式结果
  找到 10 个 open issue...
       |
       v
[Done · 4s | 2 tool calls]   ← DONE reaction
```

---

## 核心心智模型

**群 = 终端窗口。** 每个飞书群就是一个对话工作空间：一个 Agent、一个 `cwd`、一个持续会话。在同一个群里追问，Agent 记得上文——就像在同一个终端窗口里继续工作。

**总管群 = 终端管理器。** 一个特殊的群充当命令中心。告诉它你要做什么，它创建一个新群（工作空间），配置好 Agent 人格、专属文件夹和配置，把你拉进去。工作做完后，告诉它关闭这个工作空间。

```
总管群
├── "帮我创建一个调试支付服务的工作空间"
│       → 创建群 "payment-debug"
│       → 创建 ~/.lark-channel/workspaces/payment-debug/
│       → 写 agents/payment-debug.md（人格：后端调试 Agent）
│       → 重启 bridge，把你加入群
│
├── "列出我的工作空间"
│       → 展示所有活跃的群及其用途
│
└── "关闭 payment-debug"
        → 删除配置，重启 bridge（文件夹保留在磁盘）
```

每个工作空间群里运行着一个 coding agent，工作目录指向对应文件夹。Agent 的所有操作——克隆代码库、创建文件、跑脚本——都落在那个文件夹里。

---

## 一、安装与配置

### 1.1 安装飞书 CLI

```sh
npm install -g @larksuite/cli
```

前往 [open.feishu.cn](https://open.feishu.cn) 创建自建应用，然后配置凭证：

```sh
lark-cli config init
# 按提示输入 App ID、App Secret、区域（feishu 或 lark）
```

**应用所需权限：**
- `im:message`
- `im:message:send_as_bot`
- `im:reaction`

**事件订阅：**
- `im.message.receive_v1`

将机器人添加到目标群聊。

### 1.2 安装 Claude Agent SDK（Python）

```sh
pip install claude-agent-sdk
```

当前实现使用 Python 子进程运行 Agent worker，原因是 Python SDK 对跨消息 `resume`（会话恢复）的支持最成熟。TypeScript SDK（`@anthropic-ai/claude-agent-sdk`）是长期演进方向——进程内会话管理，无子进程开销——待其 V2 API 稳定后可迁移。

### 1.3 安装 lark-channel

```sh
git clone https://github.com/shareAI-lab/lark-channel
cd lark-channel
bun install
```

需要 [Bun](https://bun.sh) >= 1.0。

### 1.4 初始化配置目录

```sh
mkdir -p ~/.lark-channel/agents
cp agents.example/_feishu_workspace.md ~/.lark-channel/agents/
# 创建第一个 Agent 配置文件（见下方"Agent 文件格式"）
```

### 1.5 启动

```sh
bun start
```

---

## 二、让 Agent 帮你安装

如果想用 AI 辅助完成安装，将以下提示词复制给 Claude Code：

```
请帮我在这台机器上安装和配置 lark-channel。

步骤：
1. 确认 Bun（https://bun.sh）已安装，未安装则安装
2. 安装飞书 CLI：npm install -g @larksuite/cli
3. 克隆并安装：git clone https://github.com/shareAI-lab/lark-channel && cd lark-channel && bun install
4. 安装 Python SDK：pip install claude-agent-sdk
5. 引导我在 https://open.feishu.cn 创建飞书自建应用：
   - 需要开启的权限：im:message、im:message:send_as_bot、im:reaction
   - 需要订阅的事件：im.message.receive_v1
   - 开启机器人能力，并将机器人加入至少一个群
6. 配置 lark-cli：lark-cli config init（输入 App ID 和 App Secret）
7. 创建第一个 Agent 配置文件到 ~/.lark-channel/agents/
8. 启动：cd lark-channel && bun start

每步完成后告诉我结果，确认后再继续下一步。
```

---

## 三、总管群：工作空间管理中心

总管 Agent 负责创建和管理所有工作空间，自身不承担具体的技术工作。

### 3.1 创建总管群

```sh
lark-cli im +chat-create --name "lark-channel 总管" --type private --set-bot-manager --as bot
# 记录返回的 chat_id
```

### 3.2 创建 `~/.lark-channel/agents/manager.md`

```md
---
chat_id: oc_你的总管群ID
name: manager
cwd: ~/lark-channel
permission_mode: bypassPermissions
---

你是 lark-channel 的工作空间管理员。负责创建和管理所有 Agent 工作空间。

每个工作空间由三部分组成：
- 一个飞书群（人与 Agent 的交互界面）
- 一个文件夹 ~/.lark-channel/workspaces/{name}/（Agent 的工作目录）
- 一个配置文件 ~/.lark-channel/agents/{name}.md

用户要求创建工作空间时：
1. 询问：这个工作空间的目的和主要任务是什么？
2. 建议一个简短的英文 slug（小写、连字符）
3. 创建飞书群：
   lark-cli im +chat-create --name "{name}" --type private --set-bot-manager --as bot
4. 把用户加入群：
   lark-cli api POST /open-apis/im/v1/chats/{chat_id}/members --data '{"id_list":["USER_OPEN_ID"],"member_id_type":"open_id"}' --as bot
5. 创建工作目录：
   mkdir -p ~/.lark-channel/workspaces/{name}
6. 编写 ~/.lark-channel/agents/{name}.md：
   - chat_id：步骤 3 返回的值
   - cwd：~/.lark-channel/workspaces/{name}
   - permission_mode：根据任务敏感度判断
   - persona：根据用户描述的任务定制（角色定位、使用工具、性格风格、权限边界）
7. 重启 bridge：
   pkill -f "bun.*index.ts"; cd ~/lark-channel && bun run src/index.ts &

列出工作空间：读取 ~/.lark-channel/agents/ 下所有文件（跳过 _ 开头的）。
关闭工作空间：删除对应的 .md 文件，重启 bridge。

回复简洁，使用用户的语言。
```

### 3.3 重启 bridge

```sh
bun start
```

总管群即可使用。

---

## 四、工作空间布局

```
~/.lark-channel/
├── agents/
│   ├── _feishu_workspace.md      # 共享上下文，追加到每个 Agent 的 system prompt
│   ├── manager.md                # 总管 Agent
│   └── *.md                      # 各工作空间的 Agent 配置（由总管自动创建）
├── workspaces/
│   ├── payment-debug/            # payment-debug 群的工作目录
│   ├── frontend-refactor/        # frontend-refactor 群的工作目录
│   └── ...                       # 平铺列表，一个群对应一个文件夹
├── sessions.json                 # 运行时状态：chat_id → session_id（自动管理）
└── access.json                   # 发送者白名单（policy: allowlist 时使用）
```

工作空间可移植：压缩文件夹和对应的 `.md` 文件即可迁移或分享。

---

## 五、Agent 文件格式

`~/.lark-channel/agents/*.md` 每个文件定义一个群的 Agent：

```md
---
chat_id: oc_84f7f942e8067a61dd61a434fc92ef6a
name: learn-claude-code
cwd: ~/repos/learn-claude-code
permission_mode: default
schedule:
  - cron: "0 9 * * 1-5"
    prompt: "检查 stale PR（>3天无 review）、未回复的 issue、CI 失败。发送摘要。"
---

你是 shareAI-lab/learn-claude-code 的维护 Agent。
TypeScript 教育仓库（44k+ stars）。使用 gh CLI 操作 GitHub。
用用户的语言回复。回复简洁，适合手机阅读。
```

`permission_mode` 取值：`default` | `acceptEdits` | `bypassPermissions`

以 `_` 开头的文件是共享上下文块，自动追加到每个 Agent 的 system prompt 末尾。`_feishu_workspace.md` 告知 Agent 飞书能力（如何创建文档、多维表格、任务等）。

---

## 六、通信原理

### 6.1 飞书侧：lark-cli 核心能力

**事件订阅（WebSocket 长连接）**

飞书提供两种事件接收方式：HTTP 回调（需公网地址）和 WebSocket 长连接（无需公网）。lark-channel 采用 WebSocket 模式：

```sh
lark-cli event +subscribe \
  --event-types im.message.receive_v1 \
  --compact --quiet --as bot --force
```

`--compact` 让每条事件以单行 JSON（NDJSON）输出到 stdout，bridge.ts 持续读取此流。每条事件包含：
- `event.message.chat_id`：群 ID，用于路由到对应 Agent
- `event.message.message_id`：消息 ID，用于回复和加 reaction
- `event.sender.sender_id.open_id`：发送者 ID，用于访问控制
- `event.message.content`：消息内容

**Reaction：毫秒级状态反馈**

```sh
# 收到消息 → 立即加 EYES（~100ms）
lark-cli api POST /open-apis/im/v1/messages/{message_id}/reactions \
  --data '{"reaction_type":{"emoji_type":"EYES"}}' --as bot

# 完成 → DONE，出错 → BANGBANG
```

**Interactive Card + PATCH：实时流式更新**

卡片消息通过 `PATCH /open-apis/im/v1/messages/{message_id}` 原地更新，对用户**即时可见**（实时推送，不是刷新）。每次 PATCH 往返约 250ms，这是文字流式输出的视觉刷新率。

lark-channel 评估过飞书 CardKit 2.0 的打字机效果，但它是"录制回放"机制——所有更新在 streaming_mode 关闭后才播放动画，用户在此期间看不到任何内容。因此选用 PATCH 方案。

**PatchScheduler：避免并发冲突**

飞书不允许同一消息同时有多个 PATCH 请求。PatchScheduler 实现 latest-wins 排队：有请求在途时新内容覆盖队列，请求完成后立即发送最新内容，自然限速于 API 往返时间。

### 6.2 Agent SDK 侧：实时流式捕获

**会话持久化（resume）**

`ClaudeAgentOptions` 的 `resume` 参数接受上次会话的 `session_id`，让 Claude Code 继续同一对话上下文：

```python
options = ClaudeAgentOptions(
    system_prompt={"type": "preset", "preset": "claude_code", "append": persona},
    cwd=cwd,
    resume=session_id,          # 跨消息保持上下文
    permission_mode=permission_mode,
    model="claude-sonnet-4-6",
    include_partial_messages=True,  # 启用实时流式事件
    disallowed_tools=["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"],
)
```

`session_id` 从每次请求的 `ResultMessage.session_id` 获得，按 `chat_id` 存入 `sessions.json`，下次消息时传入 `resume`。

**StreamEvent：逐 token 实时推送**

`include_partial_messages=True` 让 `receive_response()` 在处理过程中持续发出 `StreamEvent`，包含原始 Claude API 流式事件：

| 事件类型 | 含义 |
|---------|------|
| `content_block_start` + `tool_use` | 工具调用开始，获得工具名 |
| `content_block_delta` + `text_delta` | 实时文字 token |
| `content_block_delta` + `input_json_delta` | 工具输入 JSON 流式拼接 |
| `content_block_stop` | 工具调用输入 JSON 完整 |

**UserMessage + ToolResultBlock：工具执行结果**

工具执行完毕后，SDK 将结果注入对话上下文并同步发出给调用方，以 `UserMessage` 中的 `ToolResultBlock` 形式出现。lark-channel 捕获这些结果并展示在对应工具卡片里（前几行输出、行数等）。

### 6.3 完整数据流

```
用户发消息 "查看最近的 PR"
    |
    v  lark-cli WebSocket
[bridge.ts] 解析 NDJSON 事件
    | chat_id / sender_id / message_id / content
    v
[router.ts] chat_id → AgentConfig（cwd, persona, permissionMode）
    v
[access.ts] 检查 sender_id 白名单
    v
[queue.ts] 入队（群内串行，跨群并行）
    v
[lark.ts] addReaction("EYES") → 飞书立即显示
    v
[agent.ts] 启动 Python 子进程
    | stdin: JSON 请求
    | stdout: NDJSON chunks
    v
[agent_worker.py]
    StreamEvent(text_delta)     → emit {type:"text"}      ← 逐 token
    StreamEvent(tool_use)       → emit {type:"tool_use"}  ← 工具调用完整输入
    UserMessage(ToolResultBlock)→ emit {type:"tool_result"}← 工具执行结果
    ResultMessage               → emit {type:"result", sessionId}
    |
    v
[reply.ts] 逐块创建/更新卡片
    {type:"text"}     → 首次 replyCard，后续 PatchScheduler.push
    {type:"tool_use"} → flushTextBlock + replyCard（新工具卡片）
    {type:"tool_result"} → PATCH 工具卡片，展示输出预览
    stream 结束       → flushTextBlock + replyCard(Done)
    v
[sessions.ts] 保存新 session_id，供下次 resume
```

---

## 七、多卡片布局设计

所有卡片都是对原始消息的线程回复，展开后呈现完整执行过程：

```
用户消息：查看最近的 PR
├─ [白色卡片] 文字（流式打出）
│    我来查看一下最近的 PR。
│
├─ [橙色 Bash]
│    gh pr list --state open --limit 10
│    ────────────────────────────────
│    #145  Add streaming support · 2h ago
│    #144  Fix session resume bug · 5h ago
│
├─ [白色卡片] 文字（流式打出）
│    **最近 PR 汇总**
│    共 8 个开放中的 PR：...
│
└─ [绿色 Done · 4s | 2 tool calls]
```

**工具卡片颜色方案：**

| 工具 | 颜色 |
|------|------|
| Bash | 橙色 |
| Read / Write / Edit | 蓝色 |
| Grep / Glob | 青绿色 |
| WebSearch / WebFetch | 天蓝色 |
| Agent / Task | 紫色 |
| TaskCreate / Update | 靛蓝色 |
| Done | 绿色 |
| Error | 红色 |

飞书卡片 `tag:"markdown"` 元素不支持 `#` 标题语法，lark-channel 在推送前自动转换：

```typescript
function feishuMd(text: string): string {
  return text
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**')
    .replace(/^\n+/, '')
}
```

---

## 八、访问控制

**open 模式**（默认）：所有配置群的成员均可使用。

**allowlist 模式**：仅白名单成员可使用。

```yaml
access:
  policy: allowlist
```

通过 pairing code 添加用户（无需修改配置）：

```
# 群主发送：
admin pair ABCDE

# 新用户发送：
pair ABCDE
```

---

## 九、定时巡检

每个群可配置定时 prompt（cron 表达式，本地时区）：

```yaml
schedule:
  - cron: "0 9 * * 1-5"     # 工作日早 9 点
    prompt: "检查 stale PR（>3天无 review）、未回复的 issue、CI 失败。发送摘要。"
  - cron: "0 18 * * 5"      # 周五下午 6 点
    prompt: "周报：本周合并了什么？下周有什么阻塞项？"
```

---

## 十、会话管理

会话跨消息持续，Agent 记得上下文。过期时间由 `session_ttl`（默认 7 天）控制，到期自动清除创建新会话。

```sh
cat ~/.lark-channel/sessions.json            # 查看活跃会话
echo '{}' > ~/.lark-channel/sessions.json   # 清空所有会话（全部重置上下文）
```

---

## 十一、性能说明

- **事件延迟**：收到消息 → EYES reaction 约 100ms（Go 二进制直调）
- **首张卡片**：约 1-3 秒（Claude API 首 token 延迟）
- **PATCH 刷新率**：自然限速于 API 往返时间 ~250ms/次
- **并发**：N 个群同时运行各自的 Agent，互不阻塞
- **会话恢复**：`resume` 令 Agent 无需重读文件即可接续上下文

---

## 十二、关键文件索引

| 文件 | 职责 |
|------|------|
| `src/bridge.ts` | lark-cli WebSocket 事件流接收与解析 |
| `src/router.ts` | 配置加载，chat_id → AgentConfig 路由 |
| `src/queue.ts` | 跨群并行、群内串行的异步消息队列 |
| `src/agent.ts` | Python 子进程管理，NDJSON chunk 流读取 |
| `agent_worker.py` | Claude Agent SDK 封装，StreamEvent 解析，工具结果捕获 |
| `src/reply.ts` | 多卡片流式回复引擎，PatchScheduler，工具卡片构建 |
| `src/lark.ts` | lark-cli 命令封装，Go 二进制路径优化（节省 ~70ms/次） |
| `src/sessions.ts` | session_id 按群持久化（JSON），TTL 自动清理 |
| `src/access.ts` | 发送者访问控制，pairing code 机制 |
| `src/patrol.ts` | cron 定时巡检任务调度 |
| `src/index.ts` | 入口：加载配置、串联模块、信号处理 |
