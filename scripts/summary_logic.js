import { generateText } from "./api.js";
import {
  saveSummaryBatchToWorldbook,
  getIndexConflictInfo,
  getPreviousSummaries,
  getLatestSummaryInfo,
} from "./worldbook_api.js";
import {
  applyRegexRules,
  extractJsonResult,
  processMacros,
  getContextData,
} from "./utils.js";

export const MODULE_NAME = "anima_memory_system";
let isSummarizing = false;
const DEFAULT_GLOBAL_SETTINGS = Object.freeze({
  regex_strings: [],
  output_regex: [],
  skip_layer_zero: true,
  regex_skip_user: true,
  wrapper_template: "<{{index}}>{{summary}}</{{index}}>",
  group_size: 10,
  summary_messages: [
    {
      type: "char_info",
      role: "system",
      enabled: true,
    },
    {
      type: "user_info",
      role: "system",
      enabled: true,
    },
    { type: "prev_summaries", role: "system", count: 0 },
    {
      role: "system",
      content: "建议放置破限内容",
    },
    { role: "user", content: "{{context}}" },
    {
      role: "user",
      content: "建议放置总结的要求，如字数、格式等",
    },
  ],
});

const DEFAULT_LOCAL_SETTINGS = Object.freeze({
  trigger_interval: 30,
  hide_skip_count: 5,
  auto_run: false,
  exclude_user: false, // 是否排除用户内容，这通常取决于特定扮演场景
});

export function getSummarySettings() {
  const context = SillyTavern.getContext();
  const { extensionSettings } = context;

  // -------------------------------------------------
  // 第一步：获取全局配置 (Extension Settings)
  // -------------------------------------------------
  if (!extensionSettings[MODULE_NAME]) extensionSettings[MODULE_NAME] = {};

  // 初始化全局配置
  if (!extensionSettings[MODULE_NAME].summary) {
    extensionSettings[MODULE_NAME].summary = structuredClone(
      DEFAULT_GLOBAL_SETTINGS,
    );
  }
  const globalSettings = extensionSettings[MODULE_NAME].summary;

  // 补全全局配置中缺失的键 (防止旧版配置缺少新字段)
  for (const key of Object.keys(DEFAULT_GLOBAL_SETTINGS)) {
    if (!Object.hasOwn(globalSettings, key)) {
      globalSettings[key] = DEFAULT_GLOBAL_SETTINGS[key];
    }
  }

  // --- 保留原来的兼容性检查逻辑 (检查 summary_messages) ---
  if (Array.isArray(globalSettings.summary_messages)) {
    const hasChar = globalSettings.summary_messages.some(
      (m) => m.type === "char_info",
    );
    const hasUser = globalSettings.summary_messages.some(
      (m) => m.type === "user_info",
    );

    if (!hasUser) {
      globalSettings.summary_messages.unshift({
        type: "user_info",
        role: "system",
        enabled: true,
      });
    }
    if (!hasChar) {
      globalSettings.summary_messages.unshift({
        type: "char_info",
        role: "system",
        enabled: true,
      });
    }

    const hasPrev = globalSettings.summary_messages.some(
      (m) => m.type === "prev_summaries",
    );
    if (!hasPrev) {
      // 插入到 index 2 (即在 User Info 之后)
      globalSettings.summary_messages.splice(2, 0, {
        type: "prev_summaries",
        role: "system",
        count: 0,
      });
    }
  }

  // -------------------------------------------------
  // 第二步：获取本地配置 (Chat Metadata)
  // -------------------------------------------------
  let localSettings = {};

  if (context.chatId && context.chatMetadata) {
    // 尝试读取 metadata 中的 'anima_config'
    const metaConfig = context.chatMetadata["anima_config"];

    if (metaConfig) {
      localSettings = metaConfig;
    } else {
      // 如果是新聊天或从未保存过，使用默认本地配置
      localSettings = structuredClone(DEFAULT_LOCAL_SETTINGS);
    }
  } else {
    // 如果没有加载任何聊天，也返回默认值
    localSettings = structuredClone(DEFAULT_LOCAL_SETTINGS);
  }

  // 补全本地配置中可能缺失的键 (防止旧 Metadata 报错)
  for (const key of Object.keys(DEFAULT_LOCAL_SETTINGS)) {
    if (!Object.hasOwn(localSettings, key)) {
      localSettings[key] = DEFAULT_LOCAL_SETTINGS[key];
    }
  }

  // -------------------------------------------------
  // 第三步：合并返回
  // -------------------------------------------------
  // 将两者合并，对外部看来，这依然是一个完整的设置对象
  return { ...globalSettings, ...localSettings };
}

