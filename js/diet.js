/* ==========================================================================
   饮食记录模块
   --------------------------------------------------------------------------
   移植自原型（SUBSECTION: daily view / weekly view / photo upload / food detail）。

   ## 改动清单（每处都标了 [改进] 或 [修复]）

   1. [修复] 周汇总的「平均热量/餐」原本用**记录条数**当分母，
      算出来的数在 1 条记录时等于总热量、在 5 条记录时只有 1/5，
      含义不清且严重偏小。改成明确的「日均热量」：按本周**已过去的天数**算。
      （iOS 版也修了同一个问题，见 docs/01）
   2. [修复] 日期翻页原本能翻到未来。记到明天的数据在列表里永远看不到，
      用户会以为丢了。现在「下一天」「下周」在到达今天时禁用。
   3. [改进] 删除改走底部撤销条（延迟提交），不再弹确认框。
   4. [改进] 「识别」不再用 Math.random 假抽一条 —— 那是假功能。
      现在没有配置 AI 时明确提示「手动填写」，而不是假装识别成功。
   5. [改进] 照片写入失败（配额溢出）会明确报错，而不是静默丢数据。
   6. [改进] 按时间自动选餐次用 constants 里的 5 段规则（原型的 4 段会在
      下午 3 点把「下午茶」判成「午餐」）。
   ========================================================================== */

import {
  $, $$, el, clear, genId, formatDate, formatDateCN,
  today, addDays, startOfWeekMonday, parseDayKey, isSameDay,
  detectMealType, mealInfo, formatCost, compressImage,
} from './utils.js';
import { STORAGE_KEYS, MEAL_TYPES } from './constants.js';
import * as store from './store.js';

/* ---------------------------------------------------------------- 状态 */

let dietData = [];
let dietDate = today();
let viewMode = 'daily';          // 'daily' | 'weekly'
let weekOffset = 0;              // 0 = 本周，-1 = 上周
let pendingPhoto = null;         // { dataUrl, width, height, bytes }
let editingId = null;            // 正在内联编辑的记录 id
let detailId = null;             // 详情弹窗里的记录 id
let deps = { notify: () => {}, scheduleUndo: () => {} };

export function getDietViewMode() {
  return viewMode;
}

/* ---------------------------------------------------------------- 初始化 */

