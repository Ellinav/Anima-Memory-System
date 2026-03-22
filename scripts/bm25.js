import {
  escapeHtml,
  processMacros,
  applyRegexRules,
  objectToYaml,
} from "./utils.js";
import {
  getBm25SyncList,
  triggerBm25BuildSingle,
  getBm25BackendConfig,
  markBm25Synced,
  markAllBm25SyncedBatch,
  triggerBm25BuildBatch,
  saveDictionaryAndRebuild,
} from "./bm25_logic.js";
import { RegexListComponent, getRegexModalHTML } from "./regex_ui.js";
import { markAllBm25Unsynced } from "./worldbook_api.js";
import { getLastRetrievalPayload } from "./rag_logic.js";
import { loadAndRenderKbList } from "./knowledge.js";

// 获取当前聊天对应的安全 BM25 库名
function getCurrentBm25LibName() {
  const context = SillyTavern.getContext();
  const chatId = context.chatId;
  const safeChatId = chatId ? chatId.replace(/\.jsonl?$/i, "") : "default";
  return safeChatId.replace(/[^a-zA-Z0-9@\-\._\u4e00-\u9fa5]/g, "_");
}

// 1. 获取全局配置 (工作模块 + 词典池内容)
function getGlobalBm25Settings() {
  const { extensionSettings } = SillyTavern.getContext();

  if (!extensionSettings.anima_memory_system) {
    extensionSettings.anima_memory_system = {};
  }

  // 1. 确保基础对象存在
  if (!extensionSettings.anima_memory_system.bm25) {
    extensionSettings.anima_memory_system.bm25 = {
      bm25_enabled: true,
      auto_build: true,
      search_top_k: 3,
      custom_dicts: {
        default_dict: {
          words: [],
        },
      },
    };
  }

  // 2. 🚨 核心修复：单独检查并初始化 content_settings，兼容旧版本配置文件
  if (!extensionSettings.anima_memory_system.bm25.content_settings) {
    extensionSettings.anima_memory_system.bm25.content_settings = {
      reuse_rag_regex: true,
      regex_list: [],
      skip_layer_zero: true,
      regex_skip_user: false,
      exclude_user: false,
      prompt_items: [{ type: "core", id: "floor_content", count: 2 }],
    };
  }

  // 3. 字典映射初始化
  if (!extensionSettings.anima_memory_system.bm25.dict_mapping) {
    extensionSettings.anima_memory_system.bm25.dict_mapping = {};
  }

  return extensionSettings.anima_memory_system.bm25;
}

// 2. 保存全局配置
function saveGlobalSettings() {
  const { saveSettingsDebounced } = SillyTavern.getContext();
  saveSettingsDebounced();
}

// 3. 获取当前角色专属配置 (绑定的 BM25 库)
function getCharBm25Settings() {
  const { characterId, characters } = SillyTavern.getContext();
  if (characterId === undefined) return { libs: [] }; // 未选择角色或群聊时
  const char = characters[characterId];
  return char.data?.extensions?.anima_bm25_settings || { libs: [] };
}

// 4. 保存当前角色专属配置
async function saveCharBm25Settings(settingsData) {
  const { writeExtensionField, characterId } = SillyTavern.getContext();
  // 拦截未选中角色的情况
  if (characterId === undefined || characterId === null) {
    toastr.warning(
      "未选中任何角色！无法保存库绑定。请先在界面左侧点击选中一个角色卡。",
    );
    return false;
  }
  await writeExtensionField(characterId, "anima_bm25_settings", settingsData);
  return true;
}

// 复用弹窗逻辑，专门为 BM25 定制
export function showBm25Modal(title, html) {
  if ($("#anima-bm25-modal").length === 0) {
    const modalWrap = `
        <div id="anima-bm25-modal" class="anima-modal hidden">
             <div class="anima-modal-content">
                <div class="anima-modal-header">
                    <h3 id="anima-bm25-modal-title">标题</h3>
                    <span class="anima-close-bm25-modal" style="cursor:pointer; font-size:20px;">&times;</span>
                </div>
                <div id="anima-bm25-modal-body" class="anima-modal-body"></div>
             </div>
        </div>`;
    $("body").append(modalWrap);

    // 绑定通用关闭事件
    $(document).on("click", ".anima-close-bm25-modal", function () {
      $("#anima-bm25-modal").addClass("hidden");
    });
  }

  $("#anima-bm25-modal-title").text(title);
  $("#anima-bm25-modal-body").html(html);
  $("#anima-bm25-modal").removeClass("hidden");
}

// ================= 新增：分页与草稿状态管理 =================
let currentDraftWords = []; // 内存中的词条草稿数组
let currentDictPage = 1; // 当前页码
const WORDS_PER_PAGE = 10; // 设定每页显示多少条，你可以自己改

// 提取一个专门渲染当前页词条的函数
function renderWordsList() {
  const totalItems = currentDraftWords.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / WORDS_PER_PAGE));

  // 越界保护
  if (currentDictPage > totalPages) currentDictPage = totalPages;
  if (currentDictPage < 1) currentDictPage = 1;

  const startIndex = (currentDictPage - 1) * WORDS_PER_PAGE;
  const endIndex = startIndex + WORDS_PER_PAGE;
  const pageWords = currentDraftWords.slice(startIndex, endIndex);

  const $listContainer = $("#tab-bm25 #bm25_words_list");

  if (pageWords.length === 0) {
    $listContainer.html(
      '<div style="color:#666; text-align:center; padding: 15px;">当前词典暂无词条</div>',
    );
  } else {
    const wordsHtml = pageWords
      .map((w, i) => {
        const absoluteIndex = startIndex + i; // 记录它在总数组里的绝对索引
        const triggers = (w.trigger || "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        const triggerTags =
          triggers.length > 0
            ? triggers
                .map((t) => `<span class="bm25-tag">${escapeHtml(t)}</span>`)
                .join("")
            : '<span style="color:#666; font-size:11px;">(同索引词)</span>';
        const indexTag = `<span class="bm25-tag" style="background: rgba(52, 211, 153, 0.2); color: #34d399; border: 1px solid rgba(52, 211, 153, 0.4);">${escapeHtml(w.index)}</span>`;

        // 判断是否处于刚刚新建的编辑状态
        const isEditing = w._isEditing ? true : false;

        return `
            <div class="bm25-grid-row bm25-word-view" data-abs-idx="${absoluteIndex}" style="display: ${isEditing ? "none" : "grid"};">
                <div style="display: flex; gap: 4px; flex-wrap: wrap; align-items: center; justify-content: center;">${triggerTags}</div>
                <div style="display: flex; justify-content: center; align-items: center;">${indexTag}</div>
                <div style="display: flex; gap: 5px; justify-content: center;">
                    <button class="anima-btn secondary small btn-edit-word" style="height: 28px; padding: 0 8px;"><i class="fa-solid fa-pen"></i></button>
                    <button class="anima-btn danger small btn-del-word" style="height: 28px; padding: 0 8px;"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
            <div class="bm25-grid-row bm25-word-edit" data-abs-idx="${absoluteIndex}" style="display: ${isEditing ? "grid" : "none"};">
                <input type="text" class="anima-input edit-trigger-val" value="${escapeHtml(w.trigger)}" placeholder="可留空，逗号分隔" style="height: 28px; font-size: 12px; margin: 0; padding: 0 8px; box-sizing: border-box;">
                <input type="text" class="anima-input edit-index-val" value="${escapeHtml(w.index)}" placeholder="唯一索引词" style="height: 28px; font-size: 12px; margin: 0; padding: 0 8px; box-sizing: border-box;">
                <div style="display: flex; gap: 5px; justify-content: center;">
                    <button class="anima-btn primary small btn-save-word" style="height: 28px; padding: 0 8px;"><i class="fa-solid fa-check"></i></button>
                    <button class="anima-btn danger small btn-cancel-word" style="height: 28px; padding: 0 8px;"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>`;
      })
      .join("");
    $listContainer.html(wordsHtml);
  }

  // 更新翻页按钮状态
  $("#bm25_page_info").text(
    `第 ${currentDictPage} / ${totalPages} 页 (共 ${totalItems} 条)`,
  );
  $("#btn_bm25_prev_page").prop("disabled", currentDictPage === 1);
  $("#btn_bm25_next_page").prop("disabled", currentDictPage === totalPages);
}

export function initBm25Settings() {
  const container = document.getElementById("tab-bm25");
  if (!container) return;

  const globalSettings = getGlobalBm25Settings();
  const charSettings = getCharBm25Settings();

  const resolvedDict =
    charSettings.bound_dict || globalSettings.current_dict || "default_dict";

  // 🗑️ 移除了 blacklist 和 auto_capture_tags
  const settings = {
    bm25_enabled: globalSettings.bm25_enabled,
    current_dict: resolvedDict,
    auto_build: globalSettings.auto_build ?? true,
    search_top_k: globalSettings.search_top_k || 3,
  };

  // 3. 动态获取真实的词典列表
  const dicts = globalSettings.custom_dicts
    ? Object.keys(globalSettings.custom_dicts)
    : ["default_dict"];

  // 4. 动态获取当前词典的真实词条 (统一使用 settings.current_dict)
  const currentDictData = globalSettings.custom_dicts?.[settings.current_dict];
  const words =
    currentDictData && currentDictData.words ? currentDictData.words : [];

  // 5. 动态获取当前角色绑定的真实库
  const libs = charSettings.libs || [];

  renderBm25UI(container, settings, dicts, words, libs);
  setTimeout(() => $("#bm25_dict_select").trigger("change"), 50);
}

