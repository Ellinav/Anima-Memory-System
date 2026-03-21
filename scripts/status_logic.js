import { validateStatusData } from "./status_zod.js";
import {
  getContextData,
  processMacros,
  extractJsonResult,
  deepMergeUpdates,
  objectToYaml,
  yamlToObject,
  applyRegexRules,
  createRenderContext,
  customMacroReplacers,
} from "./utils.js";
import { generateText } from "./api.js";
import { safeGetChatWorldbookName } from "./worldbook_api.js";

/**
 * @typedef {Object} ExtensionSettings
 * @property {Object} [anima_status]
 */
const stWindow = window;
const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
const ROOT_KEY = "anima_memory_system";
const SUB_KEY = "status";

export const DEFAULT_STATUS_SETTINGS = {
  status_enabled: false,
  current_status_yaml: "Status: Normal",
  prompt_rules: [
    // --- 新增：角色卡信息与用户设定默认占位 ---
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
    // 1. 状态插入位 (Status Placeholder) - 对应 UI 中的特殊栏
    // 这里 content 必须严格等于 "{{status}}"，status.js 才能渲染成那个带心跳图标的特殊条目
    {
      role: "system",
      title: "实时状态 (Real-time Status)",
      content: "{{status}}",
    },
    // 2. 增量剧情插入位 (Context Placeholder) - 对应 UI 中的蓝色特殊栏
    {
      role: "user",
      title: "增量剧情 (Auto Context)",
      content: "{{chat_context}}",
    },
  ],
  beautify_settings: {
    enabled: false,
    template: ``,
  },
  injection_settings: {
    position: "at_depth",
    role: "system",
    depth: 1,
    order: 100,
    template: "【当前状态信息】\n{{ANIMA_BASE_STATUS}}",
  },
};

export function getStatusSettings() {
  // 1. 获取全局基础设置 (Master Switch, Injection 等)
  // 逻辑变更：从 anima_memory_system.status 读取
  const rootParams = extensionSettings[ROOT_KEY] || {};
  let baseSettings =
    rootParams[SUB_KEY] || structuredClone(DEFAULT_STATUS_SETTINGS);

  let finalSettings = structuredClone(baseSettings);

  // 强制修正：注入配置始终从全局读 (如果全局没配置就用默认)
  // 这里的逻辑保持不变
  if (!finalSettings.injection_settings) {
    finalSettings.injection_settings = structuredClone(
      DEFAULT_STATUS_SETTINGS.injection_settings,
    );
  }

  const context = SillyTavern.getContext();
  const charId = context.characterId;

  // 4. 如果有角色卡，尝试从扩展字段读取配置并覆盖默认值
  if (charId) {
    // --- 读取 Zod 配置 ---
    const cardZod = getSettingsFromCharacterCard("anima_zod_config");
    if (cardZod) {
      finalSettings.zod_settings = cardZod;
    } else {
      // 关键：如果角色卡没存，这就应该重置为默认，而不是沿用全局的脏数据
      finalSettings.zod_settings = structuredClone(
        DEFAULT_STATUS_SETTINGS.zod_settings,
      );
    }

    // --- 读取 Prompt 规则 ---
    const cardPrompt = getSettingsFromCharacterCard("anima_prompt_config");
    if (cardPrompt) {
      finalSettings.prompt_rules = cardPrompt;
    } else {
      finalSettings.prompt_rules = structuredClone(
        DEFAULT_STATUS_SETTINGS.prompt_rules,
      );
    }

    const cardGC = getSettingsFromCharacterCard("anima_gc_settings");
    if (cardGC) {
      finalSettings.gc_settings = cardGC;
    } else {
      // 如果角色卡没存过，给一套默认值
      finalSettings.gc_settings = {
        reuse_regex: true, // 默认开启复用全局正则
        skip_layer_zero: true,
        regex_skip_user: false,
        exclude_user: false,
        regex_list: [],
      };
    }

    // --- 读取 美化配置 ---
    const cardBeautify = getSettingsFromCharacterCard(
      "anima_beautify_template",
    );
    if (cardBeautify) {
      // 你的 beautify 结构在默认值里是 { enabled, template }，存卡里也是这个结构吗？
      // 假设存卡里的直接是 { template: "..." } 或者完整对象，请根据你存的数据结构适配
      if (finalSettings.beautify_settings) {
        Object.assign(finalSettings.beautify_settings, cardBeautify);
      } else {
        finalSettings.beautify_settings = cardBeautify;
      }
    } else {
      finalSettings.beautify_settings = structuredClone(
        DEFAULT_STATUS_SETTINGS.beautify_settings,
      );
    }

    // --- 读取 开场白预设 (Greeting Presets) ---
    const cardGreetings = getSettingsFromCharacterCard(
      "anima_greeting_presets",
    );
    if (cardGreetings) {
      finalSettings.greeting_presets = cardGreetings;
    } else {
      finalSettings.greeting_presets = {};
    }
  } else {
    // 1. 强制重置 Zod 为代码默认值
    finalSettings.zod_settings = structuredClone(
      DEFAULT_STATUS_SETTINGS.zod_settings,
    );

    // 2. 强制重置 Prompt 规则为代码默认值
    finalSettings.prompt_rules = structuredClone(
      DEFAULT_STATUS_SETTINGS.prompt_rules,
    );

    finalSettings.gc_settings = {
      reuse_regex: true,
      skip_layer_zero: true,
      regex_skip_user: false,
      exclude_user: false,
      regex_list: [],
    };

    // 3. 强制重置 美化配置 为代码默认值
    // 这一步会把你代码里写的空字符串 (或你删改后的默认值) 覆盖掉全局里的那一大串脏数据
    finalSettings.beautify_settings = structuredClone(
      DEFAULT_STATUS_SETTINGS.beautify_settings,
    );

    // 4. 强制重置 开场白预设
    finalSettings.greeting_presets = {};
  }

  return finalSettings;
}

// ==========================================
// 状态清洗 (GC) 专属配置读取
// ==========================================
export const DEFAULT_GC_SETTINGS = {
  reuse_regex: true,
  skip_layer_zero: true,
  regex_skip_user: false,
  exclude_user: false,
  regex_list: [],
};

export const DEFAULT_GC_PROMPTS = [
  { type: "char_info", enabled: true, content: "系统自动提取角色卡信息..." },
  { type: "user_info", enabled: true, content: "系统自动提取用户设定..." },
  {
    type: "status_placeholder",
    content: "系统将在此处插入需要清洗的臃肿状态...",
  },
  {
    type: "chat_context_placeholder",
    floors: 30,
    content: "系统将在此处插入清洗后的聊天记录摘要/正文...",
  },
  {
    type: "normal",
    role: "system",
    title: "清洗指令",
    content: "请根据以上信息，清理并输出当前最新状态...",
  },
];

export function getGCSettings() {
  let finalGC = structuredClone(DEFAULT_GC_SETTINGS);
  let finalPrompts = structuredClone(DEFAULT_GC_PROMPTS);

  const context =
    typeof SillyTavern !== "undefined" ? SillyTavern.getContext() : null;
  const charId = context ? context.characterId : null;

  if (charId) {
    // 1. 读取专属清洗正则与开关
    const cardGC = getSettingsFromCharacterCard("anima_gc_settings");
    if (cardGC) {
      Object.assign(finalGC, cardGC);
    }

    // 2. 读取专属清洗提示词 (与状态更新提示词完全隔离)
    const cardPrompts = getSettingsFromCharacterCard("anima_gc_prompts");
    if (cardPrompts && Array.isArray(cardPrompts) && cardPrompts.length > 0) {
      finalPrompts = cardPrompts;
    }
  }

  return { gcConfig: finalGC, gcPrompts: finalPrompts };
}

export function saveStatusSettings(settings) {
  // 确保根对象存在
  if (!extensionSettings[ROOT_KEY]) {
    extensionSettings[ROOT_KEY] = {};
  }
  // 保存到 status 子节点
  extensionSettings[ROOT_KEY][SUB_KEY] = settings;

  // ✅ 使用官方提供的防抖保存函数写入 settings.json
  saveSettingsDebounced();
}

// ==========================================
// 核心逻辑 1: 基准状态查找 (Backtracking)
// ==========================================

/**
 * 在 targetMsgId 之前寻找最近的一个有效状态作为“基准”
 * 这是给副 API 用的，目的是计算 "Old State + Delta = New State"
 * @returns {Object} { id: number, data: Object }
 */

export function findBaseStatus(targetMsgId) {
  if (!window.TavernHelper) return { id: -1, data: {} };

  const context = SillyTavern.getContext();
  const chatLen = context.chat ? context.chat.length : 0;
  if (chatLen === 0) return { id: -1, data: {} };

  const range = `0-${Math.max(0, chatLen - 1)}`;
  // 必须确保拿到 is_user 字段
  const allChat = window.TavernHelper.getChatMessages(range, {
    include_swipes: false,
  });

  if (!allChat || allChat.length === 0) return { id: -1, data: {} };

  const targetIndex = allChat.findIndex((m) => m.message_id === targetMsgId);
  let searchStartIndex =
    targetIndex !== -1 ? targetIndex - 1 : allChat.length - 1;

  for (let i = searchStartIndex; i >= 0; i--) {
    const msg = allChat[i];
    if (!msg) continue;

    // 🔥【新增修复】: 即使该楼层有 anima_data，如果是 User 楼层也强制跳过！
    // 这能让系统从“4楼被误写”的错误中自我恢复，直接找到3楼
    const isUser =
      msg.is_user ||
      msg.role === "user" ||
      String(msg.name).toLowerCase() === "you";
    if (isUser) continue;

    const vars = window.TavernHelper.getVariables({
      type: "message",
      message_id: msg.message_id,
    });

    if (vars && vars.anima_data) {
      return { id: msg.message_id, data: vars.anima_data };
    }
  }

  return { id: -1, data: {} };
}

/**
 * 核心寻址函数：从最新楼层开始往上回溯，找到最近的一个 AI/模型 楼层
 * @returns {Object|null} 返回消息对象，找不到则返回 null
 */
export function getTargetAIFloor() {
  if (!window.TavernHelper) return null;
  const allMsgs = window.TavernHelper.getChatMessages("0-{{lastMessageId}}", {
    include_swipes: false,
  });
  if (!allMsgs || allMsgs.length === 0) return null;

  const context = SillyTavern.getContext();
  const currentUserName = context.userName;

  for (let i = allMsgs.length - 1; i >= 0; i--) {
    const msg = allMsgs[i];
    const isUser =
      msg.is_user === true ||
      msg.role === "user" ||
      (msg.name && msg.name === currentUserName) ||
      (msg.name && String(msg.name).toLowerCase() === "you") ||
      (msg.name && msg.name === "User");

    // 只要不是 User，就是我们要找的 AI 楼层
    if (!isUser) {
      return msg;
    }
  }
  return null;
}