export function saveSummarySettings(newSettings) {
  const context = SillyTavern.getContext();
  const { extensionSettings, saveSettingsDebounced } = context;

  // === 1. 提取并保存全局设置 ===
  const globalToSave = {};
  // 遍历默认全局键，从 newSettings 中提取对应的值
  for (const key of Object.keys(DEFAULT_GLOBAL_SETTINGS)) {
    if (Object.hasOwn(newSettings, key)) {
      globalToSave[key] = newSettings[key];
    }
  }

  if (!extensionSettings[MODULE_NAME]) extensionSettings[MODULE_NAME] = {};
  extensionSettings[MODULE_NAME].summary = globalToSave;
  saveSettingsDebounced(); // 保存全局 settings.json

  // === 2. 提取并保存本地设置 (到 Metadata) ===
  if (context.chatId && context.chatMetadata) {
    const localToSave = {};
    // 遍历默认本地键
    for (const key of Object.keys(DEFAULT_LOCAL_SETTINGS)) {
      if (Object.hasOwn(newSettings, key)) {
        localToSave[key] = newSettings[key];
      }
    }

    // 写入 Metadata
    context.chatMetadata["anima_config"] = localToSave;

    // 立即保存 Metadata (因为自动化状态改变很重要，不建议 debounce)
    context.saveMetadata().then(() => {
      console.log(
        "[Anima] Settings saved. (Global -> Settings, Automation -> Metadata)",
      );
    });
  } else {
    console.warn("[Anima] Saved global settings only (No chat loaded).");
  }
}

/**
 * 核心逻辑修正：
 * 1. 若开启 exclude_user，则完全忽略 User 消息。
 * 2. 若开启 regex_skip_user，User 消息将保留“原始内容” (不经过正则清洗)。
 * 3. 否则，User 消息也会执行正则提取。
 * 4. 第 0 层 (开场白) 强制保留原文。
 */
export function processMessagesWithRegex(messages, settings) {
  // 🟢 1. 获取新设置 regex_skip_user
  const { exclude_user, regex_strings, skip_layer_zero, regex_skip_user } =
    settings;

  let resultArray = [];
  // processMacros 内部会处理名字，这里仅用于日志
  // const { charName, userName } = getContextData();

  console.groupCollapsed("Anima Preprocess Log");

  messages.forEach((msg, idx) => {
    const isUser = msg.is_user === true || msg.role === "user";
    const role = isUser ? "user" : "assistant";
    const msgId = msg.message_id !== undefined ? msg.message_id : -1;
    const logPrefix = `[#${msgId}] ${msg.name} (${role}):`;

    // 1. 彻底排除 User (最高优先级)
    if (exclude_user && isUser) {
      console.log(`${logPrefix} -> 排除 (User Excluded)`);
      return;
    }

    const rawContent = msg.message || "";
    // 先处理宏 ({{char}} -> 名字)
    let contentWithNames = processMacros(rawContent);

    let finalContent = contentWithNames;
    let isSkippedRegex = false; // 标记是否跳过了正则

    // 2. 特殊处理：第 0 层 (开场白) 豁免正则
    if (msgId === 0 && skip_layer_zero) {
      console.log(`${logPrefix} -> 保留原文 (Layer 0 Protected)`);
      isSkippedRegex = true; // Layer 0 也可以视作 RAW
    }
    // 🟢 3. User 消息处理逻辑 (受开关控制)
    else if (isUser) {
      if (regex_skip_user) {
        // 开关开启：跳过正则
        console.log(`${logPrefix} -> 保留原文 (User Raw - Skipped by Setting)`);
        isSkippedRegex = true;
      } else {
        // 开关关闭：执行正则
        finalContent = applyRegexRules(contentWithNames, regex_strings);
        if (finalContent !== contentWithNames) {
          console.log(`${logPrefix} -> 正则清洗完成 (User)`);
        }
      }
    }
    // 4. Assistant 消息 (始终执行正则)
    else {
      finalContent = applyRegexRules(contentWithNames, regex_strings);
      if (finalContent !== contentWithNames) {
        console.log(`${logPrefix} -> 正则清洗完成`);
      }
    }

    // 5. 存入结果 (去除空内容)
    if (finalContent && finalContent.trim()) {
      resultArray.push({
        role: role,
        content: finalContent.trim(),
        // 🟢 新增：传递给 UI 预览使用，用于显示 [RAW] 标签
        skippedRegex: isSkippedRegex,
      });
    }
  });

  console.groupEnd();
  return resultArray;
}

