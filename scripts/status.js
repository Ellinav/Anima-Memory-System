import {
  getStatusSettings,
  saveStatusSettings,
  DEFAULT_STATUS_SETTINGS,
  saveSettingsToCharacterCard,
  scanChatForStatus,
  getStatusFromMessage,
  saveStatusToMessage,
  injectStatusToChat,
  getRealtimeStatusVariables,
  saveRealtimeStatusVariables,
  syncStatusToWorldBook,
  previewStatusPayload,
  findBaseStatus,
  triggerManualSync,
  renderAnimaTemplate,
  executeGCProcess,
} from "./status_logic.js";
import { validateStatusData, createAutoNumberSchema } from "./status_zod.js";
import {
  yamlToObject,
  objectToYaml,
  processMacros,
  applyRegexRules,
  createRenderContext,
  smartFixYaml,
} from "./utils.js";
import { RegexListComponent, getRegexModalHTML } from "./regex_ui.js";
import { openGCManagementModal } from "./status_gc_ui.js";
// 全局变量缓存
let currentSettings = null;

export function initStatusSettings() {
  const container = document.getElementById("tab-status");

  // 1. 获取设置
  currentSettings =
    getStatusSettings() || JSON.parse(JSON.stringify(DEFAULT_STATUS_SETTINGS));
  if (typeof currentSettings.status_enabled === "undefined")
    currentSettings.status_enabled = false;
  if (!currentSettings.prompt_rules) currentSettings.prompt_rules = [];

  // 检查是否存在 {{chat_context}}，不存在则自动补全
  const hasChatContext = currentSettings.prompt_rules.some(
    (r) => r.content === "{{chat_context}}",
  );
  if (!hasChatContext) {
    // 插入到数组末尾（或者你喜欢的任意位置，比如第二个）
    currentSettings.prompt_rules.push({
      role: "user",
      title: "增量剧情",
      content: "{{chat_context}}",
    });
    // 不必立即 save，等用户操作其他东西时一并保存，或者手动 saveStatusSettings(currentSettings);
  }

  const hasCharInfo = currentSettings.prompt_rules.some(
    (r) => r.type === "char_info",
  );
  const hasUserInfo = currentSettings.prompt_rules.some(
    (r) => r.type === "user_info",
  );

  if (!hasUserInfo) {
    currentSettings.prompt_rules.unshift({
      type: "user_info",
      role: "system",
      enabled: true,
    });
  }
  if (!hasCharInfo) {
    currentSettings.prompt_rules.unshift({
      type: "char_info",
      role: "system",
      enabled: true,
    });
  }

  // 2. 渲染总开关
  const masterSwitchHtml = `
        <div class="anima-setting-group" style="margin-bottom: 20px;">
            <div class="anima-card" style="border-left: 4px solid var(--anima-primary);">
                <div class="anima-flex-row" style="justify-content: space-between; align-items: center;">
                    <div class="anima-label-group">
                        <span class="anima-label-text" style="font-size: 1.1em; font-weight: bold;">启用状态管理</span>
                        <span class="anima-desc-inline">开启后启用实时状态追踪、自动状态向量检索与动态提示词注入</span>
                    </div>
                    <label class="anima-switch">
                        <input type="checkbox" id="status_master_switch" ${currentSettings.status_enabled ? "checked" : ""}>
                        <span class="slider round"></span>
                    </label>
                </div>
            </div>
        </div>
    `;

  const contentStyle = currentSettings.status_enabled ? "" : "display: none;";

  // --- YAML 模块 (Real-time Status) ---
  const yamlModuleHtml = `
        <h2 class="anima-title"><i class="fa-solid fa-heart-pulse"></i> 实时状态</h2>
        <div class="anima-card">
            
            <div class="anima-flex-row" style="justify-content: space-between; margin-bottom: 5px; align-items: center; flex-wrap: wrap; gap: 10px;">
                <label class="anima-label-text" style="margin: 0;">状态信息 (YAML)</label>
                
                <div id="status-yaml-actions-view" style="display:flex; gap:5px; flex-shrink: 0;">
                    <button id="btn-refresh-status" class="anima-btn secondary small" title="刷新UI显示" style="white-space: nowrap;"><i class="fa-solid fa-rotate-right"></i> 刷新</button>
                    <button id="btn-sync-status" class="anima-btn secondary small" title="请求副API进行增量更新" style="white-space: nowrap;"><i class="fa-solid fa-cloud-arrow-down"></i> 同步</button>
                    <button id="anima-btn-edit-status" class="anima-btn primary small" title="手动编辑" style="white-space: nowrap;"><i class="fa-solid fa-pen-to-square"></i> 编辑</button>
                </div>
                
                <div id="status-yaml-actions-edit" style="display:none; gap:5px; flex-shrink: 0;">
                    <button id="btn-confirm-status" class="anima-btn primary small" title="确认" style="white-space: nowrap;"><i class="fa-solid fa-check"></i> 确认</button>
                    <button id="btn-cancel-status" class="anima-btn danger small" title="取消" style="white-space: nowrap;"><i class="fa-solid fa-xmark"></i> 取消</button>
                </div>
            </div>

            <div style="font-size: 12px; color: #aaa; display:flex; flex-wrap: wrap; gap: 15px; margin-bottom: 8px; padding: 4px 8px; background: rgba(0,0,0,0.2); border-radius: 4px;">
                <span title="当前状态数据的字符长度"><i class="fa-solid fa-calculator"></i> 字符数: <span id="val-status-char-count" style="color: #a6e3a1; font-weight: bold;">0</span></span>
                <span title="当前状态数据的来源楼层"><i class="fa-solid fa-code-branch"></i> 源: <span id="val-source-floor-id">--</span></span>
                <span title="当前对话的最新楼层"><i class="fa-solid fa-clock"></i> 最新: <span id="val-current-floor-id">--</span></span>
            </div>

            <textarea id="status-yaml-content" class="anima-textarea" rows="6" disabled
                style="font-family: monospace; line-height: 1.4; color: #a6e3a1; background: rgba(0,0,0,0.3); width:100%; box-sizing: border-box; margin-bottom: 5px;"
            ></textarea>

            <div id="status-gc-section" style="margin-top: 15px; padding-top: 15px; border-top: 1px dashed var(--anima-border);">
                <div class="anima-flex-row" style="justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <label class="anima-label-text" style="margin: 0; color: var(--anima-warning, #fbbf24);">
                        <i class="fa-solid fa-broom"></i> 状态清洗
                    </label>
                    
                    <div id="gc-actions-main" style="display:flex; gap:5px;">
                        <button id="btn-gc-manage" class="anima-btn secondary small" title="管理清洗规则"><i class="fa-solid fa-gear"></i>清洗规则</button>
                        <button id="btn-gc-execute" class="anima-btn secondary small" title="调用高级API清洗状态"><i class="fa-solid fa-play"></i> 执行</button>
                    </div>

                    <div id="gc-actions-result" style="display:none; gap:5px;">
                        <button id="btn-gc-edit" class="anima-btn secondary small" title="手动微调清洗结果"><i class="fa-solid fa-pen-to-square"></i> 编辑</button>
                        <button id="btn-gc-apply" class="anima-btn success small" title="确认写入到楼层变量" style="background: #10b981; border-color: #059669; color: white;"><i class="fa-solid fa-check-double"></i> 写入</button>
                        <button id="btn-gc-discard" class="anima-btn danger small" title="放弃结果并清空"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>

                <div id="gc-info-bar" style="display:none; font-size: 12px; color: #fbbf24; margin-bottom: 5px; text-align: right;">
                    <i class="fa-solid fa-calculator"></i> 清洗后字符数: <span id="val-gc-char-count" style="font-weight: bold;">0</span>
                </div>

                <textarea id="gc-result-content" class="anima-textarea" rows="6" disabled
                    placeholder="等待执行清洗..."
                    style="font-family: monospace; line-height: 1.4; color: #fbbf24; background: rgba(0,0,0,0.4); border: 1px solid #fbbf24; width:100%; box-sizing: border-box; display: none;"
                ></textarea>

                <div id="gc-diff-preview" style="
                    display: none; 
                    font-family: monospace; 
                    font-size: 13px;
                    line-height: 1.5; 
                    background: rgba(0,0,0,0.4); 
                    border: 1px solid #fbbf24; 
                    border-radius: 4px;
                    width: 100%; 
                    box-sizing: border-box; 
                    padding: 10px; 
                    max-height: 250px; 
                    overflow-y: auto;
                    white-space: pre-wrap;
                "></div>

                <div id="gc-actions-edit-confirm" style="display:none; justify-content: flex-end; gap:5px; margin-top:5px;">
                    <button id="btn-gc-confirm-edit" class="anima-btn primary small"><i class="fa-solid fa-check"></i> 完成编辑</button>
                </div>
            </div>
        </div>
    `;

  function initGCModule() {
    const $btnManage = $("#btn-gc-manage");
    const $btnExecute = $("#btn-gc-execute");
    const $btnEdit = $("#btn-gc-edit");
    const $btnApply = $("#btn-gc-apply");
    const $btnDiscard = $("#btn-gc-discard");

    const $actionsMain = $("#gc-actions-main");
    const $actionsResult = $("#gc-actions-result");
    const $actionsEditConfirm = $("#gc-actions-edit-confirm");
    const $btnConfirmEdit = $("#btn-gc-confirm-edit");

    const $textarea = $("#gc-result-content");
    const $diffPreview = $("#gc-diff-preview");
    const $infoBar = $("#gc-info-bar");
    const $charCount = $("#val-gc-char-count");

    let tempGCContent = "";

    // 【核心】记录清洗针对的具体是哪一层
    let currentGCTargetId = -1;

    // 1. 管理按钮 -> 打开我们在独立文件写的弹窗
    $btnManage.off("click").on("click", (e) => {
      e.preventDefault();
      openGCManagementModal();
    });

    let originalStateObj = {};

    // 2. 执行按钮 -> 调用后端逻辑
    $btnExecute.off("click").on("click", async (e) => {
      e.preventDefault();
      const originalText = $btnExecute.html();
      $btnExecute
        .html('<i class="fa-solid fa-spinner fa-spin"></i> 处理中...')
        .prop("disabled", true);

      try {
        const result = await executeGCProcess();
        currentGCTargetId = result.targetMsgId;
        try {
          let oldVars = window.TavernHelper.getVariables({
            type: "message",
            message_id: currentGCTargetId,
          });
          originalStateObj = oldVars ? oldVars.anima_data || oldVars : {};

          const newObj = yamlToObject(result.yaml) || {};
          const diffHtml = generateDiffHtml(originalStateObj, newObj);

          // 隐藏文本框，显示高亮对比层
          $textarea.val(result.yaml).hide();
          $diffPreview.html(diffHtml).show();
        } catch (diffErr) {
          console.warn("Diff生成失败，降级显示纯文本", diffErr);
          $textarea.val(result.yaml).show();
          $diffPreview.hide();
        }

        updateGCCharCount();
        $infoBar.show();
        $actionsMain.hide();
        $actionsResult.css("display", "flex");

        if (window.toastr)
          toastr.success(`状态清洗完成，准备覆盖楼层 #${currentGCTargetId}`);
      } catch (err) {
        if (window.toastr) toastr.error("清洗失败: " + err.message);
        console.error("[Anima GC Error]:", err);
      } finally {
        $btnExecute.html(originalText).prop("disabled", false);
      }
    });

    // 3. 结果编辑 (保持不变)
    $btnEdit.off("click").on("click", (e) => {
      e.preventDefault();
      tempGCContent = $textarea.val();

      $diffPreview.hide(); // 隐藏对比层
      $textarea
        .show()
        .prop("disabled", false)
        .addClass("anima-input-active")
        .focus();

      $actionsResult.hide();
      $actionsEditConfirm.css("display", "flex");
    });

    $btnConfirmEdit.off("click").on("click", (e) => {
      e.preventDefault();
      $textarea.prop("disabled", true).removeClass("anima-input-active");
      try {
        const editedObj = yamlToObject($textarea.val()) || {};
        const diffHtml = generateDiffHtml(originalStateObj, editedObj);
        $textarea.hide();
        $diffPreview.html(diffHtml).show();
      } catch (e) {
        // 如果用户把 YAML 改废了，就老老实实显示文本框
        $textarea.show();
        $diffPreview.hide();
      }

      updateGCCharCount();
      $actionsEditConfirm.hide();
      $actionsResult.css("display", "flex");
    });

    // 4. 放弃按钮 (保持不变)
    $btnDiscard.off("click").on("click", (e) => {
      e.preventDefault();
      resetGCUI();
    });

    // 5. 【核心】写入按钮 -> 将结果精准覆盖回原楼层
    $btnApply.off("click").on("click", async (e) => {
      e.preventDefault();
      const yamlStr = $textarea.val();

      try {
        const statusObj = yamlToObject(yamlStr);
        if (!statusObj) throw new Error("YAML 格式无效或为空");

        if (currentGCTargetId !== -1) {
          // 如果成功捕获到了楼层ID，精准写入该楼层
          await saveStatusToMessage(
            currentGCTargetId,
            { anima_data: statusObj },
            "manual_ui",
          );
        } else {
          // 兜底方案：如果因为某些原因没找到基准楼层，写入最新层
          await saveRealtimeStatusVariables({ anima_data: statusObj });
        }

        if (window.toastr)
          toastr.success(
            `清洗结果已成功覆写至楼层 #${currentGCTargetId !== -1 ? currentGCTargetId : "最新"}！`,
          );

        // 保存成功后：清空结果框、隐藏底部UI
        resetGCUI();

        // 强制刷新上方的主状态输入框
        setTimeout(() => refreshStatusPanel(), 500);
      } catch (err) {
        if (window.toastr) toastr.error("写入失败: " + err.message);
      }
    });

    // 实时监听输入框变化，更新字数
    $textarea.on("input", updateGCCharCount);
    // 同时也帮主输入框加上实时字数监听（当用户点击上方“编辑”时生效）
    $("#status-yaml-content").on("input", function () {
      $("#val-status-char-count").text($(this).val().length);
    });

    function updateGCCharCount() {
      $charCount.text($textarea.val().length);
    }
    function resetGCUI() {
      $textarea
        .val("")
        .hide()
        .prop("disabled", true)
        .removeClass("anima-input-active");

      $diffPreview.empty().hide(); // 关键！清空并隐藏对比层

      $infoBar.hide();
      $actionsResult.hide();
      $actionsEditConfirm.hide();
      $actionsMain.css("display", "flex");
    }
  }

  const updateSettings = currentSettings.update_management || {
    stop_sequence: "",
    panel_enabled: false,
  };

  const zodSettings = currentSettings.zod_settings || {
    mode: "ui", // 'ui' | 'script'
    rules: [], // [{ path: 'NPC.Sam.HP', type: 'number', min: 0, max: 100 }, ...]
    script_content: "", // raw script content
  };

  const zodModuleHtml = `
        <h2 class="anima-title" style="margin-top: 25px;"><i class="fa-solid fa-shield-halved"></i> 输出校验 (Zod)</h2>
        <div class="anima-card" style="position: relative;">
            <div class="anima-desc-inline" style="margin-bottom:10px;">
                配置 Zod 校验规则以防止幻觉。校验将在合并增量前执行。
            </div>

            <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px;">
                
                <div style="display: flex; align-items: center; gap: 10px; flex: 1; min-width: 180px;">
                    <span class="anima-label-text" style="margin: 0; white-space: nowrap;">配置模式</span>
                    <select id="zod-mode-select" class="anima-select" style="flex: 1; margin: 0; height: 32px; padding: 0 5px; cursor: pointer; box-sizing: border-box;">
                        <option value="ui" ${zodSettings.mode === "ui" ? "selected" : ""}>🛠️ 可视化配置</option>
                        <option value="script" ${zodSettings.mode === "script" ? "selected" : ""}>📜 自定义脚本</option>
                    </select>
                </div>
                
                <div style="display: flex; align-items: center; gap: 5px; flex-wrap: wrap;">
                    <input type="file" id="zod_import_file" accept=".json" style="display: none;" />

                    <button id="btn-import-zod" class="anima-btn secondary small" title="导入配置 (JSON)" style="height: 32px;">
                        <i class="fa-solid fa-file-import"></i>
                    </button>
                    <button id="btn-export-zod" class="anima-btn secondary small" title="导出配置 (JSON)" style="height: 32px;">
                        <i class="fa-solid fa-file-export"></i>
                    </button>

                    <div style="width: 1px; height: 20px; background: var(--anima-border); margin: 0 2px;"></div>

                    <button id="btn-test-zod-rules" class="anima-btn secondary small" title="打开测试沙箱" style="height: 32px; padding: 0 10px;">
                        <i class="fa-solid fa-vial"></i> 测试
                    </button>
                </div>
            </div>

            <div id="zod-ui-container" style="${zodSettings.mode === "ui" ? "" : "display:none;"}">
                <div id="zod-rules-list" style="display:flex; flex-direction:column; gap: 8px; margin-bottom: 10px;"></div>
                <button id="btn-add-zod-rule" class="anima-btn secondary" style="width: 100%; border-style: dashed; opacity: 0.8;">
                    <i class="fa-solid fa-plus"></i> 添加校验规则
                </button>
            </div>

            <div id="zod-script-container" style="${zodSettings.mode === "script" ? "" : "display:none;"}">
                <div class="anima-flex-row" style="justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <span class="anima-desc-inline">
                        输入 Zod Schema 定义代码。<br>示例: <code>return z.object({ HP: z.number().min(0) });</code>
                    </span>
                    <div id="zod-script-actions-view" style="display:flex;">
                        <button id="btn-zod-script-edit" class="anima-btn secondary small"><i class="fa-solid fa-pen-to-square"></i> 编辑</button>
                    </div>
                    <div id="zod-script-actions-edit" style="display:none; gap:5px;">
                        <button id="btn-zod-script-confirm" class="anima-btn primary small"><i class="fa-solid fa-check"></i></button>
                        <button id="btn-zod-script-cancel" class="anima-btn danger small"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                </div>

                <textarea id="zod-script-input" class="anima-textarea" rows="8" disabled
                    style="font-family: monospace; font-size: 12px; white-space: pre; width: 100%; box-sizing: border-box;"
                >${escapeHtml(zodSettings.script_content || "")}</textarea>
            </div>

            <div style="margin-top: 15px; padding-top: 10px; border-top: 1px solid var(--anima-border);">
                <button id="btn-save-zod-card" class="anima-btn primary" style="width:100%">
                    <i class="fa-solid fa-floppy-disk"></i> 保存到角色卡
                </button>
            </div>

            <div id="anima-zod-test-modal" class="anima-modal hidden">
                <div class="anima-modal-content" style="max-width: 600px;">
                    
                    <div class="anima-modal-header">
                        <div style="font-weight: bold; font-size: 1.1em; display: flex; align-items: center; gap: 8px;">
                            <i class="fa-solid fa-flask"></i> 规则测试台
                        </div>
                        <span class="anima-close-zod-test anima-close-modal">&times;</span>
                    </div>

                    <div class="anima-modal-body" style="display: flex; flex-direction: column; gap: 10px; min-height: 300px;">
                        
                        <div style="display: flex; flex-direction: column; gap: 5px; flex: 1;">
                            <label class="anima-label-text" style="color: var(--anima-primary);">1. 输入模拟 JSON</label>
                            <textarea id="zod-test-input-json" class="anima-textarea" 
                                placeholder='在这里粘贴副API可能返回的 JSON...'
                                style="flex: 1; min-height: 100px; font-family: monospace; font-size: 12px; resize: none; background: rgba(0,0,0,0.2);"
                            ></textarea>
                        </div>

                        <div style="text-align: center; color: #666; font-size: 14px; padding: 5px 0;">
                            <i class="fa-solid fa-arrow-down"></i>
                        </div>

                        <div style="display: flex; flex-direction: column; gap: 5px; flex: 1;">
                            <label class="anima-label-text" style="color: var(--anima-primary);">2. 测试日志</label>
                            <div id="zod-test-log-output" style="
                                flex: 1; 
                                min-height: 150px;
                                background: #111; 
                                color: #ccc; 
                                border: 1px solid #444; 
                                border-radius: 4px; 
                                padding: 10px; 
                                font-family: 'Consolas', monospace; 
                                font-size: 12px; 
                                overflow-y: auto; 
                                white-space: pre-wrap;
                            ">// 点击下方“执行测试”查看结果...</div>
                        </div>

                    </div>

                    <div class="anima-modal-footer">
                        <button class="anima-close-zod-test anima-btn secondary">退出</button>
                        <button id="btn-run-zod-test" class="anima-btn primary">
                            <i class="fa-solid fa-play"></i> 执行测试
                        </button>
                    </div>

                </div>
            </div>
        </div>
    `;

  const updateManagementHtml = `
        <h2 class="anima-title" style="margin-top: 25px;"><i class="fa-solid fa-sliders"></i> 状态更新管理</h2>
        <div class="anima-card">
            <div class="anima-flex-row" style="align-items: center; margin-bottom: 10px;">
                <div class="anima-label-group" style="flex: 1;">
                    <span class="anima-label-text">结束标签检测</span>
                    <span class="anima-desc-inline">当主API回复包含此字符串时，视为回复完整。留空则默认检测结束。</span>
                </div>
                <div style="flex: 1;">
                    <input type="text" id="status_stop_sequence" class="anima-input" 
                        placeholder="例如: <END>, </s>" value="${escapeHtml(updateSettings.stop_sequence || "")}">
                </div>
            </div>

            <div class="anima-flex-row" style="align-items: center; margin-bottom: 15px;">
                <div class="anima-label-group">
                    <span class="anima-label-text">启用状态更新面板</span>
                    <span class="anima-desc-inline">在主API回复结束后，显示侧边面板以供手动确认是否执行状态更新。</span>
                </div>
                <label class="anima-switch">
                    <input type="checkbox" id="status_panel_enabled" ${updateSettings.panel_enabled ? "checked" : ""}>
                    <span class="slider round"></span>
                </label>
            </div>

            <div class="anima-flex-row" style="align-items: center; margin-bottom: 15px;">
                <div class="anima-label-group" style="flex: 1;">
                    <span class="anima-label-text">字数阈值提醒</span>
                    <span class="anima-desc-inline">当状态字符数超过此值时，悬浮同步按钮将变红，设置为0，则永不变红。</span>
                </div>
                <div style="flex: 1;">
                    <input type="number" id="status_char_threshold" class="anima-input" 
                        placeholder="例如: 2000" value="${updateSettings.char_threshold || ""}">
                </div>
            </div>

            <div style="margin-top: 15px; padding-top: 10px; border-top: 1px solid var(--anima-border);">
                <button id="btn-save-update-config" class="anima-btn primary" style="width:100%">
                    <i class="fa-solid fa-floppy-disk"></i> 保存到全局
                </button>
            </div>
        </div>
    `;

  const historyModuleHtml = `
        <h2 class="anima-title" style="margin-top: 25px;"><i class="fa-solid fa-clock-rotate-left"></i> 历史状态</h2>
        <div class="anima-card" style="position: relative;">
            
            <div class="anima-flex-row" style="justify-content: space-between; align-items: center; margin-bottom: 10px; min-height: 32px;">
                <div class="anima-label-group">
                    <span class="anima-label-text">状态快照查看</span>
                    <span id="hist-current-floor-indicator" class="anima-tag primary" style="display:none; margin-left:10px;">Floor #--</span>
                </div>
                
                <div id="hist-actions-view" style="display:flex; gap:8px;">
                    <button id="btn-hist-refresh" class="anima-btn secondary small" title="刷新列表">
                        <i class="fa-solid fa-sync"></i> 刷新
                    </button>
                    <button id="btn-hist-edit" class="anima-btn primary small" title="编辑当前内容">
                        <i class="fa-solid fa-pen-to-square"></i> 编辑
                    </button>
                    <button id="btn-open-history-modal" class="anima-btn secondary small">
                        <i class="fa-solid fa-list-ul"></i> 选择楼层
                    </button>
                </div>

                <div id="hist-actions-edit" style="display:none; gap:8px;">
                    <button id="btn-hist-confirm" class="anima-btn primary" title="确认保存"><i class="fa-solid fa-check"></i> 确认</button>
                    <button id="btn-hist-cancel" class="anima-btn danger" title="取消编辑"><i class="fa-solid fa-xmark"></i> 取消</button>
                </div>
            </div>

            <textarea id="hist-yaml-content" class="anima-textarea" rows="8" disabled
                placeholder="请点击右上角“选择楼层”查看历史快照..."
                style="font-family: monospace; color: #ccc; background: rgba(0,0,0,0.2); width:100%; box-sizing: border-box;"
            ></textarea>

            <details id="greeting-binding-section" style="margin-top: 15px; border-top: 1px dashed var(--anima-border); padding-top: 10px;">
                <summary style="cursor: pointer; font-weight: bold; margin-bottom: 10px; color: var(--anima-primary); user-select: none;">
                    <i class="fa-solid fa-tags"></i> 开场白状态绑定
                </summary>

                <div style="background: rgba(0,0,0,0.1); padding: 10px; border-radius: 4px;">
                    <div class="anima-flex-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; gap: 8px;">
                        
                        <div style="flex: 1; display: flex; align-items: center;">
                            <select id="greeting-select" class="anima-select" style="width: 100%; max-width: 100%; text-overflow: ellipsis; white-space: nowrap; overflow: hidden;">
                                <option value="-1">-- 请选择开场白 --</option>
                            </select>
                        </div>
                        
                        <div id="greeting-actions-view" style="display:flex; gap:5px; align-items: center;">
                            <button id="btn-greeting-refresh" class="anima-btn secondary small" style="height: 32px;" title="刷新角色卡"><i class="fa-solid fa-rotate"></i></button>
                            <button id="btn-greeting-edit" class="anima-btn primary small" style="height: 32px;" title="编辑"><i class="fa-solid fa-pen-to-square"></i></button>
                        </div>

                        <div id="greeting-actions-edit" style="display:none; gap:5px; align-items: center;">
                             <button id="btn-greeting-confirm-edit" class="anima-btn primary small" style="height: 32px;" title="暂存"><i class="fa-solid fa-check"></i></button>
                             <button id="btn-greeting-cancel-edit" class="anima-btn danger small" style="height: 32px;" title="放弃"><i class="fa-solid fa-xmark"></i></button>
                        </div>
                    </div>

                    <textarea id="greeting-yaml-content" class="anima-textarea" rows="5" disabled
                        placeholder="在此配置选中开场白的初始 YAML 状态..."
                        style="font-family: monospace; width:100%; box-sizing: border-box; font-size: 12px; margin-bottom: 10px;"
                    ></textarea>

                    <div style="border-top: 1px solid rgba(255,255,255,0.1); padding-top: 10px;">
                        <button id="btn-greeting-save-card" class="anima-btn primary" style="width:100%">
                            <i class="fa-solid fa-floppy-disk"></i> 保存所有绑定关系到角色卡
                        </button>
                    </div>
                </div>
            </details>

            <div id="anima-history-modal" class="anima-modal hidden">
                <div class="anima-modal-content" style="max-width: 450px;">
                    
                    <div class="anima-modal-header">
                        <span class="anima-label-text" style="font-size: 1.1em;">选择历史楼层</span>
                        <span id="btn-close-history-modal" class="anima-close-modal">&times;</span>
                    </div>

                    <div class="anima-modal-body" style="padding: 10px;">
                        <div id="history-list-container" style="flex: 1; overflow-y: auto; display:flex; flex-direction:column; gap:5px; min-height: 300px; max-height: 60vh;">
                            <div style="text-align:center; color:#888; margin-top: 20px;">正在加载...</div>
                        </div>
                    </div>

                    <div class="anima-modal-footer">
                        <button id="btn-modal-cancel" class="anima-btn secondary">关闭</button>
                    </div>
                </div>
            </div>
        </div>
    `;

  // --- 新增：正则处理模块 (复刻 Summary) ---
  // 默认值处理
  const regexSettings = currentSettings.regex_settings || {
    skip_layer_zero: true,
    regex_skip_user: false,
    exclude_user: false,
    regex_list: [],
  };

  const combinedPromptHtml = `
        <h2 class="anima-title" style="margin-top: 25px;"><i class="fa-solid fa-layer-group"></i>状态更新提示词</h2>
        <div class="anima-card">
            
            <div style="margin-bottom: 20px;">
                <div class="anima-flex-row" style="justify-content: space-between; margin-bottom: 10px; align-items: center;">
                    <div class="anima-label-text"><i class="fa-solid fa-filter"></i> 上下文清洗正则</div>
                    <button id="btn-add-status-regex" class="anima-btn small secondary">
                        <i class="fa-solid fa-plus"></i> 添加
                    </button>
                </div>
                
                <div id="status_regex_list_container" class="anima-regex-list" style="margin-bottom: 15px;"></div>

                <div style="background: rgba(0,0,0,0.2); padding: 15px; border-radius: 5px; margin-bottom: 15px;">
                    
                    <div class="anima-flex-row" style="justify-content: space-between; align-items: center; margin-bottom: 12px;">
                        <div class="anima-label-group">
                            <span class="anima-label-text">正则跳过开场白</span>
                            <span class="anima-desc-inline">开启后，第 0 层（开场白/设定）将保持原文。</span>
                        </div>
                        <label class="anima-switch">
                            <input type="checkbox" id="status_regex_skip_zero" ${regexSettings.skip_layer_zero ? "checked" : ""}>
                            <span class="slider round"></span>
                        </label>
                    </div>

                    <div class="anima-flex-row" style="justify-content: space-between; align-items: center; margin-bottom: 12px;">
                        <div class="anima-label-group">
                            <span class="anima-label-text">正则跳过 User 消息</span>
                            <span class="anima-desc-inline">开启后，User 发送的内容将保留原文，不进行正则清洗。</span>
                        </div>
                        <label class="anima-switch">
                            <input type="checkbox" id="status_regex_skip_user" ${regexSettings.regex_skip_user ? "checked" : ""}>
                            <span class="slider round"></span>
                        </label>
                    </div>

                    <div class="anima-flex-row" style="justify-content: space-between; align-items: center;">
                        <div class="anima-label-group">
                            <span class="anima-label-text">完全排除 User 消息</span>
                            <span class="anima-desc-inline">Prompt 中将完全剔除 User 消息，仅保留 Assistant 回复。</span>
                        </div>
                        <label class="anima-switch">
                            <input type="checkbox" id="status_regex_exclude_user" ${regexSettings.exclude_user ? "checked" : ""}>
                            <span class="slider round"></span>
                        </label>
                    </div>
                </div>
            </div>

            <hr style="border: 0; border-top: 1px solid var(--anima-border); margin: 20px 0;">

            <div>
                <div class="anima-flex-row" style="justify-content: space-between; margin-bottom: 15px; align-items: center; flex-wrap: wrap; gap: 10px;">
                    
                    <div style="min-width: 150px;">
                        <div class="anima-label-text"><i class="fa-solid fa-list-ol"></i> 状态提示词预设</div>
                        <div class="anima-desc-inline">组装发送给 状态模型 的最终提示词。</div>
                    </div>
                    
                    <div style="display: flex; gap: 5px; flex-wrap: wrap;">
                        <button id="btn-export-status-prompt" class="anima-btn small secondary" title="导出" style="height: 32px;">
                            <i class="fa-solid fa-file-export"></i>
                        </button>
                        <button id="btn-import-status-prompt" class="anima-btn small secondary" title="导入" style="height: 32px;">
                            <i class="fa-solid fa-file-import"></i>
                        </button>
                        <input type="file" id="status_import_prompt_file" accept=".json" style="display: none;" />
                        
                        <div style="width: 1px; height: 20px; background: var(--anima-border); margin: 0 2px; align-self: center;"></div>

                        <button id="btn-preview-status-prompt" class="anima-btn small secondary" style="height: 32px;">
                            <i class="fa-solid fa-eye"></i> 预览
                        </button>
                        <button id="btn-add-status-prompt" class="anima-btn small primary" style="height: 32px;">
                            <i class="fa-solid fa-plus"></i> 添加
                        </button>
                    </div>
                </div>
                
                <div id="anima_status_prompt_list" class="anima-regex-list" style="min-height: 100px; padding: 5px;"></div>
                
                <div style="margin-top: 15px; padding-top: 10px;">
                    <button id="btn-save-prompt-card" class="anima-btn primary" style="width:100%">
                        <i class="fa-solid fa-floppy-disk"></i> 保存到角色卡
                    </button>
                </div>
            </div>
        </div>
    `;

  // --- 美化模块 (Beautification) ---
  const beautifyHtml = `
        <h2 class="anima-title" style="margin-top: 25px;"><i class="fa-solid fa-wand-magic-sparkles"></i> 状态栏美化</h2>
        <div class="anima-card">
            <div class="anima-flex-row" style="justify-content: space-between; align-items: center; margin-bottom: 10px;">
                <div class="anima-label-group">
                    <span class="anima-label-text">启用美化显示</span>
                    <span class="anima-desc-inline">在上一轮回复末尾显示装饰性的状态栏</span>
                </div>
                <label class="anima-switch">
                    <input type="checkbox" id="toggle_beautify_enabled" ${currentSettings.beautify_settings?.enabled ? "checked" : ""}>
                    <span class="slider round"></span>
                </label>
            </div>

            <div id="beautify-editor-area" style="${currentSettings.beautify_settings?.enabled ? "" : "display:none;"}; border-top: 1px solid var(--anima-border); padding-top: 10px; margin-top: 10px;">
                
                <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; width: 100%; margin-bottom: 8px;">
                    <span class="anima-desc-inline">支持 HTML/CSS。使用 <code>{{status}}</code> 引用。</span>
                    
                    <div style="margin-left: auto; display: flex; align-items: center; flex-wrap: wrap; gap: 5px;">
                        <div id="beautify-actions-edit" style="display:none; gap:5px;">
                            <button id="btn-beautify-confirm" class="anima-btn primary small" title="保存"><i class="fa-solid fa-check"></i> 确认</button>
                            <button id="btn-beautify-cancel" class="anima-btn danger small" title="取消"><i class="fa-solid fa-xmark"></i> 取消</button>
                        </div>
                        
                        <div id="beautify-actions-view" style="display:flex; gap:5px; align-items: center; flex-wrap: wrap;">
                            <input type="file" id="beautify_import_file" accept=".json" style="display: none;" />
                            
                            <button id="btn-import-beautify" class="anima-btn secondary small" title="导入模板 (JSON)">
                                <i class="fa-solid fa-file-import"></i> </button>
                            <button id="btn-export-beautify" class="anima-btn secondary small" title="导出模板 (JSON)">
                                <i class="fa-solid fa-file-export"></i> </button>

                            <div style="width: 1px; height: 16px; background: var(--anima-border); margin: 0 4px;"></div>

                            <button id="btn-beautify-edit" class="anima-btn secondary small"><i class="fa-solid fa-pen-to-square"></i> </button>
                            <button id="btn-beautify-preview" class="anima-btn primary small"><i class="fa-solid fa-eye"></i> </button>
                        </div>
                    </div>
                </div>

                <textarea id="beautify-template-input" class="anima-textarea" rows="8" disabled
                    style="font-family: monospace; font-size: 12px; white-space: pre; display: block; width: 100%; box-sizing: border-box;"
                >${escapeHtml(currentSettings.beautify_settings?.template || "")}</textarea>
                
                <div id="beautify-preview-container" 
                     style="display:none; margin-top:10px; border:1px dashed #666; padding:10px; border-radius:4px; min-height:60px; background:rgba(0,0,0,0.3);">
                </div>
            </div>
            <div style="margin-top: 15px;">
                <button id="btn-save-beautify-card" class="anima-btn primary" style="width:100%">
                    <i class="fa-solid fa-floppy-disk"></i> 保存到角色卡
                </button>
            </div>
        </div>
    `;

  // --- 注入模块 (Injection) - 已修复空隙问题 ---
  const injectionSettings = currentSettings.injection_settings || {};
  const injectionHtml = `
        <h2 class="anima-title" style="margin-top: 25px;"><i class="fa-solid fa-book-journal-whills"></i> 世界书注入配置</h2>
        <div class="anima-card">
            
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px;">
                <div class="anima-compact-input">
                    <div class="anima-label-small">插入位置</div>
                    <select id="inject-position" class="anima-select">
                        <option value="at_depth" ${injectionSettings.position === "at_depth" ? "selected" : ""}>@D</option>
                        <option value="before_char" ${injectionSettings.position === "before_char" ? "selected" : ""}>角色定义之前</option>
                        <option value="after_char" ${injectionSettings.position === "after_char" ? "selected" : ""}>角色定义之后</option>
                    </select>
                </div>
                <div class="anima-compact-input">
                    <div class="anima-label-small">角色</div>
                    <select id="inject-role" class="anima-select">
                        <option value="system" ${injectionSettings.role === "system" ? "selected" : ""}>System</option>
                        <option value="user" ${injectionSettings.role === "user" ? "selected" : ""}>User</option>
                        <option value="assistant" ${injectionSettings.role === "assistant" ? "selected" : ""}>Assistant</option>
                    </select>
                </div>
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px;">
                <div class="anima-compact-input">
                    <div class="anima-label-small">深度</div>
                    <input type="number" id="inject-depth" class="anima-input" 
                           placeholder="0" value="${injectionSettings.depth ?? 1}">
                </div>
                <div class="anima-compact-input">
                    <div class="anima-label-small">顺序</div>
                    <input type="number" id="inject-order" class="anima-input" 
                           placeholder="100" value="${injectionSettings.order ?? 100}">
                </div>
            </div>

            <div style="border-top: 1px solid var(--anima-border); padding-top: 10px; margin-top: 10px;">
                <div style="display: flex; align-items: center; width: 100%; margin-bottom: 8px;">
                    <div style="font-weight: bold; font-size: 0.95em; white-space: nowrap;">
                        <i class="fa-solid fa-pen-nib"></i> 注入内容构建
                    </div>

                    <div style="margin-left: auto; display: flex; align-items: center;">
                        <div id="inject-actions-edit" style="display:none; gap:5px;">
                            <button id="btn-inject-confirm" class="anima-btn primary small" title="确认修改">
                                <i class="fa-solid fa-check"></i>
                            </button>
                            <button id="btn-inject-cancel" class="anima-btn danger small" title="取消">
                                <i class="fa-solid fa-xmark"></i>
                            </button>
                        </div>
                        <div id="inject-actions-view" style="display:flex; gap:5px;">
                            <button id="btn-inject-edit" class="anima-btn secondary small">
                                <i class="fa-solid fa-pen-to-square"></i> 编辑
                            </button>
                        </div>
                    </div>
                </div>
                
                <textarea id="inject-template-input" class="anima-textarea" rows="4" disabled
                    placeholder="在此输入需要注入的内容，推荐使用 {{format_message_variable::anima_data}} ..."
                    style="font-family: monospace; display: block; width: 100%; box-sizing: border-box; font-size: 13px;"
                >${escapeHtml(injectionSettings.template || "")}</textarea>
                
                <div class="anima-desc-inline" style="margin-top: 5px;">
                    <i class="fa-solid fa-circle-info"></i> 
                    内容将直接写入世界书。支持使用 ST 原生宏，例如 <code>{{format_message_variables::anima_data}}</code>。
                </div>
            </div>
            <div style="margin-top: 15px; padding-top: 10px; ">
                <button id="btn-inject-save-card" class="anima-btn primary" style="width:100%">
                    <i class="fa-solid fa-floppy-disk"></i> 保存
                </button>
            </div>
        </div>
    `;

  // 组合 HTML
  const mainContentHtml = `
        <div id="status-main-content" style="${contentStyle}">
            ${yamlModuleHtml} 
            ${historyModuleHtml}
            ${updateManagementHtml}
            ${zodModuleHtml}
            ${combinedPromptHtml}    
            ${beautifyHtml}
            ${injectionHtml}
        </div>
    `;
  container.innerHTML = masterSwitchHtml + mainContentHtml;

  // 4. 初始化逻辑
  bindMasterSwitch();
  initYamlEditor();
  renderStatusList();
  initBeautifyModule();
  initInjectionModule();
  initHistoryModule();
  initStatusRegexModule();
  initUpdateManagementModule();
  initZodModule();
  bindGlobalEvents();
  initGCModule();
  initFloatingSyncButton();
  setTimeout(() => {
    refreshStatusPanel();
  }, 500);
}

