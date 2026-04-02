/**
 * OpenAI Adapter
 *
 * Converts between Anthropic SDK format and OpenAI Chat Completions format.
 * Returns a fake "Anthropic" client object so the rest of the codebase
 * (which expects Anthropic types) works unchanged.
 */
import type Anthropic from '@anthropic-ai/sdk'
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import type { ClientOptions } from '@anthropic-ai/sdk'
import type {
  BetaRawMessageStreamEvent,
  BetaMessageStreamParams,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import OpenAI from 'openai'
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionChunk,
  ChatCompletionToolChoiceOption,
} from 'openai/resources/chat/completions.mjs'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenAIAdapterOptions {
  apiKey: string
  baseURL?: string
  maxRetries: number
  timeout: number
  defaultHeaders?: Record<string, string>
  fetch?: ClientOptions['fetch']
}

// ---------------------------------------------------------------------------
// Message Conversion: Anthropic → OpenAI
// ---------------------------------------------------------------------------

function convertSystemPrompt(
  system: BetaMessageStreamParams['system'],
): ChatCompletionMessageParam[] {
  if (!system) return []
  if (typeof system === 'string') {
    return [{ role: 'system' as const, content: system }]
  }
  // Array of text blocks
  const text = system
    .map((block: any) => {
      if (typeof block === 'string') return block
      if (block.type === 'text') return block.text
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
  return text ? [{ role: 'system' as const, content: text }] : []
}

function convertMessages(
  messages: BetaMessageStreamParams['messages'],
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      const content = msg.content
      if (typeof content === 'string') {
        result.push({ role: 'user', content })
        continue
      }

      // Array of content blocks — split into user content parts + tool results
      const contentParts: any[] = []
      const toolResults: ChatCompletionMessageParam[] = []
      let hasImageParts = false

      for (const block of content as any[]) {
        switch (block.type) {
          case 'text':
            contentParts.push({ type: 'text', text: block.text })
            break
          case 'tool_result': {
            let resultContent = ''
            if (typeof block.content === 'string') {
              resultContent = block.content
            } else if (Array.isArray(block.content)) {
              resultContent = block.content
                .map((b: any) => (b.type === 'text' ? b.text : ''))
                .filter(Boolean)
                .join('\n')
            }
            if (block.is_error) {
              resultContent = `[ERROR] ${resultContent}`
            }
            toolResults.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: resultContent || '(empty)',
            })
            break
          }
          case 'image': {
            hasImageParts = true
            if (block.source?.type === 'base64') {
              contentParts.push({
                type: 'image_url',
                image_url: {
                  url: `data:${block.source.media_type};base64,${block.source.data}`,
                },
              })
            } else if (block.source?.type === 'url') {
              contentParts.push({
                type: 'image_url',
                image_url: { url: block.source.url },
              })
            }
            break
          }
          case 'document':
            contentParts.push({ type: 'text', text: '[document content omitted]' })
            break
          default:
            if (block.text) contentParts.push({ type: 'text', text: block.text })
            break
        }
      }

      // Tool results must come before any user content in OpenAI format
      result.push(...toolResults)
      if (contentParts.length > 0) {
        if (hasImageParts) {
          // Use array format for multimodal content
          result.push({ role: 'user', content: contentParts })
        } else {
          // Use simple string for text-only messages
          result.push({
            role: 'user',
            content: contentParts.map((p: any) => p.text).join('\n'),
          })
        }
      }
      // If there were only tool results and no text, that's fine
    } else if (msg.role === 'assistant') {
      const content = msg.content
      if (typeof content === 'string') {
        result.push({ role: 'assistant', content })
        continue
      }

      // Array of content blocks — extract text + tool_use
      let textContent = ''
      const toolCalls: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }> = []

      for (const block of content as any[]) {
        switch (block.type) {
          case 'text':
            textContent += block.text
            break
          case 'tool_use':
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments:
                  typeof block.input === 'string'
                    ? block.input
                    : JSON.stringify(block.input),
              },
            })
            break
          case 'thinking':
          case 'redacted_thinking':
          case 'server_tool_use':
          case 'advisor_tool_result':
            // Skip Anthropic-specific blocks
            break
          default:
            break
        }
      }

      const assistantMsg: any = {
        role: 'assistant',
        content: textContent || null,
      }
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls
      }
      result.push(assistantMsg)
    }
  }

  return result
}

