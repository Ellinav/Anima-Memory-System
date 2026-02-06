import { getOrInitNarrativeTime } from "./summary_logic.js";
import { applyRegexRules } from "./utils.js";
import { insertMemory, deleteMemory, deleteBatchMemory } from "./rag_logic.js";

/**
 * 批量保存总结切片 (已修复：支持后台写入指定聊天)
 * @param {Array} summaryList
 * @param {number} batchId
 * @param {number} startId
 * @param {number} endId
 * @param {object} settings
 * @param {string} fixedChatId [新增参数] 强制指定要写入的聊天ID，防止切窗口导致写入错误
 */
export async function saveSummaryBatchToWorldbook(
  summaryList,
  batchId,
  startId,
  endId,
  settings,
  fixedChatId = null, // <--- 新增参数，默认为 null 兼容旧代码
) {
  if (!window.TavernHelper) throw new Error("TavernHelper missing");

  // 🟢 1. 优先使用传入的 ID，如果没有传才用当前的 (UI 交互操作时可能没传)
  const context = SillyTavern.getContext();
  const targetChatId = fixedChatId || context.chatId;

  if (!targetChatId) throw new Error("未检测到有效 Chat ID");

  let wbName;

  // 🟢 2. 健壮性优化：如果是当前前台聊天，直接问 ST 要名字
  if (
    targetChatId === context.chatId &&
    window.TavernHelper.getChatWorldbookName
  ) {
    wbName = window.TavernHelper.getChatWorldbookName("current");
  }

  // 降级策略：如果是后台聊天，或者 API 返回空（未绑定），则通过文件名推导
  if (!wbName) {
    wbName = targetChatId.replace(/\.(json|jsonl)$/i, "");
  }
  // 确保世界书存在 (如果不存在则创建，但不绑定为"current"，只是为了写入)
  // 注意：我们直接操作该名称的世界书，不需要 getChatWorldbookName("current")
  // 这里做个保险：尝试获取一下，如果获取不到（比如完全没创建过），则初始化一下
  try {
    // 尝试只获取名字，不改变当前绑定
    const existing = await window.TavernHelper.getWorldbook(wbName);
    if (!existing) {
      // 如果不存在，可能需要通过 getOrCreateChatWorldbook 初始化
      // 但为了安全，这里我们暂时信任 wbName 就是文件名
      console.log(`[Anima] 目标世界书 ${wbName} 可能未加载，尝试自动创建/读取`);
      await window.TavernHelper.createWorldbook(wbName);
    }
  } catch (e) {
    // 忽略错误，继续尝试写入
  }

  // 根据 batchId 决定放在哪个 Chapter (Group Size)
  const groupSize = settings.group_size || 10;
  const chapterNum = Math.ceil(batchId / groupSize);
  const entryName = `chapter_${chapterNum}`;

  // 2. 准备基础元数据
  const narrativeTime = await getOrInitNarrativeTime();

  // 3. 获取现有条目 (如果不存在则准备创建)
  const existingEntries = await window.TavernHelper.getWorldbook(wbName);
  let targetEntry = existingEntries.find(
    (e) =>
      e.name === entryName && e.extra && e.extra.createdBy === "anima_summary",
  );

  // ============================================================
  // ⚡ 核心逻辑：清理旧数据 (Clean Slate)
  // 修复：智能判断是否需要调用后端删除，防止全新 Batch 生成时卡死
  // ============================================================
  if (targetEntry) {
    // A. 检查本地是否真的存在该 Batch 的旧数据
    let hasOldBatchData = false;
    if (Array.isArray(targetEntry.extra.history)) {
      // 只有当历史记录里能找到对应的 batch_id 时，才说明是“重新生成”
      hasOldBatchData = targetEntry.extra.history.some(
        (h) => h.batch_id === batchId,
      );
    }

    // B. 只有当确实存在旧数据，且有关联向量库时，才请求后端删除
    // 这样全新的总结（如 Batch 4）就会跳过此步骤，不再发生网络请求撞车
    if (hasOldBatchData && targetEntry.extra.source_file) {
      console.log(
        `[Anima] 检测到 Batch ${batchId} 的旧数据，正在请求后端清理向量...`,
      );

      // 🔥 核心修改：一次请求，原子删除
      await deleteBatchMemory(targetEntry.extra.source_file, batchId);
    } else {
      // 调试日志：确认跳过了清理
      console.log(
        `[Anima] Batch ${batchId} 为全新内容或无关联库，跳过向量清理步骤。`,
      );
    }

    // C. 清理 Worldbook 文本内容 (本地操作，保持不变)
    // 这里的逻辑很安全：如果是新 Batch，oldSlices 为空，循环不会执行，不会误删内容
    if (Array.isArray(targetEntry.extra.history)) {
      const oldSlices = targetEntry.extra.history.filter(
        (h) => h.batch_id === batchId,
      );

      if (oldSlices.length > 0) {
        let cleanContent = targetEntry.content;
        for (const slice of oldSlices) {
          // 确保有 unique_id (兼容旧数据用 index)
          const uid =
            slice.unique_id !== undefined ? slice.unique_id : slice.index;
          const regex = new RegExp(`<${uid}>[\\s\\S]*?<\\/${uid}>`, "g");
          cleanContent = cleanContent.replace(regex, "");
        }
        targetEntry.content = cleanContent.trim();

        // D. 清理 History 数组
        targetEntry.extra.history = targetEntry.extra.history.filter(
          (h) => h.batch_id !== batchId,
        );
      }
    }
  }

  // ============================================================
  // 🔨 构建新数据 (Build New Batch)
  // ============================================================
  let newContentBlock = "";
  let newHistoryItems = [];
  const timestamp = Date.now();

  summaryList.forEach((item, idx) => {
    // Slice ID 从 1 开始
    const sliceId = idx + 1;

    // 生成唯一 ID (字符串格式: "Batch_Slice")
    // 例如: 5_1, 5_2
    const uniqueId = `${batchId}_${sliceId}`;

    // 1. 拼接文本块
    // <5_1>内容...</5_1>
    newContentBlock += `<${uniqueId}>${item.content}</${uniqueId}>\n\n`;

    // 2. 构建元数据对象
    newHistoryItems.push({
      unique_id: uniqueId,
      batch_id: batchId,
      slice_id: sliceId,
      range_start: startId,
      range_end: endId,
      narrative_time: narrativeTime,
      last_modified: timestamp,
      tags: item.tags || [],
      source_file: targetChatId,
      vectorized: false,
    });
  });

  // ============================================================
  // 💾 写入 Worldbook (Commit)
  // ============================================================

  if (targetEntry) {
    // === 更新模式 ===
    await window.TavernHelper.updateWorldbookWith(wbName, (entries) => {
      const e = entries.find((x) => x.uid === targetEntry.uid);
      if (!e) return entries;

      // 应用之前清理过的文本 + 新追加的文本
      // 注意：targetEntry.content 在上面已经是清理过的了，但 updateWorldbookWith 重新获取了 e
      // 所以我们需要重新执行一次“清理+追加”的逻辑，或者直接利用 targetEntry 的状态

      // 为了安全起见，我们重新对 e 执行一次 replace (虽然有点低效，但最稳妥)
      // 因为上面的 targetEntry 只是副本，不是引用

      // 1. 再次清理旧文本 (正则匹配 <Batch_Any> 比较复杂，不如直接追加)
      // 实际上，我们只要确保 e.content 里没有旧的ID即可。
      // 由于新 ID (uniqueId) 肯定和旧的不同(如果Slice数量变了)，或者相同。
      // 既然我们要覆盖，最好的办法是：先把所有 batchId 相关的标签都洗掉
      // 这里的正则：匹配 <5_数字>...</5_数字>
      const batchRegex = new RegExp(
        `<${batchId}_\\d+>[\\s\\S]*?<\\/${batchId}_\\d+>`,
        "g",
      );
      e.content = e.content.replace(batchRegex, "").trim();

      // 2. 追加新内容
      e.content = e.content + "\n\n" + newContentBlock.trim();

      // 3. 更新 History
      if (!e.extra.history) e.extra.history = [];
      // 过滤掉旧 Batch
      e.extra.history = e.extra.history.filter((h) => h.batch_id !== batchId);
      // 推入新 Batch
      e.extra.history.push(...newHistoryItems);

      // 4. 排序 (Narrative Time -> BatchID -> SliceID)
      e.extra.history.sort((a, b) => {
        if (a.narrative_time !== b.narrative_time)
          return a.narrative_time - b.narrative_time;
        if (a.batch_id !== b.batch_id) return a.batch_id - b.batch_id;
        return a.slice_id - b.slice_id;
      });

      // 更新根属性
      e.extra.source_file = targetChatId;
      e.extra.narrative_time = narrativeTime;

      return entries;
    });
  } else {
    // === 新建模式 ===
    console.log(`[Anima] 新建分卷条目: ${entryName}`);

    // 动态计算 Order (Chapter 1 -> 101, Chapter 2 -> 102)
    const calculatedOrder = 100 + chapterNum;

    const newEntry = {
      keys: ["summary", "前情提要", entryName],
      content: newContentBlock.trim(),
      name: entryName,

      // 🔥 核心修改 1: 默认设为 false (因为假设 RAG 是开启的)
      // 如果 RAG 没开，下面的联动逻辑会在生成后把它修正回来，或者用户手动修正
      enabled: false,

      // 🔥 核心修改 2: 显式指定 constant
      strategy: { type: "constant" },

      // 🔥 核心修改 3: 沉底 + 动态排序
      position: {
        type: "at_depth",
        role: "system",
        depth: 9999,
        order: calculatedOrder,
      },

      extra: {
        createdBy: "anima_summary",
        source_file: targetChatId,
        narrative_time: narrativeTime,
        history: newHistoryItems,
      },
    };
    await window.TavernHelper.createWorldbookEntries(wbName, [newEntry]);
  }

  // ============================================================
  // ⚡ 触发向量更新 (Trigger Vectorization)
  // ============================================================
  const settingsOld = context.extensionSettings?.anima_rag || {};
  const settingsNew =
    context.extensionSettings?.["anima_memory_system"]?.rag || {};
  // 合并配置，以新版为准
  const ragGlobalSettings = { ...settingsOld, ...settingsNew };

  // 默认值为 true
  const isRagEnabled = ragGlobalSettings.rag_enabled !== false;
  const isAutoVectorize = ragGlobalSettings.auto_vectorize !== false;

  // 执行拦截：如果 总开关关闭 或 自动向量化关闭
  if (!isRagEnabled || !isAutoVectorize) {
    console.log(
      `[Anima] 自动向量化已跳过 (总开关: ${isRagEnabled}, 自动: ${isAutoVectorize})`,
    );
    if (window.toastr) toastr.info("总结已保存 (未向量化)");
    // 这里不需要做任何额外操作，UI 默认就是红色的 (vectorized: false)
    return;
  }
  // 对新生成的每个切片，分别触发向量化
  // 这里不需要防抖了，因为通常这是 API 刚刚生成完，直接写入向量库即可
  const successIds = [];
  for (const item of newHistoryItems) {
    try {
      // 注意：这里也需要补上 batchId 参数
      const result = await insertMemory(
        summaryList[item.slice_id - 1].content,
        item.tags,
        item.narrative_time,
        targetChatId,
        null,
        item.unique_id,
        batchId,
      );

      // 如果返回了 ID，说明成功
      if (result && result.success === true) {
        console.log(`[Anima] 向量已存入: ${item.unique_id}`);
        successIds.push(item.unique_id);
      } else {
        // 如果失败，result.error 里现在是干净的文本了
        console.warn(`[Anima] 向量存入失败: ${item.unique_id}`, result?.error);
      }
    } catch (err) {
      console.error(`[Anima] 向量存入过程崩溃:`, err);
    }
  }

  if (successIds.length > 0) {
    await window.TavernHelper.updateWorldbookWith(wbName, (entries) => {
      // 找到刚才操作的条目 (可能是新建的，也可能是现有的)
      // 这里我们用 entryName (如 chapter_1) 来找最稳妥，或者遍历查找包含这些 unique_id 的条目

      // 简单遍历所有 anima 条目
      entries.forEach((entry) => {
        if (entry.extra && Array.isArray(entry.extra.history)) {
          entry.extra.history.forEach((h) => {
            // 如果这个切片的 ID 在成功列表里
            if (successIds.includes(h.unique_id || h.index)) {
              h.vectorized = true; // 标记为绿色
            }
          });
        }
      });
      return entries;
    });
    console.log(`[Anima] 已更新 ${successIds.length} 条记录的同步状态为 True`);
  }
}

