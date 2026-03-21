import { queryDual, getEffectiveSettings } from "./rag_logic.js";
import {
  updateRagEntry,
  clearRagEntry,
  getLatestRecentSummaries,
  updateKnowledgeEntry,
  clearKnowledgeEntry,
} from "./worldbook_api.js";
import {
  applyRegexRules,
  getSmartCollectionId,
  processMacros,
} from "./utils.js";
import { clearLastRetrievalResult, getChatRagFiles } from "./rag.js";
import { getChatKbFiles } from "./db_api.js";
import { getBm25BackendConfig } from "./bm25_logic.js";
import { getKbSearchPayload } from "./knowledge.js";

/**
 * 🟢 [极简版] 将后端排好序的 Chat 结果拼接成文本
 */
function formatMergedChat(mergedList) {
  if (!mergedList || mergedList.length === 0) return "";
  return mergedList.map((item) => item.text).join("\n\n");
}

/**
 * 🟢 [极简版] 将后端排好序的 KB 结果拼接成文本
 */
function formatMergedKb(mergedList) {
  if (!mergedList || mergedList.length === 0) return "";

  let finalString = "";
  let currentDoc = "";

  mergedList.forEach((item) => {
    const docName = item.doc_name || "Unknown Document";
    if (docName !== currentDoc) {
      if (finalString !== "") finalString += "\n\n";
      finalString += `[Source: ${docName}]\n`;
      currentDoc = docName;
    } else {
      finalString += "\n...\n"; // 同一文件的不同切片用省略号隔开
    }
    finalString += item.text;
  });

  return finalString;
}

// ✨ 终极修复版：构建 RAG 查询
function constructRagQuery(chat, settings) {
  const promptConfig = settings.vector_prompt || [];
  let finalQueryParts = [];

  // 1. 获取底层最真实的聊天数组
  const nativeChat = SillyTavern.getContext().chat || chat || [];
  let allMsgs = [];

  try {
    if (window.TavernHelper && window.TavernHelper.getChatMessages) {
      const lastId = nativeChat.length > 0 ? nativeChat.length - 1 : 0;
      allMsgs =
        window.TavernHelper.getChatMessages(`0-${lastId}`, {
          include_swipes: false,
        }) || [];
    }
  } catch (e) {
    console.warn("[Anima] TavernHelper 提取失败，准备回退");
  }

  if (!allMsgs || allMsgs.length === 0) {
    allMsgs = nativeChat;
  }

  // 🔴 核心修复：必须先过滤掉系统隐藏消息和空消息，然后再切片！
  let filteredChat = allMsgs.filter((msg, idx) => {
    // 剔除纯系统消息 (防止截取到 Author's Note 等临时注入块)
    if (msg.is_system && !msg.role) return false;
    // 剔除开场白
    if (
      settings.skip_layer_zero &&
      (String(msg.message_id) === "0" || idx === 0)
    )
      return false;
    // 剔除当前正在生成/Swipe的空消息
    if (!msg.mes && !msg.message) return false;
    return true;
  });

  for (const item of promptConfig) {
    if (item.type === "context") {
      const count = parseInt(item.count) || 5;

      // A. 从【全是干货】的数组中安全截取最后 N 条
      const slicedChat = filteredChat.slice(-count);

      // B. 格式化 & 正则清洗
      const textBlock = slicedChat
        .map((msg) => {
          let content = msg.message || msg.mes;
          const isUser = msg.role === "user" || msg.is_user === true;

          const shouldApplyRegex = !(isUser && settings.regex_skip_user);
          if (
            shouldApplyRegex &&
            settings.regex_strings &&
            settings.regex_strings.length > 0
          ) {
            content = applyRegexRules(content, settings.regex_strings);
          }

          content = content?.trim();
          if (!content) return null;

          const rolePrefix = isUser ? "user" : "assistant";
          return `${rolePrefix}: ${content}`;
        })
        .filter((t) => t !== null)
        .join("\n");

      if (textBlock) {
        finalQueryParts.push(textBlock);
      }
    } else {
      if (item.content && item.content.trim()) {
        let textContent = item.content.trim();
        if (typeof processMacros === "function") {
          textContent = processMacros(textContent);
        }
        finalQueryParts.push(textContent);
      }
    }
  }

  return finalQueryParts.join("\n\n").trim();
}

