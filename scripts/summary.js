import {
  getSummarySettings,
  saveSummaryProgress,
  saveSummarySettings,
  processMessagesWithRegex,
  requestSummaryFromAPI,
  handlePostSummary,
  getLastSummarizedId,
  getLastSummarizedIndex,
  runSummarizationTask,
  MODULE_NAME,
  getIsSummarizing,
} from "./summary_logic.js";
import { processMacros, getContextData } from "./utils.js";
import {
  saveSummaryBatchToWorldbook,
  deleteSummaryItem,
  updateSummaryContent,
  getIndexConflictInfo,
  getPreviousSummaries,
  getSummaryTextFromEntry,
  addSingleSummaryItem,
} from "./worldbook_api.js";
import { insertMemory } from "./rag_logic.js";
import { RegexListComponent, getRegexModalHTML } from "./regex_ui.js";

let regexComponentPre = null;
let regexComponentPost = null;
let currentRegexTarget = "pre";

// ==========================================
// 1. 界面初始化
// ==========================================
/**
 * 🔄 [新增] 专门用于从 Settings 同步开关状态到 UI
 * 供 index.js 在 chat_id_changed 时调用
 */
export function refreshAutomationUI() {
  const settings = getSummarySettings();
  if (!settings) return;

  // 同步自动运行开关
  $("#anima_auto_run").prop("checked", settings.auto_run);

  // 同步其他参数输入框
  $("#anima_trigger_interval").val(settings.trigger_interval);
  $("#anima_hide_skip").val(settings.hide_skip_count);

  // 同步预处理开关
  $("#anima_skip_layer_zero").prop("checked", settings.skip_layer_zero);
  $("#anima_regex_skip_user").prop("checked", settings.regex_skip_user);
  $("#anima_exclude_user").prop("checked", settings.exclude_user);
  $("#anima_group_size").val(settings.group_size || 10); // 如果有这个字段的话

  console.log("[Anima] Automation UI refreshed from settings.");
}

export function initSummarySettings() {
  const container = document.getElementById("tab-summary");
  const settings = getSummarySettings();

  // 1. 数据清洗
  if (settings.regex_strings) {
    settings.regex_strings = settings.regex_strings.map((item) =>
      typeof item === "string" ? { regex: item, type: "extract" } : item,
    );
  } else {
    settings.regex_strings = [];
  }
  if (!settings.output_regex) settings.output_regex = [];

  const styleFix = `
    <style>
        /* === 1. 去掉所有数字输入框的小箭头 (保持不变) === */
        .anima-input::-webkit-outer-spin-button,
        .anima-input::-webkit-inner-spin-button {
            -webkit-appearance: none;
            margin: 0;
        }
        .anima-input[type=number] {
            -moz-appearance: textfield;
        }

        /* === 2. 修复历史记录内容显示 === */
        .anima-history-content {
            /* 基础排版 */
            white-space: pre-wrap !important;
            word-wrap: break-word !important;
            overflow-y: visible !important;
            max-height: none !important;
            height: auto !important;
            
            /* ✨✨✨ 核心修复：移除底部模糊/渐变遮罩 ✨✨✨ */
            mask-image: none !important;
            -webkit-mask-image: none !important;
            -webkit-mask: none !important;
            mask: none !important;
            
            /* 移除可能存在的玻璃模糊滤镜 */
            backdrop-filter: none !important;
            -webkit-backdrop-filter: none !important;
            filter: none !important;
            
            /* 确保完全不透明 */
            opacity: 1 !important;
            
            /* 交互优化 */
            cursor: text !important; 
            user-select: text !important;
        }
    </style>
    `;

  // 2. 更新 HTML 结构
  // 🟢 修复：调整了标题层级，拆分了自动化和手动部分
  container.innerHTML =
    styleFix +
    `
        <div class="anima-setting-group">
            <h2 class="anima-title"><i class="fa-solid fa-robot"></i> 自动化总结</h2>
            <div class="anima-card">
                 ${getAutomationHTML(settings)} 
            </div>
        </div>

        <div class="anima-setting-group">
            <h2 class="anima-title"><i class="fa-solid fa-hand-pointer"></i> 手动总结</h2>
            <div class="anima-card">
                ${getManualHTML(settings)}
            </div>
        </div>

        <div class="anima-setting-group">
            <h2 class="anima-title"><i class="fa-solid fa-filter"></i> 待总结内容预处理</h2>
            <div class="anima-card">
                <div class="anima-flex-row" style="align-items: flex-start;">
                    <div class="anima-label-group">
                        <span class="anima-label-text">正则</span>
                        <span class="anima-desc-inline">
                            在发送给 AI 总结之前对历史记录进行清洗。<br>
                            例如 <code>/&lt;content&gt;(.*?)&lt;\\/content&gt;/gs</code> 会自动剥离标签。
                        </span>
                    </div>
                    <button id="anima_btn_open_regex_modal_pre" class="anima-btn primary small">
                        <i class="fa-solid fa-plus"></i> 添加规则
                    </button>
                </div>
                
                <div id="anima_regex_list_pre" class="anima-regex-list"></div>

                <div class="anima-flex-row">
                    <div class="anima-label-group">
                        <span class="anima-label-text">正则处理跳过开场白</span>
                        <span class="anima-desc-inline">开启后，第 0 层（开场白/设定）将保持原文，不被正则清洗。</span>
                    </div>
                    <label class="anima-switch">
                        <input type="checkbox" id="anima_skip_layer_zero" ${
                          settings.skip_layer_zero ? "checked" : ""
                        }>
                        <span class="slider round"></span>
                    </label>
                </div>

                <div class="anima-flex-row">
                    <div class="anima-label-group">
                        <span class="anima-label-text">正则处理跳过User消息</span>
                        <span class="anima-desc-inline">开启后，User发送的内容将保留原文，不进行正则清洗</span>
                    </div>
                    <label class="anima-switch">
                        <input type="checkbox" id="anima_regex_skip_user" ${settings.regex_skip_user ? "checked" : ""}>
                        <span class="slider round"></span>
                    </label>
                </div>

                <div class="anima-flex-row">
                    <div class="anima-label-group">
                        <span class="anima-label-text">排除 User 消息</span>
                        <span class="anima-desc-inline">开启后，不会发送用户的内容 (避免干扰)</span>
                    </div>
                    <label class="anima-switch">
                        <input type="checkbox" id="anima_exclude_user" ${
                          settings.exclude_user ? "checked" : ""
                        }>
                        <span class="slider round"></span>
                    </label>
                </div>

                <div class="anima-divider"></div>
                
                <div class="anima-prompt-container">
                    <div class="anima-flex-row">
                        <label class="anima-label-text">总结提示词</label>
                        <div style="display: flex; gap: 5px;">
                            <input type="file" id="anima_import_prompt_file" accept=".json" style="display: none;" />
                            
                            <button id="anima-btn-import-prompts" class="anima-btn secondary small" title="导入配置">
                                <i class="fa-solid fa-file-import"></i> 导入
                            </button>
                            <button id="anima-btn-export-prompts" class="anima-btn secondary small" title="导出配置">
                                <i class="fa-solid fa-file-export"></i> 导出
                            </button>
                            <button id="anima-btn-add-msg" class="anima-btn small primary">
                                <i class="fa-solid fa-plus"></i> 添加
                            </button>
                        </div>
                    </div>
                    <div class="anima-desc-inline" style="margin-bottom:5px;">
                        使用 <b>{{context}}</b> 代表经过正则处理后的历史记录。
                    </div>
                    <div id="anima_prompt_list" class="anima-regex-list" style="min-height: 100px; padding: 5px;"></div>
                </div>

                <div class="anima-btn-group">
                    <button id="anima-btn-save-preprocess" class="anima-btn primary" style="flex:1;">
                        <i class="fa-solid fa-floppy-disk"></i> 保存配置
                    </button>
                </div>
            </div>
        </div>
        
        <div class="anima-setting-group">
            <h2 class="anima-title"><i class="fa-solid fa-database"></i> 存储配置</h2>
            <div class="anima-card">
                <div class="anima-flex-row" style="align-items: center;">
                    <div class="anima-label-group">
                        <span class="anima-label-text">结果后处理正则</span>
                        <span class="anima-desc-inline">仅适用于纯文本结果，对总结内容进行二次清洗。</span>
                    </div>
                    <button id="anima_btn_open_regex_modal_post" class="anima-btn primary small">
                        <i class="fa-solid fa-plus"></i> 添加规则
                    </button>
                </div>
                
                <div id="anima_regex_list_post" class="anima-regex-list"></div>
                <div style="margin-top:15px; text-align:right;">
                    <button id="anima-btn-save" class="anima-btn primary" style="width:100%"><i class="fa-solid fa-floppy-disk"></i> 保存配置</button>
                </div>
            </div>
        </div>

        ${getRegexModalHTML()}
        <div id="anima-summary-modal" class="anima-modal hidden">
             <div class="anima-modal-content">
                <div class="anima-modal-header">
                    <h3 id="anima-modal-title">预览</h3>
                    <span class="anima-close-modal">&times;</span>
                </div>
                <div id="anima-modal-body" class="anima-modal-body"></div>
             </div>
        </div>

        <div id="anima-add-summary-modal" class="anima-modal hidden" style="z-index: 99999 !important;">
            <div class="anima-modal-content" style="max-width: 500px; z-index: 100000 !important;">
                <div class="anima-modal-header">
                    <h3><i class="fa-solid fa-plus"></i> 新增总结记录</h3>
                </div>
                <div class="anima-modal-body">
                    <div class="anima-flex-row" style="margin-bottom: 10px;">
                        <div class="anima-label-group">
                            <span class="anima-label-text">序号 (必填)</span>
                            <span class="anima-desc-inline">请使用 Batch_Slice 格式，例如: 1_3</span>
                        </div>
                        <input type="text" id="anima_add_summary_index" class="anima-input" placeholder="例: 1_3" style="width: 120px;">
                    </div>
                    
                    <div class="anima-flex-row" style="margin-bottom: 10px; flex-direction: column; align-items: flex-start;">
                        <div class="anima-label-group" style="margin-bottom: 5px;">
                            <span class="anima-label-text">内容 (必填)</span>
                        </div>
                        <textarea id="anima_add_summary_content" class="anima-textarea" rows="6" style="width: 100%; resize: vertical; padding: 10px;" placeholder="输入总结内容..."></textarea>
                    </div>

                    <div class="anima-flex-row" style="margin-bottom: 15px;">
                        <div class="anima-label-group">
                            <span class="anima-label-text">标签 (选填)</span>
                            <span class="anima-desc-inline">多个标签请用英文逗号 (,) 分隔</span>
                        </div>
                        <input type="text" id="anima_add_summary_tags" class="anima-input" placeholder="tag1, tag2" style="flex: 1;">
                    </div>

                    <div class="anima-btn-group" style="justify-content: flex-end; gap: 10px; margin-top: 15px;">
                        <button id="anima-btn-cancel-add" class="anima-btn secondary">取消</button>
                        <button id="anima-btn-confirm-add" class="anima-btn primary"><i class="fa-solid fa-check"></i> 确认</button>
                    </div>
                </div>
            </div>
        </div>
    `;
  regexComponentPre = new RegexListComponent(
    "anima_regex_list_pre", // 容器ID
    () => settings.regex_strings, // 获取数据的函数
    (newData) => {
      // 保存数据的回调
      settings.regex_strings = newData;
    },
  );
  regexComponentPre.render();

  // 🟢 [新增] 实例化组件 (Post - 后处理)
  regexComponentPost = new RegexListComponent(
    "anima_regex_list_post",
    () => settings.output_regex,
    (newData) => {
      settings.output_regex = newData;
    },
  );
  regexComponentPost.render();

  // 自动填充
  try {
    if (window.TavernHelper) {
      const msgs = window.TavernHelper.getChatMessages(-1);
      if (msgs && msgs.length) {
        const end = msgs[0].message_id;
        const start = Math.max(0, end - settings.trigger_interval);
        $("#anima_manual_start").val(start);
        $("#anima_manual_end").val(end);
      }
    }
  } catch (e) {}

  bindSummaryEvents();
  updateStatusInputs();
}

