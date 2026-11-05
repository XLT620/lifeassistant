/* ==========================================================================
   表格解析：把各种来源的课程表文本/文件，解析成统一的课程对象
   --------------------------------------------------------------------------
   支持的来源：
     · CSV / TSV（Excel 另存的、教务系统复制的）
     · 教务系统那种「网格表」（首列节次，表头是星期）
     · .ics 日历文件
     · .xlsx（Excel，用浏览器内置解压，不依赖任何第三方库）

   输出格式（所有来源统一）：
     { name, teacher, room, day, start, end, startPeriod, endPeriod,
       weeks, startWeek, endWeek, parity, noSlot }

   ⚠️ 这里最容易出错的是「单元格里塞了多种信息」。
      你的教务系统格式是：  课程名-教师@地点
      例子：国家安全教育-蒋荣华@厚德206
           珐琅书签DIY-吴献辉,吴艳芳,周晓惠@图书馆一楼研
           体育选项（一）|男|-赵谦@足球场1
      注意课程名里可能有 '-'、'|' 和逗号，所以**不能简单地全拆**。
   ========================================================================== */

import { PERIOD_TIMES, WEEKDAY_NAMES } from './constants.js';
import { timeToMinutes, minutesToTime } from './utils.js';

/* ============================================================ 小工具 */

const CN_NUM = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
  七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12,
};

/** 把「十一」这种中文数字转成 11 */
function cnToNumber(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (CN_NUM[s]) return CN_NUM[s];
  // 「十二」以外的两位数不常见，但顺手支持
  if (s === '十') return 10;
  if (s.startsWith('十') && CN_NUM[s.slice(1)]) return 10 + CN_NUM[s.slice(1)];
  return null;
}

/* ============================================================ 单元格拆分 */

/**
 * 从一个单元格文本里拆出 课程名 / 教师 / 地点。
 *
 * 规则：**从右往左，每个分隔符只拆一次**。
 *
 * 为什么不能从左或全拆：
 *   "体育选项（一）|男|-赵谦@足球场1"
 *     全拆 '-'  → ["体育选项（一）|男|", "@足球场1"] 会切错
 *     但我们其实想要 name="体育选项（一）|男|" teacher="赵谦" room="足球场1"
 *   所以：最右边的 '@' 右边一定是地点；剩下的最右边 '-' 右边一定是教师。
 *
 * @returns {{name, teacher, room}}
 */
export function parseCellText(raw) {
  // 统一全角符号
  let text = String(raw || '')
    .replace(/\u3000/g, ' ')
    .replace(/＠/g, '@')
    .replace(/[－—–]/g, '-')
    .replace(/\r?\n/g, ' ')
    .trim();

  if (!text) return { name: '', teacher: '', room: '' };

  let room = '';
  let teacher = '';
  let name = text;

  // 1. 最后一个 '@' → 地点
  const at = name.lastIndexOf('@');
  if (at > 0) {
    room = name.slice(at + 1).trim();
    name = name.slice(0, at).trim();
  }

  // 2. 剩下的最后一个 '-' → 教师
  //    但要注意：如果 '-' 后面是空字符串，说明只是尾随符号，不要当教师
  const dash = name.lastIndexOf('-');
  if (dash > 0) {
    const tail = name.slice(dash + 1).trim();
    const head = name.slice(0, dash).trim();
    // 只有「头尾都非空」且尾部像人名（不超过 24 字、不含 @ 和 ）才当教师
    if (head && tail && tail.length <= 24) {
      teacher = tail;
      name = head;
    }
  }

  // 3. 清理课程名里多余的分隔残留
  name = name.replace(/[-\s]+$/, '').trim();

  return { name, teacher, room };
}

/**
 * 解析周次文本。
 *
 * 真实教务系统里周次是**一串列表**，不是单个区间：
 *   "3-8周,12周"                      → 3-8 和 12（12 是单周！）
 *   "2-8周,12-19周"                   → 2-8 和 12-19
 *   "1周,7周,13-17周(单),18-20周"      → 1、7、13-17(单)、18-20
 *   "2-8周(双),12-18周(双)"            → 2-8(双)、12-18(双)
 *   "1-8周12-16周"                    → 1-8、12-16（中间没逗号）
 *   "1-16周(单)"、"1-16单"、"单周"、"双周"
 *
 * 以前的实现只抓「数字-数字」这种区间，会把 "," 后面的单个周次
 * （比如 "3-8周,12周" 里的 12 周）整个丢掉 —— 这是真实的漏课原因。
 *
 * @returns {{startWeek, endWeek, parity, ranges, raw}}
 *   parity: 'all' | 'odd'(单) | 'even'(双)
 *   ranges: [{from, to, parity}]，按 from 升序
 */