// ==========================================
// 核心逻辑 2: 增量上下文构建
// ==========================================

/**
 * 获取 (baseMsgId, targetMsgId] 之间的文本
 * @param {number} targetMsgId - 目标楼层 (包含)
 * @param {number} baseMsgId - 基准楼层 (不包含)
 */
async function getIncrementalChatContext(targetMsgId, baseMsgId, contextData) {
  const { charName, userName } = contextData;
  const allChat = window.TavernHelper.getChatMessages("0-{{lastMessageId}}", {
    include_swipes: false,
  });

  // 1. 确定索引范围
  let startIndex = 0;
  let targetIndex = allChat.findIndex((m) => m.message_id === targetMsgId);

  if (targetIndex === -1)
    return { text: "", range: { start: "--", end: "--", count: 0 } };

  if (baseMsgId !== -1) {
    const baseIndex = allChat.findIndex((m) => m.message_id === baseMsgId);
    if (baseIndex !== -1) {
      startIndex = baseIndex + 1; // 基准的下一楼开始
    }
  }

  // 2. 截取片段 (限制最大深度 20)
  if (targetIndex - startIndex > 20) startIndex = Math.max(0, targetIndex - 20);
  const incrementalMsgs = allChat.slice(startIndex, targetIndex + 1);

  // 3. 拼接文本
  const settings = getStatusSettings();
  const regexConfig = settings.regex_settings || {};
  const regexList = regexConfig.regex_list || [];
  let chatContext = "";

  incrementalMsgs.forEach((msg) => {
    let isUser = false;
    if (typeof msg.is_user === "boolean") isUser = msg.is_user;
    else if (msg.role === "user") isUser = true;
    else if (msg.name === userName) isUser = true;

    // 🔥 核心修正 1：只读 message
    let content = msg.message || "";
    if (!content) return;

    // 🔥 核心修正 2：强力去除 >
    content = content.replace(/^[\s\r\n]*>[\s\r\n]*/, "");

    // 其他逻辑保持不变...
    const isLayerZero = msg.message_id === allChat[0]?.message_id;
    if (regexConfig.skip_layer_zero && isLayerZero) {
      // skip regex
    } else {
      if (isUser && regexConfig.exclude_user) return;
      if (!isUser || !regexConfig.regex_skip_user) {
        content = applyRegexRules(content, regexList);
      }
    }

    const displayName = isUser ? userName : "Assistant";
    // 再次 trim() 确保没有首尾空白
    if (content.trim()) chatContext += `${displayName}: ${content.trim()}\n\n`;
  });

  return {
    text: chatContext.trim(),
    range: {
      start: incrementalMsgs[0]?.message_id ?? "Start",
      end: incrementalMsgs[incrementalMsgs.length - 1]?.message_id ?? "End",
      count: incrementalMsgs.length,
    },
  };
}

// ==========================================
// 辅助函数：通用变量读取器
// ==========================================
function getVariableValueByString(scope, keyPath) {
  if (!window.TavernHelper) return "N/A (Helper Missing)";

  let vars = {};

  try {
    // 根据 scope 映射到 type
    switch (scope) {
      case "global":
        vars = window.TavernHelper.getVariables({ type: "global" });
        break;
      case "preset":
        vars = window.TavernHelper.getVariables({ type: "preset" });
        break;
      case "character":
        // 注意：如果没加载角色卡可能会报错，加个 try-catch
        vars = window.TavernHelper.getVariables({ type: "character" });
        break;
      case "chat":
        vars = window.TavernHelper.getVariables({ type: "chat" });
        break;
      case "message":
        // 关键点：对于 message 类型，我们默认获取 "latest"
        // 这样在预览和构建 Prompt 时，就能拿到最新的数据
        vars = window.TavernHelper.getVariables({
          type: "message",
          message_id: "latest",
        });
        break;
      default:
        return `[Unknown Scope: ${scope}]`;
    }
  } catch (e) {
    console.warn(`[Anima] Failed to get variables for scope ${scope}:`, e);
    return "N/A";
  }

  // 使用 lodash 的 _.get 来支持 "a.b.c" 这种深层路径
  // SillyTavern 全局环境中有 _ (lodash)
  const _ = /** @type {any} */ (window)["_"];
  if (_ && _.get) {
    const val = _.get(vars, keyPath);
    if (val === undefined) return "N/A";
    return typeof val === "object" ? JSON.stringify(val) : String(val);
  } else {
    const val = vars[keyPath];
    if (val === undefined) return "N/A";
    return typeof val === "object" ? JSON.stringify(val) : String(val);
  }
}

// ==========================================
// 核心逻辑 3: Prompt 构建与执行
// ==========================================
async function constructStatusPrompt(statusConfig, contextData, targetMsgId) {
  const messages = [];

  // 1. 基准状态 (保持不变)
  const baseStatus = findBaseStatus(targetMsgId);
  // 🔴 旧代码：JSON 格式
  // const baseJsonStr = JSON.stringify(baseStatus.data || {});

  // 🟢 新代码：YAML 格式 (直接转换)
  const baseYamlStr = objectToYaml(baseStatus.data || {});

  // 2. 增量文本 (保持不变)
  const incResult = await getIncrementalChatContext(
    targetMsgId,
    baseStatus.id,
    contextData,
  );
  const incrementalText = incResult.text;

  // 3. 准备规则
  const rules = statusConfig.prompt_rules || [];

  // 5. 遍历规则
  for (const rule of rules) {
    // --- 新增 1：如果条目被关闭，则直接跳过不发送 ---
    if (rule.enabled === false) continue;

    let finalContent = rule.content || "";
    const currentRole = rule.role || "system"; // 提取 role 备用

    // --- 新增 2：拦截角色卡信息与用户设定，并注入上下文 ---
    if (rule.type === "char_info") {
      const charDesc = processMacros("{{description}}");
      // 如果解析后还是原宏（说明没匹配到）或为空，则跳过
      if (!charDesc || charDesc === "{{description}}") continue;

      finalContent = `${charDesc}`;
      // 不用再包一层 processMacros，因为 {{description}} 解析出的文本内部的宏会在后续步骤被处理
    } else if (rule.type === "user_info") {
      const userPersona = processMacros("{{persona}}");
      if (!userPersona || userPersona === "{{persona}}") continue;

      finalContent = `${userPersona}`;

      // A. 特殊占位符处理 (原有的逻辑改为 else if 承接)
    } else if (finalContent === "{{chat_context}}") {
      if (!incrementalText) continue;
      finalContent = `${incrementalText}`;
    } else if (
      finalContent === "{{status}}" ||
      finalContent.includes("{{status}}")
    ) {
      // 🟢【修改】纯净替换
      // 仅替换为 YAML 字符串，不添加任何 "[Current State]" 标题
      // 现在的逻辑是：{{status}} == 纯数据
      // 如果你需要标题，请在 UI 的 Prompt 规则里写：
      // "当前状态如下:\n{{status}}"
      finalContent = finalContent.replace("{{status}}", baseYamlStr);
    } else {
      // B. 普通文本的处理 (宏替换等)
      finalContent = finalContent.replace(
        /\{\{format_message_variable::([\w\.]+)\}\}/g,
        (match, keyPath) => {
          const val = getVariableValueByString("message", keyPath);
          return val !== "N/A" ? val : match;
        },
      );
      finalContent = processMacros(finalContent);
    }

    if (finalContent) {
      const currentRole = rule.role || "system";

      // 检查当前 messages 数组是否为空
      if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1];

        // 如果上一条消息的 role 和当前的一致，则合并内容
        if (lastMsg.role === currentRole) {
          // 使用双换行符分隔不同的段落，保持清晰
          lastMsg.content += `\n\n${finalContent}`;
        } else {
          // role 不同，推入新消息
          messages.push({
            role: currentRole,
            content: finalContent,
          });
        }
      } else {
        // 数组为空，直接推入
        messages.push({
          role: currentRole,
          content: finalContent,
        });
      }
    }
  }

  return { messages, incResult, baseStatus };
}

