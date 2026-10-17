# 日程生活助手 · PWA 版

一个可以在 **iPhone 上"添加到主屏幕"、像普通 App 一样使用**的网页应用。
课程表、饮食记录、心得日记三合一，**数据全部存在你自己的手机上**。

---

## 一、这个版本有什么

| 功能 | 说明 |
| --- | --- |
| **课程表** | 添加/删除课程、按星期筛选、按时间排序、**课前提醒横幅** |
| **饮食记录** | 5 个餐次（早/午/下午茶/晚/夜宵）、**按时间自动选餐次**、拍照记录、日汇总、周历 |
| **心得日记** | 6 种心情、写文字、时间线、篇数统计 |
| **深色模式** | 跟随系统，也能手动切换 |
| **离线可用** | 装到主屏幕后，没网也能打开和使用 |
| **删除可撤销** | 删错了 5 秒内点「撤销」能救回来 |

### 和原型（v2）相比改了什么

| 改动 | 为什么 |
| --- | --- |
| **删掉了阿里云埋点脚本** | 原型会加载 `g.alicdn.com` 的第三方统计脚本，往外部上报数据。这既让离线打不开，也和"数据只存本机"冲突 |
| **照片压缩后再存** | 原型直接存原图 base64，一张就 3–5 MB，而浏览器存储上限约 5 MB，**存第二张就爆** |
| **写入失败会明确报错** | 原型的 `saveData()` 没有 try/catch，配额爆了异常被静默吞掉，**界面照样弹"已记录"，但数据根本没写进去**，刷新就没了 |
| **删除改成"直接删 + 撤销条"** | 原型的确认弹窗每次都要读一遍再决定，很打断；直接删 + 5 秒撤销既少一步又更安全 |
| **不能翻到未来日期** | 原型能翻到明天，但记到明天的数据在列表里永远看不到（因为筛选是"今天及以前"），用户会以为丢了 |
| **适配了 iPhone 刘海和安全区** | 原型的 viewport 没有 `viewport-fit=cover`，刘海和底部横条会盖住内容 |
| **周汇总改成"日均热量"** | 原型写的是"平均热量/餐"，但分母用的是**记录条数**，数字含义不清且严重偏小 |
| **底部 Tab 栏** | 原型把导航放顶部（网页习惯）。底部是 iOS 惯例，拇指够得到，也更像 App |
| **真实校验时间** | 原型允许建出"10:00–09:00"这种结束早于开始的课 |

---

## 二、目录结构

```
pwa/
├── index.html              主页面（图标符号也内联在这里）
├── manifest.webmanifest    PWA 清单：名称、图标、启动方式、配色
├── service-worker.js       离线缓存
├── css/
│   ├── tokens.css          设计令牌（明暗两套色值）
│   ├── base.css            重置、排版、安全区、页面骨架
│   └── components.css      卡片/按钮/表单/周历/弹窗等组件
├── js/
│   ├── app.js              入口：Tab 切换、Toast、撤销条、主题、SW 注册
│   ├── constants.js        餐次表、内置食物库、存储键名
│   ├── utils.js            日期、格式化、图片压缩、DOM 辅助
│   ├── store.js            存储层（含配额溢出的正确处理）
│   ├── schedule.js         课程表
│   ├── diet.js             饮食记录
│   └── journal.js          心得日记
├── icons/                  图标（5 个尺寸，含 Apple 主屏幕图标）
├── screenshots/            我用无头浏览器渲染的实拍截图
└── _legacy/
    └── prototype-v2.html   原始原型（保留作对照，不参与运行）
```

---

## 三、在电脑上先跑起来看

### ⚠️ 为什么不能直接双击 index.html

本项目用了 ES 模块（`import` / `export`）。浏览器出于安全考虑
**禁止从 `file://` 加载模块**，直接双击会看到**一片空白**，
控制台报 `Access to script at 'file://...' has been blocked by CORS policy`。

这不是 bug，是浏览器的规定。必须通过 `http://` 打开。

### 启动本地服务器（一句话）

在项目根目录（有 `pwa` 这个文件夹的那一层）打开终端，执行：

```powershell
node tools\serve.js
```

然后浏览器打开：