// 在 summary_logic.js 中替换原有的 requestSummaryFromAPI

export async function requestSummaryFromAPI(
  settings,
  contextMsgArray,
  currentTaskIndex = null,
) {
  const { charName, charDesc, userName, userPersona } = getContextData();
  const lastIdx = getLastSummarizedIndex();
  const effectiveIndex =
    currentTaskIndex !== null ? currentTaskIndex : lastIdx + 1;

  // 1. 临时数组，用于按顺序收集所有生成的原始片段 (暂不合并)
  let rawSegments = [];

  for (const item of settings.summary_messages) {
    // === A. 跳过未启用的条目 ===
    // 注意：prev_summaries 没有 enabled 字段，靠 count 判断，所以单独处理
    if (
      (item.type === "char_info" || item.type === "user_info") &&
      item.enabled === false
    ) {
      continue;
    }

    // === B. 处理角色卡信息 ===
    if (item.type === "char_info") {
      const content = `[Character Description of ${charName}]:\n${processMacros(charDesc)}`;
      rawSegments.push({ role: item.role, content: content });
      continue;
    }

    // === C. 处理用户信息 ===
    if (item.type === "user_info") {
      const content = `[User Persona of ${userName}]:\n${processMacros(userPersona)}`;
      rawSegments.push({ role: item.role, content: content });
      continue;
    }

    // === D. 处理前文总结 ===
    if (item.type === "prev_summaries") {
      const count = parseInt(item.count) || 0;
      if (count > 0) {
        const prevText = await getPreviousSummaries(effectiveIndex, count);
        if (prevText) {
          // 这里的 item.role 默认是 system，如果在 UI 开放了修改，这里会自动生效
          rawSegments.push({ role: item.role, content: prevText });
        }
      }
      continue;
    }

    // === E. 处理待总结的历史记录 {{context}} ===
    if (item.content.includes("{{context}}")) {
      if (contextMsgArray && contextMsgArray.length > 0) {
        const mergedContextStr = contextMsgArray
          .map((msg) => {
            // 依然保持内部的前缀区分
            const prefix =
              msg.role === "user" ? `${userName}: ` : "assistant: ";
            return `${prefix}${msg.content}`;
          })
          .join("\n");

        // 这里通常建议保持为 user，但如果你想让用户自定义 context 的 role，
        // 可以将下方的 "user" 改为 item.role
        rawSegments.push({
          role: "user",
          content: mergedContextStr,
        });
      }
      continue;
    }

    // === F. 普通文本条目 ===
    // 处理 {{user}}, {{char}} 等宏
    rawSegments.push({
      role: item.role,
      content: processMacros(item.content),
    });
  }

  // 2. 最终合并逻辑 (Merging Logic)
  if (rawSegments.length === 0) return null;

  let finalMessages = [];
  // 先放入第一条
  finalMessages.push(rawSegments[0]);

  // 从第二条开始遍历
  for (let i = 1; i < rawSegments.length; i++) {
    const current = rawSegments[i];
    const prev = finalMessages[finalMessages.length - 1];

    // ✨ 核心修改：如果 Role 相同，则合并内容
    if (current.role === prev.role) {
      // 使用换行符分隔
      prev.content += "\n\n" + current.content;
    } else {
      // Role 不同，推入新消息
      finalMessages.push(current);
    }
  }

  console.log("[Anima] Merged Messages for API:", finalMessages);

  return await generateText(finalMessages, "llm");
}

