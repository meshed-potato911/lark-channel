# lark-channel 技术文档

将飞书群聊与 Claude Code Agent 深度打通，每个群拥有独立的 Agent 会话，支持实时流式卡片输出。

---

## 通信原理概览

lark-channel 把三个独立系统的能力拼接在一起：

```
飞书群聊
  │  用户发消息
  │
  ▼
lark-cli (Go 二进制)
  │  WebSocket 事件流 (NDJSON)
  │
  ▼
lark-channel (Bun/TypeScript 进程)
  │  路由 → 队列 → 子进程
  │
  ▼
agent_worker.py (Python 子进程)
  │  Claude Agent SDK
  │  StreamEvent 实时 token
  │
  ▼
lark-channel reply.ts
  │  多卡片流式推送
  │
  ▼
飞书群聊
  多张卡片：文字流式 | 工具调用 | 结果预览 | Done
```

---

## 一、飞书侧：lark-cli 的核心能力

### 1.1 事件订阅：WebSocket 长连接

飞书开放平台提供两种事件接收模式：HTTP 回调（需要公网地址）和 WebSocket 长连接（无需公网）。lark-channel 选用 WebSocket 模式，通过 lark-cli 建立连接：

```sh
lark-cli event +subscribe \
  --event-types im.message.receive_v1 \
  --compact \
  --quiet \
  --as bot \
  --force
```

`--compact` 让每条事件以单行 JSON（NDJSON）输出到 stdout，`--force` 表示如已有连接则断开旧连接重建。bridge.ts 持续读取这个 NDJSON 流：

```typescript
// bridge.ts: 启动 lark-cli 子进程，逐行解析事件
const proc = spawn([LARK_CLI, 'event', '+subscribe', '--event-types', 'im.message.receive_v1',
                    '--compact', '--quiet', '--as', 'bot', '--force'], { stdout: 'pipe' })

const reader = proc.stdout.getReader()
// 每读到一行 → 解析 JSON → 提取 chat_id / sender_id / content → 路由
```

每条 `im.message.receive_v1` 事件包含：
- `event.message.chat_id`：群 ID，用于路由到对应 Agent
- `event.message.message_id`：消息 ID，用于回复和加 reaction
- `event.sender.sender_id.open_id`：发送者 ID，用于访问控制
- `event.message.content`：消息内容（JSON 字符串）

### 1.2 Reaction：毫秒级状态反馈

飞书支持对消息添加 emoji reaction，lark-channel 用它作即时 ACK：

```sh
# 收到消息 → 立即加 EYES（~100ms 内）
lark-cli api POST /open-apis/im/v1/messages/{message_id}/reactions \
  --data '{"reaction_type":{"emoji_type":"EYES"}}' \
  --as bot

# 处理完成 → 加 DONE
# 出错 → 加 BANGBANG
```

EYES reaction 出现代表 Agent 已接收消息并开始处理，用户无需等待第一张卡片出现就知道系统响应了。

### 1.3 Interactive Card：结构化卡片消息

飞书的 Interactive Card（互动卡片）是 lark-channel 流式输出的载体。卡片由 JSON 描述，支持 markdown 内容、彩色 header、按钮、分割线、注释等元素。

**发送一张卡片（作为回复）：**
```sh
lark-cli im +messages-reply \
  --message-id om_xxx \
  --msg-type interactive \
  --content '{"config":{"wide_screen_mode":true},"header":{"title":{"tag":"plain_text","content":"Bash"},"template":"orange"},"elements":[{"tag":"markdown","content":"```\nls -la\n```"}]}' \
  --as bot
```

返回值中包含新卡片消息的 `message_id`，后续所有 PATCH 更新都需要这个 ID。

### 1.4 PATCH 消息：实时卡片内容更新

这是实现流式输出的关键 API。`PATCH /open-apis/im/v1/messages/{message_id}` 可以原地更新一条已发送的卡片消息，且**更新立即对用户可见**（不是刷新，是实时推送）：

```sh
lark-cli api PATCH /open-apis/im/v1/messages/{message_id} \
  --data '{"msg_type":"interactive","content":"{更新后的卡片 JSON}"}' \
  --as bot
```

每次 PATCH 的延迟约 250ms（API 往返），这决定了文字流式输出的视觉刷新率。

**PATCH 与 CardKit 的选择：**

飞书还提供 CardKit 2.0（`PUT /cardkit/v1/cards/{id}/elements/{eid}/content`），号称支持打字机效果。但经测试，CardKit 元素流式更新是"录制回放"机制：所有更新在 streaming_mode 关闭后才播放动画，期间用户看不到任何内容。PATCH 则是即时更新，因此 lark-channel 选用 PATCH 作为流式推送的底层机制。

