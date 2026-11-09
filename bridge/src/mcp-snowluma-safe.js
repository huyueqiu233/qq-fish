// 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露聊天所需的**安全动作子集**（查状态/查群/查消息/发消息），
//   不暴露任何管理类动作（禁言、踢人、改群设置、文件上传下载等）。
// - 发送类工具强制校验白名单：目标群/私聊必须命中 config.json 的
//   allow.groups / allow.private，否则拒绝 —— agent 只能往被允许的地方发消息。
// - 所有调用走 OneBot HTTP API（httpUrl + accessToken）。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// 出站文本的敏感信息拦截**统一由桥接负责**（bridge.js 的 auditAndSend / 各发送端点的
// SENSITIVE_RE 校验）：所有 QQ 发送都经由桥接 HTTP API，因此 MCP 侧不再重复实现一遍。
// 这里 import 只用于「出站审计口径一致」的说明，不在 MCP 内做拦截——
// 在 MCP 里拦会连「安全拒绝理由」都拿不到，反而让模型无法把话说清楚。
import { SENSITIVE_RE } from './sensitive.js';
import { serializeModelData } from './qq-model-view.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const cfg = loadConfig();

function getConfig() {
  return loadConfig();
}

function getAccess() {
  const c = getConfig();
  return {
    allowGroups: (c.allow?.groups ?? []).map(String),
    allowPrivate: (c.allow?.private ?? []).map(String),
    denyGroups: (c.deny?.groups ?? []).map(String),
    denyPrivate: (c.deny?.private ?? []).map(String),
    allowAllWhenEmpty: c.allowAllWhenEmpty === true
  };
}

