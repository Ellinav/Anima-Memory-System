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

// ✨ 修改版：构建查询的核心逻辑 (逻辑已同步至与 UI 预览完全一致)
function constructRagQuery(chat, settings) {
  const promptConfig = settings.vector_prompt || [];
  let finalQueryParts = [];

  // 🟢 黄金修复方案：先拿到原生 chat 兜底，并动态计算长度
  const nativeChat = SillyTavern.getContext().chat || chat || [];
  let allMsgs = [];

  try {
    if (window.TavernHelper && window.TavernHelper.getChatMessages) {
      // 动态获取最后一条消息的 ID，而不是传宏字符串
      const lastId = nativeChat.length > 0 ? nativeChat.length - 1 : 0;
      allMsgs =
        window.TavernHelper.getChatMessages(`0-${lastId}`, {
          include_swipes: false,
        }) || [];
    }
  } catch (e) {
    console.warn("[Anima] TavernHelper 提取失败，准备回退");
  }

  // 🚨 最核心的兜底：就算没报错，只要是空数组，一律强制回退到原生 chat！
  if (!allMsgs || allMsgs.length === 0) {
    allMsgs = nativeChat;
  }

  for (const item of promptConfig) {
    if (item.type === "context") {
      const count = parseInt(item.count) || 5;

      // 🟢 修复：先精准截取最后 N 楼，再进行清洗（保证不多截也不漏截）
      const slicedChat = allMsgs.slice(-count);

      const textBlock = slicedChat
        .map((msg) => {
          // 兼容 TavernHelper(role) 和 ST(is_user) 结构
          const isUser = msg.role === "user" || msg.is_user === true;
          if (msg.is_system && !msg.role) return null; // 过滤纯系统消息

          // 跳过开场白 (严格判断消息 ID 或对比原文)
          if (
            settings.skip_layer_zero &&
            (String(msg.message_id) === "0" || msg.mes === allMsgs[0]?.mes)
          )
            return null;

          let content = msg.message || msg.mes;
          if (!content) return null;

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

// ✨ 修复版：构建 BM25 检索词 (与预览绝对对齐)
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
      // 动态获取最后一条消息的 ID，而不是传宏字符串
      const lastId = nativeChat.length > 0 ? nativeChat.length - 1 : 0;
      allMsgs =
        window.TavernHelper.getChatMessages(`0-${lastId}`, {
          include_swipes: false,
        }) || [];
    }
  } catch (e) {
    console.warn("[Anima] TavernHelper 提取失败，准备回退");
  }

  // 🚨 最核心的兜底：就算没报错，只要是空数组，一律强制回退到原生 chat！
  if (!allMsgs || allMsgs.length === 0) {
    allMsgs = nativeChat;
  }

  for (const item of promptConfig) {
    if (item.id === "floor_content") {
      const count = parseInt(item.count) || 1;

      // 🔴 核心修复 1：绝对优先切片！截死最后 N 层，决不允许向前越界抓取
      const slicedChat = allMsgs.slice(-count);
      let processedChat = [];

      slicedChat.forEach((msg) => {
        // 兼容 TavernHelper(role) 和 原生 ST(is_user) 结构
        const isUser = msg.role === "user" || msg.is_user === true;
        if (msg.is_system && !msg.role) return;
        if (excludeUser && isUser) return;

        let content = msg.message || msg.mes || "";
        if (!content) return;

        if (typeof processMacros === "function") {
          content = processMacros(content);
        }

        const cleanRegex = /^[\s\r\n]*(&gt;|>)[\s\r\n]*/i;
        while (cleanRegex.test(content)) {
          content = content.replace(cleanRegex, "");
        }

        // 🔴 核心修复 2：稳健的正则判定逻辑，避免 undefined 短路
        let shouldApplyRegex = true;

        // 判断是否为开场白 (严谨比对，防止报错)
        const isLayerZero =
          String(msg.message_id) === "0" ||
          msg._id === 0 ||
          (msg.mes && allMsgs[0]?.mes && msg.mes === allMsgs[0].mes) ||
          (msg.message &&
            allMsgs[0]?.message &&
            msg.message === allMsgs[0].message);

        if (skipZero && isLayerZero) {
          shouldApplyRegex = false;
        }
        if (skipUser && isUser) {
          shouldApplyRegex = false;
        }

        // 应用正则
        if (shouldApplyRegex && regexList && regexList.length > 0) {
          content = applyRegexRules(content, regexList);
        }

        content = content?.trim() || "";

        // 如果清洗后内容仍然存在，才推入最终结果
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
