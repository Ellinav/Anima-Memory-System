/**
 * 获取当前的上下文数据 (User, Char, Persona 等)
 * 集中管理，方便所有模块调用
 */
export function getContextData() {
  const context = SillyTavern.getContext();

  // 1. 获取角色信息
  const charId = context.characterId;
  let charName = "Character";
  let charDesc = "";

  if (
    context.characters &&
    charId !== undefined &&
    context.characters[charId]
  ) {
    const charData = context.characters[charId];
    charName = charData.name || "Character";
    charDesc = charData.description || "";
  }

  // 2. 获取用户信息 (优先从 PowerUser 设置获取，其次全局变量)
  const powerSettings = context.powerUserSettings;
  let userName = "User";
  let userPersona = "";

  if (powerSettings) {
    userPersona = powerSettings.persona_description || "";
    userName = powerSettings.persona_name || context.name1 || "User";
  } else {
    userName = context.name1 || "User";
  }

  // 3. (可选) 获取群组信息
  let groupName = "";
  if (context.groupId && context.groups) {
    groupName = context.groups[context.groupId]?.name || "";
  }

  return { charName, charDesc, userName, userPersona, groupName };
}

/**
 * 创建标准化渲染上下文 (核心函数)
 * 将原始数据包装，并注入 _user, _char 等别名
 * * @param {Object} rawData - 原始 anima_data (例如: { "Player": {HP:10}, "Alice": {HP:20} })
 * @returns {Object} - 注入了别名的新对象
 */
export function createRenderContext(rawData) {
  // 1. 浅拷贝原始数据，避免污染源数据
  // 注意：这里用浅拷贝是为了让 _user 和 源数据 指向同一个内存地址
  // 修改 _user.HP 会同步修改 Player.HP (如果在 JS 逻辑中操作的话)
  const context = { ...rawData };

  // 2. 获取当前的 User 和 Char 名字
  const { userName, charName } = getContextData();

  // 3. 注入 _user 别名
  if (userName && rawData[userName]) {
    // 这里做的是引用赋值，不增加内存开销
    Object.defineProperty(context, "_user", {
      value: rawData[userName],
      enumerable: true, // 允许遍历
      writable: false, // 防止用户不小心把整个 _user 覆盖了
    });
  } else {
    // 防御性编程：如果数据里没找到用户数据，给个空对象防止报错
    context["_user"] = {};
  }

  // 4. 注入 _char 别名
  if (charName && rawData[charName]) {
    Object.defineProperty(context, "_char", {
      value: rawData[charName],
      enumerable: true,
      writable: false,
    });
  } else {
    context["_char"] = {};
  }

  return context;
}

/**
 * 宏替换核心函数 - 修复版 (支持 YAML/JSON 区分)
 * @param {string} text - 原始文本
 * @returns {string} - 替换后的文本
 */
