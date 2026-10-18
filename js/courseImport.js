/* ==========================================================================
   课程导入
   --------------------------------------------------------------------------
   两条路：
     A. 拍一张课程表照片 → AI 识别 → 确认 → 导入
     B. 选文件 / 粘贴文本 → 本地解析 → 确认 → 导入

   共同点：**都要经过「确认」这一步**。
   AI 和解析器都会出错，而且错得很隐蔽（串行、丢单双周、合并格拆错）。
   直接导入的后果是用户过几天才发现课表是错的，却不知道哪里错了。
   ========================================================================== */

import {
  $, el, clear, compressImage, genId, timeToMinutes,
} from './utils.js';
import {
  COLUMN_KEYWORDS, WEEKDAY_NAMES, PERIOD_TIMES, STORAGE_KEYS,
} from './constants.js';
import * as store from './store.js';
import { recognizeTimetable, AIError } from './ai.js';
import {
  parseText, parseXLSX, makeCourse, parseWeeks,
} from './parseTable.js';

/* ---------------------------------------------------------------- 状态 */

let deps = { notify: () => {}, onImported: () => {} };

/** 待确认的课程：[{ course, checked, status }] */
let pending = [];
let sourceLabel = '';
let busy = false;

/* ---------------------------------------------------------------- 初始化 */

export function initImport(dependencies) {
  deps = { ...deps, ...dependencies };

  // 三种文件输入（拍照 / 相册 / 文件）
  $('#importCameraInput')?.addEventListener('change', (e) => handleImagePick(e, '拍照'));
  $('#importAlbumInput')?.addEventListener('change', (e) => handleImagePick(e, '相册'));
  $('#importFileInput')?.addEventListener('change', handleFilePick);

  // 点遮罩关闭
  $('#importOverlay')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget && !busy) closeOverlay();
  });
}

export function openImportSheet() {
  renderChoose();
}

function closeOverlay() {
  const overlay = $('#importOverlay');
  if (overlay) overlay.hidden = true;
  pending = [];
  busy = false;
}

function showOverlay() {
  const overlay = $('#importOverlay');
  if (overlay) overlay.hidden = false;
}

function panel() {
  return $('#importPanel');
}

/* ============================================================ 第 1 步：选方式 */

function renderChoose() {
  const root = panel();
  if (!root) return;
  showOverlay();
  clear(root);
  root.className = 'import-panel import-sheet';

  root.appendChild(el('div', { class: 'import-handle' }));
  root.appendChild(el('div', { class: 'import-head-row' }, [
    el('h2', { class: 'import-title', text: '导入课程表' }),
    el('button', {
      type: 'button', class: 'import-close', text: '✕', 'aria-label': '关闭', onclick: closeOverlay,
    }),
  ]));
  root.appendChild(el('p', {
    class: 'import-lead',
    text: '一学期十几门课，不用一门一门敲。',
  }));

  root.appendChild(buildOption({
    icon: '📷',
    title: '拍一张课程表照片',
    desc: '教务系统截图、同学发的课表图都能认',
    primary: true,
    onclick: () => $('#importCameraInput')?.click(),
  }));

  root.appendChild(buildOption({
    icon: '🖼',
    title: '从相册选一张课表',
    desc: '已经有截图的话用这个',
    onclick: () => $('#importAlbumInput')?.click(),
  }));

  root.appendChild(buildOption({
    icon: '📄',
    title: '导入文件 / 粘贴文本',
    desc: 'Excel、CSV、日历文件，或直接粘贴教务系统的表',
    onclick: renderFileStep,
  }));

  root.appendChild(el('button', {
    type: 'button',
    class: 'import-manual',
    text: '或者，手动添加一门课',
    onclick: () => {
      closeOverlay();
      $('#courseName')?.focus();
    },
  }));

  root.appendChild(el('div', { class: 'import-note' }, [
    el('span', { text: '🔒' }),
    el('span', {
      text: '文件只在你的手机上解析，不会上传。只有「拍照识别」需要把图片发给 AI，'
        + '并且要先在设置里打开开关。',
    }),
  ]));
}