export function parseWeeks(raw) {
  const text = String(raw || '').trim();
  const result = {
    startWeek: 1, endWeek: 0, parity: 'all', ranges: [], raw: text,
  };
  if (!text) return result;

  const ranges = [];

  /*
   * 逐个抓「3-8」「12」「13-17(单)」这样的片段。
   * 注意 token 后面可能紧跟裸的「单」/「双」（"1-16单"），
   * 也可能紧跟括号（"1-16周(单)"）。
   */
  const tokenRe = /(\d{1,2})(?:\s*[-~－至]\s*(\d{1,2}))?\s*周?\s*(?:[（(]\s*([单双])\s*[)）])?/g;
  let m = tokenRe.exec(text);

  while (m !== null) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;

    if (Number.isFinite(a) && a >= 1 && a <= 30 && b >= 1 && b <= 30) {
      let parity = 'all';
      if (m[3] === '单') parity = 'odd';
      else if (m[3] === '双') parity = 'even';
      else {
        // 看紧跟着的是不是裸的「单」「双」（后面不是右括号，那种已经被上面的分组抓走了）
        const rest = text.slice(tokenRe.lastIndex);
        const bare = rest.match(/^\s*([单双])/);
        if (bare) parity = bare[1] === '单' ? 'odd' : 'even';
      }

      ranges.push({
        from: Math.min(a, b),
        to: Math.max(a, b),
        parity,
      });

      // 如果刚吃掉一个裸单/双，把匹配位置往前推，避免重复扫描
      if (!m[3]) {
        const rest = text.slice(tokenRe.lastIndex);
        const bare = rest.match(/^\s*([单双])/);
        if (bare) tokenRe.lastIndex += bare[0].length;
      }
    }

    m = tokenRe.exec(text);
  }

  // 一段都没有，但写了「单周」「双周」
  if (ranges.length === 0) {
    if (/单/.test(text) && !/双/.test(text)) result.parity = 'odd';
    else if (/双/.test(text) && !/单/.test(text)) result.parity = 'even';
    return result;
  }

  // 合并重复/相邻的段，并按起始周排序
  const merged = [];
  ranges
    .sort((x, y) => x.from - y.from)
    .forEach((r) => {
      const last = merged[merged.length - 1];
      if (last && last.parity === r.parity && r.from <= last.to + 1) {
        last.to = Math.max(last.to, r.to);
      } else {
        merged.push({ ...r });
      }
    });

  result.ranges = merged;
  result.startWeek = Math.min(...merged.map((r) => r.from));
  result.endWeek = Math.max(...merged.map((r) => r.to));

  // 顶层 parity：所有段一致才算单一含义
  const parities = new Set(merged.map((r) => r.parity));
  result.parity = parities.size === 1 ? [...parities][0] : 'all';

  return result;
}

/**
 * 从文本里认出星期几。
 * @returns {number|null} 0=周日 … 6=周六（与 Date.getDay() 一致）
 */
export function weekdayFromText(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  // 「周一」「星期一」「礼拜一」—— 注意「周日/周天/星期日」
  const cn = text.match(/(?:周|星期|礼拜)\s*([一二三四五六日天])/);
  if (cn) {
    const ch = cn[1];
    if (ch === '日' || ch === '天') return 0;
    const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
    return map[ch] ?? null;
  }

  // 纯中文「一」~「六」/「日」
  if (/^[一二三四五六日天]$/.test(text)) {
    if (text === '日' || text === '天') return 0;
    return { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }[text] ?? null;
  }

  // 英文
  const en = text.toLowerCase();
  const enMap = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const idx = enMap.findIndex((k) => en.startsWith(k));
  if (idx >= 0) return idx;
  if (en.startsWith('sunday')) return 0;
  for (let i = 0; i < 7; i += 1) {
    if (en.includes(enMap[i])) return i;
  }

  // 数字：1~7 表示周一到周日；0 表示周日
  const num = text.match(/^\d+$/);
  if (num) {
    const n = Number(text);
    if (n === 0) return 0;
    if (n >= 1 && n <= 7) return n === 7 ? 0 : n;
  }

  return null;
}

/**
 * 从文本里认出「第几节 ~ 第几节」。
 *   "一二节" → 1..2      "第3-4节" → 3..4
 *   "九十十一节" → 9..11  "1,2" → 1..2
 * @returns {{startPeriod, endPeriod}|null}
 */
export function periodsFromText(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  // 1. 「一二节」这种中文写法：抓出所有中文数字
  if (/[一二三四五六七八九十]/.test(text) && !/\d/.test(text)) {
    const chars = [];
    // 逐字扫，处理「十一」占两位
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '十' && text[i + 1] === '一') {
        chars.push(11);
        i += 1;
      } else if (text[i] === '十' && text[i + 1] === '二') {
        chars.push(12);
        i += 1;
      } else if (CN_NUM[text[i]]) {
        chars.push(CN_NUM[text[i]]);
      }
    }
    if (chars.length) {
      return { startPeriod: Math.min(...chars), endPeriod: Math.max(...chars) };
    }
  }

  // 2. 阿拉伯数字：「第3-4节」「3,4」「3-4」「(3,4)」
  const nums = (text.match(/\d{1,2}/g) || []).map(Number).filter((n) => n >= 1 && n <= 12);
  if (nums.length) {
    return { startPeriod: Math.min(...nums), endPeriod: Math.max(...nums) };
  }

  // 3. 混合：中文 + 数字
  const mixed = (text.match(/\d{1,2}/g) || []).map(Number);
  if (mixed.length) {
    return { startPeriod: Math.min(...mixed), endPeriod: Math.max(...mixed) };
  }

  return null;
}

/* ============================================================ 节次 → 时间 */

/** 节次换算成具体时间。换算不出来时返回 null。 */
export function periodToTime(startPeriod, endPeriod) {
  const s = PERIOD_TIMES.find((p) => p.period === Number(startPeriod));
  const e = PERIOD_TIMES.find((p) => p.period === Number(endPeriod));
  if (!s || !e) return null;
  return { start: s.start, end: e.end };
}

/**
 * 任何时间写法 → 'HH:MM'
 * 支持 "08:00" "8:00" "0800" "8" "8点" "上午8:00"
 */
function normalizeTime(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  const hm = text.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (hm) {
    const h = Number(hm[1]);
    const m = Number(hm[2]);
    if (h <= 23 && m <= 59) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  const hhmm = text.match(/^(\d{3,4})$/);
  if (hhmm) {
    const s = hhmm[1].padStart(4, '0');
    const h = Number(s.slice(0, 2));
    const m = Number(s.slice(2));
    if (h <= 23 && m <= 59) return `${s.slice(0, 2)}:${s.slice(2)}`;
  }

  const hourOnly = text.match(/^(\d{1,2})\s*[点时]/);
  if (hourOnly) {
    const h = Number(hourOnly[1]);
    if (h <= 23) return `${String(h).padStart(2, '0')}:00`;
  }

  return null;
}

/* ============================================================ 分隔文本 */

/** 猜分隔符：制表符优先（教务系统复制的就是 \t） */
function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 5);
  if (!lines.length) return '\t';
  const count = (ch) => lines.reduce((sum, l) => sum + (l.split(ch).length - 1), 0);
  const tabs = count('\t');
  const commas = count(',');
  const semis = count(';');
  if (tabs >= commas && tabs >= semis && tabs > 0) return '\t';
  if (semis > commas) return ';';
  return ',';
}

