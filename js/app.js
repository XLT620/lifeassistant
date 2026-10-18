/* ==========================================================================
   应用入口
   --------------------------------------------------------------------------
   职责：
     1. 等待 DOM 就绪，初始化三个功能模块
     2. 处理底部 Tab 切换（含从 URL 参数 ?tab=diet 直接进入某一页）
     3. 提供全局的 Toast 与「撤销条」（替代原型的确认弹窗删除流程）
     4. 明暗模式切换（跟随系统 / 手动指定）
     5. 注册 Service Worker（离线可用 + 可安装到主屏幕）
     6. 顶部课前提醒横幅（每分钟刷新）

   原型的这几个功能是散在全局作用域里的，拆成模块后统一收在这里，
   并通过 `createFeedback()` 暴露给各功能模块使用。
   ========================================================================== */

import {
  $, $$,
} from './utils.js';
import { THEME_KEY } from './constants.js';
import * as store from './store.js';
import { initSchedule, renderSchedule, reloadCourses, checkReminder } from './schedule.js';
import { initDiet, renderDiet, renderWeekly, getDietViewMode } from './diet.js';
import { initJournal, renderJournal } from './journal.js';
import { initSettings, openSettings } from './settings.js';
import { initImport, openImportSheet } from './courseImport.js';

/* ==================================================================== 反馈 */

/**
 * Toast 与撤销条。
 *
 * 撤销条替代了原型的「确认弹窗 → 确定删除」流程。
 * 原因：确认弹窗每次都要读一遍再做决定，很打断；而直接删 + 5 秒撤销
 * 既少一次交互，又比直接删安全（用户有后悔的机会）。
 *
 * 撤销是**延迟提交**：数据在 5 秒后才真正写入存储，
 * 所以即使中途关掉页面，数据也还在（只是没删成）。
 */
function createFeedback() {
  const toastEl = $('#toast');
  const undoEl = $('#undoBar');
  const undoTextEl = $('#undoText');
  const undoBtn = $('#undoBtn');

  let toastTimer = null;
  let undoTimer = null;
  let pendingUndo = null;

  const UNDO_MS = 5000;

  function notify(message, ms = 2200) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('show');
      toastTimer = null;
    }, ms);
  }

  function commitPendingUndo() {
    if (!pendingUndo) return;
    const action = pendingUndo;
    pendingUndo = null;
    if (undoTimer) {
      clearTimeout(undoTimer);
      undoTimer = null;
    }
    undoEl?.classList.remove('show');
    try {
      action.commit();
    } catch (err) {
      console.error('[feedback] 提交删除时出错：', err);
    }
  }

  /**
   * 登记一次可撤销的操作。
   * @param {string} message        撤销条上的文字
   * @param {Function} commit       5 秒后真正执行（落库）
   * @param {Function} revert       用户点撤销时执行
   */
  function scheduleUndo(message, commit, revert) {
    // 同一时刻只保留一个撤销条：前一个先提交掉，
    // 否则用户会以为「都撤销了」，实际只撤销了最后一次
    commitPendingUndo();

    pendingUndo = { commit, revert };
    if (undoTextEl) undoTextEl.textContent = message;
    undoEl?.classList.add('show');

    undoTimer = setTimeout(() => {
      commitPendingUndo();
    }, UNDO_MS);
  }

  undoBtn?.addEventListener('click', () => {
    if (!pendingUndo) return;
    const action = pendingUndo;
    pendingUndo = null;
    if (undoTimer) {
      clearTimeout(undoTimer);
      undoTimer = null;
    }
    undoEl?.classList.remove('show');
    try {
      action.revert();
      notify('已撤销');
    } catch (err) {
      console.error('[feedback] 撤销时出错：', err);
      notify('撤销失败');
    }
  });

  // 切换页面时把挂起的删除落库，避免状态悬空
  window.addEventListener('pagehide', commitPendingUndo);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') commitPendingUndo();
  });

  return { notify, scheduleUndo, commitPendingUndo };
}

export const feedback = createFeedback();

/* ==================================================================== 主题 */

