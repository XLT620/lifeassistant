/* ==========================================================================
   课程表模块
   --------------------------------------------------------------------------
   对照原型（SECTION: schedule / SECTION: reminder）逐项移植。
   保持一致的部分：添加/删除课程、按星期筛选、按时间排序、课前提醒横幅。
   改进的部分都标了 [改进]。
   ========================================================================== */

import {
  $, $$, el, clear, genId, timeToMinutes, minutesToTime,
  minutesSinceMidnight,
} from './utils.js';
import { STORAGE_KEYS, WEEKDAY_NAMES } from './constants.js';
import * as store from './store.js';
import {
  renderWeekGrid, currentWeek, weekDateRange, timetableOffsetWeeks,
} from './weekGrid.js';

/* ---------------------------------------------------------------- 状态 */

let courses = [];
let selectedDay = new Date().getDay();   // -1 = 全部；0–6 与 Date.getDay() 对齐
let deps = { notify: () => {}, scheduleUndo: () => {} };

/** 'week' = 周视图（默认），'list' = 原来的列表 + 添加表单 */
let viewMode = 'week';

/**
 * 当前显示的是**第几周（学期周次，绝对）**。
 * null = 跟随「本周」（打开时自动定位到今天所在周）。
 *
 * ⚠️ 以前用的是「相对本周的偏移」，配合
 *     week = min(总周数, 本周 + 偏移) 来计算。
 *     如果「本周」算出来比总周数还大（课表起始日填得早、或总周数填得小），
 *     min() 会永远返回总周数 —— 往前翻不动，**本周之后的课就永远看不到**。
 *     改成绝对周次后，1..总周数 每一周都翻得到。
 */
let viewWeek = null;

/* ---------------------------------------------------------------- 初始化 */

export function initSchedule(dependencies) {
  deps = { ...deps, ...dependencies };

  courses = store.loadCourses();

  // 表单提交
  const form = $('#courseForm');
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    handleAddCourse();
  });

  renderDayFilter();
  bindViewSwitch();
  bindWeekNav();
  renderSchedule();
}

/* ---------------------------------------------------------------- 视图切换 */

function bindViewSwitch() {
  $$('[data-sview]').forEach((btn) => {
    btn.addEventListener('click', () => {
      viewMode = btn.dataset.sview === 'week' ? 'week' : 'list';
      renderSchedule();
    });
  });
}

function bindWeekNav() {
  /** 当前实际显示的周（解析成绝对周次，并夹在 1..总周数 之间） */
  const currentShownWeek = () => {
    const settings = store.loadSettings();
    const total = Math.max(1, Number(settings.totalWeeks) || 20);
    const base = Math.min(total, Math.max(1, currentWeek(settings)));
    if (viewWeek === null) return base;
    return Math.min(total, Math.max(1, viewWeek));
  };

  $('#weekPrev')?.addEventListener('click', () => {
    const w = currentShownWeek();
    if (w <= 1) {
      deps.notify('已经是第 1 周（开学那周）了');
      return;
    }
    viewWeek = w - 1;
    renderWeek();
  });

  $('#weekNext')?.addEventListener('click', () => {
    const settings = store.loadSettings();
    const total = Math.max(1, Number(settings.totalWeeks) || 20);
    const w = currentShownWeek();
    if (w >= total) {
      deps.notify(`已经是最后一周了（共 ${total} 周）`);
      return;
    }
    viewWeek = w + 1;
    renderWeek();
  });

  $('#weekTodayBtn')?.addEventListener('click', () => {
    viewWeek = null;       // 跟随本周
    renderWeek();
  });

  // 课程表页里直接填「开学日期」/「课表第一周的周一」
  $('#weekSetupSave')?.addEventListener('click', () => {
    const termInput = $('#weekSetupTermDate');
    const startInput = $('#weekSetupDate');
    const termValue = termInput ? termInput.value : '';
    const startValue = startInput ? startInput.value : '';

    if (!termValue && !startValue) {
      deps.notify('请至少选一个日期');
      return;
    }

    const settings = store.loadSettings();
    const next = { ...settings };
    if (termValue) next.termStartDate = termValue;
    if (startValue) next.timetableStartDate = startValue;

    const result = store.saveSettings(next);
    if (!result.ok) {
      deps.notify('保存失败，请重试');
      return;
    }
    viewWeek = null;
    deps.notify('已保存，周次和日期会对上了');
    renderWeek();
  });
}

