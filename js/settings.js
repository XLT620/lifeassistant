/* ==========================================================================
   设置页
   --------------------------------------------------------------------------
   包含：AI 识别开关、连接方式、密钥/口令、测试连接、省流量模式、
        每日热量目标、存储用量、清空数据。

   ## 设计原则（针对「给朋友用」这个场景）

   1. **术语通俗化**：主界面上不出现 "API"、"token"、"endpoint" 这类词，
      统一说「服务地址」「口令」「识别次数」。技术细节收在可折叠的说明里。
   2. **两种连接方式**：
      - 「用管理员配好的服务」→ 朋友只需填口令（或什么都不填）
      - 「用我自己的 Key」→ 谁想自己付费用就选这个
   3. **必须能测试**：填完 Key/地址后能一键验证，而不是等到拍照失败才发现。
   4. **危险操作要确认**：清空数据不可撤销。
   ========================================================================== */

import { $, el, clear } from './utils.js';
import { DEFAULT_SETTINGS } from './constants.js';
import * as store from './store.js';
import { testConnection, AIError } from './ai.js';

let settings = { ...DEFAULT_SETTINGS };
let onChangeCallback = () => {};

/** 输入框的防抖保存计时器 */
let saveTimer = null;

export function initSettings({ onChange } = {}) {
  onChangeCallback = onChange || (() => {});
  settings = store.loadSettings();
  renderSettings();
}

/** 打开设置页时调用，确保显示的是最新值 */
export function openSettings() {
  settings = store.loadSettings();
  renderSettings();
}

/* ============================================================ 保存 */

function persist(patch, { notifyText = '' } = {}) {
  settings = { ...settings, ...patch };
  const result = store.saveSettings(settings);
  if (!result.ok) {
    showStatus(result.quotaExceeded ? '存储空间不足，设置没保存' : '设置保存失败', 'error');
    return false;
  }
  if (notifyText) showStatus(notifyText, 'ok');
  onChangeCallback(settings);
  return true;
}

/** 输入类字段用这个：停止输入 800ms 后才落盘，避免每敲一个字写一次 */
function persistDebounced(patch) {
  settings = { ...settings, ...patch };
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    store.saveSettings(settings);
    onChangeCallback(settings);
  }, 800);
}

/* ============================================================ 状态提示 */

function showStatus(message, kind = 'info') {
  const box = $('#settingsStatus');
  if (!box) return;
  box.textContent = message;
  box.dataset.kind = kind;
  box.hidden = false;
  // 成功后 4 秒自动消失，错误保留（用户需要看清）
  if (kind === 'ok') {
    setTimeout(() => {
      if (box.textContent === message) box.hidden = true;
    }, 4000);
  }
}

/* ============================================================ 渲染 */

export function renderSettings() {
  const root = $('#settingsContent');
  if (!root) return;
  clear(root);

  root.appendChild(buildTermSection());
  root.appendChild(buildAISection());
  root.appendChild(buildGoalSection());
  root.appendChild(buildStorageSection());
  root.appendChild(buildAboutSection());
}

/* ---------------------------------------------------------------- 学期 */

/**
 * 学期设置。
 *
 * 这里有两个日期，为什么不能合成一个：
 *
 *   教务处公布的开学日（第 1 周） ≠ 课表实际执行的第 1 周。
 *   比如 9 月 1 日开学，但前两周军训，课表从 9 月 15 日才开始按「第 1 周」走。
 *   学生手里的课表写「第 1 周」，对应的真实日期是 9 月 15 日。
 *
 *   周视图显示的日期、「本周」判断、单双周，都必须用
 *   「课表第 1 周」那个日期（timetableStartDate），
 *   否则整个学期会错开几周 —— 这就是用户报的「本周日期和课表日期不匹配」。
 */
