// 导入前端通用 API
import { getAnimaConfig } from "./api.js";
import {
  safeGetChatWorldbookName,
  getSummaryTextFromEntry,
  markAllBm25Unsynced,
} from "./worldbook_api.js";

const DEFAULT_BM25_SETTINGS = {
  bm25_enabled: true,
  current_dict: "default_dict",
  auto_build: true,
  search_top_k: 3,
  dictionaries: {
    default_dict: [{ trigger: "魔法, 法术", index: "魔法" }],
  },
  // 记录每个聊天对应的词典，如 { "chat-123": "fantasy_world_v1" }
  chat_dict_bindings: {},
};

/**
 * 1. 获取完整的 BM25 设置 (带默认值合并)
 */
export function getBm25Settings() {
  const context = SillyTavern.getContext();
  // 假设你的插件设置存在 anima_bm25_system 下
  let settings = context.extensionSettings?.["anima_bm25_system"];

  if (!settings) {
    settings = JSON.parse(JSON.stringify(DEFAULT_BM25_SETTINGS));
    context.extensionSettings["anima_bm25_system"] = settings;
  }
  return settings;
}

/**
 * 2. 保存设置到 SillyTavern 本地
 */
export async function saveBm25Settings(newSettings) {
  const context = SillyTavern.getContext();
  context.extensionSettings["anima_bm25_system"] = newSettings;
  await context.saveSettings();
  console.log("[Anima BM25] 设置已保存");
}

/**
 * 3. 🧠 核心：获取发给后端的结构化 BM25 配置包
 * @param {string} targetDictName - 明确指定要使用的词典名 (传空则取当前角色绑定的词典)
 */
export function getBm25BackendConfig(targetDictName = null) {
  const context = SillyTavern.getContext();
  const globalSettings =
    context.extensionSettings?.anima_memory_system?.bm25 || {};

  if (globalSettings.bm25_enabled === false) return { enabled: false };

  let activeDictName = targetDictName;

  // 如果没有强制指定词典名，才去读当前角色的兜底配置
  if (!activeDictName) {
    const charId = context.characterId;
    const charSettings =
      charId !== undefined
        ? context.characters[charId]?.data?.extensions?.anima_bm25_settings ||
          {}
        : {};
    activeDictName =
      charSettings.bound_dict || globalSettings.current_dict || "default_dict";
  }

  const dictData = globalSettings.custom_dicts?.[activeDictName] || {
    words: [],
  };

  const formattedDictionary = (dictData.words || []).map((word) => {
    const explicitTriggers = word.trigger
      ? String(word.trigger)
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
    const indexWord = String(word.index).trim();
    const allTriggers = [...new Set([...explicitTriggers, indexWord])].filter(
      Boolean,
    );

    return {
      trigger: word.trigger || "",
      index: indexWord,
      triggers: allTriggers,
      indexWords: [indexWord].filter(Boolean),
    };
  });

  return {
    enabled: true,
    // 🗑️ 删除：blacklistedTags: blacklistedTags,
    dictionary: formattedDictionary,
  };
}

/**
 * 4. 📊 获取当前聊天所有总结切片的 BM25 同步状态
 * 返回格式: { wbName: "...", list: [...] }
 */
export async function getBm25SyncList() {
  if (!window.TavernHelper) return { wbName: "未绑定", list: [] };
  const wbName = await safeGetChatWorldbookName();
  if (!wbName) return { wbName: "未绑定", list: [] };

  const entries = await window.TavernHelper.getWorldbook(wbName);
  const syncList = [];

  for (const entry of entries) {
    if (
      entry.extra &&
      entry.extra.createdBy === "anima_summary" &&
      Array.isArray(entry.extra.history)
    ) {
      for (const h of entry.extra.history) {
        const fullText = await getSummaryTextFromEntry(
          entry.uid,
          h.unique_id || h.index,
        );
        syncList.push({
          unique_id: h.unique_id || h.index,
          entryUid: entry.uid, // 🟢 新增：必须传给前端用于调取内容
          batch_id: h.batch_id,
          slice_id: h.slice_id,
          range_start: h.range_start || 0,
          range_end: h.range_end || 0,
          tags: h.tags || [],
          is_bm25_synced: h.is_bm25_synced === true,
          fullText: fullText,
        });
      }
    }
  }

  syncList.sort((a, b) => {
    if (a.batch_id !== b.batch_id) return b.batch_id - a.batch_id;
    return b.slice_id - a.slice_id;
  });

  return { wbName, list: syncList };
}

/**
 * 5. ✅ 更新特定切片的 BM25 同步状态为 True
 */