export function processMacros(text) {
  if (!text) return "";
  // 预处理标准占位符
  let result = text.replace(
    /\{\{(status|anima_data|ANIMA_STATUS)\}\}/gi,
    "{{format_message_variable::anima_data}}",
  );
  // ============================================================

  // 阶段 1: 拦截并处理 TavernHelper 变量宏

  // ============================================================
  // 【修改点 1】: 将 (?:get|format) 改为 (get|format) 以捕获操作类型
  // Group 1: operation (get|format)
  // Group 2: scope (global|preset|character|chat|message)
  // Group 3: key path
  const helperMacroRegex =
    /\{\{(get|format)_(global|preset|character|chat|message)_variable::([\w\.\u4e00-\u9fa5]+)\}\}/g;
  if (window.TavernHelper && result.match(helperMacroRegex)) {
    // 【修改点 2】: 增加 operation 参数
    result = result.replace(
      helperMacroRegex,
      (match, operation, scope, keyPath) => {
        try {
          let foundValue = undefined;
          // --- 情况 A: 处理 message 类型 (执行倒序查找) ---
          if (scope === "message") {
            const context = SillyTavern.getContext();
            const chat = context.chat || [];
            if (chat.length === 0) return "N/A";
            // 倒序回溯查找
            for (
              let i = chat.length - 1;
              i >= Math.max(0, chat.length - 50);
              i--
            ) {
              const vars = window.TavernHelper.getVariables({
                type: "message",
                message_id: i,
              });
              let val = undefined;
              if (vars && window._ && window._.get) {
                val = window._.get(vars, keyPath);
              } else if (vars) {
                val = vars[keyPath];
              }
              if (val !== undefined && val !== null) {
                foundValue = val;
                break;
              }
            }
          }
          // --- 情况 B: 其他类型 ---
          else {
            const rootVars = window.TavernHelper.getVariables({
              type: scope,
            });
            if (rootVars) {
              if (window._ && window._.get) {
                foundValue = window._.get(rootVars, keyPath);
              } else {
                foundValue = rootVars[keyPath];
              }
            }
          }
          if (foundValue === undefined) return "N/A";
          // 【修改点 3】: 根据 operation 类型决定输出格式
          if (typeof foundValue === "object") {
            if (operation === "format") {
              // 如果是 format_，尝试转为 YAML
              return objectToYaml(foundValue).trim();
            } else {
              // get_ 默认为 JSON
              return JSON.stringify(foundValue);
            }
          }
          return String(foundValue);
        } catch (e) {
          console.warn(`[Anima] Macro Error (${match}):`, e);
          return "[Error]";
        }
      },
    );
  }

  // ============================================================

  // 阶段 2: ST 官方宏兜底

  // ============================================================
  const context = SillyTavern.getContext();
  let stResult = null;

  if (context && context.substituteParams) {
    try {
      const val = context.substituteParams(result);
      // 核心防御：只有当返回的是【字符串】或【数字】时才采纳
      // 如果返回了对象（实验性引擎），直接丢弃，强制走下面的手动替换
      if (typeof val === "string") {
        stResult = val;
      } else if (typeof val === "number") {
        stResult = String(val);
      }
      // 如果 val 是 object，stResult 保持 null
    } catch (e) {
      // 忽略错误
    }
  }

  if (stResult !== null) {
    result = stResult;
  } else {
    // 🔥 兜底逻辑：手动正则替换
    // 只有走到这里，{{user}} 才能保证被替换成纯文本，而不会变成 [object Object]
    const { charName, userName } = getContextData();
    result = result
      .replace(/{{char}}/gi, charName)
      .replace(/{{user}}/gi, userName);
  }

  return result;
}

// ========================================================
// 下面的辅助函数保持不变 (解析正则、JSON、YAML 等工具函数)
// ========================================================

export function parseRegex(str) {
  // 🔥 修复：将 text 改为 str
  if (!str) return null;

  // 去掉首尾空格，防止用户复制粘贴时带入不可见字符
  const trimmedStr = str.trim();

  try {
    const match = trimmedStr.match(/^\/(.+)\/([a-z]*)$/);
    if (match) {
      let flags = match[2];
      // 强制补全 g 标志，因为 matchAll 必须要求全局匹配
      if (!flags.includes("g")) flags += "g";
      return new RegExp(match[1], flags);
    }
    // 如果用户没写斜杠，直接当做普通全局正则处理
    return new RegExp(trimmedStr, "g");
  } catch (e) {
    console.error("[Anima] Invalid Regex:", trimmedStr, e);
    return null;
  }
}

