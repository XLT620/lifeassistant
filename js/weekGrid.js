/* ==========================================================================
   周视图
   --------------------------------------------------------------------------
   把课程画成一张真正的课表：7 天 × 一整天。

   ## 为什么按「时间」而不是按「节次」排版（v3.2 的重要改动）

   第一版用「每节等高 36px」的行来摆课程块。结果是：
   08:00–09:40 和 10:00–11:40 两块**无缝贴在一起**，
   看起来像连上 4 节；午休的 2 小时完全消失 —— 这就是「和显示时间对不上」。

   现在改成**按真实时间比例**摆放：
     · 08:00 在最上，22:30 在最下
     · 一块课的 top / height 直接由它的开始/结束时间算出
     · 午休、晚饭这种长间隔压缩成一条细带
       （否则一天 14 小时摊在 400px 里，一节课只有 20px 高，字放不下）

   这样「课程块的位置」和「课程的时间」在定义上就不可能对不上。
   课程块里还直接写着起止时间，可以对一眼验证。

   ## 基准日期要用「课表开始执行的那一周」

   教务处说的开学周 ≠ 课表第 1 周（中间可能夹军训）。
   所以日期用 timetableStartDate，而不是 termStartDate。
   ========================================================================== */

import { el, clear, timeToMinutes } from './utils.js';
import { WEEKDAY_NAMES, WEEKDAY_SHORT, PERIOD_TIMES } from './constants.js';
import { isCourseInWeek } from './parseTable.js';

/* ---------------------------------------------------------------- 配色 */

const PALETTE = [
  { bg: '#4A7C6F', text: '#FFFFFF' },
  { bg: '#5B8FC7', text: '#FFFFFF' },
  { bg: '#8C6BB1', text: '#FFFFFF' },
  { bg: '#C77F5B', text: '#FFFFFF' },
  { bg: '#4A9E8F', text: '#FFFFFF' },
  { bg: '#C75B7A', text: '#FFFFFF' },
  { bg: '#B8934A', text: '#FFFFFF' },
  { bg: '#6B8E5B', text: '#FFFFFF' },
];

function colorFor(name) {
  let hash = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i += 1) {
    hash = (hash * 31 + s.charCodeAt(i)) % 100000;
  }
  return PALETTE[hash % PALETTE.length];
}

/* ---------------------------------------------------------------- 时间轴 */

/** 压缩带：午休 2 小时、晚饭 1 小时。只压缩「整段都没课」的部分，见 buildSegments。 */
const BREAK_BANDS = [
  { from: 12 * 60, to: 14 * 60, height: 11, label: '午休' },
  { from: 18 * 60, to: 19 * 60, height: 7, label: '晚饭' },
];

/** 允许显示的最早 / 最晚时间，避免出现凌晨那种离谱范围 */
const EARLIEST = 7 * 60;
const LATEST = 23 * 60;

/** 网格主体的高度（px）。固定值，屏幕小也不会撑爆。
 *  352 是折中：课程块还有约 70px 高（放得下 3 行课程名+时间），
 *  同时让底部「周概览」在 852px 高的手机上能露出来。 */
const GRID_HEIGHT = 352;

/**
 * 根据「所有课程」决定要显示的时间范围。
 *
 * 为什么要自适应：多数人的课都在 08:00–18:00。
 * 如果永远画到 22:30，下面会空出约 120px 白板，
 * 把周概览挤出屏幕（第一版就是这个毛病）。
 *
 * 用**全部课程**而不是本周课程来算，翻周时高度才不会跳来跳去。
 *
 * @returns {{from:number, to:number}}  分钟
 */
