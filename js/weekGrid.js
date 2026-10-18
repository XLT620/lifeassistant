/* ==========================================================================
   周视图
   --------------------------------------------------------------------------
   把课程画成一张真正的课表：7 天 × 11 节。

   设计依据（来自用户提供的真实教务系统截图）：
     · 7 天都显示，表头带日期（周一 12）
     · 左侧行标题是节次分组（一二节 / 三四节 / … / 九十十一节）
     · 课程块里显示 课程名 / 教师 / 地点
     · 底部提示「无课表课程」有多少门

   为什么用 CSS Grid 而不是绝对定位：
     绝对定位要自己算像素，字号一变就错位。
     Grid 里一个课程块就是 grid-row: 第几节 / span 几节，
     浏览器负责对齐，换字号也不用改代码。
   ========================================================================== */

import { el, clear, timeToMinutes } from './utils.js';
import {
  WEEKDAY_NAMES, WEEKDAY_SHORT, PERIOD_TIMES, PERIOD_GROUPS,
} from './constants.js';
import { isCourseInWeek } from './parseTable.js';

/* ---------------------------------------------------------------- 配色 */

/**
 * 课程块的颜色。
 *
 * 按课程名算一个稳定的哈希，同一门课永远同色 ——
 * 一眼能看出「这块和那块是同一门课」。
 * 不提供调色功能：那对用户是负担，用处却不大。
 */
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

/* ---------------------------------------------------------------- 节次 */

/** 课程从第几节开始、到第几节结束（都能算出来才返回） */
export function coursePeriods(course) {
  let sp = Number(course.startPeriod) || 0;
  let ep = Number(course.endPeriod) || 0;

  // 没有节次信息（比如手填的课）→ 用开始时间反推
  if (!sp && course.start) {
    const min = timeToMinutes(course.start);
    if (min !== null) {
      for (let i = 0; i < PERIOD_TIMES.length; i += 1) {
        const p = PERIOD_TIMES[i];
        const pStart = timeToMinutes(p.start);
        const pEnd = timeToMinutes(p.end);
        if (min >= pStart - 5 && min <= pEnd + 5) { sp = p.period; break; }
      }
    }
  }
  if (!ep && course.end) {
    const min = timeToMinutes(course.end);
    if (min !== null) {
      for (let i = PERIOD_TIMES.length - 1; i >= 0; i -= 1) {
        const p = PERIOD_TIMES[i];
        const pEnd = timeToMinutes(p.end);
        if (min <= pEnd + 5) { ep = p.period; break; }
      }
    }
  }

  if (!sp) return null;
  if (!ep || ep < sp) ep = sp;
  return { startPeriod: sp, endPeriod: ep };
}

/* ---------------------------------------------------------------- 日期 */