export function initDiet(dependencies) {
  deps = { ...deps, ...dependencies };
  dietData = store.loadDiet();

  // ---- 视图切换
  $$('.segmented-btn[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // ---- 日视图的日期导航
  $('#dietPrev')?.addEventListener('click', () => {
    dietDate = addDays(dietDate, -1);
    renderDiet();
  });
  $('#dietNext')?.addEventListener('click', () => {
    // [修复] 不允许翻到未来
    const next = addDays(dietDate, 1);
    if (next > today()) {
      deps.notify('已经是今天了，不能记录未来的日期');
      return;
    }
    dietDate = next;
    renderDiet();
  });

  // ---- 周历导航
  $('#weekPrev')?.addEventListener('click', () => {
    weekOffset -= 1;
    renderWeekly();
  });
  $('#weekNext')?.addEventListener('click', () => {
    // [修复] 不允许翻到未来
    if (weekOffset >= 0) {
      deps.notify('已经是本周了');
      return;
    }
    weekOffset += 1;
    renderWeekly();
  });

  // ---- 照片选择
  $('#photoFileInput')?.addEventListener('change', handlePhotoSelected);
  $('#photoRemoveBtn')?.addEventListener('click', clearPendingPhoto);

  // ---- 详情弹窗
  $('#foodDetailClose')?.addEventListener('click', closeDetail);
  $('#foodDetailDelete')?.addEventListener('click', () => {
    const item = dietData.find((x) => x.id === detailId);
    closeDetail();
    if (item) deleteEntry(item);
  });
  $('#foodDetailModal')?.addEventListener('click', (event) => {
    // 点遮罩（而不是弹窗本体）时关闭
    if (event.target === event.currentTarget) closeDetail();
  });

  renderDiet();
}

function switchView(mode) {
  if (mode !== 'daily' && mode !== 'weekly') return;
  viewMode = mode;

  $$('.segmented-btn[data-view]').forEach((btn) => {
    const active = btn.dataset.view === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  const daily = $('#dietDailyView');
  const weekly = $('#dietWeeklyView');
  if (daily) daily.hidden = mode !== 'daily';
  if (weekly) weekly.hidden = mode !== 'weekly';

  if (mode === 'weekly') renderWeekly();
  else renderDiet();
}

/* ==================================================================== 日视图 */

export function renderDiet() {
  const labelEl = $('#dietDateLabel');
  const container = $('#dietContent');
  if (!container) return;

  const dateStr = formatDate(dietDate);
  if (labelEl) labelEl.textContent = formatDateCN(dietDate);

  // 「下一天」在今天是最后一天时禁用
  const nextBtn = $('#dietNext');
  if (nextBtn) {
    const atToday = isSameDay(dietDate, today());
    nextBtn.disabled = atToday;
    nextBtn.setAttribute('aria-disabled', atToday ? 'true' : 'false');
  }

  clear(container);

  const dayData = dietData.filter((d) => d.date === dateStr);
  const totalCal = dayData.reduce((sum, x) => sum + (x.calories || 0), 0);
  const totalCost = dayData.reduce((sum, x) => sum + (x.cost || 0), 0);

  const settings = store.loadSettings();
  const goal = Number(settings.dailyCalorieGoal) || 0;

  // ---- 已有记录列表
  if (dayData.length > 0) {
    container.appendChild(el('div', {
      class: 'diet-meal-header',
      text: '📋 今日饮食记录',
      style: { marginTop: '0' },
    }));

    dayData.forEach((item) => {
      container.appendChild(buildEntryRow(item));
      // 正在编辑这一条时，在它下面插入编辑表单
      if (editingId === item.id) {
        container.appendChild(buildEditForm(item));
      }
    });
  }

  // ---- 添加区
  container.appendChild(buildAddSection(dateStr));

  // ---- 日汇总
  if (dayData.length > 0) {
    container.appendChild(buildDaySummary(totalCal, totalCost, goal, dayData.length));
  }
}

function buildEntryRow(item) {
  const info = mealInfo(item.meal);
  const row = el('div', { class: 'diet-item' });

  // 缩略图 / 占位
  if (item.photo) {
    row.appendChild(el('img', {
      class: 'diet-item-photo',
      src: item.photo,
      alt: item.name,
      loading: 'lazy',
    }));
  } else {
    row.appendChild(el('div', { class: 'diet-item-photo-placeholder', text: info.icon }));
  }

  // 文字信息
  const meta = el('div', { class: 'diet-item-meta' }, [
    el('span', { text: `${info.icon} ${info.label}` }),
  ]);
  if (item.calories) {
    meta.appendChild(el('span', { class: 'diet-item-cal', text: `${item.calories} kcal` }));
  }
  if (item.cost) {
    meta.appendChild(el('span', { class: 'diet-item-cost', text: `¥${formatCost(item.cost)}` }));
  }
  if (item.source === 'ai') {
    meta.appendChild(el('span', { class: 'badge accent', text: 'AI 估算' }));
  }

  row.appendChild(el('div', { class: 'diet-item-info' }, [
    el('div', { class: 'diet-item-name', text: item.name }),
    meta,
  ]));

  // 操作按钮
  row.appendChild(el('button', {
    type: 'button',
    class: 'diet-item-del',
    text: '编辑',
    style: { fontSize: '0.75rem' },
    'aria-label': `编辑 ${item.name}`,
    onclick: (event) => {
      event.stopPropagation();
      editingId = editingId === item.id ? null : item.id;
      renderDiet();
    },
  }));

  row.appendChild(el('button', {
    type: 'button',
    class: 'diet-item-del',
    text: '✕',
    'aria-label': `删除 ${item.name}`,
    onclick: (event) => {
      event.stopPropagation();
      deleteEntry(item);
    },
  }));

  // 点整行看详情
  row.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    openDetail(item);
  });

  return row;
}

/** 内联编辑表单（展开在对应记录下方） */
function buildEditForm(item) {
  const nameIn = el('input', {
    class: 'form-input', value: item.name, placeholder: '食物名称',
    style: { flex: '1 1 100%' },
  });
  const calIn = el('input', {
    class: 'form-input sm-input', type: 'number', inputmode: 'numeric',
    placeholder: '热量(kcal)', value: item.calories || '',
  });
  const costIn = el('input', {
    class: 'form-input sm-input', type: 'number', inputmode: 'decimal',
    placeholder: '金额(¥)', value: item.cost || '',
  });

  const mealSel = el('select', { class: 'form-select sm-input' });
  MEAL_TYPES.forEach((m) => {
    const opt = el('option', { value: m.key, text: `${m.icon} ${m.label}` });
    if (m.key === item.meal) opt.selected = true;
    mealSel.appendChild(opt);
  });

  const saveBtn = el('button', {
    type: 'button', class: 'btn btn-primary btn-sm', text: '保存',
    onclick: () => {
      const newName = nameIn.value.trim();
      if (!newName) {
        deps.notify('食物名称不能为空');
        return;
      }
      item.name = newName;
      item.calories = calIn.value ? parseInt(calIn.value, 10) : 0;
      item.cost = costIn.value ? parseFloat(costIn.value) : 0;
      item.meal = mealSel.value;

      const result = store.save(STORAGE_KEYS.diet, dietData);
      if (!result.ok) {
        deps.notify(result.quotaExceeded ? '存储空间不足，修改没保存' : '保存失败');
        return;
      }
      editingId = null;
      renderDiet();
      deps.notify('已修改');
    },
  });

  const cancelBtn = el('button', {
    type: 'button', class: 'btn btn-ghost btn-sm', text: '取消',
    onclick: () => {
      editingId = null;
      renderDiet();
    },
  });

  return el('div', {
    class: 'diet-add-row',
    style: { marginTop: '6px' },
  }, [nameIn, calIn, costIn, mealSel, saveBtn, cancelBtn]);
}

/** 添加区：名称 / 热量 / 金额 / 餐次 + 添加按钮 */
function buildAddSection(dateStr) {
  const nameInput = el('input', {
    class: 'form-input', id: 'addFoodName', placeholder: '食物名称',
    style: { flex: '1 1 100%' },
  });
  const calInput = el('input', {
    class: 'form-input sm-input', id: 'addFoodCal', type: 'number',
    inputmode: 'numeric', placeholder: '热量(kcal)',
  });
  const costInput = el('input', {
    class: 'form-input sm-input', id: 'addFoodCost', type: 'number',
    inputmode: 'decimal', placeholder: '金额(¥)',
  });

  const mealSelect = el('select', { class: 'form-select sm-input', id: 'addFoodMeal' });
  const detected = detectMealType();
  MEAL_TYPES.forEach((m) => {
    const opt = el('option', { value: m.key, text: `${m.icon} ${m.label}` });
    if (m.key === detected) opt.selected = true;
    mealSelect.appendChild(opt);
  });

  function addItem() {
    const name = nameInput.value.trim();
    if (!name) {
      deps.notify('请填写食物名称');
      nameInput.focus();
      return;
    }

    const entry = {
      id: genId(),
      date: dateStr,
      meal: mealSelect.value,
      name,
      calories: calInput.value ? parseInt(calInput.value, 10) : 0,
      cost: costInput.value ? parseFloat(costInput.value) : 0,
    };

    dietData.push(entry);
    const result = store.save(STORAGE_KEYS.diet, dietData);
    if (!result.ok) {
      // 写入失败：撤回内存里的改动，并明确报错
      dietData = dietData.filter((x) => x.id !== entry.id);
      deps.notify(result.quotaExceeded
        ? '存储空间不足，记录没保存（试试删掉一些带照片的记录）'
        : '保存失败，请重试');
      return;
    }

    renderDiet();
    deps.notify('已记录');
  }

  const addBtn = el('button', {
    type: 'button', class: 'btn btn-primary btn-sm', text: '添加',
    style: { minWidth: '60px' },
    onclick: addItem,
  });

  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addItem();
    }
  });

  const header = el('div', {
    class: 'diet-meal-header',
    text: '➕ 添加食物',
    style: { marginTop: dietData.some((d) => d.date === dateStr) ? '16px' : '0' },
  });

  return el('div', { class: 'diet-meal-section' }, [
    header,
    el('div', { class: 'diet-add-row' }, [
      nameInput, calInput, costInput, mealSelect, addBtn,
    ]),
  ]);
}