/**
 * 🔄 专门用于刷新自动化策略面板中的 "当前进度" 显示
 * 读取最新的 metadata 并写入 input 框
 */
export function updateStatusInputs() {
  const currentId = getLastSummarizedId();
  const currentIndex = getLastSummarizedIndex();

  // 如果是 -1，显示为 0，避免用户困惑
  const displayId = currentId;

  // 只有当元素存在时才赋值 (防止报错)
  const $idInput = $("#in_meta_id");
  const $idxInput = $("#in_meta_idx");

  if ($idInput.length) $idInput.val(displayId);
  if ($idxInput.length) $idxInput.val(currentIndex);

  // 调试日志：看看是谁在调用刷新，以及刷新成了什么
  console.log(
    `[Anima UI] Refreshed Status: ID=${displayId}, Index=${currentIndex}`,
  );
}

function getAutomationHTML(settings) {
  // 获取当前状态
  const currentId = getLastSummarizedId();
  const currentIndex = getLastSummarizedIndex();

  // 显示处理
  const displayId = currentId;

  return `
    <div class="anima-flex-row" style="align-items: center; justify-content: space-between; min-height: 40px;">
        <div class="anima-label-group" style="flex: 0 0 auto;">
            <span class="anima-label-text">当前进度</span>
        </div>
        
        <div style="display: flex; align-items: center; gap: 10px; flex: 1; justify-content: flex-end;">
            
            <div style="display: flex; align-items: center; gap: 0; background: rgba(0, 0, 0, 0.15); padding: 0 8px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.05); height: 28px;">
                <span style="font-size: 12px; color: #aaa; white-space: nowrap; line-height: 28px;">总结至</span>
                <input type="number" id="in_meta_id" class="anima-input no-spin"
                       style="width: 40px; text-align: center; border: none; background: transparent; font-family: monospace; font-weight: bold; height: 28px; line-height: 28px; margin: 0; padding: 0; font-size: 12px; color: #fff;"
                       value="${displayId}" disabled>

                <div style="width: 1px; height: 12px; background: #555; margin: 0 4px;"></div>

                <span style="font-size: 12px; color: #aaa; white-space: nowrap; line-height: 28px;">序号</span>
                <input type="number" id="in_meta_idx" class="anima-input no-spin"
                       style="width: 30px; text-align: center; border: none; background: transparent; font-family: monospace; font-weight: bold; height: 28px; line-height: 28px; margin: 0; padding: 0; font-size: 12px; color: #fff;"
                       value="${currentIndex}" disabled>
            </div>

            <div id="anima_meta_btn_group" style="width: 65px; display: flex; justify-content: center; align-items: center;">
                
                <button id="btn_edit_meta" class="anima-btn secondary small" title="修改指针" style="height: 28px; width: 28px; padding: 0; border-radius: 4px;">
                    <i class="fa-solid fa-pen" style="font-size: 12px;"></i>
                </button>
                
                <div id="meta_edit_actions" style="display: none; gap: 5px;">
                    <button id="btn_save_meta" class="anima-btn primary small" title="保存" style="height: 28px; width: 28px; padding: 0; border-radius: 4px;">
                        <i class="fa-solid fa-check" style="font-size: 12px;"></i>
                    </button>
                    <button id="btn_cancel_meta" class="anima-btn danger small" title="取消" style="height: 28px; width: 28px; padding: 0; border-radius: 4px;">
                        <i class="fa-solid fa-xmark" style="font-size: 12px;"></i>
                    </button>
                </div>

            </div>
        </div>
    </div>
    
    <div class="anima-desc-inline" style="margin-top: 5px; margin-bottom: 10px; text-align: right; font-size: 11px; opacity: 0.7;">
        修改此处可重置插件记忆进度 (谨慎操作)
    </div>

    <div class="anima-flex-row">
        <div class="anima-label-group">
            <span class="anima-label-text">触发间隔</span>
            <span class="anima-desc-inline">每 N 楼执行一次</span>
        </div>
        <div class="anima-input-wrapper">
            <input type="number" id="anima_trigger_interval" class="anima-input" min="5" value="${settings.trigger_interval}">
        </div>
    </div>
    <div class="anima-flex-row">
        <div class="anima-label-group">
            <span class="anima-label-text">隐藏保留</span>
            <span class="anima-desc-inline">总结后保留最后 N 楼不隐藏</span>
        </div>
        <div class="anima-input-wrapper">
            <input type="number" id="anima_hide_skip" class="anima-input" min="0" value="${settings.hide_skip_count}">
        </div>
    </div>
    <div class="anima-flex-row">
        <div class="anima-label-group">
            <span class="anima-label-text">后台自动运行</span>
        </div>
        <label class="anima-switch">
            <input type="checkbox" id="anima_auto_run" ${settings.auto_run ? "checked" : ""}>
            <span class="slider round"></span>
        </label>
    </div>
    
    <div class="anima-btn-group">
        <button id="anima-btn-save-automation" class="anima-btn primary" style="flex:1;">
            <i class="fa-solid fa-floppy-disk"></i> 保存配置
        </button>
        <button id="anima-btn-simulate-trigger" class="anima-btn secondary" style="flex:1;">
            <i class="fa-solid fa-bug"></i> 模拟触发
        </button>
    </div>`;
}