```
http://localhost:8080
```

要停止服务器，在那个终端窗口按 `Ctrl + C`。

### 在手机上打开看（同一个 WiFi）

服务器启动时会打印出电脑的局域网地址，类似：

```
手机上打开（需要与电脑连同一个 WiFi）：
    http://192.168.1.5:8080    （WLAN）
```

把这个地址在**手机浏览器**里打开就能看到。

⚠️ 手机上**必须用这个 IP**，不能用 `localhost` ——
`localhost` 指的是手机自己，不是你的电脑。

> 如果连不上：检查手机和电脑是否同一个 WiFi；
> Windows 防火墙可能拦了 8080 端口，第一次运行时会弹窗询问，
> 要选「允许访问」。

---

## 四、部署到网上（这样才能装到 iPhone 主屏幕）

"添加到主屏幕"和离线功能都**必须走 HTTPS**，
`localhost` 只在电脑本机算安全上下文，手机上不行。

### 推荐：GitHub Pages（免费、不需要信用卡、自带 HTTPS）

**第 1 步：注册 GitHub 账号**
到 <https://github.com/signup> 注册（免费）。

**第 2 步：建一个仓库**
- 点右上角 `+` → `New repository`
- 名字填 `lifeassistant`（随便，用英文）
- 选 **Public**（私有仓库的 Pages 要付费）
- ⚠️ **不要勾** "Add a README" / "Add .gitignore" / "Choose a license"
  （勾了会和后面 push 的代码冲突）
- 点 `Create repository`

**第 3 步：把 pwa 里的文件传上去**

最简单的方式是用网页上传（不用装 git）：

1. 在新建的仓库页面点 `uploading an existing file`
2. 打开电脑上的 `pwa` 文件夹，**全选里面的所有文件和文件夹**
   （注意是 `pwa` **里面**的内容，不是 `pwa` 这个文件夹本身）
3. 拖到网页的上传区域
4. 下面填个提交信息，比如 `first commit`，点 `Commit changes`

⚠️ 上传后仓库根目录应该能直接看到 `index.html`。
如果看到的是一个 `pwa` 文件夹，说明多套了一层，会导致后面网址不对。

**第 4 步：开启 Pages**
- 仓库页 → `Settings` → 左侧找 `Pages`
- `Source` 选 **Deploy from a branch**
- `Branch` 选 **main**，目录选 **/ (root)**
- 点 `Save`
- 等 1–2 分钟，刷新页面，上方会出现网址：

```
https://你的用户名.github.io/lifeassistant/
```

在电脑浏览器打开这个网址，**确认能看到 App**。

### 其他免费方案（任选）

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| **GitHub Pages** | 免费、无信用卡、自动 HTTPS | 需要公开仓库 |
| **Cloudflare Pages** | 免费、支持私有仓库构建、速度国内较好 | 要注册 Cloudflare |
| **Netlify** | 拖拽文件夹就能部署，最简单 | 需要注册 |
| **Vercel** | 免费、部署快 | 需要注册 |

---

## 五、装到 iPhone 主屏幕

### ⚠️ 必须用 Safari

**iPhone 上的 Chrome 不支持"添加到主屏幕"成独立 App。** 只能用 Safari。

1. 在 iPhone 上用 **Safari** 打开你的网址
   （`https://你的用户名.github.io/lifeassistant/`）
2. 等页面加载完（第一次会顺便把文件缓存下来，用于离线）
3. 点屏幕**底部中间的「分享」按钮**（一个方框里带向上箭头）
4. 在弹出菜单里**往下滑**，找到 **「添加到主屏幕」**
5. 名字会自动填「日程助手」，可以改成你喜欢的
6. 点右上角 **「添加」**

回到主屏幕，就多了一个图标。点它打开 ——
**没有浏览器的地址栏和工具栏，看起来和普通 App 一样。**

### 怎么确认离线能用

1. 先正常打开一次 App（让 Service Worker 把文件缓存好）
2. 打开**飞行模式**
3. 从主屏幕点开 App

应该还能正常打开和使用。（如果显示"暂时打不开"，说明第一次的缓存还没完成，连上网再打开一次即可。）

---

## 六、⚠️ iPhone 上 PWA 的四个限制