function buildDaySummary(totalCal, totalCost, goal, count) {
  const caloriesItem = el('div', { class: 'summary-item' }, [
    el('div', {
      class: 'summary-value',
      // [改进] 超标时标红并显示超出量，而不是只说「还可摄入 0」
      text: String(totalCal),
      style: goal > 0 && totalCal > goal ? { color: 'var(--danger)' } : {},
    }),
    el('div', {
      class: 'summary-label',
      text: goal > 0 && totalCal > goal
        ? `超标 ${totalCal - goal}`
        : '总热量(kcal)',
    }),
  ]);

  return el('div', { class: 'daily-summary' }, [
    caloriesItem,
    el('div', { class: 'summary-item' }, [
      el('div', { class: 'summary-value', text: `¥${totalCost.toFixed(1)}` }),
      el('div', { class: 'summary-label', text: '总花费' }),
    ]),
    el('div', { class: 'summary-item' }, [
      el('div', { class: 'summary-value', text: String(count) }),
      el('div', { class: 'summary-label', text: '记录条数' }),
    ]),
  ]);
}

/* ==================================================================== 照片 */

async function handlePhotoSelected(event) {
  const file = event.target.files && event.target.files[0];
  // 允许连续选同一张照片
  event.target.value = '';
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    deps.notify('请选择图片文件');
    return;
  }

  try {
    deps.notify('正在处理照片…', 1200);
    // 压缩到 1024px / JPEG 0.75 —— 既省空间，也是 AI 能接受的格式
    const result = await compressImage(file, 1024, 0.75);
    pendingPhoto = result;

    const previewEl = $('#photoPreview');
    const previewImg = $('#photoPreviewImg');
    if (previewImg) previewImg.src = result.dataUrl;
    if (previewEl) previewEl.classList.add('show');

    const uploadArea = $('#photoUploadArea');
    if (uploadArea) uploadArea.style.display = 'none';

    renderAutoAddForm();
  } catch (err) {
    console.error('[diet] 照片处理失败：', err);
    deps.notify(err.message || '照片处理失败，请换一张');
  }
}

