/**
 * 自己的农场操作 - 收获/浇水/除草/除虫/铲除/种植/商店/巡田
 */

const protobuf = require('protobufjs');
const { CONFIG, PlantPhase, PHASE_NAMES } = require('./config');
const { types } = require('./proto');
const { sendMsgAsync, getUserState, networkEvents } = require('./network');
const { toLong, toNum, getServerTimeSec, toTimeSec, log, logWarn, sleep } = require('./utils');
const { getPlantNameBySeedId, getPlantName, getPlantExp, formatGrowTime, getPlantGrowTime, getBestSeedsForLevel } = require('./gameConfig');
const { updateStatus } = require('./status');
const { getBag, getBagItems } = require('./warehouse');

// ============ 内部状态 ============
let isCheckingFarm = false;
let isFirstFarmCheck = true;
let farmCheckTimer = null;
let farmLoopRunning = false;
let lastFarmSnapshot = null;
let forceFarmCheck = false;
let lastUnlockedCount = 0;
let bestSeedCache = {
    level: 0,
    lands: 0,
    bestNoFert: null,
    bestNormalFert: null,
    line: '',
};

// ============ 农场 API ============

// 操作限制更新回调 (由 friend.js 设置)
let onOperationLimitsUpdate = null;
function setOperationLimitsCallback(callback) {
    onOperationLimitsUpdate = callback;
}

function formatExpPerHour(value) {
    if (!Number.isFinite(value)) return '?';
    const fixed = value.toFixed(2);
    return fixed.endsWith('.00') ? fixed.slice(0, -3) : fixed;
}

function buildBestSeedLine(bestNoFert, bestNormalFert) {
    if (!bestNoFert || !bestNormalFert) return '';
    const noStr = `${bestNoFert.name} ${formatExpPerHour(bestNoFert.expPerHour)}/h`;
    const fertStr = `${bestNormalFert.name} ${formatExpPerHour(bestNormalFert.expPerHour)}/h`;
    return `最优: 无肥 ${noStr} | 有肥 ${fertStr}`;
}

function ensureBestSeedCache(level, unlockedCount) {
    const lv = Number(level) || 0;
    const lands = Number(unlockedCount) || 0;
    if (!lv || !lands) return null;
    if (bestSeedCache.level === lv && bestSeedCache.lands === lands
        && bestSeedCache.bestNoFert && bestSeedCache.bestNormalFert) {
        return bestSeedCache;
    }

    const best = getBestSeedsForLevel(lv, lands);
    if (!best) return null;

    bestSeedCache = {
        level: lv,
        lands,
        bestNoFert: best.bestNoFert,
        bestNormalFert: best.bestNormalFert,
        line: buildBestSeedLine(best.bestNoFert, best.bestNormalFert),
    };
    return bestSeedCache;
}

async function getFertilizerCount() {
    try {
        const bagReply = await getBag();
        const items = getBagItems(bagReply);
        for (const item of items) {
            if (toNum(item.id) === NORMAL_FERTILIZER_ID) {
                return toNum(item.count);
            }
        }
    } catch (e) {
        logWarn('背包', `读取肥料数量失败: ${e.message}`);
    }
    return null;
}

async function getAllLands() {
    const body = types.AllLandsRequest.encode(types.AllLandsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'AllLands', body);
    const reply = types.AllLandsReply.decode(replyBody);
    // 更新操作限制
    if (reply.operation_limits && onOperationLimitsUpdate) {
        onOperationLimitsUpdate(reply.operation_limits);
    }
    return reply;
}