### 1.5 PatchScheduler：避免并发 PATCH 冲突

飞书不允许同一条消息同时有多个 PATCH 请求在飞行。lark-channel 实现了 `PatchScheduler`：

```typescript
class PatchScheduler {
  private inFlight = false
  private queued: object | null = null  // latest-wins：只保留最新待发

  push(card: object): void {
    if (this.inFlight) { this.queued = card; return }  // 有请求在途则覆盖排队
    this.fire(card)
  }

  private fire(card: object): void {
    this.inFlight = true
    patchMessage(this.cardMessageId, card).finally(() => {
      this.inFlight = false
      if (this.queued) { const next = this.queued; this.queued = null; this.fire(next) }
    })
  }
}
```

token 流来得再快，实际 PATCH 频率自然限制在 API 往返时间（~250ms/次），不会触发飞书限流（标准限制 50 req/min）。

---

## 二、Agent SDK 侧：实时流式捕获

### 2.1 ClaudeSDKClient：会话管理

Claude Agent SDK（Python）提供 `ClaudeSDKClient`，封装了 Claude Code 的完整 subprocess 管理：

```python
options = ClaudeAgentOptions(
    system_prompt={"type": "preset", "preset": "claude_code", "append": persona},
    cwd=cwd,                              # Agent 的工作目录
    resume=session_id,                    # 恢复已有会话（关键：跨消息保持上下文）
    permission_mode="bypassPermissions",  # 权限模式
    model="claude-sonnet-4-6",
    disallowed_tools=["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"],
    include_partial_messages=True,        # 关键：启用实时流式事件
)

async with ClaudeSDKClient(options) as client:
    await client.query(message)
    async for msg in client.receive_response():
        ...
```

### 2.2 `resume`：跨消息持久会话

`resume` 接受上次会话的 `session_id`，让 Claude Code 继续同一个对话上下文。用户在群里追问时，Agent 记得上文：

```
用户：最近有什么新 issue？
Agent：找到 12 个新 issue，分三类：...

用户：第 3 个详细说说
Agent：（记得第 3 个是什么，无需重新获取）详细分析如下...
```

`session_id` 由每次请求的 `ResultMessage.session_id` 返回，lark-channel 将其按 `chat_id` 存入 `~/.lark-channel/sessions.json`，下次消息时传入 `resume`。会话有 TTL（默认 7 天），到期自动清除创建新 session。

### 2.3 `include_partial_messages=True`：实时 token 流

这是流式输出的核心开关。不开启时，`receive_response()` 只在 Agent 处理完整个请求后发出 `ResultMessage`；开启后，还会实时发出 `StreamEvent` 对象，包含原始 Claude API 流式事件。

`receive_response()` 发出的消息类型：

| 类型 | 时机 | 用途 |
|------|------|------|
| `StreamEvent` | 每个流式 API 事件 | 实时文字 token、工具调用开始 |
| `AssistantMessage` | 每条完整 assistant 消息 | 工具结果（附带在随后的用户 turn） |
| `UserMessage` | 工具执行后 | 包含 `ToolResultBlock`（工具返回值） |
| `ResultMessage` | 整个 query 完成后 | 最终结果文本 + 新 session_id |

### 2.4 StreamEvent：逐 token 解析

`StreamEvent.event` 是原始 Claude API streaming 事件的字典，遵循 Anthropic streaming protocol：

```python
async for msg in client.receive_response():
    if isinstance(msg, StreamEvent):
        event = msg.event
        etype = event.get("type", "")

        if etype == "content_block_start":
            block = event.get("content_block", {})
            if block.get("type") == "tool_use":
                current_tool_name = block.get("name")  # 工具名（如 "Bash"）
                current_tool_json = ""

        elif etype == "content_block_delta":
            delta = event.get("delta", {})
            if delta.get("type") == "text_delta":
                # 实时文字 token，逐字推送
                emit({"type": "text", "content": delta.get("text", "")})
            elif delta.get("type") == "input_json_delta":
                # 工具输入 JSON 流式拼接
                current_tool_json += delta.get("partial_json", "")

        elif etype == "content_block_stop":
            if current_tool_name:
                # 工具调用完整，可以解析输入 JSON 了
                emit({"type": "tool_use", "content": f"{current_tool_name}: {current_tool_json}"})
```

关键时序：`text_delta` 在模型生成每个 token 时发出，`content_block_stop` 在工具调用输入 JSON 完整后发出（此时工具尚未开始执行）。

### 2.5 UserMessage + ToolResultBlock：工具执行结果

工具执行完毕后，SDK 将结果作为一条 `UserMessage` 注入对话上下文，并同步发出给调用方：