function buildTermSection() {
  const card = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, ['📅', ' 学期设置']),
  ]);

  // ---- 课表基准日期（决定周视图画哪一周）
  card.appendChild(el('div', { class: 'form-group' }, [
    el('label', { class: 'form-label', for: 'timetableStartInput', text: '课表第 1 周的周一' }),
    el('input', {
      class: 'form-input',
      id: 'timetableStartInput',
      type: 'date',
      value: settings.timetableStartDate || '',
      onchange: (e) => persist({ timetableStartDate: e.target.value }, { notifyText: '已保存' }),
    }),
  ]));

  card.appendChild(el('div', {
    class: 'form-hint',
    text: '这一项给周视图用：显示每天是几号、判断现在是第几周、算单双周。'
      + '翻一下教务系统，看「第 1 周」是从哪个周一开始。'
      + '拿不准就先填这个，下面那项留空会自动沿用它。',
  }));

  // ---- 教务处公布的开学日期（只用来提示学期第几周）
  card.appendChild(el('div', {
    class: 'form-group',
    style: { marginTop: 'var(--space-md)' },
  }, [
    el('label', {
      class: 'form-label', for: 'termStartInput', text: '教务处公布的开学日期（可留空）',
    }),
    el('input', {
      class: 'form-input',
      id: 'termStartInput',
      type: 'date',
      value: settings.termStartDate || '',
      onchange: (e) => persist({ termStartDate: e.target.value }, { notifyText: '已保存' }),
    }),
  ]));

  card.appendChild(el('div', {
    class: 'form-hint',
    text: '如果开学后先军训、课表晚几周才开始，就两个都填：'
      + '上面填课表第 1 周那天，下面填教务处说的开学日。'
      + '这样周视图会额外提示「学期第几周」，你能一眼核对两个周次对不对得上。'
      + '两者其实是同一天，就只填上面那个。',
  }));

  // ---- 总周数
  const weekSelect = el('select', {
    class: 'form-select',
    id: 'totalWeeksInput',
    onchange: (e) => persist({ totalWeeks: Number(e.target.value) }, { notifyText: '已保存' }),
  });
  [16, 17, 18, 19, 20, 21, 22].forEach((n) => {
    const opt = el('option', { value: String(n), text: `${n} 周` });
    if (Number(settings.totalWeeks) === n) opt.selected = true;
    weekSelect.appendChild(opt);
  });

  card.appendChild(el('div', { class: 'form-group' }, [
    el('label', { class: 'form-label', for: 'totalWeeksInput', text: '一学期共几周' }),
    weekSelect,
  ]));

  return card;
}

/* ---------------------------------------------------------------- AI 识别 */

function buildAISection() {
  const card = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, [
      svgIcon('i-camera'),
      '拍照识别食物',
    ]),
  ]);

  // ---- 总开关
  card.appendChild(buildToggleRow({
    label: '允许把照片发给 AI',
    hint: settings.aiConsent
      ? '已开启。识别时会把照片发给 AI 服务，用来判断是什么食物。'
      : '关闭状态下，App 只用内置的常见食物清单估算，完全不上网。',
    checked: settings.aiConsent === true,
    onChange: (checked) => {
      persist({ aiConsent: checked });
      renderSettings();
    },
  }));

  // 没同意时，下面的内容都不显示，避免信息过载
  if (!settings.aiConsent) {
    card.appendChild(el('div', {
      class: 'form-hint',
      style: { marginTop: 'var(--space-sm)' },
      text: '打开上面的开关后，这里会出现连接设置。',
    }));
    return card;
  }

  // ---- 连接方式
  // 顺序刻意这样排：「用我自己的 Key」放第一位，因为它是**不需要任何人搭后端**
  // 就能用的默认方案；「用管理员配好的服务」需要有人先部署 Cloudflare Worker。
  const modeField = el('div', { class: 'form-group' }, [
    el('span', { class: 'form-label', text: '用哪个方式识别' }),
  ]);

  modeField.appendChild(buildModeChoice({
    value: 'direct',
    title: '用我自己的 Key（推荐）',
    hint: '自己去 DeepSeek 申请一个 Key 填进来。费用自己承担，'
      + '别人看不到你的 Key，也不需要谁去搭服务器。',
  }));

  modeField.appendChild(buildModeChoice({
    value: 'proxy',
    title: '用管理员配好的服务（进阶）',
    hint: '管理员已经搭好了中转服务器。你不需要申请 Key，'
      + '可能只需填一个口令。',
  }));

  card.appendChild(modeField);

  // ---- 按模式显示不同字段
  if (settings.aiMode === 'direct') {
    card.appendChild(buildDirectFields());
  } else {
    card.appendChild(buildProxyFields());
  }

  // ---- 测试连接
  card.appendChild(el('div', { class: 'settings-actions' }, [
    el('button', {
      type: 'button',
      class: 'btn btn-primary btn-sm',
      id: 'testConnectionBtn',
      text: '测试一下能不能用',
      onclick: handleTestConnection,
    }),
  ]));

  // ---- 省流量
  card.appendChild(buildToggleRow({
    label: '省流量模式',
    hint: '打开后照片压缩得更狠，识别更快更省，但准确度会略降。'
      + '平时推荐打开。',
    checked: settings.saveData === true,
    onChange: (checked) => persist({ saveData: checked }, { notifyText: '已保存' }),
  }));

  // ---- 技术细节（折叠）
  card.appendChild(buildTechnicalDetails());

  return card;
}

function buildModeChoice({ value, title, hint }) {
  const selected = settings.aiMode === value;
  return el('label', {
    class: `choice-card${selected ? ' selected' : ''}`,
  }, [
    el('input', {
      type: 'radio',
      name: 'aiMode',
      value,
      checked: selected,
      onchange: () => {
        persist({ aiMode: value }, { notifyText: '已切换' });
        renderSettings();
      },
    }),
    el('div', { class: 'choice-body' }, [
      el('div', { class: 'choice-title', text: title }),
      el('div', { class: 'choice-hint', text: hint }),
    ]),
  ]);
}