function renderBm25UI(container, settings, dicts, words, libs) {
  const style = `
    <style>
        .bm25-grid-header { display: grid; grid-template-columns: 2fr 2fr 70px; gap: 10px; padding: 10px; border-bottom: 1px solid #444; font-weight: bold; color: #aaa; text-align: center; font-size: 13px; }
        .bm25-grid-row { display: grid; grid-template-columns: 2fr 2fr 70px; gap: 10px; padding: 5px 10px; border-bottom: 1px dashed rgba(255,255,255,0.05); align-items: center; text-align: center; font-size: 13px; }
        .bm25-tag { display: inline-block; background: rgba(255,255,255,0.1); padding: 2px 8px; border-radius: 12px; font-size: 11px; color: #ccc; word-break: break-all; }
        .bm25-pagination { display: flex; justify-content: center; align-items: center; gap: 10px; margin-top: 15px; font-size: 12px; color: #888; }
        .bm25-lib-badge { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; margin-right: 5px; margin-bottom: 5px; font-family: monospace; }
        .bm25-lib-normal { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
        .bm25-lib-warning { background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }
        .bm25-file-item { display: flex; justify-content: space-between; align-items: center; padding: 10px; background: rgba(255,255,255,0.05); border-radius: 4px; margin-bottom: 5px; border: 1px solid transparent; }
        .bm25-file-item:hover { border-color: rgba(255,255,255,0.1); background: rgba(255,255,255,0.08); }
        .bm25-select {
            appearance: auto !important;
            background-color: rgba(0,0,0,0.3);
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 4px;
            color: #ddd;
            cursor: pointer;
            padding: 0 5px !important;
            line-height: normal !important;
            vertical-align: middle !important;
        }
        .bm25-select:hover { border-color: rgba(255,255,255,0.4); }
        .bm25-select option { background-color: #222; color: #ddd; }
        
        /* 🔥 新增：强力修复正则和Prompt列表内的下拉框排版，防止文字坠底 */
        #bm25_regex_list select, #bm25_prompt_list select {
            appearance: auto !important;
            height: 28px !important;
            line-height: normal !important;
            padding: 0 5px !important;
            vertical-align: middle !important;
            box-sizing: border-box !important;
        }
    </style>`;

  // 主开关
  const masterSwitchHtml = `
    <div class="anima-setting-group" style="margin-bottom: 10px;">
        <div class="anima-card" style="border-left: 4px solid var(--anima-primary);">
            <div class="anima-flex-row">
                <div class="anima-label-group">
                    <span class="anima-label-text" style="font-size: 1.1em; font-weight: bold;">BM25检索总开关</span>
                    <span class="anima-desc-inline">关闭后，本页面所有配置项将被隐藏</span>
                </div>
                <label class="anima-switch">
                    <input type="checkbox" id="bm25_master_switch" ${settings.bm25_enabled ? "checked" : ""}>
                    <span class="slider round"></span>
                </label>
            </div>
        </div>
    </div>`;

  // 词典模块
  const dictOptionsHtml = dicts
    .map(
      (d) =>
        `<option value="${d}" ${settings.current_dict === d ? "selected" : ""}>${d}</option>`,
    )
    .join("");
  const wordsHtml = words
    .map((w, i) => {
      // 渲染展示用的标签
      const triggers = w.trigger
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const triggerTags =
        triggers.length > 0
          ? triggers
              .map((t) => `<span class="bm25-tag">${escapeHtml(t)}</span>`)
              .join("")
          : '<span style="color:#666; font-size:11px;">(同索引词)</span>';
      const indexTag = `<span class="bm25-tag" style="background: rgba(52, 211, 153, 0.2); color: #34d399; border: 1px solid rgba(52, 211, 153, 0.4);">${escapeHtml(w.index)}</span>`;

      return `
        <div class="bm25-grid-row bm25-word-view" data-idx="${i}">
            <div style="display: flex; gap: 4px; flex-wrap: wrap; align-items: center; justify-content: center;">${triggerTags}</div>
            <div style="display: flex; justify-content: center; align-items: center;">${indexTag}</div>
            <div style="display: flex; gap: 5px; justify-content: center;">
                <button class="anima-btn secondary small btn-edit-word" style="height: 28px; padding: 0 8px;"><i class="fa-solid fa-pen"></i></button>
                <button class="anima-btn danger small btn-del-word" style="height: 28px; padding: 0 8px;"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>
        <div class="bm25-grid-row bm25-word-edit" data-idx="${i}" style="display: none;">
            <input type="text" class="anima-input edit-trigger-val" value="${escapeHtml(w.trigger)}" placeholder="可留空，逗号分隔" style="height: 28px; font-size: 12px; margin: 0; padding: 0 8px; box-sizing: border-box;">
            <input type="text" class="anima-input edit-index-val" value="${escapeHtml(w.index)}" placeholder="唯一索引词" style="height: 28px; font-size: 12px; margin: 0; padding: 0 8px; box-sizing: border-box;">
            <div style="display: flex; gap: 5px; justify-content: center;">
                <button class="anima-btn primary small btn-save-word" style="height: 28px; padding: 0 8px;"><i class="fa-solid fa-check"></i></button>
                <button class="anima-btn danger small btn-cancel-word" style="height: 28px; padding: 0 8px;"><i class="fa-solid fa-xmark"></i></button>
            </div>
        </div>
        `;
    })
    .join("");

  const dictSectionHtml = `
    <div class="anima-setting-group bm25-content-area ${settings.bm25_enabled ? "" : "hidden"}">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 10px;">
            <h2 class="anima-title" style="margin:0;"><i class="fa-solid fa-book-open"></i> 词典模块</h2>
            <div style="display:flex; gap: 5px;">
                <button id="btn_bm25_dict_import" class="anima-btn secondary small"><i class="fa-solid fa-file-import"></i> 导入</button>
                <button id="btn_bm25_dict_export" class="anima-btn secondary small"><i class="fa-solid fa-file-export"></i> 导出</button>
            </div>
        </div>
        <div class="anima-card">
            <div class="anima-flex-row" style="margin-bottom: 15px;">
                <div class="anima-label-group" style="flex:1;">
                    <span class="anima-label-text">当前词典</span>
                </div>
                <div style="display:flex; gap: 10px; align-items: center;">
                    <select id="bm25_dict_select" class="anima-select bm25-select" style="height: 32px; width: 160px; margin: 0; box-sizing: border-box; padding: 0 10px; line-height: 30px; vertical-align: middle;">
                        ${dictOptionsHtml}
                    </select>
                    <button id="btn_bm25_new_dict" class="anima-btn primary small" style="height: 32px; margin: 0;">新增</button>
                    <button id="btn_bm25_del_dict" class="anima-btn danger small" style="height: 32px; margin: 0;">删除</button>
                </div>
            </div>

            <div style="border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; padding: 5px; background: rgba(0,0,0,0.2);">
                <div class="bm25-grid-header">
                    <div>触发词 (逗号分隔)</div>
                    <div>索引词 (单项)</div>
                    <div>操作</div>
                </div>
                <div id="bm25_words_list" style="min-height: 150px; max-height: 420px; overflow-y: auto;">
                    ${wordsHtml}
                </div>
                <div style="padding: 10px; text-align: center;">
                    <button id="btn_bm25_add_word" class="anima-btn secondary small" style="width: 100%; border: 1px dashed #666; background: transparent;"><i class="fa-solid fa-plus"></i> 添加词条</button>
                </div>
            </div>

            <div class="bm25-pagination">
                <button id="btn_bm25_prev_page" class="anima-btn secondary small" disabled><i class="fa-solid fa-chevron-left"></i></button>
                <span id="bm25_page_info">第 1 / 1 页 (共 0 条)</span>
                <button id="btn_bm25_next_page" class="anima-btn secondary small" disabled><i class="fa-solid fa-chevron-right"></i></button>
            </div>

            <div style="display: flex; gap: 10px; margin-top: 20px;">
                <button id="btn_bm25_dict_save_only" class="anima-btn secondary" style="flex: 1;"><i class="fa-solid fa-floppy-disk"></i> 仅保存修改</button>
                <button id="btn_bm25_dict_save" class="anima-btn primary" style="flex: 1;"><i class="fa-solid fa-link"></i> 保存并应用至当前窗口</button>
            </div>
        </div>
    </div>`;

  // 提取配置用于渲染
  const cSettings =
    settings.content_settings || getGlobalBm25Settings().content_settings;
  const isReuse = cSettings.reuse_rag_regex;

  // ✨ 新增：BM25 检索内容 HTML 模块
  const contentSectionHtml = `
    <div class="anima-setting-group bm25-content-area ${settings.bm25_enabled ? "" : "hidden"}">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 10px;">
            <h2 class="anima-title" style="margin:0;"><i class="fa-solid fa-filter"></i> BM25 检索内容</h2>
        </div>
        <div class="anima-card">
            
            <div class="anima-flex-row" style="margin-bottom: 15px;">
                <div class="anima-label-group">
                    <span class="anima-label-text">复用【向量检索】的正则及设置</span>
                    <span class="anima-desc-inline">打开后将应用 RAG 的清洗规则，隐藏下方的 BM25 专属正则设置</span>
                </div>
                <label class="anima-switch">
                    <input type="checkbox" id="bm25_reuse_rag_regex" ${isReuse ? "checked" : ""}>
                    <span class="slider round"></span>
                </label>
            </div>

            <div id="bm25_specific_content_settings" style="display: ${isReuse ? "none" : "block"};">
                <div class="anima-flex-row" style="align-items: flex-start; margin-bottom: 5px;">
                    <div class="anima-label-group">
                        <span class="anima-label-text">BM25 专属校准正则</span>
                        <span class="anima-desc-inline">在 BM25 向量化之前独立清洗文本</span>
                    </div>
                    <button id="bm25_btn_open_regex_modal" class="anima-btn primary small">
                        <i class="fa-solid fa-plus"></i> 添加规则
                    </button>
                </div>
                <div id="bm25_regex_list" class="anima-regex-list" style="margin-bottom: 10px; min-height: 20px;"></div>

                <div class="anima-flex-row" style="margin-bottom: 10px;">
                    <div class="anima-label-group"><span class="anima-label-text">正则跳过开场白</span></div>
                    <label class="anima-switch">
                        <input type="checkbox" id="bm25_skip_layer_zero" ${cSettings.skip_layer_zero ? "checked" : ""}>
                        <span class="slider round"></span>
                    </label>
                </div>

                <div class="anima-flex-row" style="margin-bottom: 10px;">
                    <div class="anima-label-group"><span class="anima-label-text">正则跳过 User 消息</span></div>
                    <label class="anima-switch">
                        <input type="checkbox" id="bm25_regex_skip_user" ${cSettings.regex_skip_user ? "checked" : ""}>
                        <span class="slider round"></span>
                    </label>
                </div>

                <div class="anima-flex-row">
                    <div class="anima-label-group"><span class="anima-label-text">完全排除 User 消息</span></div>
                    <label class="anima-switch">
                        <input type="checkbox" id="bm25_exclude_user" ${cSettings.exclude_user ? "checked" : ""}>
                        <span class="slider round"></span>
                    </label>
                </div>
            </div>

            <div style="border-top: 1px solid rgba(255,255,255,0.1); margin: 15px 0;"></div>
            
            <div class="anima-prompt-container">
                <div class="anima-flex-row" style="margin-bottom: 5px;">
                    <label class="anima-label-text">BM25 检索词构建</label>
                    <div style="display:flex; gap:10px;">
                        <button id="bm25_btn_preview_query" class="anima-btn secondary small"><i class="fa-solid fa-eye"></i> 预览</button>
                        <button id="bm25_btn_add_prompt_item" class="anima-btn small primary"><i class="fa-solid fa-plus"></i> 添加</button>
                    </div>
                </div>
                
                <div class="anima-prompt-item context" style="margin-bottom: 8px; padding: 10px; border: 1px solid rgba(59, 130, 246, 0.5); border-radius: 4px; background: rgba(59, 130, 246, 0.05); box-sizing: border-box;">
                    <div style="display:flex; justify-content:space-between; align-items:center; height: 30px;">
                        <div style="display:flex; align-items:center; gap: 10px;">
                            <i class="fa-solid fa-bars" style="color:#888; cursor:not-allowed; opacity: 0.5;"></i>
                            <span style="font-weight:bold; color:#60a5fa;"><i class="fa-solid fa-layer-group" style="margin-right: 4px;"></i> 最新楼层内容</span>
                        </div>
                        <div style="display:flex; align-items:center; gap: 5px;">
                            <span style="font-size: 12px; color: #aaa; line-height: 24px;">插入数量:</span>
                            <input type="number" id="bm25_prompt_floor_count" class="anima-input" value="${cSettings.prompt_items?.find((i) => i.id === "floor_content")?.count || 2}" style="width: 60px; height: 24px; line-height: 24px; padding: 0; text-align: center; font-size: 13px; margin: 0;" min="1">
                        </div>
                    </div>
                </div>

                <div id="bm25_prompt_list" style="min-height: 10px; width: 100%; box-sizing: border-box;"></div>
                
                <div style="margin-top: 15px;">
                    <button id="bm25_btn_save_content_settings" class="anima-btn primary" style="width:100%">
                        <i class="fa-solid fa-floppy-disk"></i> 保存检索设置
                    </button>
                </div>
            </div>
        </div>
    </div>`;

  // 当前BM25库模块
  const libsHtml = libs
    .map((lib) => {
      const color = lib.status === "warning" ? "#fbbf24" : "#34d399";
      const icon =
        lib.status === "warning"
          ? `<i class="fa-solid fa-triangle-exclamation" title="可能需要重建" style="color:${color};"></i>`
          : `<i class="fa-solid fa-database" style="color:${color};"></i>`;
      return `
        <div class="bm25-file-item">
            <div style="font-family: monospace; display: flex; align-items: center; gap: 10px;">
                ${icon}
                <span class="bm25-lib-name-text" style="color: #ddd;">${escapeHtml(lib.name)}</span>
            </div>
        </div>`;
    })
    .join("");

  const libSectionHtml = `
    <div class="anima-setting-group bm25-content-area ${settings.bm25_enabled ? "" : "hidden"}">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 10px;">
            <h2 class="anima-title" style="margin:0;"><i class="fa-solid fa-server"></i> BM25 库管理</h2>
            <div style="display:flex; gap: 5px;">
                <button id="btn_bm25_lib_import" class="anima-btn secondary small"><i class="fa-solid fa-file-import"></i> 导入</button>
                <button id="btn_bm25_lib_export" class="anima-btn secondary small"><i class="fa-solid fa-file-export"></i> 导出</button>
                <button id="btn_bm25_manage_libs" class="anima-btn primary small"><i class="fa-solid fa-bars-progress"></i> 管理</button>
            </div>
        </div>
        <div class="anima-card">
            <span class="anima-label-text">已关联BM25库</span>
            <div id="bm25_current_libs_container" style="min-height: 50px; padding: 10px; background: rgba(0,0,0,0.2); border: 1px dashed #555; border-radius: 4px; margin-bottom: 15px;">
                ${libsHtml || '<div style="color:#666; text-align:center;">暂无绑定的 BM25 库</div>'}
            </div>
            <div>
                <button id="btn_bm25_lib_bind_save" class="anima-btn primary" style="width: 100%;"><i class="fa-solid fa-link"></i> 保存库绑定状态</button>
            </div>
        </div>
    </div>`;

  // 工作模块
  const workSectionHtml = `
    <div class="anima-setting-group bm25-content-area ${settings.bm25_enabled ? "" : "hidden"}">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 10px;">
            <h2 class="anima-title" style="margin:0;"><i class="fa-solid fa-gears"></i> 工作模块</h2>
            <div style="display:flex; gap: 5px;">
                <button id="btn_bm25_scan_build" class="anima-btn small bm25-scan-btn"><i class="fa-solid fa-list-check"></i> 切片同步状态</button>
                <button id="btn_bm25_view_log" class="anima-btn secondary small"><i class="fa-solid fa-magnifying-glass-chart"></i> 查看最近检索</button>
            </div>
        </div>
        <div class="anima-card">
            <div class="anima-flex-row" style="margin-bottom: 15px;">
                <div class="anima-label-group">
                    <span class="anima-label-text">自动构建</span>
                    <span class="anima-desc-inline">词典变更或新增总结时触发重构</span>
                </div>
                <label class="anima-switch">
                    <input type="checkbox" id="bm25_auto_build" ${settings.auto_build ? "checked" : ""}>
                    <span class="slider round"></span>
                </label>
            </div>

            <div class="anima-flex-row" style="margin-bottom: 15px;">
                <div class="anima-label-group">
                    <span class="anima-label-text">检索数量 (Top K)</span>
                    <span class="anima-desc-inline">单次 BM25 检索返回的最大条目数</span>
                </div>
                <input type="number" id="bm25_search_k" class="anima-input" value="${settings.search_top_k}" min="1" max="20" style="height: 32px; width: 80px; text-align: center; box-sizing: border-box; margin: 0;">
            </div>

            <div>
                <button id="btn_bm25_work_save" class="anima-btn secondary" style="width: 100%;"><i class="fa-solid fa-floppy-disk"></i> 保存配置</button>
            </div>
        </div>
    </div>`;

  container.innerHTML =
    style +
    masterSwitchHtml +
    workSectionHtml +
    libSectionHtml +
    dictSectionHtml +
    contentSectionHtml;
  bindBm25Events();
}