function dayRange(courses) {
  const spans = courses
    .filter((c) => !c.noSlot)
    .map((c) => courseMinutes(c))
    .filter(Boolean);

  if (!spans.length) return { from: 8 * 60, to: 18 * 60 };

  const lo = Math.min(...spans.map((s) => s.start));
  const hi = Math.max(...spans.map((s) => s.end));

  // 往前/后各留到整点，看起来不贴着边
  let from = Math.max(EARLIEST, Math.floor(lo / 60) * 60);
  let to = Math.min(LATEST, Math.ceil(hi / 60) * 60);

  // 至少 4 小时，否则只有一节课时网格会扁得没法看
  if (to - from < 4 * 60) to = Math.min(LATEST, from + 4 * 60);
  return { from, to };
}

/**
 * 把时间范围切成「正常段 + 压缩带」。
 * 压缩带只在它整段都落在范围内时插入，被裁掉的部分不压缩。
 */
function buildSegments(from, to) {
  const segments = [];
  let cursor = from;

  BREAK_BANDS.forEach((band) => {
    if (band.to <= from || band.from >= to) return;   // 整段在范围外

    const bf = Math.max(band.from, from);
    const bt = Math.min(band.to, to);

    if (bf > cursor) segments.push({ from: cursor, to: bf, kind: 'normal' });
    if (bt > bf) {
      segments.push({
        from: bf, to: bt, kind: 'break', height: band.height, label: band.label,
      });
    }
    cursor = bt;
  });

  if (cursor < to) segments.push({ from: cursor, to, kind: 'normal' });
  return segments.length ? segments : [{ from, to, kind: 'normal' }];
}

/**
 * 建立「分钟 → 像素」的映射。
 * @returns {{yOf:Function, total:number, segments:Array, scale:number}}
 */
function makeTimeline(segments, height) {
  const normalMinutes = segments
    .filter((s) => s.kind === 'normal')
    .reduce((sum, s) => sum + (s.to - s.from), 0);

  const breakPx = segments
    .filter((s) => s.kind === 'break')
    .reduce((sum, s) => sum + s.height, 0);

  const scale = normalMinutes > 0 ? (height - breakPx) / normalMinutes : 0;

  let cursor = 0;
  const laid = segments.map((s) => {
    const isNormal = s.kind === 'normal';
    const h = isNormal ? (s.to - s.from) * scale : s.height;
    const seg = {
      ...s,
      y: cursor,
      h,
      // 每个段自己的比例（压缩带用它把分钟映射到像素）
      localScale: h / (s.to - s.from),
    };
    cursor += h;
    return seg;
  });

  const yOf = (min) => {
    for (let i = 0; i < laid.length; i += 1) {
      const seg = laid[i];
      if (min <= seg.to || i === laid.length - 1) {
        const clamped = Math.max(seg.from, Math.min(seg.to, min));
        return seg.y + (clamped - seg.from) * seg.localScale;
      }
    }
    return 0;
  };

  return { yOf, total: cursor, segments: laid, scale };
}

/* ---------------------------------------------------------------- 节次 */

/** 这门课在第几节到第几节（算不出来返回 null）。只用于统计「课时」。 */
export function coursePeriods(course) {
  let sp = Number(course.startPeriod) || 0;
  let ep = Number(course.endPeriod) || 0;

  if (!sp && course.start) {
    const min = timeToMinutes(course.start);
    if (min !== null) {
      for (let i = 0; i < PERIOD_TIMES.length; i += 1) {
        const p = PERIOD_TIMES[i];
        if (min >= timeToMinutes(p.start) - 5 && min <= timeToMinutes(p.end) + 5) {
          sp = p.period;
          break;
        }
      }
    }
  }
  if (!ep && course.end) {
    const min = timeToMinutes(course.end);
    if (min !== null) {
      for (let i = PERIOD_TIMES.length - 1; i >= 0; i -= 1) {
        const p = PERIOD_TIMES[i];
        if (min <= timeToMinutes(p.end) + 5) { ep = p.period; break; }
      }
    }
  }

  if (!sp) return null;
  if (!ep || ep < sp) ep = sp;
  return { startPeriod: sp, endPeriod: ep };
}

/* ---------------------------------------------------------------- 日期 */

function parseDate(iso) {
  if (!iso) return null;
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function addDays(date, n) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + n);
  return d;
}