function getMetaKeyId() {
  return "anima_last_summarized_id";
}

function getMetaKeyIndex() {
  return "anima_last_summarized_index";
}

export function getLastSummarizedId() {
  const context = SillyTavern.getContext();
  if (!context || !context.chatMetadata) return -1;
  return context.chatMetadata[getMetaKeyId()] ?? -1;
}

export function getLastSummarizedIndex() {
  const context = SillyTavern.getContext();
  if (!context || !context.chatMetadata) return 0;
  return context.chatMetadata[getMetaKeyIndex()] ?? 0;
}

// summary_logic.js

export async function saveSummaryProgress(id, index) {
  const context = SillyTavern.getContext();
  if (context) {
    context.chatMetadata[getMetaKeyId()] = id;
    context.chatMetadata[getMetaKeyIndex()] = index;
    await context.saveMetadata();
    console.log(`[Anima] Progress Updated: ID=${id}, Index=${index}`);
    const event = new CustomEvent("anima_progress_updated");
    document.dispatchEvent(event);
  }
}

export async function handlePostSummary(
  startId,
  endId,
  index,
  settings,
  lockedChatId = null,
) {
  const currentContextId = SillyTavern.getContext().chatId;
  if (lockedChatId && currentContextId !== lockedChatId) {
    console.log(
      `[Anima] 窗口已切换 (Target: ${lockedChatId}, Current: ${currentContextId})。跳过 Metadata 更新与隐藏楼层。`,
    );
    // 直接返回，什么都不做。等用户下次切回来时，由自动同步逻辑处理。
    return;
  }
  // 1. 修改隐藏逻辑：强制从 0 开始隐藏
  const keepCount = settings.hide_skip_count;
  // 计算需要隐藏到的截止 ID
  const hideEndId = endId - keepCount;

  // 只要截止 ID >= 0，就执行隐藏 (不管 startId 是多少)
  if (hideEndId >= 0) {
    // ✨ 修改点： range 从 "0" 开始，而不是 startId
    // 使用 ST 的字符串范围语法 "0-15" 比循环 push 性能更好，但也可用你原有的 setChatMessages 数组方式
    // 这里为了兼容你原有的 setChatMessages 逻辑，我们构造从 0 到 hideEndId 的数组
    const updates = [];
    for (let i = 0; i <= hideEndId; i++) {
      updates.push({ message_id: i, is_hidden: true });
    }
    await window.TavernHelper.setChatMessages(updates, {
      refresh: "affected",
    });
  }

  // 2. ✅ 修改逻辑：棘轮机制 (Ratchet Mechanism)
  // 只有当新的 endId 大于当前记录的进度时，才更新指针。
  // 这允许用户手动补全旧内容的总结（0-50楼），而不打乱当前的最新进度（200楼）。
  const currentLastId = getLastSummarizedId();
  if (endId > currentLastId) {
    await saveSummaryProgress(endId, index);
  } else {
    console.log(
      `[Anima] Manual fill detected (End ${endId} <= Current ${currentLastId}). Metadata NOT updated.`,
    );
  }
}

/**
 * 获取或初始化叙事时间 (Narrative Time)
 * 优先读取 chatMetadata，如果不存在则解析文件名并写入 metadata，确保时间戳恒定。
 */