function getOneBotConfig() {
  const c = getConfig();
  return {
    httpUrl: (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: c.snowluma?.accessToken ?? ''
  };
}

// 与 bridge.allowed 保持一致：allow 列表为空时按 allowAllWhenEmpty 放行
function isAllowed(allowList, denyList, id, allowAllWhenEmpty) {
  const s = String(id);
  if (denyList.includes(s)) return false;
  if (allowList.length > 0) return allowList.includes(s);
  return allowAllWhenEmpty;
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// 说明：本文件曾经有一对 escapeCqText() / messageSegments()，用于在 MCP 侧构造消息段。
// 它们从来没有被任何工具调用（发送一律走桥接的 /api/send/*，由桥接统一构造文本段并做
// CQ 转义，见 bridge.js 的 onebotSend），属于"看起来在防护、实际是死代码"的假安全。
// 这里直接删除，避免以后有人以为 MCP 侧还有一道 CQ 转义而放松桥接那一层。

async function onebot(action, params = {}) {
  const { httpUrl, token } = getOneBotConfig();
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const hint = res.status === 426 ? '；HTTP 426 通常表示 httpUrl 指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  const body = await res.json();
  if (body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ''}`);
  }
  return body.data;
}

// 桥接控制台/内部 Agent API 访问：二代仿真模式的状态工具都通过这里读写桥接内存态。
function agentApiBase() {
  const port = Number(getConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}
function readConsoleToken() {
  // 每次请求都重新读取，优先 config.json 里的 consoleToken，其次 state/console-token，
  // 避免 token 变化后 MCP 仍使用启动时缓存的旧值导致一直 401。
  //
  // 必须与桥接的校验口径**完全一致**（bridge.js 的 startConsoleServer：长度 16~128、
  // 只允许 [A-Za-z0-9_-]，不合法就忽略并回退 state/console-token）。否则用户手填一个
  // 短令牌时桥接会正常运行，而 MCP 拿着这个桥接根本不认的值去请求 —— 每个工具都 401，
  // 且错误信息里看不出原因是"config.json 里的令牌格式不合法"。
  try {
    const c = getConfig();
    const configured = String(c.consoleToken ?? '').trim();
    if (/^[A-Za-z0-9_-]{16,128}$/.test(configured)) return configured;
  } catch {}
  try {
    const tokenFile = path.join(ROOT, 'state', 'console-token');
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 把桥接返回的 `error` 变成可读文本。
 *
 * 为什么必须有：桥接个别分支会回一个**对象**（例如 `{code, message}`），直接
 * `new Error(obj)` 会把它 String 成 "[object Object]" —— 模型和运维都读不到任何信息。
 * r3 的已知未修项里就记着 `qq_wait_for_messages` 出现过 `error: "\"Error: [object Object]\""`。
 */
function errorText(value, fallback) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    try {
      const text = JSON.stringify(value);
      if (text && text !== '{}') return text.slice(0, 500);
    } catch {}
    const message = value.message ?? value.msg ?? value.error;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 500);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

async function agentApi(path, init = {}) {
  const timeoutMs = init.timeoutMs || 15000;
  const { timeoutMs: _omit, ...rest } = init;
  const headers = agentHeaders(rest.headers);
  const res = await fetch(`${agentApiBase()}${path}`, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    throw new Error(errorText(body?.error, `桥接 API HTTP ${res.status}`));
  }
  // 桥接的部分端点会用 200 + {ok:false,error} 表达业务失败（例如发送被审计拦截）。
  // 不检查 body.ok 会把「被拦截」当成「发送成功」上报给模型 —— 模型据此认为消息已发出，
  // 于是不再重试也不告诉用户，是典型的静默错误。
  if (body && typeof body === 'object' && body.ok === false) {
    throw new Error(errorText(body.error, '桥接 API 返回 ok:false（未说明原因）'));
  }
  return body;
}

/**
 * 桥接 API 请求头（含控制台令牌、x-agent-call 与调用方附加头）。
 * 拆出来是为了长轮询通道复用同一套鉴权，避免两条通路口径漂移。
 */
function agentHeaders(extra = {}) {
  const consoleToken = readConsoleToken();
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(extra ?? {})
  };
  // 声明「这是一次智能体调用」。桥接据此把「没带会话令牌」判定为**拒绝**，而不是
  // 退化成「管理端全权」——所以这个头绝不能随 token 一起被省略。历史上 331/355/379/877
  // 行用 `...(token ? {headers:{...}} : {})` 把整个头省掉了，于是「模型漏传 token」
  // 不是被拒绝，反而提权成控制台权限（confused deputy）。
  // 令牌本身仍然只在真有时才发：/api/status 的模式探测（legacyReadToolAllowed）本来就是
  // 无令牌调用，桥接对它单独放行并按最小对象返回。
  headers['x-agent-call'] = '1';
  return headers;
}

/**
 * 长轮询专用 POST（`node:http`，不经过 undici）。
 *
 * 为什么必须单独一条：Node 的全局 `fetch` 是 undici，自带 300 秒 `headersTimeout`。
 * 而 `qq_wait_for_messages` 的常规用法就是 `timeoutMs=300000` 的沉睡前观察 ——
 * 客户端会在第 301 秒以 `fetch failed / Headers Timeout Error` 断掉，桥接侧的
 * 长轮询却还在跑满自己的预算：AI 拿不到结果只能重试，而 `activeWaits` 仍占着会话
 * （重新等待被 429），于是空转烧 token（见 issue #24）。`node:http` 没有默认响应超时，
 * 超时完全由这里的计时器按调用方预算控制。
 */
function agentApiLongPoll(path, init = {}) {
  const timeoutMs = Math.max(1000, Number(init.timeoutMs) || 15000);
  const url = new URL(`${agentApiBase()}${path}`);
  const body = init.body == null ? '' : String(init.body);
  const headers = agentHeaders(init.headers);
  headers['content-length'] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let res;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(`等待超时（${Math.round(timeoutMs / 1000)}s）`);
      finish(error);
      req?.destroy(error);
      res?.destroy();
    }, timeoutMs);
    timer.unref?.();
    try {
      req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: init.method || 'GET',
        headers,
        timeout: 0
      }, (response) => {
        res = response;
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          // 桥接的 wait 响应本来就是小 JSON；超过 4MB 说明对端异常，别把内存吃光。
          if (size > 4 * 1024 * 1024) {
            finish(new Error('等待响应体过大，已中止'));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', (error) => finish(error));
        response.on('aborted', () => finish(new Error('等待响应中断')));
        response.on('close', () => { if (!response.complete) finish(new Error('等待响应中断')); });
        response.on('end', () => {
          if (settled) return;
          let parsed = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = null; }
          const status = response.statusCode || 0;
          if (status < 200 || status >= 300) {
            finish(new Error(errorText(parsed?.error, `桥接 API HTTP ${status}`)));
            return;
          }
          if (parsed && typeof parsed === 'object' && parsed.ok === false) {
            finish(new Error(errorText(parsed.error, '桥接 API 返回 ok:false（未说明原因）')));
            return;
          }
          finish(null, parsed);
        });
      });
      req.on('error', (error) => finish(error));
      req.end(body);
    } catch (error) {
      finish(error);
      req?.destroy();
    }
  });
}

async function authorizeRead(key) {
  // 会话令牌必须显式携带：桥接已把空令牌的请求一律拒绝（避免把该端点变成免鉴权入口）。
  // 旧只读工具没有令牌，因此它们改由 legacyReadToolAllowed() 做模式判定，不再调用本函数。
  throw new Error('旧只读工具没有会话令牌；请使用带会话令牌的 v2 读工具');
}

// 旧只读工具（qq_status 之外的 qq_list_groups / qq_get_group_members / qq_get_group_history）
// 没有会话令牌，因此**只能在封闭 agent（管理员私聊）里使用**。
//
// 这里用「确认是 closed-agent 才放行」的白名单写法，而不是「看到 reserved2 就拒绝」的黑名单写法：
// 桥接的 /api/status 在「带 agent 令牌」时返回的是最小状态对象（不含 mode 字段），
// 用 `status?.mode === 'reserved2'` 判断会得到 undefined ⇒ 黑名单判定为假 ⇒ 旧工具被放行，
// 等于在二代仿真模式下把白名单群名、群成员名单注入模型上下文。
async function legacyReadToolAllowed() {
  const status = await agentApi('/api/status');
  return String(status?.mode ?? '') === 'closed-agent';
}

const server = new McpServer({ name: 'snowluma-safe', version: '0.2.1-r1' });

// ── 工具开关必须在**注册期**生效，而不是只在校验期 ──────────────────────────
//
// 为什么：每个工具的描述 + 参数 schema 都会随 system prompt 在**每一次**请求里重发
// （实测 41 个工具约 8.8k token）。只在校验时 403 的话，被关掉的工具依然占着上下文、
// 依然会让模型看见并调用它（然后拿到一个错误），等于「关了个寂寞」。
//
// 这里用一个注册过滤器统一处理：开关关闭 ⇒ 该工具根本不注册 ⇒ 既省 token 又不给模型误调的机会。
// DSH 在启动时读取工具清单，所以关掉/打开后需要重启 DSH 才会刷新（控制台面板已注明）。
//
// 只列**各模式共用的工具不在其中**：qq_send_group_message / qq_send_private_message / qq_send_message（带 replyToMessageId）
// 同时服务 chat / reserved / closed-agent 模式，用 v2 的开关去决定它们是否注册会误伤其它模式，
// 所以这三个仍然只在调用时由桥接校验。
const TOOL_CONFIG_FLAGS = {
  qq_mark_read: 'markRead',
  qq_set_wake_config: 'setWakeConfig',
  qq_send_voice_text: 'sendVoice',
  qq_recall_message: 'sendMessage',
  qq_send_message: 'sendMessage',
  qq_wait_for_messages: 'waitMessages',
  qq_report_feedback: 'feedback',
  qq_get_group_members: 'getGroupMembers',
  qq_remind: 'memory',
  qq_memory_note: 'memory',
  qq_memory_search: 'memory',
  qq_memory_get: 'memory',
  qq_memory_pin: 'memory',
  qq_memory_append: 'memory',
  qq_memory_query: 'memory',
  qq_memory_remove: 'memory',
  qq_memory_clear: 'memory',
  qq_slang_query: 'slangQuery',
  qq_slang_submit: 'slangSubmit',
  qq_send_voice: 'sendVoice',
  qq_list_voices: 'sendVoice',
  // 下面这些曾经漏登记。漏一个不是"多注册一个工具"那么轻：桥接那边按 `v2ToolEnabled(flag)`
  // 在**调用期**一律 403，而这里不登记就等于"控制台显示已关闭、模型每次请求仍收到它的完整
  // 描述与参数 schema，然后调用它、再拿到 403"——既白烧 token（本文件开头 176 行起就是为省这份
  // token 才改注册期过滤的），又诱导模型误调。`qq_set_sticker_remark` 默认就是 `false`
  // （见 bridge.js 的 socialV2.tools 默认表），所以此前它一直是"默认关闭却仍然可见"。
  qq_send_poke: 'sendPoke',
  qq_get_message_images: 'getImages',
  qq_get_forward_msg: 'getForwardMsg',
  qq_list_stickers: 'listStickers',
  qq_get_sticker_image: 'getStickerImage',
  qq_send_sticker: 'sendSticker',
  qq_collect_sticker: 'collectSticker',
  qq_get_self_image: 'getSelfImage',
  qq_sticker_note: 'stickerNote',
  qq_set_sticker_remark: 'setStickerRemark',
};
const disabledTools = [];
{
  const registerTool = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    const flag = TOOL_CONFIG_FLAGS[name];
    if (flag && cfg.socialV2?.tools?.[flag] === false) {
      disabledTools.push(`${name}(${flag})`);
      return undefined;
    }
    return registerTool(name, ...rest);
  };
}

// ── 长期记忆（P1）：跨会话记住"人"和"事" ──────────────────────────────

server.tool(
  'qq_recall_message',
  '撤回一条**你自己发出去**的消息（说错话、发重复了、语气不对时用）。只能撤回自己的，别人的会失败。messageId 从发送结果或消息详情里拿。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    messageId: z.string().describe('要撤回的消息 id')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi('/api/recall', {
        method: 'POST',
        body: JSON.stringify({ key, messageId }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `撤回失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_voice_text',
  '现场合成语音说一句话（可带情绪）。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    text: z.string().describe('要说的话（60 字内最好听）'),
    emotion: z.enum(['happy', 'sad', 'calm', 'surprised', 'angry', 'melancholy']).optional().describe('情绪（可选）；不传按当前心情自动选。强度默认 0.3，太高会"破音"'),
    alpha: z.number().optional().describe('情绪强度 0~1，默认 0.3；超过 0.5 容易把音色撑崩'),
    voice: z.string().optional().describe('可选：音色名（保留兼容，现在基本不用）')
  },
  async ({ key, token, text, emotion, alpha, voice }) => {
    try {
      const data = await agentApi('/api/voice/say', {
        method: 'POST',
        body: JSON.stringify({ key, text, voice, emotion, alpha }),
        headers: { 'x-agent-token': token },
        // CPU 合成一句要 30~40 秒，agentApi 默认 15s 必然超时（2026-11-04 修）
        timeoutMs: 180000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发语音失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_state',
  '查看/调整她自己的状态。kind=mood(心情) / rest(作息) / profile(对主人的了解) / affinity(好感)；action=get 读取，set/sleep/wake 按 kind 生效。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    kind: z.enum(['mood', 'rest', 'profile', 'affinity']).describe('看哪一种状态'),
    action: z.enum(['get', 'set', 'sleep', 'wake']).optional().describe('默认 get；rest 可以用 sleep/wake'),
    delta: z.number().optional().describe('mood set：变化量，-30~30'),
    dim: z.enum(['happy', 'calm', 'sweet', 'worry', 'sad', 'jealous']).optional().describe('mood set：情绪维度'),
    reason: z.string().optional().describe('mood set：为什么变（一句话）'),
    hours: z.number().optional().describe('rest sleep：睡几个小时（不传=睡到早上）'),
    note: z.string().optional().describe('rest sleep：睡前想留一句什么'),
    field: z.enum(['values', 'preferences', 'boundaries', 'facts']).optional().describe('profile set：记哪一类'),
    text: z.string().optional().describe('profile set：一句话，最多 80 字')
  },
  async ({ key, token, kind, action, delta, dim, reason, hours, note, field, text }) => {
    try {
      const k = encodeURIComponent(key);
      const act = action || 'get';
      const h = { 'x-agent-token': token };
      let data;
      if (kind === 'mood') {
        data = act === 'get'
          ? await agentApi(`/api/mood?key=${k}`, { headers: h })
          : await agentApi('/api/mood/set', { method: 'POST', body: JSON.stringify({ key, delta, dim, reason }), headers: h });
      } else if (kind === 'rest') {
        if (act === 'get') data = await agentApi(`/api/rest?key=${k}`, { headers: h });
        else if (act === 'sleep') data = await agentApi('/api/rest/sleep', { method: 'POST', body: JSON.stringify({ key, hours, note }), headers: h });
        else if (act === 'wake') data = await agentApi('/api/rest/wake', { method: 'POST', body: JSON.stringify({ key }), headers: h });
        else throw new Error('rest 只支持 get/sleep/wake');
      } else if (kind === 'profile') {
        data = act === 'get'
          ? await agentApi(`/api/profile?key=${k}`, { headers: h })
          : await agentApi('/api/profile', { method: 'POST', body: JSON.stringify({ key, add: true, kind: field, text }), headers: h });
      } else if (kind === 'affinity') {
        data = await agentApi(`/api/affinity?key=${k}`, { headers: h });
      } else {
        throw new Error('未知 kind：' + kind);
      }
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `状态操作失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_done',
  '把一条提醒/问题标记为已完成（不再重复叫你）。kind=reminder 或 question。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    kind: z.enum(['reminder', 'question']).describe('要标记的类型'),
    id: z.string().describe('记忆编号，例如 ev-00042')
  },
  async ({ key, token, id }) => {
    try {
      const data = await agentApi('/api/memory/fire', { method: 'POST', body: JSON.stringify({ key, id }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `标记失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_style',
  '看或设置默认画风（画图时自动带上）。不传 style = 查看；传了 = 设置；传空字符串 = 清除。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    style: z.string().optional().describe('画风描述，例如"日系厚涂、暖色调"')
  },
  async ({ style }) => {
    try {
      if (style === undefined) return { content: [{ type: 'text', text: getStyle() || '（还没设默认画风）' }] };
      const d = readGenState();
      d.style = String(style || '').slice(0, 120);
      writeGenState(d);
      return { content: [{ type: 'text', text: d.style ? `默认画风已设为：${d.style}` : '默认画风已清除' }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_wallet',
  '看零花钱或记账。action=get 查看；credit 记一笔收入；spend 记一笔支出。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    action: z.enum(['get', 'credit', 'spend']).describe('要看还是记账'),
    amount: z.number().optional().describe('金额，0.01~1000'),
    note: z.string().optional().describe('这一笔是干嘛的'),
    limit: z.number().optional().describe('get：看最近几笔，默认 5')
  },
  async ({ key, token, action, amount, note, limit }) => {
    try {
      const h = { 'x-agent-token': token };
      let data;
      if (action === 'get') {
        const qs = new URLSearchParams({ key, limit: String(limit || 5) });
        data = await agentApi(`/api/wallet?${qs.toString()}`, { headers: h });
      } else {
        data = await agentApi(`/api/wallet/${action}`, { method: 'POST', body: JSON.stringify({ key, amount, note }), headers: h });
      }
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `钱包操作失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_remind',
  '给主人设一个**定时提醒**（可以指定时间）。到点你会被叫醒，然后用 qq_send_message 提醒他。适合"明天 2 点面试""晚上 9 点吃药"这类。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    text: z.string().describe('提醒什么事（一句话，会存成一条长期记忆）'),
    dueAt: z.string().describe('什么时候提醒，ISO 时间且带时区，例如 2026-11-05T14:00:00+08:00'),
    tags: z.array(z.string()).optional().describe('几个关键词')
  },
  async ({ key, token, text, dueAt, tags }) => {
    try {
      const ts = Date.parse(String(dueAt));
      if (!Number.isFinite(ts)) {
        return { content: [{ type: 'text', text: '时间格式不对，要 ISO 带时区，例如 2026-11-05T14:00:00+08:00' }], isError: true };
      }
      const data = await agentApi('/api/memory/note', {
        method: 'POST',
        body: JSON.stringify({ key, text, kind: 'event', tags: (tags || []).concat(['提醒']), priority: 70, dueAt: ts }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData({ ...data, dueAtLocal: new Date(ts).toLocaleString('zh-CN', { hour12: false }) }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设提醒失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_image_edit',
  '以图生图：参考图来自消息(messageId)/本地文件(file)/上一张(last)，可带画风。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    prompt: z.string().describe('要怎么改，具体一点，例如"改成水彩风格，背景换成星空"'),
    messageId: z.string().optional().describe('参考图所在的消息 id（三选一）'),
    file: z.string().optional().describe('本地参考图绝对路径（三选一）'),
    last: z.boolean().optional().describe('true = 用你上一次生成的那张图当参考（三选一）'),
    style: z.string().optional().describe('画风，会拼在 prompt 前面；不传就用默认画风'),
    size: z.number().optional().describe('输出尺寸，默认 512')
  },
  async ({ key, token, prompt, messageId, file, last, style, size }) => {
    try {
      if (cfg.socialV2?.tools?.imageEdit === false) throw new Error('工具未启用：qq_image_edit');
      const m = /^(group|private):(\d+)$/.exec(String(key));
      if (!m) throw new Error('key 格式不对');
      const isGroup = m[1] === 'group';
      const convId = m[2];

      // 频率限制：与表情包共用（同一会话 90 秒 1 张、每天 10 张）
      const hist = STICKER_RATE.get(key) || [];
      const now = Date.now();
      while (hist.length && now - hist[0] > 86400000) hist.shift();
      if (hist.length && now - hist[hist.length - 1] < 90000) throw new Error('太频繁了：同一会话 90 秒一张');
      if (hist.length >= 10) throw new Error('今天这个会话已经画满 10 张了');

      // 1) 收集参考图（最多 2 张）
      const dir = stickerOutDir();
      await fs.promises.mkdir(dir, { recursive: true });
      const stamp = `${now}-${Math.random().toString(16).slice(2, 6)}`;
      const refs = [];
      if (messageId) {
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        const data = await agentApi(`/api/images/message?${q.toString()}`, { headers: { 'x-agent-token': token } });
        const img = (data.images || []).find((x) => x && (x.kind === 'image' || x.kind === 'sticker') && x.data);
        if (!img) throw new Error('这条消息里没有可用的图片');
        const p1 = path.join(dir, `ref-${stamp}-1.png`);
        await fs.promises.writeFile(p1, Buffer.from(img.data, 'base64'));
        refs.push(p1);
      }
      if (file) {
        if (!fs.existsSync(file) || !isImageFile(file)) throw new Error('本地参考图不存在或不是图片：' + file);
        refs.push(file);
      }
      if (last) {
        const lp = getLastImage(key);
        if (!lp || !fs.existsSync(lp)) throw new Error('还没有你生成过的图');
        refs.push(lp);
      }
      if (!refs.length) throw new Error('至少给一个参考图：messageId / file / last 三选一');
      if (refs.length > 2) refs.length = 2;

      // 2) 拼画风
      const styleText = String(style || getStyle() || '').trim();
      const finalPrompt = styleText && !String(prompt).includes(styleText) ? `${styleText}，${prompt}` : String(prompt);

      // 3) 调 gen-cli（失败重试一次）
      const out = path.join(dir, `edit-${stamp}.png`);
      const { spawn } = await import('node:child_process');
      const runOnce = () => new Promise((resolve) => {
        const args = [STICKER_GEN, '--prompt', finalPrompt, '--out', out, '--size', String(Math.max(256, Math.min(1024, Number(size) || 512)))];
        for (const r of refs) args.push('--image', r);
        const child = spawn(process.execPath, args, { windowsHide: true });
        const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(-1); }, 300000);
        child.on('close', (c) => { clearTimeout(timer); resolve(c); });
        child.on('error', () => { clearTimeout(timer); resolve(-1); });
      });
      let code = await runOnce();
      if (code !== 0 || !fs.existsSync(out)) { await new Promise((r) => setTimeout(r, 1500)); code = await runOnce(); }
      if (code !== 0 || !fs.existsSync(out)) throw new Error('生成失败（gen-cli 退出码 ' + code + '）');

      const bytes = await fs.promises.readFile(out);
      if (bytes.length > 4 * 1024 * 1024) throw new Error('图太大，发不出去');
      const seg = { type: 'image', data: { file: 'base64://' + bytes.toString('base64') } };
      await onebot(isGroup ? 'send_group_msg' : 'send_private_msg', isGroup
        ? { group_id: Number(convId), message: [seg] }
        : { user_id: Number(convId), message: [seg] });

      noteLastImage(key, out);
      hist.push(now);
      STICKER_RATE.set(key, hist);
      return { content: [{ type: 'text', text: `已生成并发出（参考图 ${refs.length} 张，${Math.round(bytes.length / 1024)}KB）` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `以图生图失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_image',
  '把电脑上的一张图片发到当前会话（本地绝对路径，png/jpg/webp/gif，≤4MB）。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    file: z.string().describe('图片绝对路径')
  },
  async ({ key, token, file }) => {
    try {
      const m = /^(group|private):(\d+)$/.exec(String(key));
      if (!m) throw new Error('key 格式不对');
      if (!file || !fs.existsSync(file) || !isImageFile(file)) throw new Error('不是可用的图片文件：' + file);
      const bytes = await fs.promises.readFile(file);
      if (bytes.length > 4 * 1024 * 1024) throw new Error('图太大（>4MB）');
      const seg = { type: 'image', data: { file: 'base64://' + bytes.toString('base64') } };
      const isGroup = m[1] === 'group';
      await onebot(isGroup ? 'send_group_msg' : 'send_private_msg', isGroup
        ? { group_id: Number(m[2]), message: [seg] }
        : { user_id: Number(m[2]), message: [seg] });
      return { content: [{ type: 'text', text: `已发送图片（${Math.round(bytes.length / 1024)}KB）` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发图失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_file',
  '把电脑上的文件发到当前会话（本地绝对路径，≤50MB）。群聊发到群文件，私聊直接发文件。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    file: z.string().describe('文件绝对路径'),
    name: z.string().optional().describe('显示的文件名（默认用原文件名）')
  },
  async ({ key, token, file, name }) => {
    try {
      const m = /^(group|private):(\d+)$/.exec(String(key));
      if (!m) throw new Error('key 格式不对');
      if (!file || !fs.existsSync(file)) throw new Error('文件不存在：' + file);
      const st = await fs.promises.stat(file);
      if (!st.isFile()) throw new Error('不是文件：' + file);
      if (st.size > 50 * 1024 * 1024) throw new Error('文件太大（>50MB）');
      const display = String(name || path.basename(file)).slice(0, 100);
      const isGroup = m[1] === 'group';
      await onebot(isGroup ? 'upload_group_file' : 'upload_private_file', isGroup
        ? { group_id: Number(m[2]), file, name: display }
        : { user_id: Number(m[2]), file, name: display });
      return { content: [{ type: 'text', text: `已发送文件：${display}（${(st.size / 1024).toFixed(0)}KB）` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发文件失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 群主权限（2026-11-05）：只在 cfg.socialV2.ownerGroups 里的群生效 ─────────
function ownerGroupOf(key) {
  const m = /^group:(\d+)$/.exec(String(key || ''));
  if (!m) return null;
  const gid = Number(m[1]);
  const list = (cfg.socialV2?.ownerGroups ?? []).map(Number);
  return list.includes(gid) ? gid : null;
}
function requireOwnerGroup(key) {
  const gid = ownerGroupOf(key);
  if (!gid) throw new Error('这个群不在「她是群主」的名单里，不能用群主操作');
  return gid;
}
const SELF_ID = Number(cfg.selfQQ || cfg.selfId || 0) || null;

server.tool(
  'qq_group_ban',
  '禁言群成员（只有她是群主的群可用）。minutes=0 表示解禁。',
  {
    key: z.string().describe('群会话 key，格式 group:群号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    userId: z.union([z.number(), z.string()]).describe('要禁言的群友 QQ 号'),
    minutes: z.number().describe('禁言多少分钟；0 = 解除禁言')
  },
  async ({ key, userId, minutes }) => {
    try {
      const gid = requireOwnerGroup(key);
      const uid = Number(userId);
      if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('QQ 号不对');
      if (String(uid) === String(cfg.ownerQQ)) throw new Error('不能禁言主人');
      const duration = Math.max(0, Math.min(43200, Math.floor(Number(minutes) || 0))) * 60;
      await onebot('set_group_ban', { group_id: gid, user_id: uid, duration });
      return { content: [{ type: 'text', text: duration ? `已禁言 ${uid} ${duration / 60} 分钟` : `已解除 ${uid} 的禁言` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `禁言失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_group_kick',
  '踢出群成员（只有她是群主的群可用）。',
  {
    key: z.string().describe('群会话 key，格式 group:群号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    userId: z.union([z.number(), z.string()]).describe('要踢的群友 QQ 号')
  },
  async ({ key, userId }) => {
    try {
      const gid = requireOwnerGroup(key);
      const uid = Number(userId);
      if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('QQ 号不对');
      if (String(uid) === String(cfg.ownerQQ)) throw new Error('不能踢主人');
      await onebot('set_group_kick', { group_id: gid, user_id: uid, reject_add_request: false });
      return { content: [{ type: 'text', text: `已移出群：${uid}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `踢人失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_group_card',
  '改群成员的群名片（只有她是群主的群可用）。card 传空字符串表示清空名片。',
  {
    key: z.string().describe('群会话 key，格式 group:群号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    userId: z.union([z.number(), z.string()]).describe('群友 QQ 号'),
    card: z.string().describe('新名片（最多 30 字，空串 = 清空）')
  },
  async ({ key, userId, card }) => {
    try {
      const gid = requireOwnerGroup(key);
      const uid = Number(userId);
      const text = String(card || '').slice(0, 30);
      await onebot('set_group_card', { group_id: gid, user_id: uid, card: text });
      return { content: [{ type: 'text', text: text ? `已把 ${uid} 的名片改成「${text}」` : `已清空 ${uid} 的名片` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `改名失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_group_notice',
  '发群公告（只有她是群主的群可用）。',
  {
    key: z.string().describe('群会话 key，格式 group:群号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    content: z.string().describe('公告正文（最多 500 字）'),
    pinned: z.boolean().optional().describe('是否置顶，默认 false')
  },
  async ({ key, content, pinned }) => {
    try {
      const gid = requireOwnerGroup(key);
      const text = String(content || '').slice(0, 500);
      if (!text) throw new Error('公告不能为空');
      await onebot('_send_group_notice', { group_id: gid, content: text, pinned: pinned === true });
      return { content: [{ type: 'text', text: '公告已发' }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发公告失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_group_recall',
  '撤回群里的某条消息（只有她是群主的群可用）。',
  {
    key: z.string().describe('群会话 key，格式 group:群号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    messageId: z.union([z.number(), z.string()]).describe('要撤回的消息 id')
  },
  async ({ key, messageId }) => {
    try {
      requireOwnerGroup(key);
      await onebot('delete_msg', { message_id: messageId });
      return { content: [{ type: 'text', text: `已撤回消息 ${messageId}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `撤回失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 零花钱（虚拟账本，2026-11-03）────────────────────────────────────

server.tool(
  'qq_memory_note',
  '记长期记忆（事件/事实/自我认知/印象），尽量一条只记一件事。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    text: z.string().describe('记忆正文，一句话说清：谁、什么时候、发生了什么'),
    kind: z.enum(['event', 'fact', 'selfnote', 'impression']).optional().describe('记忆类型，默认 event'),
    tags: z.array(z.string()).optional().describe('几个关键词，方便以后被检索到'),
    priority: z.number().optional().describe('重要度 1-100，默认 55；很重要（约定、她特别在意的事）给 80 以上'),
    meaning: z.string().optional().describe('这条记忆「意味着什么 / 什么场景用得上」（≤160 字）。写一句，以后检索时先看这句，不用翻全文'),
    evidenceMessageId: z.string().optional().describe('如果是聊天里的事，填那条消息的 messageId，方便以后回查原文')
  },
  async ({ key, token, text, kind, tags, priority, meaning, evidenceMessageId }) => {
    try {
      const evidence = evidenceMessageId ? { type: 'chat', messageId: String(evidenceMessageId), at: new Date().toISOString() } : null;
      const data = await agentApi('/api/memory/note', {
        method: 'POST',
        body: JSON.stringify({ key, text, kind: kind || 'event', tags: tags || [], priority, meaning: meaning || null, evidence }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记录失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_search',
  '在长期记忆里按关键词找。返回的是**摘要层**（title / summary / meaning），不是全文——先看 summary 和 meaning 判断有没有用，真需要细节再用 qq_memory_get 看原文。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    query: z.string().describe('想找什么，几个关键词就行'),
    limit: z.number().optional().describe('最多返回几条，默认 8')
  },
  async ({ key, token, query, limit }) => {
    try {
      const qs = new URLSearchParams({ key, q: query, limit: String(limit || 8) });
      const data = await agentApi(`/api/memory/search?${qs.toString()}`, {
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `检索失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_get',
  '按编号取一条长期记忆的**原文**（连同证据）。只有摘要不够用时才调它——取过一次之后这条记忆会变"热"，以后更容易被想起来。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    id: z.string().describe('记忆编号，例如 ev-00012')
  },
  async ({ key, token, id }) => {
    try {
      const qs = new URLSearchParams({ id });
      const data = await agentApi(`/api/memory/get?${qs.toString()}`, {
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_pin',
  '把一条记忆钉住：永远不会因为时间久了而淡忘。适合约定、纪念日、对方明确说过很重要的事。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    id: z.string().describe('记忆编号')
  },
  async ({ key, token, id }) => {
    try {
      const data = await agentApi('/api/memory/pin', {
        method: 'POST',
        body: JSON.stringify({ id }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `置顶失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_status',
  '查询 QQ 机器人登录状态与账号信息（只读）。',
  {},
  async () => {
    try {
      const login = await onebot('get_login_info');
      let status = {};
      try { status = await onebot('get_status'); } catch {}
      return { content: [{ type: 'text', text: serializeModelData({ ...login, online: status.online, good: status.good }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 旧只读工具：**按启动时的桥接模式决定是否注册** ─────────────────────────
//
// 为什么必须在注册期就砍掉（而不是只在调用期 403）：
//   每个工具的描述 + 参数 schema 都随 system prompt 在**每一次**请求里重发。
//   实测一份 reserved2 会话的请求头是「58 个工具 / 45.5 KB schema（≈14k token/次）」，
//   其中 3 个旧只读工具在 reserved2 下**必然**返回 403，却照样占着 2500+ 字节；
//   更要命的是它们会诱导模型误调（实测 turn10 有一次 qq_get_group_members → 403，白烧一步）。
//   本文件开头（TOOL_CONFIG_FLAGS 那段）已经为「关掉的工具」立过同样的规矩，这里补齐模式维度。
//
// 语义：旧只读工具没有会话令牌，`legacyReadToolAllowed()` 只放行 closed-agent。
//   所以只有在 closed-agent 下注册它们才有意义。探测失败（读不到状态文件）时按「注册」处理：
//   那种情况下所有 QQ 工具都不可用，少注册只会让模型看到更少的失败路径，不必激进。
//
// ⚠️ 为什么读 `state/mode.json` 而**不**去问 `/api/status`：
//   注册发生在模块加载期，走网络就得用 top-level await；而本文件会被若干离线回归
//   （test-audit-security-mcp.mjs）用 `vm`/`new Function` 求值，那里没有 TLA —— 会直接
//   `ReferenceError: await is not defined`，把整批断言打红。模式文件是桥接每次切换模式时
//   原子写出的（bridge.js 的 writeMode），与 `/api/status` 同源，读盘既准确又是同步的。
const bootBridgeMode = (() => {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'state', 'mode.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return String(parsed?.mode ?? '').trim();
  } catch { return ''; }
})();
const registerLegacyReadTools = bootBridgeMode === '' || bootBridgeMode === 'closed-agent';
if (!registerLegacyReadTools) {
  console.error(`[snowluma-safe] 当前桥接模式 ${bootBridgeMode}：不注册旧只读工具（qq_list_groups / qq_get_group_history），改用带令牌的 v2 读工具`);
}

if (registerLegacyReadTools) {
server.tool(
  'qq_list_groups',
  '列出机器人所在的全部 QQ 群（只读）：群号、群名。',
  {},
  async () => {
    // 旧只读工具没有 agent token：只允许在封闭 agent（管理员私聊）里使用。
    // 判定失败一律拒绝（fail-closed），不依赖「看到某个模式才拒绝」的黑名单写法。
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝执行：${error?.message ?? error}` }], isError: true };
    }
    try {
      const a = getAccess();
      const data = await onebot('get_group_list');
      const list = (Array.isArray(data) ? data : (data?.data ?? []))
          .filter((g) => isAllowed(a.allowGroups, a.denyGroups, g.group_id, a.allowAllWhenEmpty))
          .map((g) => ({ group_id: g.group_id, group_name: g.group_name }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);
}

// 群成员列表：**换成 v2 形态**（key + token）。
//
// 为什么不再沿用旧的无令牌版本：它是 qq-chat-v2 预设里唯一被点名的"拿 QQ 号"的途径
// （见 dsh/agent-presets/qq-chat-v2/agent.cordis.yml 第 6 条），但旧版在 reserved2 下必然 403
// —— 预设教模型用一个永远失败的工具，等于每次都白烧一步。改成 v2 后同一个名字在两种模式下都成立。
server.tool(
  'qq_get_group_members',
  '列出指定群的成员（只读）：QQ 号、昵称、群名片。等特定的人、要 @ 某个人、或需要确认谁在群里时用；QQ 号取返回里的 userId。只返回白名单群，且只读取桥接允许的会话。',
  {
    key: z.string().describe('会话 key，格式 group:群号'),
    token: z.string().optional().describe('唤醒提示里的【会话令牌】'),
    limit: z.number().optional().describe('最多返回多少成员，默认 50，最大 100')
  },
  async ({ key, token, limit }) => {
    try {
      const q = new URLSearchParams({ key });
      if (limit != null) q.set('limit', String(limit));
      // token 可选：closed-agent（管理员私聊）里代理没有会话令牌，走的是操作者路径；
      // 桥接那边的白名单/模式判定对**这条**请求同样生效（不依赖 header 是否存在）。
      const data = await agentApi(`/api/socialV2/group-members?${q.toString()}`, token ? { headers: { 'x-agent-token': token } } : {});
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取群成员失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (registerLegacyReadTools) {
server.tool(
  'qq_get_group_history',
  '获取指定群的最近消息历史（只读）。messageSeq 可选：从该消息序号往前取。注意：是否可用取决于 SnowLuma 是否实现 get_group_msg_history。',
  { groupId: z.union([z.number(), z.string()]).describe('群号'), messageSeq: z.number().optional().describe('起始消息序号（可选）') },
  async ({ groupId, messageSeq }) => {
    const g = String(groupId);
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    try {
      const params = { group_id: Number(g) };
      if (messageSeq !== undefined) params.message_seq = messageSeq;
      const data = await onebot('get_group_msg_history', params);
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);
}

server.tool(
  'qq_get',
  '读取 QQ 侧信息。what 决定读什么：unread=未读、recent=最近、detail=单条详情、my_recent=我最近发的、active=活跃成员、state=会话状态、prompt=当前提示词。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    what: z.enum(['unread', 'recent', 'detail', 'my_recent', 'active', 'state', 'prompt']).describe('要读什么'),
    limit: z.number().optional().describe('返回条数/人数上限'),
    offset: z.number().optional().describe('recent 用：跳过最近 N 条'),
    afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('unread 用：从该水位之后补读'),
    messageId: z.union([z.number(), z.string()]).optional().describe('detail 用：消息 id')
  },
  async ({ key, token, what, limit, offset, afterSeq, messageId }) => {
    try {
      const k = encodeURIComponent(key);
      let path;
      if (what === 'unread') path = `/api/socialV2/unread?key=${k}&limit=${limit ?? 30}${afterSeq === undefined ? '' : `&afterSeq=${afterSeq}`}`;
      else if (what === 'recent') path = `/api/socialV2/recent?key=${k}&limit=${limit ?? 20}&offset=${offset ?? 0}`;
      else if (what === 'detail') {
        if (messageId === undefined || messageId === null) throw new Error('detail 需要 messageId');
        path = `/api/socialV2/message-detail?key=${k}&messageId=${encodeURIComponent(String(messageId))}`;
      }
      else if (what === 'my_recent') path = `/api/socialV2/my-recent?key=${k}&limit=${limit ?? 10}`;
      else if (what === 'active') path = `/api/socialV2/active-members?key=${k}&limit=${limit ?? 10}`;
      else if (what === 'state') path = `/api/socialV2/state?key=${k}`;
      else if (what === 'prompt') path = `/api/socialV2/prompt?key=${k}`;
      else throw new Error('未知 what：' + what);
      const data = await agentApi(path, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_mark_read',
  '将指定会话已查看的未读消息标记为已读。throughSeq 使用最近读取结果的 readThroughSeq，避免清除读取后才到达的新消息；省略 throughSeq 会按旧行为清空当前全部未读，因此推荐始终带上水位。注意：每次设置潜水/下一次唤醒前，桥接要求先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可 mark_read 收尾沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与也可直接 mark_read 收尾；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('本次确认已读的消息水位，使用已查看结果中的 readThroughSeq；不会清除更晚到达的消息')
  },
  async ({ key, token, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/mark-read', { method: 'POST', body: JSON.stringify({ key, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `标记已读失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_wake_config',
  '设置下次唤醒（潜水/活跃/触发条件）；不传 throughSeq 时自动标记已读。收尾优先用它。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('可选：同时确认已读的水位（用 readThroughSeq）'),
    config: z.object({
      mode: z.enum(['diving', 'active']).optional().describe('diving=潜水，active=活跃（anyMessage 开启）'),
      infinite: z.boolean().optional().describe('true=无限期，只有条件命中才唤醒；false=有限时间'),
      sleepMs: z.number().optional().describe('有限潜水毫秒数（从当前时间起算）'),
      sleepUntil: z.string().optional().describe('有限潜水截止时间 ISO 字符串，优先级高于 sleepMs'),
      triggers: z.object({
        atMention: z.boolean().optional().describe('被 @ 或引用自己时唤醒'),
        nameMention: z.boolean().optional().describe('被叫名字/昵称时唤醒'),
        speakerIds: z.array(z.union([z.number(), z.string()])).max(20).optional().describe('指定群友 QQ 号数组（最多 20 个）：其中任意一位发言时唤醒'),
        keywords: z.array(z.string()).optional().describe('出现任意关键词时唤醒'),
        question: z.boolean().optional().describe('被直接提问/点名挑战时唤醒'),
        poke: z.boolean().optional().describe('有人拍一拍时唤醒（群聊包括拍你和拍别人，私聊为对方拍你）'),
        anyMessage: z.boolean().optional().describe('任意新消息都唤醒（活跃模式）'),
        probability: z.number().optional().describe('普通消息按该概率随机唤醒（0~1）')
      }).optional(),
      batchWindowMs: z.number().optional().describe('多条消息合并唤醒窗口（毫秒，>=1000）')
    }).describe('要设置的唤醒配置，缺省字段保留原值')
  },
  async ({ key, token, config, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/wake-config', { method: 'POST', body: JSON.stringify({ key, config, throughSeq, autoMarkRead: throughSeq == null }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置唤醒配置失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_message',
  '发消息到会话（字符串=一条，数组=多条，可引用）。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).describe('要发送的内容：字符串=一条；数组=分多条'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中用于点名某个人；与引用二选一即可，不要滥用）'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto=桥接随机；fixed=固定间隔；byLength=按字数计算'),
    gapMs: z.number().optional().describe('fixed 模式下的统一间隔（毫秒）'),
    gaps: z.array(z.number()).optional().describe('fixed 模式下逐条间隔（长度=条数-1）')
  },
  async ({ key, token, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps }) => {
    try {
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-message', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (cfg.socialV2?.tools?.sendPoke !== false) {
  server.tool(
    'qq_send_poke',
    '发送 QQ 拍一拍（群聊/私聊）。适合用“戳一下”代替一句废话、提醒对方、自然回应别人的拍一拍，或偶尔主动戳一下正在聊的人/熟人——这样更拟真；但别频繁，真人不会一直戳人。群聊必须传 targetUserId（要拍的群友 QQ 号，可从 qq_get(what="active") / qq_get(what="detail") 的 userId 获取）；私聊可不传 targetUserId（默认拍当前私聊对象）。reserved2 下必须携带会话令牌 token，发送会受桥接白名单与发送频率限制。',
    {
      key: z.string().describe('group:群号 或 private:QQ号'),
      token: z.string().describe('唤醒提示里的【会话令牌】'),
      targetUserId: z.union([z.number(), z.string()]).optional().describe('要拍的群友 QQ 号（群聊必填；私聊可选）')
    },
    async ({ key, token, targetUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-poke', {
          method: 'POST',
          body: JSON.stringify({ key, targetUserId: targetUserId != null ? String(targetUserId) : '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `拍一拍失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

server.tool(
  'qq_wait_for_messages',
  '等消息：purpose=reply 做回复前短静默；默认做沉睡前观察（timeoutMs=300000）。返回里有 canSleepNow/hint，照它做。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    purpose: z.enum(['messages', 'reply']).optional().describe('默认 messages：等新消息/回复/睡前观察；reply：回复前短静默，计入最后来信后已过去的时间，绝不授予睡前观察资格'),
    timeoutMs: z.number().optional().describe('等待预算毫秒数，默认 30000、最大 600000；reply 达到静默即返回，不必等满；沉睡前观察用 messages 并传 300000'),
    minNewMessages: z.number().optional().describe('仅 messages 用途：至少等到多少条新消息才进入静默窗口，默认 1；reply 用途会忽略它'),
    quietMs: z.number().optional().describe('静默窗口毫秒数，建议 10000~12000；reply 从最后来信开始计时，messages 只在等到新消息后计时；后台默认至少 10000')
  },
  async ({ key, token, purpose, timeoutMs, minNewMessages, quietMs }) => {
    try {
      // 必须走长轮询通道：全局 fetch（undici）有 300s headersTimeout，
      // 而沉睡前观察的预算就是 300s（见 agentApiLongPoll 的说明）。
      const data = await agentApiLongPoll('/api/socialV2/wait', {
        method: 'POST',
        body: JSON.stringify({ key, purpose, timeoutMs, minNewMessages, quietMs }),
        headers: { 'x-agent-token': token },
        timeoutMs: Math.min(725000, (Number(timeoutMs) || 30000) + Math.max(Number(quietMs) || 0, 10000) + 20000)
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `等待失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_report_feedback',
  '向控制台/管理端反馈 AI 遇到的问题、困惑或需要管理员介入的情况。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    level: z.enum(['info', 'warning', 'error']).optional().describe('反馈级别，默认 info'),
    message: z.string().describe('反馈内容')
  },
  async ({ key, token, level, message }) => {
    try {
      const data = await agentApi('/api/socialV2/feedback', {
        method: 'POST',
        body: JSON.stringify({ key, level, message }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `反馈失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_append',
  '记轻量记忆（话题/念头/印象），会过期。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().describe('记忆内容，例如话题、想说的话、对某人的印象标签'),
    extra: z.object({
      target: z.string().optional().describe('memberImpression 时的群友名字/昵称'),
      participants: z.array(z.string()).optional().describe('activeTopic 的参与者列表'),
      pendingQuestion: z.string().optional().describe('activeTopic 里还没问出口的问题'),
      motivation: z.string().optional().describe('pendingThought 的动机，如 curiosity/sociability'),
      expiresAtMs: z.number().optional().describe('pendingThought 过期毫秒数，默认 2 小时')
    }).optional().describe('附加信息')
  },
  async ({ key, token, category, content, extra }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-append', {
        method: 'POST',
        body: JSON.stringify({ key, category, content, extra: extra || {} }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆写入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_query',
  '查看当前会话的轻量记忆：进行中的话题、你想说但还没说的话、对群友的印象（只读）。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('可选：只看某一类记忆')
  },
  async ({ key, token, category }) => {
    try {
      const q = new URLSearchParams({ key });
      if (category) q.set('category', category);
      const data = await agentApi(`/api/socialV2/memory?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_remove',
  '删除一条轻量记忆：activeTopic/pendingThought 用 content 匹配原文删除；memberImpression 用 target 参数指定群友名字删除。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().optional().describe('要删除的话题/想法原文（memberImpression 不需要）'),
    target: z.string().optional().describe('memberImpression 时要删除的群友名字')
  },
  async ({ key, token, category, content, target }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-remove', {
        method: 'POST',
        body: JSON.stringify({ key, category, content: content || '', target: target || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆删除失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_clear',
  '清空轻量记忆：不传 category 清空全部；传 activeTopic/pendingThought/memberImpression 只清空对应类别。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('要清空的类别，缺省清空全部')
  },
  async ({ key, token, category }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-clear', {
        method: 'POST',
        body: JSON.stringify({ key, category: category || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆清空失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_query',
  '查看当前已确认的群聊黑话/梗/网络表达（只读）。返回已确认词条列表和格式化黑话表；遇到不熟悉的词可先查这里，再决定是否搜索/使用。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().min(1).describe('唤醒提示里的【会话令牌】'),
    q: z.string().optional().describe('可选搜索词，按词条/含义/用法/示例过滤')
  },
  async ({ key, token, q }) => {
    try {
      const query = q ? `&q=${encodeURIComponent(String(q))}` : '';
      const data = await agentApi(`/api/socialV2/slang/query?key=${encodeURIComponent(key)}${query}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_submit',
  '把你在群里经常看到但不确定含义/用法的陌生词、黑话、梗或网络表达提交给管理员筛选。提交后进入候选库，管理员确认后会被写入黑话提示词，成为你后续可查询和使用的记忆。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('唤醒提示里的【会话令牌】'),
    content: z.string().describe('要提交的陌生词/黑话/梗（最多 50 字）'),
    context: z.string().optional().describe('可选：你是在什么语境/哪条消息里看到的，帮助管理员判断')
  },
  async ({ key, token, content, context }) => {
    try {
      const data = await agentApi('/api/socialV2/slang/submit', {
        method: 'POST',
        body: JSON.stringify({ key, content, context: context || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `提交黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 图片/表情查看工具（一代/二代仿真共用） ─────────────────────────────────
if (cfg.socialV2?.tools?.getImages !== false) {
  server.tool(
    'qq_get_message_images',
    '获取指定 QQ 消息中的图片/表情，并直接以图像内容返回给模型（视觉模型可“看懂”）。当消息文本里出现 [图片]、[表情] 或 hasMedia=true 时调用。支持一条消息里的多张图片/表情；二代模式下必须携带会话令牌。**视频会被抽成 6 帧拼图（一张图里按 3×2 排）再给你，说明里会写「视频 X 秒，抽 N 帧拼图」；动图（GIF/动态表情）会被桥接抽帧拼成多格图再给你**：说明里会写「动图 N 帧/…s，已抽 X 帧拼成 A×B 网格，行优先 左上→右下」——按格子顺序理解动作即可，不要把它当成一张九宫格照片；没有这类说明就是静态图。体积过大的图会被自动缩放/重编码，说明里会给出原始尺寸与体积；如果真的压不到可用体积，返回里会直接写明原因（例如「超过上限」），此时如实告诉对方你看不到，不要编造画面。',
    {
      key: z.string().describe('group:群号 或 private:QQ号'),
      messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
      token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）')
    },
    async ({ key, messageId, token }) => {
      try {
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        const data = await agentApi(`/api/images/message?${q.toString()}`, {
          headers: token ? { 'x-agent-token': token } : {},
          timeoutMs: 180000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        if (!images.length) {
          return { content: [{ type: 'text', text: `消息 ${messageId} 没有可返回的图片/表情：${data?.note || '未找到'}` }] };
        }
        const content = [];
        const textParts = [];
        for (const img of images) {
          if (img?.data && img?.mimeType) {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`);
            content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
          } else {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : '（获取失败）'}]`);
          }
        }
        if (textParts.length) {
          content.unshift({ type: 'text', text: `消息 ${messageId} 的媒体内容（${images.length} 项）：\n${textParts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 头像：让她自己决定换什么 ────────────────────────────────────────────────
// 三条路：外部图（URL/本地路径）、群里某条消息里的图、或者自己画一张。
// 换头像是账号资料变更，属于"她自己想换就换"的事，这里不做风格审查。

function _avatarCrcTable() {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}
const AVATAR_CRC = _avatarCrcTable();

function _pngEncode(width, height, rgba) {
  const crcOf = (buf) => {
    let c = -1;
    for (const b of buf) c = AVATAR_CRC[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const cr = Buffer.alloc(4);
    cr.writeUInt32BE(crcOf(typed));
    return Buffer.concat([len, typed, cr]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function _avatarSeedNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.abs(Math.trunc(v)) || 1;
  const s = String(v ?? '0');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 1;
}

function _mulberry32(a) {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function _drawAvatarBuffer({ seed = 0, palette = [], motif = 'bubbles', size = 640 }) {
  const cols = Array.isArray(palette) && palette.length >= 2 ? palette : ['#0e2036', '#1c6d7a', '#ffc65c'];
  const hex = (h) => {
    const s = String(h).replace('#', '');
    const n = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s, 16);
    return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [200, 200, 200];
  };
  const pal = cols.map(hex);
  const c0 = pal[0];
  const c1 = pal[1];
  const c2 = pal[2] ?? pal[1];
  const c3 = pal[3] ?? c2;
  const rnd = _mulberry32(_avatarSeedNum(seed));
  const rgba = Buffer.alloc(size * size * 4);
  const lighten = (c, k) => c.map((v) => Math.min(255, Math.round(v + (255 - v) * k)));
  const darken = (c, k) => c.map((v) => Math.round(v * (1 - k)));

  const put = (x, y, col, a) => {
    if (a <= 0 || x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const k = a > 1 ? 1 : a;
    rgba[i] = Math.round(rgba[i] * (1 - k) + col[0] * k);
    rgba[i + 1] = Math.round(rgba[i + 1] * (1 - k) + col[1] * k);
    rgba[i + 2] = Math.round(rgba[i + 2] * (1 - k) + col[2] * k);
  };

  // 背景：对角渐变 + 轻微暗角
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = (x / size) * 0.35 + (y / size) * 0.65;
      const i = (y * size + x) * 4;
      const vx = x / size - 0.5;
      const vy = y / size - 0.5;
      const vig = 1 - Math.min(0.35, Math.hypot(vx, vy) * 0.5);
      rgba[i] = Math.round((c0[0] + (c1[0] - c0[0]) * t) * vig);
      rgba[i + 1] = Math.round((c0[1] + (c1[1] - c0[1]) * t) * vig);
      rgba[i + 2] = Math.round((c0[2] + (c1[2] - c0[2]) * t) * vig);
      rgba[i + 3] = 255;
    }
  }

  const disc = (cx, cy, r, col, alpha = 1) => {
    const y0 = Math.max(0, Math.floor(cy - r - 1));
    const y1 = Math.min(size - 1, Math.ceil(cy + r + 1));
    const x0 = Math.max(0, Math.floor(cx - r - 1));
    const x1 = Math.min(size - 1, Math.ceil(cx + r + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        const edge = Math.max(0, Math.min(1, r - d + 0.5));
        if (edge > 0) put(x, y, col, alpha * edge);
      }
    }
  };

  const ring = (cx, cy, r, w, col, alpha = 1) => {
    const y0 = Math.max(0, Math.floor(cy - r - w - 1));
    const y1 = Math.min(size - 1, Math.ceil(cy + r + w + 1));
    const x0 = Math.max(0, Math.floor(cx - r - w - 1));
    const x1 = Math.min(size - 1, Math.ceil(cx + r + w + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        const edge = Math.max(0, Math.min(1, w / 2 + 0.5 - Math.abs(d - r)));
        if (edge > 0) put(x, y, col, alpha * edge);
      }
    }
  };

  const ellipse = (cx, cy, rx, ry, rot, col, alpha = 1) => {
    const cos = Math.cos(-rot);
    const sin = Math.sin(-rot);
    const rr = Math.max(rx, ry);
    const y0 = Math.max(0, Math.floor(cy - rr - 1));
    const y1 = Math.min(size - 1, Math.ceil(cy + rr + 1));
    const x0 = Math.max(0, Math.floor(cx - rr - 1));
    const x1 = Math.min(size - 1, Math.ceil(cx + rr + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const u = dx * cos - dy * sin;
        const v = dx * sin + dy * cos;
        const q = Math.hypot(u / rx, v / ry);
        const edge = Math.max(0, Math.min(1, (1 - q) * Math.min(rx, ry) + 0.5));
        if (edge > 0) put(x, y, col, alpha * edge);
      }
    }
  };

  // 2x2 超采样多边形（够用且代码短）
  const poly = (pts, col, alpha = 1) => {
    if (pts.length < 3) return;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const y1 = Math.min(size - 1, Math.ceil(Math.max(...ys)));
    const x0 = Math.max(0, Math.floor(Math.min(...xs)));
    const x1 = Math.min(size - 1, Math.ceil(Math.max(...xs)));
    const inside = (px, py) => {
      let hit = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i][0];
        const yi = pts[i][1];
        const xj = pts[j][0];
        const yj = pts[j][1];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    };
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        let cov = 0;
        for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
          if (inside(x + ox, y + oy)) cov += 0.25;
        }
        if (cov > 0) put(x, y, col, alpha * cov);
      }
    }
  };

  const line = (x0, y0, x1, y1, w, col, alpha = 1) => {
    const minx = Math.max(0, Math.floor(Math.min(x0, x1) - w));
    const maxx = Math.min(size - 1, Math.ceil(Math.max(x0, x1) + w));
    const miny = Math.max(0, Math.floor(Math.min(y0, y1) - w));
    const maxy = Math.min(size - 1, Math.ceil(Math.max(y0, y1) + w));
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy || 1;
    for (let y = miny; y <= maxy; y++) {
      for (let x = minx; x <= maxx; x++) {
        const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / len2));
        const d = Math.hypot(x - (x0 + dx * t), y - (y0 + dy * t));
        const edge = Math.max(0, Math.min(1, w / 2 + 0.5 - d));
        if (edge > 0) put(x, y, col, alpha * edge);
      }
    }
  };

  const star4 = (cx, cy, r, col, alpha = 1) => {
    poly([
      [cx, cy - r], [cx + r * 0.22, cy - r * 0.22], [cx + r, cy],
      [cx + r * 0.22, cy + r * 0.22], [cx, cy + r],
      [cx - r * 0.22, cy + r * 0.22], [cx - r, cy],
      [cx - r * 0.22, cy - r * 0.22],
    ], col, alpha);
  };

  // 平滑光晕：逐像素按距离平方衰减。早期版本用几层 disc 叠加，边缘会露出一圈圈色带。
  const glow = (cx, cy, r, col, alpha = 0.35) => {
    const R = r * 2.2;
    const y0 = Math.max(0, Math.floor(cy - R));
    const y1 = Math.min(size - 1, Math.ceil(cy + R));
    const x0 = Math.max(0, Math.floor(cx - R));
    const x1 = Math.min(size - 1, Math.ceil(cx + R));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy) / R;
        if (d >= 1) continue;
        const t = 1 - d;
        put(x, y, col, alpha * t * t);
      }
    }
  };

  const horizon = size * (0.62 + rnd() * 0.12);

  switch (motif) {
    case 'stars': {
      for (let i = 0; i < 46; i++) {
        const r = size * (0.002 + rnd() * 0.008);
        disc(rnd() * size, rnd() * horizon, r, lighten(c2, 0.5), 0.35 + rnd() * 0.65);
      }
      const bx = size * (0.2 + rnd() * 0.6);
      const by = size * (0.15 + rnd() * 0.45);
      star4(bx, by, size * 0.075, lighten(c2, 0.7), 0.95);
      star4(bx, by, size * 0.12, lighten(c2, 0.3), 0.25);
      disc(bx, by, size * 0.006, [255, 255, 255], 1);
      break;
    }
    case 'rings': {
      const cx = size * (0.4 + rnd() * 0.2);
      const cy = size * (0.4 + rnd() * 0.2);
      for (let i = 0; i < 7; i++) {
        ring(cx, cy, size * (0.08 + i * 0.055), size * (0.006 + rnd() * 0.01), i % 2 ? c2 : lighten(c1, 0.3), 0.55 - i * 0.05);
      }
      disc(cx, cy, size * 0.05, c2, 0.95);
      break;
    }
    case 'fish': {
      glow(size * 0.5, size * 0.55, size * 0.3, c2, 0.25);
      const cx = size * (0.44 + rnd() * 0.06);
      const cy = size * (0.5 + rnd() * 0.06);
      ellipse(cx, cy, size * 0.27, size * 0.19, 0, c2, 0.98);
      ellipse(cx - size * 0.02, cy + size * 0.05, size * 0.2, size * 0.12, 0, lighten(c2, 0.18), 0.9);
      poly([[cx + size * 0.24, cy - size * 0.13], [cx + size * 0.40, cy - size * 0.02],
        [cx + size * 0.40, cy + size * 0.02], [cx + size * 0.24, cy + size * 0.13]], darken(c2, 0.25), 0.95);
      poly([[cx - size * 0.05, cy - size * 0.16], [cx + size * 0.05, cy - size * 0.30],
        [cx + size * 0.12, cy - size * 0.14]], darken(c2, 0.15), 0.9);
      disc(cx - size * 0.13, cy - size * 0.04, size * 0.045, [255, 255, 255], 1);
      disc(cx - size * 0.12, cy - size * 0.04, size * 0.022, [25, 25, 30], 1);
      disc(cx - size * 0.14, cy - size * 0.05, size * 0.008, [255, 255, 255], 0.9);
      for (let i = 0; i < 5; i++) {
        ring(size * (0.12 + rnd() * 0.22), size * (0.2 + rnd() * 0.5), size * (0.01 + rnd() * 0.02), size * 0.005, lighten(c2, 0.6), 0.5);
      }
      break;
    }
    case 'moon': {
      const cx = size * (0.42 + rnd() * 0.16);
      const cy = size * (0.4 + rnd() * 0.16);
      const r = size * (0.24 + rnd() * 0.06);
      glow(cx, cy, r, lighten(c2, 0.4), 0.3);
      disc(cx, cy, r, lighten(c2, 0.55), 1);
      disc(cx + r * 0.45, cy - r * 0.28, r * 0.92, c1, 1);
      for (let i = 0; i < 24; i++) {
        disc(rnd() * size, rnd() * size * 0.8, size * (0.002 + rnd() * 0.006), [255, 255, 255], 0.25 + rnd() * 0.5);
      }
      break;
    }
    case 'waves': {
      disc(size * (0.68 + rnd() * 0.12), horizon - size * 0.18, size * 0.1, lighten(c2, 0.45), 0.9);
      const bands = [c2, lighten(c1, 0.15), darken(c1, 0.25), darken(c0, 0.1)];
      for (let b = 0; b < 4; b++) {
        const base = horizon + b * size * 0.09;
        const amp = size * (0.02 + b * 0.012);
        const col = bands[b];
        for (let x = 0; x < size; x++) {
          const yy = base + Math.sin(x / size * Math.PI * (2.5 + b * 0.7) + rnd() * 0.6) * amp;
          for (let y = Math.max(0, Math.floor(yy)); y < size; y++) {
            if (y < yy + size * 0.02) put(x, y, col, 0.9);
          }
        }
      }
      break;
    }
    case 'petals': {
      const cx = size * 0.5;
      const cy = size * 0.5;
      const n = 6 + Math.floor(rnd() * 4);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rnd() * 0.2;
        const rx = size * 0.20;
        const ry = size * 0.085;
        const px = cx + Math.cos(a) * size * 0.17;
        const py = cy + Math.sin(a) * size * 0.17;
        ellipse(px, py, rx, ry, a, i % 2 ? lighten(c2, 0.2) : c2, 0.85);
      }
      disc(cx, cy, size * 0.1, lighten(c3, 0.35), 1);
      disc(cx, cy, size * 0.05, darken(c3, 0.25), 0.8);
      break;
    }
    case 'constellation': {
      const pts = [];
      for (let i = 0; i < 9; i++) {
        pts.push([size * (0.12 + rnd() * 0.76), size * (0.1 + rnd() * 0.72)]);
      }
      for (let i = 0; i < pts.length - 1; i++) {
        line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], size * 0.004, lighten(c2, 0.5), 0.55);
      }
      for (const [x, y] of pts) {
        disc(x, y, size * 0.012, [255, 255, 255], 0.95);
        disc(x, y, size * 0.03, lighten(c2, 0.6), 0.18);
      }
      break;
    }
    case 'sunset': {
      const sx = size * (0.5 + (rnd() - 0.5) * 0.2);
      disc(sx, horizon - size * 0.05, size * 0.19, lighten(c2, 0.35), 1);
      glow(sx, horizon - size * 0.05, size * 0.24, c2, 0.3);
      for (let i = 0; i < 4; i++) {
        const y = horizon + i * size * 0.06;
        for (let x = 0; x < size; x++) {
          const h = size * 0.03 * (0.6 + rnd() * 0.8);
          for (let yy = Math.floor(y); yy < y + h; yy++) put(x, yy, [255, 255, 255], 0.05 + rnd() * 0.05);
        }
      }
      for (let i = 0; i < 3; i++) {
        line(size * (0.1 + rnd() * 0.8), horizon + size * (0.05 + i * 0.08),
          size * (0.1 + rnd() * 0.8), horizon + size * (0.05 + i * 0.08), size * 0.01, lighten(c2, 0.6), 0.5);
      }
      break;
    }
    case 'plain': {
      const cx = size * (0.3 + rnd() * 0.4);
      const cy = size * (0.3 + rnd() * 0.4);
      glow(cx, cy, size * 0.26, c2, 0.35);
      disc(cx, cy, size * (0.18 + rnd() * 0.1), c2, 0.95);
      break;
    }
    case 'bubbles':
    default: {
      glow(size * 0.5, size * 0.52, size * 0.3, c2, 0.25);
      const cx = size * (0.40 + rnd() * 0.1);
      const cy = size * (0.42 + rnd() * 0.1);
      disc(cx, cy, size * (0.26 + rnd() * 0.05), c2, 0.92);
      disc(cx + size * 0.03, cy + size * 0.03, size * (0.20 + rnd() * 0.04), c0, 0.35);
      for (let i = 0; i < 7; i++) {
        disc(size * (0.08 + rnd() * 0.84), size * (0.08 + rnd() * 0.84), size * (0.006 + rnd() * 0.02), [235, 250, 255], 0.45);
      }
      break;
    }
  }

  return _pngEncode(size, size, rgba);
}

async function _readAvatarBytes(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('file 为空');
  if (/^base64:\/\//i.test(s)) return Buffer.from(s.slice(9), 'base64');
  if (/^data:image\/[a-z]+;base64,/i.test(s)) return Buffer.from(s.split(',')[1], 'base64');
  if (/^https?:\/\//i.test(s)) {
    const res = await fetch(s, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  // 2026-11-01 收紧：**不再接受本地路径**。
  // 头像是公开的；QQ 群里任何人只要能让机器人"换个头像"，填一个本地路径就能把
  // 电脑上任意 PNG/JPG 变成公开头像（"权限档挡得住动，挡不住看"）。
  // 需要本地图时先转成 base64，或者用 qq_avatar_from_message 发图片消息。
  throw new Error('只接受 http(s) 链接 / base64:// / data:image；出于安全，不接受本地文件路径');
}

async function _applyAvatar(buf, note) {
  if (!buf || buf.length < 100) throw new Error('图片太小/为空');
  if (buf.length > 6 * 1024 * 1024) throw new Error('图片过大（>6MB）');
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
  if (!isPng && !isJpg) throw new Error('只支持 PNG / JPEG');
  await onebot('set_qq_avatar', { file: 'base64://' + buf.toString('base64') });
  return { content: [{ type: 'text', text: `${note}，已换成新头像（${Math.round(buf.length / 1024)}KB）` }] };
}

server.tool(
  'qq_set_avatar',
  '把机器人自己的 QQ 头像换掉。file 只接受 http(s) 图片链接、base64://、或 data:image/...（PNG/JPEG，≤6MB）；**不接受本地文件路径**（安全）。想换就换，不用问人。',
  { file: z.string().describe('图片链接或 base64；不是本地路径') },
  async ({ file }) => {
    try {
      return await _applyAvatar(await _readAvatarBytes(file), '图片读取成功');
    } catch (error) {
      return { content: [{ type: 'text', text: `换头像失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_avatar_from_message',
  '把某条 QQ 消息里的图片直接设成自己的头像（群里看到喜欢的图就用这个）。需要会话 key 和 messageId；二代模式要带 token。index 从 0 开始，默认第一张。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    messageId: z.union([z.number(), z.string()]).describe('消息 id 或本地 seq'),
    token: z.string().optional().describe('二代会话令牌'),
    index: z.number().int().min(0).optional().describe('第几张，默认 0'),
  },
  async ({ key, messageId, token, index }) => {
    try {
      const q = new URLSearchParams({ key, messageId: String(messageId) });
      const data = await agentApi(`/api/images/message?${q.toString()}`, {
        headers: token ? { 'x-agent-token': token } : {},
        timeoutMs: 180000,
      });
      const images = Array.isArray(data?.images) ? data.images.filter((img) => img?.data && img?.mimeType) : [];
      if (!images.length) throw new Error(`消息 ${messageId} 里没有可用图片`);
      const pick = images[Math.min(Number(index) || 0, images.length - 1)];
      const buf = Buffer.from(pick.data, 'base64');
      return await _applyAvatar(buf, `取到消息 ${messageId} 的第 ${(Number(index) || 0) + 1} 张图`);
    } catch (error) {
      return { content: [{ type: 'text', text: `用消息图片换头像失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_avatar_draw',
  '自己画一张头像并立刻换上（不需要任何外部图片）。seed 决定构图（随便给个数或一句话都行，同一个 seed 出同一张），palette 是 2-4 色调色板，motif 是画面主题：bubbles 气泡圆、stars 星空、rings 同心环、fish 小鱼、moon 月牙、waves 海面、petals 花瓣、constellation 星座、sunset 日落、plain 极简。',
  {
    seed: z.union([z.number(), z.string()]).optional().describe('构图种子（数字或句子）'),
    palette: z.array(z.string()).optional().describe('2-4 个十六进制颜色'),
    motif: z.enum(['bubbles', 'stars', 'rings', 'fish', 'moon', 'waves', 'petals', 'constellation', 'sunset', 'plain']).optional().describe('主题'),
  },
  async ({ seed, palette, motif }) => {
    try {
      const buf = _drawAvatarBuffer({ seed: seed ?? Date.now() % 100000, palette: palette ?? [], motif: motif ?? 'bubbles' });
      return await _applyAvatar(buf, `自己画了一张（seed=${seed ?? '随机'}，motif=${motif ?? 'bubbles'}）`);
    } catch (error) {
      return { content: [{ type: 'text', text: `画头像失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 自制表情包：豆包生图 → 直接发到当前会话 ────────────────────────────────
// 安全边界（对照"谁发消息谁用你电脑"那期视频定的）：
//   · 只允许白名单会话（allow.groups / allow.private，fail-closed）
//   · 必须带该会话的 agent token，并用一次只读查询验证
//   · 同一会话 90 秒一张、每天 10 张（防刷屏、也防被当免费画师）
//   · 只调用固定脚本、参数用数组传（不开 shell），除生成图片外不产生任何能力

// ── 画图状态：最近生成的图 + 默认画风（2026-11-04）──────────────────────
const GEN_STATE = path.join(ROOT, 'state', 'image-gen.json');
function readGenState() {
  try {
    let t = fs.readFileSync(GEN_STATE, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    return JSON.parse(t);
  } catch { return { last: {}, style: '' }; }
}
function writeGenState(d) {
  try { fs.mkdirSync(path.dirname(GEN_STATE), { recursive: true }); fs.writeFileSync(GEN_STATE, JSON.stringify(d, null, 2), 'utf8'); } catch {}
}
function noteLastImage(key, file) { const d = readGenState(); d.last = d.last || {}; d.last[key] = file; writeGenState(d); }
function getLastImage(key) { const d = readGenState(); return d.last?.[key] || ''; }
function getStyle() { return readGenState().style || ''; }

const STICKER_GEN = process.env.DSH_STICKER_GEN || path.resolve(__dirname, '..', '..', 'tools', 'doubao-image', 'gen-cli.mjs');
const STICKER_RATE = new Map();

function stickerOutDir() {
  return path.join(process.env.TEMP || process.env.TMP || '.', 'qq-stickers');
}

async function runStickerGen(prompt, timeoutMs = 240000) {
  const { spawn } = await import('node:child_process');
  const dir = stickerOutDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const out = path.join(dir, `sticker-${Date.now()}.png`);
  const child = spawn(process.execPath, [STICKER_GEN, '--prompt', prompt, '--out', out, '--size', '512'], {
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve('timeout');
    }, timeoutMs);
    child.on('close', (c) => { clearTimeout(timer); resolve(c); });
  });
  if (code === 'timeout' || code === 3) throw new Error('生成超时（豆包没出图）');
  if (code === 2) throw new Error('豆包未登录：需要管理员在 Edge 窗口扫码一次');
  if (code !== 0) throw new Error(`生成失败（exit ${code}）：${(stderr || stdout).slice(0, 200)}`);
  const cropped = out.replace(/\.png$/i, '') + '-avatar.png';
  return fs.existsSync(cropped) ? cropped : out;
}

server.tool(
  'qq_make_sticker',
  '自己画一张表情包并立刻发到当前会话（走豆包生图，约 20-40 秒）。接梗、自嘲、回应别人的表情时很自然。限制：同一会话 90 秒一张、每天 10 张；画完直接发出，不要再配文字说明"我画了"。prompt 写具体画面，例如「一只鲸鱼翻白眼，表情包风格，白底粗线条」。',
  {
    key: z.string().describe('group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示）'),
    prompt: z.string().describe('画面描述，中文，≤120 字'),
  },
  async ({ key, token, prompt }) => {
    try {
      const text = String(prompt || '').trim().slice(0, 120);
      if (!text) throw new Error('prompt 为空');
      const access = getAccess();
      const isGroup = /^group:/.test(key);
      const convId = key.slice(key.indexOf(':') + 1);
      const allow = isGroup ? access.allowGroups : access.allowPrivate;
      const deny = isGroup ? access.denyGroups : access.denyPrivate;
      if (!isAllowed(allow, deny, convId, access.allowAllWhenEmpty)) throw new Error('该会话不在白名单内');
      await agentApi(`/api/socialV2/state?key=${encodeURIComponent(key)}`, {
        headers: { 'x-agent-token': token },
        timeoutMs: 15000,
      }).catch(() => { throw new Error('会话令牌无效'); });

      const now = Date.now();
      const hist = (STICKER_RATE.get(key) ?? []).filter((t) => now - t < 86400000);
      if (hist.length && now - hist[hist.length - 1] < 90000) throw new Error('太频繁了：同一会话 90 秒一张');
      if (hist.length >= 10) throw new Error('今天这个会话已经画满 10 张了');
      hist.push(now);
      STICKER_RATE.set(key, hist);

      const styleText = String(getStyle() || '').trim();
      const finalPrompt = styleText && !text.includes(styleText) ? `${styleText}，${text}` : text;
      const file = await runStickerGen(finalPrompt);
      noteLastImage(key, file);
      const bytes = await fs.promises.readFile(file);
      if (bytes.length > 4 * 1024 * 1024) throw new Error('图太大，发不出去');
      const image = { type: 'image', data: { file: 'base64://' + bytes.toString('base64') } };
      await onebot(isGroup ? 'send_group_msg' : 'send_private_msg', isGroup
        ? { group_id: Number(convId), message: [image] }
        : { user_id: Number(convId), message: [image] });
      return { content: [{ type: 'text', text: `已生成并发出表情包：${text}（${Math.round(bytes.length / 1024)}KB）` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `做表情包失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 表情包体系工具（二代仿真模式） ─────────────────────────────────────────
if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.listStickers !== false) {
  server.tool(
    'qq_list_stickers',
    '查看 QQ 账号上已收藏的表情包（自定义表情）列表：包含 emoji_id、备注 desc、本地笔记 localNote、标签 tags、使用次数等。可通过 query 按备注/笔记/标签搜索；无备注的表情可以先调用 qq_get_sticker_image 看图理解，再用 qq_sticker_note 记下含义。刚新增/删除表情后如需立即同步，请传 refresh=true。',
    {
      key: z.string().describe('group:群号 或 private:QQ号'),
      token: z.string().describe('唤醒提示里的【会话令牌】'),
      query: z.string().optional().describe('可选搜索词，按备注/本地笔记/标签/用法过滤'),
      count: z.number().optional().describe('最多返回条数，默认 48，受 socialV2.sticker.maxListCount 配置上限约束（当前通常 100）'),
      refresh: z.boolean().optional().describe('是否强制从 QQ 重新同步收藏表情，默认 false（走缓存）')
    },
    async ({ key, token, query, count, refresh }) => {
      try {
        // 强制同步走 POST：GET 上的 refresh 参数会让「读接口」产生写副作用
        // （真的去问 OneBot 拉收藏表情并落盘 state/stickers.json），
        // 从而绕开控制台对所有非 GET 请求的 CSRF 防护（一个 <img src=...> 就能触发）。
        const data = await agentApi('/api/socialV2/sticker-list', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          body: JSON.stringify({ key, query: query ? String(query) : '', count, refresh: refresh === true, token })
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情列表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.getStickerImage !== false) {
  server.tool(
    'qq_get_sticker_image',
    '获取指定收藏表情的图片内容并直接以图像返回给模型（视觉模型可“看懂”）。当 qq_list_stickers 返回的表情 desc/localNote 为空、或你想确认表情实际长什么样时调用。stickerId 可用 qq_list_stickers 返回的 id / md5 / url。动图表情会被抽帧拼成多格图（行优先：左上→右下），说明里会写帧数与网格尺寸；体积过大时会自动缩放，说明里会给出原始尺寸。',
    {
      key: z.string().describe('group:群号 或 private:QQ号'),
      token: z.string().describe('唤醒提示里的【会话令牌】'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const q = new URLSearchParams({ key, stickerId: String(stickerId) });
        const data = await agentApi(`/api/socialV2/sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `表情没有可返回的图片：${errorText(data?.error, '未知')}` }], isError: true };
        }
        const content = [
          { type: 'text', text: `表情 ${data.sticker?.id || stickerId}${data.sticker?.desc ? '（备注：' + data.sticker.desc + '）' : ''} 的图片内容：${data.note ? '（' + data.note + '）' : ''}` },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ];
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.sendSticker !== false) {
  server.tool(
    'qq_send_sticker',
    '在指定会话发送一个 QQ 收藏表情包（自定义表情）。stickerId 用 qq_list_stickers 返回的 id / md5 / url。注意：一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话请先用 qq_send_message / qq_send_message（带 replyToMessageId） 作为单独气泡发送，再单独发这张表情。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。真人偶尔用表情包很自然，但别刷屏。',
    {
      key: z.string().describe('group:群号 或 private:QQ号'),
      token: z.string().describe('唤醒提示里的【会话令牌】'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, stickerId, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.collectSticker !== false) {
  server.tool(
    'qq_collect_sticker',
    '收藏当前会话里别人发的一张表情/图片到你的 QQ 收藏表情，并可写一句简短备注（如“好图偷了，兄弟”）。messageId 用 qq_get(what="unread") / qq_get(what="recent") 返回的 messageId 或 seq。注意：不要频繁收藏，只在真的觉得有意思/好用/戳中你时才偷图；收藏后你可以在 qq_list_stickers 里看到并继续使用。',
    {
      key: z.string().describe('group:群号 或 private:QQ号'),
      token: z.string().describe('唤醒提示里的【会话令牌】'),
      messageId: z.string().describe('要收藏的那条消息的 messageId 或 seq（来自 qq_get(what="unread") / qq_get(what="recent")）'),
      remark: z.string().optional().describe('简短备注，最多 20 字，例如“好图偷了，兄弟”')
    },
    async ({ key, token, messageId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/collect-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, messageId: String(messageId), remark: remark || '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收藏表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.voice?.enabled !== false && cfg.socialV2?.tools?.sendVoice !== false) {
  server.tool(
    'qq_send_voice',
    '在指定会话发一条 QQ 语音（把语音库里准备好的音频当语音条发出去）。voice 传 qq_list_voices 返回的 name（文件名，可带子目录），也可以直接传语音库里的文件名（不带扩展名也能匹配）。注意：① 只能发语音库（qq-bridge/audio/）里的文件，不能发任意本地路径，也不能发 URL/base64；② 受时长与频率上限约束（见 qq_list_voices 的 limits），超限会被拒绝；③ 语音是「开口说话」的强表达，别滥用，闲聊里偶尔发一条即可；④ 返回的 verified=true 表示已经用 get_msg 回读到这条消息的 record 段（语音确实落地了）—— 只有 verified=true 才能对用户说你发了语音；⑤ readback 只对「收到的」语音有意义（QQ 会转写别人的语音），自己发的语音一般拿不到转写文本，默认关闭，别依赖它。',
    {
      key: z.string().describe('group:群号 或 private:QQ号'),
      token: z.string().describe('唤醒提示里的【会话令牌】'),
      voice: z.string().describe('语音库里的文件名（来自 qq_list_voices 的 name，可带子目录/可省略扩展名）'),
      label: z.string().optional().describe('可选：写进会话记录里的说明，如「说了句晚安」'),
      verify: z.boolean().optional().describe('是否回读校验语音已落地（默认 true，建议保持开启）'),
      readback: z.boolean().optional().describe('是否额外索取 QQ 转写文本（自己发的语音通常没有，默认 false）')
    },
    async ({ key, token, voice, label, verify, readback }) => {
      try {
        const data = await agentApi('/api/socialV2/send-voice', {
          method: 'POST',
          body: JSON.stringify({
            key,
            voice: String(voice),
            label: label || '',
            verify: verify !== false,
            readback: readback === true,
            token
          }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送语音失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_list_voices',
    '查看可用的语音库（qq-bridge 的 audio 目录里准备好的音频文件）：文件名、时长、大小。想发语音前先调用这个看有哪些能发（名字用返回的 name）。返回里 limits 是时长/体积/频率上限。语音库里没有合适内容时不要硬发，也不要假装发了语音。',
    {
      key: z.string().describe('group:群号 或 private:QQ号'),
      token: z.string().describe('唤醒提示里的【会话令牌】'),
      probe: z.boolean().optional().describe('是否逐个探测时长（默认 true；文件多时可传 false 加快）')
    },
    async ({ key, token, probe }) => {
      try {
        const q = new URLSearchParams({ key });
        if (probe === false) q.set('probe', '0');
        const data = await agentApi(`/api/socialV2/voices?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取语音库失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.getSelfImage !== false) {
  server.tool(
    'qq_get_self_image',
    '查看你自己的默认 Q 版形象图片（DeepSeek 小鲸鱼形象）。当你被问“你长什么样/发张自拍/你是什么形象”时，可以调用这个工具看自己的样子；返回的图片会直接进入你的视觉上下文。',
    {
      key: z.string().describe('group:群号 或 private:QQ号'),
      token: z.string().describe('唤醒提示里的【会话令牌】')
    },
    async ({ key, token }) => {
      try {
        const q = new URLSearchParams({ key });
        const data = await agentApi(`/api/socialV2/self-image?${q.toString()}`, { headers: { 'x-agent-token': token } });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `没有可返回的形象图片：${errorText(data?.error, '未知')}` }], isError: true };
        }
        return {
          content: [
            { type: 'text', text: '这是你的默认 Q 版形象：' },
            { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取形象图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.stickerNote !== false) {
  server.tool(
    'qq_sticker_note',
    '给一个收藏表情记录你自己的理解/备注/标签/用法，供以后选择表情时参考。这是本地记忆，不会修改 QQ 账号的官方备注；适合对没有备注的表情看图后记住含义。',
    {
      key: z.string().describe('group:群号 或 private:QQ号'),
      token: z.string().describe('唤醒提示里的【会话令牌】'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      note: z.string().optional().describe('你理解的表情含义/适合场景，最多 200 字'),
      tags: z.array(z.string()).optional().describe('可选标签，如 ["嘲讽","笑哭","怼人"]'),
      usage: z.string().optional().describe('可选用法说明，最多 200 字')
    },
    async ({ key, token, stickerId, note, tags, usage }) => {
      try {
        const payload = { key, stickerId: String(stickerId) };
        if (note !== undefined && note !== null) payload.note = String(note);
        if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
        if (usage !== undefined && usage !== null) payload.usage = String(usage);
        const data = await agentApi('/api/socialV2/sticker-note', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.setStickerRemark !== false) {
  server.tool(
    'qq_set_sticker_remark',
    '修改 QQ 账号里收藏表情的官方备注（desc）。这是写操作，会直接影响 QQ 账号的表情备注；仅在管理员明确允许（socialV2.tools.setStickerRemark=true）时可用。一般优先用 qq_sticker_note 记录自己的理解，不要随意改官方备注。',
    {
      key: z.string().describe('group:群号 或 private:QQ号'),
      token: z.string().describe('唤醒提示里的【会话令牌】'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      remark: z.string().describe('新的表情备注，最多 50 字')
    },
    async ({ key, token, stickerId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/sticker-remark', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), remark: String(remark || '') }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 合并转发消息查看工具（二代仿真模式） ────────────────────────────────────
if (cfg.socialV2?.tools?.getForwardMsg !== false) {
  server.tool(
    'qq_get_forward_msg',
    '查看当前会话中出现的合并转发消息/聊天记录内容（只读）。当消息文本里出现 `[转发消息 id=...]`，或 `qq_get(what="unread")` / `qq_get(what="recent")` / `qq_get(what="detail")` 返回的某条消息带 `forwardIds` / `hasForward: true` 时调用。只能查看当前会话确实收到过的转发消息 id，不能任意读取。返回内容会包含每条消息的 text、media（图片/表情元数据）与 nestedForwardIds；如果合并转发里有图片，工具会直接把最多 5 张图片以图像内容返回给视觉模型；如果里面有嵌套合并转发，会附带嵌套转发 id 和前几条预览，必要时可继续用本工具查看嵌套 id。',
    {
      key: z.string().describe('group:群号 或 private:QQ号'),
      token: z.string().describe('唤醒提示里的【会话令牌】'),
      id: z.string().describe('合并转发消息 id（来自消息里的 [转发消息 id=...] 或 forwardIds 数组）')
    },
    async ({ key, token, id }) => {
      try {
        const q = new URLSearchParams({ key, id: String(id) });
        const data = await agentApi(`/api/socialV2/forward-message?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        const content = [{ type: 'text', text: serializeModelData(data) }];
        // 收集所有层级的图片/表情元数据（含嵌套预览），最多返回 5 张。
        const images = [];
        const seen = new Set();
        const collectMedia = (msgs) => {
          if (!Array.isArray(msgs)) return;
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            for (const media of Array.isArray(m.media) ? m.media : []) {
              if (!media || typeof media !== 'object') continue;
              const keyId = media.url || media.file || media.faceId || '';
              if (!keyId || seen.has(keyId)) continue;
              seen.add(keyId);
              images.push(media);
            }
          }
        };
        collectMedia(data?.messages);
        if (Array.isArray(data?.nestedPreviews)) {
          for (const np of data.nestedPreviews) collectMedia(np?.messages);
        }
        const MAX_IMAGES = 5;
        const imageTexts = [];
        if (images.length) {
          try {
            const mediaRes = await agentApi('/api/socialV2/forward-media', {
              method: 'POST',
              body: JSON.stringify({ key, media: images.slice(0, MAX_IMAGES) }),
              headers: { 'x-agent-token': token },
              timeoutMs: 180000
            });
            const mediaImages = Array.isArray(mediaRes?.images) ? mediaRes.images : [];
            for (const img of mediaImages) {
              if (img?.data && img?.mimeType) {
                content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}${img.text ? ' ' + img.text : ''}]`);
              } else {
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}（${img.text || '获取失败'}）]`);
              }
            }
          } catch (error) {
            imageTexts.push(`[转发内图片（批量获取失败：${error?.message ?? error}）]`);
          }
        }
        if (imageTexts.length) {
          content.unshift({ type: 'text', text: `合并转发 ${id} 的图片内容（${imageTexts.length} 项）：\n${imageTexts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `查看合并转发失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

await server.connect(new StdioServerTransport());