/**
 * 取出「课表基准日期」：优先 timetableStartDate，没填就退回 termStartDate。
 * 这样只填一个也能用。
 */
export function resolveTimetableStart(settings = {}) {
  return parseDate(settings.timetableStartDate) || parseDate(settings.termStartDate);
}

function weeksSince(start) {
  if (!start) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.floor((today.getTime() - start.getTime()) / (7 * 24 * 3600 * 1000));
  return Math.max(1, diff + 1);
}

/** 今天是课表的第几周。没有基准日期时返回 1。 */
export function currentWeek(settings = {}) {
  return weeksSince(resolveTimetableStart(settings)) ?? 1;
}

/** 今天是学期的第几周（用于「第 7 周 · 学期第 9 周」这种提示）。 */
export function currentTermWeek(settings = {}) {
  return weeksSince(parseDate(settings.termStartDate));
}

/* ---------------------------------------------------------------- 渲染 */

function fmt(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 把课程的时间解析成分钟；没写时间就用节次换算 */
function courseMinutes(course) {
  let s = timeToMinutes(course.start);
  let e = timeToMinutes(course.end);

  if (s === null || e === null) {
    const p = coursePeriods(course);
    if (p) {
      const t1 = PERIOD_TIMES.find((x) => x.period === p.startPeriod);
      const t2 = PERIOD_TIMES.find((x) => x.period === p.endPeriod);
      if (s === null && t1) s = timeToMinutes(t1.start);
      if (e === null && t2) e = timeToMinutes(t2.end);
    }
  }
  if (s === null || e === null || e <= s) return null;
  return { start: s, end: e };
}

/**
 * 画出周视图。
 *
 * @param {HTMLElement} root
 * @param {Object} opts
 * @param {Array}  opts.courses
 * @param {number} opts.week
 * @param {Object} opts.settings   需要 timetableStartDate / termStartDate
 * @param {Function} [opts.onCourseClick]
 * @param {Function} [opts.onNoSlotClick]
 */
export function renderWeekGrid(root, opts) {
  if (!root) return;
  clear(root);

  const {
    courses = [], week = 1, settings = {},
    onCourseClick = () => {}, onNoSlotClick = () => {},
  } = opts;

  const start = resolveTimetableStart(settings);
  const weekCourses = courses.filter((c) => !c.noSlot && isCourseInWeek(c, week));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayIndex = today.getDay();
  const isCurrentWeek = week === currentWeek(settings);

  const dayOrder = [1, 2, 3, 4, 5, 6, 0];   // 周一到周日

  /* ---------------- 表头：周几 + 日期 ---------------- */
  const head = el('div', { class: 'wk-head' });
  head.appendChild(el('div', { class: 'wk-gutter' }));
  dayOrder.forEach((dayIdx) => {
    const isToday = isCurrentWeek && dayIdx === todayIndex;
    const offsetFromMonday = (dayIdx + 6) % 7;
    const date = start ? addDays(start, (week - 1) * 7 + offsetFromMonday) : null;

    head.appendChild(el('div', {
      class: `wk-day${isToday ? ' is-today' : ''}${(dayIdx === 0 || dayIdx === 6) ? ' is-weekend' : ''}`,
    }, [
      el('b', { text: WEEKDAY_SHORT[dayIdx] }),
      el('span', { class: 'wk-date', text: date ? String(date.getDate()) : '' }),
    ]));
  });
  root.appendChild(head);

  /* ---------------- 主体 ---------------- */
  // 时间范围按**全部课程**算（不是本周），翻周时高度不跳
  const range = dayRange(courses);
  const timeline = makeTimeline(buildSegments(range.from, range.to), GRID_HEIGHT);

  const body = el('div', {
    class: 'wk-body',
    style: { height: `${GRID_HEIGHT}px` },
  });

  // 7 个日期列（背景 + 今日高亮）
  dayOrder.forEach((dayIdx, i) => {
    const isToday = isCurrentWeek && dayIdx === todayIndex;
    body.appendChild(el('div', {
      class: `wk-col${isToday ? ' is-today' : ''}`,
      style: {
        left: `${(i * 100) / 7}%`,
        width: `${100 / 7}%`,
      },
    }));
  });

  // 压缩带（午休 / 晚饭）
  timeline.segments.filter((s) => s.kind === 'break').forEach((seg) => {
    body.appendChild(el('div', {
      class: 'wk-break',
      style: { top: `${seg.y}px`, height: `${seg.h}px` },
    }, [
      el('span', { class: 'wk-break-label', text: seg.label }),
    ]));
  });

  // 整点横线（跳过压缩带内部）
  for (let h = Math.ceil(range.from / 60); h * 60 <= range.to; h += 1) {
    const min = h * 60;
    const inBreak = timeline.segments.some((s) => s.kind === 'break' && min > s.from && min < s.to);
    if (inBreak || min === range.from) continue;
    body.appendChild(el('div', {
      class: 'wk-line',
      style: { top: `${timeline.yOf(min)}px` },
    }));
  }

  // 左侧时间刻度：每 2 小时一个。
  // 要跳过压缩带的**内部**和**结束点** —— 午休被压成 11px 后，
  // 「12」和「14」两个刻度只差 11px，会叠在一起看不清。
  for (let h = Math.ceil(range.from / 60); h * 60 < range.to; h += 2) {
    const min = h * 60;
    const clash = timeline.segments.some(
      (s) => s.kind === 'break' && min > s.from && min <= s.to,
    );
    if (clash) continue;
    body.appendChild(el('div', {
      class: 'wk-hour',
      style: { top: `${timeline.yOf(min)}px` },
      text: String(h).padStart(2, '0'),
    }));
  }

  /* ---------------- 课程块 ---------------- */
  const skipped = [];

  weekCourses.forEach((course) => {
    const mins = courseMinutes(course);
    if (!mins) { skipped.push(course.name); return; }

    const top = timeline.yOf(mins.start);
    const bottom = timeline.yOf(mins.end);
    const height = Math.max(20, bottom - top);

    const dayIdx = Number(course.day);
    const colIndex = (dayIdx + 6) % 7;    // 周一 → 0，周日 → 6
    const color = colorFor(course.name);

    const block = el('button', {
      type: 'button',
      class: `wk-block${height < 42 ? ' tiny' : ''}`,
      style: {
        top: `${top}px`,
        height: `${height}px`,
        left: `calc(${(colIndex * 100) / 7}% + 1px)`,
        width: `calc(${100 / 7}% - 2px)`,
        background: color.bg,
        color: color.text,
      },
      title: `${course.name} ${fmt(mins.start)}–${fmt(mins.end)}`,
      'aria-label': `${course.name} ${WEEKDAY_NAMES[dayIdx]} ${fmt(mins.start)} 到 ${fmt(mins.end)}`,
      onclick: () => onCourseClick(course),
    }, [
      el('span', { class: 'wk-name', text: course.name }),
      // 只写开始时间：7 列宽度下「08:00–09:40」放不下会被截成「08:00–09:4」，
      // 反而看不出来。结束时间看块的高度和详情弹窗。
      el('span', { class: 'wk-time', text: fmt(mins.start) }),
    ]);

    // 教师 / 地点合成一行，短块里自然会被裁掉
    const metaText = [course.teacher, course.room].filter(Boolean).join(' · ');
    if (metaText) {
      block.appendChild(el('span', { class: 'wk-meta', text: metaText }));
    }

    if (course.parity === 'odd' || course.parity === 'even') {
      block.appendChild(el('span', {
        class: 'wk-parity',
        text: course.parity === 'odd' ? '单' : '双',
      }));
    }

    body.appendChild(block);
  });

  root.appendChild(body);

  /* ---------------- 无课表课程 ---------------- */
  const noSlot = courses.filter((c) => c.noSlot);
  if (noSlot.length) {
    root.appendChild(el('button', {
      type: 'button', class: 'wk-noslot', onclick: onNoSlotClick,
    }, [
      el('span', { class: 'wk-noslot-icon', text: '📌' }),
      el('span', {}, [
        document.createTextNode('还有 '),
        el('b', { text: String(noSlot.length) }),
        document.createTextNode(' 门课没有固定时间'),
      ]),
      el('span', { class: 'wk-noslot-more', text: '查看 ›' }),
    ]));
  }

  /* ---------------- 周概览 ---------------- */
  root.appendChild(buildOverview(weekCourses, week, skipped));

  /* ---------------- 空状态 ---------------- */
  if (weekCourses.length === 0) {
    root.appendChild(el('div', { class: 'wk-empty' }, [
      el('div', { class: 'empty-icon', text: courses.length === 0 ? '📅' : '🏖' }),
      el('div', {
        class: 'empty-text',
        text: courses.length === 0
          ? '还没有课程。点右上角「导入」可以一次录完整学期。'
          : `第 ${week} 周没有课`,
      }),
    ]));
  }
}

/* ---------------------------------------------------------------- 概览 */

function buildOverview(weekCourses, week, skipped) {
  const byDay = new Array(7).fill(0);
  weekCourses.forEach((c) => { byDay[Number(c.day) || 0] += 1; });

  let busiestDay = -1;
  let busiestCount = 0;
  byDay.forEach((count, day) => {
    if (count > busiestCount) { busiestCount = count; busiestDay = day; }
  });

  // 最长空档（同一天两节课之间，只算 20 分钟以上）
  let bestGap = 0;
  let bestGapText = '—';
  for (let day = 0; day < 7; day += 1) {
    const list = weekCourses
      .filter((c) => Number(c.day) === day)
      .map((c) => courseMinutes(c))
      .filter(Boolean)
      .sort((a, b) => a.start - b.start);

    for (let i = 1; i < list.length; i += 1) {
      const gap = list[i].start - list[i - 1].end;
      if (gap > bestGap && gap >= 20) {
        bestGap = gap;
        bestGapText = `${WEEKDAY_NAMES[day]} ${fmt(list[i - 1].end)}–${fmt(list[i].start)}`;
      }
    }
  }

  const periods = weekCourses.reduce((sum, c) => {
    const p = coursePeriods(c);
    return sum + (p ? p.endPeriod - p.startPeriod + 1 : 2);
  }, 0);

  const wrap = el('div', { class: 'wk-overview' });

  wrap.appendChild(el('div', { class: 'wk-ov-col' }, [
    el('div', { class: 'wk-ov-k', text: '最忙的一天' }),
    el('div', { class: 'wk-ov-v' }, busiestCount > 0
      ? [el('em', { text: WEEKDAY_NAMES[busiestDay] }), document.createTextNode(` · ${busiestCount} 节`)]
      : [document.createTextNode('—')]),
  ]));

  wrap.appendChild(el('div', { class: 'wk-ov-sep' }));

  wrap.appendChild(el('div', { class: 'wk-ov-col' }, [
    el('div', { class: 'wk-ov-k', text: '最长空档' }),
    el('div', { class: 'wk-ov-v', text: bestGapText }),
  ]));

  wrap.appendChild(el('div', { class: 'wk-ov-sep' }));

  wrap.appendChild(el('div', { class: 'wk-ov-col' }, [
    el('div', { class: 'wk-ov-k', text: `第 ${week} 周` }),
    el('div', { class: 'wk-ov-v', text: `${weekCourses.length} 节 · ${periods} 课时` }),
  ]));

  // 有时间缺失的课要明确说出来，而不是默默不画
  if (skipped.length) {
    wrap.appendChild(el('div', { class: 'wk-ov-sep' }));
    wrap.appendChild(el('div', { class: 'wk-ov-col' }, [
      el('div', { class: 'wk-ov-k', text: '时间缺失' }),
      el('div', { class: 'wk-ov-v wk-ov-warn', text: `${skipped.length} 门没排上` }),
    ]));
  }

  return wrap;
}