function initStatusRegexModule() {
  // 1. 确保配置对象存在
  if (!currentSettings.regex_settings) {
    currentSettings.regex_settings = {
      skip_layer_zero: true,
      regex_skip_user: false,
      exclude_user: false,
      regex_list: [],
    };
  }
  const settings = currentSettings.regex_settings;

  // 2. 绑定开关事件 (保持不变)
  $("#status_regex_skip_zero").on("change", function () {
    settings.skip_layer_zero = $(this).prop("checked");
    saveStatusSettings(currentSettings);
  });
  $("#status_regex_skip_user").on("change", function () {
    settings.regex_skip_user = $(this).prop("checked");
    saveStatusSettings(currentSettings);
  });
  $("#status_regex_exclude_user").on("change", function () {
    settings.exclude_user = $(this).prop("checked");
    saveStatusSettings(currentSettings);
  });

  // 3. 初始化正则列表组件 (保持不变)
  const regexComponent = new RegexListComponent(
    "status_regex_list_container",
    () => settings.regex_list || [],
    (newList) => {
      settings.regex_list = newList;
      saveStatusSettings(currentSettings);
    },
  );
  regexComponent.render();

  // ============================================================
  // 4. 【核心修改】模态框隔离逻辑
  // ============================================================

  // 定义一套 Status 页面专用的 ID
  const modalId = "anima-regex-input-modal-status";
  const inputTypeId = "anima_new_regex_type_status";
  const inputStrId = "anima_new_regex_str_status";
  const btnConfirmId = "anima_btn_confirm_add_regex_status";
  const btnCloseClass = "anima-close-regex-modal-status";

  // 检查是否已存在，不存在则创建
  if ($("#" + modalId).length === 0) {
    // 获取原始 HTML 模板
    let html = getRegexModalHTML();

    // 暴力替换 ID，生成独立副本
    html = html.replace('id="anima-regex-input-modal"', `id="${modalId}"`);
    html = html.replace('id="anima_new_regex_type"', `id="${inputTypeId}"`);
    html = html.replace('id="anima_new_regex_str"', `id="${inputStrId}"`);
    html = html.replace(
      'id="anima_btn_confirm_add_regex"',
      `id="${btnConfirmId}"`,
    );
    // 替换 Class 以便绑定关闭事件 (把原有的 class 替换掉或者追加)
    html = html.replace(
      'class="anima-close-regex-modal',
      `class="${btnCloseClass} anima-close-regex-modal`,
    );

    $("body").append(html);

    // 绑定关闭事件 (针对新 ID)
    $(`#${modalId}, .${btnCloseClass}`).on("click", function (e) {
      if (e.target === this || $(e.target).hasClass(btnCloseClass)) {
        $(`#${modalId}`).removeClass("active").addClass("hidden");
      }
    });
  }

  // 5. 绑定“添加规则”按钮 (指向新的模态框 ID)
  $("#btn-add-status-regex")
    .off("click")
    .on("click", () => {
      const $modal = $(`#${modalId}`);
      $modal.removeClass("hidden").addClass("active");

      // 绑定确认按钮 (指向新的 Input ID)
      $(`#${btnConfirmId}`)
        .off("click")
        .on("click", () => {
          const type = $(`#${inputTypeId}`).val();
          const regexStr = $(`#${inputStrId}`).val();
          if (regexStr) {
            regexComponent.addRule(regexStr, type);
            $modal.removeClass("active").addClass("hidden");
            $(`#${inputStrId}`).val("");
          }
        });
    });
}