export function applyRegexRules(text, rules) {
  if (!text || !rules || rules.length === 0) return text;

  // 1. 分离规则类型
  const excludeRules = rules.filter((r) => r.type === "exclude");
  const extractRules = rules.filter((r) => r.type !== "exclude"); // 默认为提取

  // ------------------------------------------------------
  // 阶段一：执行所有的“排除”规则
  // 这会对原始文本进行修改（清洗），供后续提取使用
  // ------------------------------------------------------
  let currentText = text;
  excludeRules.forEach((rule) => {
    const regex = parseRegex(rule.regex);
    if (regex) {
      // 排除即替换为空字符串
      currentText = currentText.replace(regex, "");
    }
  });

  // 如果没有“提取”规则，直接返回清洗后的文本
  if (extractRules.length === 0) {
    return currentText.trim();
  }

  // ------------------------------------------------------
  // 阶段二：并行执行所有的“提取”规则
  // 所有的提取规则都针对“阶段一”清洗后的 currentText 进行匹配
  // ------------------------------------------------------
  let allExtractedParts = [];

  extractRules.forEach((rule) => {
    const regex = parseRegex(rule.regex);
    if (!regex) return;

    regex.lastIndex = 0;
    const matches = [...currentText.matchAll(regex)];

    matches.forEach((m) => {
      // 【修改点 1】: 支持多捕获组
      // 如果正则中有捕获组 (m.length > 1)，则提取所有捕获组的内容
      // 如果没有捕获组 (m.length === 1)，则提取整体匹配 (m[0])
      if (m.length > 1) {
        // 从索引 1 开始遍历所有捕获组
        for (let i = 1; i < m.length; i++) {
          if (m[i]) {
            // 【修改点 2】: trim() 去除单个提取块首尾的多余换行
            allExtractedParts.push(m[i].trim());
          }
        }
      } else {
        // 没有捕获组，取整体
        allExtractedParts.push(m[0].trim());
      }
    });
  });

  // ------------------------------------------------------
  // 阶段三：合并结果
  // ------------------------------------------------------
  return allExtractedParts.filter(Boolean).join("\n");
}

/**
 * 终极 JSON 提取器 (Iterative Scanner)
 * 能够处理：
 * 1. Markdown 代码块包裹
 * 2. <thinking> 或其他标签包裹的杂音
 * 3. 前后任意纯文本干扰
 * 4. 杂音中包含混淆的括号 (如 "I will update [status]...")
 */
export function extractJsonResult(text) {
  if (!text) return null;

  // --- 策略 1: 优先匹配 Markdown 代码块 (最稳健) ---
  // 很多模型在 CoT 之后会非常规范地打上 ```json
  const codeBlockRegex =
    /```(?:json)?\s*(\[\s*[\s\S]*\s*\]|\{\s*[\s\S]*\s*\})\s*```/i;
  const match = text.match(codeBlockRegex);
  if (match) {
    const result = tryParse(match[1]);
    if (result) return result;
  }

  // --- 策略 2: 迭代扫描法 (暴力但有效) ---
  // 应对场景：
  // <thinking>I check [status]...</thinking> { "HP": 10 } End text.
  // 逻辑：遇到第一个 '[' 会提取 "[status]" -> 解析失败 -> 继续往后找
  //      遇到 '{' 会提取 '{ "HP": 10 }' -> 解析成功 -> 返回

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    // 我们只关心可能的 JSON 起始点
    if (char === "{" || char === "[") {
      // 从当前位置 i 开始，尝试提取一段平衡的括号文本
      const potentialJsonStr = extractBalancedString(text, i);

      if (potentialJsonStr) {
        // 立即尝试解析
        const result = tryParse(potentialJsonStr);
        if (result) {
          return result; // 找到了！直接返回，忽略后面的文本
        }
        // 如果解析失败（比如提取到了 [thinking]），循环继续，寻找下一个起始点
      }
    }
  }

  return null;
}

/**
 * 内部辅助：尝试解析 JSON 并归一化为数组
 * @returns {Array|null} 解析成功返回数组，失败返回 null
 */
function tryParse(str) {
  try {
    const result = JSON.parse(str);
    if (Array.isArray(result)) {
      return result;
    } else if (typeof result === "object" && result !== null) {
      return [result];
    }
  } catch (e) {
    // 解析失败，说明这段括号匹配的内容不是 JSON
    return null;
  }
  return null;
}

/**
 * 内部辅助：提取平衡括号字符串
 * @param {string} text - 完整文本
 * @param {number} startIndex - 起始位置 (必须是 { 或 [)
 * @returns {string|null} 提取出的字符串，如果未闭合则返回 null
 */
