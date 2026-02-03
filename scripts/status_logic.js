import { validateStatusData } from "./status_zod.js";
import {
  getContextData,
  processMacros,
  extractJsonResult,
  deepMergeUpdates,
  objectToYaml,
  yamlToObject,
  applyRegexRules,
} from "./utils.js";
import { generateText } from "./api.js";

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
    depth: 4,
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

  // 1. 【修复】直接从上下文获取聊天长度，构建真实的数字范围字符串
  // 避免使用 "0-{{lastMessageId}}" 这种在 JS 里无效的占位符
  const context = SillyTavern.getContext();
  const chatLen = context.chat ? context.chat.length : 0;
  if (chatLen === 0) return { id: -1, data: {} };

  // 获取全部消息 (或者取最近的50条足矣)
  const range = `0-${Math.max(0, chatLen - 1)}`;
  const allChat = window.TavernHelper.getChatMessages(range, {
    include_swipes: false,
  });

  if (!allChat || allChat.length === 0) return { id: -1, data: {} };

  // 2. 找到目标楼层的索引
  const targetIndex = allChat.findIndex((m) => m.message_id === targetMsgId);

  // 如果找不到 target (比如它是最新的还没存进去)，就从最后一条开始往前找
  let searchStartIndex =
    targetIndex !== -1 ? targetIndex - 1 : allChat.length - 1;

  // 3. 倒序查找
  for (let i = searchStartIndex; i >= 0; i--) {
    const msg = allChat[i];
    // 跳过无效消息
    if (!msg) continue;

    const vars = window.TavernHelper.getVariables({
      type: "message",
      message_id: msg.message_id,
    });

    // 只要 anima_data 存在 (哪怕是空对象)，就视为有效基准
    if (vars && vars.anima_data) {
      return { id: msg.message_id, data: vars.anima_data };
    }
  }

  return { id: -1, data: {} };
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
    let finalContent = rule.content;

    // A. 特殊占位符处理
    if (finalContent === "{{chat_context}}") {
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
  };

  if (!messages || messages.length === 0) return false;

  try {
    // 1. 请求 API
    const responseText = await generateText(messages, "status");

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
  // 1. 获取上下文中的聊天列表
  // 使用 getChatMessages("0-{{lastMessageId}}") 是最稳健的方法，因为它会处理 swipes 和当前上下文
  const msgs = window.TavernHelper.getChatMessages("0-{{lastMessageId}}", {
    include_swipes: false,
  });

  if (!msgs || msgs.length === 0) {
    if (window.toastr) window.toastr.warning("无聊天记录，无法同步");
    return;
  }

  // 2. 锁定目标：最新的一条消息
  const lastMsg = msgs[msgs.length - 1];
  const targetId = lastMsg.message_id;

  if (window.toastr)
    window.toastr.info(`正在同步状态... (Target: #${targetId})`);

  // 3. 触发更新 (透传返回值)
  return await triggerStatusUpdate(targetId); // 🟢 改动：加了 return
}

// ==========================================
// 辅助功能
// ==========================================

export function getContext() {
  return SillyTavern.getContext();
}