function clearPendingPhoto() {
  pendingPhoto = null;
  const previewEl = $('#photoPreview');
  const previewImg = $('#photoPreviewImg');
  if (previewEl) previewEl.classList.remove('show');
  if (previewImg) previewImg.removeAttribute('src');
  const uploadArea = $('#photoUploadArea');
  if (uploadArea) uploadArea.style.display = '';

  const autoAdd = $('#dietAutoAdd');
  if (autoAdd) clear(autoAdd);

  const analyzing = $('#photoAnalyzing');
  if (analyzing) analyzing.classList.remove('active');
}

/**
 * 选好照片后的「确认记录」表单。
 *
 * [改进] 原型用 MutationObserver 监听 preview 元素的 style 变化来触发这个表单，
 * 非常脆弱（换个写法就不触发）。现在改为在选照片成功后**直接调用**。
 *
 * [改进] 原本还会 setTimeout 1.8 秒后用 Math.random() 从 FOOD_DB 抽一条填进去，
 * 假装是「识别结果」。那是假功能，现在去掉了 —— 没有配置 AI 时就老实让用户手填。
 */
function renderAutoAddForm() {
  const container = $('#dietAutoAdd');
  if (!container) return;
  clear(container);
  if (!pendingPhoto) return;

  const nameInput = el('input', {
    class: 'form-input', id: 'autoFoodName', placeholder: '食物名称（可修改）',
    style: { flex: '1 1 100%' },
  });
  const calInput = el('input', {
    class: 'form-input sm-input', id: 'autoFoodCal', type: 'number',
    inputmode: 'numeric', placeholder: '热量(kcal)',
  });
  const costInput = el('input', {
    class: 'form-input sm-input', id: 'autoFoodCost', type: 'number',
    inputmode: 'decimal', placeholder: '金额(¥)',
  });

  const mealSelect = el('select', { class: 'form-select sm-input', id: 'autoFoodMeal' });
  const detected = detectMealType();
  MEAL_TYPES.forEach((m) => {
    const opt = el('option', { value: m.key, text: `${m.icon} ${m.label}` });
    if (m.key === detected) opt.selected = true;
    mealSelect.appendChild(opt);
  });

  const saveBtn = el('button', {
    type: 'button', class: 'btn btn-primary btn-sm', text: '记录',
    onclick: () => {
      const name = nameInput.value.trim();
      if (!name) {
        deps.notify('请填写食物名称');
        return;
      }

      const entry = {
        id: genId(),
        date: formatDate(dietDate),
        meal: mealSelect.value,
        name,
        calories: calInput.value ? parseInt(calInput.value, 10) : 0,
        cost: costInput.value ? parseFloat(costInput.value) : 0,
        photo: pendingPhoto ? pendingPhoto.dataUrl : undefined,
        source: 'manual',
      };

      dietData.push(entry);
      const result = store.save(STORAGE_KEYS.diet, dietData);
      if (!result.ok) {
        dietData = dietData.filter((x) => x.id !== entry.id);
        deps.notify(result.quotaExceeded
          ? '存储空间不足，含照片的记录没保存成功。建议删掉一些旧照片记录。'
          : '保存失败，请重试',
          4000);
        return;
      }

      clearPendingPhoto();
      renderDiet();
      deps.notify('已记录，含照片');
    },
  });

  const hideBtn = el('button', {
    type: 'button', class: 'btn btn-ghost btn-sm', text: '不使用照片',
    onclick: () => clearPendingPhoto(),
  });

  container.appendChild(el('div', { class: 'diet-meal-section' }, [
    el('div', { class: 'diet-meal-header', text: '📷 带照片的记录' }),
    el('div', { class: 'diet-add-row' }, [
      nameInput, calInput, costInput, mealSelect, saveBtn, hideBtn,
    ]),
    el('div', {
      class: 'form-hint',
      text: '没有配置 AI 识别，请手动填写名称与热量。配置方法见「设置」。',
    }),
  ]));

  nameInput.focus();
}

