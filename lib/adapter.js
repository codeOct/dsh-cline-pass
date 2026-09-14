/**
 * The Cline Pass LLM adapter: an OpenAI-compatible `chat/completions` stream
 * with upstream pinning and pre-first-token failover.
 *
 * The adapter is transport-only. Connection facts (base URL, model catalog),
 * the per-request account, the per-model pin, and the observation callbacks all
 * arrive through thunks supplied by the registering plugin, so credential
 * policy, settings layering, and state stay in `index.js`.
 *
 * What makes it more than a plain OpenAI adapter: every request is expanded
 * into the ordered candidate list of {@link buildAttempts}, each candidate gets
 * its own pin written into the body by {@link injectPrefs}, and a candidate
 * that fails before its first content chunk is abandoned in favour of the next
 * one — the same failover contract the gateway itself exposes, applied inside
 * the harness instead of behind a proxy.
 *
 * @module dsh-cline-pass/adapter
 */

import {
  attributionHeaders,
  contentHasImage,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  errorChain,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { chatURL } from './cline.js'
import { resolveModelMetadata } from './catalog.js'
import {
  buildAttempts,
  classifyUpstreamError,
  errorText,
  injectPrefs,
  parseRouting,
  unwrapEnvelope,
} from './protocol.js'
import { parseServerSentEvents } from './engine.js'

/** Default maximum idle interval while a stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000
/**
 * Conservative context capacity for a model the catalog does not describe.
 * Shipped models carry their published window, so this only bounds the
 * unknown ones; raise it per model in configuration when a new model ships.
 */
export const DEFAULT_CONTEXT_WINDOW = 128000
/**
 * Conservative per-request output cap for a model the catalog does not
 * describe. It must stay well below the smallest published window, because
 * the default is materialized into requests whose callers omit `maxTokens`.
 */
export const DEFAULT_MAX_TOKENS = 32000

const STREAM_IDLE_TIMEOUT_CODE = 'CLINE_PASS_STREAM_IDLE_TIMEOUT'

//#region request serialization

/** Join a message's text blocks. */
function flattenText(blocks) {
  return (blocks ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('')
}

/** Reject image content before a text-only path silently erases it. */
function assertTextOnly(blocks) {
  if (contentHasImage(blocks ?? [])) {
    throw new LlmError('The Cline Pass adapter does not accept image content.', 'UNSUPPORTED_CONTENT')
  }
}

/** Convert one assistant message, keeping tool calls and reasoning. */
function serializeAssistant(message) {
  const text = flattenText(message.content)
  const reasoning = (message.content ?? []).filter((block) => block.type === 'reasoning').map((block) => block.text).join('')
  const toolCalls = (message.content ?? []).filter((block) => block.type === 'tool-call').map((block) => ({
    id: block.id,
    type: 'function',
    function: { name: block.name, arguments: block.arguments },
  }))
  return {
    role: 'assistant',
    content: text,
    ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}

/**
 * Convert the harness conversation to wire messages.
 *
 * Tool results become standalone `{ role: 'tool' }` messages, because the
 * harness delivers each tool result in its own user-role message; a mixed user
 * message contributes its text first and its tool results after.
 */
function serializeMessages(messages) {
  const wire = []
  for (const message of messages) {
    assertTextOnly(message.content)
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    const toolResults = (message.content ?? []).filter((block) => block.type === 'tool-result')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) wire.push({ role: 'user', content: text })
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/**
 * Build the wire request for one harness call, before pinning.
 * @param options - the harness request (model, system, history, tools, sampling).
 * @param connection - resolved connection facts (default token caps).
 */
export function buildRequestBody(options, connection) {
  const messages = []
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system })
  messages.push(...serializeMessages(options.messages))
  const tools = (options.tools ?? []).map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools.length > 0 ? { tools } : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
    ...(options.reasoningEffort === undefined ? {} : { reasoning_effort: options.reasoningEffort }),
  }
}

//#endregion

//#region stream translation

/** Map an OpenAI `finish_reason` to the harness finish reason. */
export function mapFinishReason(reason) {
  switch (reason) {
    case 'stop':
    case 'end_turn':
      return { kind: 'stop' }
    case 'tool_calls':
    case 'tool-calls':
      return { kind: 'tool-calls' }
    case 'length':
    case 'max_tokens':
      return { kind: 'max-tokens' }
    default:
      return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: String(reason).toUpperCase() } }
  }
}

