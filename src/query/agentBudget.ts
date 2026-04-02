import type { NonNullableUsage } from '../services/api/logging.js'
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'

export type BudgetLevel = 'high' | 'medium' | 'low'

export type AgentBudgetConfig = {
  enabled: boolean
  effortLimit: number
  maxToolCalls: number
  maxExpensiveToolCalls: number
  verificationReserveEffort: number
  verificationReserveToolCalls: number
  highRemainingPct: number
  mediumRemainingPct: number
}

export type AgentBudgetState = {
  effortUsed: number
  effortRemaining: number
  effortRemainingPct: number
  budgetLevel: BudgetLevel
  toolCallsUsed: number
  toolCallsRemaining: number
  expensiveToolCallsUsed: number
  expensiveToolCallsRemaining: number
  duplicateSearchCount: number
  repeatedFailures: number
  verificationReserveActive: boolean
}

export type AgentBudgetGuardrailDecision = {
  blocked: boolean
  reason?: string
}

export type AgentBudgetTracker = {
  config: AgentBudgetConfig
  inputTokens: number
  outputTokens: number
  toolCallsUsed: number
  expensiveToolCallsUsed: number
  duplicateSearchCount: number
  repeatedFailures: number
  recentSearchSignatures: string[]
}

const DEFAULT_CONFIG: AgentBudgetConfig = {
  enabled: true,
  effortLimit: 60_000,
  maxToolCalls: 12,
  maxExpensiveToolCalls: 3,
  verificationReserveEffort: 8_000,
  verificationReserveToolCalls: 2,
  highRemainingPct: 0.6,
  mediumRemainingPct: 0.25,
}

const EXPENSIVE_TOOL_NAMES = new Set([
  'Agent',
  'WebSearch',
  'WebFetch',
  'Bash',
])

export function createAgentBudgetTracker(
  overrides: Partial<AgentBudgetConfig> = {},
): AgentBudgetTracker {
  return {
    config: { ...DEFAULT_CONFIG, ...overrides },
    inputTokens: 0,
    outputTokens: 0,
    toolCallsUsed: 0,
    expensiveToolCallsUsed: 0,
    duplicateSearchCount: 0,
    repeatedFailures: 0,
    recentSearchSignatures: [],
  }
}

export function recordAgentBudgetUsage(
  tracker: AgentBudgetTracker,
  usage: Pick<
    NonNullableUsage,
    | 'input_tokens'
    | 'output_tokens'
    | 'cache_creation_input_tokens'
    | 'cache_read_input_tokens'
  > | null | undefined,
): void {
  if (!usage) return
  tracker.inputTokens +=
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  tracker.outputTokens += usage.output_tokens
}

export function recordAgentBudgetToolUses(
  tracker: AgentBudgetTracker,
  toolUseBlocks: ToolUseBlock[],
): void {
  tracker.toolCallsUsed += toolUseBlocks.length
  tracker.expensiveToolCallsUsed += countExpensiveToolUses(toolUseBlocks)

  for (const toolUseBlock of toolUseBlocks) {
    const searchSignature = getSearchSignature(toolUseBlock)
    if (!searchSignature) {
      continue
    }
    if (tracker.recentSearchSignatures.includes(searchSignature)) {
      tracker.duplicateSearchCount++
    }
    tracker.recentSearchSignatures.push(searchSignature)
    if (tracker.recentSearchSignatures.length > 6) {
      tracker.recentSearchSignatures.shift()
    }
  }
}

export function recordAgentBudgetToolResult(
  tracker: AgentBudgetTracker,
  resultText: string | undefined,
): void {
  if (!resultText) return
  const lower = resultText.toLowerCase()
  if (
    lower.includes('<tool_use_error>') ||
    lower.includes('inputvalidationerror') ||
    lower.includes('error calling tool')
  ) {
    tracker.repeatedFailures++
    return
  }

  if (tracker.repeatedFailures > 0) {
    tracker.repeatedFailures = 0
  }
}