function buildOption({ icon, title, desc, onclick, primary }) {
  return el('button', {
    type: 'button',
    class: `import-opt${primary ? ' primary' : ''}`,
    onclick,
  }, [
    el('span', { class: 'import-opt-icon', text: icon }),
    el('span', { class: 'import-opt-body' }, [
      el('span', { class: 'import-opt-t', text: title }),
      el('span', { class: 'import-opt-d', text: desc }),
    ]),
    el('span', { class: 'import-opt-chev', text: '›' }),
  ]);
}

/* ============================================================ 图片 */

async function handleImagePick(event, label) {
  const input = event.target;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    deps.notify('请选一张图片');
    return;
  }

  showOverlay();
  renderBusy('正在准备图片…');

  try {
    const compressed = await compressImage(file, 1024, 0.75);
    renderImagePreview(compressed.dataUrl, label);
  } catch (err) {
    console.error('[import] 图片处理失败：', err);
    renderError('图片读不出来，请换一张。', () => renderChoose());
  }
}

function renderImagePreview(dataUrl, label) {
  const root = panel();
  if (!root) return;
  clear(root);
  root.className = 'import-panel import-full';

  root.appendChild(buildTopBar(`识别课程表`, `${label} · 第 2 步，共 3 步`, () => renderChoose()));

  const body = el('div', { class: 'import-scroll' });
  body.appendChild(el('div', { class: 'import-photo' }, [
    el('img', { src: dataUrl, alt: '课程表预览' }),
  ]));

  const settings = store.loadSettings();
  const ready = settings.aiConsent
    && (settings.aiMode === 'direct' ? settings.apiKey : settings.proxyUrl);

  if (!ready) {
    body.appendChild(el('div', { class: 'import-warn' }, [
      el('span', { text: '⚠' }),
      el('span', {
        text: settings.aiConsent
          ? '还没填 API Key 或服务地址。到「设置 → 拍照识别」里补齐就能用了。'
          : '还没同意把图片发给 AI。到「设置 → 拍照识别」里打开那个开关就能用了。',
      }),
    ]));
  }

  root.appendChild(body);

  const footer = el('div', { class: 'import-footer' }, [
    el('button', {
      type: 'button', class: 'btn btn-ghost', text: '重选', onclick: () => renderChoose(),
    }),
    el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: ready ? '开始识别' : '去设置',
      onclick: ready ? () => runRecognize(dataUrl) : () => {
        closeOverlay();
        deps.notify('点右上角齿轮进入设置');
      },
    }),
  ]);
  root.appendChild(footer);
}

async function runRecognize(dataUrl) {
  renderBusy('AI 正在读取星期和节次…', [
    '图片已准备好',
    '读取星期、节次和课程名',
    '拆出教师与教室',
    '等你确认',
  ]);

  const settings = store.loadSettings();

  try {
    const result = await recognizeTimetable({ imageDataUrl: dataUrl, settings });
    applyRecognized(result);
  } catch (err) {
    const message = err instanceof AIError ? err.message : `识别失败：${err.message}`;
    renderError(message, () => renderImagePreview(dataUrl, '拍照'), '再试一次');
  }
}