export async function markBm25Synced(uniqueId) {
  if (!window.TavernHelper) return;
  const wbName = await safeGetChatWorldbookName();
  if (!wbName) return;

  await window.TavernHelper.updateWorldbookWith(wbName, (entries) => {
    for (const e of entries) {
      if (e.extra && Array.isArray(e.extra.history)) {
        const target = e.extra.history.find(
          (h) => String(h.unique_id || h.index) === String(uniqueId),
        );
        if (target) {
          target.is_bm25_synced = true;
          break;
        }
      }
    }
    return entries;
  });
}

/**
 * 6. 🚀 真正触发单条切片的 BM25 索引构建 (连通后端)
 */
export async function triggerBm25BuildSingle(
  uniqueId,
  entryUid,
  batchId,
  tags,
  skipCapture = false,
) {
  const text = await getSummaryTextFromEntry(entryUid, uniqueId);
  const context = SillyTavern.getContext();

  const chatId = context.chatId;
  const safeChatId = chatId ? chatId.replace(/\.jsonl?$/i, "") : "default";

  // 1. 获取全局字典池
  const globalSettings =
    context.extensionSettings?.anima_memory_system?.bm25 || {};

  // 2. 精准定位当前角色绑定的词典
  const charId = context.characterId;
  const charSettings =
    charId !== undefined
      ? context.characters[charId]?.data?.extensions?.anima_bm25_settings || {}
      : {};

  const dictName =
    charSettings.bound_dict || globalSettings.current_dict || "default_dict";
  const dictData = globalSettings.custom_dicts?.[dictName] || {
    blacklist: "",
    words: [],
  };

  // ✨ 4. 核心精简：抛弃原本那一大坨手工格式化代码
  // 直接调用刚刚修复好的函数，传入当前的词典名生成配置包
  const bm25Config = getBm25BackendConfig(dictName);

  try {
    const res = await $.ajax({
      url: "/api/plugins/anima-rag/bm25/rebuild_slice",
      type: "POST",
      contentType: "application/json",
      data: JSON.stringify({
        collectionId: safeChatId,
        index: uniqueId,
        text: text,
        tags: tags,
        timestamp: Date.now(),
        batch_id: batchId,
        bm25Config: bm25Config, // 直接将生成的配置包传给后端
      }),
      dataType: "json",
    });

    if (res.success) {
      await markBm25Synced(uniqueId);
      return true;
    }
    return false;
  } catch (e) {
    console.error("[Anima BM25] 请求后端重构失败:", e);
    throw e;
  }
}

/**
 * 🚀 极速触发：将多个脏切片打包发给后端，执行一次性 IO 写入
 * @param {Array} dirtyItems - 包含 fullText, unique_id, tags 等属性的脏切片数组
 */
export async function triggerBm25BuildBatch(dirtyItems) {
  if (!dirtyItems || dirtyItems.length === 0) return true;

  const context = SillyTavern.getContext();
  const chatId = context.chatId;
  const safeChatId = chatId ? chatId.replace(/\.jsonl?$/i, "") : "default";

  // 获取当前绑定的词典配置
  const globalSettings =
    context.extensionSettings?.anima_memory_system?.bm25 || {};
  const charId = context.characterId;
  const charSettings =
    charId !== undefined
      ? context.characters[charId]?.data?.extensions?.anima_bm25_settings || {}
      : {};
  const dictName =
    charSettings.bound_dict || globalSettings.current_dict || "default_dict";
  const bm25Config = getBm25BackendConfig(dictName);

  // 将前端格式映射为后端需要的数据包数组
  const slicesPayload = dirtyItems.map((item) => ({
    index: item.unique_id,
    text: item.fullText,
    tags: item.tags || [],
    timestamp: Date.now(),
    batch_id: item.batch_id,
  }));

  try {
    const res = await $.ajax({
      url: "/api/plugins/anima-rag/bm25/rebuild_slice_batch",
      type: "POST",
      contentType: "application/json",
      data: JSON.stringify({
        collectionId: safeChatId,
        slices: slicesPayload,
        bm25Config: bm25Config,
      }),
      dataType: "json",
    });

    if (res.success) {
      // 后端构建成功后，调用我们之前修复过的批量洗白函数，更新世界书状态
      const idsToMark = dirtyItems.map((i) => i.unique_id);
      await markAllBm25SyncedBatch(idsToMark);
      return res.count;
    }
    return false;
  } catch (e) {
    console.error("[Anima BM25] 请求后端批量重构失败:", e);
    throw e;
  }
}

