// 1.0.4 审查修复的回归测试：本地模拟上游 + 子进程启动 server.mjs，端到端验证协议转换、
// 账号轮换、停服落盘等行为。不访问任何真实上游：站点要么指向本地 mock，要么禁用。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { isQuotaError } from '../src/pool.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 17_000 + Math.floor(Math.random() * 2000);
const KEY = 'sk-wb-test-review';
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

// ---------------- 模拟上游 ----------------
const hits = new Map();
const hitCount = (k) => hits.get(k) || 0;
const chunk = (delta) => JSON.stringify({ id: 'up-1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: null }] });
const finish = (reason, usage) => JSON.stringify({ id: 'up-1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: reason }], usage });
const SCENARIOS = {
  normal: [chunk({ role: 'assistant' }), chunk({ content: 'hello' }), finish('stop', { prompt_tokens: 3, completion_tokens: 1 })],
  'tools-text': [
    chunk({ role: 'assistant', content: 'Let me check.' }),
    chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"SF"}' } }] }),
    chunk({ content: ' Done.' }),
    finish('tool_calls'),
  ],
  'reason-tool': [
    chunk({ role: 'assistant' }),
    chunk({ reasoning_content: 'think' }),
    chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'shell', arguments: '' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }),
    finish('tool_calls', { prompt_tokens: 5, completion_tokens: 7 }),
  ],
  'err-after-content': [chunk({ role: 'assistant', content: 'hi' }), JSON.stringify({ code: 11, msg: 'boom' })],
};

const mock = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const url = new URL(req.url, 'http://x');
  const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (url.pathname.endsWith('/enterprises/personal/models')) {
    hits.set('catalog', hitCount('catalog') + 1);
    return json(200, { code: 0, data: { models: [...Object.keys(SCENARIOS), 'too-long', 'bad-request'].map((id) => ({ id, name: id, credits: 'x1 credits', maxInputTokens: 100000 })) } });
  }
  if (url.pathname === '/v2/billing/meter/get-user-resource') {
    hits.set('billing', hitCount('billing') + 1);
    return json(200, { code: 0, data: { Response: { Data: { Accounts: [{ PackageName: 'p', CapacityRemain: 100 }] } } } });
  }
  if (url.pathname === '/v2/chat/completions') {
    const model = JSON.parse(body).model;
    hits.set('chat:' + model, hitCount('chat:' + model) + 1);
    if (model === 'too-long') return json(400, { code: 400, msg: 'prompt is too long: 999999 tokens > 1000 maximum' });
    if (model === 'bad-request') return json(400, { code: 40001, msg: 'invalid parameter: temperature' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const f of SCENARIOS[model] || SCENARIOS.normal) res.write(`data: ${f}\n\n`);
    return res.end('data: [DONE]\n\n');
  }
  json(404, {});
});

let child = null;
let exited = null;
let tmpDir = null;
let spawnBlocked = false;

const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: AUTH, body: JSON.stringify(body) });
/** 解析 SSE 文本为 [{ event, json }]。 */
const sse = (text) => text.split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
  const data = /^data: (.*)$/m.exec(block)?.[1];
  let json = null;
  try { json = JSON.parse(data); } catch { /* [DONE] 等非 JSON 帧 */ }
  return { event: /^event: (.*)$/m.exec(block)?.[1], json };
});