function convertTools(
  tools: BetaMessageStreamParams['tools'],
): ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined

  const result: ChatCompletionTool[] = []
  for (const tool of tools) {
    // Skip server tools, advisor, etc.
    if ((tool as any).type && (tool as any).type !== 'custom') continue
    const t = tool as any
    if (!t.name) continue

    result.push({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
        // OpenAI strict mode for structured outputs
        ...(t.strict !== undefined ? { strict: t.strict } : {}),
      },
    } as ChatCompletionTool)
  }

  return result.length > 0 ? result : undefined
}

function convertToolChoice(
  toolChoice: BetaMessageStreamParams['tool_choice'],
): ChatCompletionToolChoiceOption | undefined {
  if (!toolChoice) return undefined
  const tc = toolChoice as any
  switch (tc.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'none':
      return 'none'
    case 'tool':
      return { type: 'function', function: { name: tc.name } }
    default:
      return 'auto'
  }
}

// ---------------------------------------------------------------------------
// Stop Reason Mapping: OpenAI → Anthropic
// ---------------------------------------------------------------------------

function mapFinishReason(
  reason: string | null,
): 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null {
  switch (reason) {
    case 'stop':
      return 'end_turn'
    case 'tool_calls':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'end_turn'
    default:
      return reason ? 'end_turn' : null
  }
}

// ---------------------------------------------------------------------------
// Stream Conversion: OpenAI chunks → Anthropic BetaRawMessageStreamEvent
// ---------------------------------------------------------------------------

async function* convertStream(
  openaiStream: AsyncIterable<ChatCompletionChunk>,
  model: string,
): AsyncGenerator<BetaRawMessageStreamEvent> {
  let messageStarted = false
  let textBlockStarted = false
  let textBlockIndex = 0
  let currentBlockIndex = 0
  // Track tool call blocks: openai tool index → our block index
  const toolBlockIndices = new Map<number, number>()
  let completionId = ''
  let finishReason: string | null = null
  let promptTokens = 0
  let completionTokens = 0

  for await (const chunk of openaiStream) {
    if (!messageStarted) {
      completionId = chunk.id || `chatcmpl-${Date.now()}`
      // Emit message_start
      const usage = (chunk as any).usage
      promptTokens = usage?.prompt_tokens || 0
      yield {
        type: 'message_start',
        message: {
          id: completionId,
          type: 'message',
          role: 'assistant',
          model: chunk.model || model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: promptTokens,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      } as any
      messageStarted = true
    }

    const choice = chunk.choices?.[0]
    if (!choice) {
      // Usage-only chunk at the end
      if ((chunk as any).usage) {
        promptTokens =
          (chunk as any).usage.prompt_tokens || promptTokens
        completionTokens =
          (chunk as any).usage.completion_tokens || completionTokens
      }
      continue
    }

    const delta = choice.delta
    finishReason = choice.finish_reason || finishReason

    // Handle text content
    if (delta?.content) {
      if (!textBlockStarted) {
        // Emit content_block_start for text
        yield {
          type: 'content_block_start',
          index: currentBlockIndex,
          content_block: {
            type: 'text',
            text: '',
          },
        } as any
        textBlockIndex = currentBlockIndex
        currentBlockIndex++
        textBlockStarted = true
      }
      // Emit content_block_delta for text
      yield {
        type: 'content_block_delta',
        index: textBlockIndex,
        delta: {
          type: 'text_delta',
          text: delta.content,
        },
      } as any
    }

    // Handle tool calls
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const toolIndex = tc.index ?? 0

        if (tc.id) {
          // Close text block if still open before starting tool blocks
          if (textBlockStarted && !toolBlockIndices.has(toolIndex)) {
            // Text block will be closed at the end
          }

          // New tool call — emit content_block_start
          const blockIndex = currentBlockIndex
          toolBlockIndices.set(toolIndex, blockIndex)
          currentBlockIndex++

          yield {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
              type: 'tool_use',
              id: tc.id,
              name: tc.function?.name || '',
              input: '',
            },
          } as any
        }

        // Accumulate arguments as input_json_delta
        if (tc.function?.arguments) {
          const blockIndex = toolBlockIndices.get(toolIndex)
          if (blockIndex !== undefined) {
            yield {
              type: 'content_block_delta',
              index: blockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: tc.function.arguments,
              },
            } as any
          }
        }
      }
    }
  }

  // Close all open content blocks
  if (textBlockStarted) {
    yield {
      type: 'content_block_stop',
      index: textBlockIndex,
    } as any
  }
  for (const [, blockIndex] of toolBlockIndices) {
    yield {
      type: 'content_block_stop',
      index: blockIndex,
    } as any
  }

  // Emit message_delta with stop_reason
  yield {
    type: 'message_delta',
    delta: {
      stop_reason: mapFinishReason(finishReason),
      stop_sequence: null,
    },
    usage: {
      output_tokens: completionTokens,
    },
  } as any

  // Emit message_stop
  yield {
    type: 'message_stop',
  } as any
}

