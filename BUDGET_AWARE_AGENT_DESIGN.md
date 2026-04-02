# Budget-Aware Agent 设计方案

## 1. 背景与目标

当前仓库已经有两类与预算相关的机制：

- `src/query.ts` 中的 `taskBudget` 透传与 compaction 后的 `remaining` 修正
- `src/query/tokenBudget.ts` 中的 `TOKEN_BUDGET` 连续生成/提前停止逻辑

它们解决的是：
- API 侧 task budget 约束
- 输出 token 接近预算时是否继续生成

但还没有形成一个更完整的 **budget-aware agent policy**：
- 模型并不持续感知“还剩多少资源”
- 预算更多是硬限制，而不是行为信号
- 对“什么时候该探索、什么时候该收敛、什么时候该留验证预算”缺少统一策略

本文档提出一个适合本仓库的预算感知式 Agent 设计：

> **程序负责计量与强约束，LLM 负责在预算阶段内做策略选择。**

目标不是追求理论最优，而是先得到：
- 更稳定的 agent 行为
- 更少的重复低收益工具调用
- 更好的收尾与验证保留
- 可观测、可调参、可回滚的实现

---

## 2. 设计原则

### 2.1 预算度量由程序决定，不交给 LLM 自评

预算本身必须：
- 可预测
- 可审计
- 可复现
- 可离线分析

因此以下内容应由程序固定维护：
- token 消耗
- tool call 次数
- turn 次数
- 高成本工具次数
- 派生出的 effort score
- 剩余预算等级

LLM 不负责“怎么算预算”，只负责“看到预算后怎么调整策略”。

### 2.2 不把策略全写死成规则机

如果把所有行为都写成 if/else，会很快变成脆弱的规则系统。

因此建议：
- **硬指标**：程序维护
- **硬阈值**：程序强制执行
- **软策略**：交给 LLM 在提示词内决定

### 2.3 预算是持续信号，不只是超限拦截

不是“没超限就随便跑，超限才停”。

而是让预算从任务开始就参与决策：
- 预算高：允许探索
- 预算中：优先收敛
- 预算低：停止发散，保留验证与总结预算

### 2.4 先做可回滚 MVP

第一阶段不引入复杂学习算法，不做自适应权重学习。

先做：
- 简单 effort 公式
- 三段预算等级
- 少量提示词策略
- 遥测与对比实验

---

## 3. 总体架构

整体分 4 层：

1. **Budget State Tracking（计量层）**
2. **Budget Interpretation（解释层）**
3. **Policy Exposure to LLM（策略暴露层）**
4. **Guardrails（强制边界层）**

### 3.1 计量层

负责维护客观状态，例如：

```ts
export type AgentBudgetState = {
  effortUsed: number
  effortLimit: number
  effortRemaining: number

  turnsUsed: number
  turnsRemaining: number

  toolCallsUsed: number
  toolCallsRemaining: number

  expensiveToolCallsUsed: number
  expensiveToolCallsRemaining: number

  inputTokens: number
  outputTokens: number

  budgetLevel: 'high' | 'medium' | 'low'
}
```

### 3.2 解释层

把底层统计信号转成模型可消费的状态：

- 当前预算等级：`high | medium | low`
- 是否应该保留验证预算
- 是否存在重复低收益行为
- 是否已经接近工具调用上限

### 3.3 策略暴露层

把预算状态插入 prompt / loop context，让模型知道当前所处阶段。

模型负责判断：
- 继续深挖当前路线还是 pivot
- 现在更适合读文件、搜索、编辑还是验证
- 是否值得再开新分支尝试

### 3.4 强制边界层

程序继续保留并扩展硬控制：
- 超过总预算直接停止
- 超过昂贵工具上限直接拒绝
- 低预算状态下禁止新增高成本发散行为
- 为最终验证留保底预算

---

## 4. 核心运行逻辑

一轮典型流程如下：

### 阶段 A：初始化

在 query 启动时创建预算状态，初始化：
- 最大 effort
- 最大 turns
- 最大 tool calls
- 最大 expensive tool calls
- 验证预留额度

### 阶段 B：每轮更新预算

每次 API 调用完成、每次工具执行完成后，更新：
- token 使用量
- tool 使用量
- effort score
- 剩余比例
- budget level

### 阶段 C：将预算状态喂给模型

在每轮采样前，将预算摘要插入 system 或 dynamic context，例如：

```txt
Budget status:
- level: medium
- effort remaining: 38%
- tool calls remaining: 4
- expensive tool calls remaining: 1
- reserve budget for verification
- avoid broad exploration unless current path is blocked
```

### 阶段 D：模型在预算约束下选策略

高预算时：
- 允许探索多个候选路径
- 允许先搜索再定位

