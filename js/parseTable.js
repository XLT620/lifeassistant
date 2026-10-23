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
 * 支持的写法（教务系统里都真实出现过）：
 *   "1-16"    "1-16周"    "第1-16周"    "1~16"
 *   "1-16单"  "1-16周(单)"  "单周"   "双周"
 *   "1-8单,9-16双"（混合，用 ranges 表达）
 * @returns {{startWeek, endWeek, parity, ranges, raw}}
 *   parity: 'all' | 'odd'(单) | 'even'(双)
 *   ranges: [{from, to, parity}]，混合规则时有多段
 */
export function parseWeeks(raw) {
  const text = String(raw || '').trim();
  const result = {
    startWeek: 1, endWeek: 0, parity: 'all', ranges: [], raw: text,
  };
  if (!text) return result;

  /* ---- 找出所有数字区间 ---- */
  const ranges = [];
  const rangeRe = /(\d{1,2})\s*[-~－至]\s*(\d{1,2})/g;
  let m = rangeRe.exec(text);
  while (m) {
    ranges.push({ from: Number(m[1]), to: Number(m[2]), parity: 'all' });
    m = rangeRe.exec(text);
  }

  if (ranges.length === 0) {
    const single = text.match(/\d{1,2}/);
    if (single) {
      const n = Number(single[0]);
      ranges.push({ from: n, to: n, parity: 'all' });
    }
  }

  /* ---- 单双周标记 ----
     注意不能只匹配「单周」：
     真实数据里经常写成「1-16单」「1-16(单)」「单」，
     这些都不带「周」字。                                              */
  const hasOdd = /单|odd/i.test(text);
  const hasEven = /双|even/i.test(text);

  if (ranges.length === 0) {
    // 只有「单周」「双周」这种，没有具体数字 → 从现在起整学期
    if (hasOdd && !hasEven) result.parity = 'odd';
    else if (hasEven && !hasOdd) result.parity = 'even';
    return result;
  }

  /* ---- 给每段分配单双周 ----
     一段 → 整段同一种；
     多段（"1-8单,9-16双"）→ 按段序交替/按就近的标记判断。
     简化策略：如果同时出现单和双，就把标记按出现顺序分配给各段。 */
  if (hasOdd && hasEven) {
    const oddPos = text.search(/单|odd/i);
    const evenPos = text.search(/双|even/i);
    // 单在前 → 第一段单、第二段双；反之相反
    ranges.forEach((r, i) => {
      if (ranges.length === 1) {
        r.parity = 'all';     // 一段里既写单又写双，只能当每周
      } else if (oddPos < evenPos) {
        r.parity = i % 2 === 0 ? 'odd' : 'even';
      } else {
        r.parity = i % 2 === 0 ? 'even' : 'odd';
      }
    });
    result.parity = 'all';    // 顶层标记不再有单一含义
  } else if (hasOdd) {
    ranges.forEach((r) => { r.parity = 'odd'; });
    result.parity = 'odd';
  } else if (hasEven) {
    ranges.forEach((r) => { r.parity = 'even'; });
    result.parity = 'even';
  }

  result.ranges = ranges;
  result.startWeek = Math.min(...ranges.map((r) => r.from));
  result.endWeek = Math.max(...ranges.map((r) => r.to));
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
 * 判断是不是「教务系统网格表」：表头是星期，首列是节次。
 */
export function looksLikeMatrix(rows) {
  for (let r = 0; r < Math.min(rows.length, 4); r += 1) {
    const row = rows[r];
    const dayHits = row.filter((c) => weekdayFromText(c) !== null).length;
    if (dayHits >= 3) {
      // 还要确认后面几行的首列像节次
      const bodyRows = rows.slice(r + 1, r + 4);
      const periodHits = bodyRows.filter((b) => periodsFromText(b[0]) !== null).length;
      if (periodHits >= 1) return true;
    }
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
    const hits = rows[r].filter((c) => weekdayFromText(c) !== null).length;
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

  // 2. 逐行读（首列是节次）
  const out = [];
  for (let r = headerRow + 1; r < rows.length; r += 1) {
    const row = rows[r];
    const periods = periodsFromText(row[0]);
    if (!periods) continue;

    Object.keys(colDay).forEach((colKey) => {
      const c = Number(colKey);
      const text = (row[c] || '').trim();
      if (!text) return;

      // 一个格子里可能压着多门课（各上不同周次），常见分隔：
      //   换行、分号、「；」，也有用全角空格隔开的。
      const parts = text
        .split(/[；;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);

      parts.forEach((part) => {
        // 先把「3-8周」这类周次从文字里抠出来，剩下的才是课程名
        const { text: rest, weeks } = extractWeeks(part);
        const parsed = parseCellText(rest);
        if (!parsed.name) return;
        out.push(makeCourse({
          ...parsed,
          day: colDay[c],
          startPeriod: periods.startPeriod,
          endPeriod: periods.endPeriod,
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

  // ---- 找第一个工作表
  let sheetPath = 'xl/worksheets/sheet1.xml';
  if (!files.has(sheetPath)) {
    const found = [...files.keys()].find((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
    if (!found) throw new Error('这个 Excel 里没有工作表');
    sheetPath = found;
  }

  const sheetXml = decoder.decode(files.get(sheetPath));
  return parseSheetXml(sheetXml, shared);
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
 * 统一入口：一段文本 → 课程数组。
 * 自动判断是「网格表」还是「一行一门课」。
 *
 * @param {string} text
 * @param {Object} keywords COLUMN_KEYWORDS
 * @returns {{courses:Array, kind:string}}
 */
export function parseText(text, keywords) {
  const rows = splitTable(text);
  if (!rows.length) return { courses: [], kind: 'empty' };

  // .ics 内容也走文本，先认一下
  if (/BEGIN:VCALENDAR/i.test(text)) {
    return { courses: parseICS(text), kind: 'ics' };
  }

  if (looksLikeMatrix(rows)) {
    return { courses: parseMatrix(rows), kind: 'matrix' };
  }

  const { headerRow, mapping, score } = detectMapping(rows, keywords);

  // 表头认得太少（低于 2 列）→ 当成「没有表头，按位置猜」
  if (score < 2) {
    return { courses: parseTable(rows, guessMappingByContent(rows), -1), kind: 'position' };
  }

  return { courses: parseTable(rows, mapping, headerRow), kind: 'table' };
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