export async function saveSettingsToCharacterCard(key, data) {
  const context = getContext();
  const characterId = context.characterId;
  if (characterId === undefined || characterId === null) {
    toastr.warning("未检测到当前角色，无法保存到角色卡。");
    return false;
  }
  try {
    await context.writeExtensionField(characterId, key, data);
    toastr.success("配置已成功保存到角色卡！");
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
export function checkReplyIntegrity(content) {
  if (!content || content.trim().length < 5) {
    console.warn("[Anima Defense] ⛔ 拦截：回复内容为空或过短");
    return false;
  }
  const stopPunctuation = /[.!?。"”…—~>）\]\}＊*`]$/;
  if (!stopPunctuation.test(content.trim())) {
    const lastChar = content.trim().slice(-1);
    console.warn(
      `[Anima Defense] ⛔ 拦截：回复似乎被截断。结尾字符: [${lastChar}]`,
    );
    return false;
  }
  return true;
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
  console.log(`[Anima Debug] 💾 准备写入状态到楼层 #${msgId}`);

  if (window.TavernHelper) {
    try {
      // 获取目标消息的元数据
      const msgs = window.TavernHelper.getChatMessages("0-{{lastMessageId}}", {
        include_swipes: false,
      });
      // 兼容 msgId 可能是字符串或数字的情况
      const targetMsg = msgs.find(
        (m) => String(m.message_id) === String(msgId),
      );

      if (targetMsg) {
        // 检查是否为 User (is_user 为 true，或者 role 为 'user')
        // 注意：有时 is_user 可能是 undefined，所以要多重检查
        const isUser = targetMsg.is_user || targetMsg.role === "user";

        if (isUser) {
          console.error(
            `[Anima Security] 🛑 严重警告：拦截了一次向 User 楼层 (#${msgId}) 写入变量的尝试！请求来源: ${updateType}`,
          );

          // 如果是 UI 手动触发的（比如你强行要写），可以放行（可选），但建议默认拦截
          // 如果你想允许手动编辑历史记录里的 User 楼层，可以加: if (updateType !== 'manual_ui') return;
          // 但为了安全，建议全部拦截：
          if (window.toastr)
            window.toastr.warning(
              `安全拦截：禁止向 User 楼层 (#${msgId}) 写入状态`,
            );
          return; // ❌ 直接终止，不执行后续写入
        }
      }
    } catch (e) {
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
    window.TavernHelper.replaceVariables(fullStatusData, {
      type: "message",
      message_id: msgId,
    });
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
    await syncStatusToWorldBook();
  } catch (e) {
    console.error("[Anima Debug] 💥 写入过程发生异常:", e);
  }
}

export async function syncStatusToWorldBook(explicitSettings = null) {
  const settings = explicitSettings || getStatusSettings();
  const injectConfig = settings.injection_settings || {};
  // 这里使用 generic macro，指向 latest
  const finalContent =
    injectConfig.template || "{{format_message_variable::anima_data}}";

  const context = SillyTavern.getContext();
  if (!context.chatId) return;

  let wbName = await window.TavernHelper.getChatWorldbookName("current");
  if (!wbName) {
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
      depth: injectConfig.depth ?? 4,
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
  const allChat = window.TavernHelper.getChatMessages("0-{{lastMessageId}}", {
    include_swipes: false,
  });
  if (!allChat || allChat.length === 0) throw new Error("无聊天记录");

  const targetMsg = allChat[allChat.length - 1];
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

export function cancelStatusTimer() {
  if (updateTimer) clearTimeout(updateTimer);
  if (removeUIOverlay) removeUIOverlay();
  updateTimer = null;
  removeUIOverlay = null;
}

export async function handleStatusUpdate() {
  // 1. 清理旧状态
  cancelStatusTimer();

  // 2. 获取最新消息
  const msgs = window.TavernHelper.getChatMessages(-1);
  if (!msgs || msgs.length === 0) return;
  const lastMsg = msgs[0];
  const settings = getStatusSettings();

  // 3. 基础检查：开关是否开启、是否是 AI 消息等
  if (!settings.status_enabled) return;
  if (lastMsg.is_user) return; // 只有 AI 回复才触发自动更新

  // 检查回复完整性 (你的防线函数)
  // 注意：如果 checkReplyIntegrity 不在导出的范围内，请确保它在这个文件内能被访问
  if (
    typeof checkReplyIntegrity === "function" &&
    !checkReplyIntegrity(lastMsg.message || "")
  ) {
    return;
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
    remaining--;
    // innerText 和 style 也不报错了
    if (textEl) textEl.innerText = `${remaining}s`;
    if (timerBar) timerBar.style.width = `${(remaining / seconds) * 100}%`;
    if (remaining <= 0) onConfirm();
    else updateTimer = setTimeout(tick, 1000);
  };
  updateTimer = setTimeout(tick, 1000);
}

// 请确保保留你的 initStatusMacro 和 registerAnimaHidingRegex
export function initStatusMacro() {
  if (!window.TavernHelper || !window.TavernHelper.registerMacroLike) return;
  const REGEX = /\{\{ANIMA_STATUS::(\d+)\}\}/g;
  window.TavernHelper.registerMacroLike(REGEX, (context, match, capturedId) => {
    const msgId = Number(capturedId);
    const settings = getStatusSettings();
    if (!settings.beautify_settings?.enabled) return "";
    const variables = window.TavernHelper.getVariables({
      type: "message",
      message_id: msgId,
    });
    let renderContext = variables || {};
    if (renderContext.anima_data) renderContext = renderContext.anima_data;
    if (!renderContext || Object.keys(renderContext).length === 0)
      return `<div style="font-size:12px; color:gray;">[Anima: No Data]</div>`;
    const beautify = settings.beautify_settings || {};
    let template = beautify.template || "";
    try {
      // 1. 变量替换
      let finalOutput = template.replace(/{{\s*([^\s}]+)\s*}}/g, (m, path) => {
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
      // 1. 获取上下文中的聊天数组
      const ctx = SillyTavern.getContext();
      const chat = ctx.chat || [];
      if (chat.length === 0) return keyPath ? "" : "{}"; // 如果没聊天，取值返回空，取全量返回空对象

      // 2. 确定基准查找起点
      const lastMsg = chat[chat.length - 1];
      const currentId =
        lastMsg.message_id !== undefined ? lastMsg.message_id : chat.length - 1;

      // 3. 执行回溯查找
      const base = findBaseStatus(currentId);
      const baseData = base.id !== -1 && base.data ? base.data : {};

      // 4. 【核心逻辑】判断是取全量还是取特定值
      if (keyPath && keyPath.trim()) {
        // A. 精准取值模式
        const cleanPath = keyPath.trim();
        let val = undefined;
        const lodash = /** @type {any} */ (window)["_"];
        // 优先使用 Lodash 的强力路径解析 (支持 a[0].b.c)
        if (lodash && lodash.get) {
          val = lodash.get(baseData, cleanPath);
        } else {
          // 降级方案：简单的点号分割
          val = cleanPath.split(".").reduce((o, k) => (o || {})[k], baseData);
        }

        // 处理返回值类型
        if (val === undefined) return ""; // 没找到返回空字符串
        if (typeof val === "object") return JSON.stringify(val); // 对象转字符串
        return String(val); // 基础类型转字符串
      } else {
        // B. 全量模式 (保持原有逻辑)
        return Object.keys(baseData).length > 0 ? objectToYaml(baseData) : "{}";
      }
    },
  );
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
 * 保存实时变量到最新楼层 (用于 YAML 面板保存)
 */
export async function saveRealtimeStatusVariables(statusObj) {
  try {
    if (!window.TavernHelper) throw new Error("TavernHelper not ready");
    // ============================================================
    // 🔥 新增步骤 A: 获取旧数据
    // ============================================================
    let oldAnimaData = {};
    try {
      const oldVars = window.TavernHelper.getVariables({
        type: "message",
        message_id: "latest",
      });
      if (oldVars) {
        // UI 面板直接操作的是打平的对象，还是包裹在 anima_data 里的？
        // 根据你的代码逻辑，statusObj 似乎是整个变量对象
        // 这里假设 oldVars 就是旧的状态结构
        oldAnimaData = JSON.parse(JSON.stringify(oldVars));
      }
    } catch (e) {}
    // ============================================================
    // 使用 replaceVariables 确保完全覆盖
    await window.TavernHelper.replaceVariables(statusObj, {
      type: "message",
      message_id: "latest",
    });
    // ============================================================
    // 🔥 新增步骤 B: 广播事件
    // ============================================================
    try {
      const context = SillyTavern.getContext();
      const targetEventSource = context.eventSource;

      if (targetEventSource) {
        targetEventSource.emit("ANIMA_VARIABLE_UPDATE_ENDED", {
          type: "manual_ui",
          messageId: "latest",
          oldData: oldAnimaData,
          newData: statusObj,
          timestamp: Date.now(),
        });
        console.log("[Anima] 📡 UI 手动更新事件已广播");
      }
    } catch (e) {
      console.warn("[Anima] UI 广播出错:", e);
    }
    // ============================================================
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
            <div style="max-height: 200px; overflow-y: auto;">
                ${changes.join("<br>")}
            </div>
        </div>
    `;

  if (window.toastr) {
    // 使用 info 类型，并关闭重复过滤
    window.toastr.info(htmlContent, null, {
      progressBar: true,
      timeOut: "6000",
      extendedTimeOut: "2000",
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