/**
 * 删除单条总结的辅助函数
 */
export async function deleteSummaryItem(wbName, entryUid, targetIndex) {
  try {
    const currentEntries = await window.TavernHelper.getWorldbook(wbName);
    const targetEntry = currentEntries.find((x) => x.uid === entryUid);

    // 只有当条目包含 source_file 时才能删除向量
    if (targetEntry && targetEntry.extra && targetEntry.extra.source_file) {
      const collectionId = targetEntry.extra.source_file;
      console.log(
        `[Anima] 正在请求后端删除向量: ID=${collectionId}, Index=${targetIndex}`,
      );

      // 调用我们刚才写的接口
      await deleteMemory(collectionId, targetIndex);

      if (window.toastr) toastr.success(`后端向量 #${targetIndex} 已清理`);
    }
  } catch (e) {
    console.error("尝试删除向量时出错 (不影响前端删除):", e);
  }

  await window.TavernHelper.updateWorldbookWith(wbName, (entries) => {
    const e = entries.find((x) => x.uid === entryUid);
    if (!e) return entries;

    // 1. 删除文本内容: <index>...</index> (保持不变)
    const regex = new RegExp(
      `<${targetIndex}>[\\s\\S]*?<\\/${targetIndex}>`,
      "g",
    );
    e.content = e.content.replace(regex, "").trim();

    // 2. 删除 Extra 元数据 (🔥 修改这里)
    if (Array.isArray(e.extra.history)) {
      e.extra.history = e.extra.history.filter((h) => {
        // 兼容逻辑：优先取 unique_id，没有则取 index (旧数据)
        const currentId = h.unique_id !== undefined ? h.unique_id : h.index;

        // 必须转为字符串比较，防止 3 !== "3" 的情况
        return String(currentId) !== String(targetIndex);
      });

      // 如果删完后 history 还有剩，更新 extra 根属性为最新的一条
      if (e.extra.history.length > 0) {
        // 取最后一条 (按数组顺序)
        const lastItem = e.extra.history[e.extra.history.length - 1];
        Object.assign(e.extra, lastItem);
      } else {
        // 如果删光了，清理根属性
        delete e.extra.index;
        delete e.extra.range_start;
        delete e.extra.range_end;
        // 注意：不要删 createdBy，否则条目会“失联”
      }
    }

    return entries;
  });
}

