/* ==========================================================================
   AI 食物识别
   --------------------------------------------------------------------------
   负责三件事：
     1. 把照片发给 AI（支持「走代理」和「直连」两种模式）
     2. 把 AI 返回的文字**容错解析**成结构化数据
     3. 把各种失败翻译成用户看得懂的中文提示

   ## 两种连接模式

   | 模式 | 请求路径 | Key 在哪 | 适合谁 |
   | ---- | -------- | -------- | ------ |
   | proxy（走代理）  | 手机 → 你的 Cloudflare Worker → DeepSeek | 服务器上 | 你和朋友 |
   | direct（直连）   | 手机 → DeepSeek 直连                    | 手机本地 | 想自己付费用的人 |

   ## 关于容错解析

   DeepSeek 的 JSON 模式有三个已知情况（均在官方文档里写明）：
     1. 偶尔返回**空内容** —— 所以失败时要提示"再点一次"
     2. 可能仍被包在 ```json ... ``` 里 —— 要能剥掉
     3. 可能 JSON 被 max_tokens 截断 —— 要能尝试补全

   所以下面没有用简单的 JSON.parse，而是逐层兜底。
   ========================================================================== */

/* ============================================================ 常量 */

/** 直连模式用的接口。代理模式下这个值会被设置页里填的地址替换。 */
export const DEEPSEEK_DIRECT_URL = 'https://api.deepseek.com/chat/completions';

/** 模型名。⚠️ 图片输入只支持 deepseek-flash，不要改成 deepseek-chat。 */
export const VISION_MODEL = 'deepseek-flash';

/** 单图 base64 上限 32 MiB，我们的图约 150 KB，远低于上限 */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/**
 * 系统提示词。
 *
 * 必须满足 DeepSeek 的三个要求（否则 JSON 模式可能不生效或解析失败）：
 *   1. 出现 "json" 这个词
 *   2. 给出 JSON 格式示例
 *   3. 说明缺字段时怎么处理
 */
const SYSTEM_PROMPT = [
  '你是一个中文食物识别助手。用户给你一张食物照片，请识别并估算热量与花费。',
  '',
  '只输出一个 JSON 对象，不要输出任何解释文字，不要用 markdown 代码围栏。',
  '',
  'JSON 格式示例：',
  '{',
  '  "name": "红烧牛肉面",',
  '  "calories": 580,',
  '  "cost": 22,',
  '  "confidence": 0.8,',
  '  "alternatives": ["牛肉面", "拉面"]',
  '}',
  '',
  '字段说明：',
  '- name：食物名称，中文，尽量具体（如「红烧牛肉面」，不要只写「面条」）',
  '- calories：估算热量，整数，单位千卡',
  '- cost：估算价格，数字，单位元（人民币）',
  '- confidence：你对估算的把握，0 到 1 之间的小数',
  '- alternatives：其他可能的食物名，字符串数组，最多 3 个',
  '',
  '如果照片里没有食物或看不清，输出：',
  '{"name":"无法识别","calories":0,"cost":0,"confidence":0,"alternatives":[]}',
].join('\n');

/* ============================================================ 错误 */

/**
 * 识别失败的类型。
 *
 * 区分它们的意义：**决定 App 该自动回退还是让用户去改设置**。
 *   - 服务/网络类 → 自动回退到本地食物库，用户至少有个数字能用
 *   - 用户配置类 → 不静默回退，明确告诉他去改哪里
 */
export class AIError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AIError';
    this.code = code;
    /** 是否值得让用户「再试一次」 */
    this.retryable = options.retryable === true;
    /** 是否属于用户自己可以修的问题（去设置里改） */
    this.userFixable = options.userFixable === true;
    /** 是否应该自动回退到本地估算 */
    this.shouldFallback = options.shouldFallback === true;
  }
}

/* ============================================================ 请求体 */

/**
 * 组装要发给 AI 的请求。
 *
 * ⚠️ 图片必须放在 **user** 消息里 —— 放 system 或 assistant 会直接 400。
 * 这是官方文档明确写的限制。
 */
export function buildRequestBody({ imageDataUrl, saveData = false, mealLabel = '' }) {
  const detail = saveData ? 'low' : 'original';
  const text = mealLabel
    ? `请识别这张食物照片。这顿饭大概是「${mealLabel}」。按系统提示的 JSON 格式返回。`
    : '请识别这张食物照片。按系统提示的 JSON 格式返回。';

  return {
    model: VISION_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text },
          { type: 'image_url', image_url: { url: imageDataUrl, detail } },
        ],
      },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 512,
    temperature: 0.2,
  };
}