export async function triggerStatusUpdate(targetMsgId) {
  console.log(`[Anima Status] 🚀 Trigger Update for Msg #${targetMsgId}`);
  window.dispatchEvent(new CustomEvent("anima:status_sync_start"));
  const statusConfig = getStatusSettings();
  const contextData = getContextData();

  // 构建 Prompt
  const { messages, baseStatus } = await constructStatusPrompt(
    statusConfig,
    contextData,
    targetMsgId,
  );

  // 辅助函数：强制刷新 UI (显示未同步或错误状态)
  const forceRefreshUI = () => {
    window.dispatchEvent(
      new CustomEvent("anima:status_updated", {
        detail: { msgId: targetMsgId, status: "failed_or_skipped" },
      }),
    );
    // 这会触发 status.js 里的 refreshStatusPanel()，从而检测到变量差异并显示"未同步"
    if (window.$) {
      $("#btn-refresh-status").trigger("click");
      console.log("[Anima] ⚠️ 检测到流程中断，已自动触发面板刷新");
    }
  };

  if (!messages || messages.length === 0) return false;

  try {
    // 1. 请求 API
    const responseText = await generateText(messages, "status");
    /* 测试样本
    console.log("正在模拟 LLM 返回脏数据...");
    const responseText = JSON.stringify({
      updates: {
        沈皎: {
          身体: {
            体力: 9999, // 故意写大，测试 autoNum max:100
            生理期: "false", // 故意写字符串，测试 boolean 修复
          },
        },
      },
    });
    await new Promise((r) => setTimeout(r, 1000)); // 模拟网络延迟
    */

    // 2. 基础检查：API 是否返回了空内容
    if (
      !responseText ||
      typeof responseText !== "string" ||
      responseText.trim().length === 0
    ) {
      console.warn("[Anima] 🛑 副API返回内容为空，停止更新。");
      forceRefreshUI();
      return false; // ❌ 终止：不写入
    }

    console.log(`[Anima Debug] 📡 副API 原始返回 (Raw):\n${responseText}`);

    // 3. 解析 JSON
    const rawResult = extractJsonResult(responseText);
    const payload =
      Array.isArray(rawResult) && rawResult.length > 0
        ? rawResult[0]
        : rawResult;

    // 4. JSON 完整性检查
    if (!payload) {
      console.warn("[Anima] ❌ JSON 解析失败 (payload为空)，停止更新。");
      forceRefreshUI();
      return false; // ❌ 终止：不写入
    }

    // 防止模型返回了报错信息 (例如 { "error": "..." })
    if (payload.error || payload.code || payload.detail) {
      console.error("[Anima] ❌ 检测到 JSON 包含错误信息，停止更新:", payload);
      forceRefreshUI();
      return false; // ❌ 终止：不写入
    }

    // 5. 获取更新内容
    // 注意：这里我们只取 updates。如果模型直接返回了全量状态，extractJsonResult 可能会处理，
    // 但为了逻辑安全，我们假设 payload.updates 才是增量。
    const updates = payload.updates || payload;

    // 🔥【关键修复 Q1】空更新拦截
    // 如果 updates 为空对象，说明无需变更。
    // 此时直接返回 true (流程成功)，但**不调用** saveStatusToMessage。
    // 这样 4楼 就不会被写入数据，系统会自动回溯使用 2楼 的数据。
    if (!updates || Object.keys(updates).length === 0) {
      console.log(
        "[Anima] ⚠️ 检测到空更新 (No Changes)，保持继承状态，不执行写入。",
      );
      forceRefreshUI(); // 刷新 UI 以去除加载状态
      return true; // ✅ 流程结束
    }

    // 6. 准备合并数据
    // 只有到了这一步，确定有内容要写了，我们才去获取旧数据
    const oldAnimaData = structuredClone(baseStatus.data || {});

    // 【修改点 1】: 计算出最终的候选数据 (Candidate)
    let candidateData = deepMergeUpdates(
      structuredClone(oldAnimaData),
      updates,
    );

    // 7. Zod 校验
    try {
      candidateData = validateStatusData(candidateData, oldAnimaData);
      console.log("[Anima] Zod 校验通过 ✅");
      showStatusChangeToast(updates);
    } catch (validationError) {
      console.error("[Anima] Zod 校验拦截 🛑:", validationError.message);
      if (window.toastr) {
        window.toastr.error(
          `状态更新被拦截: ${validationError.message}`,
          "Anima 安全中心",
        );
      }
      forceRefreshUI();
      return false; // ❌ 终止：校验失败不写入
    }

    if (JSON.stringify(candidateData) === JSON.stringify(oldAnimaData)) {
      console.log(
        "[Anima] 🛑 状态数值无实质变化 (Data Unchanged)，跳过写入操作。",
      );
      forceRefreshUI(); // 移除加载动画
      return true; // 视为成功，但不产生副作用
    }
    // 8. 📝 最终写入 (只有这一行代码会修改数据库)
    await saveStatusToMessage(targetMsgId, { anima_data: candidateData });

    // 9. 成功后的事件广播
    const event = new CustomEvent("anima:status_updated", {
      detail: { msgId: targetMsgId },
    });
    window.dispatchEvent(event);
    console.log(`[Anima] Update Complete...`);
    return true;
  } catch (e) {
    // 🔥【关键修复 Q2】异常捕获
    // 这里捕获所有错误（包括 api.js 抛出的 401/500/空内容）
    // 只要进入 catch，绝对不执行写入。
    console.error("[Anima] Update failed (Exception):", e);

    // 显示更友好的错误提示 (e.message 现在会包含 api.js 传递的状态码)
    if (window.toastr) window.toastr.error("状态更新异常: " + e.message);

    forceRefreshUI();
    return false; // ❌ 终止：报错不写入
  }
}

/**
 * 【UI 专用】手动同步触发器
 * 逻辑：找到当前最新楼层，强制执行一次 update
 */
export async function triggerManualSync() {
  const targetMsg = getTargetAIFloor();

  if (!targetMsg) {
    if (window.toastr) window.toastr.warning("未找到有效的 AI 回复，无法同步");
    return false;
  }

  const targetId = targetMsg.message_id;

  if (window.toastr)
    window.toastr.info(`正在同步状态... (Target: #${targetId})`);

  return await triggerStatusUpdate(targetId);
}

// ==========================================
// 辅助功能
// ==========================================

export function getContext() {
  return SillyTavern.getContext();
}

export async function saveSettingsToCharacterCard(keyOrObj, data = null) {
  const context = getContext();
  const characterId = context.characterId;

  if (characterId === undefined || characterId === null) {
    if (window.toastr) toastr.warning("未检测到当前角色，无法保存到角色卡。");
    return false;
  }

  try {
    // 如果传入的是对象（批量保存模式）
    if (typeof keyOrObj === "object" && keyOrObj !== null) {
      for (const [k, v] of Object.entries(keyOrObj)) {
        await context.writeExtensionField(characterId, k, v);
      }
    } else {
      // 如果传入的是单个 Key（兼容旧模式）
      await context.writeExtensionField(characterId, keyOrObj, data);
    }

    if (window.toastr) toastr.success("配置已成功保存到角色卡！");
    return true;
  } catch (e) {
    console.error("Save to card failed:", e);
    return false;
  }
}

export function getSettingsFromCharacterCard(key) {
  const context = getContext();
  const characterId = context.characterId;
  if (characterId === undefined || characterId === null) return null;
  const character = context.characters[characterId];
  return character.data?.extensions?.[key] || null;
}

// 防线检查
// status_logic.js

// 确保在文件顶部导入了获取设置的函数
// import { getStatusSettings } from "./status_logic.js";
// (如果都在同一个文件里就不需要 import)