/**
 * 更新单条总结的内容和Tags
 */
export async function updateSummaryContent(
  wbName,
  entryUid,
  targetIndex,
  newContent,
  newTags,
) {
  await window.TavernHelper.updateWorldbookWith(wbName, (entries) => {
    const e = entries.find((x) => x.uid === entryUid);
    if (!e) return entries;

    // 1. 更新文本内容
    const newBlock = `<${targetIndex}>${newContent}</${targetIndex}>`;
    const regex = new RegExp(`<${targetIndex}>[\\s\\S]*?<\\/${targetIndex}>`);

    if (regex.test(e.content)) {
      e.content = e.content.replace(regex, newBlock);
    } else {
      e.content = e.content + "\n\n" + newBlock;
    }

    // 2. 更新 Extra 中的 Tags 和 状态
    if (e.extra && Array.isArray(e.extra.history)) {
      const historyItem = e.extra.history.find(
        (h) => String(h.unique_id || h.index) === String(targetIndex),
      );
      if (historyItem) {
        historyItem.tags = newTags || [];
        historyItem.last_modified = Date.now();

        // 🔥 [核心修复 1] 只要内容变了，立刻标记为“未向量化” (脏数据)
        // 这样即使后面更新失败了，UI 也会显示红色的“未向量化”
        historyItem.vectorized = false;
      }
    }

    return entries;
  });

  // 触发向量更新 (防抖)
  scheduleVectorUpdate(targetIndex);
}

// worldbook_api.js

const RAG_KNOWLEDGE_ENTRY_NAME = "[ANIMA_RAG_Knowledge_Container]";

