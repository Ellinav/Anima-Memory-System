import { getAnimaConfig } from "./api.js"; // 引用你在 api.js 写的配置获取函数
import { processMacros, createRenderContext } from "./utils.js";

// 🟢 [新增] 全局状态：当前是否为重绘 (Swipe)
let _isSwipeMode = false;

// 🟢 [新增] 供 index.js 调用的设置函数
export function setSwipeState(isSwipe) {
  _isSwipeMode = !!isSwipe;
  console.log(
    `[Anima RAG] 🔄 生成模式切换: ${isSwipe ? "Swipe (重绘)" : "Normal (普通)"}`,
  );
}

// [新增] 统一配置获取函数：角色卡配置 > 全局配置
export function getEffectiveSettings() {
  const context = SillyTavern.getContext();

  // 1. 获取全局配置 (Key: anima_memory_system -> rag)
  // 这是 settings.json 里的内容
  const globalRaw =
    context.extensionSettings?.["anima_memory_system"]?.rag || {};

  // 兼容处理：如果你全局里的 candidate_multiplier 在根目录，但在逻辑里我们需要它在 strategy_settings 里
  // 我们手动构造一个标准化的 globalSettings
  const globalSettings = {
    ...globalRaw,
    strategy_settings: {
      ...(globalRaw.strategy_settings || {}),
      // 如果 strategy_settings 里没有 multiplier，就去根目录拿，还没有就默认 2
      candidate_multiplier:
        globalRaw.strategy_settings?.candidate_multiplier ??
        globalRaw.candidate_multiplier ??
        2,
    },
  };

  // 2. 获取角色专属配置 (Key: anima_rag_settings)
  // 这是 角色卡 data.extensions 里的内容
  let charSettings = {};
  if (context.characterId && context.characters[context.characterId]) {
    const charData = context.characters[context.characterId].data;

    // 🎯 核心修复：这里必须读取你实际保存的 Key "anima_rag_settings"
    if (charData?.extensions?.["anima_rag_settings"]) {
      charSettings = charData.extensions["anima_rag_settings"];
      // console.log("[Anima Config] 成功加载角色独立配置 (anima_rag_settings)");
    }
  }

  // 3. 深度合并 (Global < Character)
  const mergedSettings = { ...globalSettings, ...charSettings };

  // 特殊合并：Strategy Settings (确保不会直接覆盖导致丢失)
  if (globalSettings.strategy_settings || charSettings.strategy_settings) {
    mergedSettings.strategy_settings = {
      ...(globalSettings.strategy_settings || {}),
      ...(charSettings.strategy_settings || {}),
    };
  }

  // 特殊合并：数组通常直接覆盖 (Prompt, Holidays 等)
  if (charSettings.vector_prompt)
    mergedSettings.vector_prompt = charSettings.vector_prompt;
  if (charSettings.holidays) mergedSettings.holidays = charSettings.holidays;
  if (charSettings.period_config)
    mergedSettings.period_config = charSettings.period_config;

  return mergedSettings;
}

// ==========================================
// 🧠 核心逻辑：状态数据与规则引擎 (新增)
// ==========================================

/**
 * 获取 Anima 状态数据 (JSON)
 * 通过宏 {{get_message_variable::anima_data}} 获取，支持解析 Date/Time/Player 等字段
 */
function getAnimaStatusData() {
  try {
    // 1. 获取变量字符串
    // 注意：这里假设 anima_data 存储的是 JSON 字符串
    const rawJson = processMacros("{{get_message_variable::anima_data}}");

    if (!rawJson || rawJson.trim() === "" || rawJson.includes("{{")) {
      return null;
    }

    // 2. 解析 JSON
    const data = JSON.parse(rawJson);

    // 3. 提取内层数据 (兼容 { anima_data: {...} } 或直接 {...} 结构)
    return data.anima_data || data;
  } catch (e) {
    // 变量可能未定义或非 JSON，静默失败即可
    return null;
  }
}

/**
 * 根据路径获取值 (支持 Player.HP 这种写法)
 */
function getValueByPath(obj, path) {
  if (!obj || !path) return undefined;
  return path
    .split(".")
    .reduce(
      (acc, part) => (acc && acc[part] !== undefined ? acc[part] : undefined),
      obj,
    );
}

/**
 * 智能类型比较
 */
function smartCompare(actual, op, targetStr) {
  let target = targetStr;

  // A. 自动类型推断 (Target Value)
  // Boolean
  if (typeof target === "string") {
    const lower = target.toLowerCase();
    if (lower === "true") target = true;
    else if (lower === "false") target = false;
    // Number
    else if (!isNaN(Number(target)) && target.trim() !== "") {
      target = Number(target);
    }
  }

  // B. 操作符逻辑
  switch (op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "eq":
      return actual == target; // 弱类型相等 (兼容 "50" == 50)
    case "neq":
      return actual != target;
    case "gt":
      return Number(actual) > Number(target);
    case "lt":
      return Number(actual) < Number(target);
    case "gte":
      return Number(actual) >= Number(target);
    case "lte":
      return Number(actual) <= Number(target);
    case "includes":
      if (Array.isArray(actual)) return actual.includes(target);
      if (typeof actual === "string") return actual.includes(String(target));
      return false;
    case "not_includes":
      if (Array.isArray(actual)) return !actual.includes(target);
      if (typeof actual === "string") return !actual.includes(String(target));
      return true;
    default:
      return false;
  }
}