中预算时：
- 优先选择最可能成功的路径
- 减少平行尝试
- 开始考虑收尾与验证

低预算时：
- 不再开启新的大范围搜索
- 优先完成必要修改
- 保留预算给测试、验证、总结

### 阶段 E：程序执行兜底

若模型提出的动作违反边界：
- 拒绝执行
- 或降级执行
- 或直接要求模型给出当前最佳结论

---

## 5. 预算度量方案

## 5.1 为什么要引入 effort score

只看 token 不够，因为在 agent 系统里，高成本往往来自：
- tool calls
- web search
- 子 agent
- 大量低收益搜索

因此需要一个统一的策略刻度，而不要求它是精确成本模型。

这个分数的作用是：
- 帮助策略切换
- 帮助做 telemetry
- 帮助做 offline calibration

不是账单结算值。

## 5.2 初版 effort 公式

建议 MVP 采用线性公式：

```ts
effortUsed =
  inputTokens * 1 +
  outputTokens * 2 +
  toolCalls * 3000 +
  expensiveToolCalls * 9000
```

说明：
- input token 权重最低
- output token 更贵，因为往往意味着更长推理/生成
- 普通 tool call 设成相当于几千 token 的策略重量
- 昂贵工具额外惩罚，避免预算末期继续发散

该分数不是精确 token 等价，而是用于行为调控的归一化刻度。

## 5.3 什么算 expensive tool

第一阶段建议不要做太复杂分类，先按已有工具特征粗分。

建议默认归为 expensive 的类别：
- `Agent` 工具（子 agent）
- `WebSearch` / `WebFetch` 类外部检索
- 长时间运行的 shell/tool 操作
- 可能产生大量结果的搜索型工具

是否 expensive 应由工具元数据或名字映射表决定，而不是让模型猜。

## 5.4 额外行为信号

除了 effort 总分，还应单独维护坏模式信号：

```ts
export type BudgetBehaviorSignals = {
  repeatedFailures: number
  duplicateSearchCount: number
  consecutiveNoProgressSteps: number
  verificationBudgetReserved: boolean
}
```

原因：
- 有些坏行为不能只靠总 effort 捕捉
- 比如连续做相似搜索，绝对成本可能还不高，但策略上已经在浪费预算

---

## 6. 预算等级与策略

## 6.1 等级划分

MVP 建议按剩余 effort 比例划三段：

- `high`: remaining > 60%
- `medium`: 25% < remaining <= 60%
- `low`: remaining <= 25%

同时叠加硬门槛：
- 如果 `toolCallsRemaining <= 2`，即使 effort 还高，也可降成 `medium` 或 `low`
- 如果 `expensiveToolCallsRemaining == 0`，禁止继续昂贵探索

## 6.2 不同等级下的默认行为

### high

允许：
- 探索 2~3 个方向
- 先搜索再定位
- 做少量信息收集

不鼓励：
- 无目的地大范围搜索
- 重复调用同类工具却无新增信息

### medium

重点：从探索转向收敛。

允许：
- 沿最可能路径继续
- 必要时做一次额外验证搜索
- 开始编辑与局部验证

不鼓励：
- 平行多路线尝试
- 大量读取无关文件
- 新开高成本子 agent

### low

重点：保留收尾能力。

允许：
- 最关键的验证步骤
- 总结当前发现
- 小范围确认

不允许/强限制：
- 新的大范围搜索
- 新开子 agent
- 明显发散的探索行为

---

## 7. 验证预算机制

这是本方案的关键部分之一。

很多 agent 失败不是因为不会做，而是：
- 前面探索花光预算
- 最后没有资源验证

因此需要显式保留验证预算。

## 7.1 设计目标

让系统在中后期自动进入“保留收尾资源”模式。

## 7.2 MVP 方案

配置一个验证预留值，例如：

```ts
verificationReserve = {
  toolCalls: 2,
  effort: 8000,
}
```

含义：
- 正常探索不能侵占最后的 2 次关键工具调用
- 也不能把最后一小段 effort 全用光

## 7.3 行为方式

当系统判断已经接近 reserve 区域时：
- prompt 中提示模型“reserve budget for verification”
- guardrail 开始禁止非必要昂贵探索
- 优先允许测试、检查、总结类行为

---

## 8. 与当前代码的对应关系

## 8.1 `src/query.ts`

这是主接入点。

当前已存在：
- `taskBudget` 透传
- `taskBudgetRemaining` 在 compaction 后的修正
- `TOKEN_BUDGET` 的 continuation / completion 逻辑

建议新增职责：
- 创建 `AgentBudgetState`
- 在每轮 query / tool 执行后刷新预算摘要
- 在构造系统上下文时注入 budget prompt block
- 在工具执行前检查是否触发 budget guardrail
- 在回合末记录预算 telemetry

