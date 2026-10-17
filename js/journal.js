/* ==========================================================================
   心得日记模块
   --------------------------------------------------------------------------
   移植自原型（SECTION: journal）。

   ## 改动清单

   1. [改进] 删除改走底部撤销条（延迟提交），不再弹确认框。
   2. [改进] 乐观更新：写完立刻出现在时间线顶部，不需要重新渲染整页
      （原型每次都全量 renderJournal）。
   3. [修复] 写入失败时明确报错并回滚，不再静默丢数据。
   4. [新增] 顶部显示「共 N 篇」，长列表时用户知道总量。
      （列表本身仍是全量渲染；日记数量级不大，暂不需要虚拟滚动）
   ========================================================================== */

import {
  $, $$, el, clear, genId, formatDate, formatDateCN,
} from './utils.js';
import { STORAGE_KEYS } from './constants.js';
import * as store from './store.js';

let journalData = [];
let selectedMood = '';
let deps = { notify: () => {}, scheduleUndo: () => {} };

/* ---------------------------------------------------------------- 初始化 */

export function initJournal(dependencies) {
  deps = { ...deps, ...dependencies };
  journalData = store.loadJournal();

  // 心情选择
  $$('.mood-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mood = btn.dataset.mood;
      // 再点一次取消选择
      selectedMood = selectedMood === mood ? '' : mood;
      $$('.mood-option').forEach((b) => {
        const on = b.dataset.mood === selectedMood;
        b.classList.toggle('selected', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    });
  });

  // 表单提交
  $('#journalForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    handleAddEntry();
  });

  renderJournal();
}

/* ---------------------------------------------------------------- 新增 */

function handleAddEntry() {
  const textEl = $('#journalText');
  const text = (textEl?.value || '').trim();

  if (!text) {
    deps.notify('请先写点什么');
    textEl?.focus();
    return;
  }

  const now = new Date();
  const entry = {
    id: genId(),
    date: formatDate(now),
    dateCN: formatDateCN(now),
    mood: selectedMood,
    text,
    createdAt: now.toISOString(),
  };

  journalData.push(entry);
  const result = store.save(STORAGE_KEYS.journal, journalData);

  if (!result.ok) {
    journalData = journalData.filter((x) => x.id !== entry.id);
    deps.notify(result.quotaExceeded
      ? '存储空间不足，心得没保存成功'
      : '保存失败，请重试');
    return;
  }

  // 清空表单
  if (textEl) textEl.value = '';
  selectedMood = '';
  $$('.mood-option').forEach((b) => {
    b.classList.remove('selected');
    b.setAttribute('aria-pressed', 'false');
  });

  renderJournal();
  deps.notify('心得已记录');
}

/* ---------------------------------------------------------------- 渲染 */

export function renderJournal() {
  const container = $('#journalList');
  if (!container) return;
  clear(container);

  updateCountHint();

  if (journalData.length === 0) {
    container.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-icon', text: '📝' }),
      el('div', { class: 'empty-text', text: '还没有心得记录，写下今天的感受吧' }),
    ]));
    return;
  }

  // 按日期倒序（同一天的多条，后写的排前面）
  const sorted = journalData.slice().sort((a, b) => {
    const byDate = String(b.date).localeCompare(String(a.date));
    if (byDate !== 0) return byDate;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });

  sorted.forEach((entry) => {
    container.appendChild(buildEntry(entry));
  });
}

function buildEntry(entry) {
  const item = el('div', { class: 'journal-entry' });

  // 日期行（含心情）
  const dateRow = el('div', { class: 'journal-date' });
  if (entry.mood) {
    dateRow.appendChild(el('span', {
      class: 'journal-mood',
      text: entry.mood,
      'aria-label': '心情',
    }));
  }
  dateRow.appendChild(el('span', { text: entry.dateCN || entry.date }));
  item.appendChild(dateRow);

  // 正文
  item.appendChild(el('div', { class: 'journal-text', text: entry.text }));

  // 删除
  item.appendChild(el('div', { class: 'journal-footer' }, [
    el('button', {
      type: 'button',
      class: 'btn btn-ghost btn-sm',
      text: '删除',
      'aria-label': '删除这条心得',
      onclick: () => deleteEntry(entry),
    }),
  ]));

  return item;
}

/** 顶部「共 N 篇」提示 */
function updateCountHint() {
  const hint = $('#journalCount');
  if (!hint) return;
  if (journalData.length === 0) {
    hint.textContent = '';
    hint.hidden = true;
  } else {
    hint.hidden = false;
    hint.textContent = `共 ${journalData.length} 篇`;
  }
}

/* ---------------------------------------------------------------- 删除 */

/**
 * 删除一篇心得。
 * 与课程/饮食一致：立即从界面移除，5 秒后才真正落库，期间可撤销。
 */
function deleteEntry(entry) {
  const previous = journalData.slice();
  const preview = entry.text.length > 12 ? `${entry.text.slice(0, 12)}…` : entry.text;

  journalData = journalData.filter((x) => x.id !== entry.id);
  renderJournal();

  deps.scheduleUndo(
    `已删除「${preview}」`,
    () => {
      const result = store.save(STORAGE_KEYS.journal, journalData);
      if (!result.ok) {
        journalData = previous;
        renderJournal();
        deps.notify('删除没有保存成功，心得已恢复');
      }
    },
    () => {
      journalData = previous;
      renderJournal();
    },
  );
}