这些是 **iOS 系统的限制**，不是代码问题，提前说清楚免得你期待落空：

| 功能 | iOS PWA 支持情况 |
| --- | --- |
| 添加到主屏幕 | ✅ 可以，但**只能通过 Safari** |
| 离线使用 | ✅ 可以 |
| 拍照 | ✅ 可以，点「拍照或选择食物照片」会直接调起相机 |
| **后台定时通知** | ❌ **做不到**。iOS 不允许网页在后台定时唤醒自己。所以"课前 30 分钟自动响铃提醒"这种功能**在 PWA 上无法实现** |

### 关于课前提醒的现状

现在的"提醒"是**页面内的横幅**：打开 App 时，顶部会显示
「高等数学 A 将在 20 分钟后开始」。**只有 App 开着才看得到。**

这是 iOS 平台的硬限制。如果你确实需要真正的锁定屏幕提醒，
只有两条路：

1. **花钱**：做原生 App 上架（需要 Apple 开发者账号 $99/年）
2. **免费旁路**：用一个支持"定时推送"的服务，比如
   - **ntfy.sh**（免费开源，可以定时发通知到手机）
   - **Bark**（iOS 上的开源推送 App，免费）
   - iPhone 自带的**「提醒事项」+ 快捷指令**

  这些方案需要额外开发，而且体验不如原生。如果你需要，告诉我，我可以做。

---

## 七、怎么改代码

### ⚠️ 先说一个我踩过的坑：不要用 PowerShell 改文本文件

**不要把 `Set-Content` / `Out-File` 用在项目源文件上。** 我在开发过程中用

```powershell
(Get-Content x.js -Raw) -replace "旧", "新" | Set-Content x.js -Encoding utf8
```

改 `service-worker.js` 的版本号，结果文件被彻底搞坏，出现了两个问题：

1. **写入了 UTF-8 BOM**（开头多了 `EF BB BF` 三个字节）
   → 浏览器报 `ServiceWorker script evaluation failed`，**离线功能整个失效**
2. **中文全变成乱码**（`鈥斺€` 这种），而且**注释里的换行丢了**，
   把多行代码挤成一行 → 直接语法错误

原因是 Windows PowerShell 5.1 的 `Set-Content -Encoding utf8`
会按 GBK 误解码原本的 UTF-8 内容，再以 UTF-8 重写。

**正确做法**：用编辑器改（VS Code、记事本都行），或者跑这个脚本：

```powershell
# 自动把 CACHE_VERSION 加一（用 Node，不会破坏文件）
node tools\bump-cache.js
```

### 改了代码必须做的一件事

**改了 HTML / CSS / JS 后，要把 Service Worker 的版本号加一**，
否则浏览器还在用旧缓存，你会以为"改了没生效"。

```powershell
node tools\bump-cache.js        # 自动改
```

或者手动编辑 `pwa/service-worker.js`：

```js
const CACHE_VERSION = 'v2.4.0';   // ← 改成 v2.5.0
```

改完跑一遍检查确认没弄坏：

```powershell
node tools\check_pwa.js
```

这个脚本会检查**编码（有没有 BOM / 乱码）、语法、缓存清单、图标、外部依赖**，
出问题会明确告诉你是哪个文件、哪种问题。

### 改配色

所有颜色都在 `pwa/css/tokens.css` 里，明暗两套相邻定义：

```css
:root {
  --primary: #4A7C6F;   /* 主色（浅色模式） */
  ...
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --primary: #6BA396;  /* 主色（深色模式） */
    ...
  }
}
```

改一个变量，所有用到它的地方都会跟着变。

### 改文案

界面文字直接在 `pwa/index.html` 里搜。动态生成的文字在各 `js/*.js` 文件里。

### 加一个新的餐次

打开 `pwa/js/constants.js`，在 `MEAL_TYPES` 数组里加一项：

```js
{ key: 'midnight_snack', label: '宵夜', icon: '🍜' },
```

然后到 `pwa/js/utils.js` 的 `detectMealType()` 里加上对应的时间段。
**两处都要改**，否则新餐次不会自动被选中（但手动选是能用的）。

---

## 八、用到的调试工具

