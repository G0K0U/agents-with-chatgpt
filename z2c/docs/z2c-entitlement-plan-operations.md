# Z2C 精确套餐调用与监控闭环操作手册

日期：2026-10-01 · 依据：20261001 套餐权益接线轮次的实测证据（见
`artifacts/start-entitlement-verify/`）。原生路径优先，C2C 桥接仅为可选兼容面。

## 1. 套餐与模型选择（语义独立，无静默替换）

- 三个套餐值：`DEFAULT` / `START` / `INDIVIDUAL`。显式请求值是硬约束：
  runtime 无法提供即失败，绝不回退到其他套餐或默认模型。
- START/INDIVIDUAL 通过 `entitlement_plan` 传入 submit/resume；provider 在
  `session/create` 以 `entitlement: "start-plan" | "individual-coding-plan"` 送达
  runtime，创建后立刻由 registry 回读核对（`source: "provider-registry"`）。
- 精确校验链（引擎 `governedBinding`）：非 DEFAULT 请求要求该确切 session 的
  registry 回读 `observed === 请求套餐`；`model_id`、`thought_level` 逐字段比对。
  不可信绑定 → `BINDING_UNVERIFIED`，任务不派发。
- DEFAULT 不携带套餐约束；回读 `requested: null` 是诚实状态（不得伪造
  "requested: DEFAULT"）。runtime 默认路由可能落在当前唯一权益路由上——
  这属于凭据态事实，回读如实呈现。
- 验证工具：`pnpm --dir z2c exec tsx src/canary/entitlement-plans.ts`
  （需 `Z2C_STANDALONE_ACCOUNT_RUNTIME=1`，最小真实消耗：每套餐一个极小 turn）。

## 2. quota / 失败分类（只认证据）

- 任务终态审计事件（`task.finished` / `task.error` / `task.run_error`）携带
  `failureClass`：`timeout | quota_exhausted | auth | connection | model_error | error`。
- 分类只对已持久化的原始错误消息做匹配（`z2c/src/core/tasks/failure-class.ts`）。
  裸 `429` 不算额度证据；额度类必须出现 quota/额度/usage limit 字样。
  无法归类一律 `error`——不得把额度耗尽误报成账号失效或崩溃。
- 重置时间以 runtime 原始消息为准（`exitStatus` 保留原文）。

## 3. 状态检查（区分九态）

- 排队/运行/完成/失败/取消/中断：`state.json` 任务 `status` + `/api/status`。
- 超时：`exitStatus` 含 `turn timeout after <N>ms`；底层 turn 已由
  `session/stop` 握手终止（`requestPostTimeoutStop`，执行授权先撤）。
- 额度/认证/断连：见 `failureClass` + `exitStatus` 原文。
- 服务与子进程：`node z2c/dist/cli/z2c.js status`、`children.json`（记录
  app-server 子 pid，重启时带 pid 复用守卫清理孤儿）。

## 4. 审计后续派（从证据到下一步）

审计文件：`%LOCALAPPDATA%\z2c\audit\audit.log`（JSONL）。关键事件序：
`provider.configSource`（启动时核对 `source/resolvedPath/sha256/两套餐声明数/
standaloneAccountRuntime`）→ `task.submitted`（含 binding/model/thought/mode）→
`task.started` → `task.finished`（含 outputId、failureClass）或
`task.error` / `task.partial_output_saved`。
后续派发前先核对该序列是否闭环；半初始化会话由 runtime 创建路径统一清理。

## 5. 幂等重试与单 writer

- 提交带 `idempotency_key` 时：同 key 重复提交返回同一任务（标记 replayed）；
  指纹（含 model/thought/plan/workspace）不一致 → `IDEMPOTENCY_CONFLICT`。
- 单 writer：每 workspace 串行准入门 + 队列单活跃任务；重启恢复时
  `reconcileOnRestart` 保证运行中工作不被重发，恢复前以持久化绑定复核
  （`validateKeyedAdmission`）。
- 超时 turn 的执行授权先撤销再握手；未确认终止保持授权撤销（不重新武装），
  防止双 writer 并行修改同一工作树。

## 6. 失败 checkpoint（取消/失败不丢输出）

