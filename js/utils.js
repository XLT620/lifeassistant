/* ==========================================================================
   通用工具
   --------------------------------------------------------------------------
   原型的这些函数是全局的；拆成模块后统一从这里导出。
   行为与原版保持一致，只在注释里标注改动点。
   ========================================================================== */

import { WEEKDAY_NAMES, MEAL_TYPES } from './constants.js';

/* ---------------------------------------------------------------- 日期 */

/**
 * 转成 "YYYY-MM-DD"。
 * 刻意不用 toISOString()：那个走 UTC，在东八区的凌晨会返回前一天。
 */
export function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** "8月25日 周一" */
export function formatDateCN(date) {
  return `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAY_NAMES[date.getDay()]}`;
}

/** "今天" / "昨天" / "8月25日" */
export function relativeDay(date) {
  const today = startOfDay(new Date());
  const target = startOfDay(date);
  const diffDays = Math.round((target - today) / 86400000);
  if (diffDays === 0) return '今天';
  if (diffDays === -1) return '昨天';
  if (diffDays === 1) return '明天';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

/** 今天零点 */
export function today() {
  return startOfDay(new Date());
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * 本周的周一（零点）。
 * 注意 Date.getDay() 是 0=周日，所以周日要往回 6 天，而不是 +1 天。
 */
export function startOfWeekMonday(date = new Date()) {
  const d = startOfDay(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(d, diff);
}

/** 从 "YYYY-MM-DD" 还原 Date */
export function parseDayKey(key) {
  const parts = String(key).split('-');
  return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
}

/**
 * 按当前时间推断餐次。
 *
 * 沿用原型的分段（5 段），但把边界改成**含端点且不重叠**的写法。
 * 原型用 `>= 240 && <= 630` 这种闭区间，相邻两段的边界值（如 630 与 631）
 * 虽然没重叠，但可读性差、改起来容易出错。这里统一用「下界含、上界不含」。
 */
export function detectMealType(date = new Date()) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  if (minutes >= 4 * 60 && minutes < 10 * 60 + 30) return 'breakfast';      // 04:00–10:29
  if (minutes >= 10 * 60 + 30 && minutes < 14 * 60 + 30) return 'lunch';   // 10:30–14:29
  if (minutes >= 14 * 60 + 30 && minutes < 16 * 60 + 30) return 'afternoon_tea'; // 14:30–16:29
  if (minutes >= 16 * 60 + 30 && minutes < 20 * 60 + 30) return 'dinner';  // 16:30–20:29
  return 'late_night';                                                     // 其余
}

/** 距零点的分钟数，用于课程时间比较 */
export function minutesSinceMidnight(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

/** 分钟数 → "08:30" */
export function minutesToTime(minutes) {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

/** "08:30" → 分钟数；非法输入返回 null（不要静默变成 0） */
export function timeToMinutes(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/* ---------------------------------------------------------------- 标识 */

/**
 * 生成唯一 id。
 * 原型用 `Date.now().toString(36) + Math.random().toString(36).substr(2,5)`，
 * 同一毫秒内连续生成有碰撞可能。这里用 crypto.randomUUID（iOS 15.4+ 支持），
 * 不支持时退回原方案。
 */
export function genId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

/* ---------------------------------------------------------------- 数字 */

/** 四舍五入到 n 位小数（避免 0.1+0.2 这类浮点尾巴） */
export function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

/** 金额显示："22" / "22.50" */
export function formatCost(value) {
  const n = Number(value) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/* ---------------------------------------------------------------- DOM */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/** 创建一个元素，附属性与子节点 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
    } else {
      node.setAttribute(key, value);
    }
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** 清空一个容器 */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** 显示 / 隐藏（用 class 而不是 inline style，便于 CSS 控制） */
export function show(node, visible = true) {
  if (node) node.classList.toggle('show', visible);
  return node;
}

export function setHidden(node, hidden) {
  if (node) node.hidden = !!hidden;
  return node;
}

/* ---------------------------------------------------------------- 其他 */

/** 防抖：停止触发 ms 毫秒后才执行。用于 API Key 输入等高频场景。 */
export function debounce(fn, ms = 400) {
  let timer = null;
  return function debounced(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, ms);
  };
}

/** 转义 HTML，防止食物名里的尖括号破坏结构（虽然我们用 textContent，仍留作保险） */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/**
 * 把图片压缩并转成 dataURL。
 *
 * 为什么必须压缩：手机拍的原图 3–5 MB，直接存会让 localStorage 立刻爆配额，
 * 发给 AI 也会顶到请求体上限。这里按最长边缩到 maxSize。
 *
 * @returns {Promise<{dataUrl: string, width: number, height: number, bytes: number}>}
 */
export function compressImage(file, maxSize = 1024, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('这张图片无法解析，请换一张'));
      img.onload = () => {
        let { width, height } = img;
        const longest = Math.max(width, height);
        if (longest > maxSize) {
          const scale = maxSize / longest;
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        // 先铺白底：PNG 的透明区域转 JPEG 会变成黑色
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        // 一律输出 JPEG —— HEIC/PNG/WebP 统一成 AI 能接受的格式
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve({
          dataUrl,
          width,
          height,
          bytes: Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75),
        });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/** 今日是否已过某时刻（用于课程状态判断） */
export function hasPassed(minutes, now = new Date()) {
  return minutesSinceMidnight(now) >= minutes;
}

/** 把餐次 key 换成 {label, icon}；未知 key 也能安全返回 */
export function mealInfo(key) {
  return MEAL_TYPES.find((m) => m.key === key) || { key, label: key || '未分类', icon: '🍽️' };
}
