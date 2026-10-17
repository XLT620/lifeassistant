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
import { STORAGE_KEYS, MEAL_TYPES, FOOD_DB } from './constants.js';
import * as store from './store.js';
import { recognizeFood, AIError } from './ai.js';

/* ---------------------------------------------------------------- 状态 */

let dietData = [];
let dietDate = today();
let viewMode = 'daily';          // 'daily' | 'weekly'
let weekOffset = 0;              // 0 = 本周，-1 = 上周
let pendingPhoto = null;         // { dataUrl, width, height, bytes }
let editingId = null;            // 正在内联编辑的记录 id
let detailId = null;             // 详情弹窗里的记录 id
/** AI 识别成功后的结果，用来预填表单并在保存时标注数据来源 */
let aiResult = null;
/** 是否用过本地食物库估算（决定保存时标注的数据来源） */
let localEstimateUsed = false;
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

  // ---- 照片：拍照 / 从相册选（两个独立的隐藏 input，由按钮触发）
  // 为什么拆两个：iOS 上带 capture 的 input 只会弹相机，
  // 不带 capture 的只会弹相册，一次点击没法两全。
  $('#takePhotoBtn')?.addEventListener('click', () => {
    $('#cameraInput')?.click();
  });
  $('#pickPhotoBtn')?.addEventListener('click', () => {
    $('#albumInput')?.click();
  });
  $('#cameraInput')?.addEventListener('change', handlePhotoSelected);
  $('#albumInput')?.addEventListener('change', handlePhotoSelected);
  $('#photoRemoveBtn')?.addEventListener('click', clearPendingPhoto);

  // ---- AI 识别
  $('#aiRecognizeBtn')?.addEventListener('click', handleAiRecognize);

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

/**
 * 用户选好照片之后。
 *
 * 这一版和原型的最大区别：
 *   原型是 setTimeout 1.8 秒后从内置表里 Math.random() 抽一条，
 *   假装"识别成功"。那是假功能。
 *
 *   现在：照片先存下来给你预览，然后**由你点按钮**决定要不要调 AI。
 *   不点就用本地食物库按名称估一个值；点了才发网络请求。
 */
async function handlePhotoSelected(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  // 清空 value，这样连续选同一张照片也能触发 change
  input.value = '';
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    deps.notify('请选一张图片');
    return;
  }

  analyzing(true, '正在处理照片…');
  try {
    // 压缩到 1024px / JPEG 0.75。
    // 1024px 对 DeepSeek 已经足够（服务端会把图缩到约 1300×1300），
    // 压小主要为了省手机内存和上传流量。
    const result = await compressImage(file, 1024, 0.75);
    pendingPhoto = result;
    aiResult = null;

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
  } finally {
    analyzing(false);
  }
}

/** 显示 / 隐藏"正在处理"状态 */
function analyzing(show, text = '正在处理…') {
  const box = $('#photoAnalyzing');
  const label = $('#photoAnalyzingText');
  if (!box) return;
  box.classList.toggle('active', show);
  if (label && text) label.textContent = text;
}

/** 清掉已选照片，恢复到"拍照 / 相册"状态 */
function clearPendingPhoto() {
  pendingPhoto = null;
  aiResult = null;
  localEstimateUsed = false;

  const previewEl = $('#photoPreview');
  const previewImg = $('#photoPreviewImg');
  if (previewEl) previewEl.classList.remove('show');
  if (previewImg) previewImg.removeAttribute('src');

  const uploadArea = $('#photoUploadArea');
  if (uploadArea) uploadArea.style.display = '';

  const autoAdd = $('#dietAutoAdd');
  if (autoAdd) clear(autoAdd);

  const row = $('#aiRecognizeRow');
  if (row) row.hidden = true;

  analyzing(false);
}

/**
 * AI 识别按钮的逻辑。
 *
 * 流程：
 *   1. 检查是否同意把照片发给 AI（没同意就提示去设置，不静默跳过）
 *   2. 调 ai.js 发请求
 *   3. 成功 → 填进表单，标注来源「AI 估算」
 *   4. 失败 → 分两类：
 *        - 用户自己能修的（没填 Key / 没同意）→ 明确提示去哪改
 *        - 服务/网络问题 → 自动回退到本地食物库估算，并说明原因
 */