export async function getOrInitNarrativeTime() {
  const context = SillyTavern.getContext();
  if (!context) return Date.now();

  const chatId = context.chatId;
  const metadata = context.chatMetadata;

  // 1. 优先检查 Metadata 中是否已存在
  if (metadata && metadata.anima_narrative_time) {
    // console.log("[Anima] 使用 Metadata 中的 Narrative Time:", new Date(metadata.anima_narrative_time).toLocaleString());
    return metadata.anima_narrative_time;
  }

  // 2. 如果不存在，解析文件名 (你的原始逻辑)
  let finalTime = Date.now();
  if (chatId) {
    const name = chatId.replace(/\.(json|jsonl)$/i, "");
    // 尝试匹配常见格式: Role - YYYY-MM-DD @HHh MMm SSs MSms
    const match = name.match(
      /@\s*(\d{1,2})h\s*(\d{1,2})m\s*(\d{1,2})s(\s*(\d{1,3})ms)?/,
    );

    if (match) {
      const dateMatch = name.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
      const year = dateMatch ? parseInt(dateMatch[1]) : 1970;
      const month = dateMatch ? parseInt(dateMatch[2]) - 1 : 0;
      const day = dateMatch ? parseInt(dateMatch[3]) : 1;

      const h = parseInt(match[1]);
      const m = parseInt(match[2]);
      const s = parseInt(match[3]);
      const ms = parseInt(match[4]);

      finalTime = new Date(year, month, day, h, m, s, ms).getTime();
      console.log(
        "[Anima] 从文件名解析时间成功:",
        new Date(finalTime).toLocaleString(),
      );
    } else {
      console.warn("[Anima] 文件名时间解析失败，使用当前时间作为锚点");
    }
  }

  // 3. 关键：将确定的时间写入 Metadata (持久化)
  if (context.chatMetadata) {
    context.chatMetadata.anima_narrative_time = finalTime;
    await context.saveMetadata();
    console.log("[Anima] Narrative Time 已固化到 Metadata");
  }

  return finalTime;
}

/**
 * 执行总结核心任务
 */