/**
 * 把文本切成二维数组。
 * 支持双引号包住的分隔符（CSV 标准）。
 */
export function splitTable(text) {
  const clean = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const delimiter = detectDelimiter(clean);

  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];

    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { cell += '"'; i += 1; } else { inQuotes = false; }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"' && cell === '') { inQuotes = true; continue; }
    if (ch === delimiter) { row.push(cell); cell = ''; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  row.push(cell);
  rows.push(row);

  // 去掉全空的行
  return rows
    .map((r) => r.map((c) => String(c).trim()))
    .filter((r) => r.some((c) => c !== ''));
}

/* ============================================================ 表头识别 */

/**
 * 在第几行是表头、每列是什么。
 * @returns {{headerRow:number, mapping:Object}}
 */
export function detectMapping(rows, keywords) {
  let best = { headerRow: -1, mapping: {}, score: 0 };

  for (let r = 0; r < Math.min(rows.length, 6); r += 1) {
    const row = rows[r];
    const mapping = {};
    let score = 0;

    row.forEach((cell, c) => {
      const text = String(cell).toLowerCase();
      if (!text) return;
      Object.keys(keywords).forEach((field) => {
        if (mapping[field] !== undefined) return;
        if (keywords[field].some((k) => text.includes(String(k).toLowerCase()))) {
          mapping[field] = c;
          score += 1;
        }
      });
    });

    if (score > best.score) best = { headerRow: r, mapping, score };
  }

  return best;
}

/* ============================================================ 网格表 */

/**
 * 从一段文字里抠出周次，并返回剩下的部分。
 *
 * 教务系统的格子里经常这样写：
 *   "劳动教育 3-8周"
 *   "形势与政策 第13-16周"
 *   "体育 1-16周(单)"
 * 提示词里周次是单独字段，但从表格文本来的往往混在一起，
 * 不拆的话课程名会变成「劳动教育 3-8周」。
 *
 * @returns {{text:string, weeks:string}}
 */
export function extractWeeks(raw) {
  let text = String(raw || '').trim();
  let weeks = '';

  const patterns = [
    /第?\s*\d{1,2}\s*[-~－至]\s*\d{1,2}\s*周(?:\s*[（(]\s*[单双]\s*[)）])?/,
    /第?\s*\d{1,2}\s*周(?:\s*[（(]\s*[单双]\s*[)）])?/,
    /[（(]?\s*[单双]周\s*[)）]?/,
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m && typeof m.index === 'number') {
      weeks = m[0].trim();
      text = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length))
        .replace(/\s{2,}/g, ' ')
        .trim();
      break;
    }
  }

  return { text, weeks };
}

/**
 * 解析「教务系统导出表格」里的一格。
 *
 * 真实格式（天麟校区 2026-2027-1 课表，教务处导出）：
 *
 *   劳动教育1/(1-2节)3-8周,12周/天麟校区科602/黄薏/1/16
 *   思想道德与法治/(1-2节)2-8周,12-19周/天麟校区科802/俞玥/3.0/48
 *   大学英语1/(3-4节)1周,7周,13-17周(单),18-20周天麟校区科602/苏靖辉/2.0/32
 *
 * 底部图例写的是：课程◇周次◇校区◇地点◇教师◇学分◇课程总学时
 *
 * 需要注意的坑（都是真实数据里出现过的）：
 *   · 一个格子里有多门课，用**换行**分隔
 *   · 周次和校区之间**可能没有 "/"**（"18-20周天麟校区科602"）
 *   · 节次写在括号里、紧贴周次："(1-2节)3-8周"
 *   · 周次是多段列表："3-8周,12周"（12 是单周）
 *   · 全角逗号："2-8周，12-19周"
 *   · 地点里带括号："经管楼201(营销业务综合实训室)"
 *
 * @param {string} raw 单元格原文
 * @returns {Array<{name,teacher,room,campus,startPeriod,endPeriod,weeks,credit,hours}>}
 */
export function parseEduCell(raw) {
  const text = String(raw || '').replace(/\r/g, '');
  if (!text.trim()) return [];

  // 一格多课：换行 / 分号分开
  const lines = text.split(/[\n；;]+/).map((s) => s.trim()).filter(Boolean);

  const out = [];
  lines.forEach((line) => {
    const one = parseEduLine(line);
    if (one) out.push(one);
  });
  return out;
}