/**
 * 更新或创建知识库世界书条目
 * @param {string} content - 要写入的知识库内容
 */
export async function updateKnowledgeEntry(content) {
  const context = SillyTavern.getContext();
  const chatId = context.chatId;

  if (!chatId) return;

  let wbName = window.TavernHelper.getChatWorldbookName("current");

  if (!wbName) {
    if (!content) return;
    const newWbName = chatId.replace(/\.(json|jsonl)$/i, "");
    wbName = await window.TavernHelper.getOrCreateChatWorldbook(
      "current",
      newWbName,
    );
    console.log(`[Anima KB] 自动创建/关联世界书: ${wbName}`);
  }

  const entries = await window.TavernHelper.getWorldbook(wbName);

  // 🔴 [修改 1] 将 e.comment 改为 e.name
  const exists = entries.some((e) => e.name === RAG_KNOWLEDGE_ENTRY_NAME);

  const settings = context.extensionSettings?.["anima_memory_system"]?.rag;
  const kbSettings = settings?.knowledge_injection || {};

  if (exists) {
    // A. 更新现有条目
    await window.TavernHelper.updateWorldbookWith(wbName, (currentEntries) => {
      // 🔴 [修改 2] 将 e.comment 改为 e.name
      const target = currentEntries.find(
        (e) => e.name === RAG_KNOWLEDGE_ENTRY_NAME,
      );
      if (target) {
        if (target.content !== content) {
          target.content = content || "";
          target.enabled = !!content;
          applyEntrySettings(target, kbSettings);
        }
        // 补个保险：确保 comment 也被更新（以防万一）
        target.comment = RAG_KNOWLEDGE_ENTRY_NAME;
      }
      return currentEntries;
    });
  } else {
    // B. 创建新条目
    if (!content) return;

    const newEntryStub = {
      name: RAG_KNOWLEDGE_ENTRY_NAME, // 主键
      comment: RAG_KNOWLEDGE_ENTRY_NAME, // 备注
      content: content,
      enabled: true,
      keys: ["rag_knowledge"],
      strategy: {},
      position: {},
    };

    applyEntrySettings(newEntryStub, kbSettings);

    await window.TavernHelper.createWorldbookEntries(wbName, [newEntryStub]);
    console.log(`[Anima KB] 新条目已创建`);
  }
}

/**
 * 清理知识库条目 (置空并禁用)
 */
export async function clearKnowledgeEntry() {
  // 1. 获取当前世界书名称
  const wbName = window.TavernHelper.getChatWorldbookName("current");
  if (!wbName) return;

  // 2. 预检查
  const entries = await window.TavernHelper.getWorldbook(wbName);

  // 🔴 [修改 3] 将 e.comment 改为 e.name
  const target = entries.find((e) => e.name === RAG_KNOWLEDGE_ENTRY_NAME);

  // 如果条目不存在，或者已经是 (内容为空 且 禁用) 的状态，直接返回
  if (!target) return;
  if (
    (!target.content || target.content.trim() === "") &&
    target.enabled === false
  ) {
    return;
  }

  // 3. 执行清理
  await window.TavernHelper.updateWorldbookWith(
    wbName,
    (currentEntries) => {
      // 🔴 [修改 4] 将 e.comment 改为 e.name
      const entry = currentEntries.find(
        (e) => e.name === RAG_KNOWLEDGE_ENTRY_NAME,
      );
      if (entry) {
        entry.content = "";
        entry.enabled = true;
        entry.keys = ["rag_knowledge"];
      }
      return currentEntries;
    },
    { render: "immediate" },
  );

  console.log(`[Anima KB] 条目已清理 (Immediate Render)`);
}

/**
 * 辅助：将 Anima 的配置映射到 SillyTavern 的 WorldbookEntry 结构
 * @param {Object} entry - SillyTavern 的条目对象 (Partial)
 * @param {Object} settings - Anima 的注入配置
 */
function applyEntrySettings(entry, settings) {
  if (!settings) return;

  // 1. 映射激活策略 (Strategy)
  // 确保 strategy 对象存在
  if (!entry.strategy) entry.strategy = {};

  if (settings.strategy === "constant") {
    entry.strategy.type = "constant";
  } else if (settings.strategy === "selective") {
    entry.strategy.type = "selective";
    // 如果是 selective，必须有 keys，否则无法触发。这里给一个默认 key
    if (!entry.keys || entry.keys.length === 0) {
      entry.keys = ["rag_knowledge", "knowledge_base"];
    }
  }

  // 2. 映射插入位置 (Position)
  // 确保 position 对象存在
  if (!entry.position) entry.position = {};

  // 映射位置类型字符串
  const posMap = {
    before_character_definition: "before_character_definition",
    after_character_definition: "after_character_definition",
    at_depth: "at_depth",
  };

  // 默认为 after_character_definition
  entry.position.type =
    posMap[settings.position] || "after_character_definition";

  // 映射顺序/深度
  entry.position.order = parseInt(settings.order) || 100;

  if (settings.position === "at_depth") {
    entry.position.depth = parseInt(settings.depth) || 4;
    entry.position.role = settings.role || "system";
  }
}

/**
 * 检查指定 Index 是否已存在，并返回其元数据
 */