// 🟢 新增：提取出手动部分的 HTML
function getManualHTML(settings) {
  return `
    <div class="anima-manual-grid" style="grid-template-columns: 1fr 1fr 1fr;">
        <div class="anima-manual-input-group">
            <label>起始楼层</label>
            <input type="number" id="anima_manual_start" class="anima-input">
        </div>
        <div class="anima-manual-input-group">
            <label>终点楼层</label>
            <input type="number" id="anima_manual_end" class="anima-input">
        </div>
        <div class="anima-manual-input-group">
            <label>目标序号</label>
            <input type="number" id="anima_manual_index" class="anima-input" placeholder="自动">
        </div>
    </div>
    
    <div class="anima-desc-inline" style="margin-bottom:10px;">
        如果不填序号，将尝试自动计算 (基于上一条记录 + 1)。
    </div>

    <div class="anima-btn-group">
        <button id="anima-btn-manual-run" class="anima-btn primary" style="flex:1;">
            <i class="fa-solid fa-play"></i> 执行总结
        </button>
        <button id="anima-btn-manual-preview" class="anima-btn secondary" style="flex:1;">
            <i class="fa-solid fa-eye"></i> 预览范围
        </button>
    </div>
    <div style="margin-top: 10px;">
        <button id="anima-btn-view-history" class="anima-btn secondary" style="width:100%;">
            <i class="fa-solid fa-list-ul"></i> 历史总结管理
        </button>
    </div>`;
}