export function checkReplyIntegrity(content) {
  // 1. 基础防空检查 (放宽到长度 1，避免拦截单个 emoji 回复)
  if (!content || content.trim().length < 1) {
    console.warn("[Anima Defense] ⛔ 拦截：回复内容为空");
    return false;
  }

  const trimmedContent = content.trim();

  // ============================================================
  // A. 默认检测规则 (硬编码部分 - 你的原始列表)
  // ============================================================
  const defaultPunctuation = /[.!?。"”…—~>）\]\}＊*`]$/;
  if (defaultPunctuation.test(trimmedContent)) {
    return true; // 默认通过
  }

  // ============================================================
  // B. 自定义多符号检测规则 (UI 设置部分)
  // ============================================================
  const settings = getStatusSettings();
  const customStopRaw = settings.update_management?.stop_sequence || "";

  if (customStopRaw && customStopRaw.trim().length > 0) {
    // 1. 按逗号切割 (支持英文逗号 "," 和 中文逗号 "，")
    const customList = customStopRaw.split(/[,，]/);

    // 2. 遍历检查每一个自定义符号
    for (const item of customList) {
      const symbol = item.trim(); // 去除符号前后的空格

      // 跳过空项 (例如用户输入了 "a, ,b")
      if (!symbol) continue;

      // 3. 核心比对：检查回复是否以该符号结尾
      // 使用 endsWith 是最安全的，因为它不涉及正则转义问题
      if (trimmedContent.endsWith(symbol)) {
        // console.log(`[Anima Defense] ✅ 通过自定义符号放行: [${symbol}]`);
        return true; // 只要匹配中一个，立即放行
      }
    }
  }

  // ============================================================
  // C. 均未通过 -> 拦截
  // ============================================================
  const lastChar = trimmedContent.slice(-1); // 获取最后一个字符用于日志
  console.warn(
    `[Anima Defense] ⛔ 拦截：回复似乎被截断。结尾字符: [${lastChar}] (未匹配默认或自定义规则)`,
  );
  return false;
}

/**
 * 注入状态 (对应面板底部的 "Write to Current" 按钮)
 */
export async function injectStatusToChat(yamlText) {
  const statusObj = yamlToObject(yamlText);
  if (!statusObj) {
    if (window.toastr) window.toastr.warning("YAML 格式错误");
    return;
  }
  const chat = window.TavernHelper.getChatMessages("0-{{lastMessageId}}", {
    include_swipes: false,
  });
  if (!chat || chat.length === 0) return;
  const msgId = chat[chat.length - 1].message_id;
  await saveStatusToMessage(msgId, { anima_data: statusObj }, "manual_ui");

  if (window.toastr) window.toastr.success(`状态已更新到楼层 #${msgId}`);

  // 【建议】为了让 UI 立即响应，派发一个更新事件
  // 这样 status.js 里的监听器收到后会立即刷新面板，"源"就会变成本层
  const event = new CustomEvent("anima:status_updated", {
    detail: { msgId: msgId },
  });
  window.dispatchEvent(event);
}

// status_logic.js -> saveStatusToMessage

export async function saveStatusToMessage(
  msgId,
  fullStatusData,
  updateType = "auto",
) {
  if (msgId === undefined || msgId === null) {
    console.error("[Anima Debug] ❌ 写入失败：楼层 ID 无效 (undefined/null)");
    return;
  }
  /*console.group(`[Anima Trace] 正在尝试写入楼层 #${msgId}`);
  console.log("写入源 (updateType):", updateType);
  console.log("调用堆栈:", new Error().stack); // 🔥 这行代码会告诉你到底是谁调用的
  console.groupEnd();*/
  console.log(`[Anima Debug] 💾 准备写入状态到楼层 #${msgId}`);
  if (window.TavernHelper) {
    try {
      // 1. 获取聊天记录
      const msgs = window.TavernHelper.getChatMessages("0-{{lastMessageId}}", {
        include_swipes: false,
      });

      // 2. 找到目标消息
      const targetMsg = msgs.find(
        (m) => String(m.message_id) === String(msgId),
      );

      // 3. 【绝对防御】User 楼层禁写锁
      if (targetMsg) {
        const context = SillyTavern.getContext();
        const currentUserName = context.userName;

        // 判定是否为 User (名字匹配、Role匹配、is_user标志)
        const isUser =
          targetMsg.is_user === true ||
          targetMsg.role === "user" ||
          (targetMsg.name && targetMsg.name === currentUserName) ||
          (targetMsg.name && String(targetMsg.name).toLowerCase() === "you") || // 增加对 "You" 的检查
          (targetMsg.name && targetMsg.name === "User");

        if (isUser) {
          console.error(
            `[Anima Security] 🛑 严重拦截：阻止了向 User 楼层 (#${msgId}) 写入变量！来源: ${updateType}`,
          );
          try {
            const dirtyVars = window.TavernHelper.getVariables({
              type: "message",
              message_id: msgId,
            });
            if (dirtyVars && dirtyVars.anima_data) {
              console.warn(
                "[Anima Security] 🚔 顺手牵羊：发现 User 楼层已有脏数据，正在没收...",
              );
              const clean = { ...dirtyVars };
              delete clean.anima_data;
              window.TavernHelper.deleteVariable("anima_data", {
                type: "message",
                message_id: msgId,
              });
            }
          } catch (e) {}
          // 可以在这里加个 toastr 提示调试
          // if (window.toastr) window.toastr.warning(`Anima拦截：试图写入User层 #${msgId}`);
          return;
        }
      }
    } catch (e) {
      // 这里的 catch 必须紧跟在 try 的 } 后面，不能有任何其他代码隔开
      console.warn("[Anima Security] 安全检查时发生异常 (非致命):", e);
    }
  }

  if (!fullStatusData) {
    console.warn("[Anima Debug] ❌ 数据为空，取消写入");
    return;
  }
  // ============================================================
  // 🔥 新增步骤 A: 在写入前，先获取旧数据 (作为快照)
  // ============================================================
  let oldAnimaData = {};
  try {
    const oldVars = window.TavernHelper.getVariables({
      type: "message",
      message_id: msgId,
    });
    // 确保深拷贝，防止引用被后续操作修改
    if (oldVars && oldVars.anima_data) {
      oldAnimaData = JSON.parse(JSON.stringify(oldVars.anima_data));
    }
  } catch (e) {
    console.warn("[Anima] 获取旧数据失败，将视为第一次初始化", e);
  }
  // ============================================================
  try {
    // 1. 保存变量 (使用 variables.d.ts 中的 replaceVariables)
    // 注意：replaceVariables 在接口定义中返回 void (同步)，不需要 await，但加了也没事
    await window.TavernHelper.updateVariablesWith(
      (variables) => {
        // 确保我们将 fullStatusData 里的内容直接赋值给 variables
        // 这样如果 fullStatusData.anima_data 里少了某个 Key，variables 里也会对应消失
        if (fullStatusData && typeof fullStatusData === "object") {
          Object.assign(variables, fullStatusData);
        }
        return variables;
      },
      {
        type: "message",
        message_id: msgId,
      },
    );
    console.log(`[Anima Debug] ✅ 变量已保存到 Variable Manager`);
    // ============================================================
    // 🔥 新增步骤 B: 写入成功后，广播事件
    // ============================================================
    try {
      // 1. 从官方接口获取 eventSource
      const context = SillyTavern.getContext();
      const targetEventSource = context.eventSource;

      if (targetEventSource) {
        const newAnimaData = fullStatusData.anima_data || fullStatusData;

        // 2. 发射事件
        // 注意：官方文档推荐用 await，但这里我们不想阻塞主流程，直接调用即可
        targetEventSource.emit("ANIMA_VARIABLE_UPDATE_ENDED", {
          type: updateType, // 🟢 修改 2: 这里使用传入的参数，不再写死 "auto"
          messageId: msgId,
          oldData: oldAnimaData,
          newData: newAnimaData,
          timestamp: Date.now(),
        });
        console.log("[Anima] 📡 已成功广播事件: ANIMA_VARIABLE_UPDATE_ENDED");
      } else {
        console.warn(
          "[Anima] ⚠️ 依然找不到 eventSource，请检查 SillyTavern 版本",
        );
      }
    } catch (e) {
      console.warn("[Anima] 广播过程出错:", e);
    }
    // ============================================================
    // 2. 写入占位符到消息内容
    let targetMsgs = window.TavernHelper.getChatMessages(msgId);

    // 容错：如果按 ID 没拿到，尝试通过上下文刷新再找一次 (应对 Swipe 边缘情况)
    if (!targetMsgs || targetMsgs.length === 0) {
      console.warn(
        `[Anima Debug] ⚠️ 初次未找到消息 #${msgId}，尝试通过上下文刷新...`,
      );
      const ctx = SillyTavern.getContext();
      if (ctx.chat) {
        const found = ctx.chat.find((m) => m.message_id === msgId);
        if (found) targetMsgs = [found];
      }
    }

    if (targetMsgs && targetMsgs.length > 0) {
      // 根据 chat_message.d.ts，字段名是 message
      let originalContent = targetMsgs[0].message || "";
      const MACRO_TAG = `\n\n{{ANIMA_STATUS::${msgId}}}`;

      // 1. 构建期望的新文本 (先清理旧Tag，再追加新Tag)
      let cleanContent = originalContent
        .replace(/{{ANIMA_STATUS::\d+}}/g, "")
        .trimEnd();
      let newContent = cleanContent + MACRO_TAG;

      // 2. 核心判断：文本是否真的变了？
      // 如果 Tag 本来就在，newContent 会等于 originalContent
      if (newContent !== originalContent) {
        console.log(`[Anima Debug] 📝 内容有变化，执行文本更新...`);
        // 情况 A: 文本变了 (Tag 不存在或位置不对)，需要写入 message
        await window.TavernHelper.setChatMessages([
          {
            message_id: msgId,
            message: newContent,
          },
        ]); // refresh 默认为 'affected'
      } else {
        console.log(
          `[Anima Debug] 🔄 内容无变化，执行强制重绘 (Variables Changed)...`,
        );
        // 情况 B: 文本没变 (Tag 已存在)，但变量变了。
        // 根据接口文档：仅传递 message_id 即可触发重绘 (Re-render)
        // 不要传 message 字段，否则可能会因为“内容相同”而被内部跳过
        await window.TavernHelper.setChatMessages([
          {
            message_id: msgId,
          },
        ]);
      }

      console.log(`[Anima Debug] ✅ 消息 UI 刷新指令已发送`);
    } else {
      console.error(
        `[Anima Debug] ❌ 严重错误: 无法在聊天记录中找到楼层 #${msgId}，Tag 写入失败！`,
      );
    }

    // 3. 同步世界书
    await syncStatusToWorldBook(null, true);
  } catch (e) {
    console.error("[Anima Debug] 💥 写入过程发生异常:", e);
  }
}

export async function syncStatusToWorldBook(
  explicitSettings = null,
  forceCreate = false,
) {
  const settings = explicitSettings || getStatusSettings();
  const injectConfig = settings.injection_settings || {};
  // 这里使用 generic macro，指向 latest
  const finalContent =
    injectConfig.template || "{{format_message_variable::anima_data}}";

  const context = SillyTavern.getContext();
  if (!context.chatId) return;

  let wbName = await safeGetChatWorldbookName();
  if (!wbName) {
    // 【核心修改点】
    // 如果没有绑定世界书，且 forceCreate 为 false，则直接“懒惰退出”
    if (!forceCreate) {
      console.log("[Anima] 世界书尚未建立，且非强制写入模式，跳过状态注入。");
      return;
    }

    // 只有 forceCreate 为 true 时，才执行创建
    wbName = await window.TavernHelper.getOrCreateChatWorldbook(
      "current",
      context.chatId.replace(/\.(json|jsonl)$/i, ""),
    );
  }

  const entryData = {
    keys: ["anima_status", "status_injection"],
    content: finalContent,
    name: "[anima_status]",
    enabled: true,
    strategy: { type: "constant" },
    position: {
      type: injectConfig.position || "at_depth",
      depth: injectConfig.depth ?? 1,
      order: injectConfig.order ?? 100,
    },
    role:
      injectConfig.role === "user"
        ? 1
        : injectConfig.role === "assistant"
          ? 2
          : 0,
  };

  const entries = await window.TavernHelper.getWorldbook(wbName);
  const existing = entries.find((e) => e.name === "[anima_status]");

  if (existing) {
    await window.TavernHelper.updateWorldbookWith(wbName, (entries) => {
      const e = entries.find((x) => x.uid === existing.uid);
      if (e) Object.assign(e, entryData);
      return entries;
    });
  } else {
    await window.TavernHelper.createWorldbookEntries(wbName, [entryData]);
  }
}

export async function previewStatusPayload() {
  const contextData = getContextData();

  // 🌟 核心修复：使用统一的寻址函数，确保预览和实际发送的目标锚点完全一致
  const targetMsg = getTargetAIFloor();

  if (!targetMsg) throw new Error("未找到有效的 AI 楼层，无法生成预览");

  const settings = getStatusSettings();

  const { messages, incResult, baseStatus } = await constructStatusPrompt(
    settings,
    contextData,
    targetMsg.message_id,
  );

  return {
    incremental: incResult,
    messages: messages,
    sourceFloorId: baseStatus.id !== -1 ? baseStatus.id : "Initial (None)",
  };
}

// ==========================================
// 自动化处理
// ==========================================
let updateTimer = null;
let removeUIOverlay = null;

export function cancelStatusTimer(silent = false) {
  if (updateTimer) clearTimeout(updateTimer);
  if (removeUIOverlay) removeUIOverlay();
  updateTimer = null;
  removeUIOverlay = null;

  // 只有在非静默模式（即用户手动点击取消）时，才触发 UI 刷新
  if (!silent && window.$) {
    setTimeout(() => {
      $("#btn-refresh-status").trigger("click");
      console.log("[Anima] 🛑 用户取消更新，已自动触发面板刷新");
    }, 50);
  } else {
    // 系统自动调用时，只清理定时器，不碰 UI
    // console.log("[Anima] 🛑 计时器已静默重置");
  }
}

export async function handleStatusUpdate() {
  // 1. 清理旧状态
  cancelStatusTimer(true);

  // 2. 获取最新消息
  const msgs = window.TavernHelper.getChatMessages(-1);
  if (!msgs || msgs.length === 0) return;
  const lastMsg = msgs[0];
  const settings = getStatusSettings();

  // 3. 基础检查：开关是否开启、是否是 AI 消息等
  if (!settings.status_enabled) return;

  // 获取当前用户名，防止 is_user 字段缺失导致的误判
  const context = SillyTavern.getContext();
  const currentUserName = context.userName;

  // 综合判定：只要满足其中一条，就认为是 User 消息
  const isUser =
    lastMsg.is_user === true ||
    lastMsg.role === "user" ||
    (lastMsg.name && lastMsg.name === currentUserName) ||
    (lastMsg.name && String(lastMsg.name).toLowerCase() === "you");

  if (isUser) {
    console.warn(
      "[Anima Security] 🛑 拦截：最新楼层被判定为 User，停止状态更新。",
    );
    return; // ⛔ 绝对终止
  }

  // 检查回复完整性 (你的防线函数)
  // 注意：如果 checkReplyIntegrity 不在导出的范围内，请确保它在这个文件内能被访问
  if (
    typeof checkReplyIntegrity === "function" &&
    !checkReplyIntegrity(lastMsg.message || "")
  ) {
    return;
  }

  if (window.dispatchEvent) {
    window.dispatchEvent(
      new CustomEvent("anima:status_updated", {
        detail: { reason: "check_visibility" },
      }),
    );
  }

  // 4. 定义执行动作
  const executeUpdate = async () => {
    if (removeUIOverlay) removeUIOverlay();
    await triggerStatusUpdate(lastMsg.message_id);
  };

  // 5. 【核心修改】读取面板设置
  // 兼容旧配置：如果 update_management 不存在，默认视为 false (自动执行) 还是 true (倒计时)?
  // 根据你的描述："如果用户关闭了...则不会出现倒计时"，说明默认或者开启状态下是有倒计时的。
  const updateConfig = settings.update_management || {};
  const isPanelEnabled = updateConfig.panel_enabled === true;

  // 6. 分支逻辑
  if (isPanelEnabled) {
    createCountdownUI(5, executeUpdate, cancelStatusTimer);
  } else {
    // B. 关闭面板 -> 立即执行 -> 不显示未同步按钮
    // 这里不派发 anima:status_updated 事件，防止 UI 瞬间显示“未同步”按钮
    // 直接执行更新，更新完后 triggerStatusUpdate 内部会派发事件，UI 会刷新并显示最新数据
    await executeUpdate();
  }
}

function createCountdownUI(seconds, onConfirm, onCancel) {
  const existing = document.getElementById("anima-status-countdown");
  if (existing) existing.remove();

  const html = `
    <div id="anima-status-countdown" class="anima-floating-panel">
        <div class="anima-timer-bar"></div>
        <div class="anima-panel-content">
            <span>更新状态?</span>
            <div class="anima-btn-group">
                <button id="anima-btn-now" title="立即更新"><i class="fa-solid fa-check"></i></button>
                <button id="anima-btn-cancel" title="取消"><i class="fa-solid fa-xmark"></i></button>
            </div>
        </div>
        <div class="anima-countdown-text">${seconds}s</div>
    </div>
    <style>
        .anima-floating-panel {
            position: fixed; bottom: 120px; right: 20px; z-index: 10002;
            background: var(--smart-background, #ffffff); 
            background-color: var(--smart-background, #ffffff);
            
            border: 1px solid var(--smart-border-color);
            border-radius: 8px; padding: 8px 12px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5); /* 加深一点阴影 */
            display: flex; align-items: center; gap: 10px;
            animation: slideIn 0.3s ease-out; overflow: hidden;
            contain: layout;
            color: var(--smart-text-color, #373333); /* 确保文字颜色 */
        }
        @media (max-width: 768px) {
            .anima-floating-panel {
                bottom: auto; /* 取消底部定位 */
                top: 80px;    /* 改为顶部定位 (避开顶部Header) */
                right: 10px;  /* 稍微靠右 */
                max-width: 90%; /* 防止溢出屏幕 */
            }
        }
        .anima-timer-bar {
            position: absolute; bottom: 0; left: 0; height: 3px; background: #10b981;
            width: 100%; transition: width 1s linear;
        }
        .anima-panel-content { display: flex; align-items: center; gap: 10px; font-size: 0.9em; }
        .anima-btn-group { display: flex; gap: 5px; }
        .anima-btn-group button {
            background: transparent; border: 1px solid var(--smart-border-color);
            color: var(--smart-text-color); border-radius: 4px; cursor: pointer;
            padding: 4px 8px; transition: 0.2s;
        }
        .anima-btn-group button:hover { background: var(--smart-accent-color); color: white; }
        @keyframes slideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    </style>
    `;

  document.body.insertAdjacentHTML("beforeend", html);
  const panel = document.getElementById("anima-status-countdown");
  if (!panel) return;

  // 🟢 修复：使用 JSDoc 强制转换为 HTMLElement
  const timerBar = /** @type {HTMLElement} */ (
    panel.querySelector(".anima-timer-bar")
  );
  const textEl = /** @type {HTMLElement} */ (
    panel.querySelector(".anima-countdown-text")
  );
  const btnNow = /** @type {HTMLElement} */ (
    panel.querySelector("#anima-btn-now")
  );
  const btnCancel = /** @type {HTMLElement} */ (
    panel.querySelector("#anima-btn-cancel")
  );

  removeUIOverlay = () => {
    if (panel) panel.remove();
    updateTimer = null;
  };

  // 现在 onclick 不会报错了
  if (btnNow)
    btnNow.onclick = () => {
      clearTimeout(updateTimer);
      onConfirm();
    };
  if (btnCancel)
    btnCancel.onclick = () => {
      clearTimeout(updateTimer);
      onCancel();
    };

  let remaining = seconds;
  const tick = () => {
    // 🟢【新增】僵尸检查：如果面板已经被移除了（用户点了取消或外部清理了），直接停止
    if (!document.getElementById("anima-status-countdown")) {
      console.log("[Anima] 倒计时面板已消失，终止执行。");
      return;
    }

    remaining--;
    // innerText 和 style 也不报错了
    if (textEl) textEl.innerText = `${remaining}s`;
    if (timerBar) timerBar.style.width = `${(remaining / seconds) * 100}%`;

    if (remaining <= 0) {
      onConfirm();
    } else {
      updateTimer = setTimeout(tick, 1000);
    }
  };
  updateTimer = setTimeout(tick, 1000);
}

export function initStatusMacro() {
  if (!window.TavernHelper || !window.TavernHelper.registerMacroLike) return;
  const REGEX = /\{\{ANIMA_STATUS::(\d+)\}\}/g;
  window.TavernHelper.registerMacroLike(REGEX, (context, match, capturedId) => {
    const msgId = Number(capturedId);
    const settings = getStatusSettings();
    // 1. 基础检查
    if (!settings.beautify_settings?.enabled) return "";
    // 2. 获取原始变量
    const variables = window.TavernHelper.getVariables({
      type: "message",
      message_id: msgId,
    });
    // 3. 提取核心数据 (anima_data)
    // 这里做一个防御性处理，确保拿到的是对象
    let rawAnimaData = {};
    if (variables && variables.anima_data) {
      rawAnimaData = variables.anima_data;
    } else if (variables && Object.keys(variables).length > 0) {
      // 兼容某些极端情况，虽然通常变量都存在 anima_data 下
      rawAnimaData = variables;
    }
    // 4. 【关键修改】先检查数据是否为空 (判空逻辑前提)
    // 必须在 createRenderContext 之前判断！因为 createRenderContext 会注入 _user 导致对象永远非空
    if (!rawAnimaData || Object.keys(rawAnimaData).length === 0) {
      return `<div style="font-size:12px; color:gray;">[Anima: No Data]</div>`;
    }
    // 5. 【核心修改】创建标准化渲染上下文 (注入 _user, _char)
    const renderContext = createRenderContext(rawAnimaData);
    // 6. 渲染模板
    const beautify = settings.beautify_settings || {};
    let template = beautify.template || "";
    // 此时传入的 renderContext 已经包含了 { "_user": ..., "Player": ... }
    template = renderAnimaTemplate(template, renderContext);
    try {
      // 1. 变量替换
      let finalOutput = template.replace(/{{\s*([^\s}]+)\s*}}/g, (m, path) => {
        if (path.startsWith("key::")) {
          const targetPath = path.replace("key::", "").trim();

          // 尝试获取值
          let val = undefined;
          if (window["_"] && window["_"].get) {
            val = window["_"].get(renderContext, targetPath);
          } else {
            val = targetPath
              .split(".")
              .reduce((o, k) => (o || {})[k], renderContext);
          }

          // 情况 A: 这是一个对象 (且不是 null/数组)，说明它是个容器
          // 例如: key::世界 -> 返回 "时间, 当前地点, 天气"
          if (val && typeof val === "object" && !Array.isArray(val)) {
            return Object.keys(val).join(", ");
          }

          // 情况 B: 这是一个具体的值 (字符串/数字)，或者值不存在
          // 我们直接截取路径的最后一段作为 "Key名"
          // 例如: key::世界.时间 -> 返回 "时间"
          const segments = targetPath.split(".");
          return segments[segments.length - 1];
        }
        // A. 特殊硬编码路径处理
        if (path === "messageId") return msgId;
        if (path === "status" || path === "anima_data")
          return objectToYaml(renderContext);

        // B. 尝试从 本地状态数据 (renderContext/YAML) 中查找
        let val = undefined;
        if (window["_"] && window["_"].get) {
          val = window["_"].get(renderContext, path);
        } else {
          val = path.split(".").reduce((o, k) => (o || {})[k], renderContext);
        }

        // 如果在状态里找到了，直接返回
        if (val !== undefined) return val;

        // C. 【核心修复】如果没找到，尝试调用 processMacros 解析 ST 原生宏
        // 我们需要把 path (例如 "user") 还原成完整标签 "{{user}}" 传进去
        try {
          const rawTag = `{{${path}}}`;
          // 调用引入的工具函数
          const processed = processMacros(rawTag);

          // 如果 processMacros 返回的结果和输入不一样，说明被成功替换了
          // (例如 "{{user}}" 变成了 "Player")
          // 同时也排除了 processMacros 返回空字符串的情况
          if (processed && processed !== rawTag) {
            return processed;
          }
        } catch (err) {
          console.warn("[Anima] Macro fallback failed:", err);
        }

        // D. 实在找不到，显示 N/A
        return "N/A";
      });

      // 2. HTML 压缩 (消除空行间隙)
      finalOutput = finalOutput
        .replace(/[\r\n]+/g, "") // 去除换行
        .replace(/>\s+</g, "><") // 去除标签间空白
        .replace(/[\t ]+</g, "<") // 去除标签前空白
        .replace(/>[\t ]+/g, ">"); // 去除标签后空白

      // 3. 返回结果 (移除 pre-wrap)
      return `<div style="font-family: inherit; line-height: 1.5;">${finalOutput}</div>`;
    } catch (e) {
      console.error("[Anima Render Error]", e);
      return `<div style="color:red">Render Error: ${e.message}</div>`;
    }
  });
  window.TavernHelper.registerMacroLike(
    /\{\{ANIMA_BASE_STATUS(?:::(.*?))?\}\}/g,
    (context, match, keyPath) => {
      return resolveBaseStatusMacro(match, keyPath);
    },
  );
  const baseStatusRegex = /\{\{ANIMA_BASE_STATUS(?:::(.*?))?\}\}/g;
  const isRegistered = customMacroReplacers.some(
    (r) => r.regex.source === baseStatusRegex.source,
  );
  if (!isRegistered) {
    customMacroReplacers.push({
      regex: baseStatusRegex,
      replacer: (match, keyPath) => resolveBaseStatusMacro(match, keyPath),
    });
  }

  console.log("[Anima] Base Status Macro Registered.");
  registerAnimaHidingRegex();
  console.log("[Anima] Status Macro Registered.");
}