// ✨ 终极修复版：构建 BM25 查询
async function constructBm25Query(chat, bm25Settings, ragSettings) {
  if (!bm25Settings || !bm25Settings.content_settings) return "";

  const cSettings = bm25Settings.content_settings;
  const isReuse = cSettings.reuse_rag_regex;

  const regexList = isReuse
    ? ragSettings.regex_strings || []
    : cSettings.regex_list || [];
  const skipZero = isReuse
    ? (ragSettings.skip_layer_zero ?? true)
    : (cSettings.skip_layer_zero ?? true);
  const skipUser = isReuse
    ? (ragSettings.regex_skip_user ?? false)
    : (cSettings.regex_skip_user ?? false);
  const excludeUser = isReuse ? false : (cSettings.exclude_user ?? false);

  let finalQueryParts = [];
  const promptConfig = cSettings.prompt_items || [];

  // 1. 获取底层最真实的聊天数组
  const nativeChat = SillyTavern.getContext().chat || chat || [];
  let allMsgs = [];

  try {
    if (window.TavernHelper && window.TavernHelper.getChatMessages) {
      const lastId = nativeChat.length > 0 ? nativeChat.length - 1 : 0;
      allMsgs =
        window.TavernHelper.getChatMessages(`0-${lastId}`, {
          include_swipes: false,
        }) || [];
    }
  } catch (e) {
    console.warn("[Anima] TavernHelper 提取失败，准备回退");
  }

  if (!allMsgs || allMsgs.length === 0) {
    allMsgs = nativeChat;
  }

  // 🔴 核心修复：提前过滤系统消息和空消息
  let filteredChat = allMsgs.filter((msg, idx) => {
    if (msg.is_system && !msg.role) return false;
    if (skipZero && (String(msg.message_id) === "0" || idx === 0)) return false;

    const isUser = msg.role === "user" || msg.is_user === true;
    if (excludeUser && isUser) return false;
    // 剔除正在生成的空消息
    if (!msg.mes && !msg.message) return false;
    return true;
  });

  for (const item of promptConfig) {
    if (item.id === "floor_content") {
      const count = parseInt(item.count) || 1;

      // 安全切片
      const slicedChat = filteredChat.slice(-count);
      let processedChat = [];

      slicedChat.forEach((msg) => {
        const isUser = msg.role === "user" || msg.is_user === true;
        let content = msg.message || msg.mes || "";

        if (typeof processMacros === "function") {
          content = processMacros(content);
        }

        const cleanRegex = /^[\s\r\n]*(&gt;|>)[\s\r\n]*/i;
        while (cleanRegex.test(content)) {
          content = content.replace(cleanRegex, "");
        }

        let shouldApplyRegex = true;
        if (skipUser && isUser) {
          shouldApplyRegex = false;
        }

        if (shouldApplyRegex && regexList && regexList.length > 0) {
          content = applyRegexRules(content, regexList);
        }

        content = content?.trim() || "";

        if (content) {
          processedChat.push(`${isUser ? "user" : "assistant"}: ${content}`);
        }
      });

      if (processedChat.length > 0)
        finalQueryParts.push(processedChat.join("\n"));
    } else if (item.type === "text") {
      if (item.content && item.content.trim()) {
        let textContent = item.content.trim();
        if (typeof processMacros === "function") {
          textContent = processMacros(textContent);
        }
        finalQueryParts.push(textContent);
      }
    }
  }
  return finalQueryParts.join("\n\n").trim();
}

