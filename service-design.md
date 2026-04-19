# opencode 作为 HTTP 后端服务的技术设计方案

## 0. 现状结论（先说结论）

在阅读源码后，opencode **已经具备** "HTTP 后端 + 多项目隔离 + 可指定 Agent" 的基础设施，**唯一缺失的核心能力是 Skill 的热加载**（当前 Skill 只在 Instance 首次创建时扫描一次，之后缓存在 `InstanceState` 中，必须 `dispose` 整个 Instance 才能重载）。因此本方案分两部分：
1. **已有能力的梳理与正确用法**（把它作为 HTTP 后端直接用）；
2. **需要新增的设计**（Skill 热加载 + 一组便利的 HTTP 管理接口）。

---

## 1. 需求拆解与对应实现映射

| 需求 | 现有实现位置 | 结论 |
|---|---|---|
| 作为 HTTP 后端启动 | `src/cli/cmd/serve.ts` → `Server.listen` → Hono (`src/server/server.ts`) | ✅ 已有 |
| 指定 Agent | `POST /session/:id/message` 的 body `agent: string`（`SessionPrompt.PromptInput`，`src/session/prompt.ts:1708`） | ✅ 已有 |
| 项目数据隔离 | `WorkspaceRouterMiddleware`（`src/server/instance/middleware.ts`）按 `directory` 参数派发到独立 `Instance`；`Instance.provide` 以 `directory` 为 key 缓存上下文（`src/project/instance.ts`） | ✅ 已有 |
| 配置隔离 | `Config.Service` 绑定到 `InstanceState`，每个 Instance 一份独立配置；全局配置在 `Global.Path.config`，项目配置在 worktree 下 | ✅ 已有 |
| Skill 可用 | `Skill.layer`（`src/skill/index.ts`），扫描 `.claude/.agents/skills/**/SKILL.md`、`cfg.skills.paths/urls` | ✅ 已有（只缺热加载） |
| Skill 热加载 | — | ❌ **需要新增** |
| 身份认证 | `AuthMiddleware`（Basic Auth via `OPENCODE_SERVER_PASSWORD`） | ✅ 已有 |
| 事件订阅 | `/event`（SSE），`/session/:id/prompt_async` 非阻塞投递 | ✅ 已有 |

---

## 2. 整体架构

```
┌────────────────────────────────────────────────────────────────────┐
│                     opencode serve (Hono HTTP)                      │
│  auth → logger → compression → cors                                 │
│    ├── ControlPlaneRoutes   (跨项目/账户/同步)                      │
│    ├── UIRoutes             (静态资源/文档)                         │
│    └── InstanceRoutes                                               │
│        └── WorkspaceRouterMiddleware  ← 按 directory 路由           │
│            ├── 若本地 → Instance.provide(directory) → 业务路由      │
│            └── 若远端 → ServerProxy.http/websocket                  │
│                                                                      │
│  路由: /project /session /agent /skill /config /command /provider   │
│        /file /event /mcp /pty /permission /question /experimental   │
└────────────────────────────────────────────────────────────────────┘
             │
             ▼ (每个 directory 一份 Instance 上下文)
┌────────────────────────────────────────────────────────────────────┐
│ Instance(directory=/path/A)                                         │
│   ├── Config.Service      (.opencode/config 合并规则)               │
│   ├── Skill.Service       (InstanceState: skills/dirs)              │
│   ├── Agent.Service       (AGENTS.md + cfg.agent)                   │
│   ├── Session DB (sqlite/drizzle, path 基于 directory)              │
│   ├── Permission / LSP / Format / Command / MCP …                   │
│   └── Bus (per-instance 事件)                                       │
│                                                                      │
│ Instance(directory=/path/B)   ← 完全独立的一份上面所有状态          │
└────────────────────────────────────────────────────────────────────┘
```