async function handleAiRecognize() {
  if (!pendingPhoto) return;

  const btn = $('#aiRecognizeBtn');
  const hint = $('#aiRecognizeHint');
  const settings = store.loadSettings();

  // 先检查同意与配置，避免白发一次请求
  if (!settings.aiConsent) {
    showAIError(
      '还没有同意把照片发给 AI。到「设置 → 拍照识别食物」里打开那个开关就行。',
      [{ text: '去设置', onclick: () => deps.notify('点右上角齿轮进入设置') }],
    );
    return;
  }

  if (btn) {
    btn.disabled = true;
  }
  analyzing(true, 'AI 正在认这是什么…');
  if (hint) hint.textContent = '';

  const meal = mealInfo(detectMealType());

  try {
    const result = await recognizeFood({
      imageDataUrl: pendingPhoto.dataUrl,
      settings,
      mealLabel: meal.label,
    });

    aiResult = result;

    // 填进表单
    fillFormWithResult(result);
    removingAIError();

    if (result.calories === 0) {
      deps.notify('认出来了，但没给出热量，麻烦你補一下');
    } else {
      deps.notify(`认出来了：${result.name}`);
    }
  } catch (err) {
    const isAI = err instanceof AIError;
    const message = isAI ? err.message : `识别失败：${err.message}`;
    const shouldFallback = isAI ? err.shouldFallback : true;

    if (shouldFallback) {
      // 服务端/网络问题：自动用本地食物库给个估值，并说清发生了什么
      applyLocalEstimate(true);
      showAIError(`${message}\n\n已经改用内置食物清单估了个大概，你可以手动改。`, [
        { text: '再试一次', onclick: handleAiRecognize },
      ]);
    } else {
      // 用户自己的配置问题：不静默回退，明确告诉他去哪改
      showAIError(message, [
        { text: '知道了', onclick: removingAIError },
      ]);
    }
  } finally {
    if (btn) btn.disabled = false;
    analyzing(false);
  }
}

/** 在表单区显示一条 AI 错误提示（带可选的操作按钮） */
function showAIError(message, actions = []) {
  const container = $('#dietAutoAdd');
  if (!container) return;
  removingAIError();

  const box = el('div', { class: 'ai-error-box', id: 'aiErrorBox' });
  // 用 textContent 逐段写入，避免把换行当 HTML
  message.split('\n').filter((line) => line.trim() !== '').forEach((line) => {
    box.appendChild(el('div', { text: line }));
  });

  if (actions.length) {
    const row = el('div', { class: 'ai-error-actions' });
    actions.forEach((action) => {
      row.appendChild(el('button', {
        type: 'button',
        class: 'btn btn-ghost btn-sm',
        text: action.text,
        onclick: action.onclick,
      }));
    });
    box.appendChild(row);
  }

  container.insertBefore(box, container.firstChild);
}

function removingAIError() {
  const box = $('#aiErrorBox');
  if (box) box.remove();
}

/**
 * 选好照片后的确认表单。
 *
 * 这里也负责显示「AI 识别」按钮 —— 有照片就出现。
 */