/** 把 AI 的结果转成待确认的课程 */
function applyRecognized(result) {
  const list = [];

  result.courses.forEach((raw) => {
    const name = String(raw.name || '').trim();
    if (!name) return;

    // AI 用 1..7 表示周一到周日，内部用 0..6（0=周日）
    let day = Number(raw.day);
    if (!Number.isFinite(day) || day < 1 || day > 7) day = 1;
    day = day === 7 ? 0 : day;

    let sp = Number(raw.startPeriod);
    let ep = Number(raw.endPeriod);
    if (!Number.isFinite(sp) || sp < 1) sp = 1;
    if (!Number.isFinite(ep) || ep < sp) ep = sp;

    const t = PERIOD_TIMES.find((p) => p.period === sp);
    const tEnd = PERIOD_TIMES.find((p) => p.period === ep);

    list.push(makeCourse({
      name,
      teacher: raw.teacher,
      room: raw.room,
      day,
      startPeriod: sp,
      endPeriod: ep,
      start: t ? t.start : undefined,
      end: tEnd ? tEnd.end : undefined,
      weeks: parseWeeks(raw.weeks),
      confidence: typeof raw.confidence === 'number' ? raw.confidence : 1,
    }));
  });

  (result.noSlotCourses || []).forEach((raw) => {
    const name = String(raw.name || '').trim();
    if (!name) return;
    list.push(makeCourse({
      name,
      room: '',
      teacher: '',
      day: 1,
      weeks: parseWeeks(raw.weeks),
      noSlot: true,
      code: raw.code || '',
    }));
  });

  if (!list.length) {
    renderError('没有识别出可用的课程，请换一张更清晰的图。', renderChoose);
    return;
  }

  pending = list.map((course) => ({ course, checked: true, status: 'ok' }));
  sourceLabel = '照片识别';

  // 整张图整体把握低时提醒一句
  const lowConfidence = typeof result.meta.confidence === 'number' && result.meta.confidence < 0.5;

  renderConfirm(lowConfidence
    ? 'AI 对这张图的整体把握不高，请重点核对每一门。' : '');
}

/* ============================================================ 文件 / 粘贴 */

function renderFileStep() {
  const root = panel();
  if (!root) return;
  clear(root);
  root.className = 'import-panel import-full';

  root.appendChild(buildTopBar('导入文件', '第 1 步，共 3 步', () => renderChoose()));

  const body = el('div', { class: 'import-scroll' });

  const tabs = el('div', { class: 'import-tabs' });
  const fileTab = el('button', {
    type: 'button', class: 'on', text: '选择文件', onclick: () => switchTab('file'),
  });
  const pasteTab = el('button', {
    type: 'button', text: '粘贴文本', onclick: () => switchTab('paste'),
  });
  tabs.appendChild(fileTab);
  tabs.appendChild(pasteTab);
  body.appendChild(tabs);

  const filePane = el('div', { class: 'import-pane' }, [
    el('button', {
      type: 'button', class: 'import-filezone', onclick: () => $('#importFileInput')?.click(),
    }, [
      el('span', { class: 'import-fz-icon', text: '📄' }),
      el('span', { class: 'import-fz-t', text: '点这里选择文件' }),
      el('span', { class: 'import-fz-d', text: '教务系统导出的课表，或别的课表 App 导出的日历' }),
      el('span', { class: 'import-fz-fmts' }, [
        el('span', { class: 'import-fmt', text: '.xlsx' }),
        el('span', { class: 'import-fmt', text: '.csv' }),
        el('span', { class: 'import-fmt', text: '.ics' }),
        el('span', { class: 'import-fmt', text: '.txt' }),
      ]),
    ]),
  ]);

  const pastePane = el('div', { class: 'import-pane', hidden: true }, [
    el('textarea', {
      class: 'import-textarea',
      id: 'importPasteArea',
      rows: '8',
      placeholder: '把教务系统的课表框选复制，粘贴到这里…\n\n'
        + '也支持一行一门课的表，例如：\n高等数学\t周一\t第1-2节\tA301',
    }),
    el('button', {
      type: 'button', class: 'btn btn-primary', id: 'importPasteGo', text: '解析这段文本',
      onclick: () => {
        const area = $('#importPasteArea');
        handleText(area ? area.value : '', '粘贴的文本');
      },
    }),
  ]);

  body.appendChild(filePane);
  body.appendChild(pastePane);

  body.appendChild(el('div', { class: 'import-note' }, [
    el('span', { text: '💡' }),
    el('span', {
      text: '最省事的办法：在教务系统里框选整个课表 → 复制 → 切到「粘贴文本」贴进来。',
    }),
  ]));

  root.appendChild(body);

  function switchTab(which) {
    fileTab.classList.toggle('on', which === 'file');
    pasteTab.classList.toggle('on', which === 'paste');
    filePane.hidden = which !== 'file';
    pastePane.hidden = which !== 'paste';
    if (which === 'paste') $('#importPasteArea')?.focus();
  }
}