### 2.1 项目隔离的关键机制
- **入口路由**：`WorkspaceRouterMiddleware` 从 `?directory=` 或 `x-opencode-directory` 取项目路径（默认 `process.cwd()`），用 `Filesystem.resolve` 规范化为绝对路径。
- **上下文建立**：`Instance.provide({ directory, init: InstanceBootstrap, fn: next })` 使用 `LocalContext`（AsyncLocalStorage）把 `{ directory, worktree, project }` 注入当前请求的异步调用链。
- **缓存键**：`cache: Map<string, Promise<InstanceContext>>`，key 为绝对目录；同一目录并发请求复用同一 Instance。
- **状态隔离**：`InstanceState.make` 让每个 Service（Config/Skill/Agent/...）都以 `directory` 为维度独立持有状态；`State.create` 同步 dispose 钩子。
- **数据存储**：每个项目的 session、message、snapshot、permission 全部落盘在该 directory 下（或 `Global.Path.data/{hash(directory)}`），不跨项目污染。

### 2.2 指定 Agent 的三个层次
1. **请求级（推荐）**：`POST /session/:id/message` body 里传 `agent: "build" | "plan" | <custom>`；`SessionPrompt.prompt` 据此挑选 Agent 配置。
2. **会话级**：创建会话时写入 `agent`，后续默认继承（见 `Session.create`）。
3. **项目级**：项目内 `AGENTS.md` + `.opencode/agents/*.md` + `config.agent.*` 定义可用 Agent 集；`GET /agent` 列出。

---

## 3. 新增能力：Skill 热加载

### 3.1 现状问题
`src/skill/index.ts` 中 `InstanceState.make(init)` 只在 Instance 首次进入时执行一次扫描：
```
const state = yield* InstanceState.make(init=loadSkills(…))
```
新增 / 修改 / 删除 SKILL.md 不会被感知，除非触发 `Instance.reload` 或 `POST /instance/dispose`——这会销毁 session/连接等，代价过大。

### 3.2 设计目标
- 用户可在不中断 session、不断开 SSE/WebSocket 的前提下，让新增/修改的 Skill 立即可用。
- 触发方式：**主动 API** + **可选文件监听**。
- 保持 Skill 状态与 `InstanceState` 的一致性（避免并发读到半加载状态）。
- 作用域仅限当前 `directory`（隔离性不变）。

### 3.3 数据与服务改造（`src/skill/index.ts`）

在 `Skill.Interface` 增加：
- `reload()`：重新扫描并替换 state，返回新快照。
- `watch(enable: boolean)`：开启/关闭文件监听（可选，通过 `fs.watch`/`chokidar` 等已有能力）。

改造要点：
- 将 `State` 从 "一次性 init" 改为通过内部 `Ref<State>`（Effect Ref 或闭包可变变量 + 互斥锁）保存；
- `reload` 在互斥锁（`@/util/flock` 或 Effect `Semaphore.make(1)`）内：构造新的空 `State`，调用现有 `loadSkills`，整体替换旧 state；失败时回滚；
- `get/all/available/dirs` 每次读当前 Ref 的快照（天然并发安全）；
- 事件：reload 完成后通过 `Bus.publish("skill.updated", { added, removed, changed })` 广播（新增事件类型），现有 `/event` SSE 通道会自动转发给订阅者。

### 3.4 可选的文件监听
- 在 `Skill.layer` 内启动一个可配置的 watcher：对 `state.dirs` 集合里的每个目录 `fs.watch(recursive: true)`，debounce 300ms 后调用 `reload()`。
- 开关：`config.skills.watch: boolean`（默认 false，避免 CI/短生命周期场景无谓开销）；或通过 HTTP 动态开关。
- 注意 Linux 下 `recursive` 支持问题：回退策略是只监听 `state.dirs` 顶层，或使用 `chokidar`（已存在其他地方可复用，需确认无新依赖引入）。若无现成依赖，则默认使用 `fs.watch` 非递归 + 主动 API 兜底，避免新增第三方依赖。

### 3.5 新增 HTTP 端点（`src/server/instance/index.ts`）