/* ============================================================ 解析 */

/**
 * 从模型返回的文字里抠出结构化结果。
 *
 * 处理这些情况（都是实际会遇到的）：
 *   - 纯 JSON
 *   - 被 ```json ... ``` 包裹
 *   - 前后有解释文字（"好的，这是结果：{...}"）
 *   - 字段名用中文
 *   - 数字是字符串（"580"）或带单位（"580 kcal"）
 *   - JSON 被截断（缺少结尾的 }）
 *
 * @returns {{name,calories,cost,confidence,alternatives}|null}
 */
export function parseFoodResult(raw) {
  if (!raw || typeof raw !== 'string') return null;

  const text = raw.trim();
  if (!text) return null;

  // ---- 1. 剥掉 markdown 代码围栏
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;

  // ---- 2. 逐个尝试每个 '{' 起点（前后可能有说明文字）
  for (const start of findObjectStarts(candidate)) {
    const slice = candidate.slice(start);
    const end = findMatchingBrace(slice);

    // 有配对的花括号 → 直接解析
    if (end !== -1) {
      const parsed = tryParseObject(slice.slice(0, end + 1));
      if (parsed) return normalize(parsed);
    }

    // 没有配对（被截断）→ 试着补全再解析
    const repaired = tryRepairTruncated(slice);
    if (repaired) return normalize(repaired);
  }

  return null;
}

/** 所有可能作为对象起点的 '{' 位置 */
function findObjectStarts(text) {
  const starts = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '{') starts.push(i);
  }
  return starts;
}

/**
 * 找到与开头 '{' 配对的那个 '}'，返回其下标。
 * 必须跳过字符串内部的括号，否则 `{"name":"盖饭{大份}"}` 会算错。
 */