/** 第 1 周周一 → Date。解析失败返回 null。 */
function termStart(termStartDate) {
  if (!termStartDate) return null;
  const m = String(termStartDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
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
 * 今天是第几周。
 * 没设置开学日期时返回 1（界面会提示去设置）。
 */
export function currentWeek(termStartDate) {
  const start = termStart(termStartDate);
  if (!start) return 1;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.floor((today.getTime() - start.getTime()) / (7 * 24 * 3600 * 1000));
  return Math.max(1, diff + 1);
}

/* ---------------------------------------------------------------- 渲染 */

/**
 * 画出周视图。
 *
 * @param {HTMLElement} root 容器（#weekView）
 * @param {Object} opts
 * @param {Array}  opts.courses
 * @param {number} opts.week          要显示的周次
 * @param {string} opts.termStartDate 第 1 周周一，'YYYY-MM-DD'
 * @param {Function} [opts.onCourseClick] 点课程块的回调
 * @param {Function} [opts.onNoSlotClick] 点「无课表课程」的回调
 */
export function renderWeekGrid(root, opts) {
  if (!root) return;
  clear(root);

  const {
    courses = [], week = 1, termStartDate = '',
    onCourseClick = () => {}, onNoSlotClick = () => {},
  } = opts;

  const start = termStart(termStartDate);
  const weekdayDates = start
    ? Object.fromEntries(
      WEEKDAY_SHORT.map((_, idx) => {
        // WEEKDAY_SHORT 索引 0=周日，但课表从周一开始，所以换算
        const offsetFromMonday = (idx + 6) % 7;
        const d = addDays(start, (week - 1) * 7 + offsetFromMonday);
        return [idx, d];
      }),
    )
    : null;

  // 本周实际要上的课
  const weekCourses = courses.filter((c) => !c.noSlot && isCourseInWeek(c, week));

  const today = new Date();
  const todayIndex = today.getDay();
  const isCurrentWeek = week === currentWeek(termStartDate);

  /* ---------------- 表头 ---------------- */
  const head = el('div', { class: 'wk-head' });
  head.appendChild(el('div', { class: 'wk-gutter' }));
  // 显示顺序：周一到周日
  const dayOrder = [1, 2, 3, 4, 5, 6, 0];
  dayOrder.forEach((dayIdx) => {
    const isToday = isCurrentWeek && dayIdx === todayIndex;
    const cell = el('div', {
      class: `wk-day${isToday ? ' is-today' : ''}${(dayIdx === 0 || dayIdx === 6) ? ' is-weekend' : ''}`,
    }, [
      el('b', { text: WEEKDAY_SHORT[dayIdx] }),
    ]);
    const d = weekdayDates ? weekdayDates[dayIdx] : null;
    cell.appendChild(el('span', { class: 'wk-date', text: d ? String(d.getDate()) : '' }));
    head.appendChild(cell);
  });
  root.appendChild(head);

  /* ---------------- 网格 ---------------- */
  const body = el('div', { class: 'wk-body' });

  /*
   * 自动折叠「整学期都没有课」的节次组。
   *
   * 为什么：多数人的课都在 1~8 节，晚上 9~11 节空着。
   * 如果永远画出来，会白白占掉约 100px，把周概览挤到屏幕外。
   *
   * 判断依据是**整份课程数据**（不是这一周），所以翻周时行数不会跳来跳去。
   * 将来导入了晚课，这一行会自动出现。
   */
  const usedPeriods = new Set();
  courses.forEach((c) => {
    if (c.noSlot) return;
    const p = coursePeriods(c);
    if (!p) return;
    for (let i = p.startPeriod; i <= p.endPeriod; i += 1) usedPeriods.add(i);
  });

  const activeGroups = PERIOD_GROUPS.filter(
    (g) => g.periods.some((p) => usedPeriods.has(p)),
  );
  const groups = activeGroups.length ? activeGroups : PERIOD_GROUPS;

  // 节次 → 行号（1 起）
  const rowOf = {};
  let rowCursor = 1;
  groups.forEach((g) => {
    g.periods.forEach((p) => { rowOf[p] = rowCursor; rowCursor += 1; });
  });
  const totalRows = rowCursor - 1;

  body.style.gridTemplateRows = `repeat(${totalRows}, 34px)`;

  // 行背景 + 节次标签
  for (let r = 1; r <= totalRows; r += 1) {
    body.appendChild(el('div', {
      class: 'wk-gridline',
      style: { gridColumn: '2 / span 7', gridRow: String(r) },
    }));
  }
  groups.forEach((group) => {
    const from = rowOf[group.periods[0]] || 1;
    const span = group.periods.filter((p) => rowOf[p]).length || 1;
    body.appendChild(el('div', {
      class: `wk-period${span >= 3 ? ' wide' : ''}`,
      style: { gridColumn: '1', gridRow: `${from} / span ${span}` },
      text: group.label,
    }));
  });

  // 课程块
  weekCourses.forEach((course) => {
    const periods = coursePeriods(course);
    if (!periods) return;

    // 折算成折叠后的行号；开始节次被折叠掉时（极少数）就跳过
    const startRow = rowOf[periods.startPeriod];
    if (!startRow) return;

    // 结束节次可能超出可见范围（比如只显示到第 8 节），就画到最后一行
    let endRow = startRow;
    for (let p = periods.startPeriod; p <= periods.endPeriod; p += 1) {
      if (rowOf[p]) endRow = rowOf[p];
    }
    const span = Math.max(1, endRow - startRow + 1);

    // day 1..6,0 → 列号 2..8（周一是第 2 列）
    const colIndex = course.day === 0 ? 8 : Number(course.day) + 1;

    const color = colorFor(course.name);
    const block = el('button', {
      type: 'button',
      class: 'wk-block',
      style: {
        gridColumn: String(colIndex),
        gridRow: `${startRow} / span ${span}`,
        background: color.bg,
        color: color.text,
      },
      'aria-label': `${course.name} ${WEEKDAY_NAMES[course.day]} 第${periods.startPeriod}-${periods.endPeriod}节`,
      onclick: () => onCourseClick(course),
    }, [
      el('span', { class: 'wk-name', text: course.name }),
    ]);

    if (course.teacher) {
      block.appendChild(el('span', { class: 'wk-teacher', text: course.teacher }));
    }
    if (course.room) {
      block.appendChild(el('span', { class: 'wk-room', text: course.room }));
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

  /* ---------------- 底部：无课表课程 ---------------- */
  const noSlot = courses.filter((c) => c.noSlot);
  if (noSlot.length) {
    const bar = el('button', {
      type: 'button',
      class: 'wk-noslot',
      onclick: onNoSlotClick,
    }, [
      el('span', { class: 'wk-noslot-icon', text: '📌' }),
      el('span', {}, [
        document.createTextNode('还有 '),
        el('b', { text: String(noSlot.length) }),
        document.createTextNode(' 门课没有固定时间'),
      ]),
      el('span', { class: 'wk-noslot-more', text: '查看 ›' }),
    ]);
    root.appendChild(bar);
  }

  /* ---------------- 概览 ---------------- */
  root.appendChild(buildOverview(weekCourses, week));

  /* ---------------- 空状态 ---------------- */
  if (weekCourses.length === 0 && courses.length === 0) {
    root.appendChild(el('div', { class: 'wk-empty' }, [
      el('div', { class: 'empty-icon', text: '📅' }),
      el('div', { class: 'empty-text', text: '还没有课程。点右上角「导入」可以一次录完整学期。' }),
    ]));
  } else if (weekCourses.length === 0) {
    root.appendChild(el('div', { class: 'wk-empty' }, [
      el('div', { class: 'empty-icon', text: '🏖' }),
      el('div', { class: 'empty-text', text: `第 ${week} 周没有课` }),
    ]));
  }
}

/* ---------------------------------------------------------------- 概览 */

/**
 * 周概览：最忙的一天、最长空档、本周节数。
 *
 * 这三个数字回答的是「这周累不累、哪段能自习」，
 * 比单纯显示「共 X 节课」有用。
 */
function buildOverview(weekCourses, week) {
  const byDay = new Array(7).fill(0);
  weekCourses.forEach((c) => { byDay[Number(c.day) || 0] += 1; });

  let busiestDay = -1;
  let busiestCount = 0;
  byDay.forEach((count, day) => {
    if (count > busiestCount) { busiestCount = count; busiestDay = day; }
  });

  // 最长空档：同一天两节课之间的最大间隔（只算 20 分钟以上的）
  let bestGap = 0;
  let bestGapText = '—';
  for (let day = 0; day < 7; day += 1) {
    const list = weekCourses
      .filter((c) => Number(c.day) === day && c.start && c.end)
      .map((c) => ({ s: timeToMinutes(c.start), e: timeToMinutes(c.end) }))
      .filter((x) => x.s !== null && x.e !== null)
      .sort((a, b) => a.s - b.s);

    for (let i = 1; i < list.length; i += 1) {
      const gap = list[i].s - list[i - 1].e;
      if (gap > bestGap && gap >= 20) {
        bestGap = gap;
        // 只显示「周一 09:40–14:00」——后面的时长在窄栏里会被截掉，不如不写
        bestGapText = `${WEEKDAY_NAMES[day]} ${fmt(list[i - 1].e)}–${fmt(list[i].s)}`;
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
      // 用「周一」而不是「一」——单个「一」在小字号下看起来像破折号
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

  return wrap;
}

function fmt(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