function renderAutoAddForm() {
  const container = $('#dietAutoAdd');
  if (!container) return;
  clear(container);
  if (!pendingPhoto) return;

  // ---- 顶部：AI 识别按钮（表单外，单独一行更醒目）
  const row = $('#aiRecognizeRow');
  if (row) {
    row.hidden = false;
    const hint = $('#aiRecognizeHint');
    const settings = store.loadSettings();
    if (hint) {
      if (!settings.aiConsent) {
        hint.textContent = '想自动识别？先到「设置」里打开「允许把照片发给 AI」。';
      } else if (settings.aiMode === 'direct' && !settings.apiKey) {
        hint.textContent = '想自动识别？先到「设置」里填上你的 API Key。';
      } else if (settings.aiMode === 'proxy' && !settings.proxyUrl) {
        hint.textContent = '想自动识别？先到「设置」里填上服务地址。';
      } else {
        hint.textContent = '点上面的按钮，AI 会认一下这是什么食物并估算热量。';
      }
    }
  }

  // ---- 表单
  const nameInput = el('input', {
    class: 'form-input', id: 'autoFoodName', placeholder: '食物名称',
    style: { flex: '1 1 100%' },
    value: aiResult ? aiResult.name : '',
  });
  const calInput = el('input', {
    class: 'form-input sm-input', id: 'autoFoodCal', type: 'number',
    inputmode: 'numeric', placeholder: '热量(千卡)',
    value: aiResult && aiResult.calories ? String(aiResult.calories) : '',
  });
  const costInput = el('input', {
    class: 'form-input sm-input', id: 'autoFoodCost', type: 'number',
    inputmode: 'decimal', placeholder: '金额(元)',
    value: aiResult && aiResult.cost !== null && aiResult.cost !== undefined
      ? String(aiResult.cost) : '',
  });

  const mealSelect = el('select', { class: 'form-select sm-input', id: 'autoFoodMeal' });
  const detected = detectMealType();
  MEAL_TYPES.forEach((m) => {
    const opt = el('option', { value: m.key, text: `${m.icon} ${m.label}` });
    if (m.key === detected) opt.selected = true;
    mealSelect.appendChild(opt);
  });

  // ---- 候选食物（"也可能是"）
  const alternativesBox = el('div', { class: 'ai-alternatives', id: 'aiAlternatives' });
  if (aiResult && aiResult.alternatives && aiResult.alternatives.length) {
    aiResult.alternatives.forEach((name) => {
      alternativesBox.appendChild(el('button', {
        type: 'button',
        class: 'ai-alternative-chip',
        text: name,
        onclick: () => {
          nameInput.value = name;
          // 换了食物名，重量估算跟着重算
          applyLocalEstimate(false);
        },
      }));
    });
  }

  // ---- 保存
  const saveBtn = el('button', {
    type: 'button', class: 'btn btn-primary btn-sm', text: '记录',
    onclick: () => {
      const name = nameInput.value.trim();
      if (!name) {
        deps.notify('请填写食物名称');
        nameInput.focus();
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
        // 记录数据来源，详情页会显示
        source: aiResult ? 'ai' : (localEstimateUsed ? 'local' : 'manual'),
      };

      dietData.push(entry);
      const result = store.save(STORAGE_KEYS.diet, dietData);
      if (!result.ok) {
        dietData = dietData.filter((x) => x.id !== entry.id);
        deps.notify(result.quotaExceeded
          ? '存储空间不够了，这条带照片的记录没保存成。建议删掉一些旧照片记录。'
          : '保存失败，请重试',
          4000);
        return;
      }

      clearPendingPhoto();
      renderDiet();
      deps.notify('已记录');
    },
  });

  const cancelBtn = el('button', {
    type: 'button', class: 'btn btn-ghost btn-sm', text: '不要照片',
    onclick: () => clearPendingPhoto(),
  });

  const section = el('div', { class: 'diet-meal-section' }, [
    el('div', { class: 'diet-meal-header', text: '📷 确认一下' }),
    el('div', { class: 'diet-add-row' }, [
      nameInput, calInput, costInput, mealSelect,
    ]),
    alternativesBox,
    el('div', { class: 'diet-add-row' }, [saveBtn, cancelBtn]),
  ]);

  // 数据来源说明
  if (aiResult) {
    section.insertBefore(el('div', { class: 'ai-source-note' }, [
      el('span', { text: '🤖' }),
      el('span', {
        text: `这些数值来自 AI 估算，不一定准，你可以直接改。`
          + (aiResult.confidence !== null && aiResult.confidence !== undefined
            ? `（AI 自己觉得有 ${Math.round(aiResult.confidence * 100)}% 把握）` : ''),
      }),
    ]), section.children[1]);
  } else if (localEstimateUsed) {
    section.insertBefore(el('div', { class: 'ai-source-note' }, [
      el('span', { text: '📖' }),
      el('span', { text: '这些数值来自内置的常见食物清单，只是粗略估算，请按实际修改。' }),
    ]), section.children[1]);
  }

  container.appendChild(section);
  nameInput.focus();
}