/* ==================================================================== 周历 */

export function renderWeekly() {
  const grid = $('#weekGrid');
  const statsEl = $('#weekStats');
  if (!grid) return;

  const weekStart = addDays(startOfWeekMonday(), weekOffset * 7);
  const weekEnd = addDays(weekStart, 6);

  const labelEl = $('#weekLabel');
  if (labelEl) {
    labelEl.textContent = `${weekStart.getMonth() + 1}/${weekStart.getDate()}`
      + ` — ${weekEnd.getMonth() + 1}/${weekEnd.getDate()}`;
  }

  // 「下周」在本周时禁用
  const nextBtn = $('#weekNext');
  if (nextBtn) nextBtn.disabled = weekOffset >= 0;

  const settings = store.loadSettings();
  const goal = Number(settings.dailyCalorieGoal) || 0;
  const todayStr = formatDate(today());

  clear(grid);

  let weekTotalCal = 0;
  let weekTotalCost = 0;
  let weekTotalCount = 0;

  for (let i = 0; i < 7; i += 1) {
    const day = addDays(weekStart, i);
    const dateStr = formatDate(day);
    const dayItems = dietData.filter((x) => x.date === dateStr);

    const dayCal = dayItems.reduce((sum, x) => sum + (x.calories || 0), 0);
    const dayCost = dayItems.reduce((sum, x) => sum + (x.cost || 0), 0);

    weekTotalCal += dayCal;
    weekTotalCost += dayCost;
    weekTotalCount += dayItems.length;

    const isToday = dateStr === todayStr;
    const isFuture = day > today();

    const cell = el('div', {
      class: `week-day-cell${isToday ? ' today' : ''}${isFuture ? ' future' : ''}`,
      role: 'button',
      tabindex: '0',
      'aria-label': `${day.getMonth() + 1}月${day.getDate()}日，${dayItems.length} 条记录，${dayCal} 千卡`,
    }, [
      el('div', {
        class: 'week-day-name',
        text: ['日', '一', '二', '三', '四', '五', '六'][day.getDay()],
      }),
      el('div', { class: 'week-day-date', text: String(day.getDate()) }),
      buildWeekCellPhotos(dayItems),
    ]);

    if (dayCal > 0) {
      cell.appendChild(el('div', {
        class: `week-day-cal${goal > 0 && dayCal > goal ? ' over' : ''}`,
        text: `${dayCal}`,
      }));
    } else {
      cell.appendChild(el('div', { class: 'week-day-cal', text: ' ' }));
    }

    const openDay = () => {
      // [改进] 未来的日期不给点进去（否则用户会以为能记录未来）
      if (isFuture) {
        deps.notify('未来的日期还没有记录');
        return;
      }
      dietDate = parseDayKey(dateStr);
      switchView('daily');
    };

    cell.addEventListener('click', openDay);
    cell.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openDay();
      }
    });

    grid.appendChild(cell);
  }

  // ---- 周汇总
  if (statsEl) {
    clear(statsEl);

    // [修复] 原来这里的分母是「记录条数」，标签写「平均热量/餐」，
    // 数值严重偏小且含义不清。改成「日均热量」，分母用本周**已过去的天数** ——
    // 周三打开时用 3 天，而不是把后面 4 天的 0 也算进去。
    const denominator = elapsedDaysInWeek(weekStart);
    const avg = denominator > 0 ? Math.round(weekTotalCal / denominator) : 0;

    [
      { val: String(weekTotalCal), label: '周总热量(kcal)' },
      { val: `¥${weekTotalCost.toFixed(1)}`, label: '周总花费' },
      { val: String(weekTotalCount), label: '记录条数' },
      { val: denominator > 0 ? String(avg) : '—', label: '日均热量(kcal)' },
    ].forEach((item) => {
      statsEl.appendChild(el('div', { class: 'summary-item' }, [
        el('div', { class: 'summary-value', text: item.val }),
        el('div', { class: 'summary-label', text: item.label }),
      ]));
    });

    if (denominator > 0 && denominator < 7) {
      statsEl.appendChild(el('div', {
        class: 'form-hint',
        style: { flex: '1 1 100%', textAlign: 'center', marginTop: '4px' },
        text: `日均按本周已过去的 ${denominator} 天计算，未把未来几天算成 0`,
      }));
    }
  }
}