/** 解析一行「课程名/(1-2节)3-8周/校区地点/教师/学分/学时」 */
function parseEduLine(line) {
  // 1. 节次：必须是「(数字-数字节)」才算这种格式
  const pm = line.match(/[（(]\s*(\d{1,2})\s*[-~－至]\s*(\d{1,2})\s*节\s*[)）]/);
  if (!pm) return null;

  const startPeriod = Number(pm[1]);
  const endPeriod = Number(pm[2]);
  if (!(startPeriod >= 1 && endPeriod >= startPeriod && endPeriod <= 20)) return null;

  // 2. 课程名 = 节次括号之前的部分（去掉结尾的 / 和空白）
  const name = line.slice(0, pm.index).replace(/[\/\s]+$/, '').trim();
  if (!name) return null;

  // 3. 节次之后是「周次…」，一直到下一个 "/" 或「XX校区」
  const rest = line.slice(pm.index + pm[0].length);

  // 抓出所有周次片段（3-8周 / 12周 / 13-17周(单) / 1-8周12-16周）
  const weekRe = /(\d{1,2})\s*[-~－至]\s*(\d{1,2})\s*周\s*(?:[（(]\s*[单双]\s*[)）])?|(\d{1,2})\s*周\s*(?:[（(]\s*[单双]\s*[)）])?/g;
  const weekParts = [];
  let wm = weekRe.exec(rest);
  let weekEnd = 0;
  while (wm !== null) {
    weekParts.push(wm[0]);
    weekEnd = wm.index + wm[0].length;
    wm = weekRe.exec(rest);
  }
  let weeks = weekParts.join(',');

  // 周次后面、到第一个 "/" 之前，可能是「校区+地点」（缺 "/" 的情况）
  let tailInline = '';
  if (weekEnd > 0) {
    const after = rest.slice(weekEnd);
    const firstSlash = after.indexOf('/');
    tailInline = (firstSlash >= 0 ? after.slice(0, firstSlash) : after).trim();
  }

  // 4. 剩下的字段按 "/" 拆
  const fields = line.split('/').map((s) => s.trim()).filter((s, i) => i === 0 || s !== '');

  /*
   * 字段数量不固定：
   *   6 段：课程 / 周次 / 校区地点 / 教师 / 学分 / 学时
   *   5 段：课程 / 周次+校区地点 / 教师 / 学分 / 学时
   * 从尾部往前数更稳：最后两个是「学分」「学时」（纯数字）。
   */
  let campusPlace = tailInline;
  let teacher = '';
  let credit = '';
  let hours = '';

  const tail = fields.slice(1);   // 去掉课程名那段
  const isNum = (s) => /^\d+(\.\d+)?$/.test(String(s || '').trim());

  let end = tail.length;
  if (end >= 2 && isNum(tail[end - 1]) && isNum(tail[end - 2])) {
    hours = tail[end - 1];
    credit = tail[end - 2];
    end -= 2;
  } else if (end >= 1 && isNum(tail[end - 1])) {
    hours = tail[end - 1];
    end -= 1;
  }

  if (end >= 2) {
    teacher = tail[end - 1];
    campusPlace = tail[end - 2] || campusPlace;
  } else if (end === 1) {
    // 只剩一段，可能是教师也可能是地点
    if (/校区|楼|场|馆|室|\d/.test(tail[0])) campusPlace = tail[0];
    else teacher = tail[0];
  }

  // 教师那一段可能还挂着「校区地点」（因为没有 "/" 分隔）
  if (teacher && /校区/.test(teacher) && teacher.indexOf('校区') > 0) {
    const idx = teacher.lastIndexOf('校区') + 2;
    campusPlace = teacher.slice(0, idx) + (campusPlace || '');
    teacher = teacher.slice(idx);
  }

  /*
   * 清洗地点字段。
   *
   * 有些格子没有 "/" 把「周次」和「校区地点」分开，比如：
   *   (3-4节)1周,7周,13-17周(单),18-20周天麟校区科602
   * 这时地点字段会连着节次和周次。把节次/周次片段剥掉，
   * 剩下的「天麟校区科602」才是地点。
   * 注意：像「经管楼201(营销业务综合实训室)」这种带数字和括号的
   * 真实地点不能被误删 —— 所以只剥「带节/周字」的片段。
   */
  campusPlace = String(campusPlace || '')
    .replace(/[（(]\s*\d{1,2}\s*[-~－至]\s*\d{1,2}\s*节\s*[)）]/g, '')
    .replace(/\d{1,2}\s*[-~－至]\s*\d{1,2}\s*周\s*(?:[（(]\s*[单双]\s*[)）])?/g, '')
    .replace(/\d{1,2}\s*周\s*(?:[（(]\s*[单双]\s*[)）])?/g, '')
    .replace(/^[,，、;；\s]+/, '')
    .trim();

  if (!campusPlace) campusPlace = String(tailInline || '').trim();

  // 5. 拆「校区 / 地点」
  let campus = '';
  let room = String(campusPlace || '').trim();
  const cm = room.match(/^(.{2,6}?校区)/);
  if (cm) {
    campus = cm[1];
    room = room.slice(cm[1].length).trim();
  }

  // 6. 没有抓到周次时，别把整段当周次
  if (!weeks) weeks = '';

  return {
    name,
    teacher: String(teacher || '').trim(),
    room: String(room || '').trim(),
    campus,
    startPeriod,
    endPeriod,
    weeks,
    credit,
    hours,
  };
}


/**
 * 判断一个单元格是不是「星期表头」。
 *
 * ⚠️ 必须整格精确匹配，不能用 weekdayFromText 那种「包含即可」的判断。
 * 真实反例：`大学英语1/…/18-20周天麟校区科602/…` 里有「周天」两个字，
 * 用包含判断会被当成「周日」，整门课就被当成表头丢掉了。
 */
function isWeekdayHeaderCell(raw) {
  return /^\s*(?:星期|周|礼拜)\s*[一二三四五六日天1-7]\s*(?:\d{1,2})?\s*$/.test(String(raw || ''));
}

/**
 * 判断是不是「教务系统网格表」：表头有 3 个以上星期，且能找到节次。
 *
 * ⚠️ 节次不一定在第 1 列。真实表格常常是：
 *      A 列 = 上午 / 下午 / 晚上   B 列 = 二 / 三 / 四 / 五   C 列起才是星期
 *   所以要在**前 3 列**里找节次，不能只看第 0 列。
 */
export function looksLikeMatrix(rows) {
  for (let r = 0; r < Math.min(rows.length, 4); r += 1) {
    const row = rows[r];
    const dayHits = row.filter((c) => isWeekdayHeaderCell(c)).length;
    if (dayHits < 3) continue;

    // 表头下面几行里，前 3 列中能找到节次标签，或者格子里带「(1-2节)」
    const bodyRows = rows.slice(r + 1, r + 5);
    const hasPeriodLabel = bodyRows.some((b) => {
      for (let k = 0; k < Math.min(3, b.length); k += 1) {
        if (periodsFromText(b[k]) !== null) return true;
      }
      return false;
    });
    const hasPeriodInCell = bodyRows.some((b) => b.some(
      (c) => /[（(]\s*\d{1,2}\s*[-~－至]\s*\d{1,2}\s*节\s*[)）]/.test(String(c || '')),
    ));

    if (hasPeriodLabel || hasPeriodInCell) return true;
  }
  return false;
}