### 建议新增点

1. **query 初始化处**
   - 紧邻当前 `createBudgetTracker()` 的位置创建新的 agent budget tracker

2. **每轮采样前**
   - 将预算摘要注入 `systemContext` 或独立 prompt block

3. **工具执行前后**
   - 更新 tool 次数、昂贵工具计数、连续无进展状态

4. **完成前**
   - 记录预算阶段、是否触发 reserve、是否因 budget 终止

## 8.2 `src/QueryEngine.ts`

建议承担：
- 接收 budget summary 作为动态 query config 的一部分
- 让底层 API 请求能感知到 budget 状态
- 为后续基于 budget 的模型参数调整预留位置

第一阶段不建议把太多策略写进 `QueryEngine.ts`，保持它主要承担“传递上下文”职责。

## 8.3 `src/cost-tracker.ts`

建议承担：
- 提供 effort score 相关聚合能力
- 输出辅助 telemetry
- 为 session 级成本分析提供数据来源

注意：
- `cost-tracker.ts` 现在偏会话级成本统计
- budget-aware policy 更偏“单次 query/turn 内策略控制”

因此不建议把所有预算逻辑都塞进去，更适合：
- query 内维护实时预算状态
- cost-tracker 提供共享统计工具与输出

## 8.4 `src/query/tokenBudget.ts`

建议保留它当前职责：
- 处理输出 token 接近预算时的 continuation/stop 决策

不要直接把完整 budget-aware policy 全塞进这个文件。

更好的做法是：
- 保留 `tokenBudget.ts` 作为“输出 token continuation 子系统”
- 新增单独模块，如 `src/query/agentBudget.ts`
- 两者在 `query.ts` 中汇合

这样职责更清晰：
- `tokenBudget.ts`：单一问题，是否继续生成
- `agentBudget.ts`：整体 agent 预算感知策略

---

## 9. 建议新增模块

建议新增：`src/query/agentBudget.ts`

可包含：

```ts
export type AgentBudgetConfig = {
  effortLimit: number
  maxToolCalls: number
  maxExpensiveToolCalls: number
  verificationReserveEffort: number
  verificationReserveToolCalls: number
}

export type AgentBudgetState = {
  effortUsed: number
  effortRemaining: number
  budgetLevel: 'high' | 'medium' | 'low'
  toolCallsUsed: number
  toolCallsRemaining: number
  expensiveToolCallsUsed: number
  expensiveToolCallsRemaining: number
  repeatedFailures: number
  duplicateSearchCount: number
  verificationReserveActive: boolean
}

export function createAgentBudgetState(config: AgentBudgetConfig): AgentBudgetState
export function recordApiUsage(...): AgentBudgetState
export function recordToolUsage(...): AgentBudgetState
export function computeBudgetLevel(...): 'high' | 'medium' | 'low'
export function buildBudgetPromptBlock(...): string
export function shouldBlockToolUse(...): { blocked: boolean; reason?: string }
```

模块边界建议：
- 不直接依赖 UI
- 不直接依赖具体模型实现
- 只处理预算状态、阈值计算、文本摘要构建

---

## 10. Prompt 设计

## 10.1 目标

给模型足够清晰但不过载的预算信息。

避免：
- 直接灌太多数值细节
- 让模型自己推导复杂成本模型
- 写成很长的操作手册

## 10.2 建议格式

```txt
Budget status:
- level: medium
- effort remaining: 38%
- tool calls remaining: 4
- expensive tool calls remaining: 1
- verification reserve: active soon

Guidance:
- Prefer the most likely path over broad exploration.
- Avoid repeating low-yield searches.
- Leave enough budget for verification before finishing.
```

## 10.3 不建议暴露的内容

第一阶段不建议把以下内容直接暴露给模型：
- 完整 effort 计算公式
- 每个工具的详细权重
- 复杂 telemetry 细节

原因：
- 会增加 prompt 噪音
- 让模型去“对抗规则”而不是消费信号

---

## 11. Guardrail 设计

预算感知不是只靠 prompt，必须有程序兜底。

## 11.1 必要的硬限制

必须由程序强制执行：
- `maxTurns`
- `maxToolCalls`
- `maxExpensiveToolCalls`
- `effortLimit`

## 11.2 低预算时的限制

当 `budgetLevel === 'low'` 或 `verificationReserveActive === true` 时：
- 拒绝新增子 agent
- 拒绝新的外部广域搜索
- 拒绝明显重复的同类搜索
- 允许必要测试和局部检查

## 11.3 block 行为的返回方式

不要简单 silent fail。

建议返回给模型一个简短 system/user meta 提示，例如：

```txt
Budget guardrail: broad exploration is disabled because only verification budget remains. Use the remaining budget for validation, minimal confirmation, or a final answer.
```