export async function getIndexConflictInfo(targetIndex) {
  if (!window.TavernHelper) return null;

  const wbName = await window.TavernHelper.getChatWorldbookName("current");
  if (!wbName) return null; // 没绑定世界书肯定没冲突

  const entries = await window.TavernHelper.getWorldbook(wbName);

  // 寻找包含该 index 的条目
  // 我们遍历所有 Anima 创建的条目，检查其 history 数组
  for (const entry of entries) {
    if (
      entry.extra &&
      entry.extra.createdBy === "anima_summary" &&
      Array.isArray(entry.extra.history)
    ) {
      const historyItem = entry.extra.history.find(
        (h) => h.index === targetIndex,
      );
      if (historyItem) {
        return {
          exists: true,
          range_start: historyItem.range_start,
          range_end: historyItem.range_end,
          entryName: entry.name,
        };
      }
    }
  }
  return null;
}

/**
 * 获取指定 BatchID 之前的 N 个切片内容 (适配 Batch+Slice 架构)
 * @param {number} targetBatchId 当前准备生成的 BatchID (我们将获取比这个小的)
 * @param {number} count 需要往前查找的切片数量
 * @returns {Promise<string>} 格式化好的文本
 */
export async function getPreviousSummaries(targetBatchId, count) {
  if (!count || count <= 0) return "";
  if (!window.TavernHelper) return "";

  const wbName = await window.TavernHelper.getChatWorldbookName("current");
  if (!wbName) return "";

  const entries = await window.TavernHelper.getWorldbook(wbName);

  // 1. 收集所有历史记录并扁平化
  let allHistory = [];
  entries.forEach((entry) => {
    if (
      entry.extra &&
      entry.extra.createdBy === "anima_summary" &&
      Array.isArray(entry.extra.history)
    ) {
      entry.extra.history.forEach((h) => {
        // ✨ 适配新旧数据结构
        const batchId = h.batch_id !== undefined ? h.batch_id : h.index;
        const sliceId = h.slice_id !== undefined ? h.slice_id : 0;
        const uniqueId = h.unique_id !== undefined ? h.unique_id : h.index;

        allHistory.push({
          batch_id: batchId,
          slice_id: sliceId,
          unique_id: uniqueId, // 关键：用于正则提取
          parentContent: entry.content,
        });
      });
    }
  });

  // 2. 筛选：只取 BatchID 小于当前目标 BatchID 的记录
  const validHistory = allHistory.filter((h) => h.batch_id < targetBatchId);

  // 3. 排序：BatchID 从小到大 -> SliceID 从小到大
  validHistory.sort((a, b) => {
    if (a.batch_id !== b.batch_id) {
      return a.batch_id - b.batch_id;
    }
    return a.slice_id - b.slice_id;
  });

  // 4. 截取最后 Count 个 (即最近的 N 个切片)
  const selected = validHistory.slice(-count);

  if (selected.length === 0) return "";

  // 5. 提取内容并拼接
  let rawContents = [];
  for (const item of selected) {
    // ✨ 修正：使用 unique_id 构建正则 (兼容 "6_1" 和旧的 "6")
    // 正则解释：匹配 <unique_id>...</unique_id> 标签内的内容
    const regex = new RegExp(
      `<${item.unique_id}>([\\s\\S]*?)<\\/${item.unique_id}>`,
    );
    const match = item.parentContent.match(regex);
    if (match) {
      rawContents.push(match[1].trim());
    }
  }

  // 使用双换行拼接
  return rawContents.join("\n\n");
}

/**
 * 惰性加载专用：根据 UID 和 Index 获取单条总结的文本内容
 */
export async function getSummaryTextFromEntry(entryUid, targetIndex) {
  if (!window.TavernHelper) return "";

  const wbName = await window.TavernHelper.getChatWorldbookName("current");
  if (!wbName) return "";

  const entries = await window.TavernHelper.getWorldbook(wbName);
  const entry = entries.find((e) => e.uid === entryUid);

  if (!entry) return "(条目已丢失)";

  // 执行正则提取
  const regex = new RegExp(`<${targetIndex}>([\\s\\S]*?)<\\/${targetIndex}>`);
  const match = entry.content.match(regex);

  return match ? match[1] : "(内容标签丢失或为空)";
}
const vectorUpdateTimers = {}; // 存储防抖定时器
const DEBOUNCE_DELAY = 2000; // 默认延迟 5秒，后续可改为从 settings 读取

/**
 * 调度向量更新 (防抖)
 * 当总结被修改时调用此函数
 */
function scheduleVectorUpdate(index) {
  // 1. 清除旧的定时器 (如果用户还在持续修改，就一直重置倒计时)
  if (vectorUpdateTimers[index]) {
    clearTimeout(vectorUpdateTimers[index]);
  }

  console.log(
    `[Anima] Index ${index} 已变动，将在 ${DEBOUNCE_DELAY / 1000} 秒后触发向量更新...`,
  );

  // 2. 设置新的定时器
  vectorUpdateTimers[index] = setTimeout(() => {
    triggerVectorUpdate(index);
    delete vectorUpdateTimers[index]; // 执行完清理引用
  }, DEBOUNCE_DELAY);
}

/**
 * 实际触发向量更新
 * 修复：统一配置读取路径，确保正确读取 auto_vectorize
 */