function extractBalancedString(text, startIndex) {
  const startChar = text[startIndex];
  let stack = 0;
  let inString = false;
  let isEscaped = false;

  // 确定结束字符
  const endChar = startChar === "{" ? "}" : "]";

  for (let i = startIndex; i < text.length; i++) {
    const char = text[i];

    // 1. 处理字符串内的字符 (跳过字符串内部的括号)
    if (inString) {
      if (char === "\\") {
        isEscaped = !isEscaped;
      } else if (char === '"' && !isEscaped) {
        inString = false;
      } else {
        isEscaped = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    // 2. 括号计数
    if (char === startChar) {
      stack++;
    } else if (char === endChar) {
      stack--;
    }

    // 3. 闭合检测
    if (stack === 0) {
      // 找到了对应的结束括号
      return text.substring(startIndex, i + 1);
    }
  }

  return null; // 没有找到闭合括号
}

function isObject(item) {
  return (
    item && typeof item === "object" && !Array.isArray(item) && item !== null
  );
}

export function deepMergeUpdates(original, updates) {
  if (!original) original = {};

  for (const key in updates) {
    if (!Object.hasOwn(updates, key)) continue;

    const updateValue = updates[key];
    const currentValue = original[key];

    // 1. 处理 null (直接删除当前层级的 key)
    if (updateValue === null) {
      delete original[key];
      continue;
    }

    // 2. 处理数值增减 (例如 "+10", "-5")
    if (typeof currentValue === "number" && typeof updateValue === "string") {
      const trimmed = updateValue.trim();
      if (trimmed.startsWith("+") || trimmed.startsWith("-")) {
        const delta = parseFloat(trimmed);
        if (!isNaN(delta)) {
          original[key] = currentValue + delta;
          continue;
        }
      }
    }

    // 3. 处理嵌套对象 (🔥 修复的核心位置)
    if (isObject(updateValue)) {
      // 如果原状态中没有这个节点，或者它原本不是对象，我们就初始化一个空对象供其递归
      if (!isObject(currentValue)) {
        original[key] = {};
      }

      // 强制深入内部进行合并和清理
      deepMergeUpdates(original[key], updateValue);

      // 🔥 (可选优化) 如果递归清理完 null 之后，这个对象变成了空壳 {}，顺手把它也删掉
      // 避免状态面板里留下一堆诸如 "物品栏: {}" 的废话
      if (Object.keys(original[key]).length === 0) {
        delete original[key];
      }
      continue;
    }

    // 4. 其他基础类型情况，直接覆盖
    original[key] = updateValue;
  }

  return original;
}

export function objectToYaml(obj) {
  try {
    const yamlLib = window["jsyaml"];
    if (yamlLib && yamlLib.dump) {
      // ============================================================
      // 修改点：添加配置对象 { lineWidth: -1 }
      // lineWidth: -1 表示禁止自动换行，从而避免出现 >- 这种折叠样式
      // noRefs: true (可选) 防止生成 &ref 锚点，让显示更纯粹
      // ============================================================
      return yamlLib.dump(obj, { lineWidth: -1, noRefs: true });
    }
    return JSON.stringify(obj, null, 2);
  } catch (e) {
    console.error("YAML dump failed", e);
    return String(obj);
  }
}

export function yamlToObject(yamlStr) {
  // 1. 如果完全为空，按照原有逻辑返回 null，让业务层自己处理空值报错
  if (!yamlStr || !yamlStr.trim()) {
    return null;
  }

  try {
    const yamlLib = window["jsyaml"];
    if (yamlLib && yamlLib.load) {
      return yamlLib.load(yamlStr);
    }
    return JSON.parse(yamlStr);
  } catch (e) {
    throw e;
  }
}

export function smartFixYaml(rawYaml) {
  // 1. 绝对安全的修复：Tab 转 2 个空格
  let fixed = rawYaml.replace(/\t/g, "  ");

  // 2. 绝对安全的修复：用户可能直接粘贴了合法的 JSON
  try {
    const jsonObj = JSON.parse(rawYaml);
    return {
      success: true,
      fixedStr: objectToYaml(jsonObj),
      reason: "检测到 JSON 格式，已自动转换为 YAML",
    };
  } catch (e) {
    // 不是 JSON，不管它
  }

  // 判断仅仅替换 Tab 后是否就合法了
  try {
    const testObj = yamlToObject(fixed);
    if (testObj && typeof testObj === "object") {
      return {
        success: true,
        fixedStr: fixed,
        reason: "已自动将非法制表符(Tab)替换为空格",
      };
    }
  } catch (e) {
    return { success: false, error: e };
  }

  return { success: false, error: new Error("无法安全修复") };
}