function bindBm25Events() {
  const $tab = $("#tab-bm25");

  // ✨ 1. 【修复】隔离注入 BM25 专属的正则弹窗，防止和 RAG 的弹窗 ID 冲突打架
  if ($("#bm25-regex-input-modal").length === 0) {
    // 暴力替换掉源 HTML 中的 RAG ID，生成一个全新的专属 DOM
    const bm25RegexModal = getRegexModalHTML()
      .replace(/id="anima-regex-input-modal"/g, 'id="bm25-regex-input-modal"')
      .replace(/id="anima_new_regex_type"/g, 'id="bm25_new_regex_type"')
      .replace(
        /id="anima_new_regex_str"/g,
        'id="bm25_new_regex_str" class="anima-input" style="background-color: rgba(0,0,0,0.3) !important; color: #fff !important; border: 1px solid rgba(255,255,255,0.2) !important;"',
      )
      .replace(
        /id="anima_btn_confirm_add_regex"/g,
        'id="bm25_btn_confirm_add_regex"',
      );

    $("body").append(bm25RegexModal);

    // 绑定这一个专属模态框的关闭事件
    $(document).on(
      "click",
      "#bm25-regex-input-modal .anima-close-regex-modal",
      function () {
        $("#bm25-regex-input-modal").addClass("hidden");
      },
    );
  }

  // ✨ 2. 实例化并渲染正则列表组件
  const bm25RegexList = new RegexListComponent(
    "bm25_regex_list",
    () => getGlobalBm25Settings().content_settings.regex_list || [],
    (newData) => {
      getGlobalBm25Settings().content_settings.regex_list = newData;
    },
  );
  bm25RegexList.render();

  // ✨ 3. 复用开关联动 UI 隐藏/显示
  $tab.find("#bm25_reuse_rag_regex").on("change", function () {
    if ($(this).prop("checked")) {
      $tab.find("#bm25_specific_content_settings").slideUp(200);
    } else {
      $tab.find("#bm25_specific_content_settings").slideDown(200);
    }
  });

  // ✨ 4. 【修复】打开专属添加正则窗口事件
  $tab
    .find("#bm25_btn_open_regex_modal")
    .off("click")
    .on("click", () => {
      $("#bm25_new_regex_type").val("extract");
      $("#bm25_new_regex_str").val("");
      $("#bm25-regex-input-modal").removeClass("hidden");
    });

  // 【修复】确认添加正则（绑定到专属的 Confirm 按钮上）
  $("#bm25_btn_confirm_add_regex")
    .off("click")
    .on("click", () => {
      const type = $("#bm25_new_regex_type").val();
      const regexStr = $("#bm25_new_regex_str").val().trim();
      if (!regexStr) return toastr.warning("正则不能为空");

      bm25RegexList.addRule(regexStr, type);
      $("#bm25-regex-input-modal").addClass("hidden");
    });

  // ✨ 5. 【新增】初始化渲染提示词列表
  renderBm25PromptList();

  // ✨ 【新增/修复】预览按钮逻辑 (使用 TavernHelper 精确获取最新 N 层)
  $tab
    .find("#bm25_btn_preview_query")
    .off("click")
    .on("click", () => {
      const cSettings = getGlobalBm25Settings().content_settings;
      const isReuse = cSettings.reuse_rag_regex;

      // 1. 获取使用的正则配置 (判断是否复用 RAG)
      const extensionSettings =
        SillyTavern.getContext().extensionSettings || {};
      const ragSettings = extensionSettings.anima_memory_system?.rag || {};

      const regexList = isReuse
        ? ragSettings.regex_strings || []
        : cSettings.regex_list || [];
      const skipZero = isReuse
        ? (ragSettings.skip_layer_zero ?? true)
        : (cSettings.skip_layer_zero ?? true);
      const skipUser = isReuse
        ? (ragSettings.regex_skip_user ?? false)
        : (cSettings.regex_skip_user ?? false);
      const excludeUser = isReuse ? false : (cSettings.exclude_user ?? false); // RAG 通常没有全局排 User 设定，所以以 BM25 自己为准

      // 2. 提取聊天记录进行清洗
      const floorCountItem = cSettings.prompt_items?.find(
        (i) => i.id === "floor_content",
      );
      const floorCount = floorCountItem
        ? parseInt(floorCountItem.count, 10) || 1
        : 1;

      let processedContextMsgs = [];
      let allMsgs = [];

      try {
        // 🔥 核心修复：使用 TavernHelper 接口获取 0 到 最新层 的所有有效消息 (自动排除 swipe 废案)
        if (window.TavernHelper && window.TavernHelper.getChatMessages) {
          allMsgs =
            window.TavernHelper.getChatMessages("0-{{lastMessageId}}", {
              include_swipes: false,
            }) || [];
        }
      } catch (e) {
        console.error("[Anima BM25] 获取聊天记录失败:", e);
      }

      // 直接截取数组的最后 N 条
      const recentMsgs = allMsgs.slice(-floorCount);

      recentMsgs.forEach((msg) => {
        // TavernHelper 返回的结构中，角色通常标记在 role 字段
        const isUser = msg.role === "user";
        if (excludeUser && isUser) return;

        // 兼容性获取文本 (不同版本/接口可能是 message 或是 mes)
        let content = msg.message || msg.mes || "";
        if (content) content = processMacros(content);

        // 强力清洗打头符号 >
        const cleanRegex = /^[\s\r\n]*(&gt;|>)[\s\r\n]*/i;
        while (cleanRegex.test(content)) {
          content = content.replace(cleanRegex, "");
        }
        content = content.trim();
        if (!content) return;

        let isSkipped = false;
        // TavernHelper 返回的对象带有可靠的 message_id
        if (skipZero && String(msg.message_id) === "0") isSkipped = true;
        if (skipUser && isUser) isSkipped = true;

        if (!isSkipped && regexList.length > 0) {
          content = applyRegexRules(content, regexList);
          content = content.trim();
        }

        processedContextMsgs.push({
          role: msg.role || (isUser ? "user" : "assistant"),
          is_user: isUser,
          displayContent: content,
          isSkipped: isSkipped,
        });
      });

      // 3. 向前追溯提取最新状态变量
      let finalStatusObj = {};

      // 4. 定义通用的区块渲染 HTML 函数
      const createBlock = (
        title,
        content,
        color,
        borderColor,
        bgColor,
        isExpanded = true,
        headerExtra = "",
      ) => {
        const displayStyle = isExpanded ? "block" : "none";
        const expandedClass = isExpanded ? "expanded" : "";
        return `
          <div class="anima-preview-block ${expandedClass}" style="border: 1px solid ${borderColor}; border-radius: 6px; margin-bottom: 10px; overflow: hidden; background: rgba(0,0,0,0.1);">
              <div class="block-header" style="background: ${bgColor}; color: ${color}; padding: 8px 10px; font-size: 13px; font-weight: bold; cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none;">
                  <div style="display:flex; align-items:center; justify-content: space-between; flex:1; padding-right: 10px;">
                      <span style="display:flex; align-items:center; gap:8px;">${title}</span>
                      ${headerExtra}
                  </div>
                  <i class="fa-solid fa-chevron-down arrow-icon" style="transition: transform 0.2s;"></i>
              </div>
              <div class="block-content" style="display: ${displayStyle}; white-space: pre-wrap; color: #ccc; padding: 10px; font-size: 12px; border-top: 1px solid rgba(0,0,0,0.2); background: rgba(0,0,0,0.2); line-height: 1.5;">${content}</div>
          </div>`;
      };

      // 5. 遍历配置拼装面板
      let listHtml = "";
      (cSettings.prompt_items || []).forEach((item) => {
        if (item.id === "floor_content") {
          // 🔥 文案修正：不再使用“增量消息”，改为“楼层消息”
          let bubblesHtml =
            processedContextMsgs.length === 0
              ? `<div style='padding:5px; color:#aaa; font-style:italic;'>⚠️ 无可用的楼层消息 (可能未开始聊天或被正则完全拦截)</div>`
              : processedContextMsgs
                  .map((m) => {
                    const roleUpper = m.role ? m.role.toUpperCase() : "UNKNOWN";
                    const headerColor = m.is_user
                      ? "color:#4ade80"
                      : "color:#60a5fa";
                    const rawBadge = m.isSkipped
                      ? `<span style="font-size:10px; background:rgba(255,255,255,0.1); border-radius:3px; padding:0 4px; margin-left:6px; color:#aaa;">RAW</span>`
                      : "";
                    return `<div style="margin-bottom: 8px;"><div style="font-weight:bold; font-size: 12px; margin-bottom: 2px; ${headerColor}">[${roleUpper}]${rawBadge}</div><div style="white-space: pre-wrap; color: #ccc; font-size: 13px; padding-left: 2px;">${escapeHtml(m.displayContent)}</div></div>`;
                  })
                  .join("");
          listHtml += createBlock(
            `<i class="fa-solid fa-layer-group"></i> 最新楼层内容 (抽取 ${floorCount} 层)`,
            bubblesHtml,
            "#60a5fa",
            "#2563eb",
            "rgba(37, 99, 235, 0.2)",
          );
        } else if (item.type === "text") {
          const roleStr = (item.role || "system").toUpperCase();
          const processedContent = processMacros(item.content || "");
          const extraTag = `<span class="anima-tag secondary" style="font-size:10px;">${roleStr}</span>`;
          listHtml += createBlock(
            `<i class="fa-solid fa-file-lines"></i> ${escapeHtml(item.title)}`,
            escapeHtml(processedContent),
            "#aaa",
            "#444",
            "rgba(0,0,0,0.3)",
            true,
            extraTag,
          );
        }
      });

      // 6. 弹窗显示并绑定折叠事件 (借用已有的 showBm25Modal)
      const containerHtml = `<div id="bm25-preview-container" style="padding: 5px; max-height: 60vh; overflow-y: auto;">
          <style>.anima-preview-block.expanded .arrow-icon { transform: rotate(180deg); }</style>
          ${listHtml}
      </div>`;

      showBm25Modal("BM25 检索词构建预览", containerHtml);

      setTimeout(() => {
        $("#bm25-preview-container")
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
    });

  // 【新增】点击添加提示词按钮
  $tab
    .find("#bm25_btn_add_prompt_item")
    .off("click")
    .on("click", () => {
      const cSettings = getGlobalBm25Settings().content_settings;
      if (!cSettings.prompt_items) cSettings.prompt_items = [];

      // 往内存推送一条默认规则
      cSettings.prompt_items.push({
        type: "text",
        role: "system",
        title: "新规则",
        content: "",
      });

      // 重新渲染，并滚动到底部以便用户看到新条目
      renderBm25PromptList();
      const $list = $("#bm25_prompt_list");
      $list.animate({ scrollTop: $list.prop("scrollHeight") }, 300);
    });

  // ✨ 6. 保存配置按钮
  $tab.find("#bm25_btn_save_content_settings").on("click", () => {
    const cSettings = getGlobalBm25Settings().content_settings;

    // 提取独立开关
    cSettings.reuse_rag_regex = $tab
      .find("#bm25_reuse_rag_regex")
      .prop("checked");
    cSettings.skip_layer_zero = $tab
      .find("#bm25_skip_layer_zero")
      .prop("checked");
    cSettings.regex_skip_user = $tab
      .find("#bm25_regex_skip_user")
      .prop("checked");
    cSettings.exclude_user = $tab.find("#bm25_exclude_user").prop("checked");

    // 更新常驻条目的值
    const floorCount =
      parseInt($tab.find("#bm25_prompt_floor_count").val(), 10) || 1;

    const floorItem = cSettings.prompt_items?.find(
      (i) => i.id === "floor_content",
    );
    if (floorItem) floorItem.count = floorCount;

    saveGlobalSettings();
    toastr.success("BM25 检索设置已保存！");
  });

  // 1. 总开关逻辑
  $tab.find("#bm25_master_switch").on("change", function () {
    const isEnabled = $(this).prop("checked");
    const globalSettings = getGlobalBm25Settings();
    globalSettings.bm25_enabled = isEnabled;
    saveGlobalSettings();

    if (isEnabled) {
      $tab.find(".bm25-content-area").slideDown(200).removeClass("hidden");
      toastr.success("BM25 检索模块已启用");
    } else {
      $tab.find(".bm25-content-area").slideUp(200, function () {
        $(this).addClass("hidden");
      });
      toastr.info("BM25 检索模块已停用");
    }
  });

  // 2. 词典模块：新增词典
  $tab.find("#btn_bm25_new_dict").on("click", () => {
    const name = prompt("请输入新词典名称：");
    if (name && name.trim() !== "") {
      const dictName = name.trim();
      const globalSettings = getGlobalBm25Settings();

      if (!globalSettings.custom_dicts) globalSettings.custom_dicts = {};
      if (globalSettings.custom_dicts[dictName]) {
        return toastr.warning("该词典名称已存在！");
      }

      // 🗑️ 初始化时不再生成 blacklist 字段
      globalSettings.custom_dicts[dictName] = { words: [] };
      globalSettings.current_dict = dictName;
      saveGlobalSettings();

      $tab
        .find("#bm25_dict_select")
        .append(`<option value="${dictName}" selected>${dictName}</option>`);

      // 🗑️ 移除了清空黑名单 input 和 tags 的代码
      $tab.find("#bm25_words_list").empty();

      toastr.success(`已创建并切换到空白词典: ${dictName}`);
    }
  });

  // --- 分页按钮交互 ---
  $tab.find("#btn_bm25_prev_page").on("click", () => {
    currentDictPage--;
    renderWordsList();
  });

  $tab.find("#btn_bm25_next_page").on("click", () => {
    currentDictPage++;
    renderWordsList();
  });

  // --- 切换词典时，加载数据到草稿箱 ---
  $tab
    .find("#bm25_dict_select")
    .off("change")
    .on("change", async function () {
      const selectedDict = $(this).val();
      const globalSettings = getGlobalBm25Settings();

      if (selectedDict && globalSettings.custom_dicts[selectedDict]) {
        const dictData = globalSettings.custom_dicts[selectedDict];

        // 🗑️ 彻底删除了原有的 "1. 黑名单 UI" 更新逻辑

        // 2. 更新列表
        currentDraftWords = JSON.parse(JSON.stringify(dictData.words || []));
        currentDictPage = 1;
        renderWordsList();

        globalSettings.current_dict = selectedDict;
        saveGlobalSettings();

        const { characterId } = SillyTavern.getContext();
        if (characterId !== undefined) {
          const charSettings = getCharBm25Settings();
          charSettings.bound_dict = selectedDict;
          await saveCharBm25Settings(charSettings);
        }
      }
    });

  // --- 词条内联操作 (增/删/改/查 内存数组) ---
  $tab.on("click", ".btn-edit-word", function () {
    const absIdx = $(this).closest(".bm25-grid-row").data("abs-idx");
    currentDraftWords[absIdx]._isEditing = true;
    renderWordsList(); // 重新渲染当前页，让它变成编辑框
  });

  $tab.on("click", ".btn-cancel-word", function () {
    const absIdx = $(this).closest(".bm25-grid-row").data("abs-idx");
    // 如果是刚新建的且没有任何内容，取消直接当做删除
    if (
      !currentDraftWords[absIdx].index &&
      !currentDraftWords[absIdx].trigger
    ) {
      currentDraftWords.splice(absIdx, 1);
    } else {
      delete currentDraftWords[absIdx]._isEditing;
    }
    renderWordsList();
  });

  $tab.on("click", ".btn-save-word", function () {
    const $editRow = $(this).closest(".bm25-word-edit");
    const absIdx = $editRow.data("abs-idx");

    const newTrigger = $editRow.find(".edit-trigger-val").val().trim();
    const newIndex = $editRow.find(".edit-index-val").val().trim();

    if (!newIndex) return toastr.warning("索引词不能为空");

    // 更新内存数据
    currentDraftWords[absIdx].trigger = newTrigger;
    currentDraftWords[absIdx].index = newIndex;
    delete currentDraftWords[absIdx]._isEditing;

    renderWordsList();
  });

  $tab.on("click", ".btn-del-word", function () {
    const absIdx = $(this).closest(".bm25-grid-row").data("abs-idx");
    currentDraftWords.splice(absIdx, 1);
    renderWordsList();
  });

  $tab
    .find("#btn_bm25_add_word")
    .off("click")
    .on("click", () => {
      // 往草稿数组最后压入一条空数据，并标记为编辑状态
      currentDraftWords.push({ trigger: "", index: "", _isEditing: true });
      // 自动跳转到最后一页
      currentDictPage = Math.ceil(currentDraftWords.length / WORDS_PER_PAGE);
      renderWordsList();

      // 滚动到底部
      const listDiv = $tab.find("#bm25_words_list")[0];
      listDiv.scrollTop = listDiv.scrollHeight;
    });

  // ================= 仅保存词典，不绑定也不重构 =================
  $tab
    .find("#btn_bm25_dict_save_only")
    .off("click")
    .on("click", async () => {
      const currentDictName = $tab.find("#bm25_dict_select").val();
      if (!currentDictName) return toastr.warning("请先选择或创建一个词典");

      const cleanWords = currentDraftWords.filter((w) => {
        delete w._isEditing;
        return w.index !== "";
      });

      // 🟢 直接调用逻辑层：bindToChar 传 false
      const res = await saveDictionaryAndRebuild(
        currentDictName,
        cleanWords,
        false,
      );

      // 刷新 UI 显示
      currentDraftWords = JSON.parse(JSON.stringify(cleanWords));
      renderWordsList();
      refreshLibsUI(getCharBm25Settings().libs || []);
      if (typeof loadAndRenderKbList === "function") loadAndRenderKbList();

      if (res.reason === "auto_build_off" && res.isContentChanged) {
        toastr.warning(`修改已保存，未开启自动构建，关联库已标记为需手动重构`);
      } else if (res.reason === "no_change") {
        toastr.info(`词典 [${currentDictName}] 内容未发生变化`);
      }
    });

  // ================= 终极合并版：保存词典、绑定角色与重构 =================
  $tab
    .find("#btn_bm25_dict_save")
    .off("click")
    .on("click", async () => {
      const currentDictName = $tab.find("#bm25_dict_select").val();
      if (!currentDictName) return toastr.warning("请先选择或创建一个词典");

      const cleanWords = currentDraftWords.filter((w) => {
        delete w._isEditing;
        return w.index !== "";
      });

      // 🟢 直接调用逻辑层：bindToChar 传 true
      const res = await saveDictionaryAndRebuild(
        currentDictName,
        cleanWords,
        true,
      );

      // 刷新 UI 显示
      currentDraftWords = JSON.parse(JSON.stringify(cleanWords));
      renderWordsList();
      refreshLibsUI(getCharBm25Settings().libs || []);
      if (typeof loadAndRenderKbList === "function") loadAndRenderKbList();

      if (res.rebuilt) {
        toastr.success(
          `词典 [${currentDictName}] 已绑定至当前角色！完成相关库同步！`,
        );
      } else if (res.reason === "auto_build_off") {
        toastr.warning(
          "未开启自动构建。所有切片已变更为【待构建】状态，请手动前往面板重构。",
          "BM25 引擎",
          { timeOut: 8000 },
        );
      } else {
        toastr.info(`已确认绑定词典 [${currentDictName}]`);
      }
    });

  // 3. 库管理模块：管理弹窗
  $tab
    .find("#btn_bm25_manage_libs")
    .off("click")
    .on("click", async () => {
      let allBackendLibs = [];
      try {
        allBackendLibs = await $.ajax({
          url: "/api/plugins/anima-rag/bm25/list",
          type: "GET",
          dataType: "json",
        });
        allBackendLibs = allBackendLibs.filter(
          (libName) => !libName.startsWith("kb"),
        );
      } catch (e) {
        toastr.error("获取后端 BM25 库列表失败");
        console.error(e);
        return;
      }

      const charSettings = getCharBm25Settings();
      const boundLibsMap = new Map();
      (charSettings.libs || []).forEach((lib) =>
        boundLibsMap.set(lib.name, lib),
      );
      const globalSettings = getGlobalBm25Settings();

      if (allBackendLibs.length === 0) {
        return toastr.warning("后端没有发现任何 BM25 库，请先通过 RAG 构建");
      }

      // 🟢 提前查一下当前聊天是不是“脏”的
      let hasDirtyData = false;
      const currentLibName = getCurrentBm25LibName();
      try {
        const data = await getBm25SyncList();
        hasDirtyData =
          data.list && data.list.some((item) => item.is_bm25_synced === false);
      } catch (e) {}

      // ✨ 获取所有可用的词典名称，用于生成下拉框选项
      const allDictNames = Object.keys(globalSettings.custom_dicts || {});

      // 拼接渲染 HTML
      const rowsHtml = allBackendLibs
        .map((libName) => {
          const boundInfo = boundLibsMap.get(libName);
          const isBound = !!boundInfo;

          // ✨ 【修复问题 3】尝试读取全局字典映射中的 dirty 状态
          const mappedDictInfo = globalSettings.dict_mapping?.[libName];
          const mappedDict = mappedDictInfo?.dict;
          const isDirtyDict = mappedDictInfo?.dirty === true; // 检查是否因为切换词典变脏

          const dictName =
            mappedDict ||
            (boundInfo && boundInfo.dict
              ? boundInfo.dict
              : globalSettings.current_dict);

          const isCurrent = libName === currentLibName;
          let nameColor = "#ddd";
          let currentBadge = "";

          const needsWarning = (isCurrent && hasDirtyData) || isDirtyDict;

          if (isCurrent) {
            if (needsWarning) {
              nameColor = "#fbbf24";
              currentBadge = `<span style="margin-left: 5px; font-size: 10px; background: rgba(245, 158, 11, 0.2); border: 1px solid rgba(245, 158, 11, 0.4); color: #fbbf24; padding: 2px 6px; border-radius: 10px;">Current ⚠️</span>`;
            } else {
              nameColor = "#34d399";
              currentBadge = `<span style="margin-left: 5px; font-size: 10px; background: rgba(52, 211, 153, 0.2); border: 1px solid rgba(52, 211, 153, 0.4); color: #34d399; padding: 2px 6px; border-radius: 10px;">Current</span>`;
            }
          } else if (needsWarning) {
            // ✨ 如果是历史库，但词典被修改了，依然要标黄
            nameColor = "#fbbf24";
            currentBadge = `<span style="margin-left: 5px; font-size: 10px; background: rgba(245, 158, 11, 0.2); border: 1px solid rgba(245, 158, 11, 0.4); color: #fbbf24; padding: 2px 6px; border-radius: 10px;">⚠️ 需重构</span>`;
          }

          // ✨ 生成该行的下拉框 HTML
          const dictOptionsHtml = allDictNames
            .map(
              (dName) =>
                `<option value="${escapeHtml(dName)}" ${dName === dictName ? "selected" : ""}>${escapeHtml(dName)}</option>`,
            )
            .join("");

          return `
            <div class="bm25-modal-row" style="display:grid; grid-template-columns: minmax(0, 3.5fr) minmax(0, 2fr) 40px 65px; gap:8px; padding: 10px; border-bottom:1px solid rgba(255,255,255,0.05); align-items: center; font-size: 13px;">
                <div class="modal-lib-name" data-libname="${escapeHtml(libName)}" style="font-family: monospace; color:${nameColor}; word-break: break-all; line-height: 1.3;">
                    ${escapeHtml(libName)}${currentBadge}
                </div>
                
                <div style="width: 100%;">
                    <select class="anima-select bm25-select modal-lib-dict-select" style="width: 100%; height: 26px; padding: 0 5px; font-size: 12px; box-sizing: border-box; margin: 0;">
                        ${dictOptionsHtml}
                    </select>
                </div>

                <div style="text-align:center;">
                    <input type="checkbox" class="modal-lib-checkbox" ${isBound ? "checked" : ""} title="关联到当前窗口" style="cursor:pointer; width:16px; height:16px; margin:0;">
                </div>
                <div style="display:flex; gap: 5px; justify-content: flex-end;">
                    <button class="anima-btn secondary small btn-rebuild-modal-lib" title="用所选词典重建该库" style="padding: 0 6px;"><i class="fa-solid fa-rotate-right"></i></button>
                    <button class="anima-btn danger small btn-del-modal-lib" title="彻底删除" style="padding: 0 6px;"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
        `;
        })
        .join("");

      const modalContent = `
        <div style="margin-bottom: 10px; font-size: 12px; color: #888;">
            <i class="fa-solid fa-circle-info"></i> 勾选需要关联到当前角色的库。历史库关联的词典如需更新，请在下拉框选择后点击重建。
        </div>
        <div style="background: rgba(0,0,0,0.2); border-radius: 4px; border: 1px solid #444; overflow: hidden;">
            <div style="display:grid; grid-template-columns: minmax(0, 3.5fr) minmax(0, 2fr) 40px 65px; gap:8px; padding: 10px; background: rgba(255,255,255,0.05); font-weight: bold; font-size: 13px; color: #aaa;">
                <div>BM25 库</div>
                <div>词典配置</div>
                <div style="text-align:center;">关联</div>
                <div style="text-align:right;">操作</div>
            </div>
            <div class="anima-scroll" style="max-height: 350px; overflow-y: auto; padding-right: 5px;">
                ${rowsHtml}
            </div>
        </div>
        <div style="display: flex; gap: 10px; margin-top: 20px;">
            <button class="anima-btn secondary anima-close-bm25-modal" style="flex: 1">取消</button>
            <button class="anima-btn primary" id="btn_modal_save_lib_bind" style="flex: 1"><i class="fa-solid fa-check"></i> 保存关联与映射设置</button>
        </div>
      `;

      // 渲染弹窗
      showBm25Modal("管理全部 BM25 库", modalContent);

      // ================= 彻底删除按钮事件 =================
      $("#anima-bm25-modal-body")
        .off("click", ".btn-del-modal-lib")
        .on("click", ".btn-del-modal-lib", async function () {
          const $row = $(this).closest(".bm25-modal-row");
          const libName = $row.find(".modal-lib-name").attr("data-libname");

          if (
            !confirm(
              `⚠️ 确定要彻底删除底层 BM25 库 [${libName}] 吗？\n删除后该库将从硬盘彻底抹除，不可恢复！`,
            )
          )
            return;

          try {
            const delRes = await $.ajax({
              url: "/api/plugins/anima-rag/bm25/delete_single",
              type: "POST",
              contentType: "application/json",
              data: JSON.stringify({ libName }),
              dataType: "json",
            });

            if (delRes.success) {
              $row.fadeOut(300, function () {
                $(this).remove();
              });
              toastr.success(`库 [${libName}] 已彻底删除`);

              const charSettings = getCharBm25Settings();
              if (charSettings.libs) {
                const newLibs = charSettings.libs.filter(
                  (l) => l.name !== libName,
                );
                if (newLibs.length !== charSettings.libs.length) {
                  await saveCharBm25Settings({ libs: newLibs });
                  refreshLibsUI(newLibs);
                }
              }
            } else {
              toastr.error("删除失败: " + delRes.message);
            }
          } catch (e) {
            toastr.error("请求后端删除异常，请检查控制台");
            console.error(e);
          }
        });

      // ================= 重建按钮事件 =================
      $("#anima-bm25-modal-body")
        .off("click", ".btn-rebuild-modal-lib")
        .on("click", ".btn-rebuild-modal-lib", async function () {
          console.log("[Anima BM25 Debug] ⚡ 重建按钮被点击！");
          const $btn = $(this);
          const $row = $btn.closest(".bm25-modal-row");

          // 剔除徽章文字，拿纯净的库名
          const libName = $row.find(".modal-lib-name").attr("data-libname");

          // ✨ 核心修改：直接从这一行的下拉框里实时获取选中的词典名！
          const selectedDict = $row.find(".modal-lib-dict-select").val();

          if (
            !confirm(
              `⚠️ 确定要清空并重建 BM25 库 [${libName}] 吗？\n将使用词典 [${selectedDict}] 重新分词构建。`,
            )
          )
            return;

          const originalHtml = $btn.html();
          $btn
            .prop("disabled", true)
            .html('<i class="fa-solid fa-spinner fa-spin"></i>');

          try {
            const bm25Config = getBm25BackendConfig(selectedDict);

            const res = await $.ajax({
              url: "/api/plugins/anima-rag/bm25/rebuild_collection",
              type: "POST",
              contentType: "application/json",
              data: JSON.stringify({
                collectionId: libName,
                bm25Config: bm25Config,
              }),
              dataType: "json",
            });

            if (res.success) {
              toastr.success(
                `BM25 库 [${libName}] 重建完成！共写入 ${res.count} 条数据。`,
              );

              // 1. 写回全局映射，解除 dirty 状态
              const globalSettings = getGlobalBm25Settings();
              if (!globalSettings.dict_mapping)
                globalSettings.dict_mapping = {};
              globalSettings.dict_mapping[libName] = {
                dict: selectedDict,
                dirty: false, // 洗白！
              };
              saveGlobalSettings();

              const currentLibName = getCurrentBm25LibName();

              // ✨ 2. 实时洗白弹窗内部当前行的 DOM 样式
              const $nameDiv = $row.find(".modal-lib-name");
              if (libName === currentLibName) {
                $nameDiv.css("color", "#34d399"); // 恢复绿色
                $nameDiv.html(
                  `${escapeHtml(libName)}<span style="margin-left: 5px; font-size: 10px; background: rgba(52, 211, 153, 0.2); border: 1px solid rgba(52, 211, 153, 0.4); color: #34d399; padding: 2px 6px; border-radius: 10px;">Current</span>`,
                );
              } else {
                $nameDiv.css("color", "#ddd"); // 恢复历史库默认灰色
                $nameDiv.html(`${escapeHtml(libName)}`); // 抹除警告徽章
              }

              // 3. 如果重建的是当前库，还需要洗白底层的切片同步状态
              if (libName === currentLibName) {
                try {
                  const data = await getBm25SyncList();
                  const idsToMark = (data.list || []).map(
                    (item) => item.unique_id,
                  );
                  if (idsToMark.length > 0)
                    await markAllBm25SyncedBatch(idsToMark);
                } catch (e) {
                  console.warn("[Anima BM25] 同步前端状态失败:", e);
                }
              }

              // ✨ 4. 无论重建哪个库，都无条件触发外部列表刷新！
              refreshLibsUI(getCharBm25Settings().libs || []);
            } else {
              toastr.error(`重建失败: ${res.message}`);
            }
          } catch (e) {
            console.error(e);
            toastr.error(`重建请求异常，请检查控制台`);
          } finally {
            $btn.prop("disabled", false).html(originalHtml);
          }
        });

      // ================= 词典下拉框实时修改事件 (实时保存 + UI变黄) =================
      $("#anima-bm25-modal-body")
        .off("change", ".modal-lib-dict-select")
        .on("change", ".modal-lib-dict-select", function () {
          const $select = $(this);
          const $row = $select.closest(".bm25-modal-row");
          const $nameDiv = $row.find(".modal-lib-name");

          // ✨ 通过 data-libname 精准获取库名，无需处理徽章字符串
          const libName = $nameDiv.attr("data-libname");
          const newDict = $select.val();

          // 1. 实时保存到全局映射表，并立刻标记为脏数据 (dirty: true)
          const globalSettings = getGlobalBm25Settings();
          if (!globalSettings.dict_mapping) globalSettings.dict_mapping = {};

          const oldDict = globalSettings.dict_mapping[libName]?.dict;
          // 如果真的发生了改变
          if (oldDict !== newDict) {
            globalSettings.dict_mapping[libName] = {
              dict: newDict,
              dirty: true,
            };
            saveGlobalSettings();

            // 2. 实时更新 UI 为黄色警告样式
            const isCurrent = libName === getCurrentBm25LibName();
            $nameDiv.css("color", "#fbbf24"); // 文字变黄

            if (isCurrent) {
              $nameDiv.html(
                `${escapeHtml(libName)}<span style="margin-left: 5px; font-size: 10px; background: rgba(245, 158, 11, 0.2); border: 1px solid rgba(245, 158, 11, 0.4); color: #fbbf24; padding: 2px 6px; border-radius: 10px;">Current ⚠️</span>`,
              );
            } else {
              // 非当前库，加上“需重构”的黄色徽章
              $nameDiv.html(
                `${escapeHtml(libName)}<span style="margin-left: 5px; font-size: 10px; background: rgba(245, 158, 11, 0.2); border: 1px solid rgba(245, 158, 11, 0.4); color: #fbbf24; padding: 2px 6px; border-radius: 10px;">⚠️ 需重构</span>`,
              );
            }
            refreshLibsUI(getCharBm25Settings().libs || []);
          }
        });

      // ================= 保存关联设置按钮事件 =================
      $("#btn_modal_save_lib_bind")
        .off("click")
        .on("click", async () => {
          const updatedLibs = [];
          const globalSettings = getGlobalBm25Settings();
          if (!globalSettings.dict_mapping) globalSettings.dict_mapping = {};

          $("#anima-bm25-modal-body .modal-lib-checkbox").each(function () {
            if ($(this).prop("checked")) {
              const $row = $(this).closest(".bm25-modal-row");
              const libName = $row.find(".modal-lib-name").attr("data-libname");

              // ✨ 改为从下拉框取值
              const dictName = $row.find(".modal-lib-dict-select").val();

              updatedLibs.push({
                name: libName,
                dict: dictName,
                status: "normal",
              });

              // ✨ 将勾选的库与其对应的词典更新到全局映射表中
              globalSettings.dict_mapping[libName] = {
                dict: dictName,
                dirty: false,
              };
            }
          });

          saveGlobalSettings();

          const isSuccess = await saveCharBm25Settings({ libs: updatedLibs });
          if (!isSuccess) return;

          $("#anima-bm25-modal").addClass("hidden");
          toastr.success("库关联设置已保存到角色卡，全局映射已更新");
          refreshLibsUI(updatedLibs);
        });
    });

  // 主界面：保存库绑定状态（存入角色卡）
  $tab
    .find("#btn_bm25_lib_bind_save")
    .off("click")
    .on("click", async () => {
      const currentLibs = [];
      $tab.find(".bm25-file-item").each(function () {
        // 🟢 修改此处：精准获取专属 class，防止吞噬徽章文本
        const libName = $(this).find(".bm25-lib-name-text").text().trim();
        currentLibs.push({ name: libName, status: "normal" });
      });

      // 调用存入角色卡的 API
      await saveCharBm25Settings({ libs: currentLibs });
      toastr.success("当前 BM25 库绑定状态已成功保存到角色卡！");
    });

  // 4. 工作区逻辑：切片同步状态面板 (连通后端 + 进度条 + 真实索引词)
  // 4. 工作区逻辑：切片同步状态面板 (连通后端 + 进度条 + 真实索引词 + 前端分页)
  $tab
    .find("#btn_bm25_scan_build")
    .off("click")
    .on("click", async () => {
      const currentDictName = $("#bm25_dict_select").val() || "未选择词典";
      const currentLibName = getCurrentBm25LibName();
      const globalSettings = getGlobalBm25Settings();
      const isDictDirty =
        globalSettings.dict_mapping?.[currentLibName]?.dirty === true;

      // ================= 新增：分页变量缓存 =================
      let currentSlicePage = 1;
      const SLICES_PER_PAGE = 20;
      let allSyncSlices = [];

      // ================= 新增：单页渲染逻辑 =================
      const renderSlicePage = () => {
        const totalItems = allSyncSlices.length;
        const totalPages = Math.max(1, Math.ceil(totalItems / SLICES_PER_PAGE));

        // 越界保护
        if (currentSlicePage > totalPages) currentSlicePage = totalPages;
        if (currentSlicePage < 1) currentSlicePage = 1;

        if (totalItems === 0) {
          $("#bm25_slice_list_container").html(
            `<div style="padding:20px; text-align:center; color:#aaa;">暂无切片记录</div>`,
          );
          return;
        }

        const startIndex = (currentSlicePage - 1) * SLICES_PER_PAGE;
        const endIndex = startIndex + SLICES_PER_PAGE;
        const pageSlices = allSyncSlices.slice(startIndex, endIndex);

        // 🧠 提取词典规则，用于在前端模拟计算“真实索引词”
        const dictData = SillyTavern.getContext().extensionSettings
          ?.anima_memory_system?.bm25?.custom_dicts?.[currentDictName] || {
          words: [],
        };

        const rowsHtml = pageSlices
          .map((item) => {
            const isSynced = item.is_bm25_synced;
            const vectorBadge = isSynced
              ? `<span class="anima-tag-badge status-badge" style="background:rgba(74, 222, 128, 0.2); border-color:#22c55e; color:#4ade80; white-space:nowrap;"><i class="fa-solid fa-check"></i> 已同步</span>`
              : `<span class="anima-tag-badge status-badge" style="background:rgba(248, 113, 113, 0.2); border-color:#ef4444; color:#f87171; white-space:nowrap;"><i class="fa-solid fa-clock"></i> 待构建</span>`;

            let finalIndexWords = [];
            (dictData.words || []).forEach((rule) => {
              const triggers = (rule.trigger || "")
                .split(/[,，|]/)
                .map((t) => t.trim())
                .filter(Boolean);
              const indexWord = (rule.index || "").trim();

              const combinedTriggers = [...triggers];
              if (indexWord && !combinedTriggers.includes(indexWord)) {
                combinedTriggers.push(indexWord);
              }

              const hasTrigger = combinedTriggers.some((trig) =>
                item.fullText.includes(trig),
              );

              if (hasTrigger && indexWord) {
                finalIndexWords.push(indexWord);
              }
            });
            finalIndexWords = [...new Set(finalIndexWords)].filter(Boolean);

            const tagsHtml =
              finalIndexWords.length > 0
                ? finalIndexWords
                    .map(
                      (t) =>
                        `<span class="anima-tag-badge" style="border-color:#3b82f6; color:#60a5fa;">${escapeHtml(t)}</span>`,
                    )
                    .join("")
                : `<span style="color:#666;">(无匹配索引词)</span>`;

            const cleanText = (item.fullText || "")
              .split("\n")
              .map((line) =>
                line.replace(
                  /^[ \f\r\t\v\u3000\u00a0]+|[ \f\r\t\v\u3000\u00a0]+$/g,
                  "",
                ),
              )
              .filter((line) => line.length > 0)
              .join("\n");
            const tagsJson = escapeHtml(JSON.stringify(item.tags || []));

            return `
            <div class="anima-history-entry slice-sync-row" data-uid="${item.unique_id}" data-entryuid="${item.entryUid}" data-batchid="${item.batch_id}" data-tags="${tagsJson}" data-synced="${isSynced}" style="margin-bottom: 8px; border-radius: 6px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); overflow: hidden;">
                <div class="anima-history-header toggle-content-area" style="cursor:pointer; display:flex; justify-content:space-between; align-items:center; padding: 10px; background: rgba(0,0,0,0.2);">
                    <div class="anima-history-meta" style="flex:1; display:flex; align-items:center; flex-wrap:wrap; gap:8px;">
                        <span style="color:#fbbf24; font-weight:bold; white-space:nowrap; font-family: monospace;">#${escapeHtml(item.unique_id)}</span>
                        ${vectorBadge}
                        <span style="color:#888; font-size:12px; white-space:nowrap;"><i class="fa-solid fa-layer-group"></i> 楼层 ${item.range_start}-${item.range_end}</span>
                    </div>
                    
                    <div class="anima-history-actions" style="display:flex; align-items:center; gap:8px;">
                        <button class="anima-btn small btn-rebuild-single-slice ${isSynced ? "secondary" : "primary"}" title="构建该切片索引" style="padding: 2px 8px; height: 26px;">
                            <i class="fa-solid fa-rotate-right"></i> ${isSynced ? "重建" : "构建"}
                        </button>
                        <i class="fa-solid fa-chevron-right toggle-icon" style="font-size: 12px; color: #aaa; width:15px; text-align:center; transition: transform 0.2s;"></i>
                    </div>
                </div>
                
                <div class="anima-history-content" style="display:none; padding: 10px; font-size:12px; color:#ddd; line-height: 1.6; border-top: 1px solid rgba(255,255,255,0.05); background: rgba(0,0,0,0.4);">${escapeHtml(cleanText).replace(/\n/g, "<br>")}</div>
                
                <div class="anima-tags-wrapper" style="padding: 6px 10px; border-top: 1px dashed rgba(255,255,255,0.05); background: rgba(0,0,0,0.2);">
                    <div class="tags-view-mode" style="color:#aaa; font-size:12px; display:flex; align-items:center; gap:5px; flex-wrap:wrap;">
                        <i class="fa-solid fa-book-bookmark" style="font-size:10px; color:#3b82f6;"></i> ${tagsHtml}
                    </div>
                </div>
            </div>`;
          })
          .join("");

        // 拼装分页控件
        const paginationHtml = `
            <div class="bm25-pagination" style="padding-top: 10px; border-top: 1px dashed rgba(255,255,255,0.1); margin-bottom: 10px;">
                <button id="btn_slice_prev_page" class="anima-btn secondary small" ${currentSlicePage === 1 ? "disabled" : ""}><i class="fa-solid fa-chevron-left"></i></button>
                <span id="slice_page_info" style="margin: 0 10px; font-size: 12px; color: #888;">第 ${currentSlicePage} / ${totalPages} 页</span>
                <button id="btn_slice_next_page" class="anima-btn secondary small" ${currentSlicePage === totalPages ? "disabled" : ""}><i class="fa-solid fa-chevron-right"></i></button>
            </div>`;

        $("#bm25_slice_list_container").html(rowsHtml + paginationHtml);
      };

      // ================= 修改：数据拉取逻辑 =================
      const renderSyncList = async () => {
        $("#bm25_slice_list_container").html(
          '<div style="padding:20px; text-align:center; color:#aaa;"><i class="fa-solid fa-spinner fa-spin"></i> 正在读取世界书...</div>',
        );

        const data = await getBm25SyncList();
        allSyncSlices = data.list || [];

        $("#bm25_sync_wb_name").text(data.wbName);
        $("#bm25_sync_dict_name").text(currentDictName);
        $("#bm25_sync_total").text(allSyncSlices.length);

        renderSlicePage();
      };

      const modalHtml = `
        <style>
            /* 隐藏指定容器的滚动条但保留滚动功能 */
            .bm25-hide-scrollbar::-webkit-scrollbar { display: none; }
            .bm25-hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        </style>
        
        <div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 15px; font-size: 13px; color: #aaa;">
            ${
              isDictDirty
                ? `
            <div style="padding:8px; margin-bottom:5px; background:rgba(245, 158, 11, 0.15); border:1px solid rgba(245, 158, 11, 0.4); color:#fbbf24; border-radius:4px; font-size:12px; text-align:center;">
                ⚠️ 词典已修改，现存切片索引可能已失效，强烈建议立刻【一键重构】。
            </div>`
                : ""
            }
            <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 10px;">
                <div style="color: #aaa; display: flex; align-items: center; word-break: break-all; padding-top: 4px;">
                    <i class="fa-solid fa-book" style="margin-right: 5px;"></i> 世界书：<span id="bm25_sync_wb_name" style="color:#ddd; font-weight:bold; margin-left: 2px;">加载中...</span>
                </div>
                <div style="display: flex; gap: 5px; flex-shrink: 0;">
                    <button id="btn_bm25_sync_refresh" class="anima-btn secondary small" style="margin: 0;"><i class="fa-solid fa-arrows-rotate"></i> 刷新</button>
                    <button id="btn_modal_rebuild_all_dirty" class="anima-btn primary small" style="margin: 0;"><i class="fa-solid fa-hammer"></i> 一键重构</button>
                </div>
            </div>
            <div style="display: flex; align-items: center;">
                <i class="fa-solid fa-spell-check" style="margin-right: 5px; width: 14px; text-align: center;"></i> 词典：<span id="bm25_sync_dict_name" style="color:#ddd; font-weight:bold; margin-left: 2px;">加载中...</span>
            </div>
            <div style="display: flex; align-items: center;">
                <i class="fa-solid fa-chart-pie" style="margin-right: 5px; width: 14px; text-align: center;"></i> 共 <span id="bm25_sync_total" style="color:#ddd; font-weight:bold; margin-left: 2px; margin-right: 2px;">0</span> 个片段
            </div>
            
            <div id="bm25_rebuild_progress_container" style="display:none; margin-top: 5px;">
                <div style="display:flex; justify-content:space-between; font-size:12px; color:#aaa; margin-bottom:6px;">
                    <span>正在连通后端重构 BM25...</span>
                    <span id="bm25_progress_text" style="font-family:monospace; color:#34d399;">0 / 0</span>
                </div>
                <div style="width:100%; height:6px; background:rgba(255,255,255,0.1); border-radius:3px; overflow:hidden;">
                    <div id="bm25_progress_bar" style="width:0%; height:100%; background:#34d399; transition:width 0.2s linear;"></div>
                </div>
            </div>
        </div>
        
       <div class="anima-scroll bm25-hide-scrollbar" id="bm25_slice_list_container" style="min-height: 300px; height: 60vh; overflow-y: auto; padding-right: 5px;"></div>
    `;

      showBm25Modal("切片构建状态", modalHtml);
      await renderSyncList();

      // ================= 绑定交互事件 =================

      // 新增：翻页事件绑定
      $("#anima-bm25-modal-body")
        .off("click", "#btn_slice_prev_page")
        .on("click", "#btn_slice_prev_page", function () {
          currentSlicePage--;
          renderSlicePage();
        });

      $("#anima-bm25-modal-body")
        .off("click", "#btn_slice_next_page")
        .on("click", "#btn_slice_next_page", function () {
          currentSlicePage++;
          renderSlicePage();
        });

      $("#anima-bm25-modal-body")
        .off("click", ".toggle-content-area")
        .on("click", ".toggle-content-area", function (e) {
          if ($(e.target).closest(".btn-rebuild-single-slice").length > 0)
            return;
          const $row = $(this).closest(".slice-sync-row");
          const $content = $row.find(".anima-history-content");
          const $icon = $(this).find(".toggle-icon");
          if ($content.is(":visible")) {
            $content.slideUp(150);
            $icon.css("transform", "rotate(0deg)");
          } else {
            $content.slideDown(150);
            $icon.css("transform", "rotate(90deg)");
          }
        });

      $("#btn_bm25_sync_refresh")
        .off("click")
        .on("click", async function () {
          const $icon = $(this).find("i");
          $icon.addClass("fa-spin");
          // 刷新时回到第一页也可以，或者保持当前页。这里选择保持并在 renderSlicePage 越界保护
          await renderSyncList();
          $icon.removeClass("fa-spin");
          toastr.success("状态已刷新");
        });

      // 单条重构（附带传参给后端）
      $("#anima-bm25-modal-body")
        .off("click", ".btn-rebuild-single-slice")
        .on("click", ".btn-rebuild-single-slice", async function (e) {
          e.stopPropagation();
          const $row = $(this).closest(".slice-sync-row");
          const uniqueId = $row.data("uid");
          const entryUid = $row.data("entryuid");
          const batchId = $row.data("batchid");
          const tags = $row.data("tags") || [];
          const $btn = $(this);

          $btn
            .prop("disabled", true)
            .html('<i class="fa-solid fa-spinner fa-spin"></i>');

          try {
            const success = await triggerBm25BuildSingle(
              uniqueId,
              entryUid,
              batchId,
              tags,
            );
            if (success) {
              toastr.success(`切片 #${uniqueId} BM25 构建成功`);
              await renderSyncList(); // 重新拉取数据，渲染当前页
              refreshLibsUI(getCharBm25Settings().libs || []);
            } else {
              $btn
                .prop("disabled", false)
                .html('<i class="fa-solid fa-rotate-right"></i> 重试');
            }
          } catch (err) {
            toastr.error(`构建失败: ${err.message}`);
            $btn
              .prop("disabled", false)
              .html('<i class="fa-solid fa-rotate-right"></i> 重试');
          }
        });

      // 一键重构（采用全局丝滑进度条）
      $("#btn_modal_rebuild_all_dirty")
        .off("click")
        .on("click", async function () {
          const $btn = $(this);
          const originalHtml = $btn.html();
          const currentDictName = $("#bm25_sync_dict_name").text(); // 获取当前弹窗显示的词典名
          const $progressBar = $("#bm25_progress_bar");
          const $progressText = $("#bm25_progress_text");
          const $progressContainer = $("#bm25_rebuild_progress_container");

          // 1. 获取当前同步列表中的所有切片（这里走缓存或重新请求都可以，保险起见使用现有缓存数组或后端数据）
          const allItems = allSyncSlices;

          if (allItems.length === 0) {
            toastr.info("当前没有可重构的切片内容");
            return;
          }

          if (
            !confirm(
              `确定要基于词典 [${currentDictName}] 重新构建全部 ${allItems.length} 个切片吗？\n这将覆盖现有的 BM25 索引。`,
            )
          ) {
            return;
          }

          // 2. UI 状态切换：禁用按钮，显示进度条
          $btn
            .prop("disabled", true)
            .html(
              '<i class="fa-solid fa-spinner fa-spin"></i> 正在全量重构...',
            );
          $progressContainer.fadeIn(200);
          $progressBar.css("width", "0%");
          $progressText.text(`0 / ${allItems.length}`);

          try {
            let successCount = 0;

            // 3. 循环触发重构
            for (let i = 0; i < allItems.length; i++) {
              const item = allItems[i];

              const success = await triggerBm25BuildSingle(
                item.unique_id,
                item.entryUid,
                item.batch_id,
                item.tags,
                true, // skipCaptureTags
              );

              if (success) successCount++;

              // 4. 更新进度条 UI
              const percent = Math.round(((i + 1) / allItems.length) * 100);
              $progressBar.css("width", `${percent}%`);
              $progressText.text(`${i + 1} / ${allItems.length}`);
            }

            // 5. 完成后的处理
            toastr.success(
              `全量重构完成！成功更新 ${successCount} 条切片。`,
              "BM25 引擎",
            );

            // 洗白全局脏标记（如果是当前库）
            const globalSettings = getGlobalBm25Settings();
            if (globalSettings.dict_mapping?.[currentLibName]) {
              globalSettings.dict_mapping[currentLibName].dirty = false;
              saveGlobalSettings();
            }

            // 刷新列表显示
            await renderSyncList();
            refreshLibsUI(getCharBm25Settings().libs || []);
          } catch (e) {
            console.error("[Anima BM25] 无条件重构失败:", e);
            toastr.error("重构过程中发生异常，请检查控制台");
          } finally {
            $btn.prop("disabled", false).html(originalHtml);
            setTimeout(() => $progressContainer.fadeOut(500), 2000);
          }
        });
    });

  // ================= 🟢 [新增] 查看 BM25 最近检索日志 =================
  $tab
    .find("#btn_bm25_view_log")
    .off("click")
    .on("click", () => {
      const payload = getLastRetrievalPayload();

      if (!payload) {
        toastr.info("暂无检索记录 (请先进行一次对话)");
        return;
      }

      const bm25ChatResults = payload.bm25_chat_results || [];

      // 🟢 修复 1：优先读取后端的 bm25Query (也就是处理过的上下文)
      const queryText = payload.bm25Query || payload.query || "未记录查询词";
      const queryLen = queryText.length;

      const totalResultLen = bm25ChatResults.reduce(
        (acc, item) => acc + (item.text || "").length,
        0,
      );
      const headerStyle = "font-size:12px; color:#aaa; font-weight:bold;";

      let contentHtml = `
        <div style="margin-bottom:10px; padding:10px; background:rgba(0,0,0,0.2); border-radius:4px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
                <div style="${headerStyle}">Query (文本源)</div>
                <div style="${headerStyle}; font-family:monospace;">Length: ${queryLen} 字符数</div>
            </div>
            <div style="color:#eee; font-size:13px; white-space: pre-wrap;">${escapeHtml(queryText)}</div>
        </div>
        
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
            <div style="${headerStyle}">BM25 词频匹配切片 (${bm25ChatResults.length})</div>
            <div style="${headerStyle}; font-family:monospace;">总字数：${totalResultLen}</div>
        </div>
    `;

      if (bm25ChatResults.length > 0) {
        // 🟢 核心修复：在展示日志时，强制按分数降序（最高分排在最前面）
        bm25ChatResults.sort((a, b) => b.score - a.score);

        contentHtml += bm25ChatResults
          .map((item, idx) => {
            const displayId = item.index || item.id || "N/A";

            // 🟢 兜底所有可能的数据库字段名
            const sourceDb =
              item.source ||
              item.dbId ||
              item.collectionId ||
              item._source_collection ||
              "Unknown";

            const displayScore = `Score: ${typeof item.score === "number" ? item.score.toFixed(4) : item.score}`;

            // ✨✨ 核心 UI 升级：判断是否为意图拦截切片
            const isIntent = item._is_intent === true;

            // 定义两套主题配色：意图(紫色/雷达) vs 常规(绿色/词频)
            const themeColor = isIntent ? "#c084fc" : "#34d399";
            const borderColor = isIntent ? "#a855f7" : "#10b981";
            const bgColor = isIntent
              ? "rgba(168, 85, 247, 0.15)"
              : "rgba(16, 185, 129, 0.15)";
            const shadowCss = isIntent
              ? "box-shadow: 0 0 10px rgba(168, 85, 247, 0.3);"
              : "";

            // 生成专属徽章
            const badgeHtml = isIntent
              ? `<span style="background:${borderColor}; color:#fff; font-size:10px; padding:2px 6px; border-radius:10px; margin-right:6px; font-weight:bold;"><i class="fa-solid fa-bolt"></i> 意图拦截</span>`
              : "";

            let matchInfoHtml = "";

            // 🟢 [终极版] 前端 UI 显示过滤器
            const filterNoise = (termsArray) => {
              const uiStopWords = new Set([
                "放",
                "回",
                "问",
                "手",
                "耳",
                "后",
                "还",
                "去",
                "来",
                "像",
                "般",
                "为",
                "内",
              ]);

              return termsArray
                .filter((t) => {
                  const cleanT = t.trim();
                  if (!cleanT) return false;
                  if (cleanT.length === 1 && /[a-zA-Z0-9]/.test(cleanT))
                    return false;
                  if (!/[\u4e00-\u9fa5a-zA-Z]/.test(cleanT)) return false;
                  if (uiStopWords.has(cleanT)) return false;
                  return true;
                })
                .join(", ");
            };

            // 渲染命中词条信息
            if (item.match && typeof item.match === "object") {
              const matchedTerms = filterNoise(Object.keys(item.match));
              if (matchedTerms) {
                const matchTitle = isIntent
                  ? "⏱️ 意图锁定实体:"
                  : "🎯 命中核心词:";
                matchInfoHtml = `<div style="font-size:11px; color:${themeColor}; margin-bottom:6px; background: rgba(0,0,0, 0.2); padding: 4px 6px; border-radius: 4px; border: 1px dashed ${themeColor};"><b>${matchTitle}</b> ${escapeHtml(matchedTerms)}</div>`;
              }
            } else if (item.terms && Array.isArray(item.terms)) {
              const matchedTerms = filterNoise(item.terms);
              if (matchedTerms) {
                const matchTitle = isIntent
                  ? "⏱️ 意图锁定实体:"
                  : "🎯 命中核心词:";
                matchInfoHtml = `<div style="font-size:11px; color:${themeColor}; margin-bottom:6px; background: rgba(0,0,0, 0.2); padding: 4px 6px; border-radius: 4px; border: 1px dashed ${themeColor};"><b>${matchTitle}</b> ${escapeHtml(matchedTerms)}</div>`;
              }
            }

            // 最终组装该条目的 HTML
            return `
                <div class="anima-preview-block" style="border:1px solid ${borderColor}; margin-bottom:8px; border-radius:4px; overflow:hidden; ${shadowCss}">
                    <div class="block-header" style="background:${bgColor}; padding:6px 10px; font-size:12px; display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            ${badgeHtml}
                            <span style="color:${themeColor}; font-weight:bold;">#${idx + 1}</span>
                            <span style="color:#fff; font-weight:bold; margin:0 6px; font-family:monospace;">[${escapeHtml(displayId)}]</span>
                            <span style="color:${themeColor};">${escapeHtml(displayScore)}</span>
                        </div>
                        <span style="color:#aaa; font-size:11px;" title="来源数据库">
                            <i class="fa-solid fa-database" style="margin-right:4px;"></i>${escapeHtml(sourceDb)}
                        </span>
                    </div>
                    <div class="block-content" style="padding:10px; font-size:12px; color:#ccc; background:rgba(0,0,0,0.2); max-height:150px; overflow-y:auto;">
                        ${matchInfoHtml}
                        <div style="white-space:pre-wrap;">${escapeHtml(item.text)}</div>
                    </div>
                </div>`;
          })
          .join("");
      } else {
        contentHtml += `<div style="padding:20px; text-align:center; color:#666;">本次未命中任何 BM25 聊天切片</div>`;
      }

      showBm25Modal(
        "BM25 聊天检索日志",
        `<div style="padding:10px;">${contentHtml}</div>`,
      );
    });

  // ================= 工作模块保存与增量补齐逻辑 =================
  $tab
    .find("#btn_bm25_work_save")
    .off("click")
    .on("click", async () => {
      // 1. 获取全局设置并使用【正确的 HTML ID】保存 UI 配置
      const globalSettings = getGlobalBm25Settings();
      globalSettings.bm25_enabled = $tab
        .find("#bm25_master_switch")
        .prop("checked");
      globalSettings.auto_build = $tab.find("#bm25_auto_build").prop("checked");
      globalSettings.auto_capture_tags = $tab
        .find("#bm25_auto_capture_tags")
        .prop("checked"); // 🐛 已修复
      globalSettings.search_top_k =
        parseInt($tab.find("#bm25_search_k").val()) || 3; // 🐛 已修复

      saveGlobalSettings();
      toastr.success("BM25 工作模块设置已保存！");

      // ✨ 2. 核心建议落实：检查并自动补齐未同步的切片
      if (globalSettings.auto_build) {
        (async () => {
          try {
            let chatRebuildCount = 0;
            let kbRebuildCount = 0;
            const currentLibName = getCurrentBm25LibName();

            // ----------------------------------------------------
            // 阶段 A：扫描并全量重构因词典修改而标脏的 BM25 库
            // ----------------------------------------------------
            // 1. 扫描聊天 BM25 库
            if (globalSettings.dict_mapping) {
              const dirtyChatLibs = Object.entries(
                globalSettings.dict_mapping,
              ).filter(
                ([libName, mapInfo]) =>
                  mapInfo.dirty === true && !libName.startsWith("kb_"),
              );

              for (const [libName, mapInfo] of dirtyChatLibs) {
                try {
                  const res = await $.ajax({
                    url: "/api/plugins/anima-rag/bm25/rebuild_collection",
                    type: "POST",
                    contentType: "application/json",
                    data: JSON.stringify({
                      collectionId: libName,
                      bm25Config: getBm25BackendConfig(mapInfo.dict),
                    }),
                    dataType: "json",
                  });

                  if (res.success) {
                    globalSettings.dict_mapping[libName].dirty = false;
                    chatRebuildCount++;

                    // 如果恰好是当前聊天的库，顺手洗白前端切片状态
                    if (libName === currentLibName) {
                      const data = await getBm25SyncList();
                      const idsToMark = (data.list || []).map(
                        (item) => item.unique_id,
                      );
                      if (idsToMark.length > 0)
                        await markAllBm25SyncedBatch(idsToMark);
                    }
                  }
                } catch (err) {
                  console.error(
                    `[Anima BM25] 自动重构聊天库 ${libName} 失败`,
                    err,
                  );
                }
              }
            }

            // 2. 扫描知识库 BM25 库
            const extensionSettings =
              SillyTavern.getContext().extensionSettings;
            const kbSettings = extensionSettings?.anima_memory_system?.kb;

            if (kbSettings && kbSettings.dict_mapping) {
              const dirtyKbs = Object.entries(kbSettings.dict_mapping).filter(
                ([libName, mapInfo]) =>
                  typeof mapInfo === "object" && mapInfo.dirty === true,
              );

              for (const [kbName, mapInfo] of dirtyKbs) {
                try {
                  const dictContent =
                    globalSettings.custom_dicts[mapInfo.dict]?.words || [];
                  const resKb = await $.ajax({
                    url: "/api/plugins/anima-rag/bm25/rebuild_collection",
                    type: "POST",
                    contentType: "application/json",
                    data: JSON.stringify({
                      collectionId: kbName,
                      bm25Config: { enabled: true, dictionary: dictContent },
                    }),
                    dataType: "json",
                  });

                  if (resKb.success) {
                    kbSettings.dict_mapping[kbName].dirty = false;
                    kbRebuildCount++;
                  }
                } catch (err) {
                  console.error(
                    `[Anima KB] 自动重构知识库 ${kbName} 失败`,
                    err,
                  );
                }
              }
            }

            if (chatRebuildCount > 0 || kbRebuildCount > 0) {
              saveGlobalSettings();
              toastr.success(
                `扫描到历史脏数据！已自动重构 ${chatRebuildCount} 个聊天库和 ${kbRebuildCount} 个知识库。`,
                "BM25 引擎",
              );
            }

            // ----------------------------------------------------
            // 阶段 B：增量补齐未同步的新切片 (仅针对当前聊天)
            // ----------------------------------------------------
            const data = await getBm25SyncList();
            const syncList = data.list || [];
            const unsyncedItems = syncList.filter(
              (item) => item.is_bm25_synced === false,
            );

            if (unsyncedItems.length > 0) {
              toastr.info(
                `检测到 ${unsyncedItems.length} 条未同步切片，开始后台增量补齐...`,
                "BM25 引擎",
              );
              let successCount = 0;
              for (const item of unsyncedItems) {
                const success = await triggerBm25BuildSingle(
                  item.unique_id,
                  item.entryUid,
                  item.batch_id,
                  item.tags,
                  true, // 跳过重新捕获标签，防止循环
                );
                if (success) successCount++;
              }
              if (successCount > 0) {
                toastr.success(
                  `增量补齐完成！成功同步 ${successCount}/${unsyncedItems.length} 条切片。`,
                  "BM25 引擎",
                );
              }
            }
          } catch (e) {
            console.error("[Anima BM25] 自动重构/补齐后台任务失败", e);
            toastr.error("执行自动构建任务时发生异常，请检查控制台。");
          } finally {
            // 无论成功与否，最后统一刷新主界面 UI，让各种黄色的警告按钮变回绿色
            refreshLibsUI(getCharBm25Settings().libs || []);
            if (typeof loadAndRenderKbList === "function")
              loadAndRenderKbList();
          }
        })();
      }
    });

  $tab.on("click", ".btn-cancel-word", function () {
    const $editRow = $(this).closest(".bm25-word-edit");
    const $viewRow = $editRow.prev(".bm25-word-view");
    // 这里只是取消，真实的输入框数据重置应该在未来接上后台逻辑，目前仅切换 UI
    $editRow.css("display", "none");
    $viewRow.css("display", "grid");
  });

  // ================= 导入 / 导出 模块 =================

  // 1. 导出功能 (多选弹窗 + 多个 JSON 文件下载)
  $tab
    .find("#btn_bm25_dict_export")
    .off("click")
    .on("click", () => {
      const globalSettings = getGlobalBm25Settings();
      const dictNames = Object.keys(globalSettings.custom_dicts || {});

      if (dictNames.length === 0) {
        return toastr.warning("当前没有任何可导出的词典");
      }

      // 构建多选列表 HTML
      const rowsHtml = dictNames
        .map(
          (name) => `
          <div style="display:flex; justify-content:space-between; align-items:center; padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.05);">
              <span style="color:#ddd; font-family:monospace;">${escapeHtml(name)}</span>
              <input type="checkbox" class="export-dict-cb" value="${escapeHtml(name)}" style="cursor:pointer; width:16px; height:16px; margin:0;">
          </div>
      `,
        )
        .join("");

      const modalHtml = `
          <div style="margin-bottom:15px; color:#aaa; font-size:13px;">请勾选你需要导出的词典（浏览器可能会提示允许下载多个文件，请点击允许）：</div>
          <div style="max-height: 300px; overflow-y: auto; background: rgba(0,0,0,0.2); border: 1px solid #444; border-radius: 4px;">
              ${rowsHtml}
          </div>
          <div style="display: flex; gap: 10px; margin-top: 20px;">
              <button class="anima-btn secondary anima-close-bm25-modal" style="flex: 1">取消</button>
              <button class="anima-btn primary" id="btn_confirm_export_dicts" style="flex: 1"><i class="fa-solid fa-download"></i> 导出选中的词典</button>
          </div>
      `;

      // 借用已有的通用弹窗函数
      showBm25Modal("批量导出词典", modalHtml);

      // 确认导出逻辑
      $("#btn_confirm_export_dicts")
        .off("click")
        .on("click", () => {
          const selected = [];
          $(".export-dict-cb:checked").each(function () {
            selected.push($(this).val());
          });

          if (selected.length === 0)
            return toastr.warning("请至少勾选一个词典");

          selected.forEach((dictName) => {
            const dictData = globalSettings.custom_dicts[dictName];
            // 包装一层，加上特定的 type 签名，防止以后导入了奇怪的 JSON
            const exportObj = {
              type: "anima_bm25_dictionary",
              version: 1,
              name: dictName,
              data: dictData,
            };

            const dataStr =
              "data:text/json;charset=utf-8," +
              encodeURIComponent(JSON.stringify(exportObj, null, 2));
            const downloadAnchorNode = document.createElement("a");
            downloadAnchorNode.setAttribute("href", dataStr);
            downloadAnchorNode.setAttribute(
              "download",
              `anima_dict_${dictName}.json`,
            );
            document.body.appendChild(downloadAnchorNode);
            downloadAnchorNode.click();
            downloadAnchorNode.remove();
          });

          $("#anima-bm25-modal").addClass("hidden");
          toastr.success(`成功触发了 ${selected.length} 个词典的下载请求`);
        });
    });

  // 2. 导入功能 (支持多文件上传 + 防冲突重命名)
  $tab
    .find("#btn_bm25_dict_import")
    .off("click")
    .on("click", () => {
      // 动态创建一个不可见的 input 来拉起系统文件选择器
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";
      input.multiple = true; // 允许一次选多个 JSON

      input.onchange = async (e) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        let successCount = 0;
        const globalSettings = getGlobalBm25Settings();

        for (const file of files) {
          try {
            const text = await file.text();
            const json = JSON.parse(text);

            // 安全校验：确认是我们专属的导出格式
            if (
              json.type === "anima_bm25_dictionary" &&
              json.name &&
              json.data
            ) {
              let targetName = json.name;
              let counter = 1;

              // 防冲突：如果同名词典已存在，自动添加后缀
              while (globalSettings.custom_dicts[targetName]) {
                targetName = `${json.name}_导入(${counter})`;
                counter++;
              }

              // 写入全局变量
              globalSettings.custom_dicts[targetName] = json.data;

              // 将新词典插入到下拉框的最后
              $("#bm25_dict_select").append(
                `<option value="${escapeHtml(targetName)}">${escapeHtml(targetName)}</option>`,
              );

              // 顺便把最后一次导入的设为当前激活词典
              globalSettings.current_dict = targetName;
              $("#bm25_dict_select").val(targetName);

              successCount++;
            } else {
              toastr.warning(
                `文件 [${file.name}] 不是有效的 Anima 词典格式，已跳过。`,
              );
            }
          } catch (err) {
            console.error(err);
            toastr.error(`解析文件 [${file.name}] 失败，可能已损坏。`);
          }
        }

        if (successCount > 0) {
          saveGlobalSettings();
          // 触发 change 事件，让 UI 重新渲染黑名单和词条列表为最新导入的词典
          $("#bm25_dict_select").trigger("change");
          toastr.success(`成功导入了 ${successCount} 个词典！`);
        }
      };

      input.click(); // 触发文件选择
    });

  // --- 删除当前词典 ---
  $tab
    .find("#btn_bm25_del_dict")
    .off("click")
    .on("click", () => {
      const globalSettings = getGlobalBm25Settings();
      const dictNames = Object.keys(globalSettings.custom_dicts || {});
      const currentDictName = $tab.find("#bm25_dict_select").val();

      if (dictNames.length <= 1) {
        return toastr.warning("必须至少保留一个词典，无法删除最后的兜底词典！");
      }

      if (
        confirm(`⚠️ 确定要永久删除词典 [${currentDictName}] 吗？此操作不可逆！`)
      ) {
        // 从全局对象中剔除
        delete globalSettings.custom_dicts[currentDictName];

        // 随便找一个剩下的词典作为新的激活词典
        const remainingNames = Object.keys(globalSettings.custom_dicts);
        const nextDict = remainingNames[0];
        globalSettings.current_dict = nextDict;

        saveGlobalSettings();

        // 刷新 UI
        $tab
          .find(`#bm25_dict_select option[value='${currentDictName}']`)
          .remove();
        $tab.find("#bm25_dict_select").val(nextDict);
        $tab.find("#bm25_dict_select").trigger("change");

        toastr.success(`词典 [${currentDictName}] 已被删除`);
      }
    });

  // ================= BM25 库 导入 / 导出 =================

  // 库导出
  $tab
    .find("#btn_bm25_lib_export")
    .off("click")
    .on("click", async () => {
      let allBackendLibs = [];
      try {
        allBackendLibs = await $.ajax({
          url: "/api/plugins/anima-rag/bm25/list",
          type: "GET",
          dataType: "json",
        });
      } catch (e) {
        return toastr.error("获取后端 BM25 库列表失败");
      }

      if (allBackendLibs.length === 0)
        return toastr.warning("当前没有可导出的 BM25 库");

      const rowsHtml = allBackendLibs
        .map(
          (name) => `
          <div style="display:flex; justify-content:space-between; align-items:center; padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.05);">
              <span style="color:#ddd; font-family:monospace;">${escapeHtml(name)}</span>
              <input type="checkbox" class="export-lib-cb" value="${escapeHtml(name)}" style="cursor:pointer; width:16px; height:16px; margin:0;">
          </div>
      `,
        )
        .join("");

      const modalHtml = `
          <div style="margin-bottom:15px; color:#aaa; font-size:13px;">请勾选需要备份导出的 BM25 库：</div>
          <div style="max-height: 300px; overflow-y: auto; background: rgba(0,0,0,0.2); border: 1px solid #444; border-radius: 4px;">
              ${rowsHtml}
          </div>
          <div style="display: flex; gap: 10px; margin-top: 20px;">
              <button class="anima-btn secondary anima-close-bm25-modal" style="flex: 1">取消</button>
              <button class="anima-btn primary" id="btn_confirm_export_libs" style="flex: 1"><i class="fa-solid fa-download"></i> 导出选中的库</button>
          </div>
      `;

      showBm25Modal("批量导出 BM25 库", modalHtml);

      $("#btn_confirm_export_libs")
        .off("click")
        .on("click", async () => {
          const selected = [];
          $(".export-lib-cb:checked").each(function () {
            selected.push($(this).val());
          });

          if (selected.length === 0) return toastr.warning("请至少勾选一个库");

          let successCount = 0;
          for (const libName of selected) {
            try {
              // 👇 使用 $.ajax 坐顺风车，自动携带 CSRF Token 👇
              const jsonRes = await $.ajax({
                url: "/api/plugins/anima-rag/bm25/export_single",
                type: "POST",
                contentType: "application/json",
                data: JSON.stringify({ libName }),
                dataType: "json",
              });

              if (jsonRes.success) {
                // 打包成安全格式
                const exportObj = {
                  type: "anima_bm25_index",
                  version: 1,
                  name: libName,
                  raw: jsonRes.data,
                };

                const dataStr =
                  "data:text/json;charset=utf-8," +
                  encodeURIComponent(JSON.stringify(exportObj));
                const downloadAnchorNode = document.createElement("a");
                downloadAnchorNode.setAttribute("href", dataStr);
                downloadAnchorNode.setAttribute(
                  "download",
                  `bm25_index_${libName}.json`,
                );
                document.body.appendChild(downloadAnchorNode);
                downloadAnchorNode.click();
                downloadAnchorNode.remove();
                successCount++;
              } else {
                toastr.error(`[${libName}] 导出失败: ${jsonRes.message}`);
              }
            } catch (err) {
              console.error(err);
              toastr.error(`[${libName}] 请求后端异常`);
            }
          }

          $("#anima-bm25-modal").addClass("hidden");
          toastr.success(`成功触发了 ${successCount} 个库的下载请求`);
        });
    });

  $tab
    .find("#btn_bm25_lib_import")
    .off("click")
    .on("click", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";
      input.multiple = true;

      input.onchange = async (e) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        toastr.info("正在上传并导入库，请稍候...");

        // 1. 替换点：使用 $.ajax 提前拉取现有库列表，用于防冲突校验
        let existingLibs = [];
        try {
          existingLibs = await $.ajax({
            url: "/api/plugins/anima-rag/bm25/list",
            type: "GET",
            dataType: "json",
          });
        } catch (e) {
          console.warn("获取库列表失败，可能是初次使用或网络异常", e);
        }

        let successCount = 0;
        for (const file of files) {
          try {
            const text = await file.text();
            const json = JSON.parse(text);

            if (json.type === "anima_bm25_index" && json.name && json.raw) {
              let targetName = json.name;
              let counter = 1;

              // 防冲突命名处理
              while (existingLibs.includes(targetName)) {
                targetName = `${json.name}_导入(${counter})`;
                counter++;
              }

              // 2. 替换点：使用 $.ajax 发送给后端保存
              try {
                const uploadJson = await $.ajax({
                  url: "/api/plugins/anima-rag/bm25/import_single",
                  type: "POST",
                  contentType: "application/json",
                  data: JSON.stringify({ libName: targetName, data: json.raw }),
                  dataType: "json",
                });

                if (uploadJson.success) {
                  existingLibs.push(targetName); // 更新本地内存防止下一个文件冲突
                  successCount++;
                } else {
                  toastr.error(
                    `保存 [${file.name}] 到后端失败: ${uploadJson.message}`,
                  );
                }
              } catch (ajaxErr) {
                toastr.error(`保存 [${file.name}] 时发生网络请求异常`);
                console.error(ajaxErr);
              }
            } else {
              toastr.warning(
                `[${file.name}] 签名不符，不是有效的 BM25 库备份。`,
              );
            }
          } catch (err) {
            toastr.error(`解析文件 [${file.name}] 失败，文件可能已损坏。`);
          }
        }

        if (successCount > 0)
          toastr.success(
            `成功导入了 ${successCount} 个 BM25 库！点击“管理”按钮即可查看并关联。`,
          );
      };

      input.click();
    });

  const STContext =
    typeof SillyTavern !== "undefined" ? SillyTavern.getContext() : null;
  if (STContext && STContext.eventSource && STContext.event_types) {
    STContext.eventSource.on(STContext.event_types.CHAT_CHANGED, () => {
      // 当聊天加载完成、或者切换角色时，重新拉取当前角色的专属配置并刷新 UI
      const charSettings = getCharBm25Settings();
      refreshLibsUI(charSettings.libs || []);
    });
  }
  document.addEventListener("anima_summary_written", () => {
    const charSettings = getCharBm25Settings();
    // 这里调用咱们上一轮刚刚修复好的 refreshLibsUI，它会无条件向底层查询切片状态
    refreshLibsUI(charSettings.libs || []);
  });

  setTimeout(() => $tab.find("#bm25_dict_select").trigger("change"), 50);
}