describe('1.0.4 审查修复（端到端）', () => {
  before(async () => {
    await new Promise((r) => mock.listen(0, '127.0.0.1', r));
    const mockBase = `http://127.0.0.1:${mock.address().port}`;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-review-'));
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
      host: '127.0.0.1', port: PORT, apiKey: KEY, defaultSite: 'cn-cli', defaultModel: 'normal',
      routing: { fallbackMode: 'off' }, upstreamRetry: { attempts: 1, backoffMs: [0] },
      sites: { 'cn-cli': { label: 'mock', apiBase: mockBase, origin: mockBase, billingBase: mockBase }, 'intl-cli': { enabled: false }, 'intl-work': { enabled: false } },
    }));
    const acct = (n) => ({ id: 'acc_' + n, label: 'A' + n, accessToken: 'tok' + n, refreshToken: 'r', expiresAt: Date.now() + 30 * 864e5, uid: 'u' + n, enabled: true, failCount: 0 });
    fs.writeFileSync(path.join(tmpDir, 'auth.cn-cli.pool.json'), JSON.stringify({ version: 1, nextLabel: 4, accounts: [acct(1), acct(2), acct(3)] }));
    const logFd = fs.openSync(path.join(tmpDir, 'server.log'), 'w');
    try {
      child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: tmpDir, env: { ...process.env, WB_CONFIG_DIR: tmpDir }, stdio: ['ignore', logFd, logFd] });
    } catch (e) {
      if (e.code === 'EPERM') { spawnBlocked = true; return; }
      throw e;
    }
    exited = new Promise((r) => child.on('exit', r));
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(BASE + '/health')).ok) return; } catch { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('服务未能启动：' + fs.readFileSync(path.join(tmpDir, 'server.log'), 'utf8'));
  });

  after(() => {
    try { child?.kill(); } catch { /* 已退出 */ }
    mock.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('Anthropic 流式：工具参数用 input_json_delta，工具后的正文另开文本块', async (t) => {
    if (spawnBlocked) return t.skip('环境禁止启动子进程');
    const evs = sse(await (await post('/v1/messages', { model: 'tools-text', stream: true, max_tokens: 200, messages: [{ role: 'user', content: 'weather?' }] })).text());
    const start = evs.find((e) => e.json?.content_block?.type === 'tool_use');
    assert.deepEqual(start.json.content_block.input, {});
    const toolDeltas = evs.filter((e) => e.json?.delta?.partial_json !== undefined);
    assert.ok(toolDeltas.length > 0);
    assert.ok(toolDeltas.every((e) => e.json.delta.type === 'input_json_delta'));
    assert.deepEqual(JSON.parse(toolDeltas.map((e) => e.json.delta.partial_json).join('')), { city: 'SF' });
    // 每个增量都必须写在已打开、且类型匹配的块上
    const open = new Map();
    const want = { text_delta: 'text', input_json_delta: 'tool_use' };
    for (const e of evs) {
      if (e.json?.type === 'content_block_start') open.set(e.json.index, e.json.content_block.type);
      if (e.json?.type === 'content_block_stop') open.delete(e.json.index);
      if (e.json?.type === 'content_block_delta') assert.equal(open.get(e.json.index), want[e.json.delta.type], JSON.stringify(e.json));
    }
  });

  test('Responses 流式：推理后直接调工具时各项 output_index 独立且按序收尾', async (t) => {
    if (spawnBlocked) return t.skip('环境禁止启动子进程');
    const evs = sse(await (await post('/v1/responses', { model: 'reason-tool', stream: true, input: 'ls' })).text()).filter((e) => e.json);
    const added = evs.filter((e) => e.event === 'response.output_item.added').map((e) => e.json.output_index);
    assert.equal(new Set(added).size, added.length);
    const rsDone = evs.findIndex((e) => e.event === 'response.output_item.done' && e.json.item.type === 'reasoning');
    const fcAdded = evs.findIndex((e) => e.event === 'response.output_item.added' && e.json.item.type === 'function_call');
    assert.ok(rsDone >= 0 && rsDone < fcAdded);
    const output = evs.find((e) => e.event === 'response.completed').json.response.output;
    assert.deepEqual(output.map((o) => o.type), ['reasoning', 'function_call']);
    assert.equal(output[1].arguments, '{"cmd":"ls"}');
  });

  test('Responses 流式：上游报错只发带信息的 response.failed，不再发 completed', async (t) => {
    if (spawnBlocked) return t.skip('环境禁止启动子进程');
    const evs = sse(await (await post('/v1/responses', { model: 'err-after-content', stream: true, input: 'x' })).text()).filter((e) => e.json);
    assert.equal(evs.find((e) => e.event === 'response.failed')?.json.response.error.message, 'boom');
    assert.ok(!evs.some((e) => e.event === 'response.completed'));
  });

  test('Responses：未传 stream 时按规范返回 JSON', async (t) => {
    if (spawnBlocked) return t.skip('环境禁止启动子进程');
    const r = await post('/v1/responses', { model: 'normal', input: 'hi' });
    assert.match(r.headers.get('content-type'), /json/);
    const j = await r.json();
    assert.equal(j.object, 'response');
    assert.equal(j.output[0].content[0].text, 'hello');
  });

  test('输入超长且无法压缩：保留上游错误原文，且不轮换账号', async (t) => {
    if (spawnBlocked) return t.skip('环境禁止启动子进程');
    const before = hitCount('chat:too-long');
    const r = await post('/v1/chat/completions', { model: 'too-long', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error.message, /too long/);
    assert.equal(hitCount('chat:too-long') - before, 1);
  });

  test('参数错误：不轮换账号，也不让账号进入冷却', async (t) => {
    if (spawnBlocked) return t.skip('环境禁止启动子进程');
    const before = hitCount('chat:bad-request');
    await (await post('/v1/chat/completions', { model: 'bad-request', messages: [{ role: 'user', content: 'x' }] })).text();
    assert.equal(hitCount('chat:bad-request') - before, 1);
    const pool = JSON.parse(fs.readFileSync(path.join(tmpDir, 'auth.cn-cli.pool.json'), 'utf8'));
    for (const a of pool.accounts) assert.ok(!a.cooldownUntil && !a.exhaustedAt, JSON.stringify(a));
  });

  test('正常对话（OpenAI 流式 / 非流式、Anthropic 非流式）不受影响', async (t) => {
    if (spawnBlocked) return t.skip('环境禁止启动子进程');
    const j = await (await post('/v1/chat/completions', { model: 'normal', messages: [{ role: 'user', content: 'hi' }] })).json();
    assert.equal(j.choices[0].message.content, 'hello');
    const s = await (await post('/v1/chat/completions', { model: 'normal', stream: true, messages: [{ role: 'user', content: 'hi' }] })).text();
    assert.ok(s.includes('"content":"hello"') && s.includes('[DONE]'));
    const a = await (await post('/v1/messages', { model: 'normal', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] })).json();
    assert.equal(a.content[0].text, 'hello');
  });

  test('重复的控制台鉴权失败告警被节流', async (t) => {
    if (spawnBlocked) return t.skip('环境禁止启动子进程');
    for (let i = 0; i < 5; i++) await (await fetch(BASE + '/console/api/state', { headers: { 'X-Console-Token': 'stale' } })).text();
    const logs = await (await fetch(BASE + '/console/api/logs', { headers: AUTH })).json();
    assert.equal(logs.list.filter((l) => l.text.includes('控制台接口鉴权失败')).length, 1);
  });

  test('连续刷新首页只查询一次余额', async (t) => {
    if (spawnBlocked) return t.skip('环境禁止启动子进程');
    const before = hitCount('billing');
    for (let i = 0; i < 2; i++) await (await fetch(BASE + '/console/api/state', { headers: AUTH })).json();
    assert.equal(hitCount('billing') - before, 1);
  });

  // 放在最后：会让服务退出
  test('/admin/shutdown 退出前保存最后一次调用的用量', async (t) => {
    if (spawnBlocked) return t.skip('环境禁止启动子进程');
    await new Promise((r) => setTimeout(r, 3500)); // 等之前的节流写盘完成
    const calls = () => {
      try { return Object.values(JSON.parse(fs.readFileSync(path.join(tmpDir, 'usage.json'), 'utf8')).days).reduce((n, d) => n + d.calls, 0); } catch { return 0; }
    };
    const before = calls();
    await (await post('/v1/chat/completions', { model: 'normal', messages: [{ role: 'user', content: 'hi' }] })).json();
    await (await post('/admin/shutdown', {})).text();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    assert.equal(calls(), before + 1);
  });
});