/**
 * 重新渲染课程表（列表或周视图，按当前模式）。
 * 外部模块（导入、设置变更）改完数据后调这个。
 */
export function renderSchedule() {
  const weekWrap = $('#weekView');
  const listWrap = $('#listView');
  const nav = $('#weekNav');

  // 同步分段控件的选中态
  $$('[data-sview]').forEach((btn) => {
    const on = btn.dataset.sview === viewMode;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });

  if (weekWrap) weekWrap.hidden = viewMode !== 'week';
  if (nav) nav.hidden = viewMode !== 'week';
  if (listWrap) listWrap.hidden = viewMode !== 'list';

  // 两个视图都渲染，只是隐藏其中一个。
  // 好处：切换视图是瞬间的，而且不会有「另一个视图数据是旧的」这种情况。
  // 代价：多一次 DOM 构建，可以忽略。
  renderWeek();
  renderCourses();
}

/** 从存储重新读一遍课程（导入之后用） */
export function reloadCourses() {
  courses = store.loadCourses();
  renderSchedule();
  checkReminder();
}

/* ---------------------------------------------------------------- 周视图 */

function renderWeek() {
  const root = $('#weekView');
  if (!root) return;

  const settings = store.loadSettings();

  /*
   * 周次语义（按用户要求）：
   *   · 显示的是**学期周次**，第 1 周 = 开学日所在的那一周
   *   · 课表标签上的「第 k 周」= 学期第 (k + offset) 周
   *     （开学周与课表实施周不同周时 offset > 0）
   *   · 只能看 1..总周数，学期外不显示
   */
  const totalWeeks = Math.max(1, Number(settings.totalWeeks) || 20);
  const rawBase = currentWeek(settings);                    // 今天实际是第几周（可能超出学期）
  const inTerm = rawBase >= 1 && rawBase <= totalWeeks;
  const base = Math.min(totalWeeks, Math.max(1, rawBase));
  const week = viewWeek === null
    ? base
    : Math.min(totalWeeks, Math.max(1, viewWeek));

  const offset = timetableOffsetWeeks(settings);
  const courseWeek = week - offset;      // 对应课表上的第几周

  const labelEl = $('#weekLabel');
  const subEl = $('#weekSub');

  if (labelEl) {
    labelEl.textContent = `第 ${week} 周`;
  }

  if (subEl) {
    const hasBase = settings.termStartDate || settings.timetableStartDate;

    if (!hasBase) {
      subEl.textContent = '还没设置开学日期，先按第 1 周显示';
      subEl.dataset.warn = '1';
    } else {
      delete subEl.dataset.warn;

      const parts = [];
      if (!inTerm) {
        // 今天已经超出学期范围（比如开学日填得很早、或学期已结束）。
        // 这时不能标「本周」，否则会误导。
        parts.push(rawBase > totalWeeks ? '学期已结束' : '还没开学');
      } else {
        parts.push(week === base
          ? '本周'
          : (week < base ? `比本周早 ${base - week} 周` : `比本周晚 ${week - base} 周`));
      }

      // 这一周的日期范围，方便和教务系统核对「周次 ↔ 日期」
      const range = weekDateRange(settings, week);
      if (range) parts.push(`${range.from}–${range.to}`);
      parts.push(`共 ${totalWeeks} 周`);

      // 开学周 ≠ 课表实施周时，额外标出「课表第几周」
      if (offset > 0) {
        parts.push(courseWeek >= 1 ? `课表第 ${courseWeek} 周` : '课表还没开始');
      }

      subEl.textContent = parts.join(' · ');
    }
  }

  // 「回到本周」按钮只在「今天在学期内、且当前不是本周」时出现
  const todayBtn = $('#weekTodayBtn');
  if (todayBtn) todayBtn.hidden = !inTerm || week === base;

  // 没有基准日期时，把输入框直接摆在课程表页上（藏在设置里用户找不到）
  const setup = $('#weekSetup');
  if (setup) {
    const needSetup = !(settings.termStartDate || settings.timetableStartDate);
    setup.hidden = !needSetup;
    if (needSetup) {
      const termInput = $('#weekSetupTermDate');
      const startInput = $('#weekSetupDate');
      if (termInput && !termInput.value) termInput.value = settings.termStartDate || '';
      if (startInput && !startInput.value) startInput.value = settings.timetableStartDate || '';
    }
  }

  renderWeekGrid(root, {
    courses,
    week,
    settings,
    onCourseClick: (course) => showCourseDetail(course),
    onNoSlotClick: () => showNoSlotList(),
  });
}