export async function refreshLibsUI(libs) {
  const container = $("#bm25_current_libs_container");
  const currentLibName = getCurrentBm25LibName();
  const globalSettings = getGlobalBm25Settings();

  // 1. 无条件向底层询问当前聊天有没有未同步的切片（解开原来的 libs.some 限制）
  let hasDirtyData = false;
  try {
    const data = await getBm25SyncList();
    hasDirtyData =
      data.list && data.list.some((item) => item.is_bm25_synced === false);
  } catch (e) {
    console.warn("[Anima BM25] 获取脏数据状态失败", e);
  }

  // 2. 提取当前库的词典修改状态
  const isCurrentDictDirty =
    globalSettings.dict_mapping?.[currentLibName]?.dirty === true;
  const needsSyncWarning = hasDirtyData || isCurrentDictDirty;

  // 3. 无论有没有绑定库，都接管并更新【切片同步状态】按钮的 UI
  const $scanBtn = $("#btn_bm25_scan_build");
  $scanBtn.removeClass("secondary primary");

  if (needsSyncWarning) {
    // ⚠️ 黄色：待重构状态
    $scanBtn
      .css({
        background: "rgba(245, 158, 11, 0.2)",
        color: "#fbbf24",
        border: "1px solid rgba(245, 158, 11, 0.4)",
      })
      .html('<i class="fa-solid fa-triangle-exclamation"></i> 待重构');
  } else {
    // 🟢 绿色：已同步状态
    $scanBtn
      .css({
        background: "rgba(52, 211, 153, 0.2)",
        color: "#34d399",
        border: "1px solid rgba(52, 211, 153, 0.4)",
      })
      .html('<i class="fa-solid fa-check"></i> 已同步');
  }

  // 4. 下方才是库列表的渲染逻辑，如果为空在这里 return 就不会影响上面的按钮了
  if (!libs || libs.length === 0) {
    container.html(
      '<div style="color:#666; text-align:center;">暂无绑定的 BM25 库</div>',
    );
    return;
  }

  // 5. 渲染绑定的库列表
  const libsHtml = libs
    .map((lib) => {
      const isCurrent = lib.name === currentLibName;
      const isDictDirty =
        globalSettings.dict_mapping?.[lib.name]?.dirty === true;
      const needsWarning = (isCurrent && hasDirtyData) || isDictDirty;

      let color, icon, extraTag, titleText;

      if (isCurrent) {
        if (needsWarning) {
          color = "#fbbf24";
          icon = `<i class="fa-solid fa-triangle-exclamation" style="color:${color};"></i>`;
          extraTag = `<span style="font-size:10px; background:rgba(245, 158, 11, 0.2); border: 1px solid rgba(245, 158, 11, 0.4); color:#fbbf24; padding:2px 6px; border-radius:10px; margin-left:6px;">⚠️ 需重构</span>`;
          titleText = isDictDirty
            ? "当前库词典已更新，请重构"
            : "存在未同步切片，请前往重构";
        } else {
          color = "#34d399";
          icon = `<i class="fa-solid fa-database" style="color:${color};"></i>`;
          extraTag = `<span style="font-size:10px; background:rgba(52, 211, 153, 0.2); border: 1px solid rgba(52, 211, 153, 0.4); color:#34d399; padding:2px 6px; border-radius:10px; margin-left:6px;">Current</span>`;
          titleText = "当前聊天关联库 (已同步)";
        }
      } else {
        if (needsWarning) {
          color = "#fbbf24";
          icon = `<i class="fa-solid fa-triangle-exclamation" style="color:${color};"></i>`;
          extraTag = `<span style="font-size:10px; background:rgba(245, 158, 11, 0.2); border: 1px solid rgba(245, 158, 11, 0.4); color:#fbbf24; padding:2px 6px; border-radius:10px; margin-left:6px;">⚠️ 词典已更新</span>`;
          titleText = "历史库词典已更改，建议重构";
        } else {
          color = "#94a3b8";
          icon = `<i class="fa-solid fa-box-archive" style="color:${color};"></i>`;
          extraTag = `<span style="font-size:10px; background:rgba(148, 163, 184, 0.2); border: 1px solid rgba(148, 163, 184, 0.4); color:#94a3b8; padding:2px 6px; border-radius:10px; margin-left:6px;">Histroy</span>`;
          titleText = "其他聊天的历史库";
        }
      }

      return `
        <div class="bm25-file-item" title="${titleText}" style="border-color: ${needsWarning ? "#fbbf24" : "var(--anima-primary)"};">
            <div style="font-family: monospace; display: flex; align-items: center; gap: 10px;">
                ${icon}
                <span class="bm25-lib-name-text" style="color: ${isCurrent ? "#ddd" : "#999"}; word-break: break-all;">${escapeHtml(lib.name)}</span>
                ${extraTag}
            </div>
        </div>`;
    })
    .join("");

  container.html(libsHtml);
}