function buildProxyFields() {
  const wrap = el('div', {});

  wrap.appendChild(buildTextField({
    id: 'proxyUrlInput',
    label: '服务地址',
    placeholder: 'https://xxx.workers.dev',
    value: settings.proxyUrl || '',
    hint: '管理员会把这个网址发给你，复制粘贴进来即可。',
    type: 'url',
    onInput: (v) => persistDebounced({ proxyUrl: v.trim() }),
  }));

  wrap.appendChild(buildTextField({
    id: 'proxyCodeInput',
    label: '口令（如果管理员没给就不用填）',
    placeholder: '管理员给你的口令',
    value: settings.proxyCode || '',
    hint: '相当于一个"门禁"，防止陌生人也来用这个服务。',
    type: 'password',
    onInput: (v) => persistDebounced({ proxyCode: v.trim() }),
  }));

  return wrap;
}

function buildDirectFields() {
  const wrap = el('div', {});

  wrap.appendChild(buildTextField({
    id: 'apiKeyInput',
    label: '你的 API Key',
    placeholder: 'sk-...',
    value: settings.apiKey || '',
    hint: '去 platform.deepseek.com/api_keys 创建。'
      + '⚠️ Key 只存在这台手机上，不会上传到任何服务器。',
    type: 'password',
    onInput: (v) => persistDebounced({ apiKey: v.trim() }),
  }));

  // 清除 Key
  wrap.appendChild(el('div', { class: 'settings-actions' }, [
    el('button', {
      type: 'button',
      class: 'btn btn-ghost btn-sm',
      text: '清除已保存的 Key',
      onclick: () => {
        persist({ apiKey: '' }, { notifyText: 'Key 已清除' });
        renderSettings();
      },
    }),
  ]));

  return wrap;
}

/** 技术细节折叠区：把“地址”“Key”这些词的解释收在这里 */
function buildTechnicalDetails() {
  const details = el('details', { class: 'tech-details' }, [
    el('summary', { text: '技术细节（不看也不影响使用）' }),
  ]);

  const body = el('div', { class: 'tech-body' });

  body.appendChild(el('p', {
    text: '识别用的是 DeepSeek 的图片理解模型。两种连接方式的区别：',
  }));

  body.appendChild(el('ul', {}, [
    el('li', { text: '「管理员配好的服务」：请求先发到一台中转服务器，'
      + '由它加上密钥再转发给 DeepSeek。你的手机上不存密钥，朋友也就看不到。' }),
    el('li', { text: '「我自己的 Key」：手机直接连 DeepSeek，'
      + '密钥存在你自己手机的浏览器存储里。别人拿到你手机、并且用开发者工具，'
      + '理论上能看到它。所以这个模式适合"只为我自己用"。' }),
  ]));

  body.appendChild(el('p', {
    text: '每次识别大约消耗 1000 个 token（省流量模式约 300）。'
      + '按 DeepSeek 当前价格，一次约合 ¥0.001，也就是一分钱能识别十次左右。',
  }));

  body.appendChild(el('p', {
    text: '照片只在你点「AI 识别」的那一刻才会发出去。'
      + 'App 平时不会自动上传任何东西。',
  }));

  details.appendChild(body);
  return details;
}

/* ---------------------------------------------------------------- 目标 */

function buildGoalSection() {
  const card = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, ['🎯', ' 每日热量目标']),
  ]);

  const select = el('select', {
    class: 'form-select',
    id: 'goalSelect',
    onchange: (e) => persist({ dailyCalorieGoal: Number(e.target.value) }, { notifyText: '已保存' }),
  });

  [0, 1500, 1800, 2000, 2200, 2500, 2800].forEach((value) => {
    const opt = el('option', {
      value: String(value),
      text: value === 0 ? '不设目标' : `${value} 千卡`,
    });
    if (Number(settings.dailyCalorieGoal) === value) opt.selected = true;
    select.appendChild(opt);
  });

  card.appendChild(select);
  card.appendChild(el('div', {
    class: 'form-hint',
    text: '设了目标后，饮食页会显示"还能吃多少"；超过目标会标红提醒。',
  }));

  return card;
}

/* ---------------------------------------------------------------- 存储 */