/**
 * 5.1 🚀 批量更新切片的 BM25 同步状态为 True (防止 IO 灾难)
 */
export async function markAllBm25SyncedBatch(uniqueIds) {
  if (!window.TavernHelper) return;
  const wbName = await safeGetChatWorldbookName();
  if (!wbName || !uniqueIds || uniqueIds.length === 0) return;

  const idSet = new Set(uniqueIds.map(String));

  await window.TavernHelper.updateWorldbookWith(wbName, (entries) => {
    // let changed = false; // 不再需要这个变量

    for (const e of entries) {
      if (e.extra && Array.isArray(e.extra.history)) {
        for (const h of e.extra.history) {
          if (idSet.has(String(h.unique_id || h.index)) && !h.is_bm25_synced) {
            h.is_bm25_synced = true;
            // changed = true;
          }
        }
      }
    }
    return entries;
  });
}

// ================= 新增：自动更新词典与重建逻辑 =================

/**
 * 获取当前聊天对应的安全 BM25 库名 (从 bm25.js 中复用过来的工具函数)
 */
export function getCurrentBm25LibName() {
  const context = SillyTavern.getContext();
  const chatId = context.chatId;
  const safeChatId = chatId ? chatId.replace(/\.jsonl?$/i, "") : "default";
  return safeChatId.replace(/[^a-zA-Z0-9@\-\._\u4e00-\u9fa5]/g, "_");
}

/**
 * 自动捕获 JSON 数据更新词典 (带全链路 Debug 日志)
 */
