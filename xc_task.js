const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

// ================== 配置 ==================
// 优先读同目录下的 config.json，其次读环境变量。
// 复制 config.example.json 为 config.json，填上你自己的值。
// ==================
function loadConfig() {
  const cfg = {};
  // 1) 环境变量
  if (process.env.XC_BASE) cfg.base = process.env.XC_BASE;
  if (process.env.XC_TOKEN) cfg.token = process.env.XC_TOKEN;
  // 2) 同目录 config.json 覆盖
  try {
    const p = path.join(__dirname, 'config.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j.base) cfg.base = String(j.base).trim();
    if (j.token) cfg.token = String(j.token).trim();
  } catch (e) { /* 没有就用环境变量 */ }
  return cfg;
}

// ================== 自动定位 Operit 数据目录 ==================
// 不同设备 / 重装 App 后 UUID 会变，所以不写死。
// 策略：从本脚本所在目录往上走，找到含 "identities" 的那层（Operit 根），
// 再在它下面精确拼路径。比全盘 find 快几百倍。
// ==================
function findOperitRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    try {
      if (fs.existsSync(path.join(dir, 'identities'))) return dir;
    } catch (e) {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findIdentityDir(operitRoot) {
  if (!operitRoot) return null;
  const base = path.join(operitRoot, 'identities');
  try {
    const dirs = fs.readdirSync(base).filter(d => d.startsWith('identity-'));
    if (!dirs.length) return null;
    // 多个身份时，取最近修改的那个
    let best = null, bestTime = 0;
    for (const d of dirs) {
      try {
        const st = fs.statSync(path.join(base, d));
        if (st.mtimeMs > bestTime) { bestTime = st.mtimeMs; best = d; }
      } catch (e) {}
    }
    return path.join(base, best);
  } catch (e) { return null; }
}

const OPERIT_ROOT = findOperitRoot(__dirname);
const IDENTITY = findIdentityDir(OPERIT_ROOT);

const CURCHAT = IDENTITY ? path.join(IDENTITY, 'state', 'current_chat_id.preferences.json') : null;
const DB = IDENTITY ? path.join(IDENTITY, 'data', 'database', 'operit2.sqlite') : null;

function readCurChat() {
  if (!CURCHAT) return null;
  try {
    const j = JSON.parse(fs.readFileSync(CURCHAT, 'utf8'));
    const id = String(j.current_chat_id || '').trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return id;
  } catch (e) {}
  return null;
}

const out = { step: 'start' };

const cfg = loadConfig();
if (!cfg.base || !cfg.token) {
  out.step = 'no_config';
  out.err = '缺少 XC_BASE / XC_TOKEN。可写环境变量，或在脚本同目录放 config.json。';
  console.log(JSON.stringify(out));
  process.exit(0);
}
const BASE = String(cfg.base).replace(/\/$/, '');
const URL = BASE + '/v1/conversation-event';
const TOKEN = cfg.token;

const CID = readCurChat();
if (!CID) {
  out.step = 'no_chat';
  out.err = '读不到当前对话 id。请先在 Operit 里打开一个对话，再触发本脚本。';
  console.log(JSON.stringify(out));
  process.exit(0);
}

if (!DB || !fs.existsSync(DB)) {
  out.step = 'no_db';
  out.err = '找不到 operit2.sqlite。请检查 Operit 是否已安装、是否至少聊过一轮。';
  out.db = DB || null;
  console.log(JSON.stringify(out));
  process.exit(0);
}

const ROUNDS = 2;          // 往前带几轮对话（给判类型足够上下文）
const MAX_CHARS = 1400;    // exchange 总长上限（心潮那边上限 1500）
const PER_MSG = 500;       // 单条消息上限
const MIN_GAP_MS = 60 * 1000;  // 两次触发最小间隔，防止连点
const CURSOR = path.join(__dirname, 'cursor_' + CID.slice(0, 8) + '.json');  // 每个对话一份

// ---------- 时间窗节流 ----------
let cur0 = null;
try { cur0 = JSON.parse(fs.readFileSync(CURSOR, 'utf8')); } catch (e) { cur0 = null; }
const now = Date.now();
if (cur0 && cur0.lastRunAt && now - cur0.lastRunAt < MIN_GAP_MS) {
  out.step = 'throttled';
  out.ago = Math.round((now - cur0.lastRunAt) / 1000) + 's';
  console.log(JSON.stringify(out));
  process.exit(0);
}

const LAST_TS = cur0 && cur0.lastTs ? Number(cur0.lastTs) : 0;

// ---------- 读库 ----------
// 注意：列名是 messageTimestamp / content / sender('user'|'ai')，时间戳是毫秒。
// 同一条消息会被拆成多个 markdown part（流式分段），必须按 ts+who 聚合。
const sql = "SELECT m.timestamp AS ts,m.sender AS s,p.content AS c " +
  "FROM messages m JOIN message_parts p " +
  "ON p.chatId=m.chatId AND p.messageTimestamp=m.timestamp " +
  "WHERE m.chatId='" + CID + "' AND p.kind='markdown' AND m.sender IN('user','ai') " +
  "ORDER BY m.timestamp DESC,p.sequence ASC LIMIT 240;";

let raw = '';
try {
  raw = execSync('sqlite3 -json "' + DB + '"', { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
} catch (e) {
  out.step = 'sql_err';
  out.err = String(e && e.message ? e.message : e).slice(0, 200);
  console.log(JSON.stringify(out));
  process.exit(0);
}

const i0 = raw.indexOf('[');
if (i0 < 0) {
  out.step = 'no_rows';
  out.head = raw.slice(0, 120);
  console.log(JSON.stringify(out));
  process.exit(0);
}
let rows = [];
try { rows = JSON.parse(raw.slice(i0)); } catch (e) {
  out.step = 'parse_err';
  out.err = String(e).slice(0, 120);
  console.log(JSON.stringify(out));
  process.exit(0);
}
out.fetched = rows.length;

// ---------- 聚合（全量；游标只判断有没有新消息，不裁内容） ----------
const agg = [];
let cur = null;
for (const r of rows) {
  const ts = Number(r.ts);
  const who = r.s === 'user' ? 'user' : 'ai';
  if (cur && cur.ts === ts && cur.who === who) cur.p.push(String(r.c || ''));
  else { cur = { ts: ts, who: who, p: [String(r.c || '')] }; agg.push(cur); }
}
out.merged = agg.length;
out.since = LAST_TS;
out.hasNew = agg.some(a => a.ts > LAST_TS);

// 自动唤醒 / 系统消息，别当成真对话喂过去
const DROP = ['日记时间', '温柔巡检', '请按指引', '对话摘要'];

function clean(parts) {
  let t = parts.join('\n');
  t = t.replace(/<attachment[\s\S]*?<\/attachment>/g, '');
  // 被截断的、没有结束标签的标签片段：从开头标签砍到文末
  t = t.replace(/<attachment[\s\S]*$/g, '');
  t = t.replace(/<character_memory_recall>[\s\S]*$/g, '');
  t = t.replace(/<\/?[a-zA-Z_][\w-]*[^>]*>/g, '');
  t = t.replace(/<character_memory_recall>[\s\S]*?<\/character_memory_recall>/g, '');
  t = t.replace(/<[a-zA-Z_][\w-]*[\s\S]*?<\/[a-zA-Z_][\w-]*>/g, '');
  t = t.replace(/```[\s\S]*?```/g, '');
  t = t.replace(/`[^`]*`/g, '');
  t = t.replace(/\*\*/g, '');
  t = t.replace(/^#{1,6}\s*/gm, '');
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/\|/g, ' ');
  t = t.replace(/https?:\/\/\S+/g, '');
  t = t.replace(/path=[^\s\n]+/g, '');
  return t.split('\n').map(x => x.trim()).filter(x => x !== '').join('\n').trim();
}

const T = [];
for (const a of agg) {
  const t = clean(a.p);
  if (!t || t.length < 6) continue;
  if (DROP.some(k => t.indexOf(k) >= 0)) continue;
  T.push({ who: a.who, text: t, ts: a.ts });
}
T.reverse();
out.turns = T.length;

if (T.length === 0) {
  out.step = 'no_new';
  console.log(JSON.stringify(out));
  process.exit(0);
}

// 从最后一条 user 往前取够 ROUNDS 轮
let si = -1;
for (let i = T.length - 1; i >= 0; i--) {
  if (T[i].who === 'user') { si = i; break; }
}
if (si >= 0) {
  let extra = ROUNDS - 1;
  for (let i = si - 1; i >= 0 && extra > 0; i--) {
    if (T[i].who === 'user') { extra--; si = i; }
  }
}
const P = si >= 0 ? T.slice(si) : T.slice(-4);
if (!P.some(x => x.who === 'user') || !P.some(x => x.who === 'ai')) {
  out.step = 'wait_round';
  out.got = P.length;
  console.log(JSON.stringify(out));
  process.exit(0);
}

const L = P.map(x => {
  let b = x.text;
  if (b.length > PER_MSG) b = b.slice(0, PER_MSG) + '...';
  return (x.who === 'user' ? '她说：' : '他回：') + b;
});
let n = L.length;
let ex = L.join('\n');
while (ex.length > MAX_CHARS && n > 1) { n--; ex = L.slice(L.length - n).join('\n'); }
if (ex.length > MAX_CHARS) { ex = ex.slice(ex.length - MAX_CHARS); }
out.chars = ex.length;
out.lines = n;
const MAX_TS = Math.max.apply(null, P.map(x => x.ts));
out.maxTs = MAX_TS;

// 没有新内容就不回传，免得重复污染
if (!out.hasNew) {
  out.step = 'no_new';
  console.log(JSON.stringify(out));
  process.exit(0);
}

// ---------- 回传前先取 revision（仅用于日志，失败不影响） ----------
const TMP = path.join(__dirname, '.tmp');
function getRev() {
  try {
    execSync("curl -s -m 15 -o '" + TMP + "' '" + BASE + "/v1/state' -H 'Authorization: Bearer " + TOKEN + "'", { timeout: 25000 });
    const s = JSON.parse(fs.readFileSync(TMP, 'utf8'));
    return s.revision;
  } catch (e) { return null; }
}
out.revBefore = getRev();

// ---------- POST ----------
// 只发三个字段：event_id / session_id / exchange。
// 不要传 interactionType —— 心潮会用它的模型自己判类型，
// 带了类型反而会跳过判断，且判得不如模型准。
const body = { event_id: 'wf-' + now, session_id: 'operit-' + CID.slice(0, 8), exchange: ex };
const payloadPath = path.join(__dirname, '.payload.json');
fs.writeFileSync(payloadPath, JSON.stringify(body));

// 超时说明：心潮那边判一次类型要 20~35 秒，60 秒比较稳。
// 太短会被中断，表现为 step:curl_err / ETIMEDOUT。
let http = '', respRaw = '';
const respPath = path.join(__dirname, '.resp.json');
try {
  http = execSync(
    "curl -s -m 60 -o '" + respPath + "' -w '%{http_code}' -X POST '" + URL + "' " +
    "-H 'Authorization: Bearer " + TOKEN + "' -H 'Content-Type: application/json' " +
    "--data-binary '@" + payloadPath + "'",
    { encoding: 'utf8', timeout: 75000 }
  ).trim();
} catch (e) {
  out.step = 'curl_err';
  out.err = String(e && e.message ? e.message : e).slice(0, 200);
  console.log(JSON.stringify(out));
  process.exit(0);
}
try { respRaw = fs.readFileSync(respPath, 'utf8'); } catch (e) { respRaw = ''; }

let resp = null;
try { resp = JSON.parse(respRaw.slice(respRaw.indexOf('{'))); } catch (e) { resp = null; }
out.http = http;
out.revAfter = resp ? resp.revision : null;
out.ok = http === '200' && resp && resp.revision;
// interaction.applied 为 false 且 reasonCode 是 no_interaction_outcome，通常是
// 撞上了心潮「8 分钟内只判一次」的节流，不是失败。事件照样入账。
if (resp && resp.interaction) {
  out.applied = resp.interaction.applied;
  out.reason = resp.interaction.reasonCode;
}
out.preview = ex.slice(0, 160);

// ---------- 写游标（只在成功后推进） ----------
if (out.ok) {
  try {
    fs.writeFileSync(CURSOR, JSON.stringify({ lastTs: MAX_TS, lastRunAt: now, rev: resp.revision }));
  } catch (e) { out.cur_err = String(e).slice(0, 100); }
  out.step = 'done';
} else {
  out.step = 'post_fail';
  out.err = String(respRaw).slice(0, 200);
}
console.log(JSON.stringify(out));