/**
 * 解析网格表。
 * @param {string[][]} rows
 * @returns {Array} 课程对象数组
 */
export function parseMatrix(rows) {
  // 1. 找表头行
  let headerRow = -1;
  let colDay = {};
  for (let r = 0; r < Math.min(rows.length, 4); r += 1) {
    const hits = rows[r].filter((c) => isWeekdayHeaderCell(c)).length;
    if (hits >= 3) {
      headerRow = r;
      rows[r].forEach((cell, c) => {
        const d = weekdayFromText(cell);
        if (d !== null) colDay[c] = d;
      });
      break;
    }
  }
  if (headerRow < 0) return [];

  // 2. 逐行读
  //    首列不一定是节次 —— 真实表格里 A 列是「上午/下午/晚上」，
  //    B 列才是「二/三/四/五」。所以要在前 3 列里找节次标签。
  const out = [];
  for (let r = headerRow + 1; r < rows.length; r += 1) {
    const row = rows[r];

    let rowPeriods = null;
    for (let k = 0; k < Math.min(3, row.length); k += 1) {
      const p = periodsFromText(row[k]);
      if (p) { rowPeriods = p; break; }
    }

    Object.keys(colDay).forEach((colKey) => {
      const c = Number(colKey);
      const text = (row[c] || '').trim();
      if (!text) return;

      /*
       * 单元格本身就是「星期三」这种表头文字 → 跳过。
       * 多工作表合并时，第二个表的表头会落在数据区，不挡掉就会
       * 变出「星期一」「星期二」这样的假课程。
       */
      if (isWeekdayHeaderCell(text)) return;

      /*
       * ★ 优先用「教务系统一格一课的原始格式」解析：
       *     课程名/(1-2节)3-8周,12周/天麟校区科602/黄薏/1/16
       *   这种格式里节次、周次、教师、地点都在格子里，最可靠。
       *   它的节次来自格子内部，比行首的「二/三/四」准。
       */
      const edu = parseEduCell(text);
      if (edu.length) {
        edu.forEach((item) => {
          out.push(makeCourse({
            ...item,
            day: colDay[c],
            weeks: parseWeeks(item.weeks),
          }));
        });
        return;
      }

      // 兜底：老格式（课程名-教师@地点，节次靠行首）
      if (!rowPeriods) return;

      const parts = text
        .split(/[；;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);

      parts.forEach((part) => {
        const { text: rest, weeks } = extractWeeks(part);
        const parsed = parseCellText(rest);
        if (!parsed.name) return;
        /*
         * 课程名里至少要有一个中文字或字母。
         * 否则「1-2节」「3.0」「08:00」这类纯数字/标点会被当成课程名，
         * 生成一堆假课程（多工作表时特别容易出现）。
         */
        if (!/[\u4e00-\u9fa5A-Za-z]/.test(parsed.name)) return;
        out.push(makeCourse({
          ...parsed,
          day: colDay[c],
          startPeriod: rowPeriods.startPeriod,
          endPeriod: rowPeriods.endPeriod,
          weeks: weeks ? parseWeeks(weeks) : null,
        }));
      });
    });
  }

  return out;
}

/* ============================================================ 普通表格 */

/**
 * 解析「一行一门课」的表格，按 mapping 取列。
 */
export function parseTable(rows, mapping, headerRow) {
  const out = [];
  const start = headerRow >= 0 ? headerRow + 1 : 0;

  for (let r = start; r < rows.length; r += 1) {
    const row = rows[r];
    const get = (field) => (mapping[field] !== undefined ? (row[mapping[field]] || '').trim() : '');

    const rawName = get('name');
    if (!rawName) continue;

    let day = weekdayFromText(get('day'));
    let periods = periodsFromText(get('period'));
    let startTime = normalizeTime(get('start'));
    let endTime = normalizeTime(get('end'));

    // 如果「开始」那一列其实是节次（如 "第3节"），也认
    if (!periods && !startTime) periods = periodsFromText(get('start'));
    if (!startTime && get('start')) startTime = normalizeTime(get('start'));

    // 星期列可能是空的，但时间列里写了「周一」
    if (day === null) day = weekdayFromText(get('start')) ?? weekdayFromText(get('end'));

    if (day === null) day = 1;   // 认不出来就默认周一，导入前用户能看到并改

    const cell = parseCellText(rawName);
    const weeks = parseWeeks(get('weeks'));

    out.push(makeCourse({
      name: cell.name || rawName,
      teacher: get('teacher') || cell.teacher,
      room: get('location') || cell.room,
      day,
      startPeriod: periods ? periods.startPeriod : null,
      endPeriod: periods ? periods.endPeriod : null,
      start: startTime || undefined,
      end: endTime || undefined,
      weeks,
    }));
  }

  return out;
}

/* ============================================================ 统一成形 */

/**
 * 把各种来源的原始字段，整理成一个标准课程对象。
 * 补齐时间、单双周、默认值。
 */
export function makeCourse(input) {
  const day = Number.isFinite(input.day) ? Number(input.day) : 1;

  let start = input.start;
  let end = input.end;
  let startPeriod = input.startPeriod ?? null;
  let endPeriod = input.endPeriod ?? null;

  // 没有具体时间时用节次换算
  if ((!start || !end) && startPeriod && endPeriod) {
    const t = periodToTime(startPeriod, endPeriod);
    if (t) { start = t.start; end = t.end; }
  }

  // 有节次但没记结束节次时，至少把开始节次补全
  if (startPeriod && !endPeriod) endPeriod = startPeriod;

  const weeks = input.weeks || null;

  return {
    name: String(input.name || '').trim(),
    teacher: String(input.teacher || '').trim(),
    room: String(input.room || '').trim(),
    day,
    start: start || '',
    end: end || '',
    startPeriod,
    endPeriod,
    weeks: weeks ? weeks.raw : '',
    startWeek: weeks ? weeks.startWeek : 1,
    endWeek: weeks ? weeks.endWeek : 0,
    parity: weeks ? weeks.parity : 'all',
    /** 分段的周次规则（"1-8单,9-16双" 会有两段）；空数组表示用 startWeek/endWeek/parity */
    weeksRanges: weeks && Array.isArray(weeks.ranges) ? weeks.ranges : [],
    noSlot: Boolean(input.noSlot),
    code: String(input.code || '').trim(),
    /** AI 识别的把握（0~1）；本地解析恒为 1 */
    confidence: typeof input.confidence === 'number' ? input.confidence : 1,
  };
}

/** 这门课在第 week 周上不上？ */
export function isCourseInWeek(course, week) {
  const w = Number(week);

  /** 单双周判断 */
  const parityOk = (parity) => {
    if (parity === 'odd') return w % 2 === 1;
    if (parity === 'even') return w % 2 === 0;
    return true;
  };

  // 有分段规则时按分段判断（"1-8单,9-16双" 这类）
  const ranges = course.weeksRanges;
  if (Array.isArray(ranges) && ranges.length) {
    return ranges.some((r) => w >= Number(r.from) && w <= Number(r.to) && parityOk(r.parity));
  }

  const sw = Number(course.startWeek) || 1;
  const ew = Number(course.endWeek) || 0;

  // endWeek 为 0 表示「整学期」——不限制
  if (ew > 0 && (w < sw || w > ew)) return false;

  return parityOk(course.parity);
}

/* ============================================================ ICS */

/** 解析 .ics 日历文件 */
export function parseICS(text) {
  const src = String(text || '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');  // 拆开折行
  const out = [];

  const events = src.split('BEGIN:VEVENT').slice(1);

  events.forEach((block) => {
    const get = (key) => {
      const m = block.match(new RegExp(`${key}[^:\\n]*[:]([^\\n]*)`, 'i'));
      return m ? m[1].trim() : '';
    };

    const summary = get('SUMMARY');
    if (!summary) return;

    const dtstart = get('DTSTART');
    const dtend = get('DTEND');
    const location = get('LOCATION');
    const rrule = get('RRULE');

    const parsed = parseICSDateTime(dtstart);
    const parsedEnd = parseICSDateTime(dtend);

    // 周次来自 RRULE 的 COUNT 或 UNTIL
    let weeks = null;
    const countMatch = rrule.match(/COUNT=(\d+)/i);
    if (countMatch) {
      weeks = { startWeek: 1, endWeek: Number(countMatch[1]), parity: 'all', raw: `1-${countMatch[1]}` };
    }
    const byDayOdd = /BYDAY=.*/i.test(rrule) ? null : null;

    const cell = parseCellText(summary);

    out.push(makeCourse({
      name: cell.name || summary,
      teacher: cell.teacher,
      room: cell.room || location,
      day: parsed ? parsed.day : 1,
      start: parsed ? parsed.time : undefined,
      end: parsedEnd ? parsedEnd.time : undefined,
      weeks,
    }));
    if (byDayOdd) { /* 预留：更复杂的重复规则 */ }
  });

  return out;
}

/** '20260901T080000Z' → { day, time } */
function parseICSDateTime(value) {
  const m = String(value || '').match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return {
    day: d.getDay(),
    time: m[4] ? `${m[4]}:${m[5] || '00'}` : '',
  };
}

/* ============================================================ XLSX */

/**
 * 解析 .xlsx —— 用浏览器内置的 DecompressionStream 解 ZIP，不引入第三方库。
 *
 * xlsx 的本质：一个 ZIP 包，里面是 XML。
 *    xl/sharedStrings.xml   所有文本（单元格用序号引用它）
 *    xl/worksheets/sheet1.xml  表格结构
 *
 * 为什么不用 SheetJS：它几百 KB，还会打破「零外部依赖、可离线」的约束。
 */
export async function parseXLSX(arrayBuffer) {
  const files = await unzip(new Uint8Array(arrayBuffer));

  const decoder = new TextDecoder('utf-8');

  // ---- 共享字符串
  const sharedRaw = files.get('xl/sharedStrings.xml');
  let shared = [];
  if (sharedRaw) {
    const xml = decoder.decode(sharedRaw);
    shared = [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => {
      // <si> 里可能有多个 <r><t>，要把所有 <t> 拼起来
      const texts = [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]);
      return decodeXmlText(texts.join(''));
    });
  }

  // ---- 找出所有工作表
  const sheetPaths = [...files.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number((a.match(/(\d+)\.xml$/) || [0, 0])[1])
      - Number((b.match(/(\d+)\.xml$/) || [0, 0])[1]));

  if (!sheetPaths.length) throw new Error('这个 Excel 里没有工作表');

  /*
   * 一个 xlsx 里可能有好几个工作表：
   *   第 1 个是课表、第 2 个是作息时间表、第 3 个是别的班级的课表…
   * 以前只读 sheet1，多表的文件会被漏掉一半课。
   *
   * 现在的做法：每个表都解析，但**只合并「看起来像课表」的表**
   * （前 6 行里出现 3 个以上星期表头）。这样作息表、说明页不会污染课程。
   * 如果一个像课表的都没有，就退回「只读第一个表」。
   */
  const parsed = sheetPaths.map((p) => ({
    path: p,
    rows: parseSheetXml(decoder.decode(files.get(p)), shared),
  }));

  const looksLikeTable = (rows) => {
    let hits = 0;
    for (let r = 0; r < Math.min(rows.length, 6); r += 1) {
      hits += rows[r].filter((c) => isWeekdayHeaderCell(c)).length;
      if (hits >= 3) return true;
    }
    return false;
  };

  const blocks = parsed.filter((b) => looksLikeTable(b.rows));
  const use = blocks.length ? blocks : [parsed[0]];

  if (use.length === 1) return use[0].rows;

  // 多个工作表合并：中间插一行空行，避免表头/数据串到一起
  const merged = [];
  use.forEach((b, i) => {
    if (i > 0) merged.push([]);
    b.rows.forEach((row) => merged.push(row));
  });
  return merged;
}