/* ==================================================================== 填表 */

/** 把 AI 识别结果填进表单 */
function fillFormWithResult(result) {
  const nameInput = $('#autoFoodName');
  const calInput = $('#autoFoodCal');
  const costInput = $('#autoFoodCost');

  if (nameInput) nameInput.value = result.name || '';
  if (calInput) calInput.value = result.calories > 0 ? String(result.calories) : '';
  if (costInput) {
    costInput.value = result.cost !== null && result.cost !== undefined && result.cost > 0
      ? String(result.cost) : '';
  }

  localEstimateUsed = false;
}

/**
 * 用内置食物清单估算（离线、免费）。
 *
 * 触发时机：
 *   1. 用户点了「AI 识别」但服务端/网络出错 → 自动回退，让他至少有个数字
 *   2. 用户在「也可能是」里换了食物名 → 重新估一次
 *
 * @param {boolean} overwrite 是否覆盖已填的数值
 *   true  = 覆盖（AI 失败回退时用，此时表单可能是空的）
 *   false = 只填空着的字段（用户手动改了名之后用，保留他填的值）
 */
function applyLocalEstimate(overwrite = false) {
  const nameInput = $('#autoFoodName');
  const calInput = $('#autoFoodCal');
  const costInput = $('#autoFoodCost');
  if (!nameInput || !calInput || !costInput) return;

  const name = nameInput.value.trim();
  if (!name) return;

  const estimate = estimateFromLocalDb(name);
  if (!estimate) return;

  if (overwrite || !calInput.value) {
    calInput.value = String(estimate.calories);
  }
  if (overwrite || !costInput.value) {
    costInput.value = String(estimate.cost);
  }

  localEstimateUsed = true;

  // 追加一条来源说明（如果还没有）
  const container = $('#dietAutoAdd');
  if (container && !container.querySelector('.ai-source-note')) {
    const section = container.querySelector('.diet-meal-section');
    if (section) {
      section.insertBefore(el('div', { class: 'ai-source-note' }, [
        el('span', { text: '📖' }),
        el('span', { text: '这些数值来自内置的常见食物清单，只是粗略估算，请按实际修改。' }),
      ]), section.children[1]);
    }
  }
}

/**
 * 在内置食物清单里按名字找最接近的一项。
 *
 * 匹配策略（从严格到宽松）：
 *   1. 完全相同
 *   2. 包含关系（"红烧牛肉面" 命中 "牛肉面"）
 *   3. 按单字重合度评分，超过阈值才算命中
 *   4. 都没命中 → 给一个保守的默认值
 */
function estimateFromLocalDb(name) {
  const query = name.replace(/\s/g, '');

  // 1. 完全相同
  const exact = FOOD_DB.find((item) => item.name === query);
  if (exact) return { calories: exact.calories, cost: exact.cost };

  // 2. 包含关系（长名字优先，避免「面」抢先匹配）
  const sorted = [...FOOD_DB].sort((a, b) => b.name.length - a.name.length);
  const contains = sorted.find(
    (item) => query.includes(item.name) || item.name.includes(query),
  );
  if (contains) return { calories: contains.calories, cost: contains.cost };

  // 3. 单字重合度
  let best = null;
  let bestScore = 0;
  FOOD_DB.forEach((item) => {
    const common = [...new Set(query)].filter((ch) => item.name.includes(ch)).length;
    const score = common / Math.max(item.name.length, 1);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  });
  if (best && bestScore >= 0.5) {
    return { calories: best.calories, cost: best.cost };
  }

  // 4. 保守默认值。
  // 给一个数而不是 0 —— 0 会让用户以为"这顿饭没有热量"，比粗略值更误导。
  return { calories: 400, cost: 15 };
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