/**
 * 执行状态映射规则
 * @param {Object} data - anima_data JSON 对象
 * @param {Array} rules - 配置中的 rules 数组
 * @returns {Array} - 命中的 Tag 列表
 */
function evaluateStatusRules(data, rules) {
  if (!data || !Array.isArray(rules) || rules.length === 0) return [];

  // 🔥 [新增] 创建标准化上下文 (注入 _user, _char 别名)
  // 这样 getValueByPath(ctx, "_user.HP") 就能自动指向 data["Player"]["HP"]
  const contextData = createRenderContext(data);

  const triggeredTags = new Set();

  rules.forEach((rule) => {
    // 🔥 [修改] 这里传入 contextData 而不是原始 data
    const actualValue = getValueByPath(contextData, rule.path);

    // 2. 比对
    const isHit = smartCompare(actualValue, rule.op, rule.value);

    if (isHit && rule.tag) {
      triggeredTags.add(rule.tag);
      // console.log(`[Anima Logic] Rule Hit: ${rule.path} (${actualValue}) ${rule.op} ${rule.value} -> +${rule.tag}`);
    }
  });

  return Array.from(triggeredTags);
}

// ==========================================
// 🕒 辅助逻辑：时间、生理与状态
// ==========================================
/**
 * 递归查找对象中的时间字段
 * 支持 keys: date, time, year/month/day, 日期, 时间, etc.
 */
function findDateRecursive(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 3) return null;

  // 1. 定义可能的 Key 名称 (正则: 忽略大小写)
  // 匹配: date, time, now, current, 日期, 时间
  const timeKeyRegex = /^(date|time|current.*|日期|当前日期|时间|当前时间)$/i;

  // 2. 遍历当前层级
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      if (timeKeyRegex.test(key)) {
        // 1. 尝试用正则提取中文格式 (例如 "2025年6月15日 下午2点" -> 提取 2025, 6, 15)
        const cnMatch = value.match(
          /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/,
        );

        let dateToParse = value;
        if (cnMatch) {
          // 如果匹配到中文，强制拼装成标准格式 YYYY/MM/DD
          dateToParse = `${cnMatch[1]}/${cnMatch[2]}/${cnMatch[3]}`;
        }

        // 2. 尝试解析 (此时标准的会原样解析，中文的已经被清洗)
        const date = new Date(dateToParse);

        // 3. 简单的有效性检查 (排除 Invalid Date)
        if (!isNaN(date.getTime())) return date;
      }
    }
  }

  // 3. 如果当前层没找到，尝试深入一层 (比如 "世界": { ... })
  for (const value of Object.values(obj)) {
    if (typeof value === "object" && value !== null) {
      const result = findDateRecursive(value, depth + 1);
      if (result) return result;
    }
  }

  return null;
}

/**
 * 获取当前模拟时间 (Virtual Time Logic) - 修复版
 */
