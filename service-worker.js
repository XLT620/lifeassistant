/* ==========================================================================
   Service Worker —— 让 App 能离线打开、能安装到主屏幕
   --------------------------------------------------------------------------
   ## 缓存策略（两套，按请求类型分流）

   | 请求类型            | 策略                | 原因 |
   | ------------------- | ------------------- | ---- |
   | 页面导航（HTML）    | 网络优先 + 缓存兜底 | **绝对不能让用户看到旧界面**：如果缓存优先，你更新了代码，用户却还在用几个月前的版本 |
   | CSS / JS / 图标     | 缓存优先 + 后台更新 | 这些文件内容稳定，缓存优先启动最快 |

   ## 关于版本号

   `CACHE_VERSION` 一旦改动，旧缓存会在 activate 阶段被清掉，
   用户下次打开就走网络拿新文件。

   ⚠️ **每次改完 HTML / CSS / JS，都要把下面这个版本号加一**，
   否则用户（包括你自己）看到的还是旧版。

   ## 为什么不缓存照片

   饮食记录里的照片是用户自己的数据，存在 localStorage 里。
   本文件只缓存**程序本身**，不碰用户数据 ——
   这样"清缓存"不会误删用户的记录。

   ## ⚠️ 这个文件必须是不带 BOM 的 UTF-8

   带 BOM 时浏览器会报
   "ServiceWorker script evaluation failed" 并拒绝注册。

   特别提醒：**不要用 PowerShell 的 Set-Content 改这个文件**。
   Windows PowerShell 5.1 的 `Set-Content -Encoding utf8`
   会同时做两件坏事：写入 BOM，并且按 GBK 误解码原本的 UTF-8 内容
   （中文全变乱码、注释里的换行还会丢失，直接导致语法错误）。
   改版本号请用文本编辑器（VS Code、记事本都行）。
   ========================================================================== */

const CACHE_VERSION = 'v3.2.0';
const CACHE_NAME = `lifeassistant-${CACHE_VERSION}`;

/**
 * 需要预缓存的程序文件（app shell）。
 * 路径都相对于 service-worker.js 所在目录（也就是 pwa/）。
 *
 * ⚠️ 新增文件时**必须**加进这个清单，否则：
 *   - 第一次访问能加载（走网络）
 *   - 但离线后再打开会因为缓存里没有而失败
 * 表现是「联网能用、断网就白屏」，很难查。
 */
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',

  './css/tokens.css',
  './css/base.css',
  './css/components.css',
  './css/settings.css',
  './css/course.css',

  './js/app.js',
  './js/constants.js',
  './js/utils.js',
  './js/store.js',
  './js/schedule.js',
  './js/diet.js',
  './js/journal.js',
  './js/ai.js',
  './js/settings.js',
  './js/parseTable.js',
  './js/weekGrid.js',
  './js/courseImport.js',

  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

/* ==================================================================== 安装 */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // 逐个添加而不是 addAll：
    // addAll 只要有一个文件 404 就会整体失败，Service Worker 装不上、
    // 离线功能彻底不可用。逐个添加能让"部分成功"也算装上。
    const results = await Promise.allSettled(
      APP_SHELL.map(async (url) => {
        try {
          await cache.add(new Request(url, { cache: 'reload' }));
          return { url, ok: true };
        } catch (err) {
          console.warn('[sw] 预缓存失败：', url, err.message);
          return { url, ok: false };
        }
      }),
    );

    const failed = results
      .filter((r) => r.status === 'fulfilled' && !r.value.ok)
      .map((r) => r.value.url);
    if (failed.length) {
      console.warn(`[sw] 有 ${failed.length} 个文件没缓存上：`, failed);
    }

    // 让新的 Service Worker 立刻接管，不用等用户关掉所有标签页
    await self.skipWaiting();
  })());
});

/* ==================================================================== 激活 */

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 清掉旧版本缓存
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith('lifeassistant-') && name !== CACHE_NAME)
        .map((name) => {
          console.info('[sw] 清理旧缓存：', name);
          return caches.delete(name);
        }),
    );

    // 立刻接管所有已打开的页面
    await self.clients.claim();
  })());
});

/* ==================================================================== 拦截 */

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // 只处理 GET。POST 之类的放行 ——
  // 将来接 AI 识别时会有 POST 请求，不能拦。
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 只接管同源请求。
  // 跨域请求（比如将来调用 api.deepseek.com）必须放行 ——
  // 既不该缓存，也不该被离线策略干扰。
  if (url.origin !== self.location.origin) return;

  // ---------------- 页面导航：网络优先
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, './index.html'));
    return;
  }

  // ---------------- 静态资源：缓存优先
  event.respondWith(cacheFirst(request));
});

/* ==================================================================== 策略 */

/**
 * 网络优先：先试网络，成功就更新缓存并返回；
 * 失败（离线）时用缓存兜底。
 *
 * 页面导航必须用这个：如果把 HTML 也做成缓存优先，
 * 用户会一直看到旧版本界面，而你又没法远程让他刷新。
 */
async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;

    // 没缓存到这一页，退回首页（本项目只有一个页面）
    const fallback = await cache.match(fallbackUrl);
    if (fallback) return fallback;

    return new Response(
      '<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>离线</title>'
      + '<body style="font-family:system-ui;padding:32px;text-align:center;color:#2D3436">'
      + '<h1 style="font-size:20px">暂时打不开</h1>'
      + '<p style="color:#636E72;font-size:14px">'
      + '这个 App 还没缓存完成，或者当前网络不可用。<br>'
      + '请连上网络后重新打开一次。</p></body></html>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

/**
 * 缓存优先：命中缓存直接返回，同时在后台悄悄更新缓存。
 * 静态资源这样启动最快，且下次打开就是新的。
 */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  if (cached) {
    // 后台更新（stale-while-revalidate）
    fetch(request)
      .then((response) => {
        if (response && response.ok) cache.put(request, response.clone());
      })
      .catch(() => { /* 离线时忽略 */ });
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    // 图片这类资源找不到时给个占位响应，避免控制台报错刷屏
    if (request.destination === 'image') {
      return new Response('', { status: 404, statusText: 'offline' });
    }
    throw err;
  }
}

/* ==================================================================== 消息 */

/**
 * 允许页面主动让 Service Worker 立刻更新。
 * app.js 检测到新版本时可以用到（可选功能，暂时没接）。
 */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