function findMatchingBrace(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function tryParseObject(text) {
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch (err) {
    return null;
  }
}

/**
 * 尝试修复被截断的 JSON。
 * 比如 `{"name":"面","calories":5` → 补成 `{"name":"面","calories":5}`
 */
function tryRepairTruncated(text) {
  // 去掉结尾不完整的最后一个键值对，再补右括号
  let body = text;

  // 如果字符串没闭合，先补上引号
  const quotes = (body.match(/(?<!\\)"/g) || []).length;
  if (quotes % 2 === 1) body += '"';

  // 去掉尾部可能悬空的逗号或冒号
  body = body.replace(/[,:]\s*$/, '');

  // 尝试补 0~2 个右括号
  for (let extra = 0; extra <= 2; extra += 1) {
    const attempt = body + '}'.repeat(extra + 1);
    const parsed = tryParseObject(attempt);
    if (parsed) return parsed;
  }
  return null;
}

/** 从任意值里抠出第一个数字。支持 "580"、"约 580 kcal"、"¥22.5" */
function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const m = value.replace(/[，,]/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** 把解析出来的对象整理成固定形状，字段名中英文都认 */
function normalize(obj) {
  const pick = (...keys) => {
    for (const key of keys) {
      const v = obj[key];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  };

  const rawName = pick('name', 'food', 'foodName', '食物', '食物名称', '名称');
  const name = typeof rawName === 'string' ? rawName.trim() : '';

  // 没有名字就无法填表，判为解析失败（不要编一个"未知食物"）
  if (!name) return null;

  const calories = toNumber(pick('calories', 'calorie', 'cal', 'kcal', '热量', '卡路里'));
  const cost = toNumber(pick('cost', 'price', '金额', '价格', '花费'));
  const confidence = toNumber(pick('confidence', '置信度', 'score'));

  let alternatives = pick('alternatives', 'candidates', '候选', '其他可能');
  if (typeof alternatives === 'string') alternatives = [alternatives];
  if (!Array.isArray(alternatives)) alternatives = [];
  alternatives = alternatives
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => x.trim())
    .slice(0, 3);

  return {
    name,
    // 热量缺失时给 0，界面上会显示「未识别到热量」，而不是伪造一个数字
    calories: calories === null ? 0 : Math.max(0, Math.round(calories)),
    cost: cost === null ? null : Math.max(0, Math.round(cost * 100) / 100),
    confidence: confidence === null ? null : Math.min(1, Math.max(0, confidence)),
    alternatives,
  };
}

/* ============================================================ 请求 */

/**
 * 识别一张食物照片。
 *
 * @param {object} options
 * @param {string} options.imageDataUrl  形如 "data:image/jpeg;base64,..."
 * @param {object} options.settings      来自 store.loadSettings()
 * @param {string} options.mealLabel     餐次中文名，作为提示词辅助
 * @param {function} [options.fetchImpl] 可注入的 fetch（测试用）
 * @returns {Promise<{name,calories,cost,confidence,alternatives,raw}>}
 * @throws {AIError}
 */
export async function recognizeFood({
  imageDataUrl,
  settings,
  mealLabel = '',
  fetchImpl = fetch,
}) {
  // -------------------------------------------------- 前置检查
  if (!imageDataUrl || !imageDataUrl.startsWith('data:image/')) {
    throw new AIError('NO_IMAGE', '没有拿到照片，请重新拍一张或选一张。', {
      shouldFallback: false,
    });
  }

  // base64 长度换算成字节数，防止超过服务端上限
  const base64Part = imageDataUrl.slice(imageDataUrl.indexOf(',') + 1);
  const approxBytes = Math.round(base64Part.length * 0.75);
  if (approxBytes > MAX_IMAGE_BYTES) {
    throw new AIError('IMAGE_TOO_LARGE', '这张照片太大了，请换一张或重拍。', {
      shouldFallback: true,
    });
  }

  const mode = settings.aiMode === 'direct' ? 'direct' : 'proxy';

  // 用户是否同意把照片发给 AI
  if (!settings.aiConsent) {
    throw new AIError(
      'NO_CONSENT',
      '还没有同意把照片发给 AI。到「设置 → AI 识别」里打开那个开关。',
      { userFixable: true, shouldFallback: false },
    );
  }

  let url;
  const headers = { 'Content-Type': 'application/json' };

  if (mode === 'direct') {
    // ---- 直连：用用户自己的 Key
    if (!settings.apiKey) {
      throw new AIError(
        'NO_API_KEY',
        '还没有填 API Key。到「设置 → AI 识别」里填入你自己的 DeepSeek API Key。',
        { userFixable: true, shouldFallback: false },
      );
    }
    url = (settings.apiUrl && settings.apiUrl.trim()) || DEEPSEEK_DIRECT_URL;
    headers.Authorization = `Bearer ${settings.apiKey}`;
  } else {
    // ---- 走代理：Key 在服务器上
    if (!settings.proxyUrl) {
      throw new AIError(
        'NO_PROXY_URL',
        '还没有填服务地址。到「设置 → AI 识别」里填入管理员给你的网址。',
        { userFixable: true, shouldFallback: false },
      );
    }
    url = settings.proxyUrl.trim();
    if (settings.proxyCode) {
      headers['X-Access-Code'] = settings.proxyCode;
    }
  }

  // 走代理时由服务器组装完整请求，我们只发精简数据
  const body = mode === 'proxy'
    ? JSON.stringify({
      image: imageDataUrl,
      saveData: settings.saveData === true,
      mealHint: mealLabel,
    })
    : JSON.stringify(buildRequestBody({
      imageDataUrl,
      saveData: settings.saveData === true,
      mealLabel,
    }));

  // -------------------------------------------------- 发请求
  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', headers, body });
  } catch (err) {
    // fetch 直接抛异常 = 断网 / DNS 失败 / CORS 被拒
    throw new AIError(
      'NETWORK',
      '网络请求失败，可能是没有联网或服务地址填错了。已改用本地估算。',
      { shouldFallback: true, retryable: true },
    );
  }

  // -------------------------------------------------- 处理响应
  let payload = null;
  try {
    payload = await response.json();
  } catch (err) {
    payload = null;
  }

  if (!response.ok) {
    // 代理模式：Worker 会返回 { ok:false, error, code }
    const code = payload && payload.code;
    const message = (payload && payload.error) || `服务返回错误 ${response.status}`;

    // 把 Worker 的错误码映射成我们的行为
    const map = {
      BAD_ACCESS_CODE: { userFixable: true, shouldFallback: false },
      NO_SERVER_KEY: { userFixable: false, shouldFallback: true },
      BAD_SERVER_KEY: { userFixable: false, shouldFallback: true },
      INSUFFICIENT_BALANCE: { userFixable: false, shouldFallback: true },
      RATE_LIMITED: { retryable: true, shouldFallback: true },
      UPSTREAM_RATE_LIMITED: { retryable: true, shouldFallback: true },
      EMPTY_CONTENT: { retryable: true, shouldFallback: true },
      UPSTREAM_UNREACHABLE: { retryable: true, shouldFallback: true },
    };

    const behavior = map[code] || {
      // 直连模式下常见的 HTTP 状态码
      ...(response.status === 401 || response.status === 403
        ? { userFixable: true, shouldFallback: false }
        : { retryable: true, shouldFallback: true }),
    };

    let friendly = message;
    if (mode === 'direct') {
      if (response.status === 401 || response.status === 403) {
        friendly = 'API Key 无效或已过期，请到「设置」里检查。';
      } else if (response.status === 402) {
        friendly = 'DeepSeek 账户余额不足，请去 platform.deepseek.com 充值。';
      } else if (response.status === 429) {
        friendly = '请求太频繁，等一会儿再试。';
      }
    }

    throw new AIError(code || `HTTP_${response.status}`, friendly, behavior);
  }

  // -------------------------------------------------- 取出内容
  let content = null;
  if (mode === 'proxy') {
    content = payload && payload.content;
  } else {
    content = payload
      && payload.choices
      && payload.choices[0]
      && payload.choices[0].message
      && payload.choices[0].message.content;
  }

  if (!content || !String(content).trim()) {
    // 官方文档说 JSON 模式偶尔返回空 —— 提示用户可以再试一次
    throw new AIError(
      'EMPTY_CONTENT',
      'AI 这次没有返回内容（已知的偶发问题），再点一次「AI 识别」就好。',
      { retryable: true, shouldFallback: true },
    );
  }

  // -------------------------------------------------- 解析
  const result = parseFoodResult(content);
  if (!result) {
    throw new AIError(
      'UNPARSABLE',
      'AI 返回的内容看不懂，再试一次可能会好。已改用本地估算。',
      { retryable: true, shouldFallback: true },
    );
  }

  return { ...result, raw: content };
}

/**
 * 测试连接。
 *
 * 用一个极小的 1×1 透明 PNG 发一次真实请求 —— 这样能验证
 * 「Key 对不对」「余额够不够」「地址通不通」，而不是只检查字段有没有填。
 * 成本几乎为零（一张 1×1 的图只有几十字节）。
 *
 * @returns {Promise<{ok:boolean, message:string}>}
 */
export async function testConnection(settings, fetchImpl = fetch) {
  // 1×1 白色 PNG
  const TINY_PNG = 'data:image/png;base64,'
    + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  try {
    const result = await recognizeFood({
      imageDataUrl: TINY_PNG,
      settings: { ...settings, aiConsent: true },   // 测试时跳过同意检查
      mealLabel: '',
      fetchImpl,
    });
    return {
      ok: true,
      message: `连接成功！AI 返回了「${result.name}」。说明 Key 和服务地址都是对的。`,
    };
  } catch (err) {
    if (err instanceof AIError) {
      return { ok: false, message: err.message };
    }
    return { ok: false, message: `测试失败：${err.message}` };
  }
}

/* ==========================================================================
   课程表识别
   --------------------------------------------------------------------------
   和食物识别共用同一套「连接方式 / 错误分类 / JSON 容错」，
   但提示词和返回结构完全不同：这次要的是一整张课表（多门课）。

   为什么让 AI 返回「第几节」而不是时间：
     课表上写的就是「一二节」，让它换算成 08:00 反而容易算错；
     节次→时间的换算交给本地的 PERIOD_TIMES 表，可核对、可修改。
   ========================================================================== */

/**
 * 课表识别的系统提示词。
 *
 * 三条硬要求（来自 DeepSeek 官方文档，缺一个就可能解析失败）：
 *   1. 提示词里必须出现 "json"
 *   2. 必须给出 JSON 格式示例
 *   3. 必须说清「认不出来时怎么返回」，否则它会瞎编
 */
const TIMETABLE_PROMPT = [
  '你是课程表识别助手。用户会给你一张大学课程表的截图或照片。',
  '',
  '只输出一个 JSON 对象，不要解释文字，不要用 markdown 代码围栏。',
  '',
  'JSON 格式示例：',
  '{',
  '  "courses": [',
  '    {',
  '      "name": "国家安全教育",',
  '      "teacher": "蒋荣华",',
  '      "room": "厚德206",',
  '      "day": 1,',
  '      "startPeriod": 1,',
  '      "endPeriod": 2,',
  '      "weeks": "1-16"',
  '    }',
  '  ],',
  '  "noSlotCourses": [',
  '    { "name": "军事技能", "code": "B29800001", "weeks": "1" }',
  '  ],',
  '  "weekdayHeaderDetected": true,',
  '  "periodColumnDetected": true,',
  '  "confidence": 0.85,',
  '  "notes": "第 7 周，九十节以后没有课"',
  '}',
  '',
  '字段说明：',
  '- day：1=周一，2=周二 … 7=周日。必须是数字。',
  '- startPeriod / endPeriod：第几节课，数字。「一二节」写 1 和 2；「三四节」写 3 和 4；',
  '  「九十十一节」写 9 和 11。',
  '- weeks：周次原文，比如 "1-16"、"1-8"、"单周"、"双周"。看不到就写 ""。',
  '- teacher：可能多个，用逗号连接，原样保留。',
  '- room：教室或场地名。',
  '- noSlotCourses：课表底部单独列出、**没有具体星期和节次**的课（如军训、劳动教育、入学教育）。',
  '  这些只填 name / code / weeks。',
  '',
  '⚠️ 重要规则：',
  '1. 一格里的文字形如「课程名-教师@地点」，请拆成三个字段。',
  '2. 如果一格里有多个教师（用逗号分隔），teacher 里原样保留。',
  '3. 如果认不出某个格子，宁可不返回这一门，也不要编造。',
  '4. 如果整张图看不清、或者不是课程表，返回 {"courses":[],"noSlotCourses":[],"weekdayHeaderDetected":false,"periodColumnDetected":false,"confidence":0,"notes":"看不清"}',
  '5. weekdayHeaderDetected = 有没有认出「周一/周二…」这一行表头。',
  '6. periodColumnDetected = 有没有认出「一二节/三四节…」这一列行标题。',
].join('\n');

/**
 * 通用的一次 AI 调用：负责连接、错误分类、取回文本。
 *
 * 说明：recognizeFood 里有一段同样的逻辑没有迁过来 ——
 * 那是已经测通过的代码，不想为了「消除重复」而冒回归风险。
 * 新功能统一走这里。
 *
 * @returns {Promise<string>} 模型返回的原始文本
 */
async function requestAI({
  imageDataUrl, settings, systemPrompt, userText, fetchImpl = fetch, maxTokens = 2048,
}) {
  if (!imageDataUrl || !imageDataUrl.startsWith('data:image/')) {
    throw new AIError('NO_IMAGE', '没有拿到图片，请重新拍一张或选一张。');
  }
  if (!settings.aiConsent) {
    throw new AIError(
      'NO_CONSENT',
      '还没有同意把图片发给 AI。到「设置 → 拍照识别」里打开那个开关。',
      { userFixable: true, shouldFallback: false },
    );
  }

  const mode = settings.aiMode === 'direct' ? 'direct' : 'proxy';
  const headers = { 'Content-Type': 'application/json' };
  let url;

  if (mode === 'direct') {
    if (!settings.apiKey) {
      throw new AIError(
        'NO_API_KEY',
        '还没有填 API Key。到「设置 → 拍照识别」里填入你自己的 DeepSeek API Key。',
        { userFixable: true, shouldFallback: false },
      );
    }
    url = (settings.apiUrl && settings.apiUrl.trim()) || DEEPSEEK_DIRECT_URL;
    headers.Authorization = `Bearer ${settings.apiKey}`;
  } else {
    if (!settings.proxyUrl) {
      throw new AIError(
        'NO_PROXY_URL',
        '还没有填服务地址。到「设置 → 拍照识别」里填入管理员给你的网址。',
        { userFixable: true, shouldFallback: false },
      );
    }
    url = settings.proxyUrl.trim();
    if (settings.proxyCode) headers['X-Access-Code'] = settings.proxyCode;
  }

  const body = mode === 'proxy'
    ? JSON.stringify({
      image: imageDataUrl,
      saveData: settings.saveData === true,
      customPrompt: systemPrompt,
      customText: userText,
    })
    : JSON.stringify({
      model: VISION_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            {
              type: 'image_url',
              // ⚠️ 图片必须在 user 消息里，放 system/assistant 会 400
              image_url: { url: imageDataUrl, detail: settings.saveData ? 'low' : 'original' },
            },
          ],
        },
      ],
      response_format: { type: 'json_object' },
      max_tokens: maxTokens,
      temperature: 0.1,
    });

  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', headers, body });
  } catch (err) {
    throw new AIError('NETWORK', '网络请求失败，可能没联网或服务地址填错了。', { retryable: true });
  }

  let payload = null;
  try { payload = await response.json(); } catch (err) { payload = null; }

  if (!response.ok) {
    const code = payload && payload.code;
    const message = (payload && payload.error) || `服务返回错误 ${response.status}`;
    let friendly = message;

    if (mode === 'direct') {
      if (response.status === 401 || response.status === 403) friendly = 'API Key 无效或已过期，请到设置里检查。';
      else if (response.status === 402) friendly = 'DeepSeek 账户余额不足，请去充值。';
      else if (response.status === 429) friendly = '请求太频繁，等一会儿再试。';
    }

    throw new AIError(code || `HTTP_${response.status}`, friendly, {
      userFixable: code === 'BAD_ACCESS_CODE' || response.status === 401 || response.status === 403,
      retryable: true,
    });
  }

  const content = mode === 'proxy'
    ? payload && payload.content
    : payload && payload.choices && payload.choices[0]
      && payload.choices[0].message && payload.choices[0].message.content;

  if (!content || !String(content).trim()) {
    throw new AIError(
      'EMPTY_CONTENT',
      'AI 这次没有返回内容（已知的偶发问题），再点一次就好。',
      { retryable: true },
    );
  }

  return String(content);
}