```python
elif isinstance(msg, UserMessage):
    blocks = msg.content if isinstance(msg.content, list) else []
    for block in blocks:
        if isinstance(block, ToolResultBlock):
            raw = block.content if isinstance(block.content, str) else \
                  "".join(i.get("text","") for i in block.content if isinstance(i,dict))
            line_count = raw.count("\n") + 1
            emit({
                "type": "tool_result",
                "content": raw[:3000],
                "lineCount": line_count,
                "isError": bool(block.is_error),
            })
```

这让 lark-channel 能在工具卡片里展示输出预览（前几行 stdout、文件行数等）。

---

## 三、完整数据流

```
用户发消息 "查看最近的 PR"
    │
    ▼ lark-cli WebSocket
[bridge.ts] 解析 NDJSON 事件
    │ chat_id, sender_id, message_id, content
    ▼
[router.ts] chat_id → GroupConfig（cwd, persona, permissionMode）
    │
    ▼
[access.ts] 检查 sender_id 是否在许可名单
    │
    ▼
[queue.ts] 本群串行队列，入队
    │ （前一条消息处理完才开始）
    ▼
[lark.ts] addReaction(message_id, "EYES")  → 飞书立即显示 EYES
    │
    ▼
[agent.ts] spawn Python subprocess（agent_worker.py）
    │ stdin: JSON 请求（message, sessionId, persona, cwd, ...）
    │ stdout: NDJSON chunks
    ▼
[agent_worker.py]
    ClaudeSDKClient(options, resume=session_id)
    client.query(message)
    for msg in client.receive_response():
        StreamEvent(text_delta)  → emit {type:"text", content:"查"}
        StreamEvent(text_delta)  → emit {type:"text", content:"看一"}
        StreamEvent(text_delta)  → emit {type:"text", content:"下..."}
        StreamEvent(content_block_stop, tool_use=Bash) → emit {type:"tool_use", content:"Bash:{\"command\":\"gh pr list\"}"}
        UserMessage(ToolResultBlock) → emit {type:"tool_result", content:"#42 Fix...", lineCount:8}
        StreamEvent(text_delta)  → emit {type:"text", content:"找到"}
        ...
        ResultMessage → emit {type:"result", sessionId:"new-id"}
    │
    ▼ (TypeScript 逐行读 stdout)
[reply.ts]
    收到 {type:"text"} × N
        → 首次：replyCard → 创建文字卡片 → 获得 card_message_id
        → 后续：PatchScheduler.push(textCard(accumulated_text))
            → patchMessage(card_message_id, ...) 每 ~250ms 更新一次
    收到 {type:"tool_use"}
        → flushTextBlock()（等当前文字卡片发送完）
        → replyCard(toolCard("Bash", "gh pr list", orange))  ← 新卡片
        → 保存 lastToolPatcher（绑定到这张工具卡片）
    收到 {type:"tool_result"}
        → lastToolPatcher.push(toolCard + result_preview)
            → 工具卡片 PATCH 更新，展示输出预览
    收到 {type:"result"}
        → 保存 session_id
    stream 结束
        → flushTextBlock()
        → replyCard(doneCard("Done · 4s | 2 tool calls"))
        → addReaction(message_id, "DONE")
    │
    ▼
[sessions.ts] setSessionId(chat_id, new_session_id)  ← 下次消息时 resume
```

---

## 四、多卡片布局设计

所有卡片都是对原始消息的线程回复（reply），在飞书中显示为"N 条回复"。展开后呈现完整的执行过程：

```
用户消息：查看最近的 PR
│
├─ [白色卡片] 文字（流式打出）
│    我来查看一下最近的 PR 情况。
│
├─ [橙色 Bash]
│    gh pr list --state open --limit 10
│    ────────────────────────────────
│    #145  Add streaming support · 2h ago
│    #144  Fix session resume bug · 5h ago
│    ... 6 more lines
│
├─ [白色卡片] 文字（流式打出）
│    **最近的 PR 汇总**
│
│    共 8 个开放中的 PR：
│    - #145 Add streaming support（2小时前，等待 review）
│    ...
│
└─ [绿色 Done · 4s | 2 tool calls]
```

**工具卡片颜色方案：**

| 工具 | 颜色 | 含义 |
|------|------|------|
| Bash | 橙色 | 终端命令执行 |
| Read / Write / Edit | 蓝色 | 文件操作 |
| Grep / Glob | 青绿色 | 代码搜索 |
| WebSearch / Fetch | 天蓝色 | 网络请求 |
| Task / Agent | 紫色 | 子 Agent 任务 |
| TaskCreate / Update | 靛蓝色 | 任务管理 |
| Done | 绿色 | 完成 |
| Error | 红色 | 出错 |