export function getAgentBudgetState(
  tracker: AgentBudgetTracker,
): AgentBudgetState {
  const effortUsed =
    tracker.inputTokens +
    tracker.outputTokens * 2 +
    tracker.toolCallsUsed * 3_000 +
    tracker.expensiveToolCallsUsed * 9_000
  const effortRemaining = Math.max(0, tracker.config.effortLimit - effortUsed)
  const effortRemainingPct =
    tracker.config.effortLimit > 0
      ? effortRemaining / tracker.config.effortLimit
      : 0
  const toolCallsRemaining = Math.max(
    0,
    tracker.config.maxToolCalls - tracker.toolCallsUsed,
  )
  const expensiveToolCallsRemaining = Math.max(
    0,
    tracker.config.maxExpensiveToolCalls - tracker.expensiveToolCallsUsed,
  )
  const verificationReserveActive =
    effortRemaining <= tracker.config.verificationReserveEffort ||
    toolCallsRemaining <= tracker.config.verificationReserveToolCalls

  let budgetLevel: BudgetLevel = 'low'
  if (effortRemainingPct > tracker.config.highRemainingPct) {
    budgetLevel = 'high'
  } else if (effortRemainingPct > tracker.config.mediumRemainingPct) {
    budgetLevel = 'medium'
  }

  if (toolCallsRemaining <= tracker.config.verificationReserveToolCalls) {
    budgetLevel = 'low'
  } else if (
    budgetLevel === 'high' &&
    expensiveToolCallsRemaining <= 1
  ) {
    budgetLevel = 'medium'
  }

  return {
    effortUsed,
    effortRemaining,
    effortRemainingPct,
    budgetLevel,
    toolCallsUsed: tracker.toolCallsUsed,
    toolCallsRemaining,
    expensiveToolCallsUsed: tracker.expensiveToolCallsUsed,
    expensiveToolCallsRemaining,
    duplicateSearchCount: tracker.duplicateSearchCount,
    repeatedFailures: tracker.repeatedFailures,
    verificationReserveActive,
  }
}

export function buildAgentBudgetSystemContext(
  tracker: AgentBudgetTracker,
): string | null {
  if (!tracker.config.enabled) return null

  const state = getAgentBudgetState(tracker)
  const remainingPct = Math.round(state.effortRemainingPct * 100)
  const reserveLine = state.verificationReserveActive
    ? '- verification reserve: active'
    : '- verification reserve: keep budget available'
  const guidance = getBudgetGuidance(state)

  return [
    'Budget status:',
    `- level: ${state.budgetLevel}`,
    `- effort remaining: ${remainingPct}%`,
    `- tool calls remaining: ${state.toolCallsRemaining}`,
    `- expensive tool calls remaining: ${state.expensiveToolCallsRemaining}`,
    reserveLine,
    '',
    'Guidance:',
    ...guidance.map(line => `- ${line}`),
  ].join('\n')
}

function getBudgetGuidance(state: AgentBudgetState): string[] {
  const guidance =
    state.budgetLevel === 'high'
      ? [
          'You may explore, but keep searches targeted.',
          'Avoid repeating low-yield tool calls.',
          'Leave room for verification before finishing.',
        ]
      : state.budgetLevel === 'medium'
        ? [
            'Prefer the most likely path over broad exploration.',
            'Use focused reads and searches only when they unblock progress.',
            'Start reserving budget for verification.',
          ]
        : [
            'Do not start broad exploration or new expensive branches.',
            'Use remaining budget for validation, minimal confirmation, or a final answer.',
            'Prefer closing the current path over opening a new one.',
          ]

  if (state.duplicateSearchCount > 0) {
    guidance.push('Recent searches are repeating. Only search again if the query meaningfully changes.')
  }
  if (state.repeatedFailures > 0) {
    guidance.push('Recent tool attempts are failing. Prefer a different path or conclude with current evidence.')
  }

  return guidance
}

export function shouldBlockToolUseByBudget(
  tracker: AgentBudgetTracker,
  toolUseBlock: ToolUseBlock,
): AgentBudgetGuardrailDecision {
  if (!tracker.config.enabled) {
    return { blocked: false }
  }

  const state = getAgentBudgetState(tracker)
  const isExpensiveTool = EXPENSIVE_TOOL_NAMES.has(toolUseBlock.name)
  if (!isExpensiveTool) {
    return { blocked: false }
  }

  if (state.expensiveToolCallsRemaining <= 0) {
    return {
      blocked: true,
      reason:
        'Budget guardrail: expensive exploration is disabled because the expensive tool budget is exhausted. Use the remaining budget for validation, minimal confirmation, or a final answer.',
    }
  }

  if (state.verificationReserveActive) {
    return {
      blocked: true,
      reason:
        'Budget guardrail: only verification budget remains. Do not start a new expensive branch. Use the remaining budget for validation, minimal confirmation, or a final answer.',
    }
  }

  return { blocked: false }
}

function countExpensiveToolUses(toolUseBlocks: ToolUseBlock[]): number {
  let count = 0
  for (const block of toolUseBlocks) {
    if (EXPENSIVE_TOOL_NAMES.has(block.name)) {
      count++
    }
  }
  return count
}

function getSearchSignature(toolUseBlock: ToolUseBlock): string | null {
  if (toolUseBlock.name !== 'Grep' && toolUseBlock.name !== 'Glob') {
    return null
  }
  const input = toolUseBlock.input
  if (!input || typeof input !== 'object') {
    return toolUseBlock.name
  }
  return `${toolUseBlock.name}:${JSON.stringify(input)}`
}