/**
 * 本周已经过去几天（用于日均热量的分母）。
 * - 历史周（整周已过完）→ 7
 * - 本周 → 周一…今天
 * - 未来周 → 0（没有意义，界面上显示「—」）
 */
function elapsedDaysInWeek(weekStart) {
  const t = today();
  const weekEnd = addDays(weekStart, 6);
  if (weekEnd < t) return 7;
  if (weekStart > t) return 0;
  return Math.floor((t - weekStart) / 86400000) + 1;
}

function buildWeekCellPhotos(dayItems) {
  const wrap = el('div', { class: 'week-day-photos' });
  const withPhoto = dayItems.filter((x) => x.photo);

  if (withPhoto.length > 0) {
    withPhoto.slice(0, 4).forEach((item) => {
      wrap.appendChild(el('img', {
        class: 'week-day-photo-thumb',
        src: item.photo,
        alt: item.name,
        loading: 'lazy',
      }));
    });
  } else if (dayItems.length > 0) {
    for (let i = 0; i < Math.min(dayItems.length, 3); i += 1) {
      wrap.appendChild(el('div', { class: 'week-day-photo-dot' }));
    }
  }
  return wrap;
}

/* ==================================================================== 详情 */

function openDetail(item) {
  detailId = item.id;

  const photoEl = $('#foodDetailPhoto');
  if (photoEl) {
    if (item.photo) {
      photoEl.src = item.photo;
      photoEl.style.display = 'block';
    } else {
      photoEl.removeAttribute('src');
      photoEl.style.display = 'none';
    }
  }

  const info = mealInfo(item.meal);
  const set = (id, text) => {
    const node = $(id);
    if (node) node.textContent = text;
  };

  set('#foodDetailName', item.name);
  set('#foodDetailMeal', `${info.icon} ${info.label}`);
  set('#foodDetailCal', item.calories ? `${item.calories} kcal` : '未填写');
  set('#foodDetailCost', `¥${formatCost(item.cost)}`);
  set('#foodDetailDate', item.date);

  $('#foodDetailModal')?.classList.add('show');
}

function closeDetail() {
  $('#foodDetailModal')?.classList.remove('show');
  detailId = null;
}

/* ==================================================================== 删除 */

/**
 * 删除一条饮食记录。
 * 与课程删除一致：立即从界面移除，5 秒后才真正落库，期间可撤销。
 */
function deleteEntry(item) {
  const previous = dietData.slice();
  dietData = dietData.filter((x) => x.id !== item.id);
  if (editingId === item.id) editingId = null;

  if (viewMode === 'weekly') renderWeekly();
  else renderDiet();

  deps.scheduleUndo(
    `已删除「${item.name}」`,
    () => {
      const result = store.save(STORAGE_KEYS.diet, dietData);
      if (!result.ok) {
        dietData = previous;
        if (viewMode === 'weekly') renderWeekly();
        else renderDiet();
        deps.notify('删除没有保存成功，记录已恢复');
      }
    },
    () => {
      dietData = previous;
      if (viewMode === 'weekly') renderWeekly();
      else renderDiet();
    },
  );
}
