/* ==========================================================================
   存储层
   --------------------------------------------------------------------------
   负责所有 localStorage 读写，并集中处理**配额溢出**。

   ## 这里修的是原型最危险的一个 bug

   原型的写法是：

       function saveData(key, data) {
         localStorage.setItem(key, JSON.stringify(data));
       }

   localStorage 上限约 5 MB。一张手机照片转成 base64 是 2–5 MB，
   **存第二张就爆**。而浏览器此时抛的 `QuotaExceededError` 没有任何地方接住，
   于是：
     - Toast 照常弹「已记录」
     - 数据其实没写进去
     - 刷新页面，新记录全没了

   用户会以为自己记成功了。这比直接报错糟糕得多。

   现在 `save()` 会返回 `{ ok, error }`，调用方据此决定是否提示用户。
   另外提供了 `estimateUsage()`，可以显示「已用 X MB / 约 5 MB」。

   ## 关于照片

   照片目前仍存 base64（与原型一致，保证功能不回归）。
   **阶段 2 会换成 IndexedDB**，那时才能安全地存多张照片。
   现在如果写入失败，界面会明确告诉用户「照片太大，建议删除部分照片」。
   ========================================================================== */

import { STORAGE_KEYS, DEFAULT_SETTINGS } from './constants.js';

/** localStorage 的常见上限（各浏览器不同，取保守值用于提示） */
export const QUOTA_BYTES = 5 * 1024 * 1024;

/**
 * 读取一个键。
 * 数据损坏时返回 fallback 而不是抛异常 —— 一次解析失败不该让整个 App 打不开。
 */
export function load(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null ? fallback : parsed;
  } catch (err) {
    console.warn(`[store] 读取 ${key} 失败，已回退到默认值：`, err);
    return fallback;
  }
}

/**
 * 写入一个键。
 *
 * @returns {{ok: boolean, error: Error|null, quotaExceeded: boolean}}
 */
export function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return { ok: true, error: null, quotaExceeded: false };
  } catch (err) {
    const quotaExceeded = isQuotaError(err);
    console.error(`[store] 写入 ${key} 失败：`, err);
    return { ok: false, error: err, quotaExceeded };
  }
}

/**
 * 判断是不是配额溢出。
 * 不同浏览器给的错误名不一样，都认一遍。
 */
export function isQuotaError(err) {
  if (!err) return false;
  return err.name === 'QuotaExceededError'
    || err.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || err.code === 22
    || err.code === 1014;
}

/** 删除一个键 */
export function remove(key) {
  try {
    localStorage.removeItem(key);
    return true;
  } catch (err) {
    console.warn(`[store] 删除 ${key} 失败：`, err);
    return false;
  }
}

/* ---------------------------------------------------------------- 业务数据 */

export function loadCourses() {
  const data = load(STORAGE_KEYS.courses, []);
  return Array.isArray(data) ? data : [];
}

export function loadDiet() {
  const data = load(STORAGE_KEYS.diet, []);
  return Array.isArray(data) ? data : [];
}

export function loadJournal() {
  const data = load(STORAGE_KEYS.journal, []);
  return Array.isArray(data) ? data : [];
}

/**
 * 读取设置，并与默认值合并。
 * 合并而不是直接返回，是为了让新增的设置项在老用户那里也有值
 * （否则读了老数据后 settings.aiConsent 是 undefined，界面上开关会异常）。
 */
export function loadSettings() {
  const stored = load(STORAGE_KEYS.settings, {}) || {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function saveSettings(settings) {
  return save(STORAGE_KEYS.settings, settings);
}

/* ---------------------------------------------------------------- 容量估算 */

/**
 * 估算 localStorage 已用字节数（按 UTF-16 计，即字符数 × 2）。
 * 用于在界面上提示「存储快满了」，避免用户在不知情的情况下丢数据。
 */
export function estimateUsage() {
  let bytes = 0;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      const value = localStorage.getItem(key) || '';
      // localStorage 按 UTF-16 存储，每个字符 2 字节
      bytes += (key.length + value.length) * 2;
    }
  } catch (err) {
    console.warn('[store] 估算用量失败：', err);
  }
  return bytes;
}

/** "2.4 MB" */
export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 用量百分比（0–100），用于进度条 */
export function usagePercent() {
  return Math.min(100, Math.round((estimateUsage() / QUOTA_BYTES) * 100));
}

/* ---------------------------------------------------------------- 备份 */

/** 导出全部数据（用于「导出备份」功能，也给用户一个自救手段） */
export function exportAll() {
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    courses: loadCourses(),
    diet: loadDiet(),
    journal: loadJournal(),
    settings: (() => {
      const s = loadSettings();
      // 备份里不含 API Key —— 那是凭证，不该跟着备份文件到处跑
      const { apiKey, ...rest } = s;
      return rest;
    })(),
  };
}

/**
 * 导入备份。
 * @param {object} data  之前 exportAll() 的产物
 * @param {'replace'|'merge'} mode
 */
export function importAll(data, mode = 'replace') {
  if (!data || typeof data !== 'object') {
    return { ok: false, message: '备份文件格式不对' };
  }

  const results = [];

  if (mode === 'replace') {
    if (Array.isArray(data.courses)) results.push(['courses', save(STORAGE_KEYS.courses, data.courses)]);
    if (Array.isArray(data.diet)) results.push(['diet', save(STORAGE_KEYS.diet, data.diet)]);
    if (Array.isArray(data.journal)) results.push(['journal', save(STORAGE_KEYS.journal, data.journal)]);
  } else {
    // 合并：按 id 去重，保留现有数据优先
    const mergeInto = (key, incoming) => {
      if (!Array.isArray(incoming)) return ['skip', { ok: true }];
      const current = load(key, []) || [];
      const seen = new Set(current.map((x) => x && x.id));
      const merged = current.concat(incoming.filter((x) => x && !seen.has(x.id)));
      return [key, save(key, merged)];
    };
    results.push(mergeInto(STORAGE_KEYS.courses, data.courses));
    results.push(mergeInto(STORAGE_KEYS.diet, data.diet));
    results.push(mergeInto(STORAGE_KEYS.journal, data.journal));
  }

  const failed = results.filter(([, r]) => r && r.ok === false);
  if (failed.length) {
    return {
      ok: false,
      message: failed.some(([, r]) => r.quotaExceeded)
        ? '空间不足，导入中断。请先清理部分照片。'
        : '导入时写入失败',
    };
  }
  return { ok: true, message: `已导入 ${results.length} 类数据` };
}

/**
 * 清空全部业务数据（保留 API Key 这类设置？不 —— 全清，但会明确告知）。
 */
export function clearAllData({ keepSettings = false } = {}) {
  remove(STORAGE_KEYS.courses);
  remove(STORAGE_KEYS.diet);
  remove(STORAGE_KEYS.journal);
  if (!keepSettings) remove(STORAGE_KEYS.settings);
  return true;
}

/** 存储是否可用（Safari 无痕模式下 localStorage 可能直接抛异常） */
export function isAvailable() {
  try {
    const probe = '__lifeassistant_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch (err) {
    return false;
  }
}
