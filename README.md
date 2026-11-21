# 心潮桥 · Operit 工作流版

把 Operit 里的对话喂给[心潮·念](https://github.com/tianyupaipai-cmd/xinchao-nian)，让它知道你们聊了什么，从而调节驱力。

心潮本身只在你开口前注入状态，不知道对话内容。要让驱力跟着聊天走，就需要有人把对话送过去——这个脚本就是干这个的。

## 它做什么

```
定时触发 / 手动触发
      ↓
读 Operit 的聊天数据库（只读当前打开的那个对话）
      ↓
清洗、按时间聚合流式碎片、取最近两轮
      ↓
POST 到心潮 /v1/conversation-event
      ↓
心潮用自己的模型判断互动类型 → 调节驱力
```

## 为什么逻辑放在脚本里，而不是工作流节点里

试过，不行。Operit 的工作流节点有两个坑：

**一、长代码会被静默截断。** `workflow:save` 传节点代码时，代码长到一定长度就会在中间断开，工具不报错，只把断掉之前的部分存进去。表现是“改了又改，结果永远不变”。

**二、`toolCall` 拼 shell 命令会破坏引号。** 在节点里直接拼复杂命令，引号会被吞掉，命令实际没执行。

所以节点里只留一句 `node 脚本`，所有逻辑搬进独立文件。改参数只需要改脚本，不用进工作流编辑器。

## 前置条件

1. 已部署心潮·念，且**配置了模型**（`MODEL_ENABLED=true` + API key）
2. Operit 里有可用的终端（arm64 shell），能执行 `node` 和 `sqlite3`
3. 你至少和它聊过一轮

第 1 条最容易漏。心潮没有模型时，收到对话也判不出类型，只会记一笔不动驱力，返回 `reasonCode: "no_interaction_outcome"`。

## 安装

### 1. 放脚本

把 `xc_task.js` 放到 Operit 的产出目录下，例如：

```
<你的 chat_outputs 目录>/.operit/scripts/xc_task.js
```

具体路径可以用终端 `pwd` 看到。

### 2. 填配置

复制 `config.example.json` 为 `config.json`，放在脚本同目录：

```json
{
  "base": "https://你的心潮地址",
  "token": "你的 Bearer token"
}
```

也可以用环境变量 `XC_BASE` / `XC_TOKEN`（`config.json` 优先级更高）。

### 3. 测一下

```bash
node /路径/xc_task.js
```

第一次跑会返回 `{"step":"done", "http":"200", "revAfter":...}`。如果返回 `no_config` / `no_chat` / `no_db`，按提示检查。

### 4. 建工作流

在 Operit 里新建工作流，只要两个节点：

**触发节点**（二选一或都加）

- 定时：间隔 900000 毫秒（15 分钟）
- 手动：方便调试

**执行节点**（`type: execute`，`jsCode` 填这个）

```js
const S = '/你的完整路径/xc_task.js';
const C = '/usr/bin/node "' + S + '" > /tmp/xc_run.log 2>&1';
try { await toolCall('super_admin:shell', { command: C, timeoutMs: 90000 }); } catch (e) {}
return { fired: true };
```

注意工具名是 `super_admin:shell`，不是 `bash`。

**为什么把输出重定向到文件：** 节点里 `output` 字段会丢内容，拿不到执行结果。所以要读日志：

```bash
cat /tmp/xc_run.log
```

## 踩过的坑

**列名不是想当然的那个。** `message_parts.messageTimestamp`（不是 `timestamp`）、`message_parts.content`（不是 `text`）、`messages.sender` 的值是 `'ai'`（不是 `'assistant'`）。时间戳是毫秒。

**同一条消息会拆成多个 part。** 流式生成时，一条回复会被切成好几个 `markdown` 片段，还有纯换行的。必须按 `ts + sender` 聚合，否则会读成好几条短消息。

**超时要比心潮慢。** 心潮判一次类型要 20~35 秒（它在调模型）。curl 超时设 60 秒、`execSync` 超时设 75 秒才稳。之前设 12 秒时，每次都死在半路，日志是 `curl_err` / `ETIMEDOUT`，但脚本 `EXIT=0`，看起来像成功，其实什么都没发出去。

**别传 `interactionType`。** 心潮的服务端逻辑是：**如果事件里已经有类型，或没有 exchange，或模型没开，就跳过判断**。传了类型反而让它不判了。只发 `event_id` / `session_id` / `exchange` 三个字段，让它自己判断得更准。

**8 分钟节流。** 心潮那边同一时间窗内只判一次。`applied: false` + `no_interaction_outcome` 很可能只是被节流挡了，事件照样入账，不是失败。

**游标要按对话分开存。** 不同对话的消息时间戳完全无关，共用一个游标会乱：要么把新对话的全部历史当新内容发一遍，要么直接判成没新内容。

**游标只用来判断“有没有新的”，不能用来裁内容。** 用它裁剪会导致只发出一两条被切碎的句子，心潮读不出上下文。

**节点执行成功 ≠ 能拿到输出。** 验证要看副作用：日志文件、游标文件、心潮那边的 `revision` 有没有涨。

## 已知限制

**跟着当前打开的对话走。** 你在哪条对话里，它就读哪条。读不到当前对话时会直接退出（`step: no_chat`），不会猜。

**不带时间信息。** 接口没有时间字段，心潮记录的是“什么时候收到的”，不是“对话发生在什么时候”。

**判类型有延迟。** 加上 8 分钟节流，聊完不会立刻看到驱力变化。

**驱力涨得慢是正常的。** 它有随时间衰减的机制，日常闲聊涨一点又落回去。日常平淡对话判成 `companionship`，波动本来就小。

## 它会连哪些文件

只读：

- `<Operit 目录>/operit2.sqlite`（聊天记录）
- `current_chat_id.preferences.json`（当前对话 id）

会写（都在脚本同目录）：

- `cursor_<对话id前8位>.json` — 每个对话发到哪儿了
- `.payload.json` / `.resp.json` / `.tmp` — 请求和响应的临时文件

发出去的只有 `exchange` 一段纯文本（最近的对话，上限 1400 字）。心潮判完就丢，不存原文。

## 许可

随便用。出问题自己担。