async function harvest(landIds) {
    const state = getUserState();
    const body = types.HarvestRequest.encode(types.HarvestRequest.create({
        land_ids: landIds,
        host_gid: toLong(state.gid),
        is_all: true,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', body);
    return types.HarvestReply.decode(replyBody);
}

async function waterLand(landIds) {
    const state = getUserState();
    const body = types.WaterLandRequest.encode(types.WaterLandRequest.create({
        land_ids: landIds,
        host_gid: toLong(state.gid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'WaterLand', body);
    return types.WaterLandReply.decode(replyBody);
}

async function weedOut(landIds) {
    const state = getUserState();
    const body = types.WeedOutRequest.encode(types.WeedOutRequest.create({
        land_ids: landIds,
        host_gid: toLong(state.gid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'WeedOut', body);
    return types.WeedOutReply.decode(replyBody);
}

async function insecticide(landIds) {
    const state = getUserState();
    const body = types.InsecticideRequest.encode(types.InsecticideRequest.create({
        land_ids: landIds,
        host_gid: toLong(state.gid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Insecticide', body);
    return types.InsecticideReply.decode(replyBody);
}

// 普通肥料 ID
const NORMAL_FERTILIZER_ID = 1011;

/**
 * 施肥 - 必须逐块进行，服务器不支持批量
 * 游戏中拖动施肥间隔很短，这里用 50ms
 */
async function fertilize(landIds, fertilizerId = NORMAL_FERTILIZER_ID) {
    let successCount = 0;
    for (const landId of landIds) {
        try {
            const body = types.FertilizeRequest.encode(types.FertilizeRequest.create({
                land_ids: [toLong(landId)],
                fertilizer_id: toLong(fertilizerId),
            })).finish();
            await sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', body);
            successCount++;
        } catch (e) {
            // 施肥失败（可能肥料不足），停止继续
            break;
        }
        if (landIds.length > 1) await sleep(50);  // 50ms 间隔
    }
    return successCount;
}

async function removePlant(landIds) {
    const body = types.RemovePlantRequest.encode(types.RemovePlantRequest.create({
        land_ids: landIds.map(id => toLong(id)),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'RemovePlant', body);
    return types.RemovePlantReply.decode(replyBody);
}

// ============ 商店 API ============

async function getShopInfo(shopId) {
    const body = types.ShopInfoRequest.encode(types.ShopInfoRequest.create({
        shop_id: toLong(shopId),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.shoppb.ShopService', 'ShopInfo', body);
    return types.ShopInfoReply.decode(replyBody);
}

async function buyGoods(goodsId, num, price) {
    const body = types.BuyGoodsRequest.encode(types.BuyGoodsRequest.create({
        goods_id: toLong(goodsId),
        num: toLong(num),
        price: toLong(price),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.shoppb.ShopService', 'BuyGoods', body);
    return types.BuyGoodsReply.decode(replyBody);
}

// ============ 种植 ============

function encodePlantRequest(seedId, landIds) {
    const writer = protobuf.Writer.create();
    const itemWriter = writer.uint32(18).fork();
    itemWriter.uint32(8).int64(seedId);
    const idsWriter = itemWriter.uint32(18).fork();
    for (const id of landIds) {
        idsWriter.int64(id);
    }
    idsWriter.ldelim();
    itemWriter.ldelim();
    return writer.finish();
}

/**
 * 种植 - 游戏中拖动种植间隔很短，这里用 50ms
 */
async function plantSeeds(seedId, landIds) {
    let successCount = 0;
    for (const landId of landIds) {
        try {
            const body = encodePlantRequest(seedId, [landId]);
            const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Plant', body);
            types.PlantReply.decode(replyBody);
            successCount++;
        } catch (e) {
            logWarn('种植', `土地#${landId} 失败: ${e.message}`);
        }
        if (landIds.length > 1) await sleep(50);  // 50ms 间隔
    }
    return successCount;
}

function selectBestSeedFromAvailable(available, preferNoFert, level, lands) {
    if (!available || available.length === 0) return null;

    const modeLabel = preferNoFert ? '无肥最优' : '有肥最优';
    const seedIdSet = new Set(available.map(item => item.seedId));
    const bestByYield = (level && lands) ? getBestSeedsForLevel(level, lands, seedIdSet) : null;
    if (bestByYield) {
        const target = preferNoFert ? bestByYield.bestNoFert : bestByYield.bestNormalFert;
        if (target && target.seedId) {
            const found = available.find(item => item.seedId === target.seedId);
            if (found) return { ...found, modeLabel };
        }
    }

    // fallback: 默认按最低等级要求
    available.sort((a, b) => a.requiredLevel - b.requiredLevel);
    return { ...available[0], modeLabel: '默认' };
}

async function findBestSeed(options = {}) {
    const SEED_SHOP_ID = 2;
    const shopReply = await getShopInfo(SEED_SHOP_ID);
    if (!shopReply.goods_list || shopReply.goods_list.length === 0) {
        logWarn('商店', '种子商店无商品');
        return null;
    }

    const state = getUserState();
    const available = [];
    for (const goods of shopReply.goods_list) {
        if (!goods.unlocked) continue;

        let meetsConditions = true;
        let requiredLevel = 0;
        const conds = goods.conds || [];
        for (const cond of conds) {
            if (toNum(cond.type) === 1) {
                requiredLevel = toNum(cond.param);
                if (state.level < requiredLevel) {
                    meetsConditions = false;
                    break;
                }
            }
        }
        if (!meetsConditions) continue;

        const limitCount = toNum(goods.limit_count);
        const boughtNum = toNum(goods.bought_num);
        if (limitCount > 0 && boughtNum >= limitCount) continue;

        available.push({
            goods,
            goodsId: toNum(goods.id),
            seedId: toNum(goods.item_id),
            price: toNum(goods.price),
            requiredLevel,
        });
    }

    if (available.length === 0) {
        logWarn('商店', '没有可购买的种子');
        return null;
    }

    const preferNoFert = !!options.preferNoFert;
    const level = options.level || 0;
    const lands = options.lands || 0;
    return selectBestSeedFromAvailable(available, preferNoFert, level, lands);
}

async function autoPlantEmptyLands(deadLandIds, emptyLandIds) {
    let landsToPlant = [...emptyLandIds];
    const state = getUserState();

    // 1. 铲除枯死/收获残留植物（一键操作）
    if (deadLandIds.length > 0) {
        try {
            await removePlant(deadLandIds);
            log('铲除', `已铲除 ${deadLandIds.length} 块 (${deadLandIds.join(',')})`);
            landsToPlant.push(...deadLandIds);
        } catch (e) {
            logWarn('铲除', `批量铲除失败: ${e.message}`);
            // 失败时仍然尝试种植
            landsToPlant.push(...deadLandIds);
        }
    }

    if (landsToPlant.length === 0) return;

    // 2. 选择种子（按最优经验计算）
    let bestSeed;
    try {
        const fertilizerCount = await getFertilizerCount();
        const preferNoFert = fertilizerCount !== null && fertilizerCount < 10;
        if (preferNoFert) {
            log('种植', `普通肥不足(${fertilizerCount})，切换为无肥最优种子`);
        }

        const landsForCalc = lastUnlockedCount || landsToPlant.length;
        ensureBestSeedCache(state.level, landsForCalc);
        bestSeed = await findBestSeed({
            preferNoFert,
            level: state.level,
            lands: landsForCalc,
        });
    } catch (e) {
        logWarn('商店', `查询失败: ${e.message}`);
        return;
    }
    if (!bestSeed) return;

    const seedName = getPlantNameBySeedId(bestSeed.seedId);
    const growTime = getPlantGrowTime(1020000 + (bestSeed.seedId - 20000));  // 转换为植物ID
    const growTimeStr = growTime > 0 ? ` 生长${formatGrowTime(growTime)}` : '';
    const modeLabel = bestSeed.modeLabel ? `${bestSeed.modeLabel} ` : '';
    log('商店', `${modeLabel}最佳种子: ${seedName} (${bestSeed.seedId}) 价格=${bestSeed.price}金币${growTimeStr}`);

    // 3. 购买
    const needCount = landsToPlant.length;
    const totalCost = bestSeed.price * needCount;
    if (totalCost > state.gold) {
        logWarn('商店', `金币不足! 需要 ${totalCost} 金币, 当前 ${state.gold} 金币`);
        const canBuy = Math.floor(state.gold / bestSeed.price);
        if (canBuy <= 0) return;
        landsToPlant = landsToPlant.slice(0, canBuy);
        log('商店', `金币有限，只种 ${canBuy} 块地`);
    }

    let actualSeedId = bestSeed.seedId;
    try {
        const buyReply = await buyGoods(bestSeed.goodsId, landsToPlant.length, bestSeed.price);
        if (buyReply.get_items && buyReply.get_items.length > 0) {
            const gotItem = buyReply.get_items[0];
            const gotId = toNum(gotItem.id);
            const gotCount = toNum(gotItem.count);
            log('购买', `获得物品: id=${gotId} count=${gotCount}`);
            if (gotId > 0) actualSeedId = gotId;
        }
        if (buyReply.cost_items) {
            for (const item of buyReply.cost_items) {
                state.gold -= toNum(item.count);
            }
        }
        const boughtName = getPlantNameBySeedId(actualSeedId);
        log('购买', `已购买 ${boughtName}种子 x${landsToPlant.length}, 花费 ${bestSeed.price * landsToPlant.length} 金币`);
    } catch (e) {
        logWarn('购买', e.message);
        return;
    }

    // 4. 种植（逐块拖动，间隔50ms）
    let plantedLands = [];
    try {
        const planted = await plantSeeds(actualSeedId, landsToPlant);
        log('种植', `已在 ${planted} 块地种植 (${landsToPlant.join(',')})`);
        if (planted > 0) {
            plantedLands = landsToPlant.slice(0, planted);
        }
    } catch (e) {
        logWarn('种植', e.message);
    }

    // 5. 施肥（逐块拖动，间隔50ms）
    if (plantedLands.length > 0) {
        const fertilized = await fertilize(plantedLands);
        if (fertilized > 0) {
            log('施肥', `已为 ${fertilized}/${plantedLands.length} 块地施肥`);
        }
    }
}

// ============ 土地分析 ============

/**
 * 根据服务器时间确定当前实际生长阶段
 */
function getCurrentPhase(phases, debug, landLabel) {
    if (!phases || phases.length === 0) return null;

    const nowSec = getServerTimeSec();

    if (debug) {
        console.log(`    ${landLabel} 服务器时间=${nowSec} (${new Date(nowSec * 1000).toLocaleTimeString()})`);
        for (let i = 0; i < phases.length; i++) {
            const p = phases[i];
            const bt = toTimeSec(p.begin_time);
            const phaseName = PHASE_NAMES[p.phase] || `阶段${p.phase}`;
            const diff = bt > 0 ? (bt - nowSec) : 0;
            const diffStr = diff > 0 ? `(未来 ${diff}s)` : diff < 0 ? `(已过 ${-diff}s)` : '';
            console.log(`    ${landLabel}   [${i}] ${phaseName}(${p.phase}) begin=${bt} ${diffStr} dry=${toTimeSec(p.dry_time)} weed=${toTimeSec(p.weeds_time)} insect=${toTimeSec(p.insect_time)}`);
        }
    }

    for (let i = phases.length - 1; i >= 0; i--) {
        const beginTime = toTimeSec(phases[i].begin_time);
        if (beginTime > 0 && beginTime <= nowSec) {
            if (debug) {
                console.log(`    ${landLabel}   → 当前阶段: ${PHASE_NAMES[phases[i].phase] || phases[i].phase}`);
            }
            return phases[i];
        }
    }

    if (debug) {
        console.log(`    ${landLabel}   → 所有阶段都在未来，使用第一个: ${PHASE_NAMES[phases[0].phase] || phases[0].phase}`);
    }
    return phases[0];
}

function analyzeLands(lands) {
    const result = {
        harvestable: [], needWater: [], needWeed: [], needBug: [],
        growing: [], empty: [], dead: [],
        harvestableInfo: [],  // 收获植物的详细信息 { id, name, exp }
        farmLines: [],  // 状态栏显示用的行
        landSnapshots: [],
        minRemainingSec: null,
        serverTimeSec: 0,
        unlockedCount: 0,
    };

    const nowSec = getServerTimeSec();
    result.serverTimeSec = nowSec;
    const debug = false;
    const landSummaries = [];

    if (debug) {
        console.log('');
        console.log('========== 首次巡田详细日志 ==========');
        console.log(`  服务器时间(秒): ${nowSec}  (${new Date(nowSec * 1000).toLocaleString()})`);
        console.log(`  总土地数: ${lands.length}`);
        console.log('');
    }

    for (const land of lands) {
        const id = toNum(land.id);
        const landPrefix = formatLandPrefix(id);
        if (!land.unlocked) {
            if (debug) console.log(`  土地#${id}: 未解锁`);
            landSummaries.push(`${landPrefix}锁`);
            result.landSnapshots.push({ id, type: 'lock' });
            continue;
        }
        result.unlockedCount++;

        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0) {
            result.empty.push(id);
            if (debug) console.log(`  土地#${id}: 空地`);
            landSummaries.push(`${landPrefix}空`);
            result.landSnapshots.push({ id, type: 'empty' });
            continue;
        }

        const plantId = toNum(plant.id);
        let plantName = getPlantName(plantId);
        if (plantName === `植物${plantId}` && plant.name) {
            plantName = plant.name;
        }
        if (plantName.length > 4) plantName = plantName.slice(0, 4);
        const landLabel = `土地#${id}(${plantName})`;

        if (debug) {
            console.log(`  ${landLabel}: phases=${plant.phases.length} dry_num=${toNum(plant.dry_num)} weed_owners=${(plant.weed_owners||[]).length} insect_owners=${(plant.insect_owners||[]).length}`);
        }

        const currentPhase = getCurrentPhase(plant.phases, debug, landLabel);
        if (!currentPhase) {
            result.empty.push(id);
            landSummaries.push(`${landPrefix}空`);
            continue;
        }
        const phaseVal = currentPhase.phase;
        const totalGrowTime = getPlantGrowTime(plantId);
        const totalGrowStr = totalGrowTime > 0 ? formatGrowTime(totalGrowTime) : '未知';

        if (phaseVal === PlantPhase.DEAD) {
            result.dead.push(id);
            if (debug) console.log(`    → 结果: 枯死`);
            landSummaries.push(`${landPrefix}${plantName} 枯`);
            result.landSnapshots.push({ id, type: 'dead', name: plantName });
            continue;
        }

        if (phaseVal === PlantPhase.MATURE) {
            result.harvestable.push(id);
            // 收集植物信息用于日志
            const plantNameFromConfig = getPlantName(plantId);
            const plantExp = getPlantExp(plantId);
            result.harvestableInfo.push({
                landId: id,
                plantId,
                name: plantNameFromConfig || plantName,
                exp: plantExp,
            });
            if (debug) console.log(`    → 结果: 可收获 (${plantNameFromConfig} +${plantExp}经验)`);
            landSummaries.push(`${landPrefix}${plantName} ${formatGrowTime(0)}/${totalGrowStr}`);
            result.landSnapshots.push({ id, type: 'mature', name: plantName, totalGrowTime });
            continue;
        }

        let landNeeds = [];
        const dryNum = toNum(plant.dry_num);
        const dryTime = toTimeSec(currentPhase.dry_time);
        if (dryNum > 0 || (dryTime > 0 && dryTime <= nowSec)) {
            result.needWater.push(id);
            landNeeds.push('缺水');
        }

        const weedsTime = toTimeSec(currentPhase.weeds_time);
        const hasWeeds = (plant.weed_owners && plant.weed_owners.length > 0) || (weedsTime > 0 && weedsTime <= nowSec);
        if (hasWeeds) {
            result.needWeed.push(id);
            landNeeds.push('有草');
        }

        const insectTime = toTimeSec(currentPhase.insect_time);
        const hasBugs = (plant.insect_owners && plant.insect_owners.length > 0) || (insectTime > 0 && insectTime <= nowSec);
        if (hasBugs) {
            result.needBug.push(id);
            landNeeds.push('有虫');
        }

        result.growing.push(id);
        if (debug) {
            const needStr = landNeeds.length > 0 ? ` 需要: ${landNeeds.join(',')}` : '';
            console.log(`    → 结果: 生长中(${PHASE_NAMES[phaseVal] || phaseVal})${needStr}`);
        }
        const remainInfo = getRemainingToMatureInfo(plant.phases, nowSec, totalGrowTime);
        const remainingSec = remainInfo.remainingSec;
        if (remainInfo.known) {
            if (result.minRemainingSec === null || remainingSec < result.minRemainingSec) {
                result.minRemainingSec = remainingSec;
            }
        }
        const remainStr = formatGrowTime(remainingSec);
        landSummaries.push(`${landPrefix}${plantName} ${remainStr}/${totalGrowStr}`);
        result.landSnapshots.push({
            id,
            type: 'growing',
            name: plantName,
            totalGrowTime,
            remainingSec,
            remainingKnown: remainInfo.known,
        });
    }

    if (debug) {
        console.log('');
        console.log('========== 巡田分析汇总 ==========');
        console.log(`  可收获: ${result.harvestable.length} [${result.harvestable.join(',')}]`);
        console.log(`  生长中: ${result.growing.length} [${result.growing.join(',')}]`);
        console.log(`  缺水:   ${result.needWater.length} [${result.needWater.join(',')}]`);
        console.log(`  有草:   ${result.needWeed.length} [${result.needWeed.join(',')}]`);
        console.log(`  有虫:   ${result.needBug.length} [${result.needBug.join(',')}]`);
        console.log(`  空地:   ${result.empty.length} [${result.empty.join(',')}]`);
        console.log(`  枯死:   ${result.dead.length} [${result.dead.join(',')}]`);
        console.log('====================================');
        console.log('');
    }

    result.farmLines = buildFarmStatusLines(landSummaries);
    return result;
}

function getRemainingToMatureInfo(phases, nowSec, totalGrowTime) {
    if (!phases || phases.length === 0) return { remainingSec: 0, known: false };
    let matureBegin = 0;
    let earliestBegin = 0;
    for (const p of phases) {
        const begin = toTimeSec(p.begin_time);
        if (begin > 0 && (earliestBegin === 0 || begin < earliestBegin)) {
            earliestBegin = begin;
        }
        if (p.phase === PlantPhase.MATURE && begin > 0 && (matureBegin === 0 || begin < matureBegin)) {
            matureBegin = begin;
        }
    }
    if (matureBegin > 0) {
        return { remainingSec: Math.max(0, matureBegin - nowSec), known: true };
    }
    if (totalGrowTime > 0 && earliestBegin > 0) {
        const elapsed = Math.max(0, nowSec - earliestBegin);
        return { remainingSec: Math.max(0, totalGrowTime - elapsed), known: true };
    }
    return { remainingSec: 0, known: false };
}

function getRemainingToMatureSec(phases, nowSec, totalGrowTime) {
    return getRemainingToMatureInfo(phases, nowSec, totalGrowTime).remainingSec;
}

function buildFarmStatusLines(landSummaries) {
    const lines = [];
    const perLine = 4;
    for (let i = 0; i < landSummaries.length; i += perLine) {
        lines.push(landSummaries.slice(i, i + perLine).join(' | '));
    }
    return lines;
}

function formatLandPrefix(id) {
    return id < 10 ? `#${id}  ` : `#${id} `;
}

function buildFarmSnapshot(status) {
    return {
        emptyCount: status.empty.length,
        deadCount: status.dead.length,
        harvestableCount: status.harvestable.length,
        needWaterCount: status.needWater.length,
        needWeedCount: status.needWeed.length,
        needBugCount: status.needBug.length,
        minRemainingSec: status.minRemainingSec,
        serverTimeSec: status.serverTimeSec,
        landSnapshots: status.landSnapshots || [],
        unlockedCount: status.unlockedCount || 0,
        updatedAt: Date.now(),
    };
}

function buildFarmLinesFromSnapshot(snapshot) {
    if (!snapshot || !snapshot.landSnapshots || snapshot.landSnapshots.length === 0) return null;
    const nowSec = getServerTimeSec();
    const baseTime = typeof snapshot.serverTimeSec === 'number' ? snapshot.serverTimeSec : nowSec;
    const elapsed = Math.max(0, nowSec - baseTime);
    const landSummaries = [];

    for (const item of snapshot.landSnapshots) {
        const id = item.id;
        const landPrefix = formatLandPrefix(id);
        if (item.type === 'lock') {
            landSummaries.push(`${landPrefix}锁`);
            continue;
        }
        if (item.type === 'empty') {
            landSummaries.push(`${landPrefix}空`);
            continue;
        }
        if (item.type === 'dead') {
            landSummaries.push(`${landPrefix}${item.name} 枯`);
            continue;
        }

        const totalGrowTime = item.totalGrowTime || 0;
        const totalGrowStr = totalGrowTime > 0 ? formatGrowTime(totalGrowTime) : '未知';

        if (item.type === 'mature') {
            landSummaries.push(`${landPrefix}${item.name} ${formatGrowTime(0)}/${totalGrowStr}`);
            continue;
        }
        if (item.type === 'growing') {
            let remainingSec = item.remainingSec || 0;
            if (item.remainingKnown) {
                remainingSec = Math.max(0, remainingSec - elapsed);
            }
            const remainStr = formatGrowTime(remainingSec);
            landSummaries.push(`${landPrefix}${item.name} ${remainStr}/${totalGrowStr}`);
        }
    }

    return buildFarmStatusLines(landSummaries);
}

function shouldCheckFarmNow() {
    if (isFirstFarmCheck) return true;
    if (forceFarmCheck) return true;
    if (!lastFarmSnapshot) return true;
    if (lastFarmSnapshot.emptyCount > 0) return true;
    if (lastFarmSnapshot.deadCount > 0) return true;
    if (lastFarmSnapshot.harvestableCount > 0) return true;
    if (lastFarmSnapshot.needWaterCount > 0) return true;
    if (lastFarmSnapshot.needWeedCount > 0) return true;
    if (lastFarmSnapshot.needBugCount > 0) return true;
    if (typeof lastFarmSnapshot.minRemainingSec === 'number' && typeof lastFarmSnapshot.serverTimeSec === 'number') {
        const nowSec = getServerTimeSec();
        const elapsed = Math.max(0, nowSec - lastFarmSnapshot.serverTimeSec);
        const remaining = lastFarmSnapshot.minRemainingSec - elapsed;
        if (remaining <= 2) return true;
    }
    return false;
}

// ============ 巡田主循环 ============

async function checkFarm() {
    const state = getUserState();
    if (isCheckingFarm || !state.gid) return;
    isCheckingFarm = true;

    try {
        if (!shouldCheckFarmNow()) {
            const refreshedLines = buildFarmLinesFromSnapshot(lastFarmSnapshot);
            if (refreshedLines) {
                const statusUpdate = { farmLines: refreshedLines };
                if (bestSeedCache.line) statusUpdate.bestSeedLine = bestSeedCache.line;
                updateStatus(statusUpdate);
            }
            return;
        }

        const landsReply = await getAllLands();
        if (!landsReply.lands || landsReply.lands.length === 0) {
            log('农场', '没有土地数据');
            return;
        }

        const lands = landsReply.lands;
        const status = analyzeLands(lands);
        lastFarmSnapshot = buildFarmSnapshot(status);
        lastUnlockedCount = status.unlockedCount || lastUnlockedCount;
        const bestCache = ensureBestSeedCache(state.level, lastUnlockedCount);
        const statusUpdate = { farmLines: status.farmLines };
        if (bestCache && bestCache.line) statusUpdate.bestSeedLine = bestCache.line;
        updateStatus(statusUpdate);
        isFirstFarmCheck = false;
        forceFarmCheck = false;

        // 构建状态摘要
        const statusParts = [];
        if (status.harvestable.length) statusParts.push(`收:${status.harvestable.length}`);
        if (status.needWeed.length) statusParts.push(`草:${status.needWeed.length}`);
        if (status.needBug.length) statusParts.push(`虫:${status.needBug.length}`);
        if (status.needWater.length) statusParts.push(`水:${status.needWater.length}`);
        if (status.dead.length) statusParts.push(`枯:${status.dead.length}`);
        if (status.empty.length) statusParts.push(`空:${status.empty.length}`);
        statusParts.push(`长:${status.growing.length}`);

        const hasWork = status.harvestable.length || status.needWeed.length || status.needBug.length
            || status.needWater.length || status.dead.length || status.empty.length;

        // 执行操作并收集结果
        const actions = [];

        // 一键操作：除草、除虫、浇水可以并行执行（游戏中都是一键完成）
        const batchOps = [];
        if (status.needWeed.length > 0) {
            batchOps.push(weedOut(status.needWeed).then(() => actions.push(`除草${status.needWeed.length}`)).catch(e => logWarn('除草', e.message)));
        }
        if (status.needBug.length > 0) {
            batchOps.push(insecticide(status.needBug).then(() => actions.push(`除虫${status.needBug.length}`)).catch(e => logWarn('除虫', e.message)));
        }
        if (status.needWater.length > 0) {
            batchOps.push(waterLand(status.needWater).then(() => actions.push(`浇水${status.needWater.length}`)).catch(e => logWarn('浇水', e.message)));
        }
        if (batchOps.length > 0) {
            await Promise.all(batchOps);
        }

        // 收获（一键操作）
        let harvestedLandIds = [];
        if (status.harvestable.length > 0) {
            try {
                await harvest(status.harvestable);
                actions.push(`收获${status.harvestable.length}`);
                harvestedLandIds = [...status.harvestable];
            } catch (e) { logWarn('收获', e.message); }
        }

        // 铲除 + 种植 + 施肥（需要顺序执行）
        const allDeadLands = [...status.dead, ...harvestedLandIds];
        const allEmptyLands = [...status.empty];
        if (allDeadLands.length > 0 || allEmptyLands.length > 0) {
            try {
                await autoPlantEmptyLands(allDeadLands, allEmptyLands);
                actions.push(`种植${allDeadLands.length + allEmptyLands.length}`);
            } catch (e) { logWarn('种植', e.message); }
        }

        // 输出一行日志
        const actionStr = actions.length > 0 ? ` → ${actions.join('/')}` : '';
        if(hasWork) {
            log('农场', `[${statusParts.join(' ')}]${actionStr}${!hasWork ? ' 无需操作' : ''}`)
        }
    } catch (err) {
        logWarn('巡田', `检查失败: ${err.message}`);
    } finally {
        isCheckingFarm = false;
    }
}

/**
 * 农场巡查循环 - 本次完成后等待指定秒数再开始下次
 */
async function farmCheckLoop() {
    while (farmLoopRunning) {
        await checkFarm();
        if (!farmLoopRunning) break;
        await sleep(CONFIG.farmCheckInterval);
    }
}

function startFarmCheckLoop() {
    if (farmLoopRunning) return;
    farmLoopRunning = true;

    // 监听服务器推送的土地变化事件
    networkEvents.on('landsChanged', onLandsChangedPush);
    networkEvents.on('levelChanged', onLevelChanged);

    // 延迟 2 秒后启动循环
    farmCheckTimer = setTimeout(() => farmCheckLoop(), 2000);
}

/**
 * 处理服务器推送的土地变化
 */
let lastPushTime = 0;
function onLandsChangedPush(lands) {
    if (isCheckingFarm) return;
    const now = Date.now();
    if (now - lastPushTime < 500) return;  // 500ms 防抖
    
    lastPushTime = now;
    forceFarmCheck = true;
    log('农场', `收到推送: ${lands.length}块土地变化，触发巡田...`);
    
    setTimeout(async () => {
        if (!isCheckingFarm) {
            await checkFarm();
        }
    }, 100);
}

function onLevelChanged(level) {
    if (!level) return;
    if (!lastUnlockedCount) return;
    const cache = ensureBestSeedCache(level, lastUnlockedCount);
    if (cache && cache.line) {
        updateStatus({ bestSeedLine: cache.line });
    }
}

function stopFarmCheckLoop() {
    farmLoopRunning = false;
    if (farmCheckTimer) { clearTimeout(farmCheckTimer); farmCheckTimer = null; }
    networkEvents.removeListener('landsChanged', onLandsChangedPush);
    networkEvents.removeListener('levelChanged', onLevelChanged);
}

module.exports = {
    checkFarm, startFarmCheckLoop, stopFarmCheckLoop,
    getCurrentPhase,
    setOperationLimitsCallback,
};