function renderBm25PromptList() {
  const cSettings = getGlobalBm25Settings().content_settings;
  if (!cSettings.prompt_items) cSettings.prompt_items = [];

  const $list = $("#bm25_prompt_list");
  $list.empty();

  // 过滤出自定义文本条目（排除掉常驻的 core 条目），并保留原始索引以便修改
  const textItems = cSettings.prompt_items
    .map((item, originalIndex) => ({ ...item, originalIndex }))
    .filter((i) => i.type === "text");

  textItems.forEach((item) => {
    const $row = $(`
            <div class="anima-prompt-item" style="background: rgba(0,0,0,0.2); border: 1px solid #444; border-radius: 4px; padding: 10px; margin-bottom: 8px; box-sizing: border-box; width: 100%;">
                <div class="view-mode" style="display:flex; align-items:center; gap:10px;">
                <i class="fa-solid fa-bars anima-drag-handle" style="cursor: grab; color: #888;"></i>
                <div style="width: 80px; text-align:center;">
                    <span class="anima-tag-badge" style="background:rgba(255,255,255,0.1); border-color:#555; color:#ccc;">${item.role.toUpperCase()}</span>
                </div>
                <span class="prompt-title-view" style="flex:1; color:#ddd; font-weight:bold; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(item.title)}</span>
                <button class="anima-btn secondary small btn-edit-prompt" title="编辑" style="padding: 0 8px; height: 26px;"><i class="fa-solid fa-pen"></i></button>
                <button class="anima-btn danger small btn-del-prompt" title="删除" style="padding: 0 8px; height: 26px;"><i class="fa-solid fa-trash"></i></button>
                <button class="anima-btn secondary small btn-toggle-prompt" title="折叠/展开" style="padding: 0 8px; height: 26px;"><i class="fa-solid fa-chevron-down"></i></button>
            </div>
            
            <div class="edit-mode" style="display:none; align-items:center; gap:5px;">
                <i class="fa-solid fa-bars" style="color: transparent; width: 14px;"></i>
                <select class="anima-select edit-role" style="width:100px; height: 28px; margin:0; padding: 0 5px;">
                    <option value="system" ${item.role === "system" ? "selected" : ""}>SYSTEM</option>
                    <option value="user" ${item.role === "user" ? "selected" : ""}>USER</option>
                    <option value="assistant" ${item.role === "assistant" ? "selected" : ""}>ASSISTANT</option>
                </select>
                <input type="text" class="anima-input edit-title" value="${escapeHtml(item.title)}" style="flex:1; height: 28px; margin:0;" placeholder="条目名称">
                <button class="anima-btn primary small btn-save-prompt" title="确认修改" style="padding: 0 8px; height: 26px;"><i class="fa-solid fa-check"></i></button>
                <button class="anima-btn danger small btn-cancel-prompt" title="取消修改" style="padding: 0 8px; height: 26px;"><i class="fa-solid fa-xmark"></i></button>
            </div>

            <div class="content-area" style="display:none; margin-top:10px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 10px;">
                <textarea class="anima-textarea prompt-content-val" rows="3" style="width:100%; margin:0; font-size:12px;" readonly placeholder="在此输入提示词内容...">${escapeHtml(item.content)}</textarea>
            </div>
        </div>
        `);

    // 1. 展开/折叠
    $row.find(".btn-toggle-prompt").on("click", function () {
      const $content = $row.find(".content-area");
      const $icon = $(this).find("i");
      if ($content.is(":visible")) {
        $content.slideUp(150);
        $icon.removeClass("fa-chevron-up").addClass("fa-chevron-down");
      } else {
        $content.slideDown(150);
        $icon.removeClass("fa-chevron-down").addClass("fa-chevron-up");
      }
    });

    // 2. 进入编辑模式
    $row.find(".btn-edit-prompt").on("click", function () {
      $row.find(".view-mode").hide();
      $row.find(".edit-mode").css("display", "flex");

      // 自动展开文本框并解除只读
      const $content = $row.find(".content-area");
      $content.slideDown(150);
      $row
        .find(".prompt-content-val")
        .removeAttr("readonly")
        .css("border-color", "var(--anima-primary)");
    });

    // 3. 取消编辑模式
    $row.find(".btn-cancel-prompt").on("click", function () {
      $row.find(".edit-mode").hide();
      $row.find(".view-mode").css("display", "flex");
      // 还原文本框数据和外观
      $row
        .find(".prompt-content-val")
        .attr("readonly", true)
        .css("border-color", "#444")
        .val(item.content);
      $row.find(".edit-title").val(item.title);
      $row.find(".edit-role").val(item.role);
    });

    // 4. ✔ 确认修改
    $row.find(".btn-save-prompt").on("click", function () {
      const newRole = $row.find(".edit-role").val();
      const newTitle = $row.find(".edit-title").val().trim();
      const newContent = $row.find(".prompt-content-val").val();

      if (!newTitle) return toastr.warning("标题不能为空");

      // 同步到全局内存
      cSettings.prompt_items[item.originalIndex] = {
        type: "text",
        role: newRole,
        title: newTitle,
        content: newContent,
      };

      // 重新渲染局部UI
      renderBm25PromptList();
    });

    // 5. 删除条目
    $row.find(".btn-del-prompt").on("click", function () {
      if (confirm("确定删除此条目吗？(删除后仍需点击下方保存配置)")) {
        cSettings.prompt_items.splice(item.originalIndex, 1);
        renderBm25PromptList();
      }
    });

    $list.append($row);
  });
}