function registerAnimaHidingRegex() {
  if (!window.TavernHelper || !window.TavernHelper.updateTavernRegexesWith)
    return;
  const REGEX_NAME = "Anima Status Hider";
  const REGEX_STRING = /\{\{ANIMA_(STATUS::\d+|BASE_STATUS(?:::[^}]+)?)\}\}/g
    .source;
  window.TavernHelper.updateTavernRegexesWith((regexes) => {
    let existing = regexes.find((r) => r.script_name === REGEX_NAME);
    if (existing) {
      existing.enabled = true;
      existing.find_regex = REGEX_STRING;
      existing.replace_string = "";
      existing.source.ai_output = true;
      existing.source.user_input = true;
      existing.destination.display = false;
      existing.destination.prompt = true;
    } else {
      regexes.push({
        id: Date.now().toString(),
        script_name: REGEX_NAME,
        enabled: true,
        run_on_edit: true,
        scope: "global",
        find_regex: REGEX_STRING,
        replace_string: "",
        source: {
          user_input: true,
          ai_output: true,
          slash_command: false,
          world_info: false,
        },
        destination: { display: false, prompt: true },
        min_depth: null,
        max_depth: null,
      });
    }
    return regexes;
  });
  console.log("[Anima] Prompt hiding regex registered.");
}