function parseSheetXml(xml, shared) {
  const rows = [];

  const rowMatches = [...xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)];

  rowMatches.forEach((rm) => {
    const rowAttrs = rm[1];
    const rowIndex = Number((rowAttrs.match(/r="(\d+)"/) || [])[1]) || rows.length + 1;
    const cells = [];

    const cellMatches = [...rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)];
    cellMatches.forEach((cm) => {
      const attrs = cm[1];
      const inner = cm[2] || '';

      const refMatch = attrs.match(/r="([A-Z]+)(\d+)"/);
      const colIndex = refMatch ? colLetterToIndex(refMatch[1]) : cells.length;

      const typeMatch = attrs.match(/t="([^"]+)"/);
      const type = typeMatch ? typeMatch[1] : 'n';

      let value = '';

      if (type === 's') {
        const v = inner.match(/<v>([\s\S]*?)<\/v>/);
        if (v) value = shared[Number(v[1])] || '';
      } else if (type === 'inlineStr') {
        const texts = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]);
        value = decodeXmlText(texts.join(''));
      } else {
        const v = inner.match(/<v>([\s\S]*?)<\/v>/);
        value = v ? decodeXmlText(v[1]) : '';
      }

      cells[colIndex] = String(value).trim();
    });

    // 补成连续的数组
    const clean = [];
    for (let i = 0; i < cells.length; i += 1) clean[i] = cells[i] || '';
    if (clean.some((c) => c !== '')) {
      rows[rowIndex - 1] = clean;
    }
  });

  // 补齐空洞
  for (let i = 0; i < rows.length; i += 1) if (!rows[i]) rows[i] = [];
  return rows.filter((r) => r.some((c) => c !== ''));
}