**Feishu 卡片 Markdown 限制处理：**

飞书卡片 `tag: "markdown"` 元素不支持 `#` 标题语法，lark-channel 在推送前自动转换：

```typescript
function feishuMd(text: string): string {
  return text
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**')  // ## 标题 → **bold**
    .replace(/^\n+/, '')                        // 去除开头空行
}
```

代码块（` ``` `）、加粗（`**`）、斜体（`*`）、行内代码（`` ` ``）、列表（`-`、`1.`）均正常支持。

---

## 五、Agent 配置文件格式

每个群对应一个 `~/.lark-channel/agents/*.md` 文件：

```
---
chat_id: oc_84f7f942e8067a61dd61a434fc92ef6a   # 飞书群 ID
name: learn-claude-code                          # 显示名
cwd: ~/repos/learn-claude-code                   # Agent 工作目录
permission_mode: default                         # SDK 权限模式
schedule:                                        # 可选：定时任务
  - cron: "0 9 * * 1-5"
    prompt: "检查 stale PR、未回复的 issue、CI 失败。发送摘要。"
---

[persona 正文：Agent 的角色说明，注入为 system prompt 的附加内容]

You are the maintainer agent for shareAI-lab/learn-claude-code.
TypeScript 教育仓库，44k+ stars。
使用 gh CLI 操作 GitHub。用用户的语言回复。
```

`_feishu_workspace.md` 是共享的 Feishu 能力块，自动追加到所有 Agent 的 persona 末尾，告知 Agent 它运行在群聊环境中、如何创建飞书文档/表格/任务等。

---

## 六、快速上手

### 安装依赖

```sh
# Bun（macOS/Linux）
curl -fsSL https://bun.sh/install | bash

# Claude Agent SDK
pip install claude-agent-sdk

# lark-cli（需要 Node.js）
npm install -g @larksuite/cli
lark-cli config set   # 配置 app_id, app_secret, bot token
```

### 创建飞书应用

1. 前往 [open.feishu.cn](https://open.feishu.cn) 创建自建应用
2. 开启权限：`im:message`、`im:message:send_as_bot`、`im:reaction`
3. 开启事件：`im.message.receive_v1`
4. 将机器人加入目标群聊

### 配置并启动

```sh
git clone https://github.com/shareAI-lab/lark-channel
cd lark-channel
bun install

cp config.example.yaml config.yaml
# 编辑 config.yaml，填入 chat_id 和 cwd

# 或者使用 agents 文件（推荐）
mkdir -p ~/.lark-channel/agents
cp agents.example/_feishu_workspace.md ~/.lark-channel/agents/
# 编辑并放入你的 agent .md 文件

bun start
```

### 测试

在配置的飞书群发一条消息，应在 100ms 内看到 EYES reaction，随后出现流式卡片。

---

## 七、关键文件索引

| 文件 | 职责 |
|------|------|
| `src/bridge.ts` | lark-cli WebSocket 事件流接收与解析 |
| `src/router.ts` | YAML 配置加载，chat_id → GroupConfig 路由 |
| `src/queue.ts` | 跨群并行、群内串行的异步消息队列 |
| `src/agent.ts` | Python 子进程管理，NDJSON chunk 流读取 |
| `agent_worker.py` | Claude Agent SDK 封装，StreamEvent 解析，工具结果捕获 |
| `src/reply.ts` | 多卡片流式回复引擎，PatchScheduler，工具卡片构建 |
| `src/lark.ts` | 所有 lark-cli 命令封装，Go 二进制路径优化（节省 ~70ms/次） |
| `src/sessions.ts` | session_id 按群持久化（JSON 文件），TTL 自动清理 |
| `src/access.ts` | 发送者访问控制，pairing code 机制 |
| `src/patrol.ts` | cron 定时巡检任务调度 |
| `src/index.ts` | 入口：加载配置、串联所有模块、信号处理 |

---

## 八、性能说明

- **事件延迟**：WebSocket 接收到消息 → EYES reaction 约 100ms（Go 二进制直调，跳过 Node.js wrapper 节省 ~70ms）
- **首张卡片**：收到消息 → 第一张流式文字卡片出现约 1-3 秒（Claude API 首 token 延迟）
- **PATCH 刷新率**：自然限速于 API 往返时间 ~250ms/次，视觉上流畅
- **并发**：N 个群可同时运行各自的 Agent，互不阻塞（共享底层 lark-cli 连接）
- **会话恢复**：`resume` 机制令 Agent 无需重读文件即可接续上下文，跨消息延迟很低