// ==========================================
// 补全：UI 交互与数据获取接口
// ==========================================

/**
 * 获取指定楼层的变量状态 (供 UI 和 History 模块使用)
 * @param {number} msgId
 */
export function getStatusFromMessage(msgId) {
  try {
    if (!window.TavernHelper) return null;
    // 必须指定 type: 'message'
    return window.TavernHelper.getVariables({
      type: "message",
      message_id: msgId,
    });
  } catch (e) {
    return null;
  }
}

/**
 * 扫描聊天记录，返回所有包含状态信息的楼层列表
 * 用于 History 模块的“选择楼层”弹窗
 */
export function scanChatForStatus() {
  if (!window.TavernHelper) return [];

  let chat = [];
  try {
    chat = window.TavernHelper.getChatMessages("0-{{lastMessageId}}", {
      include_swipes: false,
    });
  } catch (e) {
    return [];
  }

  if (!chat || chat.length === 0) return [];

  const validFloors = [];

  // 倒序遍历
  for (let i = chat.length - 1; i >= 0; i--) {
    const msg = chat[i];
    const status = getStatusFromMessage(msg.message_id);

    // 只要变量存在且非空，就加入列表
    if (status && Object.keys(status).length > 0) {
      let preview = "Status Data";
      try {
        const keys = Object.keys(status).slice(0, 3).join(", ");
        preview = keys ? `{ ${keys}... }` : "Empty Object";
      } catch (e) {}

      validFloors.push({
        id: msg.message_id,
        role: msg.is_user ? "User" : "Char",
        preview: preview,
      });
    }
  }
  return validFloors;
}

/**
 * 获取最新楼层的实时变量 (用于 YAML 面板初始化)
 */
export function getRealtimeStatusVariables() {
  try {
    if (!window.TavernHelper) return {};
    const context = SillyTavern.getContext();
    // 如果没有加载聊天，直接返回空
    if (!context || !context.chatId) return {};

    const vars = window.TavernHelper.getVariables({
      type: "message",
      message_id: "latest",
    });
    return vars || {};
  } catch (e) {
    return {};
  }
}

/**
 * 保存实时变量到最新楼层 (修正融合版)
 * 1. 获取旧数据 (用于 Diff)
 * 2. 调用 saveStatusToMessage (确保 UI 刷新 & Tag 插入)
 * 3. 广播事件 (用于后端/世界书同步)
 */
export async function saveRealtimeStatusVariables(statusObj) {
  try {
    if (!window.TavernHelper) throw new Error("TavernHelper not ready");
    const context = SillyTavern.getContext();

    // 使用新的寻址函数
    const targetMsg = getTargetAIFloor();
    if (!targetMsg) {
      throw new Error("未找到有效的 AI 楼层，无法写入状态");
    }

    const targetId = targetMsg.message_id;

    // ============================================================
    // 🔥 恢复步骤 A: 获取旧数据 (Old Data)
    // ============================================================
    let oldAnimaData = {};
    try {
      // 建议直接用 targetId 获取，比 'latest' 更精准
      const oldVars = window.TavernHelper.getVariables({
        type: "message",
        message_id: targetId,
      });
      if (oldVars) {
        oldAnimaData = JSON.parse(JSON.stringify(oldVars));
      }
    } catch (e) {
      console.warn("[Anima] 获取旧数据失败:", e);
    }

    // ============================================================
    // 🔥 核心修改: 使用 saveStatusToMessage
    // 替代了原本的 replaceVariables。
    // 作用：写入变量 + 强制 UI 重绘 + 自动补全 {{ANIMA_STATUS}} Tag
    // ============================================================
    console.log(`[Anima] 实时状态编辑 -> 写入楼层 #${targetId}`);

    // 注意：saveStatusToMessage 内部会处理 anima_data 包裹
    // 如果 statusObj 已经是 { anima_data: ... }，请确保 saveStatusToMessage 能处理
    // 通常 saveStatusToMessage(id, data) 的 data 应该是不带 anima_data 前缀的纯对象？
    // *修正*: 根据你之前的代码上下文，这里传入 statusObj 即可，
    // 如果 statusObj 包含了 anima_data key，请确保 saveStatusToMessage 逻辑匹配。
    // 假设 statusObj 是 { 欧阳玥: {...} } 这种纯数据:
    await saveStatusToMessage(targetId, statusObj, "manual_ui");

    // ============================================================
    // 🔥 恢复步骤 B: 广播事件 (Broadcast)
    // ============================================================
    try {
      const targetEventSource = context.eventSource;

      if (targetEventSource) {
        targetEventSource.emit("ANIMA_VARIABLE_UPDATE_ENDED", {
          type: "manual_ui",
          messageId: targetId, // 明确传 ID
          oldData: oldAnimaData,
          newData: statusObj,
          timestamp: Date.now(),
        });
        console.log("[Anima] 📡 UI 手动更新事件已广播 (带 Diff 数据)");
      }
    } catch (e) {
      console.warn("[Anima] UI 广播出错:", e);
    }

    return true;
  } catch (e) {
    console.error("[Anima] Save Realtime failed:", e);
    throw e;
  }
}

/**
 * 【优化版】将增量对象美化并输出为 Toast 通知
 */
function showStatusChangeToast(updates) {
  const settings = getStatusSettings();
  const isPanelEnabled = settings.update_management?.panel_enabled === true;

  if (!isPanelEnabled) {
    console.log("[Anima] 状态更新面板已关闭，跳过变更通知弹窗");
    return;
  }
  if (!updates || Object.keys(updates).length === 0) {
    console.log("[Anima] 没有检测到变更内容，跳过通知");
    return;
  }

  console.log("[Anima] 准备显示变更通知:", updates);

  const changes = [];
  // 递归处理嵌套对象，展平路径 (例如 NPC.Sam.HP)
  const walk = (obj, path = "") => {
    for (let key in obj) {
      const newPath = path ? `${path}.${key}` : key;
      if (
        typeof obj[key] === "object" &&
        obj[key] !== null &&
        !Array.isArray(obj[key])
      ) {
        walk(obj[key], newPath);
      } else {
        if (key.startsWith("_")) continue;
        // 美化路径显示
        const displayName = `<span style="color: #ffffff; font-weight: bold;">${newPath}</span>`;
        changes.push(`${displayName}: ${obj[key]}`);
      }
    }
  };
  walk(updates);

  if (changes.length === 0) return;

  // 组装 HTML
  const htmlContent = `
        <div style="text-align: left; font-size: 13px; line-height: 1.5;">
            <div style="margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 4px; font-weight: bold; color:var(--anima-primary);">
                <i class="fa-solid fa-bolt-lightning"></i> 状态数值变更
            </div>
            <div style="max-height: 80px; overflow-y: auto;">
                ${changes.join("<br>")}
            </div>
        </div>
    `;

  if (window.toastr) {
    // 使用 info 类型，并关闭重复过滤
    window.toastr.info(htmlContent, null, {
      progressBar: true,
      escapeHtml: false,
      preventDuplicates: false, // 允许显示重复内容的通知
      closeButton: true,
    });
  }
}

/**
 * 递归处理对象中的 ST 宏
 */
function deepProcessMacros(obj) {
  // 1. 如果是字符串，直接执行宏替换
  if (typeof obj === "string") {
    return processMacros(obj);
  }

  // 2. 如果是数组，递归处理每一项
  if (Array.isArray(obj)) {
    return obj.map((item) => deepProcessMacros(item));
  }

  // 3. 如果是对象，递归处理 Key 和 Value
  if (typeof obj === "object" && obj !== null) {
    const newObj = {};
    for (const key in obj) {
      // 🔥 核心修复：
      // 之前的代码是: newObj[key] = ... (导致 Key 里的宏没被替换)
      // 现在的代码是: 先把 Key 拿去跑一遍 processMacros
      const newKey = processMacros(key);

      // 递归处理值，并赋值给新的 Key
      newObj[newKey] = deepProcessMacros(obj[key]);
    }
    return newObj;
  }

  // 4. 其他类型直接返回
  return obj;
}

/**
 * 处理开场白 Swipe 事件 (核心逻辑)
 * @param {boolean} isSilent - 是否静默执行 (不显示 Toast)
 */