/**
 * Map OpenAI usage fields to disjoint harness counts.
 *
 * `prompt_tokens` includes cache hits per the OpenAI convention, and the
 * harness counts are disjoint, so cached tokens are subtracted out of
 * `inputTokens`.
 */
export function mapUsage(usage) {
  const cacheRead = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens
  const input = Number.isSafeInteger(usage?.prompt_tokens) ? usage.prompt_tokens : 0
  const output = Number.isSafeInteger(usage?.completion_tokens) ? usage.completion_tokens : 0
  const combined = input + output
  const hasExactTotal = Number.isSafeInteger(usage?.total_tokens) ? usage.total_tokens === combined : true
  return {
    inputTokens: input - (cacheRead ?? 0),
    outputTokens: output,
    ...(hasExactTotal ? { totalTokens: combined } : {}),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

/** One streamed identity field: a later empty or null value never clears it. */
function acceptIdentity(current, incoming) {
  return typeof incoming === 'string' && incoming.length > 0 ? incoming : current
}

/** Assemble the terminal content block for one open block. */
function closeBlock(block) {
  switch (block.kind) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    default:
      return { type: 'tool-call', id: ToolCallId(block.callId ?? ''), name: block.name ?? '', arguments: block.text }
  }
}

/** Map a gateway error payload to a stable harness code. */
export function streamErrorCode(message, status) {
  const detail = String(message ?? '')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (/unauthorized|re-authenticate|invalid api key|401|403/i.test(detail)) return 'AUTH'
  if (/429|rate limit|rate-?limited/i.test(detail)) return 'RATE_LIMIT'
  if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (status === 400) return 'INVALID_REQUEST'
  if (status !== undefined && status >= 500) return 'SERVER'
  if (status !== undefined && status >= 400) return `HTTP_${status}`
  return 'UPSTREAM'
}

/**
 * Translate decoded SSE payloads into harness stream chunks.
 *
 * Deltas stream through as they arrive; block ends, usage and the finish reason
 * are all deferred to the `[DONE]` sentinel, so no chunk ever follows `finish`.
 * A completion with no content at all becomes an `EMPTY_RESPONSE` error finish
 * rather than a silent empty message.
 *
 * @param payloads - decoded SSE payloads from {@link parseServerSentEvents}, `[DONE]` last.
 */
export async function* translate(payloads) {
  let nextIndex = 0
  let textBlock
  let reasoningBlock
  const toolBlocks = new Map()
  const order = []
  let pendingFinish
  let pendingUsage
  const open = (kind) => {
    const block = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }
  for await (const payload of payloads) {
    if (payload === '[DONE]') {
      for (const block of order) yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
          : reason,
      }
      return
    }
    const chunk = unwrapEnvelope(payload)
    // A 200 response whose body is an error object must fail the attempt, so a
    // pin that the router refuses still fails over to the next candidate.
    if (chunk?.error !== undefined && chunk?.choices === undefined) {
      throw new LlmError(errorText(chunk.error), streamErrorCode(errorText(chunk.error)))
    }
    for (const choice of chunk?.choices ?? []) {
      const delta = choice?.delta ?? {}
      const reasoning = delta.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (reasoningBlock === undefined) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }
      const content = delta.content
      if (typeof content === 'string' && content.length > 0) {
        if (textBlock === undefined) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }
      for (const call of delta.tool_calls ?? []) {
        let block = toolBlocks.get(call.index)
        if (block === undefined) {
          block = open('tool-call')
          toolBlocks.set(call.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        block.callId = acceptIdentity(block.callId, call.id)
        block.name = acceptIdentity(block.name, call.function?.name)
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: ToolCallId(block.callId ?? ''),
          ...(block.name === undefined ? {} : { name: block.name }),
          argumentsDelta: fragment,
        }
      }
      if (typeof choice?.finish_reason === 'string') pendingFinish = mapFinishReason(choice.finish_reason)
    }
    if (chunk?.usage !== undefined && chunk.usage !== null) pendingUsage = mapUsage(chunk.usage)
  }
  throw new LlmError('stream ended without [DONE]', 'STREAM_CLOSED')
}