export async function autoUpdateDictionary(dictUpdates) {
  console.log("🔍 [Debug] 进入 autoUpdateDictionary, 接收到数据:", dictUpdates);

  if (!dictUpdates || !Array.isArray(dictUpdates) || dictUpdates.length === 0) {
    console.log("❌ [Debug] 终止: dictUpdates 为空或不是数组");
    return false;
  }

  const context = SillyTavern.getContext();
  const globalSettings =
    context.extensionSettings?.anima_memory_system?.bm25 || {};

  // 1. 检查自动捕获开关 (兼容 undefined 的情况)
  const isAutoCapture = globalSettings.auto_capture_tags !== false;
  console.log(
    `🔍 [Debug] BM25 全局配置检查 -> 开启状态: ${globalSettings.bm25_enabled}, 自动捕获判定: ${isAutoCapture} (底层原始值: ${globalSettings.auto_capture_tags})`,
  );

  if (!isAutoCapture) {
    console.log("❌ [Debug] 终止: auto_capture_tags 被显式关闭。");
    return false;
  }

  // 2. 查角色卡，获取当前绑定的词典
  const charId = context.characterId;
  const charSettings =
    charId !== undefined
      ? context.characters[charId]?.data?.extensions?.anima_bm25_settings || {}
      : {};
  const dictName =
    charSettings.bound_dict || globalSettings.current_dict || "default_dict";
  console.log(
    `🔍 [Debug] 当前解析出的目标词典名称为: [${dictName}] (当前角色ID: ${charId})`,
  );

  // 3. 定位到全局里的具体词典数据
  if (!globalSettings.custom_dicts) globalSettings.custom_dicts = {};
  const dictData = globalSettings.custom_dicts[dictName];
  if (!dictData) {
    console.log(
      `❌ [Debug] 终止: 在 custom_dicts 中找不到名为 [${dictName}] 的词典数据！当前全局拥有的词典列表:`,
      Object.keys(globalSettings.custom_dicts),
    );
    return false;
  }

  // 确保 words 数组存在
  if (!dictData.words) dictData.words = [];

  let isChanged = false;
  console.log(
    `🔍 [Debug] 目标词典 [${dictName}] 现存词条数: ${dictData.words.length}`,
  );

  // 4. 遍历更新
  dictUpdates.forEach((update) => {
    const indexWord = (update.index || "").trim();
    const newTriggersStr = (update.trigger || "").trim();

    if (!indexWord) {
      console.log(`⚠️ [Debug] 跳过: 发现 index 为空的非法数据`, update);
      return;
    }

    const existingWord = dictData.words.find((w) => w.index === indexWord);

    if (existingWord) {
      const existingTriggers = (existingWord.trigger || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const newTriggers = newTriggersStr
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      const mergedTriggers = [
        ...new Set([...existingTriggers, ...newTriggers]),
      ];
      const mergedStr = mergedTriggers.join(", ");

      if (existingWord.trigger !== mergedStr) {
        console.log(
          `✅ [Debug] 准备更新词条: [${indexWord}] 的触发词从 "${existingWord.trigger}" 变为 "${mergedStr}"`,
        );
        existingWord.trigger = mergedStr;
        isChanged = true;
      } else {
        console.log(
          `⏸️ [Debug] 无需更新: [${indexWord}] 触发词已完全包含，无新内容`,
        );
      }
    } else {
      console.log(
        `✅ [Debug] 准备新增词条: [${indexWord}] 触发词: "${newTriggersStr}"`,
      );
      dictData.words.push({ trigger: newTriggersStr, index: indexWord });
      isChanged = true;
    }
  });

  if (isChanged) {
    console.log("💾 [Debug] 内存数据已修改，正在标脏关联库并固化...");

    // 🟢 接入我们的标脏核心！这让 LLM 修改和点击 UI 按钮的效果完全一致
    markRelatedLibsDirty(dictName);

    context.saveSettingsDebounced();

    // ✨✨ 新增：无缝刷新前端 UI 面板 ✨✨
    // 只有当用户确实停留在 BM25 页面，且正在查看的词典就是刚才被更新的词典时，才触发刷新
    if (typeof $ !== "undefined" && $("#bm25_dict_select").length > 0) {
      if ($("#bm25_dict_select").val() === dictName) {
        console.log(
          `🔄 [Debug] 触发 UI 刷新，重载词典 [${dictName}] 的最新数据`,
        );
        // 触发下拉框的 change 事件，这会调用你原本写好的读取内存、更新草稿箱并渲染列表的逻辑
        $("#bm25_dict_select").trigger("change");

        // 可选：稍微延迟一下，把列表滚动到底部，方便用户第一眼就看到新加进去的词条
        setTimeout(() => {
          const listDiv = $("#bm25_words_list")[0];
          if (listDiv) listDiv.scrollTop = listDiv.scrollHeight;
        }, 100);
      }
    }

    return true;
  }

  console.log("⏸️ [Debug] 遍历完毕，所有词条均已存在，未发生任何实际变更");
  return false;
}

/**
 * 触发一次全量 BM25 后台重构
 */
export async function triggerFullBm25Rebuild(silent = false) {
  const context = SillyTavern.getContext();
  const globalSettings =
    context.extensionSettings?.anima_memory_system?.bm25 || {};
  if (!globalSettings.auto_build) return;

  console.log(`[Anima BM25] 🔄 检测到需要重构，开始后台扫荡任务...`);
  let chatSuccessCount = 0;
  let kbSuccessCount = 0;
  const currentLibName = getCurrentBm25LibName();

  try {
    await markAllBm25Unsynced(); // 洗白当前世界书的切片状态

    // 1. 扫荡并重构所有【聊天库】
    if (globalSettings.dict_mapping) {
      const dirtyChatLibs = Object.entries(globalSettings.dict_mapping).filter(
        ([libName, mapInfo]) =>
          mapInfo.dirty === true && !libName.startsWith("kb_"),
      );

      for (const [libName, mapInfo] of dirtyChatLibs) {
        try {
          const res = await $.ajax({
            url: "/api/plugins/anima-rag/bm25/rebuild_collection",
            type: "POST",
            contentType: "application/json",
            data: JSON.stringify({
              collectionId: libName,
              bm25Config: getBm25BackendConfig(mapInfo.dict),
            }),
            dataType: "json",
          });

          if (res.success) {
            globalSettings.dict_mapping[libName].dirty = false;
            chatSuccessCount++;
            if (libName === currentLibName) {
              // 当前聊天库顺手洗白切片
              const data = await getBm25SyncList();
              const idsToMark = (data.list || []).map((item) => item.unique_id);
              if (idsToMark.length > 0) await markAllBm25SyncedBatch(idsToMark);
            }
          }
        } catch (err) {
          console.error(`[Anima BM25] 自动重构聊天库 ${libName} 失败`, err);
        }
      }
    }

    // 2. 扫荡并重构所有【知识库】
    const kbSettings = context.extensionSettings?.anima_memory_system?.kb;
    if (kbSettings && kbSettings.dict_mapping) {
      const dirtyKbs = Object.entries(kbSettings.dict_mapping).filter(
        ([kbName, mapInfo]) =>
          typeof mapInfo === "object" && mapInfo.dirty === true,
      );

      for (const [kbName, mapInfo] of dirtyKbs) {
        try {
          const dictContent =
            globalSettings.custom_dicts[mapInfo.dict]?.words || [];
          const resKb = await $.ajax({
            url: "/api/plugins/anima-rag/bm25/rebuild_collection",
            type: "POST",
            contentType: "application/json",
            data: JSON.stringify({
              collectionId: kbName,
              bm25Config: { enabled: true, dictionary: dictContent },
            }),
            dataType: "json",
          });

          if (resKb.success) {
            kbSettings.dict_mapping[kbName].dirty = false;
            kbSuccessCount++;
          }
        } catch (err) {
          console.error(`[Anima KB] 自动重构知识库 ${kbName} 失败`, err);
        }
      }
    }

    context.saveSettingsDebounced();
    if (
      !silent &&
      window.toastr &&
      (chatSuccessCount > 0 || kbSuccessCount > 0)
    ) {
      toastr.success(
        `后台同步完成！重构了 ${chatSuccessCount} 个聊天库和 ${kbSuccessCount} 个知识库。`,
        "BM25 引擎",
      );
    }
  } catch (e) {
    console.error("[Anima BM25] 全量重构后台任务异常:", e);
  }
}

/**
 * 🟢 新增工具：将所有关联了某个词典的聊天库和知识库打上“脏标记”
 */
export function markRelatedLibsDirty(dictName) {
  const context = SillyTavern.getContext();
  const globalSettings =
    context.extensionSettings?.anima_memory_system?.bm25 || {};

  // 标记聊天库
  if (globalSettings.dict_mapping) {
    for (const [libName, mapInfo] of Object.entries(
      globalSettings.dict_mapping,
    )) {
      if (mapInfo.dict === dictName) mapInfo.dirty = true;
    }
  }

  // 标记知识库 (KB)
  const kbSettings = context.extensionSettings?.anima_memory_system?.kb;
  if (kbSettings && kbSettings.dict_mapping) {
    for (const [kbName, mapInfo] of Object.entries(kbSettings.dict_mapping)) {
      const kbDictName =
        typeof mapInfo === "object" && mapInfo !== null
          ? mapInfo.dict
          : mapInfo;
      if (kbDictName === dictName) {
        kbSettings.dict_mapping[kbName] = { dict: dictName, dirty: true };
      }
    }
  }
}

/**
 * 🟢 新增：提取供 UI 按钮共用的保存与重构逻辑
 */
export async function saveDictionaryAndRebuild(
  dictName,
  cleanWords,
  bindToChar = false,
) {
  const context = SillyTavern.getContext();
  const globalSettings =
    context.extensionSettings?.anima_memory_system?.bm25 || {};
  if (!globalSettings.custom_dicts) globalSettings.custom_dicts = {};

  const oldWords = globalSettings.custom_dicts[dictName]?.words || [];
  const isContentChanged =
    JSON.stringify(oldWords) !== JSON.stringify(cleanWords);

  // 1. 覆盖字典数据
  globalSettings.custom_dicts[dictName] = { words: cleanWords };
  globalSettings.current_dict = dictName;

  // 2. 如果内容变了，全员标脏
  if (isContentChanged) markRelatedLibsDirty(dictName);

  let isDictSwitched = false;
  const currentLibName = getCurrentBm25LibName();

  // 3. 处理强绑定角色逻辑
  if (bindToChar) {
    if (context.characterId !== undefined) {
      const charSettings =
        context.characters[context.characterId]?.data?.extensions
          ?.anima_bm25_settings || {};
      charSettings.bound_dict = dictName;
      await context.writeExtensionField(
        context.characterId,
        "anima_bm25_settings",
        charSettings,
      );

      if (!globalSettings.dict_mapping) globalSettings.dict_mapping = {};
      const oldBoundDict = globalSettings.dict_mapping[currentLibName]?.dict;
      isDictSwitched = oldBoundDict !== dictName;

      if (isContentChanged || isDictSwitched) {
        globalSettings.dict_mapping[currentLibName] = {
          dict: dictName,
          dirty: true,
        };
      } else if (!globalSettings.dict_mapping[currentLibName]) {
        globalSettings.dict_mapping[currentLibName] = {
          dict: dictName,
          dirty: false,
        };
      }
    } else {
      if (window.toastr) toastr.warning("未选中任何角色！仅保存了词典。");
    }
  }

  context.saveSettingsDebounced();
  const needRebuild = isContentChanged || isDictSwitched;

  // 4. 执行重构
  if (!globalSettings.auto_build) {
    return { rebuilt: false, reason: "auto_build_off", isContentChanged };
  }

  if (needRebuild) {
    if (window.toastr)
      toastr.info("正在后台同步重构相关 BM25 库...", "BM25 引擎");
    await triggerFullBm25Rebuild(true); // 使用静默模式触发
    return { rebuilt: true };
  }

  return { rebuilt: false, reason: "no_change", isContentChanged };
}