export async function handleGreetingSwipe(isSilent = false) {
  try {
    // 1. 获取 Layer 0 的当前内容
    const msgs = window.TavernHelper.getChatMessages(0);
    if (!msgs || msgs.length === 0) return;

    // 🟢 辅助函数：标准化文本 (移除 \r，统一换行符，移除首尾空白)
    const normalizeText = (str) => {
      if (!str) return "";
      return str.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    };

    // 获取聊天记录里的文本 (并标准化)
    const rawMsgContent = msgs[0].message || "";
    const targetText = normalizeText(rawMsgContent);

    // 2. 获取角色卡原始数据
    const charData = window.TavernHelper.getCharData("current");
    if (!charData) return;

    // 3. 比对文本，确定 Index
    let matchedIndex = -1;

    // 3.1 比对 First Message
    const rawFirstMes = charData.first_mes || "";
    // 先处理宏 (比如 {{user}})，再标准化
    const processedFirst = processMacros(rawFirstMes);

    // 🛠️ Debug: 如果还是匹配不上，可以在控制台打印这两行看看长度是否一致
    // console.log("Chat Len:", targetText.length, "Card Len:", normalizeText(processedFirst).length);

    if (normalizeText(processedFirst) === targetText) {
      matchedIndex = 0;
    } else if (
      charData.data &&
      Array.isArray(charData.data.alternate_greetings)
    ) {
      // 3.2 循环比对 Alternate Greetings
      for (let i = 0; i < charData.data.alternate_greetings.length; i++) {
        const rawAlt = charData.data.alternate_greetings[i] || "";
        const processedAlt = processMacros(rawAlt);

        if (normalizeText(processedAlt) === targetText) {
          matchedIndex = i + 1;
          break;
        }
      }
    }

    // 修正：如果比对完全失败，尝试一种“宽松模式” (可选)
    // 有时候 ST 会把 markdown 图片链接里的特殊符号转义，导致严格全等失败
    // 如果你的开场白非常长（像你提供的那个），可以用包含检测作为兜底
    if (matchedIndex === -1 && targetText.length > 50) {
      // 取前 50 个字符进行模糊匹配
      const shortTarget = targetText.substring(0, 50);

      const pFirst = normalizeText(processMacros(rawFirstMes));
      if (pFirst.startsWith(shortTarget)) matchedIndex = 0;
      else if (
        charData.data &&
        Array.isArray(charData.data.alternate_greetings)
      ) {
        for (let i = 0; i < charData.data.alternate_greetings.length; i++) {
          const pAlt = normalizeText(
            processMacros(charData.data.alternate_greetings[i] || ""),
          );
          if (pAlt.startsWith(shortTarget)) {
            matchedIndex = i + 1;
            break;
          }
        }
      }
    }

    // 如果连开场白索引都没匹配到
    if (matchedIndex === -1) {
      console.log("[Anima] 未匹配到已知开场白 (可能是自定义内容或宏解析差异)");
      // Debug: 打印出来对比
      console.log("Target (Chat):", targetText.substring(0, 20) + "...");
      return;
    }

    // 4. 读取预设配置
    const settings = getStatusSettings();
    const presets = settings.greeting_presets || {};
    const targetStatus = presets[matchedIndex];

    // 5. 注入状态 (如果有预设)
    if (targetStatus) {
      console.log(
        `[Anima] 应用 Index ${matchedIndex} 的开场白状态预设 (Silent: ${isSilent})`,
      );

      // ✅ 修改点：先进行深度宏替换，再写入
      // 这解决了 {{user}} 变成 [object Object] 或不被翻译的问题
      const processedStatus = deepProcessMacros(targetStatus);

      // 使用处理后的数据写入
      await saveStatusToMessage(0, { anima_data: processedStatus });

      // 只有确实写入了数据且非静默模式，才弹窗提示成功
      if (!isSilent && window.toastr) {
        window.toastr.success(`已应用开场白 #${matchedIndex} 的初始状态`);
      }
    } else {
      console.log(
        `[Anima] 开场白 #${matchedIndex} 未配置预设，准备刷新 UI 以反映空状态。`,
      );
    }

    // 6. 【核心修复】强制刷新 UI
    // 无论是否写入了新数据，都必须通知 UI 重新读取当前楼层
    // 如果写入了，UI 会显示新变量；如果没写入，UI 会清空显示并弹出同步按钮
    setTimeout(() => {
      const event = new CustomEvent("anima:status_updated", {
        detail: { msgId: 0, reason: "greeting_swipe" },
      });
      window.dispatchEvent(event);
    }, 50);
  } catch (e) {
    console.error("[Anima] 处理开场白状态失败:", e);
  }
}

/**
 * 【新增】聊天加载时的初始检查
 * 逻辑：检查当前聊天是否只有 1 条消息 (Layer 0)，且是 Assistant 发送的。
 * 如果是，则尝试匹配并注入初始变量。
 */
export function checkInitialGreetingStatus() {
  // 1. 获取最新消息
  const latestMsgs = window.TavernHelper.getChatMessages("latest");

  // 如果读不到消息，返回 false，让调用方知道需要重试
  if (!latestMsgs || latestMsgs.length === 0) {
    // console.log("[Anima] Chat not ready yet...");
    return false;
  }

  const lastMsg = latestMsgs[0];
  const currentId = Number(lastMsg.message_id);

  // 调试日志：看看 ID 和 User 状态
  // console.log(`[Anima] Check Init: ID=${currentId}, User=${lastMsg.is_user}`);

  if (currentId === 0 && !lastMsg.is_user) {
    console.log("[Anima] 检测到初始开场白场景，执行状态检查...");
    handleGreetingSwipe(true);
    return true; // 成功执行
  }

  return true; // 读到了消息但条件不符，也算“检查完成”
}

/**
 * 增强型模板渲染器 (支持 {{#each}} 和 {{#if}} 条件判断)
 * @param {string} template - 原始模板字符串
 * @param {object} contextData - 完整的数据上下文 (root)
 */
