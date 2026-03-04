import {
  previewStatusPayload,
  getStatusSettings,
  getGCSettings,
  saveSettingsToCharacterCard,
} from "./status_logic.js";
import {
  processMacros,
  objectToYaml,
  applyRegexRules,
  getContextData,
} from "./utils.js";

export function openGCManagementModal() {
  const modalId = "anima-gc-management-modal";
  $(`#${modalId}`).remove();

  // 🔥 优化点 1：深拷贝初始配置，确保“取消”能生效
  const rawSettings = getGCSettings();
  let gcSettings = JSON.parse(
    JSON.stringify({
      ...rawSettings.gcConfig,
      prompt_rules: rawSettings.gcPrompts,
    }),
  );

  const ensureCorePromptsExist = () => {
    // 定义不可缺少的常驻条目及默认值
    const corePrompts = [
      { type: "char_info", enabled: true },
      { type: "user_info", enabled: true },
      { type: "status_placeholder" },
      { type: "chat_context_placeholder", floors: 30 },
    ];

    if (!Array.isArray(gcSettings.prompt_rules)) {
      gcSettings.prompt_rules = [];
    }

    // 检查并补全
    corePrompts.forEach((coreRule, index) => {
      const exists = gcSettings.prompt_rules.some(
        (r) => r.type === coreRule.type,
      );
      if (!exists) {
        // 如果不存在，强制插入到数组的前排对应位置
        gcSettings.prompt_rules.splice(index, 0, coreRule);
      }
    });
  };

  // 弹窗初始化时，立刻执行一次自我修复
  ensureCorePromptsExist();

  // ==========================================
  // 1. 基础 UI 框架构建
  // ==========================================
  const modalHtml = `
        <div id="${modalId}" class="anima-modal hidden">
            <div class="anima-modal-content" style="width: 750px; max-width: 95%; height: 85vh; display: flex; flex-direction: column; background: var(--anima-bg-dark, #1f2937); border: 1px solid var(--anima-border);">
                
                <div class="anima-modal-header" style="background: rgba(0,0,0,0.2); border-bottom: 1px solid var(--anima-border);">
                    <h3 style="margin:0; font-size:1.1em; display:flex; align-items:center; gap:10px; color: var(--anima-warning, #fbbf24);">
                        <i class="fa-solid fa-broom"></i> 状态清洗配置管理
                    </h3>
                    <span class="anima-close-gc-modal" style="cursor: pointer; opacity:0.7; font-size: 1.5em;">&times;</span>
                </div>

                <div class="anima-modal-body" style="flex: 1; overflow-y: auto; padding: 20px;">
                    
                    <div class="anima-card" style="margin-bottom: 20px; border-color: #4b5563;">
                        <div class="anima-flex-row" style="justify-content: space-between; align-items: center;">
                            <div class="anima-label-group">
                                <span class="anima-label-text">复用【状态更新提示词】的正则及设置</span>
                            </div>
                            <label class="anima-switch">
                                <input type="checkbox" id="gc_toggle_reuse_regex" ${gcSettings.reuse_regex ? "checked" : ""}>
                                <span class="slider round"></span>
                            </label>
                        </div>
                    </div>

                    <div id="gc_custom_regex_section" class="anima-card" style="${gcSettings.reuse_regex ? "display:none;" : ""} margin-bottom: 20px; border-color: #4b5563;">
                        <div class="anima-flex-row" style="justify-content: space-between; align-items: center; margin-bottom: 10px;">
                            <div class="anima-label-text"><i class="fa-solid fa-filter"></i> 专属清洗正则</div>
                            <button id="btn-gc-add-regex" class="anima-btn small secondary"><i class="fa-solid fa-plus"></i> 添加</button>
                        </div>
                        
                        <div id="gc_regex_list_container" style="display:flex; flex-direction:column; gap:5px; margin-bottom: 15px;"></div>
                        
                        <div style="background: rgba(0,0,0,0.2); padding: 15px; border-radius: 5px;">
                            <div class="anima-flex-row" style="justify-content: space-between; align-items: center; margin-bottom: 12px;">
                                <span class="anima-label-text">正则跳过开场白</span>
                                <label class="anima-switch"><input type="checkbox" id="gc_skip_layer_zero" ${gcSettings.skip_layer_zero ? "checked" : ""}><span class="slider round"></span></label>
                            </div>
                            <div class="anima-flex-row" style="justify-content: space-between; align-items: center; margin-bottom: 12px;">
                                <span class="anima-label-text">正则跳过 User 消息</span>
                                <label class="anima-switch"><input type="checkbox" id="gc_regex_skip_user" ${gcSettings.regex_skip_user ? "checked" : ""}><span class="slider round"></span></label>
                            </div>
                            <div class="anima-flex-row" style="justify-content: space-between; align-items: center;">
                                <span class="anima-label-text">完全排除 User 消息</span>
                                <label class="anima-switch"><input type="checkbox" id="gc_exclude_user" ${gcSettings.exclude_user ? "checked" : ""}><span class="slider round"></span></label>
                            </div>
                        </div>
                    </div>

                    <div class="anima-card" style="margin-bottom: 20px; border-color: #4b5563;">
                        <div class="anima-flex-row" style="justify-content: space-between; align-items: center; margin-bottom: 15px;">
                            <div class="anima-label-text"><i class="fa-solid fa-list-ol"></i> 状态清洗提示词预设</div>
                            <div style="display: flex; gap: 5px;">
                                <button id="btn-gc-import" class="anima-btn small secondary" title="导入"><i class="fa-solid fa-file-import"></i> </button>
                                <button id="btn-gc-export" class="anima-btn small secondary" title="导出"><i class="fa-solid fa-file-export"></i> </button>
                                <button id="btn-gc-add-prompt" class="anima-btn small primary"><i class="fa-solid fa-plus"></i></button>
                            </div>
                        </div>

                        <div id="gc_prompt_list_container" style="display:flex; flex-direction:column; gap:8px;"></div>
                    </div>

                </div>

                <div class="anima-modal-footer" style="background: rgba(0,0,0,0.2); border-top: 1px solid var(--anima-border); display: flex; justify-content: space-between;">
                    <button class="anima-btn secondary anima-close-gc-modal">取消</button>
                    <button id="btn-gc-save-config" class="anima-btn primary">
                        <i class="fa-solid fa-floppy-disk"></i> 保存
                    </button>
                </div>
            </div>
        </div>
    `;

  $("body").append(modalHtml);
  setTimeout(() => {
    $(`#${modalId}`).removeClass("hidden");
  }, 10);

  // ==========================================
  // 2. 渲染函数：正则列表 (已修复样式与水平对齐，新增拖拽)
  // ==========================================
  const renderGCRegex = () => {
    const $container = $("#gc_regex_list_container");
    $container.empty();

    if (gcSettings.regex_list.length === 0) {
      $container.html(
        '<div style="text-align:center; color:#666; font-size:12px; padding:10px; border:1px dashed #555;">暂无专属正则</div>',
      );
      return;
    }

    gcSettings.regex_list.forEach((rule, idx) => {
      const $item = $(`
                <div class="anima-regex-item" data-idx="${idx}" style="display: flex; flex-direction: row; flex-wrap: nowrap; align-items: center; gap: 8px; width: 100%; padding: 6px 10px; background: rgba(0,0,0,0.2); border: 1px solid var(--anima-border, #4b5563); border-radius: 4px; box-sizing: border-box;">
                    <i class="fa-solid fa-bars anima-drag-handle" title="拖动排序" style="cursor:grab; color:#888; flex-shrink: 0;"></i>
                    
                    <select class="anima-select gc-regex-type" style="width: 100px; margin: 0; box-sizing: border-box; background: rgba(0,0,0,0.3); color: #ddd; border: 1px solid #555; border-radius: 4px; padding: 4px; flex-shrink: 0;">
                        <option value="extract" ${rule.type === "extract" ? "selected" : ""}>提取</option>
                        <option value="exclude" ${rule.type === "exclude" ? "selected" : ""}>排除</option>
                    </select>
                    
                    <input type="text" class="anima-input gc-regex-content" value="${escapeHtml(rule.content || "")}" placeholder="输入正则表达式..." style="flex: 1; min-width: 0; margin: 0; box-sizing: border-box; background: rgba(0,0,0,0.3); color: #ddd; border: 1px solid #555; border-radius: 4px; padding: 4px 8px;">
                    
                    <button class="anima-btn danger small gc-regex-delete" style="width: 32px; height: 32px; padding: 0; margin: 0; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: #ef4444; color: white; border: none; border-radius: 4px; cursor: pointer;">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            `);

      $item.find(".gc-regex-type").on("change", function () {
        rule.type = $(this).val();
        renderGCPrompts();
      });
      $item.find(".gc-regex-content").on("input", function () {
        rule.content = $(this).val();
        renderGCPrompts();
      });
      $item.find(".gc-regex-delete").on("click", () => {
        gcSettings.regex_list.splice(idx, 1);
        renderGCRegex();
        renderGCPrompts();
      });
      $container.append($item);
    });

    // 挂载拖拽排序
    $container.sortable({
      handle: ".anima-drag-handle",
      placeholder: "ui-state-highlight",
      stop: function () {
        const newRegex = [];
        $container.children().each(function () {
          const oldIdx = $(this).data("idx");
          if (gcSettings.regex_list[oldIdx])
            newRegex.push(gcSettings.regex_list[oldIdx]);
        });
        gcSettings.regex_list = newRegex;
        renderGCRegex();
      },
    });
  };

  // ==========================================
  // 3. 数据拉取与清洗逻辑 (完美复刻主面板逻辑)
  // ==========================================
  let cachedStatus = "正在加载...";
  let cachedChar = "正在加载...";
  let cachedUser = "正在加载...";

  // 弹窗打开时立刻异步拉取底层数据
  async function loadPreviewData() {
    try {
      // 1. 角色卡信息：纯粹提取，绝不过滤任何标签
      const { userPersona, charDesc } = getContextData(); // 你 utils.js 里已经写好了这个函数

      if (charDesc) {
        cachedChar = charDesc;
      } else {
        cachedChar = "未检测到角色卡信息";
      }

      if (userPersona) {
        cachedUser = userPersona;
      } else {
        cachedUser = "未检测到用户设定";
      }

      // 3. 提取实时状态
      if (typeof previewStatusPayload !== "undefined") {
        const result = await previewStatusPayload();
        if (result.sourceFloorId !== -1) {
          const vars = window.TavernHelper.getVariables({
            type: "message",
            message_id: result.sourceFloorId,
          });
          const data = vars.anima_data || vars || {};
          cachedStatus =
            Object.keys(data).length > 0
              ? typeof objectToYaml !== "undefined"
                ? objectToYaml(data)
                : JSON.stringify(data)
              : "# 此楼层无状态数据 (Empty)";
        } else {
          cachedStatus = "# 初始状态 (Init)";
        }
      }
      renderGCPrompts();
    } catch (e) {
      console.error("加载预览数据失败:", e);
    }
  }
  loadPreviewData(); // 立即执行

  // 辅助函数：清洗剧情上下文 (已升级为返回对象数组)
  function getCleanedContext(floors) {
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

    if (gcSettings.reuse_regex) {
      const globalSettings =
        typeof getStatusSettings !== "undefined" ? getStatusSettings() : {};
      const globalRegexConfig = globalSettings.regex_settings || {};
      activeRegexList = globalRegexConfig.regex_list || [];
      activeSkipZero = globalRegexConfig.skip_layer_zero || false;
      activeSkipUser = globalRegexConfig.regex_skip_user || false;
      activeExcludeUser = globalRegexConfig.exclude_user || false;
    } else {
      activeRegexList = gcSettings.regex_list || [];
      activeSkipZero = gcSettings.skip_layer_zero || false;
      activeSkipUser = gcSettings.regex_skip_user || false;
      activeExcludeUser = gcSettings.exclude_user || false;
    }

    // 🔥 史诗级修复：强制将所有配置项归一化，确保 `applyRegexRules` 绝对能读到 `r.regex`
    const validRegexes = [];
    activeRegexList.forEach((r) => {
      if (!r) return;
      let val =
        r.regex || r.content || r.pattern || (typeof r === "string" ? r : "");
      let type = r.type || "extract";

      if (val) {
        // 确保在这里传入的是字符串，让 applyRegexRules 内部 parseRegex 重新生成 RegExp 实例
        validRegexes.push({ type: type, regex: String(val) });
      }
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

      // 🔥 只有存在有效正则时，才交给引擎处理
      if (!isSkipped && validRegexes.length > 0) {
        if (typeof applyRegexRules !== "undefined") {
          content = applyRegexRules(content, validRegexes);
        }
        content = content.trim();
      }

      if (content) {
        processedMsgs.push({
          role: msg.role || (isUser ? "user" : "assistant"),
          is_user: isUser,
          isSkipped: isSkipped,
          displayContent: content,
        });
      }
    });

    return processedMsgs;
  }

  // ==========================================
  // 4. 渲染函数：提示词列表
  // ==========================================
  const renderGCPrompts = () => {
    const $container = $("#gc_prompt_list_container");
    $container.empty();

    gcSettings.prompt_rules.forEach((rule, idx) => {
      let headerHtml = "";
      let isFixed = false;
      let bgColor = "rgba(0,0,0,0.2)";
      let borderColor = "#444";

      // 🔥 将字符串和数组严格分离，解决报错
      let displayContent = typeof rule.content === "string" ? rule.content : "";
      let contextArray = null;

      if (rule.type === "char_info" || rule.type === "user_info") {
        isFixed = true;
        const isChar = rule.type === "char_info";
        const title = isChar ? "👾 角色卡信息" : "👑 用户设定";
        const color = isChar ? "#d8b4fe" : "#f472b6";
        bgColor = isChar
          ? "rgba(168, 85, 247, 0.1)"
          : "rgba(236, 72, 153, 0.1)";
        borderColor = isChar ? "#9333ea" : "#db2777";

        headerHtml = `
                    <span style="font-weight:bold; color:${color}; flex:1;">${title}</span>
                    <label class="anima-switch gc-prompt-toggle" style="margin:0 10px 0 0;"><input type="checkbox" ${rule.enabled ? "checked" : ""}><span class="slider round"></span></label>
                `;
        displayContent = isChar ? cachedChar : cachedUser;
      } else if (rule.type === "status_placeholder") {
        isFixed = true;
        bgColor = "rgba(16, 185, 129, 0.1)";
        borderColor = "#10b981";
        headerHtml = `
                    <span style="font-weight:bold; color:#6ee7b7; flex:1;"><i class="fa-solid fa-heart-pulse"></i> 实时状态插入位</span>
                    <i class="fa-solid fa-lock" style="color:#10b981; opacity:0.5; margin-right: 15px;" title="锁定条目"></i>
                `;
        displayContent = cachedStatus;
      } else if (rule.type === "chat_context_placeholder") {
        isFixed = true;
        bgColor = "rgba(59, 130, 246, 0.1)";
        borderColor = "#3b82f6";

        headerHtml = `
                    <span style="font-weight:bold; color:#93c5fd; flex:1;"><i class="fa-solid fa-layer-group"></i> 上下文</span>
                    <div style="display:flex; align-items:center; gap:5px; margin-right: 15px;" class="stop-propagation">
                        <span style="font-size:12px; color:#aaa;">最新</span>
                        <div class="anima-compact-input" style="margin: 0;">
                            <input type="number" class="anima-input gc-prompt-floors" value="${rule.floors || 30}" style="width:60px; text-align:center; margin: 0; background: rgba(0,0,0,0.3); color: #ddd; border: 1px solid #555; border-radius: 4px; padding: 2px;">
                        </div>
                        <span style="font-size:12px; color:#aaa;">楼</span>
                    </div>
                `;

        // 🔥 赋值给独立的数组变量
        contextArray = getCleanedContext(rule.floors || 30);
      } else {
        // 自由条目保持不变
        headerHtml = `
                    <div class="gc-prompt-view" style="display:flex; align-items:center; flex:1; gap:8px;">
                        <span class="anima-tag secondary" style="font-size:10px; background: #374151; padding: 2px 6px; border-radius: 4px;">${(rule.role || "system").toUpperCase()}</span>
                        <span style="font-weight:bold; color:#ddd; flex:1;">${escapeHtml(rule.title || "新规则")}</span>
                        <div style="display:flex; gap:5px; margin-right: 10px;" class="stop-propagation">
                            <button class="anima-btn secondary small gc-prompt-edit-btn" style="width:28px; height:28px; padding:0; background: #374151; color: #ddd; border: none; cursor:pointer; box-sizing: border-box;"><i class="fa-solid fa-pen"></i></button>
                            <button class="anima-btn danger small gc-prompt-del-btn" style="width:28px; height:28px; padding:0; background: #ef4444; color: white; border: none; cursor:pointer; box-sizing: border-box;"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    </div>
                    
                    <div class="gc-prompt-edit" style="display:none; align-items:center; flex:1; gap:8px; margin-right:10px;" class="stop-propagation">
                        <select class="anima-select gc-prompt-role" style="width:90px; height:28px; margin: 0; padding: 0 5px; box-sizing: border-box; background: rgba(0,0,0,0.3); color: #ddd; border: 1px solid #555; border-radius: 4px; outline: none;">
                            <option value="system" ${rule.role === "system" ? "selected" : ""}>System</option>
                            <option value="user" ${rule.role === "user" ? "selected" : ""}>User</option>
                            <option value="assistant" ${rule.role === "assistant" ? "selected" : ""}>Assistant</option>
                        </select>
                        <input type="text" class="anima-input gc-prompt-title" value="${escapeHtml(rule.title || "")}" style="flex:1; height:28px; margin: 0; padding: 0 8px; box-sizing: border-box; background: rgba(0,0,0,0.3); color: #ddd; border: 1px solid #555; border-radius: 4px; outline: none;">
                        <div style="display:flex; gap:5px; align-items: center;">
                            <button class="anima-btn primary small gc-prompt-confirm-btn" style="display:flex; align-items:center; justify-content:center; width:28px; height:28px; margin: 0; padding:0; box-sizing: border-box; background: #10b981; border: none; color: white; cursor:pointer;"><i class="fa-solid fa-check"></i></button>
                            <button class="anima-btn danger small gc-prompt-cancel-btn" style="display:flex; align-items:center; justify-content:center; width:28px; height:28px; margin: 0; padding:0; box-sizing: border-box; background: #ef4444; border: none; color: white; cursor:pointer;"><i class="fa-solid fa-xmark"></i></button>
                        </div>
                    </div>
                `;
      }

      let bodyContentHtml = "";

      if (rule.type === "chat_context_placeholder") {
        let bubblesHtml = "";

        if (!contextArray || contextArray.length === 0) {
          bubblesHtml = `<div style='padding:5px; color:#aaa; font-style:italic;'>⚠️ 无增量消息 (或已被正则完全过滤)</div>`;
        } else {
          bubblesHtml = contextArray
            .map((m) => {
              const roleUpper = m.role ? m.role.toUpperCase() : "UNKNOWN";
              const headerColor = m.is_user ? "color:#4ade80" : "color:#60a5fa";
              const rawBadge = m.isSkipped
                ? `<span style="font-size:10px; background:rgba(255,255,255,0.1); border-radius:3px; padding:0 4px; margin-left:6px; color:#aaa;" title="正则已跳过">RAW</span>`
                : "";

              return (
                `<div style="margin-bottom: 12px; background: rgba(0,0,0,0.2); padding: 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.05);">` +
                `<div style="font-weight:bold; font-size: 11px; margin-bottom: 4px; ${headerColor}">[${roleUpper}]${rawBadge}</div>` +
                `<div style="white-space: pre-wrap; color: #ddd; font-size: 12px; line-height: 1.5;">${escapeHtml(m.displayContent).trim()}</div>` +
                `</div>`
              );
            })
            .join("");
        }
        bodyContentHtml = `<div class="anima-chat-bubbles-container" style="max-height: 250px; overflow-y: auto; padding: 10px; background: rgba(0,0,0,0.3); border: 1px solid ${borderColor}; border-radius: 4px;">${bubblesHtml}</div>`;
      } else {
        bodyContentHtml = `<textarea class="anima-textarea gc-prompt-content" rows="4" style="width:100%; box-sizing:border-box; background: rgba(0,0,0,0.3); color: #ddd; border: 1px solid #555; border-radius: 4px; padding: 8px; outline: none; resize: vertical;" ${isFixed ? "disabled" : ""}>${escapeHtml(String(displayContent))}</textarea>`;
      }

      const $item = $(`
                <div class="anima-regex-item" data-idx="${idx}" style="border: 1px solid ${borderColor}; background: ${bgColor}; border-radius: 4px; overflow: hidden;">
                    <div class="gc-prompt-header" style="display:flex; align-items:center; padding: 8px 10px; cursor: pointer; user-select: none;">
                        <i class="fa-solid fa-bars anima-drag-handle" title="拖动排序" style="cursor:grab; margin-right: 12px; color:#888;"></i>
                        ${headerHtml}
                        <i class="fa-solid fa-chevron-down toggle-icon" style="color:#aaa; transition: transform 0.2s;"></i>
                    </div>
                    <div class="gc-prompt-body" style="display:none; padding: 10px; border-top: 1px dashed ${borderColor}; background: rgba(0,0,0,0.3);">
                        ${bodyContentHtml}
                    </div>
                </div>
            `);

      // 事件绑定部分 (与上版基本一致)
      const $header = $item.find(".gc-prompt-header");
      const $body = $item.find(".gc-prompt-body");
      const $icon = $item.find(".toggle-icon");

      $header.on("click", (e) => {
        if (
          $(e.target).closest(
            ".stop-propagation, button, input, select, .anima-switch",
          ).length > 0
        )
          return;
        $body.slideToggle(150);
        $icon.css(
          "transform",
          $body.is(":visible") ? "rotate(180deg)" : "rotate(0deg)",
        );
      });

      if (rule.type === "char_info" || rule.type === "user_info") {
        $item.find(".gc-prompt-toggle input").on("change", function () {
          rule.enabled = $(this).prop("checked");
        });
      }
      if (rule.type === "chat_context_placeholder") {
        // 监听数字变动，不仅修改 rule，同时触发重绘以实时呈现截取的楼数内容
        $item.find(".gc-prompt-floors").on("change", function () {
          rule.floors = parseInt($(this).val()) || 0;
          renderGCPrompts();
        });
      }

      if (!isFixed) {
        const $view = $item.find(".gc-prompt-view");
        const $edit = $item.find(".gc-prompt-edit");
        const $content = $item.find(".gc-prompt-content");

        $item.find(".gc-prompt-edit-btn").on("click", () => {
          $view.hide();
          $edit.css("display", "flex");
        });
        $item.find(".gc-prompt-cancel-btn").on("click", () => {
          $item.find(".gc-prompt-role").val(rule.role || "system");
          $item.find(".gc-prompt-title").val(rule.title || "");
          $content.val(rule.content || "");
          $edit.hide();
          $view.css("display", "flex");
        });
        $item.find(".gc-prompt-confirm-btn").on("click", () => {
          rule.role = $item.find(".gc-prompt-role").val();
          rule.title = $item.find(".gc-prompt-title").val();
          rule.content = $content.val();
          renderGCPrompts();
        });
        $item.find(".gc-prompt-del-btn").on("click", () => {
          gcSettings.prompt_rules.splice(idx, 1);
          renderGCPrompts();
        });
        $content.on("input", function () {
          rule.content = $(this).val();
        });
      }

      $container.append($item);
    });

    $container.sortable({
      handle: ".anima-drag-handle",
      placeholder: "ui-state-highlight",
      stop: function () {
        const newRules = [];
        $container.children().each(function () {
          const oldIdx = $(this).data("idx");
          if (gcSettings.prompt_rules[oldIdx])
            newRules.push(gcSettings.prompt_rules[oldIdx]);
        });
        gcSettings.prompt_rules = newRules;
        renderGCPrompts();
      },
    });
  };

  // ==========================================
  // 5. 全局事件绑定 & 初始化逻辑
  // ==========================================

  // 关闭逻辑
  const closeModal = () => {
    $(`#${modalId}`).addClass("hidden");
    setTimeout(() => {
      $(`#${modalId}`).remove();
    }, 300);
  };
  $(`#${modalId} .anima-close-gc-modal, #${modalId} .anima-close-gc-modal`).on(
    "click",
    closeModal,
  );
  $(`#${modalId}`).on("click", function (e) {
    if (e.target === this) closeModal();
  });

  // 复用正则开关联动
  $("#gc_toggle_reuse_regex").on("change", function () {
    gcSettings.reuse_regex = $(this).prop("checked");
    if (gcSettings.reuse_regex) {
      $("#gc_custom_regex_section").slideUp(200);
    } else {
      $("#gc_custom_regex_section").slideDown(200);
    }
    renderGCPrompts(); // 🔥 切换开关时实时更新预览
  });

  // 独立正则控制开关
  $("#gc_skip_layer_zero").on("change", function () {
    gcSettings.skip_layer_zero = $(this).prop("checked");
    renderGCPrompts(); // 🔥 切换开关时实时更新预览
  });
  $("#gc_regex_skip_user").on("change", function () {
    gcSettings.regex_skip_user = $(this).prop("checked");
    renderGCPrompts(); // 🔥 切换开关时实时更新预览
  });
  $("#gc_exclude_user").on("change", function () {
    gcSettings.exclude_user = $(this).prop("checked");
    renderGCPrompts(); // 🔥 切换开关时实时更新预览
  });

  // 导出功能
  $("#btn-gc-export").on("click", () => {
    const dataStr = JSON.stringify(gcSettings.prompt_rules, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `Anima_GC_Prompts_${new Date().getTime()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  });

  // 导入功能
  $("#btn-gc-import").on("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = (e) => {
      const file = e.target.files[0];
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const imported = JSON.parse(event.target.result);
          if (Array.isArray(imported)) {
            // 直接覆盖当前内存中的提示词
            gcSettings.prompt_rules = imported;

            // 🔥 新增：导入后强制检查并补全常驻条目！
            ensureCorePromptsExist();

            renderGCPrompts(); // 重新渲染界面
            if (window.toastr)
              toastr.success("提示词已导入（记得点击保存以生效）");
          }
        } catch (err) {
          if (window.toastr) toastr.error("导入失败：文件格式不正确");
        }
      };
      reader.readAsText(file);
    };
    input.click();
  });

  // 添加按钮
  $("#btn-gc-add-regex").on("click", () => {
    gcSettings.regex_list.push({ type: "extract", content: "" });
    renderGCRegex();
  });

  $("#btn-gc-add-prompt").on("click", () => {
    gcSettings.prompt_rules.push({
      type: "normal",
      role: "system",
      title: "新规则",
      content: "",
    });
    renderGCPrompts();
  });

  // 保存配置
  $("#btn-gc-save-config").on("click", async function () {
    console.log("即将保存的 GC 配置: ", gcSettings);

    try {
      // 1. 准备专属正则及开关的数据
      const regexConfigToSave = {
        reuse_regex: gcSettings.reuse_regex,
        skip_layer_zero: gcSettings.skip_layer_zero,
        regex_skip_user: gcSettings.regex_skip_user,
        exclude_user: gcSettings.exclude_user,
        regex_list: gcSettings.regex_list,
      };

      // 2. 将两部分数据打包成一个 Payload 对象
      const payload = {
        anima_gc_prompts: gcSettings.prompt_rules,
        anima_gc_settings: regexConfigToSave,
      };

      // 3. 触发一次批量保存
      await saveSettingsToCharacterCard(payload);
    } catch (error) {
      console.error("[Anima] 保存清洗配置失败:", error);
      if (window.toastr) {
        window.toastr.error("保存清洗配置失败，请查看控制台。", "Anima");
      }
    }
  });

  // 辅助函数：转义 HTML
  function escapeHtml(text) {
    if (!text) return "";
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // 初始化渲染
  renderGCRegex();
  renderGCPrompts();
}