test('配置中的坏规则只丢弃该条，无效 fallbackMode 回退为 off', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-review-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    port: 8788, apiKey: 'k', routing: { fallbackMode: 'bogus' },
    routingPolicies: [
      { model: 'ok-model', site: 'cn-cli', fallbackMode: 'off', fallbackSites: [] },
      { model: 'bad-model', site: 'no-such-site', fallbackMode: 'off', fallbackSites: [] },
    ],
  }));
  const cfg = loadConfig(dir);
  assert.deepEqual(cfg.routingPolicies.map((p) => p.model), ['ok-model']);
  assert.equal(cfg.routing.fallbackMode, 'off');
});

test('上下文超长不算额度耗尽，真实额度不足仍判为耗尽', () => {
  assert.equal(isQuotaError(400, "This model's maximum context length is 8192 tokens (context_length_exceeded)"), false);
  assert.equal(isQuotaError(400, 'prompt is too long: 200001 tokens > 200000 maximum, exceeds limit'), false);
  assert.equal(isQuotaError(400, 'insufficient credit balance'), true);
  assert.equal(isQuotaError(200, '积分不足'), true);
  assert.equal(isQuotaError(429, ''), true);
});

test('桌面数据：配置损坏时报出文件路径，导入目录缺 config.json 给出明确提示', (t) => {
  const { initData, importData } = require('../desktop/data.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-review-data-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'config.json'), '{ broken');
  assert.throws(() => initData(data), (e) => e.message.includes(path.join(data, 'config.json')));
  const empty = path.join(dir, 'empty');
  fs.mkdirSync(empty);
  assert.throws(() => importData(empty, path.join(dir, 'dest')), /没有 config\.json/);
});