export function renderAnimaTemplate(template, contextData) {
  if (!template) return "";
  let output = template;

  // ========================================================
  // 🌟 核心辅助：动态路径转换引擎
  // 完美复刻你的逻辑：自动把 _char 替换为当前真实的 {{char}} 名字
  // ========================================================
  const resolveDynamicPath = (rawPath) => {
    let p = rawPath.trim();
    if (p.startsWith("_char.") && typeof processMacros !== "undefined") {
      const charName = processMacros("{{char}}");
      if (charName && charName !== "{{char}}") {
        p = p.replace("_char.", charName + ".");
      }
    } else if (p.startsWith("_user.") && typeof processMacros !== "undefined") {
      const userName = processMacros("{{user}}");
      if (userName && userName !== "{{user}}") {
        p = p.replace("_user.", userName + ".");
      }
    }
    return p;
  };

  // ========================================================
  // 1. 处理 {{#each path}} ... {{/each}} 循环
  // ========================================================
  // 究极正则：无视内部空格
  const eachRegex =
    /\{\{\s*#each\s+([^}]+?)\s*\}\}([\s\S]*?)\{\{\s*\/each\s*\}\}/g;

  output = output.replace(eachRegex, (match, path, content) => {
    const cleanPath = resolveDynamicPath(path);

    let targetData = undefined;
    if (window["_"] && window["_"].get) {
      targetData = window["_"].get(contextData, cleanPath);
    } else {
      targetData = cleanPath
        .split(".")
        .reduce((o, k) => (o || {})[k], contextData);
    }

    if (!targetData || typeof targetData !== "object") return "";

    let loopResult = "";
    const keys = Object.keys(targetData);

    keys.forEach((key) => {
      const itemData = targetData[key];
      let itemHtml = content;

      itemHtml = itemHtml.replace(/\{\{@key\}\}/g, key);
      if (typeof itemData !== "object") {
        itemHtml = itemHtml.replace(/\{\{this\}\}/g, itemData);
      }
      itemHtml = itemHtml.replace(/\{\{\s*([^\s}]+)\s*\}\}/g, (m, propPath) => {
        if (propPath === "@key") return key;
        let val = undefined;
        if (typeof itemData === "object" && itemData !== null) {
          if (window["_"] && window["_"].get) {
            val = window["_"].get(itemData, propPath);
          } else {
            val = propPath.split(".").reduce((o, k) => (o || {})[k], itemData);
          }
        }
        return val !== undefined ? val : m;
      });
      loopResult += itemHtml;
    });
    return loopResult;
  });

  // ========================================================
  // 2. 处理 {{#if path}} ... {{else}} ... {{/if}}
  // ========================================================
  // 究极正则：无视标签内的任何换行和空格
  const ifRegex = /\{\{#if\s+([^\}]+)\}\}([\s\S]*?)\{\{\/if\}\}/g;

  output = output.replace(ifRegex, (match, condition, innerContent) => {
    // 1. 手动拆分 true 块和 false 块
    let trueContent = innerContent;
    let falseContent = "";
    const elseIndex = innerContent.indexOf("{{else}}");
    if (elseIndex !== -1) {
      trueContent = innerContent.substring(0, elseIndex);
      falseContent = innerContent.substring(elseIndex + 8);
    }

    // --- 内部辅助函数：处理单一基础条件 (如 A >= B) ---
    const evaluateSingle = (singleCond) => {
      let targetPath = singleCond.trim();
      let expectedValue = undefined;
      let operator = null;

      // 匹配操作符
      const opMatch = targetPath.match(/(==|!=|>=|<=|>|<)/);
      if (opMatch) {
        operator = opMatch[0];
        const parts = targetPath.split(operator);
        targetPath = parts[0].trim();
        expectedValue = parts[1].trim().replace(/^["']|["']$/g, "");
      }

      // 获取变量真实值
      let targetData = undefined;
      if (window["_"] && window["_"].get) {
        targetData = window["_"].get(contextData, targetPath);
      } else {
        targetData = targetPath
          .split(".")
          .reduce((o, k) => (o || {})[k], contextData);
      }

      let isTruthy = false;

      if (operator) {
        if (targetData !== undefined && targetData !== null) {
          let left = targetData;
          let right = expectedValue;

          const numLeft = Number(left);
          const numRight = Number(right);

          if (!isNaN(numLeft) && !isNaN(numRight) && right !== "") {
            left = numLeft;
            right = numRight;
          } else {
            left = String(left).trim();
            right = String(right).trim();
            if (right === "true") right = true;
            if (right === "false") right = false;
            if (left === "true") left = true;
            if (left === "false") left = false;
          }

          switch (operator) {
            case "==":
              isTruthy = left == right;
              break;
            case "!=":
              isTruthy = left != right;
              break;
            case ">":
              isTruthy = left > right;
              break;
            case "<":
              isTruthy = left < right;
              break;
            case ">=":
              isTruthy = left >= right;
              break;
            case "<=":
              isTruthy = left <= right;
              break;
          }
        }
      } else {
        isTruthy =
          targetData !== undefined &&
          targetData !== null &&
          targetData !== "" &&
          targetData !== "null" &&
          targetData !== "false" &&
          targetData !== "N/A";
      }
      return isTruthy;
    };

    // --- 核心逻辑：处理 && 和 || 运算符 ---
    // 先按 || 切分，再按 && 切分，天然实现了 && 优先级高于 || 的特性
    let finalResult = false;

    // 1. 按 || 切分为多个大组
    const orGroups = condition.split("||");

    for (const orGroup of orGroups) {
      // 2. 按 && 切分每个大组里的独立条件
      const andConditions = orGroup.split("&&");
      let groupResult = true; // 假设这个大组默认通过

      for (const andCond of andConditions) {
        // 只要其中一个 AND 条件不满足，整个大组就失败
        if (!evaluateSingle(andCond)) {
          groupResult = false;
          break; // 短路机制：后面的 AND 不用算了
        }
      }

      // 如果这个大组所有 AND 都通过了，那整个语句就是 true！
      if (groupResult) {
        finalResult = true;
        break; // 短路机制：后面的 OR 大组不用算了
      }
    }

    // 返回对应代码块
    if (finalResult) {
      return trueContent;
    } else {
      return falseContent;
    }
  });

  return output;
}
// ==========================================
// 状态清洗 (GC) 核心执行逻辑
// ==========================================

/**
 * 1. 提取并清洗 GC 专属上下文 (严格复刻 status_gc_ui.js 逻辑)
 */
export function getCleanedContextForGC(floors, gcConfig) {
  if (!window.TavernHelper) return [];
  const allMsgs = window.TavernHelper.getChatMessages("0-{{lastMessageId}}", {
    include_swipes: false,
  });
  if (!allMsgs || allMsgs.length === 0) return [];

  const msgs = allMsgs.slice(-Math.abs(floors));
  if (msgs.length === 0) return [];

  let processedMsgs = [];
  let activeRegexList = [];
  let activeSkipZero = false;
  let activeSkipUser = false;
  let activeExcludeUser = false;

  if (gcConfig.reuse_regex) {
    const globalSettings = getStatusSettings();
    const globalRegexConfig = globalSettings.regex_settings || {};
    activeRegexList = globalRegexConfig.regex_list || [];
    activeSkipZero = globalRegexConfig.skip_layer_zero || false;
    activeSkipUser = globalRegexConfig.regex_skip_user || false;
    activeExcludeUser = globalRegexConfig.exclude_user || false;
  } else {
    activeRegexList = gcConfig.regex_list || [];
    activeSkipZero = gcConfig.skip_layer_zero || false;
    activeSkipUser = gcConfig.regex_skip_user || false;
    activeExcludeUser = gcConfig.exclude_user || false;
  }

  const validRegexes = [];
  activeRegexList.forEach((r) => {
    if (!r) return;
    let val =
      r.regex || r.content || r.pattern || (typeof r === "string" ? r : "");
    let type = r.type || "extract";
    if (val) validRegexes.push({ type: type, regex: String(val) });
  });

  msgs.forEach((msg) => {
    const isUser = msg.is_user || msg.role === "user";
    if (activeExcludeUser && isUser) return;

    let content = msg.message || "";
    if (content && typeof processMacros !== "undefined") {
      content = processMacros(content);
    }

    const cleanRegex = /^[\s\r\n]*(&gt;|>)[\s\r\n]*/i;
    while (cleanRegex.test(content)) {
      content = content.replace(cleanRegex, "");
    }
    content = content.trim();
    if (!content) return;

    let isSkipped = false;
    if (activeSkipZero && String(msg.message_id) === "0") isSkipped = true;
    if (activeSkipUser && isUser) isSkipped = true;

    if (!isSkipped && validRegexes.length > 0) {
      if (typeof applyRegexRules !== "undefined") {
        content = applyRegexRules(content, validRegexes);
      }
      content = content.trim();
    }

    if (content) {
      processedMsgs.push({
        role: msg.role || (isUser ? "user" : "assistant"),
        displayContent: content,
      });
    }
  });

  return processedMsgs;
}

/**
 * 2. 组装发送给 LLM 的 Messages 数组与获取基准楼层
 */
export async function buildGCPayload() {
  const { gcConfig, gcPrompts } = getGCSettings();
  const messages = [];

  // 1. 获取基准楼层与状态
  let baseStatus = { id: -1, data: {} };
  let targetWriteId = -1; // 【新增】专门用于记录最终要写入的目标楼层

  const allMsgs = window.TavernHelper.getChatMessages("0-{{lastMessageId}}", {
    include_swipes: false,
  });

  if (allMsgs && allMsgs.length > 0) {
    // 【新增】智能寻找最近的 AI 楼层作为写入目标，防止触发你的 User 楼层禁写锁
    let targetMsg = allMsgs[allMsgs.length - 1];
    const context = SillyTavern.getContext();
    const currentUserName = context.userName;

    // 判定最新楼层是否为 User
    let isUser =
      targetMsg.is_user === true ||
      targetMsg.role === "user" ||
      (targetMsg.name && targetMsg.name === currentUserName) ||
      (targetMsg.name && String(targetMsg.name).toLowerCase() === "you");

    if (isUser) {
      // 如果最新是 User (比如玩家刚发完话就点清洗)，往上找一层 AI
      for (let i = allMsgs.length - 2; i >= 0; i--) {
        const m = allMsgs[i];
        const mIsUser =
          m.is_user === true ||
          m.role === "user" ||
          m.name === currentUserName ||
          String(m.name).toLowerCase() === "you";
        if (!mIsUser) {
          targetMsg = m;
          break;
        }
      }
    }

    targetWriteId = targetMsg.message_id;

    // 查找状态数据 (以 targetWriteId 为起点回溯)
    const vars = window.TavernHelper.getVariables({
      type: "message",
      message_id: targetWriteId,
    });

    if (vars && vars.anima_data && Object.keys(vars.anima_data).length > 0) {
      baseStatus = { id: targetWriteId, data: vars.anima_data };
    } else {
      // 找不到就往上回溯，比如回溯到了 30 楼
      baseStatus = findBaseStatus(targetWriteId);
    }
  }

  let currentStatusYaml =
    baseStatus.id !== -1 ? objectToYaml(baseStatus.data) : "# 初始状态 (Init)";

  // 2. 精准获取角色与用户数据
  const { charDesc, userPersona } = getContextData();

  // 3. 严格按照 GC UI 显示的内容组装
  for (const rule of gcPrompts) {
    if (rule.enabled === false) continue;

    let finalContent = "";
    let role = rule.role || "system";

    if (rule.type === "char_info") {
      role = "system";
      if (charDesc) finalContent = processMacros(charDesc);
    } else if (rule.type === "user_info") {
      role = "system";
      if (userPersona) finalContent = processMacros(userPersona);
    } else if (rule.type === "status_placeholder") {
      role = "system";
      finalContent = currentStatusYaml;
    } else if (rule.type === "chat_context_placeholder") {
      role = "user";
      // 这里的逻辑不用改，它本身就是截取最底部的最新 N 楼
      const contextArray = getCleanedContextForGC(rule.floors || 30, gcConfig);
      if (contextArray.length > 0) {
        finalContent = contextArray
          .map((m) => {
            const roleName = m.role ? m.role.toUpperCase() : "UNKNOWN";
            return `[${roleName}]\n${m.displayContent}`;
          })
          .join("\n\n");
      } else {
        finalContent = "⚠️ 无增量消息 (或已被正则完全过滤)";
      }
    } else {
      finalContent = processMacros(rule.content || "");
    }

    if (finalContent) {
      if (messages.length > 0 && messages[messages.length - 1].role === role) {
        messages[messages.length - 1].content += `\n\n${finalContent}`;
      } else {
        messages.push({ role, content: finalContent });
      }
    }
  }

  // 【修改】将 targetWriteId 一起返回给执行函数
  return { messages, baseStatus, targetWriteId };
}

/**
 * 3. 供前端 UI 调用的主执行函数
 */
export async function executeGCProcess() {
  // 【修改】接收 targetWriteId
  const { messages, baseStatus, targetWriteId } = await buildGCPayload();

  if (!messages || messages.length === 0) {
    throw new Error("生成的清洗提示词为空");
  }

  // 0. 严格调用 llm API (总结模型)
  const responseText = await generateText(messages, "llm");

  if (!responseText) {
    throw new Error("模型返回内容为空");
  }

  console.log("[Anima GC] LLM 原始返回:", responseText);

  // 1. 提取 JSON 增量更新
  const rawResult = extractJsonResult(responseText);
  let updates = {};
  if (rawResult) {
    const payload =
      Array.isArray(rawResult) && rawResult.length > 0
        ? rawResult[0]
        : rawResult;
    updates = payload.updates || payload;
  } else {
    throw new Error("未能从 LLM 回复中解析出有效的 JSON");
  }

  console.log("[Anima GC] 提取到的增量更新 JSON:", updates);

  // 2. 将增量 JSON 与旧状态合并
  const mergedData = deepMergeUpdates(
    structuredClone(baseStatus.data || {}),
    updates,
  );

  // 3. 转换为 YAML 以便 UI 显示
  const cleanYaml = objectToYaml(mergedData);

  return {
    yaml: cleanYaml,
    // 【核心修改】将写入目标指向最新层 (如 32)，如果没找到最新层才兜底用旧层
    targetMsgId: targetWriteId !== -1 ? targetWriteId : baseStatus.id,
  };
}

// 1. 把提取数据的核心逻辑抽离成独立函数
export function resolveBaseStatusMacro(match, keyPath) {
  const ctx = SillyTavern.getContext();
  const chat = ctx.chat || [];
  if (chat.length === 0) return keyPath ? "" : "{}";

  const lastMsg = chat[chat.length - 1];
  const currentId =
    lastMsg.message_id !== undefined ? lastMsg.message_id : chat.length - 1;

  const base = findBaseStatus(currentId); // 确保 findBaseStatus 在你的作用域内可用
  const baseData = base.id !== -1 && base.data ? base.data : {};

  if (keyPath && keyPath.trim()) {
    const contextData = createRenderContext(baseData);
    const cleanPath = keyPath.trim();
    let val = undefined;
    const lodash = /** @type {any} */ (window)["_"];

    if (lodash && lodash.get) {
      val = lodash.get(contextData, cleanPath);
    } else {
      val = cleanPath.split(".").reduce((o, k) => (o || {})[k], contextData);
    }

    if (val === undefined) return "";
    if (typeof val === "object") {
      return objectToYaml(val).trim();
    }
    return String(val);
  } else {
    return Object.keys(baseData).length > 0 ? objectToYaml(baseData) : "{}";
  }
}