项目根目录的 `tools/` 下有几个脚本，都是零依赖的：

```powershell
# 启动本地服务器
node tools\serve.js

# 冒烟测试：用无头浏览器真的把页面打开，检查有没有 JS 报错、
# 三个页面能不能跑、加课程/写日记/撤销是否正常
node tools\smoke_test.js http://localhost:8080

# 布局检查：在 iPhone 尺寸下查有没有元素溢出、文字折行、点击区过小
node tools\check_layout.js http://localhost:8080

# 截图：渲染出各页面的实拍图，存到 pwa/screenshots/
node tools\screenshot_pwa.js http://localhost:8080

# 生成 App 图标（改了配色后想重新生成时用）
python tools\make_pwa_icons.py
```

> 后三个脚本会启动无头 Edge，需要在**允许创建命名管道**的环境下运行
> （受限沙箱下 Chromium 会直接 `FATAL` 退出）。

---

## 九、还没做的（下一步可选）

| 功能 | 说明 | 需要什么 |
| --- | --- | --- |
| **AI 食物识别** | 拍照后自动识别食物、估算热量和金额 | 需要你去 <https://platform.deepseek.com> 申请一个 API Key（有免费额度），填到设置页 |
| **设置页** | 填 API Key、设每日热量目标、导出数据 | 我可以做 |
| **照片改存 IndexedDB** | 现在照片还是 base64 存 localStorage，存十来张就会满。改用 IndexedDB 后能存几百张 | 我可以做 |
| **数据导出/导入** | 把记录导成 CSV / JSON 备份 | 存储层已经写好了导出函数，只差界面 |
| **如果要做后端** | 把 API Key 放到服务端，不暴露在前端 | Cloudflare Workers 免费版（每月 10 万次请求，不要信用卡） |

---

## 十、安全说明（重要，请读）

### API Key 现在放在哪里

**还没有做 AI 识别功能**，所以现在没有 Key 的问题。
将来做的时候，Key 会**存在你手机浏览器的本地存储里**。

### 这安全吗

**老实说：不够安全。** 原因：

网页里的 JavaScript 是**用户能看到、也能改**的。
所以只要别人能打开你手机的浏览器（比如手机没锁屏、或者你把手机借给别人），
他就可以通过开发者工具看到那个 Key。

**但也要公平地说**：

- 这个 Key **从来没有离开过你的设备**，也没有经过任何中间服务器
- 它只会在你主动点"AI 识别"时，直接从你的手机发到 DeepSeek
- 这跟"Key 被泄露到公网上"完全是两回事

### 什么时候必须上后端

**如果你只想自己用** → 现在这样就行，风险可控。

**如果你想把这个 App 分享给别人用** → **必须上后端**。
否则你就是在把自己的 API Key 发给每一个使用的人，他们会用你的额度。

那时候用 **Cloudflare Workers 免费版**：

- 每月 10 万次请求免费
- **不需要信用卡**
- Key 存在 Cloudflare 的环境变量里，前端完全看不到

代码大概长这样（约 40 行）：

```js
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    const body = await request.text();
    const upstream = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Key 从环境变量读，不在代码里
        'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
```

需要的时候告诉我，我帮你配好。

---

## 十一、遇到问题怎么办

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 双击 index.html 一片空白 | ES 模块不允许 `file://` | 用 `node tools\serve.js` 起服务器访问 |
| 改了代码没生效 | Service Worker 用了旧缓存 | 改 `service-worker.js` 里的 `CACHE_VERSION` |
| 手机上打不开电脑的地址 | 不在同一 WiFi，或防火墙拦了 | 检查 WiFi；Windows 防火墙允许 8080 |
| Safari 里找不到「添加到主屏幕」 | 用的是 Chrome 或微信内置浏览器 | **换 Safari** |
| 装到主屏幕后图标是空白方块 | apple-touch-icon 没上传 | 确认 `icons/apple-touch-icon.png` 在仓库里 |
| 提示"存储空间不足" | 照片太多，localStorage 满了 | 删掉一些带照片的记录；或等我改用 IndexedDB |
| 离线打不开 | 第一次缓存还没完成 | 连网打开一次，等几秒再试 |