function initTheme() {
  const btn = $('#themeToggle');
  if (!btn) return;

  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function savedTheme() {
    try {
      const value = localStorage.getItem(THEME_KEY);
      return value === 'light' || value === 'dark' ? value : 'auto';
    } catch (err) {
      return 'auto';
    }
  }

  function apply(theme) {
    const root = document.documentElement;
    if (theme === 'auto') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', theme);
    }
    // 同步 iOS 状态栏颜色，让状态栏文字与顶栏协调
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const isDark = theme === 'dark'
        || (theme === 'auto' && media && media.matches);
      meta.setAttribute('content', isDark ? '#3A6259' : '#4A7C6F');
    }
    if (btn) {
      const effective = theme === 'auto'
        ? (media && media.matches ? 'dark' : 'light')
        : theme;
      // 切换图标：深色时显示太阳（点它会切到浅色），浅色时显示月亮
      const use = btn.querySelector('use');
      if (use) {
        use.setAttribute('href', effective === 'dark' ? '#i-sun' : '#i-moon');
      }
      btn.setAttribute('aria-label',
        effective === 'dark' ? '切换到浅色模式' : '切换到深色模式');
    }
  }

  btn.addEventListener('click', () => {
    const current = savedTheme();
    const effective = current === 'auto'
      ? (media && media.matches ? 'dark' : 'light')
      : current;
    const next = effective === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (err) {
      /* 无痕模式下可能失败，不影响切换本身 */
    }
    apply(next);
  });

  // 未手动选择时跟随系统
  if (media) {
    const onChange = () => {
      if (savedTheme() === 'auto') apply('auto');
    };
    if (media.addEventListener) media.addEventListener('change', onChange);
    else if (media.addListener) media.addListener(onChange);
  }

  apply(savedTheme());
}

/* ==================================================================== Tab */

/**
 * 底部 Tab 栏的三个页面。
 * 设置页（settings）不在这个数组里 —— 它不是 Tab，是从顶栏齿轮进入的子页面，
 * 所以进入设置时底部 Tab 不高亮任何一个，避免"我在哪一页"的困惑。
 */
const TABS = ['schedule', 'diet', 'journal'];

/** 当前显示的页面，可能是 TABS 里的一个，也可能是 'settings' */
let activeTab = 'schedule';

function switchTab(name, { scrollTop = true } = {}) {
  const isSettings = name === 'settings';

  // 未知名字一律回到课程表（防御性）
  if (!isSettings && !TABS.includes(name)) name = 'schedule';
  activeTab = name;

  // ---- 底部 Tab 的高亮
  // 设置页不属于任何 Tab，所以全部取消高亮
  $$('.tab-btn').forEach((btn) => {
    const isActive = !isSettings && btn.dataset.tab === name;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  // ---- 面板切换
  $$('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `panel-${name}`);
  });

  // ---- 刷新该页数据
  if (name === 'schedule') {
    renderSchedule();
    checkReminder();
  } else if (name === 'diet') {
    if (getDietViewMode() === 'weekly') renderWeekly();
    else renderDiet();
  } else if (name === 'journal') {
    renderJournal();
  } else if (isSettings) {
    // 每次进入都重新读一遍设置，避免显示过期值
    openSettings();
  }

  const main = $('.app-main');
  if (main && scrollTop) main.scrollTop = 0;

  // ---- 地址栏
  // 设置页也写进 ?tab=，这样刷新后还在设置页（调试时有用）
  try {
    const url = new URL(window.location.href);
    if (name === 'schedule') url.searchParams.delete('tab');
    else url.searchParams.set('tab', name);
    window.history.replaceState(null, '', url.toString());
  } catch (err) {
    /* file:// 下可能不支持，忽略 */
  }
}

function initTabs() {
  // ---- 底部三个 Tab
  $$('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // ---- 顶栏齿轮 → 设置页
  $('#settingsButton')?.addEventListener('click', () => switchTab('settings'));

  // ---- 设置页的返回按钮 → 回到课程表
  $('#settingsBackBtn')?.addEventListener('click', () => switchTab('schedule'));

  // ---- 支持 ?tab=diet 直达（PWA 的 shortcuts 用到了这个）
  // 注意也要允许 ?tab=settings，方便调试时直接进设置页
  const params = new URLSearchParams(window.location.search);
  const initial = params.get('tab');
  const valid = initial === 'settings' || TABS.includes(initial);
  switchTab(valid ? initial : 'schedule');
}

/* ==================================================================== 顶栏 */

function initHeader() {
  const dateEl = $('#headerDate');
  const now = new Date();
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  if (dateEl) dateEl.textContent = `${now.getMonth() + 1}月${now.getDate()}日 ${week}`;
}

/* ==================================================================== 提醒 */

/**
 * 课前提醒横幅。
 *
 * ⚠️ 这是**页面内**提醒，只有 App 打开着才看得到。
 * iOS 上的 PWA 无法做真正的后台定时通知（平台限制），
 * 所以这里用了三层补偿：
 *   1. 这个横幅（App 打开时每分钟刷新）
 *   2. 如果用户授权了通知权限，在 App 处于前台时也发一条系统通知
 *   3. 显示「下一节课」始终在最显眼的位置（课程表页顶部）
 */
function initReminderLoop() {
  checkReminder();
  setInterval(checkReminder, 60000);
  // 回到前台时立刻重算 —— 从后台切回来时数据可能已经过期
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkReminder();
  });
}