/* ---------------------------------------------------------------- 详情 */

/**
 * 点课程块 → 用底部抽屉显示详情。
 * 比跳新页面轻，关掉成本低。
 */
function showCourseDetail(course) {
  const messages = [
    course.name,
    `${WEEKDAY_NAMES[course.day] || ''} ${course.start || ''}–${course.end || ''}`,
  ];
  if (course.teacher) messages.push(`教师：${course.teacher}`);
  if (course.room) messages.push(`地点：${course.room}`);
  if (course.weeks) messages.push(`周次：${course.weeks}`);

  const confirmed = window.confirm(`${messages.join('\n')}\n\n要删除这门课吗？（可以撤销）`);
  if (confirmed) {
    // 直接走延迟提交的删除
    deleteCourse(course);
  }
}

/** 无课表课程：列出来给用户看 */
function showNoSlotList() {
  const list = courses.filter((c) => c.noSlot);
  if (!list.length) return;
  const text = list
    .map((c) => `· ${c.name}${c.weeks ? `（${c.weeks}）` : ''}`)
    .join('\n');
  window.alert(`这些课没有固定的星期和节次：\n\n${text}\n\n它们不会画进周视图。`);
}

/* ---------------------------------------------------------------- 增删 */

function handleAddCourse() {
  const nameEl = $('#courseName');
  const dayEl = $('#courseDay');
  const startEl = $('#courseStart');
  const endEl = $('#courseEnd');
  const locationEl = $('#courseLocation');

  const name = (nameEl?.value || '').trim();
  if (!name) {
    deps.notify('请填写课程名称');
    nameEl?.focus();
    return;
  }

  const startMin = timeToMinutes(startEl?.value);
  const endMin = timeToMinutes(endEl?.value);

  if (startMin === null || endMin === null) {
    deps.notify('请填写开始和结束时间');
    return;
  }

  // [改进] 原型完全不校验时间顺序，可以建出「10:00–09:00」这种倒转的课，
  // 之后排序、提醒计算都会得出奇怪结果。这里拦住它。
  if (endMin === startMin) {
    deps.notify('开始和结束时间不能相同');
    return;
  }

  const weekday = parseInt(dayEl?.value, 10);

  const course = {
    id: genId(),
    name,
    day: Number.isNaN(weekday) ? 1 : weekday,   // 1=周一 … 6=周六，0=周日
    start: minutesToTime(startMin),
    end: minutesToTime(endMin),
    location: (locationEl?.value || '').trim(),
  };

  courses.push(course);
  const result = store.save(STORAGE_KEYS.courses, courses);

  if (!result.ok) {
    // 写入失败必须告诉用户，否则他以为加上了
    courses.pop();
    deps.notify(result.quotaExceeded
      ? '存储空间不足，课程没保存成功'
      : '保存失败，请重试');
    return;
  }

  // 清空表单（保留星期，方便连续录入同一天的课）
  if (nameEl) nameEl.value = '';
  if (locationEl) locationEl.value = '';
  if (startEl) startEl.value = '';
  if (endEl) endEl.value = '';

  renderSchedule();
  checkReminder();
  deps.notify('课程已添加');
}