/**
 * 解码 XML 里的实体。
 *
 * ⚠️ 必须处理**数字字符引用**（`&#26376;`）。
 *   Excel（以及 openpyxl）写非 ASCII 字符时经常用这种形式，
 *   例如「月」会写成 `&#26376;`。只处理 &amp; 这类命名实体是不够的 ——
 *   那样解出来的全是 `&#26376;` 这样的原始字符串，中文一个都认不出。
 */
function decodeXmlText(s) {
  return String(s)
    // 十六进制数字实体：&#x6708;
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch (e) { return ''; }
    })
    // 十进制数字实体：&#26376;
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(Number(dec)); } catch (e) { return ''; }
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // &amp; 放最后，避免把 &amp;#26376; 先解成 &#26376;
    .replace(/&amp;/g, '&');
}

/** 'A' → 0, 'B' → 1, 'AA' → 26 */
function colLetterToIndex(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i += 1) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n - 1;
}

/**
 * 解 ZIP（只处理 xlsx 会用到的两种压缩方式）。
 * 返回 Map<路径, Uint8Array>
 */
async function unzip(bytes) {
  const files = new Map();

  // 从尾部找中央目录结束记录（EOCD）
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i -= 1) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('这不是一个有效的 Excel 文件（ZIP 结构没找到）');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  for (let n = 0; n < total; n += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;

    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);

    const nameBytes = bytes.slice(offset + 46, offset + 46 + nameLen);
    const name = new TextDecoder('utf-8').decode(nameBytes);

    // 读本地头，拿到真正的数据起点
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = bytes.slice(dataStart, dataStart + compSize);

    // eslint-disable-next-line no-await-in-loop
    files.set(name, method === 0 ? raw : await inflateRaw(raw));

    offset += 46 + nameLen + extraLen + commentLen;
  }

  return files;
}

async function inflateRaw(data) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('这个浏览器不支持解压 xlsx，请在 Excel 里另存为 CSV 再导入');
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ============================================================ 总入口 */

/**
 * 从「作息时间表」的文字里读出每节课的时间。
 *
 * 真实作息表长这样（天麟校区 表2）：
 *   1  上午  第一节  08:00-08:45
 *   2        第二节  08:55-09:40   课间10分钟
 *   ...
 *   5  下午  第五节  14:30-15:15
 *
 * 只要能解析出「第几节 → 几点到几点」，周视图的时间轴和课前提醒
 * 就会用学校的真实作息，而不是内置默认值。
 *
 * @returns {Array<{period:number, start:string, end:string}>}
 */
export function parsePeriodTimes(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let seq = 0;

  const cnNum = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const cnPeriod = (s) => {
    if (!s) return null;
    if (/^\d{1,2}$/.test(s)) return Number(s);
    // 十一、十二 这种
    if (s.length === 2 && s[0] === '十' && cnNum[s[1]]) return 10 + cnNum[s[1]];
    if (s.length === 3 && s[0] === '十' && s[1] === '十') return null;
    if (s[0] === '十' && s[1] === '一') return 11;
    if (s[0] === '十' && s[1] === '二') return 12;
    return cnNum[s] || null;
  };

  lines.forEach((line) => {
    const tm = line.match(/(\d{1,2})\s*[:：]\s*(\d{2})\s*[-~－至—]\s*(\d{1,2})\s*[:：]\s*(\d{2})/);
    if (!tm) return;

    const start = `${String(Number(tm[1])).padStart(2, '0')}:${tm[2]}`;
    const end = `${String(Number(tm[3])).padStart(2, '0')}:${tm[4]}`;

    const pm = line.match(/第\s*([一二三四五六七八九十\d]{1,3})\s*节/);
    seq += 1;
    const period = (pm && cnPeriod(pm[1])) || seq;

    out.push({ period, start, end });
  });

  // 去重（同一节出现两次取第一条）并按节次排序
  const seen = new Map();
  out.forEach((p) => { if (!seen.has(p.period)) seen.set(p.period, p); });
  return [...seen.values()].sort((a, b) => a.period - b.period);
}

/**
 * 从课表的页脚/抬头里读出「学期信息」。
 *
 * 真实课表底部一般写着：
 *   本学期2026-08-31正式上课至2027-01-17结束，共20周
 * 这正好是 App 需要的两个日期 + 总周数，能省掉用户自己填。
 *
 * @returns {{termStartDate:string, totalWeeks:number}|null}
 */