function buildStorageSection() {
  const used = store.estimateUsage();
  const percent = store.usagePercent();
  const card = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, ['💾', ' 存储情况']),
  ]);

  card.appendChild(el('div', { class: 'info-row' }, [
    el('span', { class: 'info-label', text: '已用空间' }),
    el('span', { class: 'info-value', text: `${store.formatBytes(used)}（约 ${percent}%）` }),
  ]));

  // 用量条
  card.appendChild(el('div', { class: 'usage-bar' }, [
    el('div', {
      class: 'usage-fill',
      style: { width: `${Math.max(2, percent)}%` },
      'data-level': percent > 80 ? 'danger' : (percent > 60 ? 'warn' : 'ok'),
    }),
  ]));

  if (percent > 70) {
    card.appendChild(el('div', {
      class: 'form-hint',
      text: '空间快满了。浏览器给网页的存储上限约 5 MB，'
        + '照片最占空间。建议删掉一些带照片的旧记录。',
    }));
  } else {
    card.appendChild(el('div', {
      class: 'form-hint',
      text: '记录和照片都存在这台手机上，不会上传。',
    }));
  }

  // 清空数据
  card.appendChild(el('div', { class: 'settings-actions' }, [
    el('button', {
      type: 'button',
      class: 'btn btn-danger btn-sm',
      text: '清空所有记录',
      onclick: handleClearData,
    }),
  ]));

  return card;
}

/* ---------------------------------------------------------------- 关于 */

function buildAboutSection() {
  const card = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, ['ℹ️', ' 关于']),
  ]);

  card.appendChild(el('div', { class: 'info-row' }, [
    el('span', { class: 'info-label', text: '版本' }),
    el('span', { class: 'info-value', text: '2.0.0（PWA）' }),
  ]));

  card.appendChild(el('div', { class: 'info-row' }, [
    el('span', { class: 'info-label', text: '数据存放' }),
    el('span', { class: 'info-value', text: '只在这台手机' }),
  ]));

  card.appendChild(el('div', {
    class: 'form-hint',
    text: '把网页"添加到主屏幕"后，可以像普通 App 一样使用，没网也能打开。',
  }));

  return card;
}

/* ============================================================ 交互 */

/** 测试连接：发一个极小的图片请求，验证地址/口令/Key 是否可用 */
async function handleTestConnection() {
  const btn = $('#testConnectionBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '正在测试…';
  }
  showStatus('正在测试，请稍等…', 'info');

  try {
    const result = await testConnection(settings);
    showStatus(result.message, result.ok ? 'ok' : 'error');
  } catch (err) {
    showStatus(`测试失败：${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '测试一下能不能用';
    }
  }
}

/** 清空数据：两次确认，第一次用原生 confirm 已经足够 */
function handleClearData() {
  const confirmed = window.confirm(
    '确定要清空吗？\n\n'
    + '课程、饮食记录、心得日记都会被删除，无法恢复。\n'
    + '（设置里的 Key 和口令会保留）',
  );
  if (!confirmed) return;

  store.clearAllData({ keepSettings: true });
  showStatus('已清空所有记录。设置保留。', 'ok');

  // 通知外部刷新列表
  onChangeCallback(store.loadSettings());
}

/* ============================================================ 小组件 */

function svgIcon(id) {
  // 用 innerHTML 是为了少写 DOM 构建代码；这里的内容是我们自己的常量，不来自用户输入
  const span = document.createElement('span');
  span.className = 'icon-wrap';
  span.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${id}"/></svg>`;
  return span;
}

/** 一行开关 */
function buildToggleRow({ label, hint, checked, onChange }) {
  const inputId = `toggle-${label.replace(/\s/g, '-')}`;
  return el('div', { class: 'toggle-row' }, [
    el('div', { class: 'toggle-text' }, [
      el('label', { class: 'toggle-label', for: inputId, text: label }),
      el('div', { class: 'toggle-hint', text: hint }),
    ]),
    el('label', { class: 'switch' }, [
      el('input', {
        type: 'checkbox',
        id: inputId,
        checked,
        onchange: (e) => onChange(e.target.checked),
      }),
      el('span', { class: 'switch-track' }),
    ]),
  ]);
}

/** 一个带标签的输入框 */
function buildTextField({ id, label, placeholder, value, hint, type = 'text', onInput }) {
  const input = el('input', {
    class: 'form-input',
    id,
    type,
    placeholder,
    value,
    autocomplete: 'off',
    spellcheck: 'false',
    oninput: (e) => onInput(e.target.value),
  });

  const group = el('div', { class: 'form-group' }, [
    el('label', { class: 'form-label', for: id, text: label }),
    input,
  ]);

  // 密码框加一个"显示"按钮，方便核对有没有输错
  if (type === 'password') {
    const toggle = el('button', {
      type: 'button',
      class: 'reveal-btn',
      text: '显示',
      onclick: () => {
        const showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        toggle.textContent = showing ? '显示' : '隐藏';
      },
    });
    group.appendChild(el('div', { class: 'reveal-row' }, [toggle]));
  }

  if (hint) group.appendChild(el('div', { class: 'form-hint', text: hint }));

  return group;
}