function bindRegexModalEvents() {
  // 通用关闭 (点击背景)
  $("#anima-regex-input-modal").on("click", function (e) {
    if (e.target === this) {
      $(this).removeClass("active").addClass("hidden");
    }
  });
}
// ==========================================
// 逻辑模块 0: 总开关
// ==========================================
function bindMasterSwitch() {
  $("#status_master_switch").on("change", function () {
    const isEnabled = $(this).prop("checked");
    currentSettings.status_enabled = isEnabled;

    // 核心修改：状态改变立即保存到 extensionSettings
    saveStatusSettings(currentSettings);

    if (isEnabled) {
      $("#status-main-content").slideDown(200);
    } else {
      $("#status-main-content").slideUp(200);
    }

    // 🔥【核心修复】总开关关闭时，也必须强制刷新一下面板
    // 这样 refreshStatusPanel 里的逻辑（见下一步）就能把悬浮按钮干掉
    refreshStatusPanel();
  });
}

// ==========================================
// 逻辑模块 1: YAML 编辑器 (Real-time Status)
// ==========================================
/**
 * 【核心/导出】刷新状态面板 UI
 * 供 index.js 和 logic 模块调用
 */
export function refreshStatusPanel() {
  const $textarea = $("#status-yaml-content");
  const $sourceIndicator = $("#val-source-floor-id");
  const $currentIndicator = $("#val-current-floor-id");
  const $syncBtn = $("#anima-floating-sync-btn");

  if ($textarea.length === 0) return;

  // 【新增】如果没有聊天记录（比如关闭了聊天窗口）
  const context = SillyTavern.getContext();
  if (!context.chatId || !window.TavernHelper) {
    $textarea.val(""); // 清空 YAML
    $textarea.attr("placeholder", "未加载聊天...");
    $sourceIndicator.text("--");
    $currentIndicator.text("--");
    if ($syncBtn.length > 0) $syncBtn.hide();
    return;
  }

  try {
    // 1. 获取全量消息以定位 ID
    const allMsgs = window.TavernHelper.getChatMessages("0-{{lastMessageId}}", {
      include_swipes: false,
    });

    let currentId = "--";
    let displaySource = "None";
    let finalStatusObj = {};

    // 标记：是否应该显示同步按钮
    let shouldShowSyncBtn = false;

    if (allMsgs && allMsgs.length > 0) {
      const lastMsg = allMsgs[allMsgs.length - 1];
      currentId = lastMsg.message_id;

      // 判断是否为 AI 消息 (Layer 0 通常被视为 AI，除非手动改成 User)
      // 增加 role 判断以增强稳定性
      const isAi = !lastMsg.is_user || lastMsg.role === "assistant";

      // 2. 尝试获取当前楼层的实际数据
      // 注意：对于 Layer 0，必须精确指定 message_id，防止 latest 指向错误
      const currentVars = window.TavernHelper.getVariables({
        type: "message",
        message_id: currentId,
      });

      // 3. 核心判断逻辑
      // 检查当前楼层是否有自己的数据 (Own Data)
      const hasOwnData =
        currentVars &&
        currentVars.anima_data &&
        Object.keys(currentVars.anima_data).length > 0;

      if (hasOwnData) {
        // A. 当前楼层有数据 -> 已同步
        finalStatusObj = currentVars.anima_data;
        displaySource = `${currentId} (本层)`;

        // 【核心修复】只要有数据，绝对不显示同步按钮
        shouldShowSyncBtn = false;
      } else {
        // B. 当前楼层无数据 -> 回溯找基准 (继承)
        const base = findBaseStatus(currentId);

        // 数据显示逻辑
        if (base.id !== -1) {
          finalStatusObj = base.data;
          displaySource = `${base.id} (继承)`;
        } else {
          displaySource = "Init (无数据)";
        }

        // 按钮显示逻辑：
        // 只有当是 AI 回复，且确实没数据时，才提示同步
        // 【额外过滤】如果当前是 Layer 0 且没有配置预设，通常也不建议弹同步按钮（太干扰），除非你希望 Layer 0 也可以跑 LLM 生成状态
        // 这里我们保持原样，但你可以根据喜好决定是否加 && currentId !== 0
        const updateConfig = currentSettings.update_management || {
          panel_enabled: false,
        };

        // 2. 增加开关判断 (修改: 只有当 isAi 为真 且 开关开启时，才显示)
        if (
          isAi &&
          updateConfig.panel_enabled &&
          currentSettings.status_enabled
        ) {
          shouldShowSyncBtn = true;
        }
      }
    }

    // 4. 渲染文本框
    const yamlStr =
      Object.keys(finalStatusObj).length > 0
        ? objectToYaml(finalStatusObj)
        : "# 当前无任何历史状态\n# 请点击“同步”进行初始化...";

    $textarea.val(yamlStr);
    $("#val-status-char-count").text(yamlStr.length);
    $currentIndicator.text(currentId);
    $sourceIndicator.text(displaySource);

    // 5. 【核心修复】按钮显隐控制 (加强版)
    if ($syncBtn.length > 0) {
      if (shouldShowSyncBtn) {
        const updateConfig = currentSettings.update_management || {};
        const threshold = parseInt(updateConfig.char_threshold, 10);
        const isOverLimit =
          !isNaN(threshold) && threshold > 0 && yamlStr.length > threshold;

        if (isOverLimit) {
          // 超标：变红并加一点发光特效，修改 title 提示语
          $syncBtn.css({
            "background-color": "#ef4444",
            "border-color": "#dc2626",
            "box-shadow": "0 0 10px rgba(239, 68, 68, 0.6)",
          });
          $syncBtn.attr(
            "title",
            `字数已达 ${yamlStr.length}/${threshold}！点击同步后，建议进行状态清洗 (可拖动)`,
          );
        } else {
          // 正常：清空内联样式，恢复 style.css 中定义的默认黄色/蓝色
          $syncBtn.css({
            "background-color": "",
            "border-color": "",
            "box-shadow": "",
          });
          $syncBtn.attr("title", "检测到当前状态未同步，点击更新 (可拖动)");
        }

        // 🔥【新增】强制重置图标为“云朵”
        // 防止上次点击后留下的 fa-spinner 还在转
        if ($syncBtn.find)
          $syncBtn.find("i").attr("class", "fa-solid fa-cloud-arrow-up");

        $syncBtn
          .css("display", "flex")
          .removeClass("anima-spin-out")
          .addClass("anima-fade-in");
      } else {
        // 强制隐藏，防止 ghost state，并顺手重置颜色
        $syncBtn
          .removeClass("anima-fade-in")
          .addClass("anima-spin-out")
          .fadeOut(200);

        $syncBtn.css({
          "background-color": "",
          "border-color": "",
          "box-shadow": "",
        });
      }
    }
  } catch (e) {
    console.error("[Anima] 刷新状态面板 UI 错误:", e);
    $sourceIndicator.text("Error");
  }
}

function showYamlFixPreviewModal(originalStr, fixedStr, reason, onConfirm) {
  const title = `<span style="color: var(--anima-warning, #fbbf24);"><i class="fa-solid fa-triangle-exclamation"></i> YAML 格式修复建议</span>`;

  // 构建弹窗内容：左右分栏或上下分栏对比
  const contentHtml = `
        <div style="margin-bottom: 15px; color: #ccc;">
            检测到格式错误，Anima 已尝试自动修复 (原因: <span style="color: #4ade80;">${reason}</span>)。<br>
            请确认修复后的格式是否符合预期，确认后将直接保存。
        </div>
        
        <div style="display: flex; gap: 15px; height: 300px; margin-bottom: 15px;">
            <div style="flex: 1; display: flex; flex-direction: column;">
                <label class="anima-label-text" style="color: #f87171;"><i class="fa-solid fa-xmark"></i> 你的原始输入</label>
                <textarea class="anima-textarea" disabled style="flex: 1; resize: none; font-family: monospace; font-size: 12px; background: rgba(0,0,0,0.2); opacity: 0.7;">${escapeHtml(originalStr)}</textarea>
            </div>
            
            <div style="flex: 1; display: flex; flex-direction: column;">
                <label class="anima-label-text" style="color: #4ade80;"><i class="fa-solid fa-check"></i> 智能修复结果</label>
                <textarea id="anima-yaml-fixed-preview" class="anima-textarea" style="flex: 1; resize: none; font-family: monospace; font-size: 12px; border-color: #4ade80;">${escapeHtml(fixedStr)}</textarea>
            </div>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 10px;">
            <button id="btn-cancel-yaml-fix" class="anima-btn secondary anima-close-modal">取消并返回修改</button>
            <button id="btn-confirm-yaml-fix" class="anima-btn primary" style="background: #10b981; border-color: #059669;">
                <i class="fa-solid fa-floppy-disk"></i> 确认保存
            </button>
        </div>
    `;

  // 使用你现有的通用弹窗组件
  createCustomModal(title, contentHtml);

  // 绑定这个弹窗特有的确认事件
  $("#btn-confirm-yaml-fix")
    .off("click")
    .on("click", async () => {
      const finalYaml = $("#anima-yaml-fixed-preview").val();

      // 禁用按钮防止重复点击
      $(this)
        .prop("disabled", true)
        .html('<i class="fa-solid fa-spinner fa-spin"></i> 保存中...');

      // 执行传入的回调
      await onConfirm(finalYaml);

      // 关闭弹窗 (触发你原本 createCustomModal 里的关闭逻辑)
      $("#anima-custom-preview-modal .anima-close-modal").first().click();
    });
}

function initYamlEditor() {
  console.log("[Anima] Init YAML Editor (Real-time Variable Mode)...");

  const $textarea = $("#status-yaml-content");
  const $btnEdit = $("#anima-btn-edit-status");
  const $btnConfirm = $("#btn-confirm-status");
  const $btnCancel = $("#btn-cancel-status");
  // const $btnRefresh = $("#btn-refresh-status"); // 下面直接用选择器绑定即可

  const $viewContainer = $("#status-yaml-actions-view");
  const $editContainer = $("#status-yaml-actions-edit");

  // 1. 初始化时立即刷新一次数据
  refreshStatusPanel();
  bindYamlAutoIndent($textarea);

  $("#btn-sync-status")
    .off("click")
    .on("click", async function (e) {
      e.preventDefault();
      const $icon = $(this).find("i");

      if (!confirm("确定要请求副API重新生成当前状态吗？\n这将消耗Token。"))
        return;

      $icon.removeClass("fa-cloud-arrow-down").addClass("fa-spinner fa-spin");

      try {
        // 🟢 改动：接收返回值 (true/false)
        const success = await triggerManualSync();

        refreshStatusPanel(); // 无论成功失败，都刷新一下面板(可能想看旧状态)

        // 🟢 改动：只有成功了才弹“完成”
        if (success) {
          toastr.success("状态同步完成");
        }
        // 如果失败(false)，底层 triggerStatusUpdate 已经弹了红窗，这里就不用说话了
      } catch (err) {
        toastr.error("同步失败: " + err.message);
      } finally {
        $icon.removeClass("fa-spinner fa-spin").addClass("fa-cloud-arrow-down");
      }
    });

  // 2. 绑定刷新按钮
  // ⚠️ 注意：这里改用了 function(e)，不要用箭头函数，否则 $(this) 会失效
  $("#btn-refresh-status")
    .off("click")
    .on("click", function (e) {
      e.preventDefault();
      const $icon = $(this).find("i");
      $icon.addClass("fa-spin");

      // 执行刷新逻辑 (始终执行)
      refreshStatusPanel();

      setTimeout(() => {
        $icon.removeClass("fa-spin");

        // === 🔥 核心修改开始 ===
        // 判断是否为用户真实操作
        // e.originalEvent 在脚本 .trigger() 时通常为 undefined
        // e.isTrigger 在 jQuery 触发时为 true
        const isScriptTriggered = !e.originalEvent || e.isTrigger;

        // 只有当不是脚本触发 (即用户亲手点的) 时，才弹窗
        if (!isScriptTriggered) {
          if (window.toastr) window.toastr.success("状态已刷新");
        }
        // === 🔥 核心修改结束 ===
      }, 300);
    });

  // 3. 绑定“编辑”按钮
  $btnEdit.off("click").on("click", (e) => {
    e.preventDefault();
    let currentContent = $textarea.val();

    // 如果是默认提示文本，清空以便输入
    if (currentContent.startsWith("# 当前最新楼层")) {
      currentContent = "";
      $textarea.val("");
    }

    $textarea.data("original", currentContent); // 缓存原始值
    $viewContainer.hide();
    $editContainer.css("display", "flex");
    $textarea.prop("disabled", false).focus().addClass("anima-input-active");
  });

  // 4. 绑定“取消”按钮
  $btnCancel.off("click").on("click", (e) => {
    e.preventDefault();
    // 恢复原始值
    $textarea.val($textarea.data("original"));
    exitEditMode();
  });

  // 5. 绑定“确认”按钮 (核心保存逻辑)
  $btnConfirm.off("click").on("click", async (e) => {
    e.preventDefault();
    const yamlStr = $textarea.val();

    try {
      // 1. 尝试正常解析
      const statusObj = yamlToObject(yamlStr);
      if (!statusObj) throw new Error("YAML 格式无效或为空");

      // 解析成功，走正常的保存逻辑...
      await saveRealtimeStatusVariables({ anima_data: statusObj });
      if (window.toastr) window.toastr.success("变量已更新");
      exitEditMode();
      setTimeout(() => refreshStatusPanel(), 500);
    } catch (err) {
      // 1. 正常解析失败，尝试智能修复 (只处理 Tab 和 JSON)
      console.warn("[Anima] YAML 解析失败，尝试智能修复...", err);
      const fixResult = smartFixYaml(yamlStr);

      if (fixResult.success) {
        // 2. 修复成功，调用预览弹窗让用户确认
        showYamlFixPreviewModal(
          yamlStr,
          fixResult.fixedStr,
          fixResult.reason,
          // 传入回调：如果用户点击确认，执行真正的保存
          async (confirmedYaml) => {
            const finalObj = yamlToObject(confirmedYaml);
            await saveRealtimeStatusVariables({ anima_data: finalObj });
            $textarea.val(confirmedYaml); // 更新面板内容
            if (window.toastr) window.toastr.success("已应用修复并保存");
            exitEditMode();
            setTimeout(() => refreshStatusPanel(), 500);
          },
        );
        return; // 修复成功并进入弹窗流程后，直接 return，不走下面的报错
      }

      // 3. 修复失败，精准提取错误信息并拦截
      let errorMsg = "YAML 格式错误。";

      // js-yaml 的标准错误通常包含 mark 对象
      if (err.mark && err.mark.line !== undefined) {
        const lineNum = err.mark.line + 1; // mark.line 是索引，转为人类可读行号
        const reason = err.reason || "语法错误";

        const lines = yamlStr.split("\n");
        const errorIdx = err.mark.line;

        // 辅助函数：只提取冒号前面的 Key 名称
        const extractKey = (lineText) => {
          if (!lineText) return "";
          // 匹配开头可能的空格或列表符，截取到第一个冒号之前
          const match = lineText.match(/^[\s-]*([^:]+):/);
          // 如果没匹配到冒号，就截取前 10 个字符作为兜底
          return match
            ? match[1].trim()
            : lineText.trim().substring(0, 10) + "...";
        };

        const currentKey = extractKey(lines[errorIdx]);
        const prevKey = errorIdx > 0 ? extractKey(lines[errorIdx - 1]) : "";

        // 拼装极其清爽的提示
        const contextDisplay = prevKey
          ? `【 ${prevKey} 】或【 ${currentKey} 】`
          : `【 ${currentKey} 】`;

        errorMsg = `YAML 第 ${lineNum} 行出错。请检查 ${contextDisplay} 附近的空格或缩进！`;
      } else {
        // 备用兜底：尝试从 message 字符串中正则提取行号
        const lineMatch =
          err.message.match(/at line (\d+)/i) ||
          err.message.match(/line: (\d+)/i);
        if (lineMatch) {
          errorMsg = `YAML 第 ${lineMatch[1]} 行格式错误，请检查缩进或冒号后是否缺少空格。`;
        } else {
          errorMsg = `YAML 格式错误: ${err.message}`;
        }
      }

      // 4. 拦截并提示，保持在编辑状态，让用户自己动手改
      if (window.toastr) {
        window.toastr.error(errorMsg, "保存失败", { timeOut: 7000 });
      }
    }
  });

  // 辅助函数：退出编辑模式 UI 状态
  function exitEditMode() {
    $editContainer.hide();
    $viewContainer.css("display", "flex");
    $textarea.prop("disabled", true);
    $textarea.removeClass("anima-input-active");
  }
}