//#endregion

/**
 * Watch a payload stream for routing metadata without disturbing it.
 *
 * The gateway attaches `provider_metadata.gateway.routing` to the message of a
 * non-streaming answer; in a stream it appears on whichever frame carries it,
 * so every frame is inspected and the last non-null reading wins.
 *
 * @param payloads - decoded SSE payloads.
 * @param observed - mutable `{ provider, canonical, pipeline }` filled in place.
 */
async function* tapRouting(payloads, observed) {
  for await (const payload of payloads) {
    if (payload !== '[DONE]') {
      const routing = parseRouting(payload)
      if (routing.finalProvider !== null) {
        observed.provider = routing.finalProvider
        observed.pipeline = routing.pipeline
        if (routing.canonicalSlug !== null) observed.canonical = routing.canonicalSlug
      }
    }
    yield payload
  }
}

/**
 * The Cline Pass adapter. One instance serves the plugin's provider route(s);
 * the harness model id IS the gateway's wire model id.
 */
export class ClinePassAdapter extends LlmAdapter {
  constructor(config) {
    super()
    this.config = config
  }

  providerInfo(provider) {
    return { id: provider, name: this.config.connection().displayName }
  }

  listModels(provider) {
    return Promise.resolve(this.config.connection().models.map((model) => this.modelInfo(provider, model)))
  }

  resolveModel(provider, model) {
    const connection = this.config.connection()
    const configured = connection.models.find((entry) => entry.id === model)
    const discovered = this.config.discoveredContext?.(model)
    const override = configured ?? { id: model }
    const resolved = resolveModelMetadata(provider, model, override, {
      contextWindow: discovered ?? connection.defaultContextWindow,
      maxTokens: connection.maxTokens,
      reasoning: connection.reasoningModels !== false,
    })
    // A probe that saw this model's real endpoints overrides the published
    // window: it is measured, not documented.
    return Promise.resolve(discovered === undefined
      ? resolved
      : { ...resolved, context: { contextWindow: Math.max(discovered, resolved.context.contextWindow) } })
  }

  /** Advertise one model in the catalog listing. */
  modelInfo(provider, model) {
    const input = Array.isArray(model.input) && model.input.length > 0 ? model.input : ['text']
    return {
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: input,
    }
  }

  stream(options) {
    return this.run(options)
  }

