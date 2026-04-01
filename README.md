# lark-channel

Connect Feishu/Lark group chats to [Claude Code](https://claude.ai/code) agents. Each group is an isolated workspace: the agent has persistent session context, streams responses as real-time Feishu cards, and its working directory is a dedicated folder on disk.

```
User: what are the recent open issues?
       |
       v  ~100ms
[EYES reaction]       ← agent received
       |
       v
[text card]           ← streaming, token by token
  Let me check...
       |
       v
[Bash card]           ← tool call
  gh issue list --state open
  ─────────────────────────────
  #142 Fix streaming bug · 2h ago
  #141 Add webhook support · 5h ago
       |
       v
[text card]           ← streaming result
  Found 10 open issues...
       |
       v
[Done · 4s | 2 tool calls]   ← DONE reaction added
```

---

## The Mental Model

**Group = terminal window.** Each Feishu group is a conversation workspace: one agent, one `cwd`, one persistent session. Asking a follow-up question in the same group picks up where the last message left off — the agent remembers.

**Manager group = terminal manager.** One special group acts as your command center. Tell it what you want to work on; it creates a new group (workspace) with the right agent persona, dedicated folder, and config — then adds you. When you're done, tell it to close the workspace.

```
Manager group
├── "start a workspace to debug the payment service"
│       → creates group "payment-debug"
│       → creates ~/.lark-channel/workspaces/payment-debug/
│       → writes agents/payment-debug.md (persona: backend debugging agent)
│       → restarts bridge, adds you to group
│
├── "list my workspaces"
│       → shows all active groups + their purposes
│
└── "close payment-debug"
        → archives group, workspace folder stays on disk
```

Each workspace group has one coding agent running against its folder. Everything the agent does — clones, files, scripts — lands in that folder.

---

## Prerequisites

- [Bun](https://bun.sh) >= 1.0
- Python >= 3.10 (for `agent_worker.py`)
- A Feishu bot app ([open.feishu.cn](https://open.feishu.cn))
- Claude Code installed and authorized (`claude --version`)

---

## Install

### 1. Feishu CLI

```sh
npm install -g @larksuite/cli
```

Create a Feishu app at [open.feishu.cn](https://open.feishu.cn), then configure:

```sh
lark-cli config init
# enter: App ID, App Secret, region (feishu or lark)
```

Required app permissions: `im:message`, `im:message:send_as_bot`, `im:reaction`
Required event subscription: `im.message.receive_v1`
Add the bot to your target groups.

### 2. Claude Agent SDK (Python)

```sh
pip install claude-agent-sdk
```

### 3. lark-channel

```sh
git clone https://github.com/shareAI-lab/lark-channel
cd lark-channel
bun install
```

### 4. Configure

```sh
mkdir -p ~/.lark-channel/agents
cp agents.example/_feishu_workspace.md ~/.lark-channel/agents/
# create your first agent .md file (see Agent Files below)
```

### 5. Start

```sh
bun start
```

---

## Ask Your Agent to Set This Up

If you prefer to let an AI guide the installation, copy this prompt to Claude Code:

```
Please help me install and configure lark-channel on this machine.

Steps:
1. Check that Bun (https://bun.sh) is installed; install if not.
2. Install Feishu CLI: npm install -g @larksuite/cli
3. Clone and install: git clone https://github.com/shareAI-lab/lark-channel && cd lark-channel && bun install
4. Install Python SDK: pip install claude-agent-sdk
5. Guide me to create a Feishu app at https://open.feishu.cn:
   - App type: self-built (custom app)
   - Permissions to enable: im:message, im:message:send_as_bot, im:reaction
   - Event to subscribe: im.message.receive_v1
   - Enable bot mode and add bot to at least one group
6. Configure lark-cli: lark-cli config init  (enter App ID and App Secret)
7. Create my first agent config at ~/.lark-channel/agents/
8. Start: cd lark-channel && bun start

After each step, show me what was done and confirm before continuing.
```

---

## Manager Group

The manager agent creates and manages all other workspaces. Set it up once.

**1. Create the manager group in Feishu** (or ask the manager agent to help you later):

```sh
lark-cli im +chat-create --name "lark-channel manager" --type private --set-bot-manager --as bot
# note the chat_id returned
```

**2. Create `~/.lark-channel/agents/manager.md`**:

```md
---
chat_id: oc_YOUR_MANAGER_CHAT_ID
name: manager
cwd: ~/lark-channel
permission_mode: bypassPermissions
---

You are the lark-channel workspace manager. You create and manage isolated agent workspaces.

Each workspace is:
- A Feishu group where the user and agent interact
- A folder at ~/.lark-channel/workspaces/{name}/ (the agent's cwd)
- An agent config at ~/.lark-channel/agents/{name}.md

When a user asks to create a workspace:
1. Ask: what is the purpose / main task?
2. Suggest a short slug name (lowercase, hyphens)
3. Create the Feishu group:
   lark-cli im +chat-create --name "{name}" --type private --set-bot-manager --as bot
4. Add the user to the group:
   lark-cli api POST /open-apis/im/v1/chats/{chat_id}/members --data '{"id_list":["USER_OPEN_ID"],"member_id_type":"open_id"}' --as bot
5. Create the workspace folder:
   mkdir -p ~/.lark-channel/workspaces/{name}
6. Write ~/.lark-channel/agents/{name}.md with:
   - chat_id from step 3
   - cwd: ~/.lark-channel/workspaces/{name}
   - permission_mode based on task sensitivity
   - A persona tailored to the stated task (role, tools, personality, scope)
7. Restart the bridge:
   pkill -f "bun.*index.ts"; cd ~/lark-channel && bun run src/index.ts &

When asked to list workspaces: read all files in ~/.lark-channel/agents/ (skip _prefix files).
When asked to close a workspace: remove the agent .md file and restart the bridge.

Reply concisely. Use the user's language.
```

**3. Restart** `bun start` — the manager group is now active.

---

## Workspace Layout

```
~/.lark-channel/
├── agents/
│   ├── _feishu_workspace.md   # shared context appended to every agent
│   ├── manager.md             # manager agent
│   └── *.md                   # one per workspace (auto-created by manager)
├── workspaces/
│   ├── payment-debug/         # cwd for the payment-debug group
│   ├── frontend-refactor/     # cwd for the frontend-refactor group
│   └── ...                    # flat list, one folder per workspace
├── sessions.json              # runtime: chat_id → session_id (auto-managed)
└── access.json                # sender allowlist (if access.policy: allowlist)
```

Workspaces are portable: zip a folder and its `.md` file to move or share a workspace.

---

## Agent Files

Each `~/.lark-channel/agents/*.md` file defines one group's agent:

```md
---
chat_id: oc_84f7f942e8067a61dd61a434fc92ef6a
name: learn-claude-code
cwd: ~/repos/learn-claude-code
permission_mode: default
schedule:
  - cron: "0 9 * * 1-5"
    prompt: "Check stale PRs (>3 days), unanswered issues, failing CI. Post a digest."
---

You are the maintainer agent for shareAI-lab/learn-claude-code.
TypeScript educational repo (44k+ stars). Use gh CLI for GitHub operations.
Reply in the user's language. Keep responses concise for mobile reading.
```

`permission_mode`: `default` | `acceptEdits` | `bypassPermissions`

Files starting with `_` are shared context blocks appended to every agent's system prompt. The included `_feishu_workspace.md` teaches agents how to create Feishu docs, tables, and tasks.

---

## Streaming Card Layout

Each logical block in the agent response becomes a separate thread reply:

| Block | Card style | Live updates |
|-------|-----------|--------------|
| Text segment | No header, markdown | PATCH per token |
| Bash | Orange header + command | Output preview after run |
| Read / Write / Edit | Blue header + filename | Line count |
| Grep / Glob | Teal header + pattern | Match count |
| WebSearch / WebFetch | Wathet header + query | Result summary |
| Agent / Task | Purple header | First lines of result |
| Done | Green · elapsed · tool count | — |
| Error | Red header + message | — |

Feishu card markdown is preprocessed automatically: `## headings` → `**bold**`, leading blank lines stripped.

---

## Access Control

**Open** (default): anyone in a configured group can message the agent.

**Allowlist**: only approved `open_id`s.

```yaml
# config.yaml
access:
  policy: allowlist
```

To approve a user without editing config:

```
# Group owner sends:
admin pair ABCDE

# New user sends in the same group:
pair ABCDE
```

---

## Scheduled Patrols

```yaml
schedule:
  - cron: "0 9 * * 1-5"
    prompt: "Check stale PRs (>3 days without review), unanswered issues, failing CI. Post a digest."
  - cron: "0 18 * * 5"
    prompt: "Weekly summary: what was merged? Any blockers for next week?"
```

Cron expressions use local timezone.

---

## Session Management

Sessions persist across messages in the same group (agent remembers context). They expire after `session_ttl` (default 7 days) and reset automatically.

```sh
cat ~/.lark-channel/sessions.json        # view active sessions
echo '{}' > ~/.lark-channel/sessions.json  # reset all (fresh context)
```

---

## Architecture

```
Feishu groups
     |
     v
lark-channel (Bun process)
  bridge.ts     ← lark-cli WebSocket event stream (NDJSON)
     |
  router.ts     ← chat_id → agent config (from ~/.lark-channel/agents/*.md)
     |
  queue.ts      ← serial per group, parallel across groups
     |
  agent.ts      ← Python subprocess per query
     |
  agent_worker.py  ← Claude Agent SDK (ClaudeSDKClient, StreamEvent, session resume)
     |
  reply.ts      ← multi-block streaming cards + PatchScheduler
     |
  lark.ts       ← lark-cli Go binary (reactions, cards, PATCH)
```

Current implementation uses a Python subprocess for the agent worker because the Python SDK has mature `resume` support for cross-message session persistence. The TypeScript SDK (`@anthropic-ai/claude-agent-sdk`) is the natural long-term path — it would allow in-process session management with no subprocess overhead.

---

## Development

```sh
bun dev          # watch mode
bun run check    # type check
```

Test the agent worker directly:

```sh
echo '{"message":"hello","persona":"You are helpful","cwd":"/tmp","permissionMode":"default"}' \
  | python3 agent_worker.py
```

---

## License

MIT
