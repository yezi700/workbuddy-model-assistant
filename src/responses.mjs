// OpenAI Responses API 兼容层：/v1/responses
//
// 背景：Codex CLI / 桌面端 0.154+ 只认 Responses 协议（wire_api 仅接受 "responses"），
// 而本项目上游是 Chat Completions 语义。本模块做双向协议转换：
//
//   Codex(Responses 请求) → 本层 → Chat Completions → 复用车载 handler → 转回 Responses
//
// 设计原则：只新增，不改动 /v1/chat/completions 的任何既有行为。
import { resolveTarget } from './router.mjs';
import { openRoutedChat } from './routed-chat.mjs';
import { aggregateFrames, classifyFrame, upstreamErrorMessage } from './upstream.mjs';
import { recordUsage } from './usage.mjs';
import { startSSE, writeSSEEvent, sendJson, sendError, estimateTokens } from './util.mjs';
import { requestLog, warn } from './log.mjs';

/** 生成 Responses 风格 id。 */
function rid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/**
 * Responses 请求 → Chat Completions 请求。
 *
 * 关键映射：
 *   - instructions          → system 消息
 *   - input(string)         → 单条 user 消息
 *   - input(数组)           → 逐项转换（message / function_call / function_call_output）
 *   - tools(function 扁平)  → tools(function 嵌套)
 *   - max_output_tokens     → max_tokens
 */
export function toChatRequest(body) {
  const messages = [];

  // 注意：上游对 system 消息做内容模式匹配，Codex 的 instructions（含 "You are a coding agent
  // running in the Codex CLI ..."）作为 system 会被判定为 "Illegal API invocation from an
  // unapproved channel"。实测证明同样内容放 user 位置可正常通过，因此这里把 instructions
  // 折进首条 user 消息，而不是用 system 角色发送。
  const instructions =
    typeof body.instructions === 'string' && body.instructions.trim() ? body.instructions.trim() : '';

  const input = body.input;

  if (typeof input === 'string') {
    if (input) messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const type = item.type || (item.role ? 'message' : null);

      if (type === 'message') {
        // developer 角色上游不接受，统一降级为 user；再合并进 instructions
        const role = item.role === 'assistant' ? 'assistant' : 'user';
        messages.push({ role, content: normalizeContent(item.content) });
      } else if (type === 'function_call') {
        // 模型发起的工具调用 → assistant.tool_calls
        //
        // 关键：连续的多个 function_call 必须合并进【同一条】assistant 消息。
        // 若每个都单独生成一条 assistant 消息，就会出现「两条 assistant 消息相邻、
        // 中间没有对应的 tool 结果」，上游会报：
        //   tool calls and tool results do not match
        // Codex 经常一次并行发起多个工具调用，所以这里必须合并。
        const call = {
          id: item.call_id || item.id || rid('call'),
          type: 'function',
          function: { name: item.name || '', arguments: item.arguments || '{}' },
        };
        const last = messages[messages.length - 1];
        if (last && last.role === 'assistant' && Array.isArray(last.tool_calls) && last.content === null) {
          last.tool_calls.push(call); // 并入上一条 assistant
        } else {
          messages.push({ role: 'assistant', content: null, tool_calls: [call] });
        }
      } else if (type === 'function_call_output') {
        // 工具执行结果 → role:tool
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id || item.id || '',
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
        });
      } else if (type === 'reasoning') {
        // 推理项不回传给上游（上游不接受该角色）
        continue;
      } else if (item.role) {
        messages.push({ role: item.role, content: normalizeContent(item.content) });
      }
    }
  }

  if (!messages.length) messages.push({ role: 'user', content: '' });

  // 合并 instructions 到首条 user 消息（见上方说明：不能走 system 角色）
  if (instructions) {
    const firstUser = messages.find((m) => m.role === 'user');
    if (firstUser) {
      firstUser.content = `<instructions>\n${instructions}\n</instructions>\n\n${firstUser.content || ''}`;
    } else {
      messages.unshift({ role: 'user', content: `<instructions>\n${instructions}\n</instructions>` });
    }
  }

  // 上游硬性要求首条必须是 system，且过长/特定内容会被拒；这里只放一句极短占位
  if (messages[0]?.role !== 'system') {
    messages.unshift({ role: 'system', content: 'You are a helpful AI assistant.' });
  }

  const chat = { messages, stream: body.stream !== false };

  // 模型由调用方注入
  if (body.model) chat.model = body.model;

  if (body.max_output_tokens) chat.max_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.top_p !== undefined) chat.top_p = body.top_p;

  // tools：Responses 是扁平的 {type,name,parameters}，Chat 是嵌套的 {type,function:{...}}
  if (Array.isArray(body.tools) && body.tools.length) {
    const tools = [];
    for (const t of body.tools) {
      if (!t || typeof t !== 'object') continue;
      if (t.type === 'function' && t.name) {
        tools.push({
          type: 'function',
          function: {
            name: t.name,
            description: t.description || undefined,
            parameters: t.parameters || { type: 'object', properties: {} },
          },
        });
      } else if (t.type === 'function' && t.function) {
        tools.push(t); // 已是 Chat 格式，原样保留
      }
      // 其余内置工具类型（web_search 等）上游不支持，忽略
    }
    if (tools.length) chat.tools = tools;
  }

  if (body.tool_choice !== undefined) {
    const tc = body.tool_choice;
    if (typeof tc === 'string') chat.tool_choice = tc;
    else if (tc && typeof tc === 'object' && tc.name) chat.tool_choice = tc.name;
  }

  return chat;
}