async function handleFilePick(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;

  showOverlay();
  renderBusy('正在解析文件…');

  const name = file.name.toLowerCase();

  try {
    if (name.endsWith('.xlsx')) {
      const buffer = await file.arrayBuffer();
      const rows = await parseXLSX(buffer);
      // 把二维表拼回制表符分隔的文本，复用统一解析
      const text = rows.map((r) => r.join('\t')).join('\n');
      handleText(text, file.name, true);
      return;
    }

    const text = await file.text();
    handleText(text, file.name, true);
  } catch (err) {
    console.error('[import] 文件解析失败：', err);
    const hint = /xlsx|解压|ZIP/i.test(err.message)
      ? '这类 Excel 读不了。请在 Excel 里「另存为 CSV」再导入。'
      : `文件读不出来：${err.message}`;
    renderError(hint, () => renderFileStep());
  }
}

function handleText(text, label, alreadyBusy) {
  if (!text || !text.trim()) {
    renderError('没有内容可解析。', () => renderFileStep());
    return;
  }

  if (!alreadyBusy) {
    showOverlay();
    renderBusy('正在解析…');
  }

  try {
    const { courses, kind } = parseText(text, COLUMN_KEYWORDS);

    if (!courses.length) {
      renderError(
        '没能从这段内容里认出课程。请确认复制的是课表（含星期和课程名）。',
        () => renderFileStep(),
      );
      return;
    }

    pending = courses.map((course) => ({ course, checked: true, status: 'ok' }));
    sourceLabel = `${label}（${kindName(kind)}）`;
    renderConfirm();
  } catch (err) {
    console.error('[import] 解析出错：', err);
    renderError(`解析出错：${err.message}`, () => renderFileStep());
  }
}

function kindName(kind) {
  return {
    matrix: '网格表', table: '普通表', position: '按位置猜的',
    ics: '日历文件', empty: '空内容',
  }[kind] || kind;
}

/* ============================================================ 确认 */

function renderConfirm(notice = '') {
  const root = panel();
  if (!root) return;
  clear(root);
  root.className = 'import-panel import-full';

  // 先算重复/冲突（需要和已有课程比）
  const existing = store.loadCourses();
  pending.forEach((item) => {
    if (item.course.noSlot) { item.status = 'noslot'; return; }
    item.status = analyzeStatus(item.course, existing, pending);
    // 重复的默认不勾选
    if (item.status === 'dup') item.checked = false;
  });

  const total = pending.length;
  const dupCount = pending.filter((x) => x.status === 'dup').length;
  const conflictCount = pending.filter((x) => x.status === 'conflict').length;
  const lowConf = pending.filter((x) => x.course.confidence < 0.7 && x.course.confidence > 0).length;

  root.appendChild(buildTopBar('核对一下', `${sourceLabel} · 第 3 步，共 3 步`, closeOverlay));

  const body = el('div', { class: 'import-scroll' });

  const head = el('div', { class: 'import-confirm-head' }, [
    el('div', { class: 'import-ch-t', text: `识别到 ${total} 门课` }),
    el('div', { class: 'import-ch-d', text: '点「改」可以改星期和节次；点方框可以取消勾选。' }),
  ]);

  const flags = [];
  if (dupCount) flags.push(`${dupCount} 条可能重复`);
  if (conflictCount) flags.push(`${conflictCount} 条时间冲突`);
  if (lowConf) flags.push(`${lowConf} 条把握不高`);
  if (notice) flags.unshift(notice);
  if (flags.length) {
    head.appendChild(el('div', { class: 'import-ch-warn' }, [
      el('span', { text: '⚠' }),
      el('span', { text: flags.join('；') }),
    ]));
  }
  body.appendChild(head);

  const list = el('div', { class: 'import-list' });
  pending.forEach((item, index) => {
    list.appendChild(buildConfirmItem(item, index));
  });
  body.appendChild(list);

  root.appendChild(body);

  // 底部按钮
  const countEl = el('span', { class: 'import-count', text: '' });
  const commitBtn = el('button', {
    type: 'button', class: 'btn btn-primary', onclick: () => commitImport(),
  }, [document.createTextNode('导入选中的 '), countEl, document.createTextNode(' 门')]);

  function refreshCount() {
    const n = pending.filter((x) => x.checked).length;
    countEl.textContent = String(n);
    commitBtn.disabled = n === 0;
  }
  refreshCount();
  // 存一份刷新函数给行用
  root.__refreshCount = refreshCount;

  root.appendChild(el('div', { class: 'import-footer' }, [
    el('button', {
      type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeOverlay,
    }),
    commitBtn,
  ]));
}