/** 从 AI 返回的 JSON 里取出课表。容错：剥 markdown、补截断。 */
export function parseTimetableResult(raw) {
  if (!raw) return null;

  let text = String(raw).trim();

  // 剥掉 ```json ... ```
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  // 找到第一个 { 开始尝试解析
  const start = text.indexOf('{');
  if (start < 0) return null;

  const candidates = [text.slice(start)];

  // 补上被截断的右括号
  for (let extra = 1; extra <= 3; extra += 1) {
    candidates.push(text.slice(start) + '}'.repeat(extra));
  }

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === 'object') {
        const courses = Array.isArray(obj.courses) ? obj.courses : [];
        const noSlot = Array.isArray(obj.noSlotCourses) ? obj.noSlotCourses : [];
        return {
          courses,
          noSlotCourses: noSlot,
          weekdayHeaderDetected: obj.weekdayHeaderDetected !== false,
          periodColumnDetected: obj.periodColumnDetected !== false,
          confidence: typeof obj.confidence === 'number' ? obj.confidence : null,
          notes: typeof obj.notes === 'string' ? obj.notes : '',
        };
      }
    } catch (err) {
      /* 试下一个 */
    }
  }
  return null;
}

/**
 * 识别一张课程表图片。
 *
 * @param {Object} opts
 * @param {string} opts.imageDataUrl
 * @param {Object} opts.settings
 * @param {string} [opts.weekHint] 用户填的「这是第几周」，作为提示词辅助
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<{courses:Array, noSlotCourses:Array, meta:Object, raw:string}>}
 */