export function parseSemesterInfo(text) {
  const src = String(text || '');
  const out = {};

  const start = src.match(/(\d{4})\s*[-./年]\s*(\d{1,2})\s*[-./月]\s*(\d{1,2})\s*日?\s*(?:正式)?(?:上课|开学)/);
  if (start) {
    out.termStartDate = `${start[1]}-${String(start[2]).padStart(2, '0')}-${String(start[3]).padStart(2, '0')}`;
  }

  /*
   * 总周数：不能只取第一个「共 N 周」。
   * 真实课表里「实践课程: 军事技能黄薏(共3周)」会排在前面，
   * 第一个匹配到的是 3 周，不是学期总周数。
   * 所以把所有「共 N 周」都扫一遍，取落在合理范围（8~30）里的那个。
   */
  const totalRe = /共\s*(\d{1,2})\s*周/g;
  let tm = totalRe.exec(src);
  let best = null;
  while (tm !== null) {
    const n = Number(tm[1]);
    if (n >= 8 && n <= 30) best = n;
    tm = totalRe.exec(src);
  }
  if (best) out.totalWeeks = best;

  return Object.keys(out).length ? out : null;
}

/**
 * 读出课表底部的「实践课程」（没有固定星期节次的那种）。
 *   实践课程: 军事技能黄薏(共3周)/9-11周;
 */
function parsePracticeLines(rows) {
  const out = [];
  rows.forEach((row) => {
    const line = row.join(' ').trim();
    if (!/^实践课程|实践课\s*[:：]/.test(line)) return;

    // 去掉「实践课程:」前缀
    let body = line.replace(/^实践课程\s*[:：]?/, '').trim();

    // 周次从行里抠出来
    const weeks = (body.match(/(\d{1,2}\s*[-~－至]\s*\d{1,2}\s*周(?:\s*[,，]\s*\d{1,2}\s*周)*)/) || [])[1] || '';
    body = body.replace(weeks, ' ').trim();

    // 名字：去掉结尾的括号说明（(共3周)）和教师名（中文 2~4 字）
    body = body.replace(/[（(][^)）]*[)）]/g, ' ').replace(/[\/；;]+$/, '').trim();

    // 「军事技能黄薏」→ 名字里很难切出教师，保留原文当课程名更安全
    const name = body.split(/\s+/)[0];
    if (!name) return;

    out.push({ name, weeks });
  });
  return out;
}

/**
 * 统一入口：一段文本 → 课程数组。
 * 自动判断是「网格表」还是「一行一门课」。
 *
 * @param {string} text
 * @param {Object} keywords COLUMN_KEYWORDS
 * @returns {{courses:Array, kind:string, semester:Object|null}}
 */
export function parseText(text, keywords) {
  const rows = splitTable(text);
  if (!rows.length) return { courses: [], kind: 'empty', semester: null };

  // .ics 内容也走文本，先认一下
  if (/BEGIN:VCALENDAR/i.test(text)) {
    return { courses: parseICS(text), kind: 'ics', semester: null };
  }

  // 底部「实践课程」：没有固定时间，单独收集
  const practice = parsePracticeLines(rows);
  const semester = parseSemesterInfo(text);

  const withPractice = (courses) => courses.concat(practice.map((p) => makeCourse({
    name: p.name,
    room: '',
    teacher: '',
    day: 1,
    weeks: p.weeks ? parseWeeks(p.weeks) : null,
    noSlot: true,
    confidence: 0.7,
  })));

  if (looksLikeMatrix(rows)) {
    return { courses: withPractice(parseMatrix(rows)), kind: 'matrix', semester };
  }

  const { headerRow, mapping, score } = detectMapping(rows, keywords);

  // 表头认得太少（低于 2 列）→ 当成「没有表头，按位置猜」
  if (score < 2) {
    return {
      courses: withPractice(parseTable(rows, guessMappingByContent(rows), -1)),
      kind: 'position',
      semester,
    };
  }

  return {
    courses: withPractice(parseTable(rows, mapping, headerRow)),
    kind: 'table',
    semester,
  };
}

/**
 * 没有表头时，按每列的内容特征猜它是干什么的。
 * 只是兜底，猜错用户在确认页能改。
 */
function guessMappingByContent(rows) {
  const sample = rows.slice(0, 8);
  const width = Math.max(...sample.map((r) => r.length));
  const mapping = {};

  for (let c = 0; c < width; c += 1) {
    const values = sample.map((r) => r[c] || '').filter(Boolean);
    if (!values.length) continue;

    const dayHits = values.filter((v) => weekdayFromText(v) !== null).length;
    const timeHits = values.filter((v) => normalizeTime(v) || /点/.test(v)).length;
    const periodHits = values.filter((v) => periodsFromText(v) !== null).length;
    const weekHits = values.filter((v) => /\d+\s*[-~]\s*\d+/.test(v)).length;
    const roomHits = values.filter((v) => /[@楼室馆场]/.test(v)).length;

    if (dayHits / values.length > 0.6 && mapping.day === undefined) { mapping.day = c; continue; }
    if (periodHits / values.length > 0.6 && mapping.period === undefined) { mapping.period = c; continue; }
    if (timeHits / values.length > 0.6) {
      if (mapping.start === undefined) mapping.start = c;
      else if (mapping.end === undefined) mapping.end = c;
      continue;
    }
    if (weekHits / values.length > 0.6 && mapping.weeks === undefined) { mapping.weeks = c; continue; }
    if (roomHits / values.length > 0.8 && mapping.location === undefined) { mapping.location = c; continue; }
    if (mapping.name === undefined) mapping.name = c;
  }

  if (mapping.name === undefined) mapping.name = 0;
  return mapping;
}

/** 给外面用的：把 'HH:MM' 的两个时间算成分钟，方便算空档 */
export function toMinutes(t) {
  return timeToMinutes(t);
}

export { normalizeTime, minutesToTime, WEEKDAY_NAMES };