function buildConfirmItem(item, index) {
  const { course } = item;

  const wrap = el('div', { class: 'import-item' });

  const ck = el('button', {
    type: 'button',
    class: `import-ck${item.checked ? ' on' : ''}`,
    'aria-label': item.checked ? '取消勾选' : '勾选',
    onclick: () => {
      item.checked = !item.checked;
      ck.classList.toggle('on', item.checked);
      ck.setAttribute('aria-label', item.checked ? '取消勾选' : '勾选');
      const root = panel();
      if (root && root.__refreshCount) root.__refreshCount();
    },
  }, [item.checked ? document.createTextNode('✓') : '']);

  const nameInput = el('input', {
    class: 'import-name',
    value: course.name,
    'aria-label': '课程名称',
    oninput: (e) => { course.name = e.target.value; },
  });

  const meta = el('div', {
    class: 'import-meta',
    text: describeCourse(course),
  });

  const flagRow = el('div', { class: 'import-flags' });
  if (item.status === 'dup') {
    flagRow.appendChild(el('span', { class: 'import-flag warn', text: '可能重复：已有同名课程' }));
  } else if (item.status === 'conflict') {
    flagRow.appendChild(el('span', { class: 'import-flag bad', text: '与其他课时间重叠' }));
  }
  if (item.status === 'noslot') {
    flagRow.appendChild(el('span', { class: 'import-flag', text: '没有固定时间' }));
  }
  if (course.confidence > 0 && course.confidence < 0.7) {
    flagRow.appendChild(el('span', {
      class: 'import-flag warn',
      text: `把握 ${Math.round(course.confidence * 100)}%，建议核对`,
    }));
  }
  if (course.weeks) {
    flagRow.appendChild(el('span', { class: 'import-flag', text: course.weeks }));
  }

  const main = el('div', { class: 'import-main' }, [nameInput, meta, flagRow]);

  const editBtn = el('button', {
    type: 'button', class: 'import-edit-btn', text: '改',
  });

  const row = el('div', {
    class: `import-row${item.status === 'dup' ? ' dup' : ''}${item.status === 'conflict' ? ' conflict' : ''}`,
  }, [ck, main, editBtn]);

  // ---- 编辑区（默认收起）
  const edit = el('div', { class: 'import-edit', hidden: true });

  const daySelect = el('select', { class: 'import-select', 'aria-label': '星期' });
  [1, 2, 3, 4, 5, 6, 0].forEach((d) => {
    const opt = el('option', { value: String(d), text: WEEKDAY_NAMES[d] });
    if (Number(course.day) === d) opt.selected = true;
    daySelect.appendChild(opt);
  });

  const startSelect = el('select', { class: 'import-select', 'aria-label': '开始节次' });
  const endSelect = el('select', { class: 'import-select', 'aria-label': '结束节次' });
  PERIOD_TIMES.forEach((p) => {
    const o1 = el('option', { value: String(p.period), text: `第${p.period}节` });
    if (Number(course.startPeriod) === p.period) o1.selected = true;
    startSelect.appendChild(o1);
    const o2 = el('option', { value: String(p.period), text: `第${p.period}节` });
    if (Number(course.endPeriod) === p.period) o2.selected = true;
    endSelect.appendChild(o2);
  });

  const roomInput = el('input', {
    class: 'import-input', value: course.room || '', placeholder: '地点', 'aria-label': '地点',
    oninput: (e) => { course.room = e.target.value; meta.textContent = describeCourse(course); },
  });

  const teacherInput = el('input', {
    class: 'import-input', value: course.teacher || '', placeholder: '教师', 'aria-label': '教师',
    oninput: (e) => { course.teacher = e.target.value; meta.textContent = describeCourse(course); },
  });

  const weeksInput = el('input', {
    class: 'import-input', value: course.weeks || '', placeholder: '周次，如 1-16 或 单周',
    'aria-label': '周次',
  });

  function syncPeriods() {
    const sp = Number(startSelect.value);
    const ep = Math.max(sp, Number(endSelect.value));
    course.startPeriod = sp;
    course.endPeriod = ep;

    const t1 = PERIOD_TIMES.find((p) => p.period === sp);
    const t2 = PERIOD_TIMES.find((p) => p.period === ep);
    if (t1) course.start = t1.start;
    if (t2) course.end = t2.end;

    course.day = Number(daySelect.value);
    course.weeks = weeksInput.value.trim();
    const w = parseWeeks(course.weeks);
    course.startWeek = w.startWeek;
    course.endWeek = w.endWeek;
    course.parity = w.parity;

    meta.textContent = describeCourse(course);
  }

  [daySelect, startSelect, endSelect].forEach((s) => s.addEventListener('change', syncPeriods));
  weeksInput.addEventListener('input', syncPeriods);

  // 没有固定时间的课（军训、劳动教育）不显示星期和节次 —— 改了也没意义
  if (!course.noSlot) {
    edit.appendChild(el('div', { class: 'import-edit-row' }, [daySelect, startSelect, endSelect]));
    edit.appendChild(el('div', { class: 'import-edit-row' }, [roomInput, teacherInput]));
  }
  edit.appendChild(el('div', { class: 'import-edit-row' }, [weeksInput]));

  editBtn.addEventListener('click', () => {
    edit.hidden = !edit.hidden;
    editBtn.textContent = edit.hidden ? '改' : '收起';
  });

  wrap.appendChild(row);
  wrap.appendChild(edit);

  return wrap;
}