// ---------------------------------------------------------------------------
// Fake Stream wrapper (matches Anthropic SDK's Stream interface)
// ---------------------------------------------------------------------------

class FakeStream {
  controller: AbortController
  private generator: AsyncGenerator<BetaRawMessageStreamEvent>

  constructor(
    generator: AsyncGenerator<BetaRawMessageStreamEvent>,
    controller: AbortController,
  ) {
    this.generator = generator
    this.controller = controller
  }

  [Symbol.asyncIterator](): AsyncIterator<BetaRawMessageStreamEvent> {
    return this.generator
  }

  abort(): void {
    this.controller.abort()
  }
}

// ---------------------------------------------------------------------------
// Error Conversion: OpenAI errors → Anthropic SDK errors
// ---------------------------------------------------------------------------

function wrapOpenAIError(error: unknown): never {
  if (error instanceof OpenAI.APIError) {
    const status = error.status
    const message = error.message
    const headers = error.headers as any

    if (status === 408 || error.code === 'ETIMEDOUT') {
      throw new APIConnectionTimeoutError({ message })
    }
    if (status === undefined || status === null) {
      throw new APIConnectionError({ message, cause: error })
    }
    throw APIError.generate(
      status,
      { error: { message, type: 'api_error' } },
      message,
      headers,
    )
  }

  if (error instanceof Error) {
    if (
      error.name === 'AbortError' ||
      error.message.includes('abort')
    ) {
      throw new APIUserAbortError()
    }
    throw new APIConnectionError({
      message: error.message,
      cause: error,
    })
  }

  throw new APIConnectionError({
    message: String(error),
    cause: error as Error,
  })
}

// ---------------------------------------------------------------------------
// Main Adapter Factory
// ---------------------------------------------------------------------------

export function createOpenAIAdapter(
  options: OpenAIAdapterOptions,
): Anthropic {
  const openai = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL || process.env.OPENAI_BASE_URL,
    maxRetries: 0, // We handle retries ourselves via withRetry
    timeout: options.timeout,
    fetch: options.fetch as any,
    defaultHeaders: options.defaultHeaders,
  })

  // Build the fake Anthropic client
  const adapter = {
    beta: {
      messages: {
        create(
          params: BetaMessageStreamParams & { stream?: boolean },
          requestOptions?: { signal?: AbortSignal; headers?: Record<string, string> },
        ) {
          const openaiMessages = [
            ...convertSystemPrompt(params.system),
            ...convertMessages(params.messages),
          ]

          const openaiTools = convertTools(params.tools)
          const toolChoice = convertToolChoice(params.tool_choice)

          // Detect reasoning models (o-series)
          const isReasoningModel = /^o[34]/.test(params.model)

          const openaiParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
            model: params.model,
            messages: openaiMessages,
            stream: true,
            stream_options: { include_usage: true },
            max_completion_tokens: params.max_tokens,
            // Reasoning models don't support temperature
            ...(!isReasoningModel && { temperature: params.temperature ?? undefined }),
            ...(openaiTools && { tools: openaiTools }),
            ...(openaiTools && toolChoice && { tool_choice: toolChoice }),
            // Map Anthropic thinking to OpenAI reasoning_effort
            ...(isReasoningModel && { reasoning_effort: 'high' }),
          }

          const abortController = new AbortController()

          // Link external signal to our controller
          if (requestOptions?.signal) {
            if (requestOptions.signal.aborted) {
              abortController.abort()
            } else {
              requestOptions.signal.addEventListener('abort', () => {
                abortController.abort()
              })
            }
          }

          // Return APIPromise-like object with .withResponse()
          const promise = (async () => {
            try {
              const stream = await openai.chat.completions.create(
                openaiParams,
                { signal: abortController.signal },
              )

              const anthropicStream = new FakeStream(
                convertStream(stream as any, params.model),
                abortController,
              )

              return anthropicStream
            } catch (error) {
              wrapOpenAIError(error)
            }
          })()

          // Add .withResponse() method
          // Cache the promise so withResponse() awaits the same settled promise.
          // If the promise rejected, re-throw the already-wrapped Anthropic error
          // instead of double-wrapping it through wrapOpenAIError.
          const settled = promise.catch((e: unknown) => { throw e })
          const result = Object.assign(promise, {
            withResponse: async () => {
              const data = await settled
              return {
                data,
                request_id: `openai-${Date.now()}`,
                response: new Response(),
              }
            },
          })

          return result
        },
      },
    },
  }

  return adapter as unknown as Anthropic
}