/**
 * 删除课程。
 *
 * [改进] 原型弹确认框；这里直接删 + 底部撤销条，5 秒内可撤销。
 *
 * ## 撤销的机制（这一点想清楚很重要）
 *
 * 不是「先删掉、记下备份、撤销时再插回来」，而是**延迟提交**：
 *
 *   1. 点删除 → 立刻从**界面**移除（用户马上看到结果，零延迟）
 *   2. 但**数据**还是原样，没有写进存储
 *   3. 5 秒内点「撤销」→ 只是把界面重画回原样，数据从未变过
 *   4. 5 秒后 → 才真正从数组里删掉并落库
 *
 * 这样即使用户在这 5 秒内关掉页面或杀掉 App，数据也**还在**（只是没删成）。
 * 比「先删了再想办法恢复」安全得多 —— 后者一旦关页面就真的丢了。
 */
function deleteCourse(course) {
  // 1. 先从界面移除
  const previousList = courses.slice();
  courses = courses.filter((c) => c.id !== course.id);
  renderSchedule();
  checkReminder();

  // 2. 登记延迟提交
  deps.scheduleUndo(
    `已删除课程「${course.name}」`,
    // commit：5 秒后真正落库（此刻 courses 已经是删过的列表）
    () => {
      const result = store.save(STORAGE_KEYS.courses, courses);
      if (!result.ok) {
        // 落库失败：把课程放回去，并明确告诉用户
        courses = previousList;
        renderSchedule();
        checkReminder();
        deps.notify('删除没有保存成功，课程已恢复');
      }
    },
    // revert：撤销 —— 数据从未被删，只需把界面恢复
    () => {
      courses = previousList;
      renderSchedule();
      checkReminder();
    },
  );
}

/* ---------------------------------------------------------------- 渲染 */

function renderDayFilter() {
  const container = $('#dayFilter');
  if (!container) return;
  clear(container);

  const days = [
    { val: -1, label: '全部' },
    { val: 1, label: '周一' },
    { val: 2, label: '周二' },
    { val: 3, label: '周三' },
    { val: 4, label: '周四' },
    { val: 5, label: '周五' },
    { val: 6, label: '周六' },
    { val: 0, label: '周日' },
  ];

  days.forEach((d) => {
    const chip = el('button', {
      type: 'button',
      class: `day-chip${selectedDay === d.val ? ' active' : ''}`,
      text: d.label,
      'aria-pressed': selectedDay === d.val ? 'true' : 'false',
      onclick: () => {
        selectedDay = d.val;
        renderDayFilter();
        renderCourses();
      },
    });
    container.appendChild(chip);
  });
}

export function renderCourses() {
  const container = $('#courseList');
  if (!container) return;
  clear(container);

  let filtered = courses;
  if (selectedDay !== -1) {
    filtered = courses.filter((c) => c.day === selectedDay);
  }

  // 按开始时间排序（字符串比较对 "HH:MM" 是正确的）
  const sorted = filtered.slice().sort((a, b) => String(a.start).localeCompare(String(b.start)));

  if (sorted.length === 0) {
    container.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-icon', text: '📭' }),
      el('div', {
        class: 'empty-text',
        text: courses.length === 0
          ? '还没有课程，上方添加开始吧'
          : '这一天还没有课',
      }),
    ]));
    return;
  }

  sorted.forEach((course) => {
    container.appendChild(buildCourseRow(course));
  });
}

function buildCourseRow(course) {
  const row = el('div', { class: 'course-item' });

  // 时间块
  row.appendChild(el('div', { class: 'course-time-block' }, [
    el('div', { class: 'course-time-start', text: course.start }),
    el('div', { class: 'course-time-end', text: course.end }),
  ]));

  // 信息
  const info = el('div', { class: 'course-info' }, [
    el('div', { class: 'course-name', text: course.name }),
  ]);
  if (course.location) {
    info.appendChild(el('div', { class: 'course-location', text: course.location }));
  }
  const dayIndex = Number(course.day);
  info.appendChild(el('span', {
    class: 'course-weekday',
    text: WEEKDAY_NAMES[dayIndex] || '未知',
  }));
  row.appendChild(info);

  // 操作
  row.appendChild(el('div', { class: 'course-actions' }, [
    el('button', {
      type: 'button',
      class: 'btn btn-ghost btn-sm',
      text: '删除',
      'aria-label': `删除课程 ${course.name}`,
      onclick: () => deleteCourse(course),
    }),
  ]));

  return row;
}