/** 一句话描述一门课 */
function describeCourse(course) {
  if (course.noSlot) return [course.code, course.weeks].filter(Boolean).join(' · ') || '无固定时间';

  const parts = [WEEKDAY_NAMES[course.day]];
  if (course.startPeriod) {
    parts.push(course.endPeriod && course.endPeriod !== course.startPeriod
      ? `第${course.startPeriod}-${course.endPeriod}节`
      : `第${course.startPeriod}节`);
  } else if (course.start) {
    parts.push(`${course.start}–${course.end}`);
  }
  if (course.teacher) parts.push(course.teacher);
  if (course.room) parts.push(course.room);
  return parts.join(' · ');
}

/* ---------------------------------------------------------------- 去重判定 */

const norm = (s) => String(s || '').replace(/\s/g, '');

/**
 * 判断一门待导入课程与已有课程的关系。
 *   'dup'      完全重复（同名 + 同星期 + 开始时间相差 ≤5 分钟）
 *   'conflict' 时间重叠但名字不同
 *   'ok'       没问题
 */
function analyzeStatus(course, existing, batch) {
  for (const ex of existing) {
    if (ex.noSlot) continue;
    if (norm(ex.name) !== norm(course.name)) continue;
    if (Number(ex.day) !== Number(course.day)) continue;
    const a = timeToMinutes(ex.start);
    const b = timeToMinutes(course.start);
    if (a !== null && b !== null && Math.abs(a - b) <= 5) return 'dup';
  }

  // 和本批次内其他行是否重复
  const others = batch.filter((x) => x.course !== course && !x.course.noSlot);
  for (const other of others) {
    if (norm(other.course.name) !== norm(course.name)) continue;
    if (Number(other.course.day) !== Number(course.day)) continue;
    const a = timeToMinutes(other.course.start);
    const b = timeToMinutes(course.start);
    if (a !== null && b !== null && Math.abs(a - b) <= 5) return 'dup';
  }

  const b1 = timeToMinutes(course.start);
  const b2 = timeToMinutes(course.end);
  if (b1 === null || b2 === null) return 'ok';

  for (const ex of existing) {
    if (ex.noSlot) continue;
    if (Number(ex.day) !== Number(course.day)) continue;
    if (norm(ex.name) === norm(course.name)) continue;
    const a1 = timeToMinutes(ex.start);
    const a2 = timeToMinutes(ex.end);
    if (a1 === null || a2 === null) continue;
    if (b1 < a2 && b2 > a1) return 'conflict';
  }

  return 'ok';
}