export async function triggerVectorUpdate(index) {
  console.log(`⚡ [Anima Vector] 触发增量更新检查: Index ${index}`);

  if (!window.TavernHelper) return;

  const context = SillyTavern.getContext();

  // 🔥 [核心修复]：兼容两种配置路径，优先读取 anima_memory_system
  const settingsOld = context.extensionSettings?.anima_rag || {};
  const settingsNew =
    context.extensionSettings?.["anima_memory_system"]?.rag || {};

  // 合并配置，以新版为准
  const ragGlobalSettings = { ...settingsOld, ...settingsNew };

  // 获取开关状态 (默认为 true)
  const isRagEnabled = ragGlobalSettings.rag_enabled !== false;
  const isAutoVectorize = ragGlobalSettings.auto_vectorize !== false;

  // 拦截逻辑
  if (!isRagEnabled || !isAutoVectorize) {
    console.warn(
      `[Anima] 增量向量化被拦截 (总开关: ${isRagEnabled}, 自动: ${isAutoVectorize})`,
    );
    // 如果是因为自动同步关闭而拦截，给个提示
    if (isRagEnabled && !isAutoVectorize && window.toastr) {
      toastr.info(`修改已保存 (自动向量化未开启)`, `Index #${index}`);
    }
    return;
  }

  // === 以下是执行逻辑，保持你原有代码不变 ===
  const wbName = await window.TavernHelper.getChatWorldbookName("current");
  if (!wbName) return;

  const entries = await window.TavernHelper.getWorldbook(wbName);

  // 查找条目
  let targetEntry = null;
  let historyItem = null;

  for (const entry of entries) {
    if (entry.extra && Array.isArray(entry.extra.history)) {
      const found = entry.extra.history.find(
        (h) => String(h.unique_id || h.index) === String(index),
      );
      if (found) {
        targetEntry = entry;
        historyItem = found;
        break;
      }
    }
  }

  if (!targetEntry || !historyItem) {
    console.warn(`[Anima] 未找到 Index ${index} 的世界书条目，跳过向量化。`);
    return;
  }

  const collectionId = targetEntry.extra.source_file;
  if (!collectionId) {
    console.error("[Anima] 条目缺少 source_file，无法定位向量库。");
    return;
  }

  // 提示用户后台开始工作了
  if (window.toastr) toastr.info(`正在后台同步向量...`, `Index #${index}`);

  const summaryText = await getSummaryTextFromEntry(targetEntry.uid, index);
  const tags = historyItem.tags || [];
  const timestamp = historyItem.narrative_time;
  const batchId =
    historyItem.batch_id !== undefined ? historyItem.batch_id : null;

  console.log(`[Anima] 正在推送到向量库: ${collectionId} (Index: ${index})`);

  // 调用 API
  const result = await insertMemory(
    summaryText,
    tags,
    timestamp,
    collectionId,
    null,
    index,
    batchId,
  );

  if (result && result.success === true) {
    console.log(`[Anima] ✅ 向量更新成功: Index ${index}`);

    // 更新世界书状态为 true
    await window.TavernHelper.updateWorldbookWith(wbName, (currEntries) => {
      const e = currEntries.find((x) => x.uid === targetEntry.uid);
      if (e && e.extra && Array.isArray(e.extra.history)) {
        const h = e.extra.history.find(
          (x) => String(x.unique_id || x.index) === String(index),
        );
        if (h) {
          h.vectorized = true; // 标记为已同步
        }
      }
      return currEntries;
    });

    if (window.toastr) toastr.success(`向量已自动更新`, `Index #${index}`);
  } else {
    // 失败处理
    console.warn(`[Anima] ⛔ 向量更新失败: Index ${index}`, result?.error);
    // 此时 Toastr 显示干净的报错信息
    if (window.toastr)
      toastr.warning(
        `更新失败: ${result?.error || "未知错误"}`,
        `Index #${index}`,
      );
  }
}
/**
 * [RAG专用] 更新或创建 RAG 容器条目
 * ⚡ 逻辑变更：优先使用传入 settings，但如果缺失，自动回退读取全局配置
 */
export async function updateRagEntry(content, settings = {}) {
  if (!window.TavernHelper) return;

  const context = SillyTavern.getContext();
  const chatId = context.chatId;
  if (!chatId) return;

  // 获取或初始化聊天世界书
  let wbName = await window.TavernHelper.getChatWorldbookName("current");
  if (!wbName) {
    if (!content) return;
    const newWbName = chatId.replace(/\.(json|jsonl)$/i, "");
    wbName = await window.TavernHelper.getOrCreateChatWorldbook(
      "current",
      newWbName,
    );
  }

  const RAG_ENTRY_NAME = "[ANIMA_RAG_Container]";

  // 🟢 [新增] 主动读取全局配置，确保创建时与 UI 一致
  // 注意：请确保这里的路径和你保存配置的路径一致
  const globalSettings =
    context.extensionSettings?.["anima_memory_system"]?.rag?.injection || {};

  // 🟢 [修改] 合并配置：参数 > 全局配置 > 默认值
  const finalSettings = {
    strategy: settings.strategy || globalSettings.strategy || "constant",
    position: settings.position || globalSettings.position || "at_depth",

    // Role 特殊处理：UI保存的是字符串，世界书里可能是数字
    role: settings.role || globalSettings.role || "system",

    // 深度和顺序
    depth:
      (settings.depth !== undefined ? settings.depth : globalSettings.depth) ??
      9999,
    order:
      (settings.order !== undefined ? settings.order : globalSettings.order) ??
      100,
  };

  const entries = await window.TavernHelper.getWorldbook(wbName);
  const targetEntry = entries.find((e) => e.name === RAG_ENTRY_NAME);

  // 辅助函数：将 role 字符串转为数字 (ST标准: 0=System, 1=User, 2=Assistant)
  const resolveRole = (roleStr) => {
    if (roleStr === "user") return 1;
    if (roleStr === "assistant") return 2;
    return 0; // system
  };

  if (targetEntry) {
    // === A. 更新模式 ===
    await window.TavernHelper.updateWorldbookWith(wbName, (currentEntries) => {
      const e = currentEntries.find((x) => x.uid === targetEntry.uid);
      if (e) {
        e.content = content;
        e.enabled = true;

        // 覆盖属性
        if (!e.strategy) e.strategy = {};
        e.strategy.type = finalSettings.strategy;

        if (!e.position) e.position = {};
        e.position.type = finalSettings.position;
        e.position.order = finalSettings.order;

        if (finalSettings.position === "at_depth") {
          e.position.depth = finalSettings.depth;
        } else {
          e.position.depth = 0;
        }

        e.role = resolveRole(finalSettings.role);
      }
      return currentEntries;
    });
  } else {
    // === B. 新建模式 ===
    if (!content) return;

    const newEntry = {
      name: RAG_ENTRY_NAME,
      keys: ["RAG_CONTAINER"],
      content: content,
      enabled: true,
      strategy: {
        type: finalSettings.strategy,
      },
      position: {
        type: finalSettings.position,
        depth: finalSettings.depth,
        order: finalSettings.order,
      },
      role: resolveRole(finalSettings.role),
      extra: {
        createdBy: "anima_rag",
      },
    };
    await window.TavernHelper.createWorldbookEntries(wbName, [newEntry]);
  }
}