/**
 * 为文本框绑定 YAML 自动缩进功能
 * @param {jQuery} $textarea - 需要绑定的 textarea 元素
 */
function bindYamlAutoIndent($textarea) {
  // 防止重复绑定
  $textarea.off("keydown.yamlIndent").on("keydown.yamlIndent", function (e) {
    // 监听回车键 (Enter)
    if (e.key === "Enter") {
      e.preventDefault(); // 阻止原生的换行行为

      const el = this;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const val = el.value;

      // 1. 往前寻找当前行的开头位置
      const lineStart = val.lastIndexOf("\n", start - 1) + 1;

      // 2. 截取当前行的文本（光标之前的部分）
      const currentLine = val.substring(lineStart, start);

      // 3. 使用正则匹配当前行开头的空白字符（空格）
      const match = currentLine.match(/^[\s]+/);
      let indentSpaces = match ? match[0] : "";

      // 4. 【进阶智能】如果当前行以冒号结尾，下一行理应再多缩进 2 个空格
      if (currentLine.trim().endsWith(":")) {
        indentSpaces += "  ";
      }

      // 5. 拼装要插入的内容：换行符 + 算好的空格
      const textToInsert = "\n" + indentSpaces;

      // 6. 重新拼接文本框的值
      el.value = val.substring(0, start) + textToInsert + val.substring(end);

      // 7. 将光标移动到新插入的空格之后
      el.selectionStart = el.selectionEnd = start + textToInsert.length;
    }

    // 顺手处理一下 Tab 键：将其转化为 2 个空格，彻底防止非法字符
    if (e.key === "Tab") {
      e.preventDefault();
      const el = this;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const val = el.value;

      el.value = val.substring(0, start) + "  " + val.substring(end);
      el.selectionStart = el.selectionEnd = start + 2;
    }
  });
}
// ==========================================
// 逻辑模块 2: 提示词列表渲染
// ==========================================
function renderStatusList() {
  const listEl = $("#anima_status_prompt_list");
  listEl.empty();
  if (!currentSettings.prompt_rules) currentSettings.prompt_rules = [];

  currentSettings.prompt_rules.forEach((msg, idx) => {
    let $item = null;

    // --- 新增：角色卡信息 & 用户信息 ---
    if (msg.type === "char_info" || msg.type === "user_info") {
      const isChar = msg.type === "char_info";
      const title = isChar ? "👾 角色卡信息" : "👑 用户设定";
      const colorClass = isChar ? "color:#a855f7" : "color:#ec4899";
      const borderColor = isChar ? "#a855f7" : "#ec4899";
      const bgColor = isChar
        ? "rgba(168, 85, 247, 0.1)"
        : "rgba(236, 72, 153, 0.1)";

      $item = $(`
          <div class="anima-regex-item anima-special-item" data-idx="${idx}" data-type="${msg.type}" 
               style="border-color: ${borderColor}; height: 44px; display: flex; align-items: center; padding: 0 10px; box-sizing: border-box; background: ${bgColor};">
              <div style="display: flex; align-items: center; gap:10px; width: 100%; height: 100%;">
                  <i class="fa-solid fa-bars anima-drag-handle" title="拖动排序" style="cursor:grab; margin: 0; display:flex; align-items:center;"></i>
                  <span style="font-weight:bold; font-size:13px; ${colorClass}; display:flex; align-items:center; gap:5px; line-height: 1;">${title}</span>
                  
                  <div style="margin-left:auto; display:flex; align-items:center; height: 100%;">
                      <label class="anima-switch" title="启用/关闭" style="margin: 0; display: flex; align-items: center;">
                          <input type="checkbox" class="special-toggle" ${msg.enabled !== false ? "checked" : ""}>
                          <span class="slider round"></span>
                      </label>
                  </div>
              </div>
          </div>
      `);

      // 绑定开关事件，并即时保存
      $item.find(".special-toggle").on("change", function () {
        currentSettings.prompt_rules[idx].enabled = $(this).prop("checked");
        saveStatusSettings(currentSettings);
      });
    } else if (msg.content === "{{status}}") {
      $item = $(`
                <div class="anima-regex-item anima-special-item" data-idx="${idx}" data-type="status_placeholder" 
                     style="border-color: var(--anima-primary); height: 44px; display: flex; align-items: center; padding: 0 10px; box-sizing: border-box;">
                    <div style="display: flex; align-items: center; gap:10px; width: 100%; height: 100%;">
                        <i class="fa-solid fa-bars anima-drag-handle" title="拖动排序" style="cursor:grab; margin: 0; display:flex; align-items:center;"></i>
                        <span style="font-weight:bold; font-size:13px; color:var(--anima-primary); display:flex; align-items:center; gap:5px; line-height: 1;">
                            <i class="fa-solid fa-heart-pulse"></i> 实时状态插入位
                        </span>
                    </div>
                </div>
            `);
    } else if (msg.content === "{{chat_context}}") {
      // 【核心修改】去掉了 btn-delete，样式调整为常驻风格
      $item = $(`
                <div class="anima-regex-item anima-special-item" data-idx="${idx}" data-type="chat_context_placeholder" 
                     style="border-color: #3b82f6; height: 44px; display: flex; align-items: center; padding: 0 10px; box-sizing: border-box; background: rgba(59, 130, 246, 0.1);">
                    <div style="display: flex; align-items: center; gap:10px; width: 100%; height: 100%;">
                        <i class="fa-solid fa-bars anima-drag-handle" title="拖动排序" style="cursor:grab; margin: 0; display:flex; align-items:center;"></i>
                        <span style="font-weight:bold; font-size:13px; color:#60a5fa; display:flex; align-items:center; gap:5px; line-height: 1;">
                            <i class="fa-solid fa-comments"></i> 增量剧情插入位
                        </span>
                        
                        <div style="margin-left:auto; opacity: 0.5;">
                             <i class="fa-solid fa-lock" title="固定条目" style="color:#60a5fa;"></i>
                        </div>
                    </div>
                </div>
            `);

      // 绑定删除按钮 (允许用户删除这个占位符，如果想恢复可以通过“添加条目”加回来)
      $item.find(".btn-delete").on("click", () => {
        if (confirm("移除增量剧情占位符？(移除后将默认追加在最后)")) {
          currentSettings.prompt_rules.splice(idx, 1);
          renderStatusList();
        }
      });
    } else {
      const currentTitle = msg.title || "";
      const displayTitleHtml = currentTitle
        ? escapeHtml(currentTitle)
        : '<span style="color:#666;">(新规则)</span>';
      const displayRole = (msg.role || "SYSTEM").toUpperCase();

      $item = $(`
                <div class="anima-regex-item" data-idx="${idx}" data-type="normal">
                    <div class="view-mode" style="display:flex; align-items:center; gap:8px; width:100%; margin-bottom: 6px; height: 32px;">
                        <i class="fa-solid fa-bars anima-drag-handle" style="cursor:grab; color:#888;"></i>
                        <span class="anima-tag secondary" style="font-family:monospace; font-size:12px; height:24px; line-height:24px; padding:0 8px;">${displayRole}</span>
                        <span class="view-title-text" style="font-weight:bold; color:#ddd; flex:1; cursor:text; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${displayTitleHtml}</span>
                        <div class="btn-group" style="display:flex; gap:5px;">
                            <button class="anima-btn secondary small btn-edit" style="width:28px; height:28px; padding:0; display:flex; align-items:center; justify-content:center;"><i class="fa-solid fa-pen" style="font-size:12px;"></i></button>
                            <button class="anima-btn danger small btn-delete" style="width:28px; height:28px; padding:0; display:flex; align-items:center; justify-content:center;"><i class="fa-solid fa-trash" style="font-size:12px;"></i></button>
                        </div>
                    </div>
                    <div class="edit-mode" style="display:none; align-items:center; gap:8px; width:100%; margin-bottom: 6px; height: 32px;">
                        <select class="anima-select role-select" style="width:120px; height:30px; flex-shrink: 0; padding: 0 5px;">
                            <option value="system">System</option>
                            <option value="user">User</option>
                            <option value="assistant">Assistant</option>
                        </select>
                        <input type="text" class="anima-input title-input" value="${escapeHtml(currentTitle)}" 
                               placeholder="输入条目标题..."
                               style="flex:1; height:30px; margin:0; min-width: 0;">
                        
                        <button class="anima-btn primary small btn-confirm" style="width:30px; height:30px; padding:0; flex-shrink: 0;"><i class="fa-solid fa-check"></i></button>
                        <button class="anima-btn danger small btn-cancel" style="width:30px; height:30px; padding:0; flex-shrink: 0;"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <textarea class="anima-textarea content-input" rows="2" disabled style="opacity:1; cursor:default; width:100%; box-sizing:border-box;">${escapeHtml(msg.content)}</textarea>
                </div>
            `);

      const $view = $item.find(".view-mode");
      const $edit = $item.find(".edit-mode");
      const $text = $item.find(".content-input");
      const $role = $item.find(".role-select");

      $role.val(msg.role || "system");

      $item.find(".btn-edit, .view-title-text").on("click", () => {
        $view.hide();
        $edit.css("display", "flex");
        $text
          .prop("disabled", false)
          .focus()
          .css("border-color", "var(--anima-primary)");
      });
      $item.find(".btn-cancel").on("click", renderStatusList);
      $item.find(".btn-confirm").on("click", () => {
        msg.role = $role.val();
        msg.title = $item.find(".title-input").val();
        msg.content = $text.val();
        renderStatusList();
      });
      $item.find(".btn-delete").on("click", () => {
        if (confirm("Del?")) {
          currentSettings.prompt_rules.splice(idx, 1);
          saveStatusSettings(currentSettings);
          renderStatusList();
        }
      });
    }
    if ($item) listEl.append($item);
  });

  listEl.sortable({
    handle: ".anima-drag-handle",
    placeholder: "ui-state-highlight",
    stop: function () {
      setTimeout(() => {
        const newRules = [];
        listEl.children().each(function () {
          const oldIdx = $(this).data("idx");
          if (currentSettings.prompt_rules[oldIdx])
            newRules.push(currentSettings.prompt_rules[oldIdx]);
        });
        currentSettings.prompt_rules = newRules;
        saveStatusSettings(currentSettings);
        renderStatusList();
      }, 0);
    },
  });
}