/* ============================================================ 写入 */

function commitImport() {
  const chosen = pending.filter((x) => x.checked).map((x) => x.course);
  if (!chosen.length) {
    deps.notify('没有勾选任何课程');
    return;
  }

  // 名字为空的不要
  const valid = chosen.filter((c) => c.name && c.name.trim());
  if (!valid.length) {
    deps.notify('课程名称都是空的，请先填写');
    return;
  }

  const existing = store.loadCourses();
  const added = valid.map((c) => ({ ...c, id: genId() }));

  const next = existing.concat(added);
  const result = store.save(STORAGE_KEYS.courses, next);

  if (!result.ok) {
    deps.notify(result.quotaExceeded ? '存储空间不足，没保存成功' : '保存失败，请重试');
    return;
  }

  closeOverlay();
  deps.notify(`已导入 ${added.length} 门课`);
  deps.onImported(added.length);
}

/* ============================================================ 通用界面 */

function buildTopBar(title, subtitle, onBack) {
  return el('div', { class: 'import-topbar' }, [
    el('button', {
      type: 'button', class: 'import-back', 'aria-label': '返回', onclick: onBack,
    }, [
      el('svg', { class: 'icon', 'aria-hidden': 'true' }, [
        el('use', { href: '#i-chevron-left' }),
      ]),
    ]),
    el('div', { class: 'import-titlewrap' }, [
      el('div', { class: 'import-title', text: title }),
      el('div', { class: 'import-sub', text: subtitle }),
    ]),
    el('span', { class: 'import-spacer' }),
  ]);
}

function renderBusy(text, steps) {
  const root = panel();
  if (!root) return;
  clear(root);
  root.className = 'import-panel import-full import-busy-panel';

  const body = el('div', { class: 'import-busy' }, [
    el('div', { class: 'import-spinner' }),
    el('div', { class: 'import-busy-t', text }),
    el('div', { class: 'import-busy-d', text: '通常需要 5~15 秒，请不要退出' }),
  ]);

  if (steps) {
    const list = el('div', { class: 'import-steps' });
    steps.forEach((label, i) => {
      list.appendChild(el('div', {
        class: `import-step${i === 0 ? ' done' : (i === 1 ? ' active' : '')}`,
      }, [
        el('span', { class: 'import-step-bullet', text: i === 0 ? '✓' : '' }),
        el('span', { text: label }),
      ]));
    });
    body.appendChild(list);
  }

  root.appendChild(body);
}

function renderError(message, onRetry, retryText = '重来') {
  const root = panel();
  if (!root) return;
  clear(root);
  root.className = 'import-panel import-full';

  root.appendChild(buildTopBar('没成功', '', closeOverlay));

  root.appendChild(el('div', { class: 'import-scroll' }, [
    el('div', { class: 'import-error' }, [
      el('div', { class: 'import-error-icon', text: '😕' }),
      el('div', { class: 'import-error-text', text: message }),
    ]),
    el('div', { class: 'import-note' }, [
      el('span', { text: '💡' }),
      el('span', { text: '如果一直不行，可以用「导入文件 / 粘贴文本」，那个完全在本地解析，不依赖网络。' }),
    ]),
  ]));

  root.appendChild(el('div', { class: 'import-footer' }, [
    el('button', { type: 'button', class: 'btn btn-ghost', text: '关闭', onclick: closeOverlay }),
    el('button', {
      type: 'button', class: 'btn btn-primary', text: retryText, onclick: onRetry,
    }),
  ]));
}