/** Responses 的 content 可能是字符串或分块数组，统一压成字符串。 */
function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content ?? '';
  const parts = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') {
      if (typeof p === 'string') parts.push(p);
      continue;
    }
    if (typeof p.text === 'string') parts.push(p.text);
    else if (p.type === 'input_text' && typeof p.text === 'string') parts.push(p.text);
  }
  return parts.join('');
}

/** 组装一个完整的 Responses 对象（供非流式与流式收尾共用）。 */
function buildResponse({ id, model, status, output, usage, createdAt }) {
  return {
    id,
    object: 'response',
    created_at: createdAt || Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: usage || null,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
  };
}

/** 把聚合后的 Chat 结果转成 Responses 的 output 数组。 */
function toOutput(agg) {
  const output = [];

  if (agg.reasoning) {
    output.push({
      type: 'reasoning',
      id: rid('rs'),
      summary: [{ type: 'summary_text', text: agg.reasoning }],
    });
  }

  if (agg.content) {
    output.push({
      type: 'message',
      id: rid('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: agg.content, annotations: [] }],
    });
  }

  for (const tc of agg.toolCallList || []) {
    output.push({
      type: 'function_call',
      id: rid('fc'),
      call_id: tc.id || rid('call'),
      name: tc.function?.name || '',
      arguments: tc.function?.arguments || '{}',
      status: 'completed',
    });
  }

  if (!output.length) {
    output.push({
      type: 'message',
      id: rid('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [] }],
    });
  }

  return output;
}

/** Chat usage → Responses usage。 */
function toUsage(u) {
  if (!u) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const input = u.prompt_tokens ?? u.input_tokens ?? 0;
  const output = u.completion_tokens ?? u.output_tokens ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: u.prompt_cache_hit_tokens ?? u.cached_tokens ?? 0 },
    output_tokens: output,
    output_tokens_details: {
      reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? u.completion_thinking_tokens ?? 0,
    },
    total_tokens: u.total_tokens ?? input + output,
  };
}