/* ==================================================================== SW */

/**
 * 注册 Service Worker。
 *
 * 只在 http/https 下注册 —— file:// 协议不支持 Service Worker，
 * 直接双击 index.html 打开时会走到这里，不该报错。
 */
function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') {
    console.info('[sw] file:// 协议下不支持 Service Worker，已跳过。'
      + '想测试离线功能请用本地服务器打开。');
    return;
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js')
      .then((reg) => {
        console.info('[sw] 注册成功，作用域：', reg.scope);
        // 有新版本时提示用户刷新（避免用户一直用着旧缓存）
        reg.addEventListener('updatefound', () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              feedback.notify('有新版本，下拉刷新即可更新', 4000);
            }
          });
        });
      })
      .catch((err) => {
        console.warn('[sw] 注册失败：', err);
      });
  });
}

/* ==================================================================== 启动 */

function boot() {
  // 存储可用性检查：Safari 无痕模式下 localStorage 会直接抛异常
  if (!store.isAvailable()) {
    const warn = $('#storageWarning');
    if (warn) {
      warn.hidden = false;
      warn.textContent = '当前浏览器不允许本地存储（可能是无痕模式），'
        + '你记录的内容在关闭页面后会丢失。请改用普通模式。';
    }
  }

  initTheme();
  initHeader();

  // 三个功能模块各自初始化（绑定各自的表单与按钮）
  try {
    initSchedule({ notify: feedback.notify, scheduleUndo: feedback.scheduleUndo });
    initDiet({ notify: feedback.notify, scheduleUndo: feedback.scheduleUndo });
    initJournal({ notify: feedback.notify, scheduleUndo: feedback.scheduleUndo });
    // 课程导入：导入完成后要重画课程表（周视图 + 列表）
    initImport({
      notify: feedback.notify,
      onImported: () => {
        reloadCourses();
      },
    });
    // 设置模块：改动设置后要通知各页面刷新（比如换了热量目标，饮食页要重算）
    initSettings({
      onChange: () => {
        feedback.notify('设置已保存');
        // 当前在哪一页就刷哪一页
        if (activeTab === 'diet') {
          if (getDietViewMode() === 'weekly') renderWeekly();
          else renderDiet();
        } else if (activeTab === 'schedule') {
          // 学期设置改了（开学日期 / 总周数）会直接影响周视图
          reloadCourses();
        }
      },
    });
  } catch (err) {
    console.error('[boot] 模块初始化失败：', err);
    feedback.notify('部分功能初始化失败，请刷新页面', 5000);
  }

  // 顶部「导入」按钮
  $('#importBtn')?.addEventListener('click', () => openImportSheet());

  // 周视图里的「还没设置开学日期」提示，点一下直接进设置
  $('#weekSub')?.addEventListener('click', () => {
    if ($('#weekSub')?.dataset.warn === '1') switchTab('settings');
  });

  initTabs();
  initReminderLoop();
  initServiceWorker();

  console.info('[app] 启动完成');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