/**
 * [RAG专用] 清空 RAG 条目内容
 * 安全清理：只有当条目存在时才执行，绝不自动创建
 */
export async function clearRagEntry() {
  if (!window.TavernHelper) return;

  // 1. 获取当前绑定的世界书，如果没有绑定，说明肯定没有 RAG 条目，直接跳过
  const wbName = await window.TavernHelper.getChatWorldbookName("current");
  if (!wbName) return;

  // 2. 检查条目是否存在
  const entries = await window.TavernHelper.getWorldbook(wbName);
  const RAG_ENTRY_NAME = "[ANIMA_RAG_Container]";
  const targetEntry = entries.find((e) => e.name === RAG_ENTRY_NAME);

  // 3. 只有存在时才执行更新
  if (targetEntry) {
    await window.TavernHelper.updateWorldbookWith(wbName, (currentEntries) => {
      const e = currentEntries.find((x) => x.uid === targetEntry.uid);
      if (e) {
        e.content = ""; // 清空内容
        // e.enabled = false; // 可选：清理后是否禁用？通常保持启用但内容为空即可，避免频繁开关导致闪烁
      }
      return currentEntries;
    });
    console.log("[Anima] RAG 条目内容已清理");
  } else {
    // 条目不存在，什么都不做
  }
}

/**
 * 获取指定聊天世界书中最新的总结进度 (用于同步检查)
 * @returns {Promise<{maxEndId: number, maxBatchId: number} | null>}
 */
export async function getLatestSummaryInfo(chatId) {
  if (!window.TavernHelper || !chatId) return null;

  // 根据 chatId 推导世界书名
  const wbName = chatId.replace(/\.(json|jsonl)$/i, "");

  try {
    const entries = await window.TavernHelper.getWorldbook(wbName);
    if (!entries) return null;

    // 找到 Anima 的条目
    // 可能有多个 chapter 条目，我们需要遍历所有由 anima_summary 创建的条目
    const animaEntries = entries.filter(
      (e) => e.extra && e.extra.createdBy === "anima_summary",
    );

    if (animaEntries.length === 0) return null;

    let maxEndId = -1;
    let maxBatchId = 0;

    // 遍历所有条目的 history 寻找最大值
    animaEntries.forEach((entry) => {
      if (Array.isArray(entry.extra.history)) {
        entry.extra.history.forEach((h) => {
          // 确保是数字
          const end = parseInt(h.range_end);
          const batch = parseInt(
            h.batch_id !== undefined ? h.batch_id : h.index,
          );

          if (!isNaN(end) && end > maxEndId) {
            maxEndId = end;
            maxBatchId = batch;
          }
        });
      }
    });

    if (maxEndId === -1) return null;

    return { maxEndId, maxBatchId };
  } catch (e) {
    console.error("[Anima] 读取世界书进度失败:", e);
    return null;
  }
}

/**
 * 获取最新的 N 个总结切片 (用于 RAG 注入的 recent_history)
 * @param {number} count 需要获取的数量
 * @returns {Promise<{text: string, ids: string[]}>} 返回格式化后的文本和这些切片的ID列表(用于去重)
 */