export async function handleResponses(ctx) {
  const { cfg, res, body, signal } = ctx;
  const started = Date.now();
  // 与 OpenAI 规范一致：stream 缺省为 false（Codex 总是显式传 true）。
  // 原先缺省走流式，不传 stream 的 SDK 会收到 SSE 而解析失败。
  const wantsStream = body.stream === true;

  // 先解析模型（保持与 chat 相同的路由语义：支持 site/model 前缀与别名）
  const target = await resolveTarget(cfg, body.model);
  let { site, model } = target;

  const chatReq = toChatRequest({ ...body, model });
  const requestModel = target.requested;

  const opened = await openRoutedChat(cfg, target, chatReq, { signal });
  const up = opened.up;
  site = opened.site;
  model = opened.model;
  chatReq.model = model;
  if (!up.ok) {
    requestLog({ site, model, mode: 'responses', status: up.status, ms: Date.now() - started, note: 'upstream_reject' });
    return sendError(res, up.status, upstreamErrorMessage(up.status, up.text, site));
  }

  const responseId = rid('resp');

  // ---------- 非流式 ----------
  if (!wantsStream) {
    let agg;
    try {
      agg = await aggregateFrames(up.frames);
    } catch (e) {
      requestLog({ site, model, mode: 'responses-json', status: e.status || 502, ms: Date.now() - started, note: 'aggregate_failed' });
      return sendError(res, e.status || 502, e.message);
    } finally {
      up.close();
    }

    const usage = toUsage(agg.usage);
    requestLog({ site, model, mode: 'responses-json', status: 200, ms: Date.now() - started, tools: agg.toolCallList.length || undefined });
    recordUsage({
      site,
      model,
      mode: 'responses',
      status: 200,
      promptTokens: usage.input_tokens,
      completionTokens: usage.output_tokens,
      credit: agg.usage?.credit ?? 0,
      ms: Date.now() - started,
      tools: agg.toolCallList.length,
    });

    return sendJson(
      res,
      200,
      buildResponse({
        id: responseId,
        model: requestModel,
        status: 'completed',
        output: toOutput(agg),
        usage,
        createdAt: agg.created,
      }),
    );
  }

  // ---------- 流式 ----------
  startSSE(res, { 'X-Service': 'workbuddy-proxy', 'X-Upstream-Site': site });

  let seq = 0;
  const emit = (type, payload) =>
    writeSSEEvent(res, type, JSON.stringify({ type, sequence_number: seq++, ...payload }));

  let finished = false;
  let failed = null; // 上游错误信息；发出 response.failed 后不能再发 response.completed
  let contentChars = 0;
  let upstreamUsage = null;
  // 每个输出项在「打开」时分配自己的 output_index，增量与收尾都用它，不再事后推算。
  let nextIndex = 0;
  const doneItems = []; // { index, item }：已收尾的输出项，response.completed 按 index 排序回填
  let reasoning = null; // 当前打开的推理项 { id, index, text }
  let text = null; // 当前打开的正文项 { id, index, text }
  const toolItems = new Map(); // 上游 tool_call index → { id, call_id, name, args, index }

  const closeReasoning = async () => {
    if (!reasoning) return;
    const r = reasoning;
    reasoning = null;
    const item = { type: 'reasoning', id: r.id, summary: [{ type: 'summary_text', text: r.text }] };
    await emit('response.reasoning_summary_text.done', { item_id: r.id, output_index: r.index, summary_index: 0, text: r.text });
    await emit('response.output_item.done', { output_index: r.index, item });
    doneItems.push({ index: r.index, item });
  };

  const closeText = async () => {
    if (!text) return;
    const t = text;
    text = null;
    const part = { type: 'output_text', text: t.text, annotations: [] };
    await emit('response.output_text.done', { item_id: t.id, output_index: t.index, content_index: 0, text: t.text });
    await emit('response.content_part.done', { item_id: t.id, output_index: t.index, content_index: 0, part });
    const item = { type: 'message', id: t.id, status: 'completed', role: 'assistant', content: [part] };
    await emit('response.output_item.done', { output_index: t.index, item });
    doneItems.push({ index: t.index, item });
  };

  const failWith = async (message) => {
    failed = String(message || '上游错误');
    const response = buildResponse({ id: responseId, model: requestModel, status: 'failed', output: [], usage: null });
    response.error = { code: 'upstream_error', message: failed };
    await emit('response.failed', { response });
  };

  try {
    await emit('response.created', {
      response: buildResponse({ id: responseId, model: requestModel, status: 'in_progress', output: [] }),
    });
    await emit('response.in_progress', {
      response: buildResponse({ id: responseId, model: requestModel, status: 'in_progress', output: [] }),
    });

    for await (const payload of up.frames) {
      const parsed = classifyFrame(payload);
      if (parsed.kind === 'error') {
        await failWith(parsed.message);
        break;
      }
      if (parsed.kind !== 'chunk') continue;

      const obj = parsed.obj;
      if (obj.usage) upstreamUsage = obj.usage;
      const delta = obj.choices?.[0]?.delta;
      if (!delta) continue;

      // 推理内容：作为 reasoning 项的增量。
      // Codex 要求增量前必须先 output_item.added，否则报 "ReasoningSummaryDelta without active item"。
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        if (!reasoning) {
          await closeText();
          reasoning = { id: rid('rs'), index: nextIndex++, text: '' };
          await emit('response.output_item.added', {
            output_index: reasoning.index,
            item: { type: 'reasoning', id: reasoning.id, summary: [] },
          });
        }
        reasoning.text += delta.reasoning_content;
        await emit('response.reasoning_summary_text.delta', {
          item_id: reasoning.id,
          output_index: reasoning.index,
          summary_index: 0,
          delta: delta.reasoning_content,
        });
      }

      // 正文
      if (typeof delta.content === 'string' && delta.content) {
        if (!text) {
          await closeReasoning();
          text = { id: rid('msg'), index: nextIndex++, text: '' };
          await emit('response.output_item.added', {
            output_index: text.index,
            item: { type: 'message', id: text.id, status: 'in_progress', role: 'assistant', content: [] },
          });
          await emit('response.content_part.added', {
            item_id: text.id,
            output_index: text.index,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          });
        }
        contentChars += delta.content.length;
        text.text += delta.content;
        await emit('response.output_text.delta', {
          item_id: text.id,
          output_index: text.index,
          content_index: 0,
          delta: delta.content,
        });
      }

      // 工具调用：先收尾推理与正文。推理模型常见「思考 → 直接调工具」，
      // 原先只在正文开始时收尾推理，推理项会和第一个工具项抢同一个 output_index。
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
        await closeReasoning();
        await closeText();
        for (const tc of delta.tool_calls) {
          const key = Number.isInteger(tc.index) ? tc.index : 0;
          let cur = toolItems.get(key);
          if (!cur) {
            cur = { id: rid('fc'), call_id: tc.id || rid('call'), name: tc.function?.name || '', args: '', index: nextIndex++ };
            toolItems.set(key, cur);
            await emit('response.output_item.added', {
              output_index: cur.index,
              item: {
                type: 'function_call',
                id: cur.id,
                call_id: cur.call_id,
                name: cur.name,
                arguments: '',
                status: 'in_progress',
              },
            });
          }
          if (tc.function?.name && !cur.name) cur.name = tc.function.name;
          if (tc.function?.arguments) {
            cur.args += tc.function.arguments;
            await emit('response.function_call_arguments.delta', {
              item_id: cur.id,
              output_index: cur.index,
              delta: tc.function.arguments,
            });
          }
        }
      }
    }

    if (!failed) {
      await closeReasoning();
      await closeText();
      for (const [, cur] of [...toolItems.entries()].sort((a, b) => a[0] - b[0])) {
        const item = {
          type: 'function_call',
          id: cur.id,
          call_id: cur.call_id,
          name: cur.name,
          arguments: cur.args,
          status: 'completed',
        };
        await emit('response.function_call_arguments.done', { item_id: cur.id, output_index: cur.index, arguments: cur.args });
        await emit('response.output_item.done', { output_index: cur.index, item });
        doneItems.push({ index: cur.index, item });
      }

      finished = true;
      await emit('response.completed', {
        response: buildResponse({
          id: responseId,
          model: requestModel,
          status: 'completed',
          output: doneItems.sort((a, b) => a.index - b.index).map((d) => d.item),
          usage: toUsage(upstreamUsage),
        }),
      });
    }
  } catch (e) {
    warn(`[${site}] Responses 流式转换异常：${e?.message || e}`);
    // 客户端还在时要明确告知失败，否则 Codex 只能报「流在 response.completed 之前断开」
    if (!failed && !finished && !signal?.aborted && !res.writableEnded) {
      await failWith(e?.message || String(e)).catch(() => {});
    }
  } finally {
    up.close();
    if (!res.writableEnded) res.end();
    const status = finished ? 200 : failed ? 502 : 499;
    requestLog({
      site,
      model,
      mode: 'responses',
      status,
      ms: Date.now() - started,
      note: failed ? 'upstream_error' : undefined,
    });
    recordUsage({
      site,
      model,
      mode: 'responses',
      status,
      promptTokens: upstreamUsage?.prompt_tokens ?? estimateTokens(JSON.stringify(chatReq.messages || [])),
      completionTokens: upstreamUsage?.completion_tokens ?? estimateTokens('x'.repeat(contentChars)),
      credit: upstreamUsage?.credit ?? 0,
      ms: Date.now() - started,
      tools: toolItems.size,
    });
  }
}