增加到 `InstanceRoutes` 中（自动继承 `WorkspaceRouterMiddleware` 的项目隔离）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/skill/reload` | 触发当前项目 Skill 重扫，返回 `{ added, removed, changed, total }` |
| GET  | `/skill/:name` | 返回单个 skill 的完整内容（便于客户端调试） |
| POST | `/skill/watch` | `{ enable: boolean }` 开启/关闭 watcher（需要 config 授权） |

事件流（已有 `/event`）新增事件类型：
- `skill.updated { scope: directory, added[], removed[], changed[] }`

### 3.6 并发与一致性
- 使用单例 `Semaphore(1)` 串行化 reload；读路径无锁。
- 正在进行的 Session 在下一次拉取 skill 列表时（`Skill.available(agent)` 在每次 prompt 构造 system prompt 时调用）自然拿到最新；无需中断正在进行的 LLM 调用。
- 如 LLM 正在 streaming，当次对话仍使用已注入的 system prompt（符合直觉）；下一次 user turn 使用新 skill 集合。

---

## 4. HTTP 接口总览（对外文档）

> 所有 `/session /agent /skill /config /command /file …` 路由均接受 `?directory=<absolute>` 或 `x-opencode-directory` 头用于选择项目；缺省则使用 server 进程 cwd。

### 4.1 项目与元数据
- `GET  /path` 当前项目的 directory / worktree / global path
- `GET  /vcs`、`GET /vcs/diff` git 信息
- `GET  /project` 项目列表
- `POST /instance/dispose` 释放当前项目 Instance

### 4.2 Agent / Skill / Command
- `GET  /agent` 当前项目可用 Agent 列表
- `GET  /skill` 当前项目可用 Skill 列表
- `POST /skill/reload`（新增）
- `GET  /skill/:name`（新增）
- `POST /skill/watch`（新增）
- `GET  /command` 可用命令

### 4.3 会话与对话（核心）
- `GET  /session` 列表，支持 `roots / search / start / limit`
- `POST /session` 创建（支持 `parentID / directory / title / agent` 等）
- `GET  /session/:id` / `DELETE /session/:id`
- `GET  /session/:id/message` 消息历史
- `POST /session/:id/message` 同步发送并流式返回
  - body：`{ agent, model?:{providerID,modelID}, system?, variant?, parts:[TextPart|FilePart|AgentPart|SubtaskPart] }`
- `POST /session/:id/prompt_async` 异步投递，立即 204；结果通过 `/event` 广播
- `POST /session/:id/summarize` 触发压缩
- `POST /session/:id/command` 执行命令
- 分享/恢复：`/session/:id/share|unshare|revert|summary` 等

### 4.4 事件流
- `GET /event`（SSE） 订阅当前项目 Bus 全量事件（session.updated、message.updated、permission.asked、skill.updated 新事件 …）
- WebSocket 升级由 `InstanceRoutes` 的 `upgrade` 支持（控制台/TUI 对接用）

### 4.5 认证
- `AuthMiddleware` 读取 `OPENCODE_SERVER_PASSWORD` 与 `OPENCODE_SERVER_USERNAME`（默认 `opencode`），使用 HTTP Basic；
- 支持 `?auth_token=` 兜底（内部转换为 `Authorization: Basic …`），便于 SSE/WS。
- CORS：默认放行 localhost/127.0.0.1、`*.opencode.ai`、tauri 三类；其他源通过 `serve --cors` 白名单传入。
- **加固建议**：生产部署要求必须设置强密码，并建议前置 TLS 反代（Caddy/Nginx）。当前代码已在无密码时打印警告。

---

## 5. 项目数据隔离的落地细节

- **路径决定一切**：客户端必须为每个项目使用自己的绝对路径做 `directory`；服务器内部以此为唯一键。
- **目录校验**：`Filesystem.resolve` 会把相对路径基于 server 进程 cwd 展开，因此多租户部署建议：
  - 在反代/网关层强制校验 `directory` 前缀在允许的根目录下（防目录穿越）；
  - 或在 `WorkspaceRouterMiddleware` 前加一层自定义中间件，读取配置的 `OPENCODE_ALLOWED_ROOTS`，拒绝超出前缀的目录。
- **项目配置来源**：`Config` 合并顺序（已有）：系统 managed → 全局（`$XDG_CONFIG/opencode`）→ 项目（worktree 根的 `opencode.json/.opencode/config.json`）→ AGENTS.md 覆盖。每个 Instance 独立一份，不共享。
- **Session DB**：每个 directory 对应独立 SQLite（drizzle），位于 Global data 下按路径 hash 命名（见 `src/storage`），互不影响。
- **生命周期**：`POST /instance/dispose` 释放单个项目资源；进程退出时 `Instance.disposeAll()`。

---

## 6. 客户端交互示例（概念性）

1. **启动服务端**
   - 设置 `OPENCODE_SERVER_PASSWORD=xxx` 后执行 `opencode serve --hostname 0.0.0.0 --port 4096`。
2. **选择项目并列出 Agent/Skill**
   - `GET /agent?directory=/repo/proj-a`
   - `GET /skill?directory=/repo/proj-a`
3. **创建会话**
   - `POST /session?directory=/repo/proj-a` body: `{ agent: "build" }`
4. **发送消息（指定 agent 覆盖）**
   - `POST /session/<id>/message?directory=/repo/proj-a` body: `{ agent: "plan", parts:[{type:"text", text:"..."}] }`
5. **热更新 Skill**
   - 用户把新 `SKILL.md` 放进 `/repo/proj-a/.opencode/skills/foo/SKILL.md`
   - `POST /skill/reload?directory=/repo/proj-a` → 立即可用
   - 订阅 `/event?directory=/repo/proj-a` 可收到 `skill.updated`
6. **并行另一个项目不受影响**
   - 同一台 server 上 `?directory=/repo/proj-b` 的 Instance 独立运行。

---

## 7. 需要新增/修改的代码清单（最小改动集）

1. `packages/opencode/src/skill/index.ts`
   - 将 `state` 的实现从一次性 `InstanceState.make` 改为包装一个可替换的 Ref，暴露 `reload`、（可选）`watch`。
   - 新增 `Bus` 事件 `skill.updated`（在 `src/server/event.ts` 或 `src/bus` 注册）。
2. `packages/opencode/src/server/instance/index.ts`
   - 新增 `POST /skill/reload`、`GET /skill/:name`、`POST /skill/watch` 三个路由，带 `describeRoute` OpenAPI 元数据。
3. （可选）`packages/opencode/src/config/config.ts` 增加 `skills.watch?: boolean`。
4. 测试：在 `packages/opencode/test` 下新增用例——
   - 创建临时目录，启动 server；
   - `GET /skill` 初次为空；
   - 写入 `SKILL.md` 后 `POST /skill/reload`；
   - 再次 `GET /skill` 看到新 skill；
   - 删除后再 reload 确认消失。
   - （保持 "tests cannot run from repo root" 约束，在 `packages/opencode` 下执行 `bun test`。）
5. SDK 重新生成：`./packages/sdk/js/script/build.ts`（因为 OpenAPI 规格有变）。

---

## 8. 关键权衡与风险

- **为什么不直接 `Instance.reload()`**：reload 会销毁 session/db 连接、打断 SSE、丢失 LSP 预热。Skill 的粒度远小于 Instance，独立热更更安全、成本更低。
- **文件监听 vs 主动 API**：主动 API 更确定、易于灰度；默认关闭 watcher，可按需开启。
- **多租户场景**：opencode Server 当前面向 "同一用户/同一机器 + 多项目"。要做多租户 SaaS，需在反代层/网关层额外加：`directory` 白名单、用户级密钥、资源限额、审计。本方案不自作主张引入这些，避免范围蔓延。
- **权限**：`Skill.available(agent)` 已根据 `Permission.evaluate("skill", name, agent.permission)` 过滤 deny；reload 不改变权限模型。
- **Windows 兼容**：`fs.watch` 行为差异需要在 watcher 开启时处理，默认关闭策略可回避。

---

## 9. 交付与验证

- **自测**：`bun typecheck`（在 `packages/opencode`）、新增单测 `bun test`；`opencode serve` 本地用 curl 跑完上面 1–6 场景。
- **文档**：在 `packages/opencode/README.md` 新增 "HTTP backend usage" 章节；在 SDK 生成后同步到 `packages/sdk/js`。
- **向后兼容**：所有新接口为 additive；`PromptInput.agent` 字段已存在；旧客户端无感。

以上即完整技术设计方案。若希望直接落地 Skill 热加载（§3、§7），可以随时让我开始实施最小改动集。