export async function recognizeTimetable({
  imageDataUrl, settings, weekHint = '', fetchImpl = fetch,
}) {
  const userText = weekHint
    ? `这是一张课程表。据用户说这是第 ${weekHint} 周。请按系统提示的 JSON 格式返回。`
    : '这是一张课程表。请按系统提示的 JSON 格式返回。';

  const raw = await requestAI({
    imageDataUrl,
    settings,
    systemPrompt: TIMETABLE_PROMPT,
    userText,
    fetchImpl,
    maxTokens: 3000,   // 课表可能十几门课，给足额度，否则 JSON 会被截断
  });

  const parsed = parseTimetableResult(raw);

  if (!parsed) {
    throw new AIError(
      'UNPARSABLE',
      'AI 返回的内容看不懂，再试一次可能会好。',
      { retryable: true },
    );
  }

  // 整张图没认出表头 → 很可能整体解析错了，直接拦下来
  if (!parsed.weekdayHeaderDetected || !parsed.periodColumnDetected) {
    throw new AIError(
      'NOT_A_TIMETABLE',
      '这张图里没有认出星期和节次，可能不是课程表、或者拍得太模糊。'
        + '请换一张更清晰的截图，或者用「导入文件」。',
      { retryable: true },
    );
  }

  if (parsed.courses.length === 0) {
    throw new AIError(
      'NO_COURSE',
      '没有识别出任何课程。请确认这张图是课表，并且格子里的字看得清。',
      { retryable: true },
    );
  }

  return {
    courses: parsed.courses,
    noSlotCourses: parsed.noSlotCourses,
    meta: {
      confidence: parsed.confidence,
      notes: parsed.notes,
      weekdayHeaderDetected: parsed.weekdayHeaderDetected,
      periodColumnDetected: parsed.periodColumnDetected,
    },
    raw,
  };
}