  /**
   * Attempt every pinned candidate in order, yielding the first one that
   * produces content. Failover happens only before the first yielded chunk.
   */
  async *run(options) {
    const connection = this.config.connection()
    const meta = this.config.modelMeta(options.model) ?? {}
    const attempts = buildAttempts(this.config.pin(options.model))
    const startedAt = Date.now()
    const trace = []
    let delivered = false
    let lastError = null
    for (const attempt of attempts) {
      const account = await this.config.resolveAccount()
      const body = injectPrefs(buildRequestBody(options, connection), meta, attempt)
      const attemptStarted = Date.now()
      const consumer = new AbortController()
      const upstream = options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal])
      const watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
      try {
        let response
        try {
          response = await fetch(chatURL(account.baseURL), {
            method: 'POST',
            headers: {
              authorization: `Bearer ${account.key}`,
              'content-type': 'application/json',
              accept: 'text/event-stream',
              ...attributionHeaders(),
            },
            body: JSON.stringify(body),
            signal: watchdog.signal,
          })
        } catch (error) {
          if (options.signal?.aborted) throw new LlmError('Cline Pass request aborted by caller', 'ABORTED', { cause: error })
          const note = errorChain(error)
          trace.push({ upstream: attempt.upstream ?? '(auto)', status: 0, ms: Date.now() - attemptStarted, note })
          this.config.learnUpstream(options.model, attempt.upstream, 'unknown', note, Date.now() - attemptStarted)
          lastError = new LlmError(note, 'TRANSPORT', { cause: error })
          continue
        }
        if (!response.ok) {
          const raw = await response.text().catch(() => '')
          let detail = raw.slice(0, 400)
          try {
            const parsed = unwrapEnvelope(JSON.parse(raw))
            detail = errorText(parsed?.error) || detail
          } catch { /* keep the raw text */ }
          const ms = Date.now() - attemptStarted
          trace.push({ upstream: attempt.upstream ?? '(auto)', status: response.status, ms, note: detail.slice(0, 160) })
          this.config.learnUpstream(options.model, attempt.upstream, classifyUpstreamError(detail), detail, ms)
          lastError = new LlmError(`${detail || `HTTP ${response.status}`} [model=${options.model}]`, streamErrorCode(detail, response.status), { status: response.status })
          // A rejected pin or a busy upstream is worth another candidate; an
          // auth failure is not, so it is raised immediately.
          if (lastError.code === 'AUTH' || lastError.code === QUOTA_EXCEEDED_CODE) throw lastError
          continue
        }
        if (response.body === null || response.body === undefined) {
          lastError = new LlmError('gateway returned no response body', 'EMPTY_RESPONSE', { status: response.status })
          continue
        }
        let yielded = false
        const observed = { provider: null, canonical: null, pipeline: null }
        const iterator = translate(tapRouting(parseServerSentEvents(response.body), observed))[Symbol.asyncIterator]()
        try {
          for (;;) {
            const next = await watchdog.next(iterator)
            if (next.done === true) break
            yielded = true
            yield next.value
          }
        } catch (error) {
          if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
            throw new LlmError(`Cline Pass stream idle timeout after ${connection.streamIdleTimeoutMs}ms [model=${options.model}]`, 'TIMEOUT', { cause: error })
          }
          if (options.signal?.aborted) throw new LlmError('Cline Pass request aborted by caller', 'ABORTED', { cause: error })
          const note = error instanceof LlmError ? error.message : errorChain(error)
          const ms = Date.now() - attemptStarted
          trace.push({ upstream: attempt.upstream ?? '(auto)', status: 200, ms, note: note.slice(0, 160) })
          this.config.learnUpstream(options.model, attempt.upstream, classifyUpstreamError(note), note, ms)
          // Content already reached the caller: this is the answer's failure,
          // not a reason to silently ask another channel. A missing account is
          // fatal for the same reason — every candidate would fail the same way.
          if (yielded || error?.code === 'AUTH' || error?.code === QUOTA_EXCEEDED_CODE) {
            this.config.record(options.model, {
              provider: observed.provider,
              canonical: observed.canonical,
              attempts: trace.map((row) => row.upstream),
              ms: Date.now() - startedAt,
              stream: true,
              error: note.slice(0, 200),
              account: account.name,
            })
            throw error instanceof LlmError ? error : new LlmError(note, 'TRANSPORT', { cause: error })
          }
          lastError = error instanceof LlmError ? error : new LlmError(note, 'TRANSPORT', { cause: error })
          continue
        } finally {
          consumer.abort('Cline Pass stream consumer stopped')
          if (iterator.return !== undefined) {
            try {
              await iterator.return()
            } catch { /* the consumer controller already owns termination */ }
          }
        }
        delivered = true
        trace.push({ upstream: attempt.upstream ?? '(auto)', status: 200, ms: Date.now() - attemptStarted, note: 'ok' })
        this.config.record(options.model, {
          provider: observed.provider ?? (attempt.upstream ?? null),
          canonical: observed.canonical,
          attempts: trace.map((row) => row.upstream),
          ms: Date.now() - startedAt,
          stream: true,
          error: null,
          account: account.name,
        })
        if (attempt.upstream !== null) this.config.learnUpstream(options.model, attempt.upstream, 'ok', '', Date.now() - attemptStarted)
        return
      } finally {
        watchdog[Symbol.dispose]()
      }
    }
    if (!delivered) {
      const message = lastError?.message ?? 'no pinned upstream could serve the request'
      this.config.record(options.model, {
        provider: null,
        attempts: trace.map((row) => row.upstream),
        ms: Date.now() - startedAt,
        stream: true,
        error: message.slice(0, 200),
        account: null,
      })
      throw lastError ?? new LlmError(`${message} [model=${options.model}]`, 'UPSTREAM')
    }
  }
}
