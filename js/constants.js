/* ==========================================================================
   常量表
   --------------------------------------------------------------------------
   原型把这些写成全局 var，拆成模块后必须显式导出 ——
   否则 diet.js 里调 MEAL_TYPES 会直接报 "MEAL_TYPES is not defined"。
   ========================================================================== */

/** localStorage 的键名。沿用原型，这样老数据能直接被读到，不会丢。 */
export const STORAGE_KEYS = {
  courses: 'schedule_app_courses',
  diet: 'schedule_app_diet',
  journal: 'schedule_app_journal',
  settings: 'schedule_app_settings',
};

/** 主题选择的存储键（design/js/theme.js 用的同一个键，保持互通） */
export const THEME_KEY = 'design-theme';

/**
 * 餐次。
 * 原型只有 4 个（早/午/晚/加餐），这份完整版有 5 个（多了下午茶、夜宵），
 * 并且用 detectMealType() 按当前时间自动选择。
 */
export const MEAL_TYPES = [
  { key: 'breakfast',     label: '早餐',    icon: '🌅' },
  { key: 'lunch',         label: '午餐',    icon: '☀️' },
  { key: 'afternoon_tea', label: '下午茶',  icon: '🍵' },
  { key: 'dinner',        label: '晚餐',    icon: '🌙' },
  { key: 'late_night',    label: '夜宵',    icon: '🌃' },
];

/** 餐次 key → 中文名，用于详情弹窗 */
export const MEAL_LABEL_MAP = MEAL_TYPES.reduce((map, m) => {
  map[m.key] = m.label;
  return map;
}, {});

/** 星期名，索引与 Date.getDay() 对齐（0 = 周日） */
export const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export const WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六'];

/** 心情选项（与 iOS 版和设计稿一致） */
export const MOODS = ['😊', '😌', '🤔', '😤', '😢', '🎉'];

/**
 * 内置食物库 —— 作为 AI 识别失败时的兜底，以及手动添加时的建议。
 *
 * ⚠️ 原型里的 FOOD_DB 是**假装识别**用的：setTimeout 1.8 秒后
 * 从这里 Math.random() 抽一条填进去，跟照片毫无关系。
 * 现在它承担真实职责：只在 AI 不可用时用于估算，并且界面会标注来源。
 */
export const FOOD_DB = [
  { name: '红烧牛肉面',   calories: 580, cost: 22 },
  { name: '番茄鸡蛋盖饭', calories: 450, cost: 16 },
  { name: '宫保鸡丁饭',   calories: 520, cost: 20 },
  { name: '清炒时蔬',     calories: 180, cost: 12 },
  { name: '水煮鱼片',     calories: 520, cost: 38 },
  { name: '麻婆豆腐饭',   calories: 480, cost: 15 },
  { name: '酸菜鱼米饭',   calories: 560, cost: 28 },
  { name: '蛋炒饭',       calories: 400, cost: 10 },
  { name: '兰州拉面',     calories: 460, cost: 18 },
  { name: '黄焖鸡米饭',   calories: 550, cost: 22 },
  { name: '煎饼果子',     calories: 350, cost: 8 },
  { name: '肉夹馍',       calories: 380, cost: 10 },
  { name: '小笼包',       calories: 320, cost: 14 },
  { name: '豆浆油条',     calories: 480, cost: 8 },
  { name: '牛奶三明治',   calories: 360, cost: 15 },
  { name: '鸡排饭',       calories: 620, cost: 18 },
  { name: '卤肉饭',       calories: 560, cost: 16 },
  { name: '酸辣粉',       calories: 380, cost: 12 },
  { name: '螺蛳粉',       calories: 420, cost: 15 },
  { name: '烤肉拌饭',     calories: 600, cost: 20 },
  { name: '冒菜',         calories: 350, cost: 22 },
  { name: '皮蛋瘦肉粥',   calories: 280, cost: 10 },
  { name: '奶茶',         calories: 350, cost: 16 },
  { name: '水果沙拉',     calories: 220, cost: 18 },
  { name: '煎饺',         calories: 400, cost: 12 },
  { name: '叉烧饭',       calories: 540, cost: 20 },
  { name: '咖喱鸡排饭',   calories: 580, cost: 22 },
  { name: '糖醋里脊饭',   calories: 560, cost: 20 },
  { name: '红烧排骨饭',   calories: 620, cost: 25 },
  { name: '鱼香肉丝饭',   calories: 500, cost: 16 },
];

/**
 * 设置项的默认值。
 * 注意 apiKey 默认空字符串 —— 绝不在代码里写死任何 Key。
 */
export const DEFAULT_SETTINGS = {
  apiKey: '',
  aiConsent: false,        // 是否同意把照片发给 AI（默认 false）
  dailyCalorieGoal: 2000,  // 0 = 不设目标
  reminderMinutes: 30,     // 课前多少分钟在页面内提示
  theme: 'auto',           // 'auto' | 'light' | 'dark'
};