// ==========================================
// 逻辑模块 4: 美化模块 (预览逻辑修复)
// ==========================================
function initBeautifyModule() {
  const $toggle = $("#toggle_beautify_enabled");
  const $editorArea = $("#beautify-editor-area");
  const $btnEdit = $("#btn-beautify-edit");
  const $btnPreview = $("#btn-beautify-preview");
  const $btnConfirm = $("#btn-beautify-confirm");
  const $btnCancel = $("#btn-beautify-cancel");
  const $viewGroup = $("#beautify-actions-view");
  const $editGroup = $("#beautify-actions-edit");
  const $textarea = $("#beautify-template-input");
  const $previewBox = $("#beautify-preview-container");
  let tempContent = "";

  // 预览状态 Flag
  let isPreviewMode = false;

  $toggle.on("change", function () {
    const enabled = $(this).prop("checked");
    if (enabled) $editorArea.slideDown(200);
    else $editorArea.slideUp(200);
    if (!currentSettings.beautify_settings)
      currentSettings.beautify_settings = {};
    currentSettings.beautify_settings.enabled = enabled;
    saveStatusSettings(currentSettings);
  });

  $("#btn-save-beautify-card").on("click", async () => {
    const template = $textarea.val();

    // 1. 保存到角色卡 (保持你原来的逻辑)
    const success = await saveSettingsToCharacterCard(
      "anima_beautify_template",
      {
        template: template,
      },
    );

    if (success) {
      // 2. 【新增】强制刷新当前聊天
      // 这会销毁当前聊天界面并重建，从而触发 initStatusMacro 重新运行，
      // 此时它会调用新修改的 getStatusSettings()，读到角色卡里的新模板。
      const context = SillyTavern.getContext();
      if (context.reloadCurrentChat) {
        await context.reloadCurrentChat();
      } else {
        // 备用刷新方案 (旧版本兼容)
        location.reload();
      }
    }
  });

  // 1. 导出 (Export)
  $("#btn-export-beautify").on("click", (e) => {
    e.preventDefault();
    try {
      // 获取当前内容：如果在编辑模式，取输入框的值；如果在查看模式，取 Settings 或 输入框的值
      // 为了所见即所得，直接取 input 的值（它在 view 模式下也是有值的，只是 disabled）
      const currentTemplate = $textarea.val();

      const exportData = {
        template: currentTemplate,
      };

      const dataStr = JSON.stringify(exportData, null, 2);
      const blob = new Blob([dataStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      // 时间戳文件名
      const timestamp = new Date()
        .toISOString()
        .replace(/[-:.]/g, "")
        .slice(0, 14);
      a.download = `anima_beautify_template_${timestamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (window.toastr) toastr.success("美化模板导出成功");
    } catch (err) {
      console.error(err);
      if (window.toastr) toastr.error("导出失败: " + err.message);
    }
  });

  // 2. 导入 (Import) - 触发
  $("#btn-import-beautify").on("click", (e) => {
    e.preventDefault();
    $("#beautify_import_file").click();
  });

  // ===========================
  // 3. 导入逻辑 (Import) - 修复版
  // ===========================
  $("#beautify_import_file")
    .off("change")
    .on("change", function (e) {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();

      reader.onload = (ev) => {
        try {
          const json = JSON.parse(ev.target.result);

          // 格式校验
          if (!json || typeof json.template !== "string") {
            throw new Error("文件格式错误：未找到 template 字段");
          }

          if (confirm("确定要导入该模板吗？这将覆盖当前编辑框中的内容。")) {
            // 🔥 1. 自动格式化代码 (Auto Wrap / Beautify)
            let newTemplate = json.template;
            try {
              // 尝试格式化，如果失败则保留原样
              newTemplate = simpleFormatHTML(newTemplate);
            } catch (fmtErr) {
              console.warn("Auto-format failed, using raw string:", fmtErr);
            }

            // 🔥 2. 强制重新获取 DOM 元素并赋值 (解决 UI 不显示的问题)
            const $targetBox = $("#beautify-template-input");
            $targetBox.val(newTemplate);

            // 🔥 3. 更新内存中的缓存 (防止点“取消”后回滚到旧版)
            // 这一步非常重要，它让“导入”操作等同于一次“已确认的编辑”
            tempContent = newTemplate;

            // 4. 更新全局设置内存
            if (!currentSettings.beautify_settings)
              currentSettings.beautify_settings = {};
            currentSettings.beautify_settings.template = newTemplate;

            // 5. 触发保存 (Debounced)
            saveStatusSettings(currentSettings);

            // 6. 刷新预览
            if (isPreviewMode) {
              togglePreview(false);
              setTimeout(() => togglePreview(true), 50);
            }

            if (window.toastr) toastr.success("模板导入成功 (已自动格式化)");
          }
        } catch (err) {
          console.error(err);
          if (window.toastr) toastr.error("导入失败: " + err.message);
        }

        // 清空 input 允许重复导入同一个文件
        $(this).val("");
      };

      reader.readAsText(file);
    });

  $btnEdit.on("click", function () {
    // 如果正在预览，先关闭预览
    if (isPreviewMode) togglePreview(false);

    tempContent = $textarea.val();
    $previewBox.hide();
    $textarea
      .show()
      .prop("disabled", false)
      .focus()
      .css("border-color", "var(--anima-primary)");
    $viewGroup.hide();
    $editGroup.css("display", "flex");
  });

  $btnConfirm.on("click", function () {
    if (!currentSettings.beautify_settings)
      currentSettings.beautify_settings = {};
    currentSettings.beautify_settings.template = $textarea.val();
    exitBeautifyEdit();
    toastr.success("美化模板已暂存");
  });

  $btnCancel.on("click", function () {
    $textarea.val(tempContent);
    exitBeautifyEdit();
  });

  function exitBeautifyEdit() {
    $textarea.prop("disabled", true).css("border-color", "");
    $editGroup.hide();
    $viewGroup.css("display", "flex");
  }

  // 预览切换逻辑
  function togglePreview(show) {
    isPreviewMode = show;

    if (show) {
      let rawHtml = $textarea.val();

      // ============================================================
      // 0. 准备数据上下文 (保持你之前的智能回溯逻辑)
      // ============================================================
      let renderContext = {};
      try {
        const context = SillyTavern.getContext();
        const chat = context.chat || [];

        if (chat.length > 0) {
          // 1. 锁定当前对话的末尾楼层
          const lastMsg = chat[chat.length - 1];
          const lastId = lastMsg.message_id;

          // 2. 调用 status_logic.js 里的回溯函数
          const base = findBaseStatus(lastId);

          // 3. 获取找到的数据
          if (base && base.data) {
            // 🔴 删除旧代码: renderContext = base.data;

            // 🟢 新增代码: 使用 createRenderContext 注入 _user / _char
            renderContext = createRenderContext(base.data);
          }
          console.log("[Anima Preview] Loaded state from floor:", base.id);
        } else {
          // 🟢 即使没聊天记录，也要初始化一个空壳，防止 {{_user}} 报错
          renderContext = createRenderContext({});
        }
      } catch (e) {
        console.error("[Anima Preview] Failed to load history state:", e);
        // 出错兜底
        renderContext = createRenderContext({});
      }

      // ============================================================
      // 1. 流水线第一步: 循环展开 (Loops)
      // ============================================================
      let step1_Looped = renderAnimaTemplate(rawHtml, renderContext);

      // ============================================================
      // 2. 流水线第二步: 特殊处理 {{status}}
      // (必须在 processMacros 之前，防止它被误转为 API 格式)
      // ============================================================
      let step2_Status = step1_Looped.replace(/\{\{status\}\}/g, () => {
        return Object.keys(renderContext).length > 0
          ? objectToYaml(renderContext)
          : "Status: Normal";
      });

      // ============================================================
      // 3. 流水线第三步: ST 原生宏处理 (Global Macros)
      // (这里处理 {{user}}, {{char}} 等)
      // ============================================================
      let step3_Macros = processMacros(step2_Status);

      // ============================================================
      // 4. 流水线第四步: 本地变量与 Key 处理 (Local Vars)
      // (处理剩下的 {{HP}}, {{key::...}} 等)
      // ============================================================
      let renderedHtml = step3_Macros.replace(
        /{{\s*([^\s}]+)\s*}}/g,
        (match, path) => {
          // A. 处理 key:: 前缀
          if (path.startsWith("key::")) {
            const targetPath = path.replace("key::", "").trim();
            let val = undefined;
            if (window["_"] && window["_"].get)
              val = window["_"].get(renderContext, targetPath);
            else
              val = targetPath
                .split(".")
                .reduce((o, k) => (o || {})[k], renderContext);

            // 如果是对象，返回键名列表
            if (val && typeof val === "object" && !Array.isArray(val))
              return Object.keys(val).join(", ");

            // 如果是值，返回路径最后一段
            const segments = targetPath.split(".");
            return segments[segments.length - 1];
          }

          // B. 处理常规本地变量
          let val = window["_"].get(renderContext, path);

          // C. 默认值与显示
          if (val === undefined || val === null) return "(变量值)";
          if (typeof val === "object") return JSON.stringify(val);
          return String(val);
        },
      );

      // ============================================================
      // 5. 压缩与渲染 (Minification & Render)
      // ============================================================
      renderedHtml = renderedHtml
        .replace(/[\r\n]+/g, "")
        .replace(/>\s+</g, "><")
        .replace(/[\t ]+</g, "<")
        .replace(/>[\t ]+/g, ">");

      $textarea.hide();
      $previewBox
        .html(
          `<div style="font-family: inherit; line-height: 1.5;">${renderedHtml}</div>`,
        )
        .fadeIn(200);

      $btnPreview.removeClass("primary").addClass("success");
      $btnPreview.html('<i class="fa-solid fa-eye-slash"></i> 退出');
    } else {
      // ... (退出预览逻辑保持不变)
      $previewBox.hide();
      $textarea.fadeIn(200);
      $btnPreview.removeClass("success").addClass("primary");
      $btnPreview.html('<i class="fa-solid fa-eye"></i> 预览');
    }
  }

  $btnPreview.on("click", function () {
    togglePreview(!isPreviewMode);
  });
}

// ==========================================
// 逻辑模块 5: 注入模块逻辑
// ==========================================
function initInjectionModule() {
  const $textarea = $("#inject-template-input");
  const $btnEdit = $("#btn-inject-edit");

  // 修改 1：绑定新的 ID
  const $btnConfirm = $("#btn-inject-confirm");

  const $btnCancel = $("#btn-inject-cancel");
  const $viewGroup = $("#inject-actions-view");
  const $editGroup = $("#inject-actions-edit");

  let originalContent = "";

  $btnEdit.on("click", () => {
    originalContent = $textarea.val();
    $viewGroup.hide();
    $editGroup.css("display", "flex");
    $textarea.prop("disabled", false).focus().addClass("anima-input-active");
  });

  $btnCancel.on("click", () => {
    $textarea.val(originalContent);
    exitEdit();
  });

  // 修改 2：重写确认按钮逻辑
  $btnConfirm.on("click", () => {
    // 1. 更新内存中的配置
    if (!currentSettings.injection_settings)
      currentSettings.injection_settings = {};

    currentSettings.injection_settings.template = $textarea.val();

    // 2. 提示暂存成功
    toastr.success("注入内容已暂存 (请记得点击底部按钮保存到角色卡)");

    // 3. 退出编辑模式
    exitEdit();
  });

  function exitEdit() {
    $editGroup.hide();
    $viewGroup.css("display", "flex");
    $textarea.prop("disabled", true).removeClass("anima-input-active");
  }
  $("#btn-inject-save-card").on("click", async () => {
    // 1. 从 UI 获取数据
    const injectionData = {
      position: $("#inject-position").val(),
      role: $("#inject-role").val(),
      depth: Number($("#inject-depth").val()),
      order: Number($("#inject-order").val()),
      template: $("#inject-template-input").val(),
    };

    // 2. 更新当前的设置对象 (currentSettings)
    if (!currentSettings.injection_settings) {
      currentSettings.injection_settings = {};
    }
    Object.assign(currentSettings.injection_settings, injectionData);

    // 3. ✅【关键调用】保存到全局 settings.json
    // 不要调用 saveSettingsToCharacterCard
    saveStatusSettings(currentSettings);

    // 4. 应用到世界书 (传入最新配置以立即生效)
    try {
      await syncStatusToWorldBook(currentSettings);
      toastr.success("注入配置已保存 (全局 settings.json) 并应用");
    } catch (e) {
      console.error(e);
      toastr.error("应用到世界书失败");
    }
  });
}

function initZodModule() {
  // 1. 确保配置对象结构完整
  if (!currentSettings.zod_settings) {
    currentSettings.zod_settings = {
      mode: "ui",
      rules: [],
      script_content: "",
    };
  }
  const settings = currentSettings.zod_settings;
  const $container = $("#zod-rules-list");

  // ===========================
  // 模式切换逻辑
  // ===========================
  $("#zod-mode-select").on("change", function () {
    const mode = $(this).val();
    settings.mode = mode;

    if (mode === "ui") {
      $("#zod-ui-container").slideDown(200);
      $("#zod-script-container").slideUp(200);
      renderRules(); // 切换回 UI 模式时重新渲染
    } else {
      $("#zod-ui-container").slideUp(200);
      $("#zod-script-container").slideDown(200);
    }
    // 内存保存 (暂存)
    saveStatusSettings(currentSettings);
  });

  // 1. 导出 (Export)
  $("#btn-export-zod").on("click", (e) => {
    e.preventDefault();
    try {
      // 构造导出的数据结构
      // 我们直接导出整个 zod_settings 对象，这样包含了模式、UI规则和脚本内容
      const exportData = {
        mode: settings.mode,
        rules: settings.rules || [],
        script_content: settings.script_content || "",
      };

      // 为了确保数据最新，如果是 script 模式且处于编辑状态，尝试获取输入框的值
      if (
        settings.mode === "script" &&
        !$("#zod-script-input").prop("disabled")
      ) {
        exportData.script_content = $("#zod-script-input").val();
      }

      const dataStr = JSON.stringify(exportData, null, 2); // 美化格式
      const blob = new Blob([dataStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      // 生成带时间戳的文件名
      const timestamp = new Date()
        .toISOString()
        .replace(/[-:.]/g, "")
        .slice(0, 14);
      a.download = `anima_zod_config_${timestamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (window.toastr) toastr.success("Zod 配置导出成功");
    } catch (err) {
      console.error(err);
      if (window.toastr) toastr.error("导出失败: " + err.message);
    }
  });

  // 2. 导入 (Import) - 触发文件选择
  $("#btn-import-zod").on("click", (e) => {
    e.preventDefault();
    $("#zod_import_file").click(); // 触发隐藏的 input
  });

  // 3. 导入 - 处理文件读取
  $("#zod_import_file").on("change", function (e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const json = JSON.parse(ev.target.result);

        // 简单的格式校验
        if (typeof json !== "object" || json === null) {
          throw new Error("文件格式错误：必须是 JSON 对象");
        }

        if (confirm("确定要导入该配置吗？这将覆盖当前的 Zod 设置。")) {
          // A. 更新内存数据
          // 兼容性处理：如果导入的是旧格式（只有 rules 数组），默认切到 UI 模式
          if (Array.isArray(json)) {
            settings.mode = "ui";
            settings.rules = json;
          } else {
            // 标准格式
            settings.mode = json.mode || "ui"; // 默认 ui
            settings.rules = Array.isArray(json.rules) ? json.rules : [];
            settings.script_content = json.script_content || "";
          }

          // B. 保存到全局设置
          saveStatusSettings(currentSettings);

          // C. 【关键】自动切换 UI 状态
          // 更新下拉框的值
          const $select = $("#zod-mode-select");
          $select.val(settings.mode);

          // 触发 change 事件，让 initZodModule 里的逻辑自动切换显示容器 (ui/script)
          $select.trigger("change");

          // 如果是 UI 模式，还需要强制重绘列表 (因为 trigger change 只是切换容器显隐，没重绘列表)
          if (settings.mode === "ui") {
            renderRules();
          } else {
            // 如果是脚本模式，更新文本框内容
            $("#zod-script-input").val(settings.script_content);
          }

          if (window.toastr)
            toastr.success(
              `配置已导入，自动切换至: ${settings.mode === "ui" ? "可视化模式" : "脚本模式"}`,
            );
        }
      } catch (err) {
        console.error(err);
        if (window.toastr) toastr.error("导入失败: " + err.message);
      }
      // 清空 value 允许重复导入
      $(this).val("");
    };
    reader.readAsText(file);
  });

  // ===========================
  // UI 模式逻辑 (CSS修复版)
  // ===========================

  function renderRules() {
    $container.empty();
    if (!settings.rules || settings.rules.length === 0) {
      $container.html(
        '<div style="text-align:center; color:#666; font-size:12px; padding:10px;">暂无规则，请点击下方按钮添加</div>',
      );
      return;
    }

    settings.rules.forEach((rule, idx) => {
      // 1. 定义通用样式 (关键修复)
      // height: 34px (稍微增高)
      // padding: 0 5px (清除ST默认的大padding)
      // line-height: normal (防止文字偏移)
      // font-size: 13px (防止字体过大)
      const inputStyle =
        "margin: 0; height: 34px; padding: 0 8px; line-height: normal; box-sizing: border-box; vertical-align: middle; font-size: 13px;";
      const labelStyle =
        "font-size: 12px; color: #aaa; white-space: nowrap; margin: 0 4px;";

      // 2. 根据类型生成第二行的具体配置 HTML
      let constraintInputs = "";

      if (rule.type === "number") {
        constraintInputs = `
                    <div class="anima-flex-row" style="align-items: center; width: 100%; gap: 5px;">
                        <div style="flex: 1; display: flex; align-items: center;">
                            <span style="${labelStyle} margin-left: 0;">Min</span>
                            <input type="number" class="anima-input rule-min" placeholder="-∞" value="${rule.min ?? ""}" title="最小值" style="${inputStyle} width: 100%;">
                        </div>
                        
                        <span style="${labelStyle}">~</span>
                        
                        <div style="flex: 1; display: flex; align-items: center;">
                            <span style="${labelStyle}">Max</span>
                            <input type="number" class="anima-input rule-max" placeholder="+∞" value="${rule.max ?? ""}" title="最大值" style="${inputStyle} width: 100%;">
                        </div>

                        <div style="flex: 1; display: flex; align-items: center; margin-left: 5px;">
                            <span style="${labelStyle}">幅度±</span>
                            <input type="number" class="anima-input rule-delta" placeholder="No Limit" value="${rule.delta ?? ""}" title="单次变化最大幅度" style="${inputStyle} width: 100%;">
                        </div>
                    </div>
                `;
      } else if (rule.type === "string") {
        constraintInputs = `
                    <div class="anima-flex-row" style="align-items: center; gap: 5px; width: 100%;">
                        <span style="${labelStyle}">枚举值:</span>
                        <input type="text" class="anima-input rule-enum" placeholder="例如: A, B, C (留空不限)" value="${escapeHtml(rule.enum || "")}" title="允许的文本值，用逗号分隔" style="${inputStyle} flex:1;">
                    </div>
                `;
      } else if (rule.type === "boolean") {
        constraintInputs = `<div style="padding: 5px 0;"><span style="color:#888; font-size:12px; font-style: italic;">(布尔值: 仅校验 true/false，无额外参数)</span></div>`;
      }

      // 3. 构建整体卡片结构
      const $item = $(`
                <div class="zod-rule-item" style="
                    padding: 8px 10px; 
                    background: rgba(0,0,0,0.2); 
                    border: 1px solid var(--anima-border); 
                    border-radius: 4px; 
                    display: flex; 
                    flex-direction: column; 
                    gap: 8px;
                ">
                    <div style="display: flex; align-items: center; gap: 8px; width: 100%;">
                        
                        <div style="width: 45%; display: flex; flex-direction: column;">
                            <input type="text" class="anima-input rule-path" placeholder="变量路径" 
                                value="${escapeHtml(rule.path)}" 
                                style="${inputStyle} width: 100%; font-family: monospace; font-weight: bold;">
                        </div>
                        
                        <div style="flex: 1; display: flex; flex-direction: column;">
                            <select class="anima-select rule-type" style="${inputStyle} width: 100%; cursor: pointer;">
                                <option value="number" ${rule.type === "number" ? "selected" : ""}>Number (数值)</option>
                                <option value="string" ${rule.type === "string" ? "selected" : ""}>String (文本)</option>
                                <option value="boolean" ${rule.type === "boolean" ? "selected" : ""}>Boolean (布尔)</option>
                            </select>
                        </div>

                        <button class="anima-btn danger small btn-del-rule" title="删除此规则" 
                            style="margin: 0; width: 34px; height: 34px; padding: 0; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>

                    <div class="rule-settings-row" style="width: 100%;">
                        ${constraintInputs}
                    </div>
                </div>
            `);

      // 4. 绑定事件逻辑 (保持不变)
      $item.find("input, select").on("change input", function () {
        rule.path = $item.find(".rule-path").val();

        // 类型切换处理
        const newType = $item.find(".rule-type").val();
        if (newType !== rule.type) {
          rule.type = newType;
          // 清理旧属性
          delete rule.min;
          delete rule.max;
          delete rule.enum;
          delete rule.delta;
          renderRules(); // 重绘
          return;
        }

        // 数值处理
        if (rule.type === "number") {
          const min = $item.find(".rule-min").val();
          const max = $item.find(".rule-max").val();
          const delta = $item.find(".rule-delta").val();

          rule.min = min !== "" ? Number(min) : undefined;
          rule.max = max !== "" ? Number(max) : undefined;
          rule.delta = delta !== "" ? Number(delta) : undefined;
        }
        // 字符串处理
        else if (rule.type === "string") {
          rule.enum = $item.find(".rule-enum").val();
        }
      });

      // 删除事件
      $item.find(".btn-del-rule").on("click", () => {
        settings.rules.splice(idx, 1);
        saveStatusSettings(currentSettings);
        renderRules();
      });

      $container.append($item);
    });
  }

  // 添加按钮
  $("#btn-add-zod-rule").on("click", () => {
    settings.rules.push({
      path: "",
      type: "number",
    });
    renderRules();
  });

  // 初始渲染
  if (settings.mode === "ui") renderRules();

  // ===========================
  // 脚本模式逻辑
  // ===========================
  const $scriptInput = $("#zod-script-input");
  const $btnEdit = $("#btn-zod-script-edit");
  const $btnConfirm = $("#btn-zod-script-confirm");
  const $btnCancel = $("#btn-zod-script-cancel");
  const $viewGroup = $("#zod-script-actions-view");
  const $editGroup = $("#zod-script-actions-edit");
  let tempScript = "";

  $btnEdit.on("click", () => {
    tempScript = $scriptInput.val();
    $viewGroup.hide();
    $editGroup.css("display", "flex");
    $scriptInput.prop("disabled", false).focus().addClass("anima-input-active");
  });

  $btnCancel.on("click", () => {
    $scriptInput.val(tempScript);
    exitScriptEdit();
  });

  $btnConfirm.on("click", () => {
    settings.script_content = $scriptInput.val();
    saveStatusSettings(currentSettings); // 内存保存
    exitScriptEdit();
    if (window.toastr) window.toastr.success("脚本已暂存 (记得保存到角色卡)");
  });

  function exitScriptEdit() {
    $editGroup.hide();
    $viewGroup.css("display", "flex");
    $scriptInput.prop("disabled", true).removeClass("anima-input-active");
  }

  // ===========================
  // 全局：保存到角色卡
  // ===========================
  $("#btn-save-zod-card").on("click", async () => {
    const dataToSave = {
      mode: settings.mode,
      rules: settings.rules,
      script_content: settings.script_content,
    };

    // 1. 同步到内存 (防止用户没点确认直接点保存)
    if (settings.mode === "script") {
      // 如果处于脚本编辑模式但未确认，尝试获取当前值
      if (!$scriptInput.prop("disabled")) {
        dataToSave.script_content = $scriptInput.val();
        settings.script_content = dataToSave.script_content;
        exitScriptEdit();
      }
    }

    // 2. 调用工具函数保存
    // 假设 status_logic.js 里的 saveSettingsToCharacterCard 已经正确 export 并在 status.js 引用了
    const success = await saveSettingsToCharacterCard(
      "anima_zod_config",
      dataToSave,
    );

    // 提示已经在 helper 里做了，这里可以不做，或者加个 log
    if (success) {
      console.log("[Anima] Zod config saved to card.");
    }
  });

  // ===========================
  // 新增：Zod 测试弹窗逻辑 (UI交互)
  // ===========================
  const $testModal = $("#anima-zod-test-modal");
  const $testInput = $("#zod-test-input-json");
  const $testLog = $("#zod-test-log-output");

  // 1. 打开弹窗
  $("#btn-test-zod-rules").on("click", (e) => {
    e.preventDefault();
    // 清空日志，或者显示提示
    $testLog.html('<span style="color:#666">// 等待测试...</span>');

    // 预填一个简单的示例，方便用户理解 (如果为空的话)
    if (!$testInput.val().trim()) {
      $testInput.val('{\n  "example_key": value\n}');
    }

    $testModal.removeClass("hidden");
  });

  // 2. 关闭弹窗 (按钮 + 背景点击)
  $(".anima-close-zod-test").on("click", (e) => {
    e.preventDefault();
    $testModal.addClass("hidden");
  });

  $testModal.on("click", function (e) {
    if (e.target === this) {
      $(this).addClass("hidden");
    }
  });

  // 3. 执行测试 (逻辑待实现)
  $("#btn-run-zod-test")
    .off("click")
    .on("click", (e) => {
      e.preventDefault();

      const rawJson = $testInput.val().trim();
      const mode = settings.mode;
      const rules = settings.rules || [];
      const scriptContent = settings.script_content || "";

      const $log = $("#zod-test-log-output");
      $log.html(""); // 清空日志

      // 辅助函数：写日志 (已应用去空格优化)
      const log = (msg, type = "info") => {
        let color = "#ccc";
        let icon = '<i class="fa-solid fa-info-circle"></i>';
        if (type === "success") {
          color = "#4ade80";
          icon = '<i class="fa-solid fa-check-circle"></i>';
        }
        if (type === "error") {
          color = "#f87171";
          icon = '<i class="fa-solid fa-circle-xmark"></i>';
        }
        if (type === "warn") {
          color = "#fbbf24";
          icon = '<i class="fa-solid fa-triangle-exclamation"></i>';
        }
        const time = new Date().toLocaleTimeString();
        $log.append(
          `<div style="color:${color}; margin-bottom:4px; border-bottom:1px solid #333; padding-bottom:2px;"><span style="opacity:0.5; font-size:10px;">[${time}]</span> ${icon} ${msg}</div>`,
        );
        $log.scrollTop($log[0].scrollHeight);
      };

      const z = window.z;
      if (!z) {
        log("严重错误: 无法找到 window.z 对象。", "error");
        return;
      }

      // --- 🟢 新增：准备 oldData (基准数据) ---
      let realOldData = {};
      try {
        if (window.TavernHelper) {
          const vars = window.TavernHelper.getVariables({
            type: "message",
            message_id: "latest",
          });
          realOldData = vars.anima_data || vars || {};

          // 为了避免日志刷屏，只显示部分
          const preview = JSON.stringify(realOldData).slice(0, 40) + "...";
          log(`环境就绪: 已加载基准数据 (oldData) [${preview}]`, "info");
        } else {
          log("警告: 未检测到 TavernHelper，oldData 将为空对象。", "warn");
        }
      } catch (e) {
        log(`获取 oldData 失败: ${e.message}`, "warn");
      }
      const wrappedOldData = createRenderContext(realOldData);
      // -------------------------------------------

      let dataObj = null;
      try {
        if (!rawJson) throw new Error("输入为空");
        dataObj = JSON.parse(rawJson);
        log("JSON 格式校验通过", "success");
      } catch (err) {
        log(`JSON 解析失败: ${err.message}`, "error");
        return;
      }
      const wrappedNewData = createRenderContext(dataObj);
      try {
        if (mode === "ui") {
          log(`正在执行 UI 模式校验 (${rules.length} 条规则)...`, "info");

          if (rules.length === 0) {
            log("警告: 当前没有配置任何规则。", "warn");
            return;
          }

          // 🔥 1. 准备工作：完全模拟 validateWithUI 的行为
          // 先深拷贝原始数据，确保不污染外部环境
          const uiResultData = window._.cloneDeep(dataObj);
          // 再给拷贝的数据套上 _user/_char 别名壳
          const uiContext = createRenderContext(uiResultData);

          let passCount = 0;
          let failCount = 0;
          let correctedCount = 0;

          rules.forEach((rule, idx) => {
            const path = rule.path;
            if (!path) return;

            // 🔥 2. 从我们的临时 Context 中取值
            let value = undefined;
            if (window._ && window._.get) {
              value = window._.get(uiContext, path);
            } else {
              value = path.split(".").reduce((o, k) => (o || {})[k], uiContext);
            }

            if (value === undefined) {
              log(`[规则 #${idx + 1}] 路径 "${path}": 未找到值 (跳过)`, "warn");
              return;
            }

            let schema = null;

            try {
              if (rule.type === "number") {
                // 数值类型：使用 autoNum (支持自动修补)
                schema = createAutoNumberSchema(
                  path,
                  {
                    min:
                      rule.min !== "" && rule.min !== undefined
                        ? Number(rule.min)
                        : undefined,
                    max:
                      rule.max !== "" && rule.max !== undefined
                        ? Number(rule.max)
                        : undefined,
                    maxDelta:
                      rule.delta !== "" && rule.delta !== undefined
                        ? Number(rule.delta)
                        : undefined,
                    priority: "delta",
                  },
                  wrappedOldData, // 使用外部准备好的旧数据
                  window._,
                );
              } else if (rule.type === "string") {
                // 字符串类型
                schema = z.coerce.string();
                if (rule.enum) {
                  const enumList = rule.enum
                    .split(/[,，]/)
                    .map((s) => s.trim())
                    .filter((s) => s);
                  if (enumList.length > 0) {
                    schema = schema.refine((val) => enumList.includes(val), {
                      message: `必须是: ${enumList.join(", ")}`,
                    });
                  }
                }
              } else if (rule.type === "boolean") {
                // 🔥 3. 布尔类型：同步 status_zod.js 的修复逻辑
                // 不再简单使用 z.coerce.boolean()，而是手动处理 "false" 字符串
                schema = z.any().transform((val) => {
                  if (typeof val === "string") {
                    return val.toLowerCase() !== "false" && val !== "";
                  }
                  return Boolean(val);
                });
              }

              // 执行校验
              const result = schema.safeParse(value);

              if (result.success) {
                // 🔥 4. 关键修改：如果有变化，真正写回 uiContext
                // 因为 uiContext._user 指向 uiResultData.ShenJiao
                // 所以这里修改了，uiResultData 也就变了
                if (result.data !== value) {
                  log(
                    `[规则 #${idx + 1}] ${path}: 自动修补 🛠️\n    原始值: ${JSON.stringify(value)}\n    修补后: ${JSON.stringify(result.data)}`,
                    "warn",
                  );
                  window._.set(uiContext, path, result.data); // <--- 写回！
                  correctedCount++;
                } else {
                  log(
                    `[规则 #${idx + 1}] ${path}: ${JSON.stringify(value)} (通过) ✅`,
                    "success",
                  );
                }
                passCount++;
              } else {
                const errorMsg = result.error.issues
                  .map((i) => i.message)
                  .join("; ");
                log(
                  `[规则 #${idx + 1}] ${path}: 失败 ❌ - ${errorMsg}`,
                  "error",
                );
                failCount++;
              }
            } catch (e) {
              log(`[规则 #${idx + 1}] 错误: ${e.message}`, "error");
              failCount++;
            }
          });

          log(
            `--- 测试结束: 通过 ${passCount}, 修补 ${correctedCount}, 失败 ${failCount} ---`,
            failCount === 0 ? "success" : "warn",
          );

          // 🔥 5. 打印最终结果
          // uiResultData 此时已经是修补过的干净 JSON（不含 _user）
          log(
            "最终数据(模拟回写): " + JSON.stringify(uiResultData, null, 2),
            "info",
          );
        } else if (mode === "script") {
          log("正在执行 脚本模式 校验...", "info");

          if (!scriptContent.trim()) {
            log("脚本内容为空。", "warn");
            return;
          }

          let userSchema = null;
          try {
            // 🔴 关键修复 1: 在测试环境中构建 utils 工具箱
            // 这样测试台才能看懂 utils.autoNum
            const utils = {
              val: (path, def) => window._.get(wrappedOldData, path, def),
              getVar: (name) => {
                if (window.TavernHelper && window.TavernHelper.getVariable) {
                  return window.TavernHelper.getVariable(name);
                }
                return null;
              },
              // 调用刚刚 import 进来的辅助函数
              autoNum: (path, opts) =>
                createAutoNumberSchema(path, opts, wrappedOldData, window._), // 🟢 改这里
            };

            // 🔴 关键修复 2: 注入 utils 参数
            // new Function 的参数依次是: 'z', 'oldData', 'utils', '函数体内容'
            // 注意参数顺序要和 status_zod.js 里保持一致，方便用户记忆
            // (我在 status_zod.js 里建议的是 z, _, oldData, utils，这里稍微适配一下)

            // 为了和 status_zod.js 保持完全一致的体验，我们把 _ 也传进去
            const createSchema = new Function(
              "z",
              "_",
              "oldData",
              "utils",
              scriptContent,
            );

            // 执行函数，传入真实的 z, lodash, realOldData 和 utils
            userSchema = createSchema(z, window._, wrappedOldData, utils);

            if (!userSchema || typeof userSchema.safeParse !== "function") {
              throw new Error(
                "脚本未返回有效的 Zod Schema (需 return z.object(...) )",
              );
            }
          } catch (e) {
            log(`脚本语法/执行错误: ${e.message}`, "error");
            console.error(e);
            return;
          }

          const result = userSchema.safeParse(wrappedNewData); // 这里传 wrappedNewData

          if (result.success) {
            // =========================================================
            // 🔥 核心新增：深度比对函数 (Diff Walker)
            // =========================================================
            let changeCount = 0;

            // 递归比对两个对象，打印差异
            const findAndLogDiff = (original, modified, path = "") => {
              // 获取所有涉及的键 (并集)
              const allKeys = new Set([
                ...Object.keys(original || {}),
                ...Object.keys(modified || {}),
              ]);

              allKeys.forEach((key) => {
                // 忽略 _char (通常不用于校验)
                if (key === "_char") return;

                const val1 = original ? original[key] : undefined;
                const val2 = modified ? modified[key] : undefined;
                const currentPath = path ? `${path}.${key}` : key;

                // 使用 Lodash 判断相等性
                if (!window._.isEqual(val1, val2)) {
                  // 如果都是纯对象，则递归深入 (继续找具体是哪个子字段变了)
                  if (
                    window._.isPlainObject(val1) &&
                    window._.isPlainObject(val2)
                  ) {
                    findAndLogDiff(val1, val2, currentPath);
                  } else {
                    // 如果不是对象（是值），或者其中一个是 undefined/null，说明这里发生了实质性修改
                    log(
                      `[脚本修正] ${currentPath}: 自动修补 🛠️\n    原始值: ${JSON.stringify(val1)}\n    修补后: ${JSON.stringify(val2)}`,
                      "warn",
                    );
                    changeCount++;
                  }
                }
              });
            };

            // 执行比对：对比“输入数据(wrappedNewData)”和“输出数据(result.data)”
            // 这样能直接检测到 _user 下的变化
            findAndLogDiff(wrappedNewData, result.data);

            if (changeCount === 0) {
              log("脚本校验完美通过 (无修改) ✅", "success");
            } else {
              log(
                `--- 校验完成: 触发了 ${changeCount} 处自动修正 (见上方) ---`,
                "warn",
              );
            }

            // =========================================================
            // 下面是之前的回写与最终展示逻辑 (保持不变)
            // =========================================================
            const finalDisplay = { ...result.data };
            const keys = Object.keys(finalDisplay);
            const userKey = keys.find((k) => k !== "_user" && k !== "_char");
            if (userKey && finalDisplay._user) {
              finalDisplay[userKey] = finalDisplay._user;
            }
            delete finalDisplay._user;
            delete finalDisplay._char;

            log(
              "最终数据(模拟回写): " + JSON.stringify(finalDisplay, null, 2),
              "info",
            );
          }
        }
      } catch (globalErr) {
        log(`未知运行错误: ${globalErr.message}`, "error");
        console.error(globalErr);
      }
    });
}

function initHistoryModule() {
  // UI 元素引用
  const $modal = $("#anima-history-modal");
  const $btnOpenModal = $("#btn-open-history-modal");
  const $btnCloseModal = $("#btn-close-history-modal, #btn-modal-cancel");
  const $listContainer = $("#history-list-container");

  const $textarea = $("#hist-yaml-content");
  const $indicator = $("#hist-current-floor-indicator");

  // 按钮组
  const $viewGroup = $("#hist-actions-view");
  const $editGroup = $("#hist-actions-edit");
  const $btnRefresh = $("#btn-hist-refresh");
  const $btnEdit = $("#btn-hist-edit");
  const $btnConfirm = $("#btn-hist-confirm");
  const $btnCancel = $("#btn-hist-cancel");

  let tempContent = "";
  let currentFloorId = null;
  bindYamlAutoIndent($textarea);

  // 1. 打开弹窗 (选择楼层)
  $btnOpenModal.on("click", (e) => {
    e.preventDefault();
    // 【关键修改】使用 class 切换
    $modal.removeClass("hidden");

    // 扫描并渲染列表
    const floors = scanChatForStatus();
    renderModalList(floors);
  });

  // 2. 关闭弹窗
  $btnCloseModal.on("click", (e) => {
    e.preventDefault();
    $modal.addClass("hidden");
  });
  $modal.on("click", (e) => {
    if (e.target === $modal[0]) $modal.addClass("hidden");
  });

  // 3. 渲染弹窗列表逻辑
  function renderModalList(floors) {
    $listContainer.empty();
    if (floors.length === 0) {
      $listContainer.html(
        '<div style="text-align:center; color:#888; padding:20px;">未发现包含状态的历史记录</div>',
      );
      return;
    }

    floors
      .sort((a, b) => b.id - a.id)
      .forEach((floor) => {
        const $item = $(`
                <div class="anima-history-item" style="padding: 10px; background: rgba(255,255,255,0.05); border-radius: 4px; cursor: pointer; margin-bottom: 5px; border: 1px solid transparent; transition: all 0.2s;">
                    <div style="display:flex; justify-content: space-between; align-items: center;">
                        <span style="font-weight: bold; color: var(--anima-primary);">Floor #${floor.id}</span>
                        <span style="font-size: 12px; opacity: 0.7;">${floor.role.toUpperCase()}</span>
                    </div>
                    <div style="font-size: 12px; color: #aaa; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                        ${escapeHtml(floor.preview || "No preview")}
                    </div>
                </div>
            `);

        $item.hover(
          function () {
            $(this).css("background", "rgba(255,255,255,0.1)");
          },
          function () {
            $(this).css("background", "rgba(255,255,255,0.05)");
          },
        );

        $item.on("click", async (e) => {
          e.preventDefault();
          await loadFloorStatus(floor.id);
          $modal.addClass("hidden");
        });

        $listContainer.append($item);
      });
  }

  // 4. 加载特定楼层数据到主界面
  async function loadFloorStatus(floorId) {
    try {
      const statusData = getStatusFromMessage(floorId);
      if (statusData) {
        // --- 修改点：剥离最外层 anima_data ---
        const displayData = statusData.anima_data
          ? statusData.anima_data
          : statusData;
        const yamlStr = objectToYaml(displayData);
        // ------------------------------------

        $textarea.val(yamlStr);

        // 更新UI状态
        currentFloorId = floorId;
        $indicator.text(`Floor #${floorId}`).show();
        $btnEdit.prop("disabled", false).removeClass("disabled");
        $textarea.prop("disabled", true);
      }
    } catch (e) {
      toastr.error("读取楼层数据失败");
      console.error(e);
    }
  }

  // 5. 编辑功能 (参考实时状态：去掉 .off，加 preventDefault)
  $btnEdit.on("click", (e) => {
    e.preventDefault(); // 阻止默认行为（虽然 button type=button 默认没啥，但加保险）

    // 核心检查：如果当前没选楼层（currentFloorId 为 null），则拦截并提示
    if (currentFloorId === null) {
      toastr.warning("请先通过“选择楼层”加载一个历史快照");
      return;
    }

    // --- 以下是正常的进入编辑模式逻辑 ---
    console.log("[Anima] History Edit Clicked"); // 这下能看到日志了

    tempContent = $textarea.val();
    $viewGroup.hide();
    $editGroup.css("display", "flex");
    $textarea.prop("disabled", false).focus().addClass("anima-input-active");
  });

  // 6. 取消编辑
  $btnCancel.on("click", (e) => {
    e.preventDefault();
    $textarea.val(tempContent);
    exitEditMode();
  });

  // 7. 确认保存
  $btnConfirm.on("click", async (e) => {
    e.preventDefault();
    if (currentFloorId === null) return;

    const newYaml = $textarea.val();
    try {
      const newObj = yamlToObject(newYaml);
      if (!newObj) throw new Error("YAML 格式错误");

      // 1. 保存到指定楼层
      await saveStatusToMessage(
        currentFloorId,
        { anima_data: newObj },
        "manual_ui",
      );
      toastr.success(`已更新楼层 #${currentFloorId} 的状态`);

      // ===============================================
      // ✅ 核心修复：无条件刷新实时面板
      // ===============================================
      // 只要修改了历史记录（无论是最新层还是旧层），都有可能影响当前显示的“继承状态”
      // 加 50ms 延时是为了防止 saveStatusToMessage 的异步写入尚未完全传播到 getVariables
      setTimeout(() => {
        console.log("[Anima] 历史状态已变更，强制刷新实时面板...");
        refreshStatusPanel();

        // 可选：给顶部面板加个闪烁动画，提示用户数据已变
        $("#status-yaml-content").addClass("anima-input-active");
        setTimeout(
          () => $("#status-yaml-content").removeClass("anima-input-active"),
          300,
        );
      }, 50);
      // ===============================================

      exitEditMode();
    } catch (e) {
      toastr.error("保存失败: " + e.message);
    }
  });

  // 8. 刷新按钮
  $btnRefresh.on("click", (e) => {
    e.preventDefault();
    const $icon = $btnRefresh.find("i");
    $icon.addClass("fa-spin");

    // 模拟一点延迟让用户感觉到刷新了
    setTimeout(() => {
      if (currentFloorId !== null) {
        loadFloorStatus(currentFloorId);
        toastr.success("已刷新当前楼层数据");
      } else {
        // 如果没选楼层，点击刷新相当于打开选择器
        $btnOpenModal.click();
      }
      $icon.removeClass("fa-spin");
    }, 300);
  });

  function exitEditMode() {
    $editGroup.hide();
    $viewGroup.css("display", "flex");
    $textarea.prop("disabled", true).removeClass("anima-input-active");
  }

  // ===============================================
  // 新增：开场白状态绑定逻辑 (Greeting Presets)
  // ===============================================
  const $greetingSelect = $("#greeting-select");
  const $greetingTextarea = $("#greeting-yaml-content");
  bindYamlAutoIndent($greetingTextarea);
  const $btnGreetingRefresh = $("#btn-greeting-refresh");
  const $btnGreetingEdit = $("#btn-greeting-edit");
  const $btnGreetingConfirm = $("#btn-greeting-confirm-edit");
  const $btnGreetingCancel = $("#btn-greeting-cancel-edit");

  // 【修改】这个按钮现在是常驻的，不需要频繁 toggle
  const $btnGreetingSaveCard = $("#btn-greeting-save-card");

  const $greetingViewActions = $("#greeting-actions-view");
  const $greetingEditActions = $("#greeting-actions-edit");

  let greetingPresetsCache = {}; // 内存缓存
  let tempGreetingContent = "";

  // 1. 加载角色卡开场白列表
  async function loadCharacterGreetings() {
    // 记录当前选中的值，刷新后尝试恢复
    const currentVal = $greetingSelect.val();
    $greetingSelect.empty();

    const context = SillyTavern.getContext();
    const charId = context.characterId;

    if (charId === undefined || charId === null) {
      $greetingSelect.html('<option value="-1">未检测到角色卡</option>');
      return;
    }

    try {
      const charData = context.characters[charId];
      let optionsHtml = "";

      // Index 0: first_mes
      const firstMes = charData.first_mes || "";
      const MAX_PREVIEW_LEN = 45;

      // 处理 First Message
      const firstMesDisplay =
        firstMes.length > MAX_PREVIEW_LEN
          ? firstMes.substring(0, MAX_PREVIEW_LEN - 3) + "..."
          : firstMes;
      optionsHtml += `<option value="0" title="${escapeHtml(firstMes)}">Default: ${firstMesDisplay}</option>`;

      // 处理 Alternate Greetings
      if (charData.data && Array.isArray(charData.data.alternate_greetings)) {
        charData.data.alternate_greetings.forEach((alt, idx) => {
          const displayIdx = idx + 1;
          const altText = alt || "";

          const altDisplay =
            altText.length > MAX_PREVIEW_LEN
              ? altText.substring(0, MAX_PREVIEW_LEN - 3) + "..."
              : altText;

          // 🛑 修改点 3: 同样给这里添加 title 属性
          optionsHtml += `<option value="${displayIdx}" title="${escapeHtml(altText)}">Alt #${displayIdx}: ${altDisplay}</option>`;
        });
      }

      $greetingSelect.html(optionsHtml);

      // 读取现有的 presets
      const extSettings = getStatusSettings();
      greetingPresetsCache = extSettings.greeting_presets || {};

      // 尝试恢复选中，如果不存在则选 0
      if (
        currentVal &&
        $greetingSelect.find(`option[value="${currentVal}"]`).length > 0
      ) {
        $greetingSelect.val(currentVal);
      } else {
        $greetingSelect.val("0");
      }

      $greetingSelect.trigger("change");
    } catch (e) {
      console.error(e);
      $greetingSelect.html('<option value="-1">加载失败</option>');
    }
  }

  // 2. 下拉框变更
  $greetingSelect.on("change", function () {
    const val = $(this).val();
    if (val === "-1" || val === null) {
      $greetingTextarea.val("");
      $btnGreetingEdit.prop("disabled", true);
      return;
    }

    $btnGreetingEdit.prop("disabled", false);

    // 读取缓存
    const presetData = greetingPresetsCache[val] || {};
    const yamlStr =
      Object.keys(presetData).length > 0 ? objectToYaml(presetData) : "";

    $greetingTextarea.val(yamlStr);
    if (!yamlStr) {
      $greetingTextarea.attr(
        "placeholder",
        "# 此开场白暂无绑定状态\n# 点击编辑按钮进行配置...",
      );
    }
  });

  // 3. 刷新按钮
  $btnGreetingRefresh.on("click", (e) => {
    e.preventDefault();
    loadCharacterGreetings();
    const $icon = $btnGreetingRefresh.find("i");
    $icon.addClass("fa-spin");
    setTimeout(() => $icon.removeClass("fa-spin"), 500);
  });

  // 4. 编辑按钮
  $btnGreetingEdit.on("click", (e) => {
    e.preventDefault();
    tempGreetingContent = $greetingTextarea.val();
    $greetingViewActions.hide();
    $greetingEditActions.css("display", "flex");
    $greetingTextarea
      .prop("disabled", false)
      .addClass("anima-input-active")
      .focus();
  });

  // 5. 取消编辑
  $btnGreetingCancel.on("click", (e) => {
    e.preventDefault();
    $greetingTextarea.val(tempGreetingContent);
    exitGreetingEdit();
  });

  // 6. 确认编辑 (写入缓存)
  $btnGreetingConfirm.on("click", (e) => {
    e.preventDefault();
    const currentIdx = $greetingSelect.val();
    const newYaml = $greetingTextarea.val();

    try {
      // ============================================================
      // 🟢 修复 (V2): 更改占位符，避免 YAML 将 # 识别为注释
      // ============================================================

      let safeYaml = newYaml;
      // 1. 隐藏宏标签 (使用下划线，避免 # 注释冲突)
      // 同时也处理一下可能存在的引号，确保它作为纯 key 存在
      if (safeYaml && safeYaml.includes("{{")) {
        safeYaml = safeYaml
          .replace(/\{\{/g, "__ANIMA_MACRO_OPEN__")
          .replace(/\}\}/g, "__ANIMA_MACRO_CLOSE__");
      }

      // 2. 安全解析
      let newObj = safeYaml.trim() ? yamlToObject(safeYaml) : {};

      // 3. 递归还原宏标签
      const restoreMacros = (obj) => {
        if (typeof obj === "string") {
          return obj
            .replace(/__ANIMA_MACRO_OPEN__/g, "{{")
            .replace(/__ANIMA_MACRO_CLOSE__/g, "}}");
        }
        if (Array.isArray(obj)) {
          return obj.map(restoreMacros);
        }
        if (typeof obj === "object" && obj !== null) {
          const restored = {};
          for (const key in obj) {
            const newKey = key
              .replace(/__ANIMA_MACRO_OPEN__/g, "{{")
              .replace(/__ANIMA_MACRO_CLOSE__/g, "}}");
            restored[newKey] = restoreMacros(obj[key]);
          }
          return restored;
        }
        return obj;
      };

      newObj = restoreMacros(newObj);

      // ============================================================

      if (newYaml.trim() && !newObj) throw new Error("YAML 格式错误");

      // 更新缓存
      greetingPresetsCache[currentIdx] = newObj;

      toastr.success(`已暂存 [开场白 #${currentIdx}] 的状态配置`);
      exitGreetingEdit();
    } catch (err) {
      console.error(err);
      toastr.error("YAML 解析失败: " + err.message);
    }
  });

  function exitGreetingEdit() {
    $greetingEditActions.hide();
    $greetingViewActions.css("display", "flex");
    $greetingTextarea.prop("disabled", true).removeClass("anima-input-active");
  }

  // 7. 保存到角色卡 (物理保存)
  $btnGreetingSaveCard.on("click", async (e) => {
    e.preventDefault();

    // 1. 同步到 Settings
    if (!currentSettings.greeting_presets)
      currentSettings.greeting_presets = {};
    currentSettings.greeting_presets = greetingPresetsCache;

    // 2. 保存到内存 (Debounced)
    saveStatusSettings(currentSettings);

    // 3. 保存到角色卡文件
    const success = await saveSettingsToCharacterCard(
      "anima_greeting_presets",
      greetingPresetsCache,
    );

    if (success) {
      // 可选：给个强烈的视觉反馈
      console.log("[Anima] Greeting Presets Saved:", greetingPresetsCache);
    }
  });

  // 初始化监听
  $("#greeting-binding-section").on("toggle", function () {
    if (this.open) loadCharacterGreetings();
  });
}

// ==========================================
// 逻辑模块 3: 全局保存
// ==========================================
function bindGlobalEvents() {
  $("#btn-add-status-prompt").on("click", (e) => {
    // 【核心修改】简化为只添加普通规则
    currentSettings.prompt_rules.unshift({
      role: "system",
      title: "新规则",
      content: "",
    });
    renderStatusList();
  });

  // --- 新增：提示词导出逻辑 ---
  $("#btn-export-status-prompt").on("click", () => {
    try {
      // 获取当前内存中的规则
      const rules = currentSettings.prompt_rules || [];
      const dataStr = JSON.stringify(rules, null, 4);
      const blob = new Blob([dataStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      // 生成带时间戳的文件名
      const timestamp = new Date()
        .toISOString()
        .replace(/[-:.]/g, "")
        .slice(0, 14);
      a.download = `anima_status_prompts_${timestamp}.json`;
      document.body.appendChild(a);
      a.click();

      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (window.toastr) toastr.success("提示词序列导出成功");
    } catch (e) {
      console.error(e);
      if (window.toastr) toastr.error("导出失败: " + e.message);
    }
  });

  // --- 新增：提示词导入逻辑 ---
  // 1. 点击按钮触发文件选择
  $("#btn-import-status-prompt").on("click", () => {
    $("#status_import_prompt_file").click();
  });

  // 2. 文件选择变化处理
  $("#status_import_prompt_file").on("change", function (e) {
    const target = e.target;
    if (!target.files || !target.files[0]) return;

    const file = target.files[0];
    const reader = new FileReader();

    reader.onload = (ev) => {
      try {
        const result = ev.target.result;
        if (typeof result !== "string") return;

        const json = JSON.parse(result);

        if (Array.isArray(json)) {
          if (
            confirm("确定要导入该文件吗？这将覆盖当前的状态更新提示词序列。")
          ) {
            // 1. 更新内存配置
            currentSettings.prompt_rules = json;

            // 2. 保存到插件设置 (Extension Settings)
            // 这步很重要，确保后续点击“保存到角色卡”时用的是新数据
            saveStatusSettings(currentSettings);

            // 3. 刷新 UI 列表
            renderStatusList();

            if (window.toastr)
              toastr.success("提示词序列导入成功 (记得保存到角色卡)");
          }
        } else {
          if (window.toastr) toastr.error("文件格式错误：内容必须是 JSON 数组");
        }
      } catch (err) {
        console.error(err);
        if (window.toastr) toastr.error("JSON 解析失败: " + err.message);
      }
      // 清空 value，允许重复导入同一个文件
      $(target).val("");
    };
    reader.readAsText(file);
  });

  $("#btn-save-prompt-card").on("click", async () => {
    // 假设我们将 prompt_rules 存为 anima_prompt_config
    const dataToSave = currentSettings.prompt_rules;
    await saveSettingsToCharacterCard("anima_prompt_config", dataToSave);
  });
  $("#btn-preview-status-prompt")
    .off("click")
    .on("click", () => showStatusPreviewModal());

  $(window).on("anima:status_sync_start", function () {
    // === 新增：检查开关状态 ===
    const updateConfig = currentSettings.update_management || {
      panel_enabled: false,
    };
    // 如果面板未启用，直接不处理 UI，保持隐藏
    if (!updateConfig.panel_enabled) return;
    // ========================

    const $btn = $("#anima-floating-sync-btn");
    if ($btn.length > 0) {
      // 1. 变图标为转圈
      $btn.find("i").attr("class", "fa-solid fa-spinner fa-spin");
      // 2. 确保它是显示的 (防止倒计时结束时按钮恰好被隐藏)
      $btn
        .css("display", "flex")
        .removeClass("anima-spin-out")
        .addClass("anima-fade-in");
    }
  });

  $(window)
    .off("anima:status_updated")
    .on("anima:status_updated", function (e) {
      refreshStatusPanel();

      // 只有这几种情况才弹窗
      // 1. manual_ui: 用户手动在面板修改了变量并保存
      // 2. auto_update_success: 正常的副 API 流程结束 (需在 logic 里传这个 reason)
      const allowedReasons = ["manual_ui", "auto_update_success"];

      if (allowedReasons.includes(e.detail?.reason) && window.toastr) {
        window.toastr.success("状态已同步");
      }
    });
}

function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * 将状态对象同步到 ST 变量管理器
 * @param {Object} statusObj - 从 YAML 解析出来的 JS 对象
 */
async function syncStatusToVariables(statusObj) {
  if (!statusObj) return;

  try {
    // 策略 A：直接把整个对象存为一个变量 (例如 {{status}})
    // await window.TavernHelper.insertOrAssignVariables({ "status": statusObj }, { type: 'chat' });

    // 策略 B (推荐)：如果你的状态结构是 { HP: 100, MP: 50 }，展平注册，方便在 ST 里用 {{HP}} 调用
    // 如果你的结构是 { 属性: { HP: 100 } }，可能需要递归展平或者只注册第一层

    // 这里假设 statusObj 是类似 { HP: 100, State: "Healthy" } 的结构
    await window.TavernHelper.insertOrAssignVariables(statusObj, {
      type: "chat",
    });

    console.log("[Anima] 变量已同步到 Variable Manager");
  } catch (e) {
    console.error("[Anima] 变量同步失败:", e);
  }
}

function initUpdateManagementModule() {
  // 确保对象存在 (补充 char_threshold 字段)
  if (!currentSettings.update_management) {
    currentSettings.update_management = {
      stop_sequence: "",
      panel_enabled: false,
      char_threshold: "", // 新增初始值
    };
  }
  const settings = currentSettings.update_management;

  // 1. 文本框逻辑优化：只更新内存，不立即写盘
  $("#status_stop_sequence").on("input", function () {
    settings.stop_sequence = $(this).val();
  });

  $("#status_char_threshold").on("input", function () {
    settings.char_threshold = $(this).val();
  });

  // 2. 开关逻辑：保持即时生效（因为涉及到 UI 刷新）
  $("#status_panel_enabled").on("change", function () {
    settings.panel_enabled = $(this).prop("checked");

    // 开关还是建议即时保存，防止用户点了开关没点保存按钮导致 UI 和数据不一致
    saveStatusSettings(currentSettings);

    // 立即刷新面板 UI (隐藏/显示悬浮按钮)
    refreshStatusPanel();

    if (window.toastr) {
      const statusText = settings.panel_enabled ? "启用" : "禁用";
      toastr.info(`状态更新面板已${statusText}`);
    }
  });

  // 3. 【新增】绑定保存按钮
  $("#btn-save-update-config").on("click", function () {
    // 强制保存当前内存中的所有设置到全局 settings.json
    saveStatusSettings(currentSettings);

    // 视觉反馈
    if (window.toastr) {
      toastr.success("状态管理配置已保存 (Global)");
    }

    // 顺便刷新一下面板，确保状态同步
    refreshStatusPanel();
  });
}

/**
 * 显示预览弹窗 (含正则清洗 + 字段修复)
 */
async function showStatusPreviewModal() {
  const $btn = $("#btn-preview-status-prompt");
  const originalText = $btn.html();

  // Loading 动画
  $btn.html('<i class="fa-solid fa-circle-notch fa-spin"></i> 生成中...');
  $btn.prop("disabled", true);

  try {
    // 1. 获取核心数据
    const result = await previewStatusPayload();

    // 2. 准备基础数据
    const rules = currentSettings.prompt_rules || [];
    // --- 3. 准备并清洗 Context 消息 ---
    let processedContextMsgs = [];

    // 1. 获取配置并设置默认值
    const regexSettings = currentSettings.regex_settings || {
      skip_layer_zero: true,
      regex_skip_user: false,
      exclude_user: false,
      regex_list: [],
    };
    const safeRegexList = Array.isArray(regexSettings.regex_list)
      ? regexSettings.regex_list
      : [];

    if (
      result.incremental &&
      result.incremental.range &&
      result.incremental.range.count > 0
    ) {
      try {
        // A. 获取原始消息
        const rawMsgs = window.TavernHelper.getChatMessages(
          `${result.incremental.range.start}-${result.incremental.range.end}`,
          { include_swipes: false },
        );

        // B. 遍历消息进行清洗
        rawMsgs.forEach((msg) => {
          const isUser = msg.is_user || msg.role === "user";

          // 1. 排除 User (保持不变)
          if (regexSettings.exclude_user && isUser) {
            return;
          }

          // 🔥 步骤 A: 获取原始内容
          let content = msg.message || "";

          // 🔥 步骤 B: 宏替换 (processMacros) 必须最先执行
          // 这样能确保宏展开后的内容也能被后续的清洗逻辑覆盖
          if (content) {
            content = processMacros(content);
          }

          // 🛑 DEBUG: 如果你还会遇到问题，请按 F12 看控制台，告诉我这里打印了什么
          // console.log(`[Status Debug] Raw:`, JSON.stringify(content));

          // 🔥 步骤 C: 【强力清洗】循环去除头部的 >、&gt; 和空白
          // 原因：有时候 LLM 会输出 ">> text" 或者 "&gt; text"
          // 这里的正则含义：匹配开头(^) 的 任意空白([\s\r\n]*) + (大于号> 或 转义&gt;) + 任意空白
          const cleanRegex = /^[\s\r\n]*(&gt;|>)[\s\r\n]*/i;

          // 使用 while 循环，只要开头还有 > 就一直删，直到删干净为止
          while (cleanRegex.test(content)) {
            content = content.replace(cleanRegex, "");
          }

          // 再次 trim 确保开头没有残留的换行
          content = content.trim();

          // 如果洗完只剩空壳（比如原本只有一个 >），则跳过
          if (!content) return;

          let isSkipped = false;

          // 2. 判断是否跳过正则 (保持不变)
          if (regexSettings.skip_layer_zero && String(msg.message_id) === "0")
            isSkipped = true;
          if (regexSettings.regex_skip_user && isUser) isSkipped = true;

          // 3. 应用插件内部的正则 (保持不变)
          // 注意：这里只会应用你在 Status 插件面板里配置的正则
          if (!isSkipped && safeRegexList.length > 0) {
            content = applyRegexRules(content, safeRegexList);
            // 正则处理后可能又产生了头部空白，再修剪一次
            content = content.trim();
          }

          // 推入结果
          processedContextMsgs.push({
            role: msg.role,
            is_user: isUser,
            displayContent: content,
            isSkipped: isSkipped,
          });
        });
      } catch (err) {
        console.error("处理增量消息失败:", err);
      }
    }

    // --- 4. 准备 Base Status YAML ---
    let baseStatusYaml = "# Error: 无法获取状态数据";
    let baseStatusSourceText = "N/A";

    if (
      result.sourceFloorId !== -1 &&
      typeof result.sourceFloorId === "number"
    ) {
      try {
        const vars = window.TavernHelper.getVariables({
          type: "message",
          message_id: result.sourceFloorId,
        });
        const data = vars.anima_data || vars || {};

        if (Object.keys(data).length > 0) {
          baseStatusYaml = objectToYaml(data);
        } else {
          baseStatusYaml = "# 此楼层无状态数据 (Empty)";
        }
        baseStatusSourceText = `Floor #${result.sourceFloorId}`;
      } catch (e) {
        baseStatusYaml = "# 读取出错: " + e.message;
      }
    } else {
      baseStatusYaml = "# 初始状态 (Init)";
      baseStatusSourceText = "Init";
    }

    // =========================================================
    // 5. 定义样式辅助函数
    // =========================================================
    const createBlock = (
      title,
      content,
      color,
      borderColor,
      bgColor,
      isExpanded = false,
      headerExtra = "",
    ) => {
      const displayStyle = isExpanded ? "block" : "none";
      const expandedClass = isExpanded ? "expanded" : "";
      return `
            <div class="anima-preview-block ${expandedClass}" style="border-color: ${borderColor};">
                <div class="block-header" style="background: ${bgColor}; color: ${color};">
                    <div style="display:flex; align-items:center; justify-content: space-between; flex:1; padding-right: 10px;">
                        <span style="display:flex; align-items:center; gap:8px;">${title}</span>
                        ${headerExtra}
                    </div>
                    <i class="fa-solid fa-chevron-down arrow-icon"></i>
                </div>
                <div class="block-content" style="display: ${displayStyle}; white-space: pre-wrap; color: #ccc;">${content}</div>
            </div>`;
    };

    const cssStyle = `<style>
            .anima-preview-block { border: 1px solid #444; border-radius: 6px; margin-bottom: 10px; overflow: hidden; background: rgba(0,0,0,0.1); } 
            .block-header { padding: 8px 10px; font-size: 13px; font-weight: bold; cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none; } 
            .block-header:hover { filter: brightness(1.2); } 
            .block-content { padding: 10px; font-size: 12px; border-top: 1px solid rgba(0,0,0,0.2); background: rgba(0,0,0,0.2); line-height: 1.5; } 
            .anima-preview-block.expanded .arrow-icon { transform: rotate(180deg); }
        </style>`;

    // =========================================================
    // 6. 遍历 Prompt Rules 构建列表
    // =========================================================
    let charDesc = processMacros("{{description}}");
    if (charDesc === "{{description}}") charDesc = "未检测到角色卡信息";

    let userPersona = processMacros("{{persona}}");
    if (userPersona === "{{persona}}") userPersona = "未检测到用户设定";

    let listHtml = "";

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];

      // --- 新增：过滤掉未启用的条目 ---
      if (rule.enabled === false) continue;

      // --- 新增：处理角色卡和用户设定 ---
      if (rule.type === "char_info" || rule.type === "user_info") {
        const isChar = rule.type === "char_info";
        const labelTitle = isChar ? `👾 角色卡信息` : `👑 用户设定`;

        // 使用刚才获取到的 charDesc 和 userPersona
        let raw = isChar ? charDesc : userPersona;
        raw = processMacros(raw || "");

        const extraTag = `<span class="anima-tag secondary" style="font-size:10px;">SYSTEM</span>`;
        listHtml += createBlock(
          labelTitle,
          escapeHtml(raw),
          isChar ? "#d8b4fe" : "#f472b6", // Color (天蓝浅色)
          isChar ? "#9333ea" : "#db2777", // Border (天蓝深色)
          isChar ? "rgba(168, 85, 247, 0.2)" : "rgba(236, 72, 153, 0.2)", // Background
          false,
          extraTag,
        );
        continue;
      }

      // --- A. 状态插入位 {{status}} ---
      if (rule.content === "{{status}}") {
        const extraInfo = `<span style="font-weight:normal; opacity:0.8; font-family:monospace;">${baseStatusSourceText}</span>`;

        listHtml += createBlock(
          `<i class="fa-solid fa-database"></i> 状态数据来源`,
          `<textarea class="anima-textarea" readonly style="width:100%; height:120px; font-size:12px; font-family:monospace; background:rgba(0,0,0,0.2); color:#a6e3a1; border:none; resize:none; padding:0;">${baseStatusYaml}</textarea>`,
          "#10b981", // Green
          "#059669",
          "rgba(5, 150, 105, 0.2)",
          false,
          extraInfo,
        );
        continue;
      }

      // --- B. 增量剧情插入位 {{chat_context}} ---
      if (rule.content === "{{chat_context}}") {
        let bubblesHtml = "";
        if (processedContextMsgs.length === 0) {
          bubblesHtml = `<div style='padding:5px; color:#aaa; font-style:italic;'>⚠️ 无增量消息 (或已被正则完全过滤)</div>`;
        } else {
          bubblesHtml = processedContextMsgs
            .map((m) => {
              const roleUpper = m.role ? m.role.toUpperCase() : "UNKNOWN";
              const headerColor = m.is_user ? "color:#4ade80" : "color:#60a5fa";

              // 标记 RAW (如果被跳过清洗)
              const rawBadge = m.isSkipped
                ? `<span style="font-size:10px; background:rgba(255,255,255,0.1); border-radius:3px; padding:0 4px; margin-left:6px; color:#aaa;" title="正则已跳过">RAW</span>`
                : "";

              return (
                `<div style="margin-bottom: 15px;">` +
                `<div style="font-weight:bold; font-size: 12px; margin-bottom: 4px; ${headerColor}">[${roleUpper}]${rawBadge}</div>` +
                `<div style="white-space: pre-wrap; color: #ccc; font-size: 13px; padding-left: 2px;">${escapeHtml(m.displayContent).trim()}</div>` +
                `</div>`
              );
            })
            .join("");
        }

        const rangeInfo = result.incremental.range
          ? `<span style="font-weight:normal; opacity:0.8; font-family:monospace;">${result.incremental.range.start} - ${result.incremental.range.end}</span>`
          : "";

        listHtml += createBlock(
          `<i class="fa-solid fa-clock-rotate-left"></i> 增量剧情`,
          bubblesHtml,
          "#60a5fa", // Blue
          "#2563eb",
          "rgba(37, 99, 235, 0.2)",
          false,
          rangeInfo,
        );
        continue;
      }

      // --- C. 手动添加的条目 ---
      const roleStr = (rule.role || "system").toUpperCase();
      const titleStr = rule.title || `Prompt #${i + 1}`;
      const processedContent = processMacros(rule.content || "");
      const extraTag = `<span class="anima-tag secondary" style="font-size:10px;">${roleStr}</span>`;

      listHtml += createBlock(
        `<i class="fa-solid fa-file-lines"></i> ${escapeHtml(titleStr)}`,
        escapeHtml(processedContent),
        "#aaa",
        "#444",
        "rgba(0,0,0,0.3)",
        false,
        extraTag,
      );
    }

    // 7. 显示模态框
    const containerHtml = `<div id="anima-preview-container-status" style="padding: 5px;">${listHtml}</div>`;
    createCustomModal("状态更新序列预览", cssStyle + containerHtml);

    // 8. 绑定折叠事件
    setTimeout(() => {
      $("#anima-preview-container-status")
        .off("click")
        .on("click", ".block-header", function () {
          const $block = $(this).closest(".anima-preview-block");
          const $content = $block.find(".block-content");
          if ($content.is(":visible")) {
            $content.slideUp(150);
            $block.removeClass("expanded");
          } else {
            $content.slideDown(150);
            $block.addClass("expanded");
          }
        });
    }, 100);
  } catch (e) {
    console.error(e);
    if (window.toastr) window.toastr.error("预览生成失败: " + e.message);
  } finally {
    $btn.html(originalText);
    $btn.prop("disabled", false);
  }
}

/**
 * 通用自定义模态框构建器 (标准版)
 * 修复：移除内联布局样式，使用 ST 标准 CSS 类实现完美居中
 */
function createCustomModal(title, contentHtml) {
  const modalId = "anima-custom-preview-modal";

  // 1. 清理旧实例 (防止重复)
  $(`#${modalId}`).remove();

  // 2. 构建符合“最佳实践”的 HTML 结构
  // 关键修复：外层使用 class="anima-modal hidden"，去掉 style="position: fixed..."
  const modalHtml = `
        <div id="${modalId}" class="anima-modal hidden">
            <div class="anima-modal-content" style="
                width: 800px; 
                max-width: 95%; 
                height: 85vh; 
                display: flex; 
                flex-direction: column;
                background: var(--anima-bg-dark, #1f2937); /* 保留原有深色背景 */
                border: 1px solid var(--anima-border);
            ">
                
                <div class="anima-modal-header" style="background: rgba(0,0,0,0.2); border-bottom: 1px solid var(--anima-border);">
                    <h3 style="margin:0; font-size:1.1em; display:flex; align-items:center; gap:10px;">
                        <i class="fa-solid fa-eye"></i> ${title}
                    </h3>
                    <span class="anima-close-modal" style="cursor: pointer; opacity:0.7; font-size: 1.5em;">&times;</span>
                </div>

                <div class="anima-modal-body" style="flex: 1; overflow-y: auto; padding: 20px;">
                    ${contentHtml}
                </div>

                <div class="anima-modal-footer" style="background: rgba(0,0,0,0.2); border-top: 1px solid var(--anima-border);">
                    <button class="anima-btn secondary anima-close-modal">关闭</button>
                </div>

            </div>
        </div>
    `;

  $("body").append(modalHtml);

  // 3. 激活弹窗 (移除 hidden 类)
  // 使用 setTimeout 0 确保 DOM 插入后再切换类，触发 CSS 动画 (Fade In)
  setTimeout(() => {
    $(`#${modalId}`).removeClass("hidden");
  }, 10);

  // 4. 定义关闭逻辑
  const closeModal = () => {
    // 先加 hidden 触发淡出动画
    $(`#${modalId}`).addClass("hidden");

    // 等待动画结束(通常0.2-0.3s)后，从 DOM 中移除元素
    setTimeout(() => {
      $(`#${modalId}`).remove();
    }, 300);
  };

  // 绑定关闭事件 (X 号 和 底部关闭按钮)
  $(`#${modalId} .anima-close-modal`).on("click", closeModal);

  // 点击背景关闭
  $(`#${modalId}`).on("click", function (e) {
    if (e.target === this) {
      closeModal();
    }
  });
}

// ==========================================
// 【修改版】悬浮同步按钮模块 (支持拖动)
// ==========================================
export function initFloatingSyncButton() {
  // 防止重复创建
  if ($("#anima-floating-sync-btn").length > 0) return;

  // 1. 创建 DOM (保持原样)
  const btnHtml = `
        <div id="anima-floating-sync-btn" title="检测到当前状态未同步，点击更新 (可拖动)">
            <i class="fa-solid fa-cloud-arrow-up"></i>
        </div>
    `;
  $("body").append(btnHtml);

  const $btn = $("#anima-floating-sync-btn");

  // 2. 拖动逻辑变量 (保持原样)
  let isDragging = false;
  let hasMoved = false; // 用于区分是点击还是拖动
  let startX, startY, initialLeft, initialTop;

  // 3. 绑定鼠标/触摸事件
  $btn.on("mousedown touchstart", function (e) {
    // 只有左键才触发拖动
    if (e.type === "mousedown" && e.button !== 0) return;

    isDragging = true;
    hasMoved = false;

    // 移除 transition 以便实时跟随，且改变鼠标样式
    $btn.css({ cursor: "grabbing", transition: "none" });

    // 获取起始坐标 (兼容 touch)
    const clientX = e.type === "touchstart" ? e.touches[0].clientX : e.clientX;
    const clientY = e.type === "touchstart" ? e.touches[0].clientY : e.clientY;

    startX = clientX;
    startY = clientY;

    // 获取当前元素位置 (getBoundingClientRect 是相对于视口的)
    const rect = $btn[0].getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    // 🟢【修改1】手机端核心修复：必须阻止默认行为，否则长按会触发菜单/滚动，导致无法拖动
    if (e.type === "touchstart" && e.cancelable) {
      e.preventDefault();
    }
  });

  $(document).on("mousemove touchmove", function (e) {
    if (!isDragging) return;

    const clientX = e.type === "touchmove" ? e.touches[0].clientX : e.clientX;
    const clientY = e.type === "touchmove" ? e.touches[0].clientY : e.clientY;

    const dx = clientX - startX;
    const dy = clientY - startY;

    // 只有移动超过一定距离才视为拖动，防止手抖
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      hasMoved = true;
    }

    // 更新位置 (使用 fixed 定位的 left/top)
    // 注意：我们要把 bottom/right 清除，改用 left/top 绝对控制
    $btn.css({
      bottom: "auto",
      right: "auto",
      left: initialLeft + dx + "px",
      top: initialTop + dy + "px",
    });

    // 🟢【修改2】防止拖动时页面跟着滚动
    if (e.type === "touchmove" && e.cancelable) {
      e.preventDefault();
    }
  });

  $(document).on("mouseup touchend", function (e) {
    if (!isDragging) return;
    isDragging = false;
    $btn.css({ cursor: "grab", transition: "opacity 0.3s ease" });

    // 🟢【修改3】手机端点击修复：
    // 因为在 touchstart 里用了 preventDefault()，浏览器的原生 click 事件被杀死了。
    // 所以如果手指抬起时没有发生移动 (!hasMoved)，我们需要手动触发 click。
    if (e.type === "touchend" && !hasMoved) {
      $btn.trigger("click");
    }
  });

  // 4. 点击事件 (核心：如果是拖动结束，则不触发同步)
  // (保持你原本的逻辑完全不变)
  $btn.on("click", async function (e) {
    if (hasMoved) {
      // 如果刚刚是拖动，则忽略这次点击
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // --- 执行原有同步逻辑 ---
    const $icon = $(this).find("i");
    $icon.removeClass("fa-cloud-arrow-up").addClass("fa-spinner fa-spin");

    try {
      await triggerManualSync();
    } catch (err) {
      if (window.toastr) toastr.error("同步失败");
      $icon.removeClass("fa-spinner fa-spin").addClass("fa-cloud-arrow-up");
    }
  });
}

// 2. 核心检测逻辑：决定按钮是显示还是隐藏
function updateSyncButtonVisibility() {
  const $btn = $("#anima-floating-sync-btn");
  if (!window.TavernHelper) return;

  // 获取最新消息
  const msgs = window.TavernHelper.getChatMessages("latest");
  if (!msgs || msgs.length === 0) {
    $btn.hide();
    return;
  }

  const lastMsg = msgs[0];

  // 条件：
  // 1. 是 AI 发的消息 (is_user 为 false)
  // 2. 里面没有 anima_data (说明没同步)
  // 3. 排除系统消息或空消息（可选，看你需求）
  const isAi = !lastMsg.is_user;

  // 检查是否有状态数据
  const vars = window.TavernHelper.getVariables({
    type: "message",
    message_id: lastMsg.message_id,
  });
  const hasData =
    vars && vars.anima_data && Object.keys(vars.anima_data).length > 0;

  const updateConfig = currentSettings.update_management || {
    panel_enabled: false,
  };

  // 🔥 核心修正：增加对 panel_enabled 的检查
  if (isAi && !hasData && updateConfig.panel_enabled) {
    // AI 回复了但没状态 -> 显示警告按钮
    $btn
      .css("display", "flex")
      .removeClass("anima-spin-out")
      .addClass("anima-fade-in");
  } else {
    // 有状态，或者用户发的，或者面板被禁用了 -> 隐藏
    $btn.fadeOut(200);
  }
}

/**
 * 简易 HTML 格式化工具 (Beautifier)
 * 用于导入时将压缩的一行代码展开为多行，方便阅读
 */
function simpleFormatHTML(html) {
  if (!html) return "";

  // 1. 预处理：移除多余的空白，标准化标签
  let formatted = "";
  const reg = /(>)(<)(\/*)/g;
  html = html.replace(reg, "$1\r\n$2$3");

  let pad = 0;
  const lines = html.split("\r\n");

  // 2. 逐行处理缩进
  lines.forEach((node) => {
    let indent = 0;
    if (node.match(/.+<\/\w[^>]*>$/)) {
      indent = 0;
    } else if (node.match(/^<\/\w/)) {
      if (pad !== 0) {
        pad -= 1;
      }
    } else if (node.match(/^<\w[^>]*[^\/]>.*$/)) {
      indent = 1;
    } else {
      indent = 0;
    }

    let padding = "";
    for (let i = 0; i < pad; i++) {
      padding += "  "; // 2空格缩进
    }

    formatted += padding + node + "\r\n";
    pad += indent;
  });

  return formatted.trim();
}

/**
 * 递归对比新旧对象，生成带有颜色高亮的 Diff HTML (支持深度展开版)
 */
function generateDiffHtml(oldObj, newObj, indent = 0) {
  let html = "";
  const spaces = "&nbsp;&nbsp;".repeat(indent);

  // 获取所有的 key (取并集)
  const allKeys = new Set([
    ...Object.keys(oldObj || {}),
    ...Object.keys(newObj || {}),
  ]);

  // 格式化输出值的辅助内部函数
  const renderVal = (val) => {
    if (window._.isPlainObject(val))
      return '<span style="color:#888;">{...}</span>';
    if (Array.isArray(val))
      return `<span style="color:#888;">[ ${escapeHtml(val.join(", "))} ]</span>`;
    if (typeof val === "string")
      return `<span style="color:#e2e8f0;">"${escapeHtml(val)}"</span>`;
    return `<span style="color:#60a5fa;">${escapeHtml(String(val))}</span>`;
  };

  allKeys.forEach((key) => {
    const oldVal = (oldObj || {})[key];
    const newVal = (newObj || {})[key];
    const safeKey = escapeHtml(key);

    const isOldObj = window._.isPlainObject(oldVal);
    const isNewObj = window._.isPlainObject(newVal);

    if (oldVal === undefined) {
      // 🟢 新增 (在旧数据中不存在)
      if (isNewObj) {
        // 如果新增的是一个对象，打印标题并递归展开里面的所有属性
        html += `<div style="color: #4ade80;">${spaces}<span style="font-weight:bold;">${safeKey}</span>: <span style="font-size:10px; opacity:0.8;">(+新增对象)</span></div>`;
        html += generateDiffHtml({}, newVal, indent + 1); // 巧妙递归：把旧对象视为空
      } else {
        html += `<div style="color: #4ade80;">${spaces}<span style="font-weight:bold;">${safeKey}</span>: ${renderVal(newVal)} <span style="font-size:10px; opacity:0.8;">(+新增)</span></div>`;
      }
    } else if (newVal === undefined) {
      // 🔴 删除 (在新数据中被干掉了)
      if (isOldObj) {
        // 如果删除的是一个对象，打印标题并递归展开里面被删掉的属性
        html += `<div style="color: #f87171; text-decoration: line-through; opacity: 0.8;">${spaces}<span style="font-weight:bold;">${safeKey}</span>: <span style="font-size:10px; text-decoration: none;">(-删除对象)</span></div>`;
        html += generateDiffHtml(oldVal, {}, indent + 1); // 巧妙递归：把新对象视为空
      } else {
        html += `<div style="color: #f87171; text-decoration: line-through; opacity: 0.8;">${spaces}<span style="font-weight:bold;">${safeKey}</span>: ${renderVal(oldVal)} <span style="font-size:10px; text-decoration: none;">(-删除)</span></div>`;
      }
    } else if (isOldObj && isNewObj) {
      // ⚪ 双方都是对象且都存在，正常向下递归深入
      html += `<div style="color: #ccc;">${spaces}<span style="font-weight:bold;">${safeKey}</span>:</div>`;
      html += generateDiffHtml(oldVal, newVal, indent + 1);
    } else if (!window._.isEqual(oldVal, newVal)) {
      // 🟡 修改 (值发生了变化)
      if (isOldObj || isNewObj) {
        // 数据结构发生突变 (比如原本是个文本，被模型改成了一个对象)
        html += `<div style="color: #fbbf24;">${spaces}<span style="font-weight:bold;">${safeKey}</span>: <span style="font-size:10px; opacity:0.8;">(~类型/结构改变)</span></div>`;
        html += generateDiffHtml(
          isOldObj ? oldVal : { "[旧值]": oldVal },
          isNewObj ? newVal : { "[新值]": newVal },
          indent + 1,
        );
      } else {
        // 正常的文本/数字值修改
        html += `<div style="color: #fbbf24;">${spaces}<span style="font-weight:bold;">${safeKey}</span>: ${renderVal(newVal)} <span style="font-size:10px; opacity:0.8;">(~修改, 原: ${renderVal(oldVal)})</span></div>`;
      }
    } else {
      // ⚪ 无变化 (仅限基本类型和数组，因为 isOldObj && isNewObj 已经被上面拦截了)
      html += `<div style="color: #888;">${spaces}<span style="font-weight:bold;">${safeKey}</span>: ${renderVal(newVal)}</div>`;
    }
  });

  if (html === "") {
    // 防止空对象引起排版诡异
    return indent === 0
      ? `<div style="color: #888; text-align: center;">(状态无任何变化)</div>`
      : `<div style="color: #888;">${spaces}<span style="color:#666;">(空)</span></div>`;
  }
  return html;
}