这样模型能理解为何动作被拒绝，并做下一步调整。

---

## 12. 遥测与评估

如果没有遥测，这个方案很难调。

## 12.1 建议记录的指标

每个 query/turn 记录：
- effortUsed
- effortRemainingPct
- final budgetLevel
- toolCallsUsed
- expensiveToolCallsUsed
- duplicateSearchCount
- repeatedFailures
- 是否进入 verification reserve
- 是否因 budget guardrail 阻止过动作
- 是否因 budget 提前停止
- 最终是否成功（若已有近似信号）

## 12.2 需要观察的结果

重点不是分数是否“数学准确”，而是行为是否改善：
- 是否减少重复工具调用
- 是否减少无意义发散
- 是否留下验证预算
- 是否降低平均成本
- 是否提升完成率/满意度

## 12.3 实验方式

建议做 feature flag，例如：
- `AGENT_BUDGET_AWARE`

分组比较：
- baseline：现状
- variant A：只注入 budget prompt
- variant B：budget prompt + guardrail
- variant C：budget prompt + guardrail + duplicate-search 惩罚

---

## 13. 参数初始值建议

在没有大规模离线数据前，先用可解释默认值。

## 13.1 初始配置

```ts
const defaultAgentBudgetConfig = {
  effortLimit: 60000,
  maxToolCalls: 12,
  maxExpensiveToolCalls: 3,
  verificationReserveEffort: 8000,
  verificationReserveToolCalls: 2,
}
```

## 13.2 初始权重

```ts
const effortWeights = {
  inputToken: 1,
  outputToken: 2,
  toolCall: 3000,
  expensiveToolCall: 9000,
}
```

## 13.3 初始阈值

```ts
const budgetThresholds = {
  highRemainingPct: 0.60,
  mediumRemainingPct: 0.25,
}
```

## 13.4 如何校准

后续根据真实轨迹校准：
1. 采样 20~50 条真实任务
2. 按简单问答 / 常规改动 / 困难调试分组
3. 观察成功轨迹通常在哪个预算阶段收敛
4. 调整 toolCall 与 expensiveToolCall 权重
5. 检查 low 阶段是否过早触发

---

## 14. 分阶段落地计划

## Phase 0：文档与接口设计

产出：
- 本文档
- 类型定义
- 模块边界
- feature flag 设计

## Phase 1：预算状态 MVP

实现：
- `agentBudget.ts`
- effort score 计算
- budget level 计算
- prompt 注入

此阶段不拦截工具，只做软提示 + telemetry。

## Phase 2：基础 guardrail

实现：
- 低预算时限制 expensive tools
- verification reserve 机制
- budget block 提示回灌模型

## Phase 3：坏模式检测

实现：
- duplicate search 检测
- consecutive no-progress 检测
- repeated failure 惩罚

## Phase 4：实验与校准

实现：
- A/B 对比
- 参数调整
- 根据任务类型细分默认预算

---

## 15. 风险与限制

## 15.1 过早保守

如果权重或阈值过激，模型可能还没真正探索就进入收敛模式。

缓解：
- 先做软提示，不急着强拦截
- 先用宽松阈值
- telemetry 观察 low 是否触发过早

## 15.2 对不同任务迁移不一致

论文更接近 web-search 型 agent，而当前仓库是通用 coding CLI。

风险：
- 有些 coding/debugging 任务天然需要更长探索期

缓解：
- 先统一默认值
- 后续按任务类型细分预算模板

## 15.3 坏模式检测误杀

比如“重复搜索”在某些情况下其实是逐步缩小范围的合理行为。

缓解：
- 第一阶段只记录，不阻止
- 在有数据后再做硬限制

## 15.4 Prompt 噪音增加

预算提示过长会稀释主任务目标。

缓解：
- 保持 budget prompt 极短
- 只暴露摘要，不暴露计算细节

---

## 16. 推荐决策

推荐采用：

### 现在就做
- 新增 `agentBudget.ts` 模块
- 实现 effort score MVP
- 注入预算摘要到 prompt
- 增加 telemetry

### 下一步再做
- verification reserve guardrail
- expensive tool 限制
- duplicate-search / no-progress 检测

### 暂不建议做
- 完整照搬论文中的复杂自适应编排
- 让 LLM 自己定义预算值或权重
- 上来就做强硬且复杂的规则系统

---

## 17. 一句话总结

本方案的核心是：

> **用程序维护稳定、可审计的预算状态；用 LLM 在预算阶段内做策略切换；用 guardrail 保证不会在临近收尾时继续发散。**

它适合先以 MVP 方式落地到当前仓库的 `query.ts` 主循环中，再逐步扩展到工具选择与验证阶段控制。