export async function runSummarizationTask({
  force = false,
  customRange = null,
  manualIndex = null,
} = {}) {
  const settings = getSummarySettings();

  // 🛑 1. 门卫检查
  if (isSummarizing) {
    console.log("[Anima] Task skipped: Summarization already in progress.");
    return;
  }

  // 🛑 2. 配置检查
  if (!force && !settings.auto_run) return;

  // 🔒 3. 锁定 Chat ID (关键：防止切窗后 ID 变化)
  const currentChatId = SillyTavern.getContext().chatId;
  if (!currentChatId) return;

  // 🔒 4. 上锁
  isSummarizing = true;

  try {
    // =======================================================
    // ✨✨✨ [新增逻辑] 阶段 A：基于世界书的自动同步 ✨✨✨
    // 作用：处理“用户切走窗口又切回来”的情况。
    // 检查硬盘里的世界书进度是否比当前的 Metadata 进度更新。
    // =======================================================
    if (!customRange) {
      // 1. 获取当前 Metadata 记录的 ID
      const currentMetaId = getLastSummarizedId();

      // 2. 读取世界书里的最新进度 (使用 currentChatId 确保读对文件)
      // 注意：请确保文件头已 import { getLatestSummaryInfo } from "./worldbook_api.js"
      const wbInfo = await getLatestSummaryInfo(currentChatId);

      // 3. 如果世界书 (wbInfo) 比 Metadata (currentMetaId) 更新
      if (wbInfo && wbInfo.maxEndId > currentMetaId) {
        console.log(
          `[Anima] 🔄 同步检测: 世界书进度 (#${wbInfo.maxBatchId}, End:${wbInfo.maxEndId}) 领先于 Metadata (${currentMetaId})。正在补齐 UI...`,
        );

        // A. 更新 Metadata 指针
        await saveSummaryProgress(wbInfo.maxEndId, wbInfo.maxBatchId);

        // B. 执行 UI 补发隐藏
        // 注意：这里不传 currentChatId，因为现在肯定是在当前窗口，必须强制执行 UI 更新
        await handlePostSummary(
          0,
          wbInfo.maxEndId,
          wbInfo.maxBatchId,
          settings,
          // 这里的 lockedChatId 留空/null，表示强制执行 UI 更新
        );

        if (window.toastr)
          toastr.info(`Anima: 进度已从世界书同步至 #${wbInfo.maxBatchId}`);
      }
    }

    // =======================================================
    // 📜 [原有逻辑] 阶段 B：基于隐藏消息的自动同步 (兜底) 📜
    // 作用：处理首次运行或 Metadata 丢失但有隐藏消息的情况。
    // (保持你的代码原样，未做删减)
    // =======================================================
    let lastSummarizedId = getLastSummarizedId();
    if (lastSummarizedId === -1 && !customRange) {
      try {
        const hiddenMsgs = window.TavernHelper.getChatMessages(
          "0-{{lastMessageId}}",
          { hide_state: "hidden", include_swipes: false },
        );
        if (hiddenMsgs && hiddenMsgs.length > 0) {
          const maxHiddenId = hiddenMsgs[hiddenMsgs.length - 1].message_id;
          const interval = Math.max(1, settings.trigger_interval);
          const reservedIndex = Math.ceil(maxHiddenId / interval);

          console.log(
            `[Anima] Auto-Sync (Legacy): Detected hidden messages up to ${maxHiddenId}. Syncing pointer...`,
          );

          await saveSummaryProgress(maxHiddenId, reservedIndex);
          // 更新局部变量，确保下方循环能读到最新值
          lastSummarizedId = maxHiddenId;

          if (window.toastr)
            toastr.info(
              `Anima: 已自动同步进度至 #${reservedIndex} (楼层 ${maxHiddenId})`,
            );
        }
      } catch (e) {
        console.error("[Anima] Auto-Sync check failed:", e);
      }
    }

    // =======================================================
    // 🔄 [原有逻辑] 阶段 C：循环追赶逻辑 🔄
    // =======================================================
    let keepRunning = true;

    while (keepRunning) {
      // A. 每次循环开头，重新读取最新的进度
      lastSummarizedId = getLastSummarizedId();

      let startId, targetEndId, finalIndex;

      // B. 计算本轮目标
      if (customRange) {
        // --- 手动模式 ---
        startId = customRange.start;
        targetEndId = customRange.end;
        finalIndex =
          manualIndex !== null && !isNaN(manualIndex)
            ? manualIndex
            : getLastSummarizedIndex() + 1;
        keepRunning = false;
      } else {
        // --- 自动模式 ---
        let lastMsgArray;
        try {
          lastMsgArray = window.TavernHelper.getChatMessages(-1);
        } catch (e) {}

        if (!lastMsgArray || !lastMsgArray.length) {
          keepRunning = false;
          break;
        }

        const latestMsg = lastMsgArray[0];
        const latestId = latestMsg.message_id;
        const interval = settings.trigger_interval;
        const calcTargetEndId = lastSummarizedId + interval;

        if (latestId < calcTargetEndId) {
          keepRunning = false;
          break;
        }

        if (latestId === calcTargetEndId) {
          const isUser = latestMsg.is_user || latestMsg.role === "user";
          if (!isUser) {
            console.log(
              `[Anima] 挂起: 等待 User 发言确认 (Current #${latestId})`,
            );
            keepRunning = false;
            break;
          }
        }

        startId = lastSummarizedId + 1;
        targetEndId = calcTargetEndId;
        finalIndex = getLastSummarizedIndex() + 1;
      }

      // C. 冲突检测
      if (force && customRange) {
        const conflict = await getIndexConflictInfo(finalIndex);
        if (conflict) {
          const confirmMsg = `⚠️ 序号 [#${finalIndex}] 已存在于世界书条目 [${conflict.entryName}] 中。\n如果继续，将会覆盖原总结的内容，是否继续？`;
          if (!confirm(confirmMsg)) return;
        }
      }

      if (window.toastr) {
        toastr.info(
          `Anima: 正在总结 #${finalIndex} (楼层 ${startId}-${targetEndId})...`,
        );
      }

      // D. 获取消息
      const msgs = window.TavernHelper.getChatMessages(
        `${startId}-${targetEndId}`,
        { include_swipes: false },
      );

      if (!msgs || !msgs.length) {
        keepRunning = false;
        break;
      }

      const contextMsgArray = processMessagesWithRegex(msgs, settings);

      // E. 正则过滤为空时的处理
      if (!contextMsgArray || contextMsgArray.length === 0) {
        console.log(
          `[Anima] Range ${startId}-${targetEndId} empty after regex. Skipping API.`,
        );
        // 🟢 这里也要传入 currentChatId 吗？
        // 建议传入，虽然是跳过API，但如果用户切走了，我们也不希望乱改 UI
        await handlePostSummary(
          startId,
          targetEndId,
          finalIndex,
          settings,
          currentChatId, // <--- 传入锁定的 ID
        );
        continue;
      }

      let summaryBatch = [];

      // F. API 请求
      const rawResult = await requestSummaryFromAPI(
        settings,
        contextMsgArray,
        finalIndex,
      );
      if (!rawResult) throw new Error("API 返回为空");

      console.log("[Anima] Raw Model Output:", rawResult);

      // 1. 尝试提取 JSON
      let parsedResult = extractJsonResult(rawResult);
      // ✨ 修改点 A：兼容单个对象 { ... }
      // 如果解析出来是对象，但不是数组，说明模型只输出了单条 JSON。
      // 我们手动把它包一层数组，变成 [ { ... } ]，以便复用下方的数组遍历逻辑。
      if (
        parsedResult &&
        typeof parsedResult === "object" &&
        !Array.isArray(parsedResult)
      ) {
        console.log(
          "[Anima] Detected single JSON object, converting to array.",
        );
        parsedResult = [parsedResult];
      }

      // 2. 校验逻辑 (此时无论是数组还是单对象，都已统一为数组格式)
      if (
        parsedResult &&
        Array.isArray(parsedResult) &&
        parsedResult.length > 0
      ) {
        summaryBatch = parsedResult.map((item) => {
          const content = item.summary || item.content || item.text || "";
          let tags = [];
          const rawTags = item.tags || item.tag;

          if (Array.isArray(rawTags)) {
            tags = rawTags;
          }
          // ✨ 修改点 B：方案 C (通用标签读取)
          else if (typeof rawTags === "object") {
            Object.entries(rawTags).forEach(([key, val]) => {
              if (Array.isArray(val)) {
                tags = tags.concat(val);
              } else if (typeof val === "string") {
                tags.push(val);
              } else if (typeof val === "boolean" && val === true) {
                // 将 key 首字母大写作为标签 (如 "important": true -> "Important")
                tags.push(key.charAt(0).toUpperCase() + key.slice(1));
              }
            });
          } else if (typeof rawTags === "string") {
            tags = [rawTags];
          }

          return {
            content: content,
            tags: [...new Set(tags)].filter((t) => t),
          };
        });
      } else {
        // (保持原有的纯文本兜底逻辑不变)
        let finalContent = rawResult;
        if (settings.output_regex && settings.output_regex.length > 0) {
          finalContent = applyRegexRules(rawResult, settings.output_regex);
        }
        summaryBatch.push({
          content: finalContent,
          tags: [],
        });
      }

      summaryBatch = summaryBatch.filter(
        (s) => s.content && s.content.trim() !== "",
      );
      if (summaryBatch.length === 0)
        throw new Error("Parsed Summary Batch is Empty");

      // =======================================================
      // 🟢 修改点 1: 存入世界书，传入 currentChatId
      // =======================================================
      // 确保写入的是任务开始时锁定的那个聊天文件
      await saveSummaryBatchToWorldbook(
        summaryBatch,
        finalIndex,
        startId,
        targetEndId,
        settings,
        currentChatId, // <--- ✨✨✨ 传入锁定的 ID
      );

      // =======================================================
      // 🟢 修改点 2: 保存进度，传入 currentChatId
      // =======================================================
      // 如果用户切走了窗口，handlePostSummary 内部会拦截 UI 操作
      await handlePostSummary(
        startId,
        targetEndId,
        finalIndex,
        settings,
        currentChatId, // <--- ✨✨✨ 传入锁定的 ID
      );

      console.log(`[Anima] 批次 #${finalIndex} 完成。检查是否有更多待处理...`);

      if (window.toastr) {
        // 使用 success 样式表示成功，提示用户该序号已保存
        toastr.success(`Anima: 总结 #${finalIndex} 已成功存入世界书`);
      }

      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (err) {
    console.error("[Anima Error]", err);
    if (window.toastr) toastr.error("自动化总结出错，已停止: " + err.message);
  } finally {
    isSummarizing = false;
    console.log("[Anima] Task cycle finished. Lock released.");
  }
}
/**
 * 获取当前是否正在执行总结任务 (用于 UI 禁用按钮)
 */
export function getIsSummarizing() {
  return isSummarizing;
}