function getSimulationDate(settings, animaData) {
  const isVirtual = settings.virtual_time_mode;

  if (isVirtual && animaData) {
    // 🟢 策略 1: 深度递归查找 JSON 中的时间
    const jsonDate = findDateRecursive(animaData);
    if (jsonDate) {
      console.log(
        `[Anima RAG] 🕒 捕获虚拟时间 (JSON): ${jsonDate.toLocaleString()}`,
      );
      return jsonDate;
    }
  }

  if (isVirtual) {
    // 🟡 策略 2: 回退到 Context 正则查找
    const context = SillyTavern.getContext();
    const chat = context.chat || [];
    const recentMsgs = chat.slice(-10).reverse();
    // 扩充正则以支持 YYYY/MM/DD
    const timeRegex =
      /\[(?:Time|Date|时间|日期)\s*[:：]\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/i;

    for (const msg of recentMsgs) {
      const match = (msg.mes || "").match(timeRegex);
      if (match && match[1]) {
        return new Date(match[1]);
      }
    }
  }

  if (isVirtual) {
    console.warn(
      "[Anima RAG] ⚠️ 虚拟时间获取失败: 变量或聊天记录中未找到有效时间，将跳过时间相关策略。",
    );
    return null;
  }

  // 如果没开启虚拟时间，默认用真实时间
  return new Date();
}

/**
 * 修改版：只计算单个事件对象是否处于周期内
 * param: event { label, start_date, cycle_length, ... }
 */
function checkPeriodState(event, currentDate) {
  if (!event || !event.start_date) return false;

  let startDate;
  // 🛠️ 修复开始：处理不带年份的日期 (MM-DD)，强制绑定到当前虚拟年份
  // 避免因为年份不同 (如默认 2001) 导致的周期相位偏移
  const simpleDateRegex = /^(\d{1,2})[-/](\d{1,2})$/;
  const match = String(event.start_date).match(simpleDateRegex);

  if (match) {
    const year = currentDate.getFullYear(); // 使用当前虚拟时间的年份 (2025)
    const month = parseInt(match[1], 10) - 1; // JS 月份从 0 开始
    const day = parseInt(match[2], 10);
    startDate = new Date(year, month, day);
  } else {
    // 如果是完整日期 (2025-06-15)，则正常解析
    startDate = new Date(event.start_date);
  }
  // 🛠️ 修复结束

  if (isNaN(startDate.getTime())) return false;

  const cycleLength = event.cycle_length || 28;
  const duration = event.duration || 5;
  const rangeBefore = event.range_before || 0;
  const rangeAfter = event.range_after || 0;

  // 计算天数差
  const diffTime = currentDate.getTime() - startDate.getTime();
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

  // 计算当前处于周期的第几天 (0 ~ cycleLength-1)
  // 使用双重取模确保负数日期也能正确计算相位
  const dayInCycle = ((diffDays % cycleLength) + cycleLength) % cycleLength;

  // 1. 经前 (PMS)
  if (rangeBefore > 0 && dayInCycle >= cycleLength - rangeBefore) return true;
  // 2. 经期 (Duration)
  if (dayInCycle < duration) return true;
  // 3. 经后 (Aftercare)
  if (
    rangeAfter > 0 &&
    dayInCycle >= duration &&
    dayInCycle < duration + rangeAfter
  )
    return true;

  return false;
}

/**
 * 状态提取 (基于正则扫描最近上下文)
 * 修复：扫描范围跟随 UI 设置的 "vector_prompt" 中的 context.count
 */
function detectActiveStatus(labels, chatHistory) {
  if (!labels || labels.length === 0 || !chatHistory) return [];

  // 1. 获取全局配置
  const context = SillyTavern.getContext();
  const settings = context.extensionSettings?.["anima_memory_system"]?.rag;

  // 2. 动态确定扫描行数
  let scanCount = 3; // 兜底默认值
  if (settings && Array.isArray(settings.vector_prompt)) {
    // 找到类型为 'context' 的配置项
    const ctxConfig = settings.vector_prompt.find(
      (item) => item.type === "context",
    );
    if (ctxConfig && ctxConfig.count) {
      scanCount = ctxConfig.count;
    }
  }

  // 3. 截取最近的 N 条消息
  const recentMsgs = chatHistory.slice(-scanCount);
  const recentText = recentMsgs.map((m) => m.mes).join("\n");

  const activeTags = [];

  labels.forEach((label) => {
    // 简单正则：匹配单词边界，忽略大小写
    // TODO: 未来如果有复杂的 XML 状态栏，需在此处修改正则逻辑
    const regex = new RegExp(`\\b${label}\\b`, "i");
    if (regex.test(recentText)) {
      activeTags.push(label);
    }
  });

  return activeTags;
}

/**
 * 获取标准化的数据库集合 ID
 * 解决中文角色文件名只显示日期的问题 (2025-7-29...) -> (角色名_2025-7-29...)
 */
export function getSmartCollectionId() {
  const context = SillyTavern.getContext();
  let filename = context.chatId; // 获取当前文件名 (e.g. "2025-1-1.jsonl")

  if (!filename) return null;

  // 去掉 .json 或 .jsonl 后缀
  filename = filename.replace(/\.jsonl?$/i, "");

  // 定义清洗函数（必须与后端逻辑保持一致：空格转下划线）
  const sanitizeName = (str) => {
    if (!str) return "";
    // 将所有非中文、非字母数字、非@.-的字符（包括空格）都替换为下划线
    return str.replace(/[^a-zA-Z0-9@\-\._\u4e00-\u9fa5]/g, "_");
  };

  // 尝试获取当前角色数据
  let charName = null;
  try {
    // 优先尝试 TavernHelper
    const charData = window.TavernHelper?.RawCharacter?.find({
      name: "current",
    });
    if (charData && charData.name) {
      charName = charData.name;
    }
    // 兜底：如果 TavernHelper 没拿到，尝试从 Context 直接读
    else if (
      context.characterId &&
      context.characters &&
      context.characters[context.characterId]
    ) {
      charName = context.characters[context.characterId].name;
    }
  } catch (e) {
    console.warn("[Anima ID] 获取角色名失败:", e);
  }

  // 1. 先把文件名清洗一遍，确保没有空格干扰正则判断
  const cleanFilename = sanitizeName(filename);

  // 2. 如果拿到了角色名
  if (charName) {
    const cleanCharName = sanitizeName(charName);

    // 情况 A: 文件名已经包含了角色名 (ST有时会自动带上)
    if (cleanFilename.startsWith(cleanCharName)) {
      return cleanFilename;
    }

    // 情况 B: 文件名看起来像纯时间戳 (数字开头) -> 手动拼接
    // 使用更严格的正则，确保是日期格式 (例如 2025...)
    if (/^\d{4}/.test(cleanFilename)) {
      return `${cleanCharName}_${cleanFilename}`;
    }
  }

  // 3. 兜底：直接返回清洗后的文件名
  return cleanFilename;
}

// 定义后端插件的路由前缀 (SillyTavern 标准)
const PLUGIN_API_URL = "/api/plugins/anima-rag";

// 🟢 新增：获取后端可用向量库列表
export async function getAvailableCollections() {
  const settings = getEffectiveSettings();
  if (settings && settings.rag_enabled === false) {
    return []; // 直接返回空数组
  }
  try {
    return await callBackend("/list", {}, "GET");
    // 注意：如果你之前的 callBackend 只支持 POST，
    // 你可能需要简单修改 callBackend 支持 GET，或者这里直接用 $.get
    // 下面是直接用 $.ajax 的写法，或者你修改 callBackend
  } catch (e) {
    console.error("获取列表失败", e);
    return [];
  }
}

/**
 * 通用函数：调用后端向量插件 (jQuery 版 - 自动处理 CSRF)
 * @param {string} endpoint - 后端路由，例如 "/insert" 或 "/query"
 * @param {object} payload - 发送的数据
 */
async function callBackend(endpoint, payload, method = "POST") {
  const settings = getAnimaConfig();
  const apiCredentials = settings?.api?.rag || settings?.rag || {};

  // 🔍 调试日志：看看它到底读到了哪里 (修复后可注释掉)
  // console.log("[Anima Debug] Config Source:", settings?.api?.rag ? "New (api.rag)" : "Old (rag)", apiCredentials);

  if (method === "POST" && (!apiCredentials.key || !apiCredentials.model)) {
    const errMsg = "缺少 API Key 或 Model 配置，请先在设置面板填写！";
    console.error(`[Anima Debug] ❌ 前端拦截: ${errMsg}`, apiCredentials);
    // 强制弹窗
    if (window.toastr) toastr.error(errMsg, "Anima API 拦截");
    throw new Error(errMsg);
  }

  const requestBody = {
    ...payload,
    apiConfig: {
      source: apiCredentials.source,
      url: apiCredentials.url,
      key: apiCredentials.key,
      model: apiCredentials.model,
    },
  };

  return new Promise((resolve, reject) => {
    $.ajax({
      url: `${PLUGIN_API_URL}${endpoint}`,
      type: method,
      contentType: "application/json",
      data: JSON.stringify(requestBody),
      timeout: 30000, // 🟢 新增：30秒超时机制，防止请求死锁挂起
      success: (data) => {
        resolve(data);
      },
      error: (jqXHR, textStatus, errorThrown) => {
        let errMsg = "未知错误";

        // 🟢 新增：细化网络层面的报错
        if (jqXHR.status === 0) {
          errMsg = "无法连接到后端服务器 (请检查 Node.js 后端是否启动)。";
        } else if (textStatus === "timeout") {
          errMsg = "向量 API 请求超时 (超过30秒)，请检查代理或网络。";
        } else {
          try {
            const errData = JSON.parse(jqXHR.responseText);
            errMsg = errData.message || errData.error || errMsg;
          } catch (e) {
            const rawText = jqXHR.responseText || jqXHR.statusText || "";
            errMsg = rawText
              .replace(/<[^>]*>?/gm, "")
              .trim()
              .replace(/\s+/g, " ")
              .substring(0, 150);
            if (!errMsg) errMsg = `HTTP Error ${jqXHR.status}`;
          }
        }

        console.error(`[Anima Debug] ❌ Backend Error:`, errMsg);
        // 失败直接弹窗
        if (window.toastr) toastr.error(errMsg, "Anima 向量接口报错");
        reject(new Error(errMsg));
      },
    });
  });
}

// 🟢 [新增] 上传知识库文件
export async function uploadKnowledgeBase(file, settings) {
  if (settings && settings.rag_enabled === false) {
    console.warn("[Anima RAG] 总开关已关闭，拦截知识库上传。");
    // 这里 reject 一个错误，或者 resolve 一个提示，取决于你希望 UI 怎么反应
    return Promise.reject(new Error("RAG 总开关已关闭，无法上传文件。"));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const content = e.target.result;
      try {
        // 调用后端
        const response = await callBackend("/import_knowledge", {
          fileName: file.name,
          fileContent: content,
          settings: {
            delimiter: settings.knowledge_base?.delimiter,
            chunk_size: settings.knowledge_base?.chunk_size,
          },
        });
        if (window.toastr) {
          toastr.success(`文件 ${file.name} 导入成功！`, "Anima RAG");
        }
        resolve(response);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = (err) => reject(err);
    reader.readAsText(file); // 此时仅支持文本读取，PDF/Docx 需要额外库
  });
}

// 1. 存入向量
export async function insertMemory(
  text,
  tags,
  timestamp,
  collectionId, // 这里通常由 UI 传入 context.chatId
  oldUuid = null,
  index = null,
  batchId = null,
) {
  const context = SillyTavern.getContext();
  const settings = getEffectiveSettings();

  // ✨ [修改点] 智能覆盖 collectionId
  // 如果传入的 collectionId 和当前的 chatId 去掉后缀后一致，说明是在操作当前聊天
  // 此时我们应用智能命名逻辑。如果传入的是其他 ID (比如在处理后台任务)，则保持原样。
  const currentChatId = context.chatId
    ? context.chatId.replace(/\.jsonl?$/i, "")
    : "";

  // 如果没有传 collectionId，或者传入的就是当前文件名，则使用增强版 ID
  if (!collectionId || collectionId === currentChatId) {
    collectionId = getSmartCollectionId();
    console.log(`[Anima ID] 写入目标重定向为: ${collectionId}`);
  }

  // 检查 1: 总开关
  if (settings && settings.rag_enabled === false) {
    console.warn("[Anima Debug] ⛔ 写入被拦截: rag_enabled is false");
    return null;
  }

  text = processMacros(text);
  if (!text || text.trim() === "") {
    console.warn("[Anima RAG] 拒绝写入：内容为空");
    if (window.toastr)
      toastr.warning("切片内容为空，已跳过向量存入。", "Anima RAG");
    return { success: false, error: "Empty text" };
  }
  try {
    console.log(
      `[Anima Debug] 🚀 发起写入请求: ID=${index}, Collection=${collectionId}`,
    );

    const response = await callBackend("/insert", {
      text,
      tags,
      timestamp,
      collectionId,
      uuid: oldUuid,
      index: index,
      batch_id: batchId,
    });

    if (response && response.vectorId) {
      console.log(`[Anima] ✅ 向量更新成功. ID: ${response.vectorId}`);
      if (window.toastr) {
        toastr.success(
          "向量化完成，已成功存入数据库！",
          "Anima RAG",
          { timeOut: 3000 }, // 3秒后消失
        );
      }
      try {
        if (context.chatId && context.chatMetadata) {
          // 读取当前关联列表 (如果没有则初始化为空数组)
          const activeFiles =
            context.chatMetadata["anima_rag_active_files"] || [];

          // 如果列表中还没有这个 ID (注意：collectionId 已经是经过 getSmartCollectionId 处理过的带下划线的 ID)
          if (!activeFiles.includes(collectionId)) {
            console.log(
              `[Anima Auto-Bind] 检测到新数据库连接: ${collectionId}，正在自动绑定...`,
            );

            // 1. 更新内存中的 metadata
            activeFiles.push(collectionId);
            context.chatMetadata["anima_rag_active_files"] = activeFiles;

            // 2. 持久化保存 metadata
            await context.saveMetadata();

            // 3. (可选) 尝试通知 UI 刷新，如果 rag.js 已经加载
            // 使用动态导入避免循环依赖
            import("./rag.js")
              .then((ui) => {
                if (ui.initRagSettings && document.getElementById("tab-rag")) {
                  // 重新初始化以刷新列表显示
                  ui.initRagSettings();
                }
              })
              .catch((e) => console.warn("[Anima Auto-Bind] UI 刷新跳过:", e));
          }
        }
      } catch (bindErr) {
        console.warn(
          "[Anima Auto-Bind] 自动绑定失败，但不影响向量写入:",
          bindErr,
        );
      }
      return { success: true, vectorId: response.vectorId };
    } else {
      return { success: false, error: "后端未返回有效 ID" };
    }
  } catch (e) {
    console.error("[Anima Debug] 💥 向量存入过程发生异常:", e);
    if (window.toastr) {
      toastr.error("向量化失败: " + e.message, "Anima RAG Error");
    }
    return { success: false, error: e.message };
  }
}
function sanitizeId(id) {
  if (!id) return "";
  // 这一步很关键：把空格和特殊符号都变成下划线，和后端逻辑保持一致
  return id.replace(/[^a-zA-Z0-9@\-\._\u4e00-\u9fa5]/g, "_");
}

// 2. 查询向量 (双轨并发版：Chat + KB)
export async function queryDual({
  searchText,
  currentChatId,
  extraChatFiles,
  kbFiles,
  excludeIds,
  isSilent = false,
}) {
  const showToast = (msg, type = "info", title = "Anima RAG") => {
    if (!isSilent && window.toastr) {
      if (type === "error") toastr.error(msg, title);
      else if (type === "warning") toastr.warning(msg, title);
      else toastr.info(msg, title);
    }
  };

  const context = SillyTavern.getContext();
  const settings = getEffectiveSettings();

  // ============== 总开关拦截 ==============
  if (settings && settings.rag_enabled === false) {
    console.warn("[Anima RAG] 总开关已关闭，阻断检索请求。");
    return { chat_results: [], kb_results: [] };
  }

  // ============== 2. ID 清洗与智能合并 ==============
  const clean = (id) => {
    if (!id) return "";
    return id.replace(/[^a-zA-Z0-9@\-\._\u4e00-\u9fa5]/g, "_");
  };

  let rawMainId = getSmartCollectionId() || currentChatId || "";
  let cleanMainId = clean(rawMainId);
  let finalChatIds = [];

  // 🔥 核心修改：判断优先级 🔥
  // 情况 A: 用户在 UI 上有明确配置 (extraChatFiles 是数组，哪怕是空数组)
  // 此时完全遵从 UI，不再强行添加当前聊天 ID
  if (Array.isArray(extraChatFiles)) {
    console.log(
      `[Anima RAG] 🛡️ 采用 UI 绑定列表 (${extraChatFiles.length} 个)`,
    );
    // 清洗列表
    let cleanExtras = extraChatFiles.map((id) => clean(id));
    // 去重并过滤空值
    finalChatIds = [...new Set(cleanExtras)].filter(Boolean);
  }
  // 情况 B: 没有任何配置 (undefined)，通常是刚创建聊天且未打开过设置
  // 此时保持原有逻辑：默认检索当前聊天
  else {
    console.log(
      `[Anima RAG] ⚠️ 无 UI 配置，回退至默认当前聊天: ${cleanMainId}`,
    );
    finalChatIds = [cleanMainId].filter(Boolean);
  }

  // 打印最终决定检索的列表
  console.log(`[Anima] 🟢 最终检索列表: [${finalChatIds.join(", ")}]`);

  // KB 清洗 (保持不变)
  const finalKbFiles = (kbFiles || []).map((id) => clean(id));

  if (finalChatIds.length === 0 && finalKbFiles.length === 0) {
    console.warn("[Anima RAG] 未指定任何数据库 ID (UI列表为空)，跳过检索");
    showToast("当前未绑定任何聊天或知识库，跳过检索。", "info");
    return { chat_results: [], kb_results: [] };
  }

  // ============== 3. 空文本拦截 (最有可能的罪魁祸首) ==============
  searchText = processMacros(searchText || "");
  if (!searchText || searchText.trim() === "") {
    console.warn("[Anima RAG] 提取到的检索词为空，跳过向后端发送请求。");
    showToast("检索文本为空 (正则可能填写错误)，跳过检索。", "warning");
    return { chat_results: [], kb_results: [] };
  }

  // ============================================
  // 🧠 构建 Chat 策略 (复用原有的复杂逻辑)
  // ============================================
  // 定义硬编码默认值
  const defaultStrat = {
    candidate_multiplier: 2,
    important: { labels: ["Important"], count: 1 },
    diversity: { count: 2 },
    special: { count: 1 },
    status: { labels: ["Sick"], count: 1 },
    period: { labels: ["Period"], count: 1 },
  };

  // 获取配置
  const userStrat = settings?.strategy_settings || {};
  const baseCount = settings?.base_count || 2;
  const minScore = settings?.min_score || 0.2;
  const isDistributed = settings?.distributed_retrieval ?? true;

  // 深度合并配置
  const stratConfig = {
    candidate_multiplier:
      userStrat.candidate_multiplier ?? defaultStrat.candidate_multiplier,
    important: { ...defaultStrat.important, ...userStrat.important },
    diversity: { ...defaultStrat.diversity, ...userStrat.diversity },
    special: { ...defaultStrat.special, ...userStrat.special },
    status: { ...defaultStrat.status, ...userStrat.status },
    period: { ...defaultStrat.period, ...userStrat.period },
  };

  // --- 智能感知模块 (Context Awareness) ---
  // 0. 获取状态数据
  const animaData = getAnimaStatusData();

  // 1. 虚拟时间 (现在可能返回 null)
  const simDate = getSimulationDate(settings, animaData);

  // 2. 节日判定 (🔥 加个 if simDate)
  let activeHolidayTags = [];
  if (simDate) {
    activeHolidayTags = checkActiveHoliday(settings?.holidays, simDate);
  }

  // 3. 周期判定 (🔥 加个 if simDate)
  const pConfig = settings?.period_config || {};
  let activeTimeTags = [];
  let definedCyclicLabels = [];

  if (pConfig.enabled !== false && Array.isArray(pConfig.events)) {
    pConfig.events.forEach((event) => {
      if (event.label) definedCyclicLabels.push(event.label.toLowerCase());

      // 只有当 simDate 存在时，才去计算周期
      if (simDate && checkPeriodState(event, simDate)) {
        activeTimeTags.push(event.label);
      }
    });
  }
  // 4. 状态/正则判定
  const configuredStatusLabels = stratConfig.status?.labels || [];
  const regexTags = detectActiveStatus(configuredStatusLabels, context.chat);
  const ruleTags = evaluateStatusRules(animaData, stratConfig.status?.rules);
  let rawStatusTags = [...new Set([...regexTags, ...ruleTags])];

  // 5. 标签劫持逻辑
  const statusTagsToHijack = rawStatusTags.filter((t) =>
    definedCyclicLabels.includes(t.toLowerCase()),
  );
  const finalStatusTags = rawStatusTags.filter(
    (t) => !definedCyclicLabels.includes(t.toLowerCase()),
  );
  let finalCyclicTags = [
    ...new Set([...activeTimeTags, ...statusTagsToHijack]),
  ];
  let isPeriodActive = finalCyclicTags.length > 0;

  if (activeHolidayTags.length > 0) {
    console.log(`[Anima RAG] 🎉 节日触发: ${activeHolidayTags.join(", ")}`);
  }

  // 2. 周期/事件日志
  if (isPeriodActive) {
    console.log(
      `[Anima RAG] 🩸 周期/事件活跃 (Count=${stratConfig.period?.count}): ${finalCyclicTags.join(", ")}`,
    );
  }

  // 3. 状态触发日志
  if (finalStatusTags.length > 0) {
    console.log(
      `[Anima RAG] 🚑 状态触发 (Count=${stratConfig.status?.count}): ${finalStatusTags.join(", ")}`,
    );
  }

  // 构建 Chat 策略 Payload
  const chatStrategyPayload = {
    enabled: isDistributed,
    recent_weight: settings?.recent_weight || 0,
    current_session_id: cleanMainId,
    global_multiplier: stratConfig.candidate_multiplier,
    min_score: minScore,
    steps: [
      { type: "base", count: baseCount },
      {
        type: "important",
        count: stratConfig.important.count,
        labels: stratConfig.important.labels,
      },
      {
        type: "status",
        count: stratConfig.status.count,
        labels: finalStatusTags,
      },
      {
        type: "period",
        count: isPeriodActive ? stratConfig.period.count : 0,
        labels: finalCyclicTags,
      },
      {
        type: "special",
        count: activeHolidayTags.length > 0 ? stratConfig.special.count : 0,
        labels: activeHolidayTags,
      },
      { type: "diversity", count: stratConfig.diversity.count },
    ],
  };

  // ============================================
  // 📚 构建 KB 策略 (简单模式)
  // ============================================
  const kbConfig = settings?.knowledge_base || {};
  const kbStrategyPayload = {
    search_top_k: kbConfig.search_top_k || 3,
    min_score: kbConfig.min_score || 0.5,
  };

  // ============================================
  // 🚀 发送请求
  // ============================================
  try {
    // 🟢 [修复] 引入正确的 API 配置路径
    const fullConfig = getAnimaConfig(); // 获取包含 api 的总配置
    const rerankApiConfig = fullConfig?.api?.rerank || {}; // 读取实际保存的 url, key, model

    const isRerankEnabled = settings?.rerank_enabled === true;
    const rerankCount = settings?.rerank_count || 30;

    const response = await callBackend("/query", {
      searchText,
      ignore_ids: excludeIds || [],
      sessionId: cleanMainId,
      is_swipe: _isSwipeMode,
      // 🟢 [修复] 组装正确的 Rerank 配置发给后端
      rerankConfig: {
        enabled: isRerankEnabled,
        count: rerankCount,
        api: rerankApiConfig, // 现在这里面有真实的 url 和 key 了
      },
      echoConfig: {
        max_count: settings?.echo_max_count ?? 10,
        base_life: settings?.base_life ?? 1,
        imp_life: settings?.imp_life ?? 2,
      },
      chatContext: {
        ids: finalChatIds,
        strategy: chatStrategyPayload,
      },
      kbContext: {
        ids: finalKbFiles,
        strategy: kbStrategyPayload,
      },
    });
    if (
      response &&
      response._debug_logs &&
      Array.isArray(response._debug_logs)
    ) {
      const logs = response._debug_logs;
      const totalCount =
        (response.chat_results?.length || 0) +
        (response.kb_results?.length || 0);

      console.groupCollapsed(
        `%c[Anima RAG] 🕵️ 检索报告 | 命中: ${totalCount} | 日志: ${logs.length} 条`,
        "color: #22d3ee; font-weight: bold; background: #0f172a; padding: 2px 6px; border-radius: 4px;",
      );

      logs.forEach((log) => {
        // 🎨 样式区分：Echo 系统用紫色，普通检索用青色
        const isEcho = (log.step || "").includes("Echo");

        const stepColor = isEcho ? "#d8b4fe" : "#67e8f9"; // 紫色 vs 青色
        const stepLabel = `[${log.step}]`.padEnd(15, " ");

        // 构建元数据字符串 (库名 + 分数 + ID)
        let metaParts = [];
        if (log.library) metaParts.push(log.library);
        if (log.uniqueID && log.uniqueID !== "-")
          metaParts.push(`ID:${log.uniqueID}`);
        if (log.score && log.score !== "-") metaParts.push(`Sc:${log.score}`);
        const metaStr =
          metaParts.length > 0 ? `[${metaParts.join(" | ")}]` : "";

        // 打印
        console.log(
          `%c${stepLabel}%c ${metaStr} %c${log.tags || log.info || ""}`,
          `color: ${stepColor}; font-weight: bold; font-family: monospace;`, // Step 样式
          "color: #94a3b8; font-size: 0.9em;", // Meta 样式 (灰色)
          "color: inherit;", // 内容默认颜色
        );
      });

      console.groupEnd();
    }
    // 调试日志回传 UI (合并 Chat 和 KB 的日志，或者只传 Chat 的)
    // 目前后端只返回了 Chat 的 debug 记录在 _debug_logs 中，如果需要 KB 的也可以让后端加
    if (response && response._debug_logs) {
      import("./rag.js")
        .then((uiModule) => {
          if (uiModule.updateLastRetrievalResult) {
            uiModule.updateLastRetrievalResult({
              query: searchText,
              // 在结果预览里，我们将 chat 和 kb 合并展示，方便用户看
              results: [
                ...(response.chat_results || []),
                ...(response.kb_results || []),
              ],
              strategy_log: response._debug_logs,
            });
          }
        })
        .catch((e) => console.warn(e));
    }

    return {
      chat_results: response.chat_results || [],
      kb_results: response.kb_results || [],
    };
  } catch (e) {
    console.error("[Anima RAG] 双轨检索失败:", e);
    // 注意：callBackend 里面如果是网络错误已经弹过窗了，这里可以加个兜底
    // 为了防止双重弹窗，如果你觉得烦，可以把这里的 toastr 注释掉
    if (window.toastr && !e.message.includes("请先在")) {
      toastr.error("检索过程崩溃: " + e.message, "Anima RAG 致命错误");
    }
    return { chat_results: [], kb_results: [] };
  }
}

// 3. 删除向量 (✨ 已修复：复用 callBackend，解决路径和权限问题)
export async function deleteMemory(collectionId, index) {
  const context = SillyTavern.getContext();
  const settings = context.extensionSettings?.["anima_memory_system"]?.rag;
  if (settings && settings.rag_enabled === false) {
    console.warn("[Anima RAG] 总开关已关闭，阻断向量删除操作。");
    return null;
  }
  if (!collectionId || index === undefined) return;

  try {
    const response = await callBackend("/delete", {
      collectionId: collectionId,
      // 🔥 修改点：移除 parseInt，直接传 raw value
      // 这样 "1_1" 才能原样传给后端
      index: index,
    });

    console.log(`[Anima Client] 后端删除响应:`, response);
    return response;
  } catch (err) {
    console.error("[Anima Client] 删除向量失败:", err);
    // 不抛出错误，以免阻断前端删除 UI，只弹窗警告
    if (window.toastr) {
      toastr.warning("本地记录已删，但后端向量删除失败: " + err.message);
    }
  }
}

// 🔥 4. 新增：批量删除向量
export async function deleteBatchMemory(collectionId, batchId) {
  const context = SillyTavern.getContext();
  const settings = context.extensionSettings?.["anima_memory_system"]?.rag;
  if (settings && settings.rag_enabled === false) {
    console.warn("[Anima RAG] 总开关已关闭，阻断批量删除操作。");
    return null;
  }
  if (!collectionId || batchId === undefined) return;

  try {
    const response = await callBackend("/delete_batch", {
      collectionId: collectionId,
      batch_id: batchId,
    });

    console.log(`[Anima Client] Batch ${batchId} 向量清理响应:`, response);
    return response;
  } catch (err) {
    console.error("[Anima Client] 批量删除失败:", err);
    if (window.toastr) {
      toastr.warning("后端批量清理失败: " + err.message);
    }
  }
}

// 🟢 新增：物理删除整个 Collection 文件夹
export async function deleteCollection(collectionId) {
  const settings = getEffectiveSettings(); // 获取当前配置
  if (settings && settings.rag_enabled === false) {
    console.warn("[Anima RAG] 总开关已关闭，拦截数据库删除。");
    return { success: false, message: "RAG Disabled" };
  }
  if (!collectionId) return;

  try {
    const response = await callBackend("/delete_collection", {
      collectionId: collectionId,
    });
    console.log(`[Anima Client] 数据库删除响应:`, response);
    return response;
  } catch (err) {
    console.error("[Anima Client] 数据库删除失败:", err);
    if (window.toastr) {
      toastr.error("后端删除失败: " + err.message);
    }
    return { success: false };
  }
}

/**
 * 检查日期是否命中节日 (修改版：支持同时触发多个节日)
 * 返回数组，例如 ["Birthday", "Christmas"]
 */
function checkActiveHoliday(holidays, currentDate) {
  if (!holidays || !Array.isArray(holidays) || holidays.length === 0) return []; // 返回空数组

  const activeHolidays = []; // 存储所有命中的节日
  const now = new Date(currentDate);
  now.setHours(0, 0, 0, 0);
  const currentYear = now.getFullYear();

  for (const h of holidays) {
    if (!h.date) continue;

    const [mm, dd] = h.date.split(/[-/]/).map(Number);
    if (!mm || !dd) continue;

    const targetDate = new Date(currentYear, mm - 1, dd);
    targetDate.setHours(0, 0, 0, 0);

    const diffTime = targetDate.getTime() - now.getTime();
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

    const rangeBefore = h.range_before || 0;
    const rangeAfter = h.range_after || 0;

    let isHit = false;
    if (diffDays === 0) {
      isHit = true;
    } else if (diffDays > 0) {
      if (diffDays <= rangeBefore) isHit = true;
    } else {
      if (Math.abs(diffDays) <= rangeAfter) isHit = true;
    }

    if (isHit) {
      activeHolidays.push(h.name);
      // 注意：这里删除了 return，继续循环检查下一个节日
    }
  }
  return activeHolidays;
}