export async function initInterceptor() {
  globalThis.Anima_RAG_Interceptor = async function (
    chat,
    contextSize,
    abort,
    type,
  ) {
    console.log(`[Anima Debug] Interceptor Called! Type: ${type}`);

    const allowedTypes = ["chat", "impersonate", "swipe", "normal"];
    if (type && !allowedTypes.includes(type)) {
      console.log(`[Anima Debug] 跳过非聊天类型: ${type}`);
      return;
    }

    const context = SillyTavern.getContext();
    const settings = getEffectiveSettings();

    if (settings.rag_enabled === false) {
      console.log("[Anima Debug] RAG 开关已关闭");
      return;
    }

    try {
      clearLastRetrievalResult();

      // 1. 生成向量检索词
      let vectorQueryText = constructRagQuery(chat, settings);

      // 2. 获取 BM25 全局配置并生成独立的 BM25 检索词
      const extensionSettings =
        SillyTavern.getContext().extensionSettings || {};
      const bm25Settings = extensionSettings.anima_memory_system?.bm25 || {};
      let bm25QueryText = await constructBm25Query(
        chat,
        bm25Settings,
        settings,
      );

      // 3. 只要两者有一个不为空就继续执行
      if (!vectorQueryText && !bm25QueryText) {
        console.log("[Anima] 检索文本全部为空，跳过");
        return;
      }
      console.log(
        `[Anima] 向量检索词 Length: ${vectorQueryText.length} | BM25检索词 Length: ${bm25QueryText.length}`,
      );

      // 检索词日志，Debug用
      console.log(
        `[Anima Debug 最终检索词快照]\n\n=== 向量 RAG 检索词 ===\n${vectorQueryText}\n\n=== BM25 检索词 ===\n${bm25QueryText}\n\n========================`,
      );

      const recentCount = settings.injection_settings?.recent_count || 2;
      let recentData = { text: "", ids: [] };

      if (recentCount > 0) {
        recentData = await getLatestRecentSummaries(recentCount);
      }

      // 🟢 1. 使用智能清洗 ID，确保和向量库名字完全一致
      const currentChatId = getSmartCollectionId();
      const extraChatFiles = getChatRagFiles() || [];

      // ✨ 核心修复：不再无脑读取所有文件，而是获取受开关严格控制的载荷
      const kbPayload = getKbSearchPayload();

      // 🟢 2. 构建 BM25 配置包供后端拦截使用
      // ✨ 将 kb 的 bm25 配置直接指向安全载荷
      const bm25Configs = {
        chat: [],
        kb: kbPayload.bm25ConfigsKb || [],
        chat_top_k: bm25Settings.search_top_k || 3,
      };
      const processedDbIds = new Set();

      // ✨ 获取全局的库到词典的映射表
      const dictMapping = bm25Settings.dict_mapping || {};

      // ✨ 核心修复：先查映射，找到真正绑定的词典名称，再获取 Config
      const currentDictName =
        dictMapping[currentChatId]?.dict ||
        bm25Settings.current_dict ||
        "default_dict";
      const chatBm25Config = getBm25BackendConfig(currentDictName);

      if (chatBm25Config.enabled && currentChatId) {
        bm25Configs.chat.push({
          dbId: currentChatId,
          dictionary: chatBm25Config.dictionary,
        });
        processedDbIds.add(currentChatId);
      }

      extraChatFiles.forEach((dbId) => {
        if (!processedDbIds.has(dbId)) {
          // 历史库同样需要查映射
          const dbDictName =
            dictMapping[dbId]?.dict ||
            bm25Settings.current_dict ||
            "default_dict";
          const cfg = getBm25BackendConfig(dbDictName);
          if (cfg.enabled) {
            bm25Configs.chat.push({ dbId, dictionary: cfg.dictionary });
            processedDbIds.add(dbId);
          }
        }
      });

      console.log(`[Anima] 🚀 发起双轨检索...`);

      // 🟢 调用新版 queryDual，接收完整的 payload
      const responsePayload = await queryDual({
        searchText: vectorQueryText,
        bm25SearchText: bm25QueryText,
        currentChatId: currentChatId,
        extraChatFiles: extraChatFiles,
        excludeIds: recentData.ids,
        bm25Configs: bm25Configs,
        kbPayload: kbPayload, // ✨ 将知识库载荷传给逻辑层
      });

      // 🟢 1. 直接使用后端处理好的 merged_chat_results 拼接文本
      const chatRagText = formatMergedChat(responsePayload.merged_chat_results);

      const injectCfg = settings.injection_settings || {};
      const template = injectCfg.template || "{{chatHistory}}";

      let finalMemoryContent = "";
      const hasRag = chatRagText && chatRagText.trim().length > 0;
      const hasRecent = recentData.text && recentData.text.trim().length > 0;

      if (hasRag || hasRecent) {
        finalMemoryContent = template.replace(/\{\{rag\}\}/gi, chatRagText);
        finalMemoryContent = finalMemoryContent.replace(
          /\{\{recent_history\}\}/gi,
          recentData.text,
        );
      } else {
        finalMemoryContent = "";
      }

      await updateRagEntry(finalMemoryContent, injectCfg);

      // 🟢 2. 直接使用后端处理好的 merged_kb_results 拼接文本
      const formattedKbText = formatMergedKb(responsePayload.merged_kb_results);

      // ✨ 修复：读取 knowledge.js 的全局配置，并执行 {{knowledge}} 模板替换
      const kbSettings =
        extensionSettings.anima_memory_system?.kb_settings
          ?.knowledge_injection || {};
      const kbTemplate =
        kbSettings.template || "以下是相关设定：\n{{knowledge}}";

      if (formattedKbText && formattedKbText.trim().length > 0) {
        // 执行模板替换
        const finalKbContent = kbTemplate.replace(
          /\{\{knowledge\}\}/gi,
          formattedKbText,
        );
        // 将带有提示词模板的最终文本写入 [ANIMA_Knowledge_Container]
        await updateKnowledgeEntry(finalKbContent);
      } else {
        await updateKnowledgeEntry("");
      }
    } catch (err) {
      console.error("[Anima Interceptor] Critical Error:", err);
      await clearRagEntry();
      await clearKnowledgeEntry();
    }
  };

  console.log("[Anima] RAG 拦截器已就绪 (双轨支持版)");
}