// ==========================================
// 4. 事件绑定
// ==========================================
function bindSummaryEvents() {
  function renderPromptList() {
    const settings = getSummarySettings();
    const listEl = $("#anima_prompt_list");
    listEl.empty();

    settings.summary_messages.forEach((msg, idx) => {
      let $item = null;

      // === 1. 角色卡信息 & 用户信息 (保持不变) ===
      if (msg.type === "char_info" || msg.type === "user_info") {
        const isChar = msg.type === "char_info";
        const title = isChar ? "👾 角色卡信息" : "👩🏻 用户设定";
        // 角色卡使用紫色，用户设定使用粉色
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

        // 绑定开关事件
        $item.find(".special-toggle").on("change", function () {
          settings.summary_messages[idx].enabled = $(this).prop("checked");
        });
      } else if (msg.type === "prev_summaries") {
        const colorHex = "#22c55e"; // 绿色
        const bgColor = "rgba(34, 197, 94, 0.1)";
        $item = $(`
            <div class="anima-regex-item anima-special-item" data-idx="${idx}" data-type="prev_summaries" 
                 style="border-color: ${colorHex}; height: 44px; display: flex; align-items: center; padding: 0 10px; box-sizing: border-box; background: ${bgColor};">
                <div style="display: flex; align-items: center; gap:10px; width: 100%; height: 100%;">
                    <i class="fa-solid fa-bars anima-drag-handle" title="拖动排序" style="cursor:grab; margin: 0; display:flex; align-items:center;"></i>
                    <span style="font-weight:bold; font-size:13px; color:${colorHex}; display:flex; align-items:center; gap:5px; line-height: 1;">
                        <i class="fa-solid fa-clock-rotate-left"></i> 插入前文总结
                    </span>
                    
                    <div style="margin-left:auto; display:flex; align-items:center; gap:5px; height: 100%;">
                        <span style="font-size:12px; color:#aaa;">数量:</span>
                        <input type="number" class="prev-count-input anima-input" 
                               style="width: 50px; height: 24px; padding: 0 5px; text-align: center; margin: 0; box-sizing: border-box;" 
                               min="0" placeholder="0" value="${msg.count || 0}" title="设为 0 则不插入。设为 N 则插入最近的 N 条总结作为参考。">
                    </div>
                </div>
            </div>
        `);

        // 绑定数字变化事件
        $item.find(".prev-count-input").on("change", function () {
          let val = parseInt($(this).val());
          if (val < 0) val = 0;
          settings.summary_messages[idx].count = val;
        });
      }
      // === 2. 历史记录占位符 ({{context}}) ===
      else if (msg.content === "{{context}}") {
        const colorHex = "#3b82f6"; // 蓝色
        const bgColor = "rgba(59, 130, 246, 0.1)";
        $item = $(`
            <div class="anima-regex-item anima-context-item" data-idx="${idx}" data-type="context" 
                 style="border-color: ${colorHex}; border-style: solid !important; height: 44px; display: flex; align-items: center; padding: 0 10px; box-sizing: border-box; background: ${bgColor};">
                <div style="display: flex; align-items: center; gap:10px; width: 100%; height: 100%;">
                    <i class="fa-solid fa-bars anima-drag-handle" title="拖动排序" style="cursor:grab; margin: 0; display:flex; align-items:center;"></i>
                    <span style="font-weight:bold; font-size:13px; color:${colorHex}; display:flex; align-items:center; gap:5px; line-height: 1;">
                        <i class="fa-solid fa-book-open"></i> 待总结内容
                    </span>
                    
                    <div style="margin-left:auto; opacity: 0.5;">
                         <i class="fa-solid fa-lock" title="核心条目" style="color:${colorHex};"></i>
                    </div>
                </div>
            </div>
        `);
      }

      // === 3. 普通文本条目 (CSS优化 & 标题修复版) ===
      else {
        // 读取 title，防止 undefined
        const currentTitle = msg.title || "";
        // 仅用于显示的标题
        const displayTitleHtml = currentTitle
          ? escapeHtml(currentTitle)
          : '<span style="color:#666; font-weight:normal; font-style:normal; font-size:12px;">(未命名条目)</span>';

        const displayRole = msg.role ? msg.role.toUpperCase() : "SYSTEM";

        $item = $(`
            <div class="anima-regex-item" data-idx="${idx}" data-type="normal">
                
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; height: 32px;">
                    
                    <div class="view-mode" style="display:flex; align-items:center; gap:8px; width:100%; height:100%;">
                        <i class="fa-solid fa-bars anima-drag-handle" title="按住拖动排序" style="cursor:grab; color:#888;"></i>
                        
                        <span class="anima-tag secondary" style="font-family:monospace; min-width:70px; text-align:center; height:24px; line-height:24px; font-size:12px; padding:0; display:inline-block;">${displayRole}</span>
                        
                        <span class="view-title-text" style="font-weight:bold; color:#ddd; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; cursor:text; line-height: 32px;">
                            ${displayTitleHtml}
                        </span>

                        <div style="display:flex; gap:5px; align-items:center;">
                            <button class="anima-btn secondary small btn-edit" title="编辑" style="height:28px; width:28px; padding:0; display:flex; align-items:center; justify-content:center;"><i class="fa-solid fa-pen" style="font-size:12px;"></i></button>
                            <button class="anima-btn danger small btn-delete" title="删除" style="height:28px; width:28px; padding:0; display:flex; align-items:center; justify-content:center;"><i class="fa-solid fa-trash" style="font-size:12px;"></i></button>
                        </div>
                    </div>

                    <div class="edit-mode" style="display:none; align-items:center; gap:8px; width:100%; height:100%;">
                        <i class="fa-solid fa-bars" style="opacity:0.3; cursor:not-allowed;"></i>
                        
                        <select class="anima-select role-select" style="width:auto; padding:0 25px 0 10px; height:30px; line-height:30px; font-size:13px; margin:0; box-sizing:border-box;">
                            <option value="system" ${msg.role === "system" ? "selected" : ""}>SYSTEM</option>
                            <option value="user" ${msg.role === "user" ? "selected" : ""}>USER</option>
                            <option value="assistant" ${msg.role === "assistant" ? "selected" : ""}>ASSISTANT</option>
                        </select>

                        <input type="text" class="anima-input title-input" 
                               value="${escapeHtml(currentTitle)}" 
                               placeholder="输入条目名称..." 
                               style="flex:1; height:30px; box-sizing:border-box; margin:0; vertical-align:middle;">

                        <div style="display:flex; gap:5px; margin-left: 2px; align-items:center;">
                            <button class="anima-btn primary small btn-confirm" style="height:30px; width:30px; padding:0; display:flex; align-items:center; justify-content:center; margin:0;" title="确认修改"><i class="fa-solid fa-check"></i></button>
                            <button class="anima-btn danger small btn-cancel" style="height:30px; width:30px; padding:0; display:flex; align-items:center; justify-content:center; margin:0;" title="取消"><i class="fa-solid fa-xmark"></i></button>
                        </div>
                    </div>

                </div>

                <textarea class="anima-textarea content-input" rows="2" disabled
                          style="width:100%; resize:vertical; opacity: 1; color: #ffffff; cursor: default; font-size:13px; line-height:1.4;">${escapeHtml(msg.content)}</textarea>
            </div>
        `);

        const $viewMode = $item.find(".view-mode");
        const $editMode = $item.find(".edit-mode");
        const $textarea = $item.find(".content-input");

        // 删除
        $item.find(".btn-delete").on("click", function () {
          if (confirm("确定删除此条目吗？")) {
            settings.summary_messages.splice(idx, 1);
            renderPromptList();
          }
        });

        // 进入编辑
        const enterEditMode = () => {
          $viewMode.hide();
          $editMode.css("display", "flex");
          $textarea.prop("disabled", false).css({
            opacity: "1",
            cursor: "text",
            "border-color": "var(--anima-primary)",
          });
        };
        $item.find(".btn-edit").on("click", enterEditMode);
        $item.find(".view-title-text").on("click", enterEditMode); // 点击文字也能编辑

        // 取消
        $item.find(".btn-cancel").on("click", function () {
          renderPromptList(); // 重新渲染恢复原状
        });

        // 确认保存
        $item.find(".btn-confirm").on("click", function () {
          const newRole = $item.find(".role-select").val();
          const newTitle = $item.find(".title-input").val().trim();
          const newContent = $textarea.val();

          // 更新内存
          settings.summary_messages[idx].role = newRole;
          settings.summary_messages[idx].title = newTitle;
          settings.summary_messages[idx].content = newContent;

          renderPromptList();
        });
      }

      // ✅ 统一在这里将生成的元素添加到列表中
      // (这是之前代码遗漏的关键步骤)
      if ($item) {
        listEl.append($item);
      }
    });

    // ... 拖拽排序部分保持不变 ...
    listEl.sortable({
      handle: ".anima-drag-handle",
      placeholder: "ui-state-highlight",
      opacity: 0.8,
      tolerance: "pointer", // [可选建议] 让鼠标指针碰到占位符就算有效，体验更好
      stop: function (event, ui) {
        // 🟢 修复：使用 setTimeout 0 将逻辑推迟到当前调用栈清空后执行
        setTimeout(() => {
          const newMessages = [];

          // 遍历当前的 DOM 顺序来重组数组
          listEl.children().each(function () {
            const $el = $(this);
            const oldIdx = $el.data("idx"); // 获取这个元素原来的索引
            const type = $el.data("type");

            // 从旧的设置中获取原始数据对象
            const originalMsg = settings.summary_messages[oldIdx];

            // 如果原始数据丢失（极其罕见），跳过以防报错
            if (!originalMsg) return;

            // 根据类型决定如何重建数据
            if (
              type === "char_info" ||
              type === "user_info" ||
              type === "context" ||
              type === "prev_summaries"
            ) {
              newMessages.push(originalMsg);
            } else {
              // 普通文本条目：读取最新输入值
              const role = $el.find(".role-select").val() || originalMsg.role;
              const content = $el.find(".content-input").val();
              const title = $el.find(".title-input").val() || originalMsg.title;

              newMessages.push({
                role: role,
                content:
                  content !== undefined ? content : originalMsg.content || "",
                title: title,
              });
            }
          });

          // 更新内存中的设置
          settings.summary_messages = newMessages;

          // 🟢 重要提示：如果 getSummarySettings 返回的是对象副本而不是引用，
          // 你必须在这里取消注释 saveSummarySettings，否则重绘后列表会弹回原样！
          saveSummarySettings(settings);

          // 重新渲染列表以更新 data-idx
          renderPromptList();
        }, 0);
      },
    });

    listEl.find("textarea, select").on("mousedown", function (e) {
      e.stopPropagation();
    });
  }

  renderPromptList();
  $("#anima-btn-add-msg").on("click", () => {
    const settings = getSummarySettings();
    settings.summary_messages.unshift({
      role: "system",
      title: "新规则",
      content: "",
    });
    renderPromptList();
  });

  $("#anima-btn-export-prompts").on("click", () => {
    try {
      const settings = getSummarySettings();
      const dataStr = JSON.stringify(settings.summary_messages, null, 4);
      const blob = new Blob([dataStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      const timestamp = new Date()
        .toISOString()
        .replace(/[-:.]/g, "")
        .slice(0, 14);
      a.download = `anima_summary_prompts_${timestamp}.json`;
      document.body.appendChild(a);
      a.click();

      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (window.toastr) toastr.success("提示词导出成功");
    } catch (e) {
      console.error(e);
      if (window.toastr) toastr.error("导出失败: " + e.message);
    }
  });

  $("#anima-btn-import-prompts").on("click", () => {
    $("#anima_import_prompt_file").click();
  });

  // 2. 监听文件选择变化
  $("#anima_import_prompt_file").on("change", function (e) {
    // TS 修复：进行类型断言或检查，确保 e.target 存在
    const target = e.target; // 或者 e.target as HTMLInputElement
    if (!target.files || !target.files[0]) return;

    const file = target.files[0];
    const reader = new FileReader();

    reader.onload = (ev) => {
      try {
        const result = ev.target.result;

        // 🛑 修复问题 1 (TS报错): 明确检查类型
        if (typeof result !== "string") {
          return;
        }

        const json = JSON.parse(result);

        if (Array.isArray(json)) {
          if (
            confirm("确定要导入该文件吗？这将覆盖当前所有的总结提示词配置。")
          ) {
            // 获取当前配置副本
            const settings = getSummarySettings();
            // 修改副本中的提示词
            settings.summary_messages = json;

            // 🛑 修复问题 2 (无变化):
            // 必须调用 saveSummarySettings 将修改后的副本写回系统内存/硬盘
            // 否则 renderPromptList 重新拉取时还是旧数据
            saveSummarySettings(settings);

            // 现在重新拉取并渲染，就是新的了
            renderPromptList();

            if (window.toastr) toastr.success("提示词导入成功");
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

  // 保存配置
  $("#anima-btn-save").on("click", () => {
    const newSettings = {
      trigger_interval: parseInt($("#anima_trigger_interval").val()) || 30,
      hide_skip_count: parseInt($("#anima_hide_skip").val()) || 5,
      auto_run: $("#anima_auto_run").prop("checked"),
      exclude_user: $("#anima_exclude_user").prop("checked"),
      regex_skip_user: $("#anima_regex_skip_user").prop("checked"),
      skip_layer_zero: $("#anima_skip_layer_zero").prop("checked"),
      regex_strings: regexComponentPre
        ? regexComponentPre.getData()
        : getSummarySettings().regex_strings,
      summary_messages: getSummarySettings().summary_messages, // 这个还没重构，保持原样
      output_regex: regexComponentPost
        ? regexComponentPost.getData()
        : getSummarySettings().output_regex || [],
      wrapper_template: $("#anima_wrapper_template").val(),
      group_size: parseInt($("#anima_group_size").val()) || 10,
    };
    saveSummarySettings(newSettings);
    if (window.toastr) toastr.success("配置已保存到系统设置");
    if (newSettings.auto_run) {
      console.log("[Anima] Auto-Run enabled. Triggering check...");
      runSummarizationTask({ force: false });
    }
  });

  // 1. 新增：内容处理部分的“保存配置”按钮
  $("#anima-btn-save-preprocess").on("click", () => {
    // 直接触发底部的保存按钮逻辑，避免重复代码
    $("#anima-btn-save").click();
  });

  $("#anima-btn-save-automation").on("click", () => {
    // 1. 原有的保存逻辑 (通过点击通用保存按钮实现)
    $("#anima-btn-save").click();

    // ✨✨✨ 新增：保存后立即尝试触发一次任务 ✨✨✨
    const settings = getSummarySettings(); // 获取最新设置
    if (settings.auto_run) {
      console.log(
        "[Anima] Settings saved with Auto-Run ON. Triggering immediate check...",
      );

      // 调用任务函数 (确保顶部 import 了 runSummarizationTask)
      // 这里的 force: false 意味着它会遵循所有的自动化检查逻辑 (间隔、Role判断等)
      runSummarizationTask({ force: false });
    }
  });

  $("#anima-btn-view-history").on("click", () => {
    // === 新增：检查聊天是否加载 ===
    const context = SillyTavern.getContext();
    if (!context.chatId) {
      toastr.warning("请先打开一个聊天窗口以查看历史记录。");
      return;
    }
    showSummaryHistoryModal();
  });

  // 手动执行
  $("#anima-btn-manual-run").on("click", () => {
    const start = parseInt($("#anima_manual_start").val());
    const end = parseInt($("#anima_manual_end").val());
    // ✅ 获取用户输入的 index
    const idxInput = $("#anima_manual_index").val();
    const idx = idxInput ? parseInt(idxInput) : null;

    if (isNaN(start) || isNaN(end)) {
      toastr.warning("请填写起始和终点楼层");
      return;
    }

    runSummarizationTask({
      force: true,
      customRange: { start, end },
      manualIndex: idx,
    });
  });

  $(".anima-close-modal").on("click", () =>
    $("#anima-summary-modal").addClass("hidden"),
  );

  $("#anima_btn_open_regex_modal_pre").on("click", () => {
    currentRegexTarget = "pre";
    openRegexModal();
  });
  $("#anima_btn_open_regex_modal_post").on("click", () => {
    currentRegexTarget = "post";
    openRegexModal();
  });

  // === 新增：手动添加总结模态框事件 ===
  // 1. 关闭模态框
  $(".anima-close-add-modal, #anima-btn-cancel-add").on("click", () => {
    $("#anima-add-summary-modal").addClass("hidden");
    // $("#anima-summary-modal").css("opacity", "1"); // 恢复透明度
  });

  // 2. 确认按钮 (UI层的基础校验，逻辑预留)
  $("#anima-btn-confirm-add").on("click", async () => {
    const indexStr = $("#anima_add_summary_index").val().trim();
    const contentStr = $("#anima_add_summary_content").val().trim();
    const tagsStr = $("#anima_add_summary_tags").val().trim();

    if (!indexStr || !/^\d+_\d+$/.test(indexStr) || !contentStr) {
      toastr.warning("请确保格式正确且内容不为空！");
      return;
    }

    const [batchIdStr, sliceIdStr] = indexStr.split("_");
    const batchId = parseInt(batchIdStr);
    const sliceId = parseInt(sliceIdStr);
    const tagsArray = tagsStr
      ? tagsStr
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter((t) => t)
      : [];

    // 禁用按钮防连点
    const $btn = $("#anima-btn-confirm-add");
    $btn
      .prop("disabled", true)
      .html('<i class="fa-solid fa-spinner fa-spin"></i> 处理中...');

    try {
      // 1. 查重拦截
      const conflictInfo = await getIndexConflictInfo(indexStr);
      if (conflictInfo && conflictInfo.exists) {
        toastr.error(
          `序号 ${indexStr} 已存在于 [${conflictInfo.entryName}] 中，请更换序号！`,
        );
        $btn
          .prop("disabled", false)
          .html('<i class="fa-solid fa-check"></i> 确认');
        return;
      }

      // 2. 获取当前的 group_size 配置用于计算 Chapter
      const settings = getSummarySettings();
      const groupSize = settings.group_size || 10;

      // 3. 写入世界书并触发向量化
      await addSingleSummaryItem(
        indexStr,
        batchId,
        sliceId,
        contentStr,
        tagsArray,
        groupSize,
      );

      toastr.success(`记录 #${indexStr} 已保存，正在后台同步向量！`);

      // 4. 关闭弹窗并刷新列表
      $("#anima-add-summary-modal").addClass("hidden");

      // 触发上一层的模态框刷新
      showSummaryHistoryModal();
    } catch (e) {
      console.error(e);
      toastr.error("保存失败: " + e.message);
    } finally {
      $btn
        .prop("disabled", false)
        .html('<i class="fa-solid fa-check"></i> 确认');
    }
  });

  // === 模态框确定 ===
  $("#anima_btn_confirm_add_regex").on("click", () => {
    const type = $("#anima_new_regex_type").val();
    const str = $("#anima_new_regex_str").val().trim();
    if (!str) return toastr.warning("正则不能为空");
    if (currentRegexTarget === "pre") {
      if (regexComponentPre) regexComponentPre.addRule(str, type);
    } else {
      if (regexComponentPost) regexComponentPost.addRule(str, type);
    }
    $("#anima-regex-input-modal").addClass("hidden");
  });

  // === 关闭模态框 ===
  $(".anima-close-regex-modal").on("click", () => {
    $("#anima-regex-input-modal").addClass("hidden");
  });
  // 🟢 2. 绑定新按钮：手动预览
  $("#anima-btn-manual-preview").on("click", () => {
    const start = parseInt($("#anima_manual_start").val());
    const end = parseInt($("#anima_manual_end").val());
    let idx = parseInt($("#anima_manual_index").val());

    if (isNaN(start) || isNaN(end)) {
      toastr.warning("请填写起始和终点楼层");
      return;
    }
    // 如果没填 Index，模拟计算
    if (isNaN(idx)) idx = getLastSummarizedIndex() + 1;

    previewSummary(start, end, idx, "手动总结预览");
  });

  // 🟢 3. 绑定新按钮：模拟自动触发
  // 🟢 3. 绑定新按钮：模拟自动触发 (修复版)
  $("#anima-btn-simulate-trigger").on("click", () => {
    // 🔒 1. 检查是否正在运行
    if (getIsSummarizing()) {
      toastr.warning("自动化总结正在运行中，请稍后再试...");
      return;
    }

    try {
      const lastId = getLastSummarizedId();
      const lastIdx = getLastSummarizedIndex();
      const settings = getSummarySettings();

      // 2. 获取当前最大楼层 (绝对安全的方式)
      let maxMsgId = 0;
      let hasMsgs = false;
      try {
        // 获取最新的一条消息来确定 ID
        const msgs = window.TavernHelper.getChatMessages(-1);
        if (msgs && msgs.length > 0) {
          maxMsgId = msgs[0].message_id;
          hasMsgs = true;
        }
      } catch (e) {
        console.error("获取消息失败", e);
      }

      if (!hasMsgs) {
        toastr.warning("当前没有聊天记录，无法模拟。");
        return;
      }

      // 3. 计算理论范围
      const start = lastId + 1;
      const targetEnd = lastId + settings.trigger_interval; // 理论终点 (119)
      const idx = lastIdx + 1;

      // 4. ✨✨✨ 核心修复：计算实际安全的预览终点 ✨✨✨
      // 如果 targetEnd (119) > maxMsgId (94)，则强制截断为 94
      const safeEnd = Math.min(targetEnd, maxMsgId);

      console.log(
        `[Anima Simulation] Theory: ${start}-${targetEnd}, Safe: ${start}-${safeEnd}, Max: ${maxMsgId}`,
      );

      // 5. 构建弹窗标题
      let title = `模拟触发 (#${idx})`;

      // 情况 A: 已经完全追上 (Start 95 > Max 94)
      if (start > maxMsgId) {
        toastr.info(
          `无需总结 (进度 #${lastIdx} 已覆盖至 ${lastId}，最新楼层 ${maxMsgId})`,
        );
        return;
      }

      // 情况 B: 楼层不足，触发了截断
      if (safeEnd < targetEnd) {
        // 此时 safeEnd 就是 94
        title += ` (⚠️ 预览: ${start}-${safeEnd} / 目标 ${targetEnd})`;
      } else {
        title += ` (✅ 完整范围)`;
      }

      // 6. 调用预览 (使用 safeEnd，确保不报错)
      // SillyTavern 只要传入存在的范围 (90-94) 就不会报错
      previewSummary(start, safeEnd, idx, title);
    } catch (err) {
      console.error("[Anima Simulation Error]", err);
      toastr.error("模拟失败: " + err.message);
    }
  });

  // 1. 点击“编辑”按钮
  $("#btn_edit_meta").on("click", () => {
    // 解锁输入框
    $("#in_meta_id")
      .prop("disabled", false)
      .css("background", "rgba(0,0,0,0.3)")
      .focus();
    $("#in_meta_idx")
      .prop("disabled", false)
      .css("background", "rgba(0,0,0,0.3)");

    // 切换按钮显示：隐藏编辑按钮，显示操作组
    $("#btn_edit_meta").hide();
    $("#meta_edit_actions").css("display", "flex"); // 使用 flex 布局让它们横向排列
  });

  // 2. 点击“取消”按钮
  $("#btn_cancel_meta").on("click", () => {
    updateStatusInputs();

    // 锁定输入框 & 恢复透明背景
    $("#in_meta_id").prop("disabled", true).css("background", "transparent");
    $("#in_meta_idx").prop("disabled", true).css("background", "transparent");

    // 切换按钮显示
    $("#meta_edit_actions").hide();
    $("#btn_edit_meta").show();
  });

  // 3. 点击“保存”按钮
  $("#btn_save_meta").on("click", async () => {
    const newId = parseInt($("#in_meta_id").val());
    const newIdx = parseInt($("#in_meta_idx").val());

    if (isNaN(newId) || isNaN(newIdx)) {
      toastr.warning("请输入有效的数字");
      return;
    }

    try {
      await saveSummaryProgress(newId, newIdx);

      // 锁定输入框 & 恢复透明背景
      $("#in_meta_id").prop("disabled", true).css("background", "transparent");
      $("#in_meta_idx").prop("disabled", true).css("background", "transparent");

      // 切换按钮显示
      $("#meta_edit_actions").hide();
      $("#btn_edit_meta").show();

      toastr.success(`指针已更新: ID=${newId}, Index=${newIdx}`);
      updateStatusInputs();
    } catch (e) {
      console.error(e);
      toastr.error("保存失败");
    }
  });

  document.addEventListener("anima_progress_updated", () => {
    // 只有当插件设置面板存在时才执行刷新，避免不必要的 DOM 操作
    if (document.getElementById("in_meta_id")) {
      console.log("[Anima UI] Received update signal. Refreshing inputs...");
      updateStatusInputs();
    }
  });
}

function openRegexModal() {
  $("#anima_new_regex_str").val("");
  $("#anima_new_regex_type").val("extract");
  $("#anima-regex-input-modal").removeClass("hidden");
}

// ==========================================
// 5. 核心逻辑
// ==========================================

function showModal(title, html) {
  $("#anima-modal-title").text(title);
  $("#anima-modal-body").html(html);
  $("#anima-summary-modal").removeClass("hidden");
}

function escapeHtml(text) {
  if (!text) return text;
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ==========================================
// 6. 历史记录管理 (History Management)
// ==========================================

let cachedHistoryData = [];
let currentHistoryPage = 1;
const PAGE_SIZE = 20;

async function showSummaryHistoryModal() {
  if (!window.TavernHelper) return;

  const wbName = await window.TavernHelper.getChatWorldbookName("current");
  if (!wbName) {
    toastr.warning("当前聊天没有绑定世界书，暂无总结存档。");
    return;
  }
  const currentChatId = SillyTavern.getContext().chatId;
  const entries = await window.TavernHelper.getWorldbook(wbName);
  const animaEntries = entries.filter(
    (e) =>
      e.extra &&
      e.extra.createdBy === "anima_summary" &&
      e.extra.source_file === currentChatId, // <--- 新增这行，严防串台
  );

  if (animaEntries.length === 0) {
    toastr.info(`世界书 [${wbName}] 中暂无 Anima 插件生成的总结。`);
    return;
  }

  // 1. 构建轻量级数据 (适配新旧两种结构)
  cachedHistoryData = [];
  animaEntries.forEach((entry) => {
    if (Array.isArray(entry.extra.history)) {
      entry.extra.history.forEach((hist) => {
        // ✨ 核心适配逻辑 ✨
        // 新数据: unique_id="6_1", batch_id=6, slice_id=1
        // 旧数据: index=6 (且无 unique_id)
        const uniqueId =
          hist.unique_id !== undefined ? hist.unique_id : hist.index;
        const batchId =
          hist.batch_id !== undefined ? hist.batch_id : hist.index;
        const sliceId = hist.slice_id !== undefined ? hist.slice_id : 0; // 旧数据默认为0或1视作单切片

        cachedHistoryData.push({
          uid: entry.uid,
          entryName: entry.name,

          // 存储适配后的 ID
          unique_id: uniqueId, // 用于查找文本、删除向量 (string)
          batch_id: batchId, // 用于排序、重新生成 (number)
          slice_id: sliceId, // 用于排序、展示 (number)

          range_start: hist.range_start,
          range_end: hist.range_end,
          tags: Array.isArray(hist.tags) ? hist.tags : [],
          wbName: wbName,
          narrative_time: entry.extra.narrative_time || Date.now(),
        });
      });
    }
  });

  // 2. 排序优化：先按 Batch 倒序，同 Batch 内按 Slice 正序 (或者倒序，看你喜好)
  cachedHistoryData.sort((a, b) => {
    if (b.batch_id !== a.batch_id) {
      return b.batch_id - a.batch_id;
    }
    // ✨ 修改处：改为 b - a
    return b.slice_id - a.slice_id;
  });

  // 重置页码
  currentHistoryPage = 1;

  // 2. 初始化模态框框架
  const modalHtml = `
        <div style="margin-bottom:10px; display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:10px;">
            
            <span style="font-size:12px; color:#aaa; word-break: break-all;">
                当前世界书: <strong>${escapeHtml(wbName)}</strong> (共 ${cachedHistoryData.length} 条)
            </span>
            
            <div style="display: flex; gap: 8px; margin-left: auto;">
                <button id="anima-btn-open-add-modal" class="anima-btn small primary"><i class="fa-solid fa-plus"></i> 新增</button>
                <button id="anima-btn-refresh-list" class="anima-btn small secondary"><i class="fa-solid fa-sync"></i> 刷新</button>
            </div>
            
        </div>
        
        <div id="anima-history-list-container" style="min-height: 300px;"></div>
        
        <div id="anima-history-pagination" style="display:flex; justify-content:center; align-items:center; margin-top:15px; gap:15px;">
        </div>
    `;

  showModal("历史总结管理", modalHtml);

  // 3. 首次渲染第一页
  renderHistoryPage();

  // 4. 绑定各种事件 (刷新、翻页、列表点击)
  // 刷新按钮
  $("#anima-btn-refresh-list")
    .off("click")
    .on("click", () => showSummaryHistoryModal());

  $("#anima-btn-open-add-modal")
    .off("click")
    .on("click", () => {
      // 清空之前的输入残留
      $("#anima_add_summary_index").val("");
      $("#anima_add_summary_content").val("");
      $("#anima_add_summary_tags").val("");
      // 显示新增弹窗
      $("#anima-add-summary-modal").removeClass("hidden");
      // （可选）如果不希望背景太黑，可以将下层弹窗稍微变暗或隐藏
      // $("#anima-summary-modal").css("opacity", "0.3");
    });

  // 分页按钮 (委托绑定)
  $("#anima-history-pagination")
    .off("click")
    .on("click", ".page-btn", function () {
      const action = $(this).data("action");
      if (action === "prev") {
        if (currentHistoryPage > 1) {
          currentHistoryPage--;
          renderHistoryPage();
        }
      } else if (action === "next") {
        const maxPage = Math.ceil(cachedHistoryData.length / PAGE_SIZE);
        if (currentHistoryPage < maxPage) {
          currentHistoryPage++;
          renderHistoryPage();
        }
      }
    });

  // ★★★ 调用那个你没见过的函数 ★★★
  bindHistoryListEvents(wbName);
}

function renderHistoryPage() {
  const listContainer = $("#anima-history-list-container");
  const pageContainer = $("#anima-history-pagination");

  const startIdx = (currentHistoryPage - 1) * PAGE_SIZE;
  const endIdx = startIdx + PAGE_SIZE;
  const pageItems = cachedHistoryData.slice(startIdx, endIdx);

  if (pageItems.length === 0) {
    listContainer.html(
      `<div style="padding:20px; text-align:center;">暂无记录</div>`,
    );
    pageContainer.empty();
    return;
  }

  const html = pageItems
    .map((item) => {
      const tagsHtml = item.tags
        .map(
          (tag) =>
            `<span class="anima-tag-badge" style="background:rgba(255,255,255,0.1); padding:2px 8px; border-radius:10px; font-size:12px; margin-right:5px; border:1px solid #555;">${escapeHtml(tag)}</span>`,
        )
        .join("");
      const tagsString = item.tags.join(", ");

      // ✨ 格式化显示 ID：如果有 slice_id > 0，显示为 Batch-Slice (例如 6-1)
      const displayId =
        item.slice_id > 0
          ? `${item.batch_id}<span style="font-size:0.8em; opacity:0.7;">-${item.slice_id}</span>`
          : `${item.batch_id}`;

      // ✨ 关键：data-unique-id 存储字符串ID ("6_1") 用于查找内容
      // ✨ 关键：data-batch-id 用于重新生成整个批次
      return `
        <div class="anima-history-entry" 
             data-unique-id="${item.unique_id}" 
             data-batch-id="${item.batch_id}"
             data-uid="${item.uid}" 
             style="margin-bottom: 5px; border: 1px solid #444; border-radius: 4px; background: rgba(0,0,0,0.2);">
            
            <div class="anima-history-header" style="padding: 8px 10px; cursor: pointer; display: flex; justify-content: space-between; align-items: center;">
                <div class="anima-history-meta" style="flex: 1; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px; min-width: 0;">
                    <span style="color:#fbbf24; font-weight:bold; white-space: nowrap; flex-shrink: 0;">#${displayId}</span>
    
                    <span style="color:#aaa; font-size:12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100px;">
                        [${escapeHtml(item.entryName)}]
                    </span>
    
                    <span style="color:#666; font-size:12px; white-space: nowrap; flex-shrink: 0;">
                        ${item.range_start}-${item.range_end}
                    </span>
                </div>
                
                <div class="anima-history-actions" style="display:flex; align-items:center; gap:5px;">
                    <div class="actions-normal">
                        <button class="anima-btn small primary btn-regen-item" data-start="${item.range_start}" data-end="${item.range_end}" data-batch-id="${item.batch_id}" title="重新生成该批次"><i class="fa-solid fa-rotate"></i></button>
                        <button class="anima-btn small secondary btn-edit-item" title="编辑"><i class="fa-solid fa-pen-to-square"></i></button>
                        <button class="anima-btn small danger btn-del-item" title="删除"><i class="fa-solid fa-trash"></i></button>
                    </div>
                    <div class="actions-editing" style="display:none; gap:5px;"> 
                        <button class="anima-btn small primary btn-save-edit"><i class="fa-solid fa-check"></i></button>
                        <button class="anima-btn small danger btn-cancel-edit"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <i class="fa-solid fa-chevron-right toggle-icon" style="font-size: 10px; color: #666; width:15px; text-align:center; transition: transform 0.2s; margin-left: 5px;"></i>
                </div>
            </div>
            
            <div class="anima-history-content" data-loaded="false" style="display: none; padding: 10px; border-top: 1px solid rgba(255,255,255,0.05);">
                <div class="loading-placeholder" style="color:#888; font-style:italic;">
                    <i class="fa-solid fa-circle-notch fa-spin"></i> Loading content...
                </div>
            </div>
            
            <div class="anima-tags-wrapper" style="padding: 5px 10px 8px 10px; border-top: 1px dashed rgba(255,255,255,0.1);">
                <div class="tags-view-mode" style="color:#aaa; font-size:12px;">
                    <i class="fa-solid fa-tags" style="font-size:10px; margin-right:5px;"></i>
                    ${tagsHtml || '<span style="opacity:0.5;">No tags</span>'}
                </div>
                <div class="tags-edit-mode" style="display:none; align-items:center; gap:5px; margin-top:5px;">
                    <input type="text" class="anima-input tags-input" value="${escapeHtml(tagsString)}" placeholder="Tags..." style="width:100%;">
                </div>
            </div>
        </div>
        `;
    })
    .join("");

  listContainer.html(html);

  // ... 分页代码保持不变 ...
  const maxPage = Math.ceil(cachedHistoryData.length / PAGE_SIZE);
  if (maxPage <= 1) {
    pageContainer.empty();
  } else {
    pageContainer.html(`
            <button class="anima-btn small secondary page-btn" data-action="prev" ${currentHistoryPage === 1 ? 'disabled style="opacity:0.5"' : ""}>&lt;</button>
            <span style="font-weight:bold; color:#ccc;">${currentHistoryPage} / ${maxPage}</span>
            <button class="anima-btn small secondary page-btn" data-action="next" ${currentHistoryPage === maxPage ? 'disabled style="opacity:0.5"' : ""}>&gt;</button>
        `);
  }
}

/**
 * 统一绑定列表内部的所有事件 (点击展开、编辑、删除等)
 * 这个函数只需要在打开模态框时调用一次
 */

function bindHistoryListEvents(wbName) {
  const container = $("#anima-history-list-container");
  container.off("click");

  // === A. 展开 (Fetch Text) ===
  container.on("click", ".anima-history-header", async function (e) {
    if ($(e.target).closest("button, input, textarea").length) return;

    const $entry = $(this).closest(".anima-history-entry");
    const $content = $entry.find(".anima-history-content");
    const $icon = $entry.find(".toggle-icon");

    if ($content.hasClass("editing")) return;

    if ($content.is(":visible")) {
      $content.slideUp(150);
      $icon.css("transform", "rotate(0deg)");
    } else {
      if ($content.attr("data-loaded") === "false") {
        const uid = $entry.data("uid");
        // ✨ 改为获取 unique-id (string "6_1")
        const uniqueId = $entry.data("unique-id");

        // 调用 worldbook_api.js 获取文本
        const fullText = await getSummaryTextFromEntry(uid, uniqueId);
        $content.text(fullText).attr("data-loaded", "true");
      }
      $content.slideDown(150);
      $icon.css("transform", "rotate(90deg)");
    }
  });

  // === B. 编辑 ===
  container.on("click", ".btn-edit-item", async function (e) {
    e.preventDefault();
    e.stopPropagation();
    const $entry = $(this).closest(".anima-history-entry");
    const $contentDiv = $entry.find(".anima-history-content");

    if (!$contentDiv.is(":visible")) {
      $entry.find(".anima-history-header").click();
    }

    setTimeout(async () => {
      if ($contentDiv.attr("data-loaded") === "false") {
        const uid = $entry.data("uid");
        const uniqueId = $entry.data("unique-id");
        const fullText = await getSummaryTextFromEntry(uid, uniqueId);
        $contentDiv.text(fullText).attr("data-loaded", "true");
      }
      // ... 后续 UI 切换逻辑保持不变 ...
      const $tagsView = $entry.find(".tags-view-mode");
      const $tagsEdit = $entry.find(".tags-edit-mode");
      const $tagsInput = $entry.find(".tags-input");
      const originalText = $contentDiv.text();
      const originalTagsStr = $tagsInput.val();

      $contentDiv.data("original-text", originalText);
      $tagsInput.data("original-tags", originalTagsStr);

      $entry.find(".actions-normal").hide();
      $entry.find(".actions-editing").css("display", "flex");
      $contentDiv
        .addClass("editing")
        .html(
          `<textarea class="anima-edit-textarea" style="width:100%; min-height:150px; resize:vertical; background:rgba(0,0,0,0.3); color:#fff; border:1px solid #555; padding:5px; font-family:inherit;">${escapeHtml(originalText)}</textarea>`,
        );
      $tagsView.hide();
      $tagsEdit.css("display", "flex");
    }, 50);
  });

  // === C. 取消编辑 (保持不变) ===
  container.on("click", ".btn-cancel-edit", function (e) {
    // ... 代码完全不变 ...
    e.preventDefault();
    e.stopPropagation();
    const $entry = $(this).closest(".anima-history-entry");
    const $contentDiv = $entry.find(".anima-history-content");
    const $tagsView = $entry.find(".tags-view-mode");
    const $tagsEdit = $entry.find(".tags-edit-mode");
    const $tagsInput = $entry.find(".tags-input");

    const originalText = $contentDiv.data("original-text");
    $contentDiv.removeClass("editing").text(originalText);
    $tagsInput.val($tagsInput.data("original-tags"));

    $tagsEdit.hide();
    $tagsView.show();
    $entry.find(".actions-editing").hide();
    $entry.find(".actions-normal").show();
  });

  // === D. 保存编辑 ===
  container.on("click", ".btn-save-edit", async function (e) {
    e.preventDefault();
    e.stopPropagation();
    const $btn = $(this);
    if ($btn.prop("disabled")) return;

    const originalIcon = $btn.html();
    $btn
      .prop("disabled", true)
      .html('<i class="fa-solid fa-spinner fa-spin"></i>');

    const $entry = $btn.closest(".anima-history-entry");
    const $textarea = $entry.find("textarea");
    const $tagsInput = $entry.find(".tags-input");
    const $contentDiv = $entry.find(".anima-history-content");

    const newText = $textarea.val();
    const tagsStr = $tagsInput.val().trim();
    const uid = $entry.data("uid");
    // ✨ 改为获取 unique-id (string)
    const uniqueId = $entry.data("unique-id");

    const originalText = $contentDiv.data("original-text");
    const safeOriginalTags = $tagsInput.data("original-tags") || "";

    const restoreUI = () => {
      $btn.prop("disabled", false).html(originalIcon);
    };

    if (!newText.trim()) {
      toastr.warning("内容不能为空");
      restoreUI();
      return;
    }

    if (newText === originalText && tagsStr === safeOriginalTags) {
      toastr.info("内容未变更");
      $contentDiv.removeClass("editing").text(originalText);
      $entry.find(".tags-edit-mode").hide();
      $entry.find(".tags-view-mode").show();
      $entry.find(".actions-editing").hide();
      $entry.find(".actions-normal").show();
      restoreUI();
      return;
    }

    const newTags = tagsStr
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    try {
      // ✨ 传入 uniqueId
      await updateSummaryContent(wbName, uid, uniqueId, newText, newTags);

      // ... 后面 UI 更新逻辑保持不变 ...
      $contentDiv
        .text(newText)
        .removeClass("editing")
        .attr("data-loaded", "true");
      // (Tag Badge 更新代码省略，同原版)
      const $tagsView = $entry.find(".tags-view-mode");
      const newBadgesHtml =
        newTags.length > 0
          ? newTags
              .map(
                (tag) =>
                  `<span class="anima-tag-badge" style="background:rgba(255,255,255,0.1); padding:2px 8px; border-radius:10px; font-size:12px; margin-right:5px; border:1px solid #555;">${escapeHtml(tag)}</span>`,
              )
              .join("")
          : '<span style="opacity:0.5;">No tags</span>';
      $tagsView.html(
        `<i class="fa-solid fa-tags" style="font-size:10px; margin-right:5px;"></i>${newBadgesHtml}`,
      );

      $entry.find(".tags-edit-mode").hide();
      $tagsView.show();
      $entry.find(".actions-editing").hide();
      $entry.find(".actions-normal").show();

      restoreUI();
    } catch (err) {
      console.error(err);
      toastr.error("保存失败: " + err.message);
      restoreUI();
    }
  });

  // === E. 重新生成 (Regen) ===
  container.on("click", ".btn-regen-item", function () {
    const start = parseInt($(this).data("start"));
    const end = parseInt($(this).data("end"));
    // ✨ 改为获取 batch-id (即批次号)
    const batchId = parseInt($(this).data("batch-id"));

    if (
      confirm(
        `确定要重新生成整个批次 #${batchId} 吗？\n(这将覆盖该批次下的所有切片)`,
      )
    ) {
      $("#anima-summary-modal").addClass("hidden");
      // 调用 runSummarizationTask，传入 manualIndex = batchId
      runSummarizationTask({
        force: true,
        customRange: { start, end },
        manualIndex: batchId,
      });
    }
  });

  // === F. 删除 (Delete) ===
  container.on("click", ".btn-del-item", async function () {
    const uid = $(this).closest(".anima-history-entry").data("uid");
    // ✨ 改为获取 unique-id
    const uniqueId = $(this).closest(".anima-history-entry").data("unique-id");

    if (!confirm(`确定要删除切片 #${uniqueId} 吗？`)) return;
    try {
      await deleteSummaryItem(wbName, uid, uniqueId);
      toastr.success(`已删除记录 #${uniqueId}`);
      showSummaryHistoryModal();
    } catch (e) {
      toastr.error(e.message);
    }
  });
}

async function previewSummary(startId, endId, targetIndex, titlePrefix = "") {
  console.log(`[Anima Preview] Start request: ${startId}-${endId}`); // 🟢 Debug

  // A. 基础检查
  const context = SillyTavern.getContext();
  if (!context.chatId) {
    toastr.warning("请先打开一个聊天窗口。");
    return;
  }

  try {
    // B. 获取消息内容 (关键点：检查获取到了什么)
    // 注意：TavernHelper.getChatMessages 返回的是 Array
    const msgs = window.TavernHelper.getChatMessages(`${startId}-${endId}`, {
      include_swipes: false,
    });

    console.log(
      `[Anima Preview] Got messages count: ${msgs ? msgs.length : "null"}`,
    ); // 🟢 Debug

    // 如果 ST 返回空数组，可能是范围完全超出了，或者 API 行为异常
    // 我们手动容错：如果 msgs 为空，但也弹窗，只不过内容显示为空
    const safeMsgs = msgs || [];

    // C. 处理 Context
    const settings = getSummarySettings();
    const previewSettings = {
      regex_strings: settings.regex_strings,
      exclude_user: $("#anima_exclude_user").prop("checked"),
      regex_skip_user: $("#anima_regex_skip_user").prop("checked"),
      skip_layer_zero: $("#anima_skip_layer_zero").prop("checked"),
    };

    // 正则处理
    const contextArr = safeMsgs.length
      ? processMessagesWithRegex(safeMsgs, previewSettings)
      : [];

    console.log(
      `[Anima Preview] Context processed. Lines: ${contextArr.length}`,
    ); // 🟢 Debug

    // D. 获取元数据
    const { charName, charDesc, userName, userPersona } = getContextData();

    // E. 辅助渲染函数 (Block)
    const createBlock = (
      title,
      content,
      color,
      borderColor,
      bgColor,
      headerExtra = "",
    ) => {
      return `
            <div class="anima-preview-block" style="border-color: ${borderColor};">
                <div class="block-header" style="background: ${bgColor}; color: ${color};">
                    <div style="display:flex; align-items:center; justify-content: space-between; flex:1; padding-right: 10px;">
                        <span style="display:flex; align-items:center; gap:8px;">${title}</span>
                        ${headerExtra}
                    </div>
                    <i class="fa-solid fa-chevron-down arrow-icon"></i>
                </div>
                <div class="block-content" style="display: none; white-space: pre-wrap; color: #ccc;">${content}</div>
            </div>`;
    };

    let finalPreviewHtml = "";

    // F. 遍历构建 Prompt 链
    for (const [index, item] of settings.summary_messages.entries()) {
      // =========================================================
      // 🟢 修复 1: 检查角色卡/用户设定是否启用
      // =========================================================
      if (item.type === "char_info" || item.type === "user_info") {
        // 如果 enabled 为 false，直接跳过，不生成 HTML
        if (item.enabled === false) continue;

        const isChar = item.type === "char_info";
        const labelTitle = isChar ? `👾 角色卡信息` : `👑 用户设定`;
        let raw = isChar ? charDesc : userPersona;
        raw = processMacros(raw || "");
        const pColor = isChar ? "#d8b4fe" : "#f472b6"; // 亮色字体
        const pBorder = isChar ? "#9333ea" : "#db2777"; // 边框
        const pBg = isChar
          ? "rgba(168, 85, 247, 0.2)"
          : "rgba(236, 72, 153, 0.2)"; // 背景

        finalPreviewHtml += createBlock(
          labelTitle,
          escapeHtml(raw),
          pColor,
          pBorder,
          pBg,
          `<span class="anima-tag secondary" style="font-size:10px;">SYSTEM</span>`,
        );
        continue;
      }

      // =========================================================
      // 🟢 修复 2: 检查前文总结数量
      // =========================================================
      if (item.type === "prev_summaries") {
        const count = parseInt(item.count) || 0;
        // 如果数量 <= 0，直接跳过
        if (count <= 0) continue;

        // ... 后续渲染代码保持不变 ...
        // 必须 await
        const prevText = await getPreviousSummaries(targetIndex, count);
        finalPreviewHtml += createBlock(
          `⏮️ 插入前文总结`,
          escapeHtml(prevText || "无"),
          "#4ade80",
          "#16a34a",
          "rgba(34, 197, 94, 0.2)",
          `<span class="anima-tag secondary" style="font-size:10px;">SYSTEM</span>`,
        );
        continue;
      }

      // 重点：Context
      if (item.content && item.content.includes("{{context}}")) {
        let contextHtml = "";
        if (contextArr.length === 0) {
          contextHtml = `<div style='padding:10px; color:#aaa; font-style:italic;'>⚠️ 此范围内没有有效消息。<br>可能原因：<br>1. 楼层确实不足 (Max < Start)<br>2. 消息被"排除User"或正则完全过滤</div>`;
        } else {
          contextHtml = contextArr
            .map((m) => {
              const colorClass =
                m.role === "user" ? "color:#4ade80" : "color:#60a5fa";

              // 🟢 新增：检测 skippedRegex 标记 (这个标记需要 summary_logic.js 返回)
              const skipBadge = m.skippedRegex
                ? `<span style="font-size:10px; background:rgba(255,255,255,0.1); border-radius:3px; padding:0 3px; margin-left:5px; color:#aaa;" title="正则已跳过">RAW</span>`
                : "";

              return (
                `<div style="margin-bottom: 8px; border-left: 2px solid rgba(255,255,255,0.1); padding-left: 6px;">` +
                // 🟢 修改：在 role 后面加入 ${skipBadge}
                `<div style="font-weight:bold; font-size: 11px; margin-bottom: 2px; line-height: 1; ${colorClass}">[${m.role.toUpperCase()}]${skipBadge}</div>` +
                `<div style="white-space: pre-wrap; color: #ccc; line-height: 1.4; font-size: 12px; margin: 0;">${escapeHtml(m.content).trim()}</div>` +
                `</div>`
              );
            })
            .join("");
        }

        finalPreviewHtml += createBlock(
          `📎 待总结内容`,
          contextHtml,
          "#93c5fd",
          "#2563eb",
          "rgba(59, 130, 246, 0.2)",
          `<span style="font-size:12px; font-family:monospace; opacity: 0.8;">${startId} - ${endId}</span>`,
        );
        continue;
      }

      // 普通条目
      const roleStr = (item.role || "system").toUpperCase();
      const titleStr = item.title ? item.title : `📝 Prompt #${index + 1}`;
      const processedContent = processMacros(item.content);

      finalPreviewHtml += createBlock(
        titleStr,
        escapeHtml(processedContent),
        "#aaa",
        "#444",
        "rgba(0,0,0,0.3)",
        `<span class="anima-tag secondary" style="font-size:10px;">${roleStr}</span>`,
      );
    }

    // G. 显示模态框
    const metaInfo = `
            <div style="margin-bottom: 10px; color: #aaa; font-size: 12px; border-bottom:1px solid #444; padding-bottom:10px;">
                <div style="display:flex; justify-content:space-between;">
                    <span><strong>目标序号:</strong> #${targetIndex}</span>
                    <span><strong>待总结内容范围:</strong> ${startId} - ${endId}</span>
                </div>
            </div>
        `;

    const style = `<style>
        .anima-preview-block { border: 1px solid #444; border-radius: 6px; margin-bottom: 10px; overflow: hidden; background: rgba(0,0,0,0.1); } 
        .block-header { padding: 8px 10px; font-size: 13px; font-weight: bold; cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none; } 
        .block-header:hover { filter: brightness(1.2); } 
        .block-content { padding: 10px; font-size: 12px; border-top: 1px solid rgba(0,0,0,0.2); background: rgba(0,0,0,0.2); line-height: 1.5; } 
        .anima-preview-block.expanded .arrow-icon { transform: rotate(180deg); }
    </style>`;

    console.log("[Anima Preview] Calling showModal..."); // 🟢 Debug

    showModal(
      titlePrefix || "预览",
      style +
        metaInfo +
        `<div id="anima-preview-container">${finalPreviewHtml}</div>`,
    );

    // 绑定折叠逻辑
    setTimeout(() => {
      $("#anima-preview-container")
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
    console.error("[Anima Preview Error]", e);
    toastr.error("预览发生错误: " + e.message);
  }
}