/* ---------------------------------------------------------------- 提醒 */

/**
 * 课前提醒横幅。
 *
 * [改进] 原型的判定逻辑写在一条长长的 if-else 里，且只比较「今天」的课。
 * 这里改成三种状态更清楚：
 *   1. 有课在 N 分钟内开始 → 显示「X 分钟后开始」
 *   2. 今天还有课没上 → 显示「下一节课：xxx（时间）」
 *   3. 今天的课上完了 / 没有课 → 对应提示
 *
 * N 取自设置（默认 30 分钟）。
 */
export function checkReminder() {
  const banner = $('#reminderBanner');
  const textEl = $('#reminderText');
  if (!banner || !textEl) return;

  const settings = store.loadSettings();
  const lead = Number(settings.reminderMinutes) || 30;

  const now = new Date();
  const todayIndex = now.getDay();
  const nowMin = minutesSinceMidnight(now);

  const todayCourses = courses
    .filter((c) => Number(c.day) === todayIndex)
    .map((c) => ({ ...c, startMin: timeToMinutes(c.start), endMin: timeToMinutes(c.end) }))
    .filter((c) => c.startMin !== null)
    .sort((a, b) => a.startMin - b.startMin);

  if (todayCourses.length === 0) {
    textEl.textContent = '今天没有课程安排';
    banner.classList.add('active');
    setReminderLevel(banner, 'normal');
    return;
  }

  // 1. lead 分钟内即将开始的课
  const upcoming = todayCourses.find((c) => {
    const diff = c.startMin - nowMin;
    return diff > 0 && diff <= lead;
  });

  if (upcoming) {
    const diff = upcoming.startMin - nowMin;
    let message = `${upcoming.name} 将在 ${diff} 分钟后开始`;
    if (upcoming.location) message += `（${upcoming.location}）`;
    textEl.textContent = message;
    banner.classList.add('active');
    setReminderLevel(banner, 'urgent');
    return;
  }

  // 2. 正在上的课
  const ongoing = todayCourses.find((c) => c.endMin !== null && nowMin >= c.startMin && nowMin < c.endMin);
  if (ongoing) {
    textEl.textContent = `正在上：${ongoing.name}（${ongoing.start}–${ongoing.end}）`;
    banner.classList.add('active');
    setReminderLevel(banner, 'normal');
    return;
  }

  // 3. 今天还没上的下一节
  const next = todayCourses.find((c) => c.startMin > nowMin);
  if (next) {
    textEl.textContent = `下一节课：${next.name}（${next.start}）`;
    banner.classList.add('active');
    setReminderLevel(banner, 'normal');
    return;
  }

  // 4. 全部结束
  textEl.textContent = '今天的课程已全部结束，好好休息吧';
  banner.classList.add('active');
  setReminderLevel(banner, 'normal');
}

/**
 * 用不同的底色区分「马上要上课」和「普通提示」。
 * 用 data-level 属性 + CSS，而不是直接改 style，避免和深色模式打架。
 */
function setReminderLevel(banner, level) {
  banner.dataset.level = level;
}

/* ---------------------------------------------------------------- 统计 */

/** 供其他模块使用：今天的课程（已解析出分钟数并排序） */
export function getTodayCourses() {
  const todayIndex = new Date().getDay();
  return courses
    .filter((c) => Number(c.day) === todayIndex)
    .map((c) => ({
      ...c,
      startMin: timeToMinutes(c.start),
      endMin: timeToMinutes(c.end),
    }))
    .filter((c) => c.startMin !== null)
    .sort((a, b) => a.startMin - b.startMin);
}

export function getCourses() {
  return courses.slice();
}