- 失败路径 best-effort 保存部分输出（`task.partial_output_saved` 审计事件），
  经常规 `getOutput` 可读；末段内联 `[model error during turn: ...]` 标记
  真实错误。取消竞态保持 cancelled 状态，输出仍保留。
- 成功路径语义不变：消息级 model error 仍然使 turn 失败，绝不冒充成功。

## 7. 部署与回滚（上游 CLI bundle）

- 服务进程 = `node z2c/dist/service/main.js`；上游 CLI = `Z2C_ZCODE_CLI`
  指向的 `zcode.cjs`（本机：上游开发树 dist）。改 z2c 源码后必须
  `tsc` 重建 z2c/dist 再重启。
- 受控交换序列（每步留痕）：
  1. 备份现 `dist/zcode.cjs`（记录 sha256；不得把重建后的 dist 当旧版备份）。
  2. `node z2c/dist/cli/z2c.js stop`；确认 pid 退出。
  3. 拷入候选（核对 sha256）；`node z2c/dist/cli/z2c.js start`。
  4. 审计核对 `provider.configSource`：sha256 与声明数、`standaloneAccountRuntime`。
- 回滚 = 用第 1 步备份反向执行同一序列。
- **启动环境陷阱**：服务继承启动 shell 的 env。若 shell 带
  `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`（如宿主运行时路径），必须显式覆盖为
  部署目标配置，否则子进程加载错误目录（诊断事件 status=protectedPathUnread）。
- 服务启动所需 env（本机现行部署）：
  `Z2C_STANDALONE_ACCOUNT_RUNTIME=1`（用户级已持久化）+
  `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=<上游 dist provider 配置>`（仅启动 shell；
  不要写入用户级，宿主运行时会动态切换该变量）。

## 8. 权限拒绝后的停止流程

- 工具/命令被拒（引擎 policy 或用户拒绝）：立即停止该操作，禁止换工具、
  换子代理或改写命令绕过；把被拒操作与原因写入交接报告。
- 引擎侧等价语义：反向权限请求在执行授权撤销后一律拒绝；未经分类的
  development 操作默认 deny（`interaction.resolved` 审计 `source: "policy"`）。

## 9. 已知边界

- INDIVIDUAL 套餐在当前凭据态无权益（-32002 如实失败）——需用户在 ZCode
  登录 Individual 计划后重跑 canary（exit code 2 = BLOCKED）。
- 引擎派发前校验失败（BINDING_UNVERIFIED）会留下 idle 新会话（无任务/无
  turn/无授权）；resume 既有会话不会因校验失败被销毁。
- `Z2C_PROVIDER` 用户级环境变量对服务主入口无效（服务硬编码 official lane）。

## 10. 套餐目录事实与身份解析（2026-10-01 第二轮补充）

- **各套餐目录独立**（勘误于第三轮）：START 计划通告 GLM-5.3-Flash（low/high/max）；
  INDIVIDUAL 计划通告 GLM-5.3 **和 GLM-5.3-Flash**。注意：session/read 的
  `settings.model.available` 是**当前模型作用域**（只含当前模型一个条目，上游
  modelAvailability="current" 的刻意设计），不能当作 provider 全目录证据——
  "快照里没有"≠"目录里没有"。套餐约束的权威是 runtime 自身的逐次 setModel
  校验 + 事后 exact-session 回读；Z2C 只在有真实跨套餐证据（条目存在但
  access mode 不符）时提前拒绝。
- **Individual 身份来源**：Desktop host 从 family 的 OAuth 用户档案推导身份并缓存
  coding-plan api-key 到共享凭据库；standalone 解析器（快照 + 请求期鉴权头）对齐
  同一来源，per-provider identity 键仅作显式覆盖。两者皆缺 → 凭据真实失效。
- **路由准入集合**（A2C `ZCODE_NATIVE_ADMISSIBLE_PROVIDER_IDS`）：新增
  account:zai-start-plan、account:zai-individual-coding-plan、
  account:bigmodel-start-plan、account:bigmodel-individual-coding-plan；
  team/off-peak 仍不可准入（无计费语义）。readSession 对"绑定未观测"与
  "路由不可准入"给出不同真实原因。
- **canary 预算纪律**：每个有权益套餐只派一个极小 turn；DEFAULT 会话只
  attest 不派 turn（runtime 默认路由可能落在某个权益路由上，不能隐性消耗）；
  exact-pair 重建零消耗。