export async function getLatestRecentSummaries(count) {
  if (!count || count <= 0) return { text: "", ids: [] };
  if (!window.TavernHelper) return { text: "", ids: [] };

  const wbName = await window.TavernHelper.getChatWorldbookName("current");
  if (!wbName) return { text: "", ids: [] };

  const entries = await window.TavernHelper.getWorldbook(wbName);

  // 1. 收集所有历史记录 (Anima创建的)
  let allHistory = [];
  entries.forEach((entry) => {
    if (
      entry.extra &&
      entry.extra.createdBy === "anima_summary" &&
      Array.isArray(entry.extra.history)
    ) {
      entry.extra.history.forEach((h) => {
        const batchId = h.batch_id !== undefined ? h.batch_id : h.index;
        const sliceId = h.slice_id !== undefined ? h.slice_id : 0;
        const uniqueId = h.unique_id !== undefined ? h.unique_id : h.index;

        allHistory.push({
          batch_id: Number(batchId),
          slice_id: Number(sliceId),
          unique_id: String(uniqueId),
          parentContent: entry.content,
          narrative_time: h.narrative_time, // 辅助排序
        });
      });
    }
  });

  if (allHistory.length === 0) return { text: "", ids: [] };

  // 2. 倒序排序 (最新的在最前)
  // 优先级: NarrativeTime > BatchID > SliceID
  allHistory.sort((a, b) => {
    // 如果有时间戳，优先按时间倒序
    if (
      a.narrative_time &&
      b.narrative_time &&
      a.narrative_time !== b.narrative_time
    ) {
      // ✅ 修复：添加 .getTime()
      return (
        new Date(b.narrative_time).getTime() -
        new Date(a.narrative_time).getTime()
      );
    }
    // 其次按 Batch 倒序
    if (a.batch_id !== b.batch_id) return b.batch_id - a.batch_id;
    // 最后按 Slice 倒序
    return b.slice_id - a.slice_id;
  });

  // 3. 截取前 N 个
  const selected = allHistory.slice(0, count);

  // 为了符合阅读习惯，虽然是倒序取出来的，但拼接文本时应该按“正序”拼
  // 比如取出 [5_2, 5_1]，拼接时应该是 "内容(5_1)\n\n内容(5_2)"
  selected.reverse();

  const ids = [];
  const textParts = [];

  for (const item of selected) {
    ids.push(item.unique_id);

    // 正则提取内容 <5_2>...</5_2>
    const regex = new RegExp(
      `<${item.unique_id}>([\\s\\S]*?)<\\/${item.unique_id}>`,
    );
    const match = item.parentContent.match(regex);
    if (match) {
      textParts.push(match[1].trim());
    }
  }

  return {
    text: textParts.join("\n\n"), // 用双换行连接
    ids: ids, // 返回 ID 数组用于后端去重
  };
}

/**
 * 切换所有 Anima 总结条目的启用状态
 * @param {boolean} isRagEnabled - 当前向量总开关的状态
 */
export async function toggleAllSummariesState(isRagEnabled) {
  if (!window.TavernHelper) return;

  const wbName = await window.TavernHelper.getChatWorldbookName("current");
  if (!wbName) return;

  // 逻辑反转：RAG 开 -> 条目关；RAG 关 -> 条目开
  const targetState = !isRagEnabled;

  await window.TavernHelper.updateWorldbookWith(wbName, (entries) => {
    let modifiedCount = 0;
    entries.forEach((entry) => {
      // 筛选条件：由 anima_summary 创建的 chapter 条目
      if (
        entry.extra &&
        entry.extra.createdBy === "anima_summary" &&
        entry.name.startsWith("chapter_")
      ) {
        if (entry.enabled !== targetState) {
          entry.enabled = targetState;
          modifiedCount++;
        }
      }
    });

    if (modifiedCount > 0) {
      console.log(
        `[Anima] 联动切换: RAG=${isRagEnabled} -> ${modifiedCount} 个总结条目设为 ${targetState}`,
      );
      if (window.toastr)
        toastr.info(
          `已自动${targetState ? "启用" : "禁用"} ${modifiedCount} 个总结条目`,
        );
    }

    return entries;
  });
}

/**
 * [新增] 强制同步 RAG 配置到世界书条目 (用于在 UI 点击保存时调用)
 * 这将更新 [ANIMA_RAG_Container] 和 [ANIMA_RAG_Knowledge_Container] 的策略与位置，而不改变内容
 */
export async function syncRagSettingsToWorldbook() {
  if (typeof window.TavernHelper.getChatWorldbookName !== "function") {
    console.warn("[Anima RAG] 请更新酒馆助手！");
    return;
  }
  if (!window.TavernHelper) return;

  const context = SillyTavern.getContext();
  const wbName = await window.TavernHelper.getChatWorldbookName("current");
  if (!wbName) return;

  // 1. 获取最新配置 (请确保这里的路径与你在 rag.js 中保存的路径一致)
  const allSettings =
    context.extensionSettings?.["anima_memory_system"]?.rag || {};

  // 假设配置结构如下 (你需要根据实际情况调整字段名):
  const chatSettings = allSettings.injection_settings || {}; // 聊天注入配置
  const kbSettings = allSettings.knowledge_injection || {}; // 知识库注入配置

  // 2. 定义要更新的目标
  const targets = [
    { name: "[ANIMA_RAG_Container]", settings: chatSettings },
    { name: "[ANIMA_RAG_Knowledge_Container]", settings: kbSettings },
  ];

  // 3. 执行更新
  await window.TavernHelper.updateWorldbookWith(wbName, (entries) => {
    let modified = false;

    targets.forEach(({ name, settings }) => {
      const entry = entries.find((e) => e.name === name);
      if (entry && settings) {
        // 应用 Strategy
        if (!entry.strategy) entry.strategy = {};
        // 如果配置里有 strategy 字段才更新，防止 undefined
        if (settings.strategy) entry.strategy.type = settings.strategy;

        // 应用 Position
        if (!entry.position) entry.position = {};

        // 映射位置类型
        const posMap = {
          before_character_definition: "before_character_definition",
          after_character_definition: "after_character_definition",
          at_depth: "at_depth",
        };

        if (settings.position) {
          entry.position.type =
            posMap[settings.position] || "after_character_definition";
        }

        if (settings.order !== undefined)
          entry.position.order = parseInt(settings.order);
        if (settings.depth !== undefined)
          entry.position.depth = parseInt(settings.depth);

        // 应用 Role
        if (settings.role) {
          entry.role =
            settings.role === "user"
              ? 1
              : settings.role === "assistant"
                ? 2
                : 0;
        }

        modified = true;
      }
    });

    if (modified) console.log("[Anima] 世界书条目配置已同步为最新 UI 设置");
    return entries;
  });
}
