/**
 * 状态栏 - 在终端固定位置显示用户状态
 */

const { getLevelExpTable, getLevelExpProgress } = require('./gameConfig');

// ============ 状态数据 ============
const statusData = {
    platform: 'qq',
    name: '',
    level: 0,
    gold: 0,
    exp: 0,
    farmLines: [],
};

// ============ 状态栏高度 ============
const BASE_STATUS_LINES = 2;  // 基础状态栏占用行数

// ============ ANSI 转义码 ============
const ESC = '\x1b';
const SAVE_CURSOR = `${ESC}7`;
const RESTORE_CURSOR = `${ESC}8`;
const MOVE_TO = (row, col) => `${ESC}[${row};${col}H`;
const CLEAR_LINE = `${ESC}[2K`;
const SCROLL_REGION = (top, bottom) => `${ESC}[${top};${bottom}r`;
const RESET_SCROLL = `${ESC}[r`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[2m`;
const CYAN = `${ESC}[36m`;
const YELLOW = `${ESC}[33m`;
const GREEN = `${ESC}[32m`;
const MAGENTA = `${ESC}[35m`;

// ============ 状态栏是否启用 ============
let statusEnabled = false;
let termRows = 24;
let lastRenderedLines = BASE_STATUS_LINES;

/**
 * 初始化状态栏
 */
function initStatusBar() {
    // 检测终端是否支持
    if (!process.stdout.isTTY) {
        return false;
    }

    termRows = process.stdout.rows || 24;
    statusEnabled = true;

    // 设置滚动区域，留出顶部状态栏空间
    updateScrollRegion(getTotalStatusLines());

    // 监听终端大小变化
    process.stdout.on('resize', () => {
        termRows = process.stdout.rows || 24;
        updateScrollRegion(getTotalStatusLines());
        renderStatusBar();
    });

    // 初始渲染
    renderStatusBar();
    return true;
}

/**
 * 清理状态栏（退出时调用）
 */
function cleanupStatusBar() {
    if (!statusEnabled) return;
    statusEnabled = false;
    // 重置滚动区域
    process.stdout.write(RESET_SCROLL);
    // 清除状态栏
    for (let i = 1; i <= lastRenderedLines; i++) {
        process.stdout.write(MOVE_TO(i, 1) + CLEAR_LINE);
    }
}

function getTotalStatusLines() {
    const extraLines = statusData.farmLines ? statusData.farmLines.length : 0;
    return BASE_STATUS_LINES + extraLines;
}

function updateScrollRegion(totalLines) {
    const lines = Math.max(BASE_STATUS_LINES, totalLines);
    lastRenderedLines = lines;
    process.stdout.write(SCROLL_REGION(lines + 1, termRows));
    process.stdout.write(MOVE_TO(lines + 1, 1));
}

/**
 * 渲染状态栏
 */
function renderStatusBar() {
    if (!statusEnabled) return;

    const { platform, name, level, gold, exp, farmLines } = statusData;

    // 构建状态行
    const platformStr = platform === 'wx' ? `${MAGENTA}微信${RESET}` : `${CYAN}QQ${RESET}`;
    const nameStr = name ? `${BOLD}${name}${RESET}` : '未登录';
    const levelStr = `${GREEN}Lv${level}${RESET}`;
    const goldStr = `${YELLOW}金币:${gold}${RESET}`;
    
    // 显示经验值
    let expStr = '';
    if (level > 0 && exp >= 0) {
        const levelExpTable = getLevelExpTable();
        if (levelExpTable) {
            // 有配置表时显示当前等级进度
            const progress = getLevelExpProgress(level, exp);
            expStr = `${DIM}经验:${progress.current}/${progress.needed}${RESET}`;
        } else {
            // 没有配置表时只显示累计经验
            expStr = `${DIM}经验:${exp}${RESET}`;
        }
    }

    // 第一行：平台 | 昵称 | 等级 | 金币 | 经验
    const line1 = `${platformStr} | ${nameStr} | ${levelStr} | ${goldStr}${expStr ? ' | ' + expStr : ''}`;

    // 第二行：分隔线
    const width = process.stdout.columns || 80;
    const line2 = `${DIM}${'─'.repeat(Math.min(width, 80))}${RESET}`;

    const totalLines = getTotalStatusLines();
    const prevLines = lastRenderedLines;
    if (totalLines !== prevLines) {
        updateScrollRegion(totalLines);
    }

    const linesToClear = Math.max(totalLines, prevLines);

    // 保存光标位置
    process.stdout.write(SAVE_CURSOR);
    // 清除所有状态栏行
    for (let i = 1; i <= linesToClear; i++) {
        process.stdout.write(MOVE_TO(i, 1) + CLEAR_LINE);
    }
    // 第一行
    process.stdout.write(MOVE_TO(1, 1) + line1);
    // 第二行
    process.stdout.write(MOVE_TO(2, 1) + line2);
    // 农场状态行
    if (farmLines && farmLines.length > 0) {
        for (let i = 0; i < farmLines.length; i++) {
            const line = farmLines[i];
            process.stdout.write(MOVE_TO(3 + i, 1) + line);
        }
    }
    // 恢复光标位置
    process.stdout.write(RESTORE_CURSOR);
}

/**
 * 更新状态数据并刷新显示
 */
function updateStatus(data) {
    let changed = false;
    for (const key of Object.keys(data)) {
        if (statusData[key] !== data[key]) {
            statusData[key] = data[key];
            changed = true;
        }
    }
    if (changed && statusEnabled) {
        renderStatusBar();
    }
}

/**
 * 设置平台
 */
function setStatusPlatform(platform) {
    updateStatus({ platform });
}

/**
 * 从登录数据更新状态
 */
function updateStatusFromLogin(basic) {
    updateStatus({
        name: basic.name || statusData.name,
        level: basic.level || statusData.level,
        gold: basic.gold || statusData.gold,
        exp: basic.exp || statusData.exp,
    });
}

/**
 * 更新金币
 */
function updateStatusGold(gold) {
    updateStatus({ gold });
}

/**
 * 更新等级和经验
 */
function updateStatusLevel(level, exp) {
    const data = { level };
    if (exp !== undefined) data.exp = exp;
    updateStatus(data);
}

module.exports = {
    initStatusBar,
    cleanupStatusBar,
    updateStatus,
    setStatusPlatform,
    updateStatusFromLogin,
    updateStatusGold,
    updateStatusLevel,
    statusData,
};
