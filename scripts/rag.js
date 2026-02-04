import {
  toggleAllSummariesState,
  syncRagSettingsToWorldbook,
} from "./worldbook_api.js"; // 🟢 引入 updateSummaryContent

import { getAvailableCollections, getSmartCollectionId } from "./rag_logic.js";
import { RegexListComponent, getRegexModalHTML } from "./regex_ui.js";
import {
  renderStrategyTable,
  renderPromptList,
  renderFileList,
  renderHolidayModal,
  constructRagQueryMock,
  renderTagTable,
  renderUnifiedFileList,
} from "./rag_ui_components.js";

import {
  showVectorStatusModal,
  checkAndSyncDirtyVectors,
} from "./rag_status.js";

let regexComponent = null;
// ==========================================
// rag.js - RAG 向量数据库设置界面 (V4 - 完美复刻版)
// ==========================================
// 1. 定义一个内存变量
let _lastRetrievalResult = null;

// ✅ 2. 新增：导出清理函数
export function clearLastRetrievalResult() {
  _lastRetrievalResult = null;
  $("#rag_btn_last_result").removeClass("glow-effect"); // 去掉高亮
  // console.log("[Anima RAG] Last result cache cleared.");
}

// 3. 导出这个更新函数 (这就 rag_logic.js 调用的那个)
export function updateLastRetrievalResult(data) {
  _lastRetrievalResult = data;

  // 可选：给按钮加个视觉反馈，告诉用户有新数据了
  const $btn = $("#rag_btn_last_result");
  $btn.addClass("glow-effect");
  // 你可以在 CSS 里加个简单动画，或者只是简单地闪烁一下
  setTimeout(() => $btn.removeClass("glow-effect"), 1000);
}

const PARENT_MODULE_NAME = "anima_memory_system";

// 默认全局设置
export const DEFAULT_RAG_SETTINGS = {
  rag_enabled: true,

  knowledge_base: {
    delimiter: "", // 切片自定义分隔符 (如 "###")
    chunk_size: 500, // 切片字符数 (delimiter为空时生效)
    search_top_k: 3, // 每个文档检索数量
    min_score: 0.5, // 知识库最低相关度
  },

  // === 1. 基础区域 (通用) ===
  min_score: 0.5,
  base_count: 2, // 既是未开启时的总数，也是开启后的“基础切片”数量
  // 虚拟时间模式 (新增)
  virtual_time_mode: false,

  // === 2. 分布式策略开关 ===
  distributed_retrieval: true,

  // === 3. 详细策略配置 (新) ===
  strategy_settings: {
    candidate_multiplier: 2,
    important: { labels: ["Important"], count: 1 },

    // 节日 (自动匹配)
    special: { count: 1 },

    // 🔥 新增：生理 (Period) 独立配置
    period: { count: 1 },

    // 状态 (Status) 独立配置
    status: {
      labels: ["Sick", "Injury"], // 这里的 labels 变为“只读”，由 rules 自动生成用于显示
      count: 1,
      // 新增 rules 数组
      rules: [
        // 示例结构
        // { tag: "Injury", path: "Player.HP", op: "<", value: "50" },
        // { tag: "Sick", path: "Player.Status", op: "includes", value: "Sick" }
      ],
    },

    diversity: { count: 2 },
  },

  holidays: [{ date: "12-25", name: "Christmas", trigger_days: 7 }], // 示例数据
  // 生理周期配置 (新增)
  period_config: {
    enabled: true, // 默认开启
    events: [], // 默认清空 (空数组)
  },

  regex_strings: [],
  skip_layer_zero: true,
  regex_skip_user: true, // 注意补全这个之前的配置
  vector_prompt: [{ type: "context", count: 2 }],
  auto_vectorize: true,
  injection_settings: {
    strategy: "constant", // constant | selective
    position: "at_depth", // at_depth | before_character_definition | after_character_definition
    role: "system", // system | user | assistant
    depth: 9999,
    order: 100,
    recent_count: 2,
    template:
      "<recalledMemories>\n{{rag}}\n</recalledMemories>\n<immediateHistory>\n{{recent_history}}\n</immediateHistory>",
  },
  knowledge_injection: {
    enabled: true,
    strategy: "constant",
    position: "before_character_definition",
    role: "system",
    depth: 0,
    template: "<knowledge>\n{{knowledge}}\n</knowledge>", // 默认模板
  },
};

const CHARACTER_SETTING_KEYS = [
  "distributed_retrieval",
  "virtual_time_mode",
  "strategy_settings", // 包含 Important, Special, Period, Status, Diversity
  "holidays", // 节日配置通常也跟角色世界观相关
  "period_config", // 生理期配置跟角色绑定
];
const GLOBAL_STRATEGY_SUB_KEYS = ["candidate_multiplier"];
// ==========================================
// 1. 数据存取逻辑
// ==========================================
export function getRagSettings() {
  const context = SillyTavern.getContext();

  // A. 基础：获取全局设置（包含技术参数）
  const parentSettings = context.extensionSettings[PARENT_MODULE_NAME] || {};
  const globalSettings =
    parentSettings.rag || structuredClone(DEFAULT_RAG_SETTINGS);
  let merged = { ...globalSettings };

  // B. 覆盖：尝试从角色卡读取个性化策略
  const charId = context.characterId;
  if (charId !== undefined) {
    const character = context.characters[charId];
    const charExtensions = character?.data?.extensions?.anima_rag_settings;

    if (charExtensions) {
      CHARACTER_SETTING_KEYS.forEach((key) => {
        if (Object.hasOwn(charExtensions, key)) {
          merged[key] = structuredClone(charExtensions[key]);
        }
      });
    }
  }

  // C. 特殊处理：确保 candidate_multiplier 始终取自全局
  if (merged.strategy_settings) {
    merged.strategy_settings.candidate_multiplier =
      globalSettings.candidate_multiplier ||
      globalSettings.strategy_settings?.candidate_multiplier ||
      2;
  }

  return merged;
}

export async function saveRagSettings(settings) {
  const context = SillyTavern.getContext();

  // --- 1. 处理全局部分 (extensionSettings) ---
  if (!context.extensionSettings[PARENT_MODULE_NAME]) {
    context.extensionSettings[PARENT_MODULE_NAME] = {};
  }

  const globalPart = structuredClone(settings);
  // 移除角色卡特有的个性化配置
  CHARACTER_SETTING_KEYS.forEach((key) => delete globalPart[key]);

  // 强制将倍率存入全局根目录或保留在全局对象中
  globalPart.candidate_multiplier =
    settings.strategy_settings?.candidate_multiplier || 2;

  context.extensionSettings[PARENT_MODULE_NAME].rag = globalPart;
  context.saveSettingsDebounced();

  // --- 2. 处理角色卡部分 (Character Extensions) ---
  const charId = context.characterId;
  if (charId !== undefined) {
    const charPart = {};
    CHARACTER_SETTING_KEYS.forEach((key) => {
      if (settings[key] !== undefined) {
        charPart[key] = structuredClone(settings[key]);
      }
    });

    // 角色卡内不存储全局技术参数 (倍率)
    if (charPart.strategy_settings) {
      delete charPart.strategy_settings.candidate_multiplier;
    }

    await context.writeExtensionField(charId, "anima_rag_settings", charPart);
  }
}

// 🟢 [新增] 获取当前聊天关联的知识库文件
export function getChatKbFiles() {
  const context = SillyTavern.getContext();
  if (!context.chatId || !context.chatMetadata) return [];
  return context.chatMetadata["anima_kb_active_files"] || [];
}

// 🟢 [新增] 保存知识库关联
export async function saveChatKbFiles(files) {
  const context = SillyTavern.getContext();
  if (!context.chatId) return;
  const uniqueFiles = [...new Set(files)].filter(Boolean);
  context.chatMetadata["anima_kb_active_files"] = uniqueFiles;
  await context.saveMetadata();
  console.log("[Anima KB] Metadata saved:", uniqueFiles);
}

export function getChatRagFiles() {
  const context = SillyTavern.getContext();
  if (!context.chatId || !context.chatMetadata) return [];

  // 如果是 undefined (从未设置过)，返回 undefined 以便 init 判断“首次”
  return context.chatMetadata["anima_rag_active_files"];
}

export async function saveChatRagFiles(files) {
  const context = SillyTavern.getContext();
  if (!context.chatId) return;

  // 🟢 核心修复：强制去重，过滤空值
  const uniqueFiles = [...new Set(files)].filter(Boolean);

  context.chatMetadata["anima_rag_active_files"] = uniqueFiles;
  await context.saveMetadata();
  console.log("[Anima RAG] Metadata saved:", uniqueFiles);
}

export function escapeHtml(text) {
  if (!text) return text;
  return text
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ==========================================
// 2. 初始化入口
// ==========================================

export function initRagSettings() {
  const container = document.getElementById("tab-rag");
  if (!container) return;

  const context = SillyTavern.getContext();
  const currentChatId = context ? context.chatId : null;
  const settings = getRagSettings();

  // 1. 获取 Metadata 中的数据
  let ragFiles = getChatRagFiles();

  // 🟢 修改点 A：记录是否是初次加载（undefined）
  const isFirstLoad = ragFiles === undefined;

  // 🟢 修改点 B：不再强行绑定 currentChatId！
  // 如果是 undefined，就初始化为空数组，保持界面干净
  ragFiles = ragFiles || [];

  renderMainUI(container, settings, ragFiles, currentChatId);

  // 🟢 修改点 C：异步执行“智能发现”逻辑
  // 只有在从未设置过（FirstLoad）且有聊天ID时才检查
  if (isFirstLoad && currentChatId) {
    tryAutoBindExistingDB();
  }
}

// 🟢 新增辅助函数：尝试自动绑定已存在的、命名正确的数据库
async function tryAutoBindExistingDB() {
  // 1. 获取标准化的后端ID (e.g. "角色名_2023-05-12_...")
  const smartId = getSmartCollectionId();
  if (!smartId) return;

  try {
    // 2. 问后端：你有哪些数据库？
    const availableDbs = await getAvailableCollections();

    // 3. 检查：我们要找的 smartId 是否真的存在？
    if (availableDbs && availableDbs.includes(smartId)) {
      console.log(`[Anima RAG] 发现已存在的同名数据库，自动关联: ${smartId}`);

      // 4. 存在才关联，并且关联的是 smartId (带下划线的)，不是原始 ID
      await saveChatRagFiles([smartId]);

      // 5. 刷新界面显示
      renderUnifiedFileList();
    } else {
      console.log(`[Anima RAG] 暂无同名数据库 (${smartId})，保持未关联状态。`);
      // 什么都不做，界面保持为空，符合你的要求
    }
  } catch (e) {
    console.warn("[Anima RAG] 自动关联检查失败:", e);
  }
}

// ==========================================
// 3. 渲染逻辑
// ==========================================

function renderMainUI(container, settings, ragFiles, currentChatId) {
  const safeRagFiles = ragFiles || [];

  const styleFix = `
    <style>
        /* 复用 Summary 样式 */
        .anima-rag-tag-table { width: 100%; border-collapse: collapse; margin-top: 10px; background: rgba(0,0,0,0.1); border-radius: 4px; }
        .anima-rag-tag-table th, .anima-rag-tag-table td { padding: 8px 10px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .anima-rag-tag-table th { font-size: 12px; color: #aaa; font-weight: normal; }
        .anima-rag-file-item { display: flex; justify-content: space-between; align-items: center; padding: 10px; background: rgba(255,255,255,0.05); border-radius: 4px; margin-bottom: 5px; border: 1px solid transparent; }
        .anima-rag-file-item:hover { border-color: rgba(255,255,255,0.1); background: rgba(255,255,255,0.08); }
        
        /* 提示词列表样式 */
        .anima-prompt-item { background: rgba(0,0,0,0.2); border: 1px solid #444; border-radius: 4px; padding: 10px; margin-bottom: 8px; }
        .anima-prompt-item.context { border-color: #3b82f6; background: rgba(59, 130, 246, 0.1); }
        .anima-drag-handle { cursor: grab; color: #888; margin-right: 10px; }
        
        /* 正则列表样式 (Row模式) */
        .anima-regex-item.is-row { background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.05); border-radius: 4px; padding: 8px; margin-bottom: 5px; }
        
        /* 历史记录/向量状态样式 */
        .anima-history-entry { margin-bottom: 5px; border: 1px solid #444; border-radius: 4px; background: rgba(0,0,0,0.2); }
        .anima-history-header { padding: 8px 10px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
        .anima-history-content { display: none; padding: 10px; border-top: 1px solid rgba(255,255,255,0.05); white-space: pre-wrap; word-wrap: break-word; opacity: 1 !important; mask-image: none !important; }
        .anima-tag-badge { background:rgba(255,255,255,0.1); padding:2px 8px; border-radius:10px; font-size:12px; margin-right:5px; border:1px solid #555; }
        
        /* 辅助类 */
        .hidden { display: none !important; }
        
        /* 🟢 修复：注入配置模块样式 */
        .anima-compact-input { display: flex; flex-direction: column; gap: 4px; }
        .anima-label-small { font-size: 12px; color: #aaa; font-weight: bold; margin-bottom: 2px; }
        
        /* 🟢 核心修复：强制增加高度，防止文字被遮挡 */
        .rag-inject-control {
            height: 38px !important;       /* 增加高度 */
            min-height: 38px !important;
            font-size: 13px !important;
            padding: 0 10px !important;    /* 左右内边距 */
            line-height: 36px !important;  /* 垂直居中 */
            box-sizing: border-box !important;
        }
        select.rag-inject-control {
            appearance: auto;              /* 确保下拉箭头显示 */
            padding-right: 25px !important;
        }
        
        .disabled-input { opacity: 0.5; pointer-events: none; filter: grayscale(1); }

        /* 新增：通用输入框样式 */
        .anima-textarea {
            width: 100%;
            background-color: rgba(0, 0, 0, 0.2); /* 稍微调整以适配 RAG 的深色背景 */
            border: 1px solid #444;
            color: #eee;
            padding: 10px;
            border-radius: 6px;
            margin-bottom: 10px;
            font-size: 13px;
            box-sizing: border-box;
            resize: vertical;
        }
        .anima-textarea:focus {
            outline: none;
            border-color: var(--anima-primary);
            background-color: rgba(0, 0, 0, 0.3);
        }
    </style>`;

  const masterSwitchHtml = `
        <div class="anima-setting-group" style="margin-bottom: 10px;">
            <div class="anima-card" style="border-left: 4px solid var(--anima-primary);">
                <div class="anima-flex-row">
                    <div class="anima-label-group">
                        <span class="anima-label-text" style="font-size: 1.1em; font-weight: bold;">向量功能总开关</span>
                        <span class="anima-desc-inline">开启后启用自动向量化、聊天检索与注入功能</span>
                    </div>
                    <label class="anima-switch">
                        <input type="checkbox" id="rag_master_switch" ${settings.rag_enabled ? "checked" : ""}>
                        <span class="slider round"></span>
                    </label>
                </div>
            </div>
        </div>
    `;
  const contentVisibilityClass = settings.rag_enabled ? "" : "hidden";

  const mainContentHtml =
    styleFix +
    `
        <div id="rag_main_content_wrapper" class="${contentVisibilityClass}">
            
            <div class="anima-setting-group">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 5px;">
                    <h2 class="anima-title" style="margin:0;"><i class="fa-solid fa-database"></i> 数据与任务</h2>
                    <div style="display:flex; gap:5px;">
                         <button id="rag_btn_status" class="anima-btn secondary small" title="当前聊天向量状态">
                             <i class="fa-solid fa-list-check"></i> 当前聊天向量
                         </button>
                         <button id="rag_btn_last_result" class="anima-btn secondary small" title="查看最近一次生成的检索详情">
                             <i class="fa-solid fa-magnifying-glass"></i> 查看最近检索
                         </button>
                    </div>
                </div>

                <div class="anima-card">
                    <div class="anima-flex-row">
                        <div class="anima-label-group">
                            <span class="anima-label-text">聊天记录数据库</span>
                        </div>
                        <div style="display:flex; gap:5px;">
                            <input type="file" id="rag_input_import_zip" accept=".zip" style="display:none;" />
                        
                            <button id="rag_btn_upload_zip" class="anima-btn secondary small" title="导入 .zip 数据库">
                                <i class="fa-solid fa-file-import"></i> 导入
                            </button>
                            <button id="rag_btn_download_zip" class="anima-btn secondary small" title="导出当前聊天数据库">
                                <i class="fa-solid fa-file-export"></i> 导出
                            </button>
                            <button id="rag_btn_import" class="anima-btn primary small" title="将已存在的数据库关联到当前聊天">
                                <i class="fa-solid fa-link"></i> 管理
                            </button>
                        </div>
                    </div>
                    <div id="rag_file_list" style="margin-top: 10px;"></div>
                    
                    <div class="anima-divider"></div>

                    <div class="anima-flex-row">
                        <div class="anima-label-group">
                            <span class="anima-label-text">自动向量化</span>
                            <span class="anima-desc-inline">当聊天总结更新时自动同步</span>
                        </div>
                        <label class="anima-switch">
                            <input type="checkbox" id="rag_auto_vectorize" ${settings.auto_vectorize ? "checked" : ""}>
                            <span class="slider round"></span>
                        </label>
                    </div>
                    <div style="margin-top: 10px;">
                        <button id="rag_btn_save_settings_top" class="anima-btn primary" style="width:100%">
                            <i class="fa-solid fa-floppy-disk"></i> 保存配置
                        </button>
                    </div>
                </div>
            </div>

            <div class="anima-setting-group">
                <h2 class="anima-title"><i class="fa-solid fa-book-open"></i> 知识库</h2>
                <div class="anima-card">
                    <input type="file" id="rag_input_knowledge_file" accept=".txt,.md,.json" multiple style="display:none;" />

                    <div class="anima-flex-row">
                        <div class="anima-label-group">
                            <span class="anima-label-text">知识库构建</span>
                            <span class="anima-desc-inline">仅支持上传 txt 和 markdown 格式</span>
                        </div>
                        <div style="display:flex; gap:5px;">
                             <button id="rag_btn_kb_import" class="anima-btn primary small">
                                <i class="fa-solid fa-upload"></i> 上传
                            </button>
                            <button id="rag_btn_kb_view" class="anima-btn secondary small">
                                <i class="fa-solid fa-eye"></i> 查看
                            </button>
                        </div>
                    </div>

                    <div class="anima-divider"></div>

                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 10px;">
                        <div class="anima-compact-input">
                            <div class="anima-label-small">切片依据 (自定义标签)</div>
                            <input type="text" id="rag_kb_delimiter" class="anima-input" 
                                   value="${escapeHtml(settings.knowledge_base?.delimiter || "")}" 
                                   placeholder="例如: ### (为空则按字数)">
                        </div>
                        <div class="anima-compact-input">
                            <div class="anima-label-small">切片字符数</div>
                            <input type="number" id="rag_kb_chunk_size" class="anima-input" 
                                   value="${settings.knowledge_base?.chunk_size || 500}" min="50" step="50">
                        </div>
                    </div>
                    <div class="anima-desc-inline" style="margin-bottom: 15px; font-size:11px; color:#888;">
                        <i class="fa-solid fa-circle-info"></i> 若填写了"切片依据"，则优先按标签切分；否则按字符数切分（并自动寻找句号/换行符截断）。
                    </div>

                    <div class="anima-flex-row">
                         <div class="anima-label-group">
                            <span class="anima-label-text">检索数量</span>
                            <span class="anima-desc-inline">每个文档检索的切片数</span>
                        </div>
                        <div class="anima-input-wrapper">
                             <input type="number" id="rag_kb_search_top_k" class="anima-input" 
                                    style="width:80px; text-align:center;"
                                    value="${settings.knowledge_base?.search_top_k || 3}" min="1" max="20">
                        </div>
                    </div>
                    
                     <div class="anima-flex-row">
                         <div class="anima-label-group">
                            <span class="anima-label-text">最低相关性</span>
                            <span class="anima-desc-inline">知识库检索的最低门槛</span>
                        </div>
                        <div class="anima-input-wrapper">
                             <input type="number" id="rag_kb_min_score" class="anima-input" 
                                    style="width:80px; text-align:center;"
                                    value="${settings.knowledge_base?.min_score || 0.5}" step="0.05" min="0" max="1">
                        </div>
                    </div>

                    <div style="margin-top: 10px;">
                        <button id="rag_btn_save_kb_settings" class="anima-btn primary" style="width:100%">
                            <i class="fa-solid fa-floppy-disk"></i> 保存知识库配置
                        </button>
                    </div>
                </div>
            </div>

            <div id="anima-rag-modal" class="anima-modal hidden">
                 <div class="anima-modal-content">
                    <div class="anima-modal-header">
                        <h3 id="anima-rag-modal-title">标题</h3>
                        <span class="anima-close-rag-modal" style="cursor:pointer; font-size:20px;">&times;</span>
                    </div>
                    <div id="anima-rag-modal-body" class="anima-modal-body"></div>
                 </div>
            </div>
            ${getRegexModalHTML()}
            
           <div class="anima-setting-group">
            <h2 class="anima-title"><i class="fa-solid fa-filter"></i>向量检索内容</h2>
            <div class="anima-card">
                <div class="anima-flex-row" style="align-items: flex-start;">
                    <div class="anima-label-group">
                        <span class="anima-label-text">正则清洗</span>
                        <span class="anima-desc-inline">在向量化之前清洗文本</span>
                    </div>
                    <button id="rag_btn_open_regex_modal" class="anima-btn primary small">
                        <i class="fa-solid fa-plus"></i> 添加规则
                    </button>
                </div>
                <div id="rag_regex_list" class="anima-regex-list"></div>

                <div class="anima-flex-row">
                    <div class="anima-label-group">
                        <span class="anima-label-text">正则处理跳过开场白</span>
                        <span class="anima-desc-inline">开启后，第 0 层（开场白/设定）将保持原文，不被正则清洗。</span>
                    </div>
                    <label class="anima-switch">
                        <input type="checkbox" id="rag_skip_layer_zero" ${settings.skip_layer_zero ? "checked" : ""}>
                        <span class="slider round"></span>
                    </label>
                </div>

                <div class="anima-flex-row">
                    <div class="anima-label-group">
                        <span class="anima-label-text">正则处理跳过User消息</span>
                        <span class="anima-desc-inline">开启后，User发送的内容将保留原文，不进行正则清洗</span>
                    </div>
                    <label class="anima-switch">
                        <input type="checkbox" id="rag_regex_skip_user" ${settings.regex_skip_user ? "checked" : ""}>
                        <span class="slider round"></span>
                    </label>
                </div>
                
                <div class="anima-divider"></div>
                
                <div class="anima-prompt-container">
                    <div class="anima-flex-row">
                        <label class="anima-label-text">向量提示词构建</label>
                        <div style="display:flex; gap:10px;">
                             <button id="rag_btn_preview_query" class="anima-btn secondary small">
                                <i class="fa-solid fa-eye"></i> 预览
                            </button>
                            <button id="rag_btn_add_prompt_item" class="anima-btn small primary"><i class="fa-solid fa-plus"></i> 添加</button>
                        </div>
                    </div>
                    <div class="anima-desc-inline" style="margin-bottom:5px;">
                        构建发送给 Embedding 模型的文本。必须包含 <b>楼层内容</b>。
                    </div>
                    <div id="rag_prompt_list" class="anima-regex-list" style="min-height: 80px; padding: 5px;"></div>
                    
                    <div style="margin-top: 10px;">
                        <button id="rag_btn_save_prompt_bottom" class="anima-btn primary" style="width:100%">
                            <i class="fa-solid fa-floppy-disk"></i> 保存配置
                        </button>
                    </div>
                </div>
            </div>
        </div>

            <div class="anima-setting-group">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 5px;">
                    <h2 class="anima-title" style="margin:0;"><i class="fa-solid fa-sliders"></i> 检索策略 (聊天数据库)</h2>
                    <div style="display:flex; gap:5px;">
                        <input type="file" id="rag_input_strategy_json" accept=".json" style="display:none;" />
                        <button id="rag_strategy_import" class="anima-btn secondary small" title="导入策略配置">
                            <i class="fa-solid fa-file-import"></i> 导入
                        </button>
                        <button id="rag_strategy_export" class="anima-btn secondary small" title="导出策略配置">
                            <i class="fa-solid fa-file-export"></i> 导出
                        </button>
                    </div>
                </div>
                <div class="anima-card">
                    <div class="anima-flex-row">
                        <div class="anima-label-group">
                            <span class="anima-label-text">基础结果数量</span>
                            <span class="anima-desc-inline">最少检索切片数</span>
                        </div>
                        <div class="anima-input-wrapper">
                            <input type="number" id="rag_base_count" class="anima-input" 
                                   style="width:80px; text-align:center;"
                                   value="${settings.base_count}" min="1">
                        </div>
                    </div>

                    <div class="anima-flex-row">
                        <div class="anima-label-group">
                            <span class="anima-label-text">最低相关性</span>
                            <span class="anima-desc-inline">低于此分数的切片将被丢弃</span>
                        </div>
                        <div class="anima-input-wrapper">
                             <input type="number" id="rag_min_score" class="anima-input" 
                                    style="width:80px; text-align:center;"
                                    value="${settings.min_score || 0.5}" step="0.05" min="0" max="1">
                        </div>
                    </div>

                    <div class="anima-flex-row">
                        <div class="anima-label-group">
                            <span class="anima-label-text">启用分布式检索策略</span>
                            <span class="anima-desc-inline">开启后启用多级召回</span>
                        </div>
                        <label class="anima-switch">
                            <input type="checkbox" id="rag_distributed_switch" ${settings.distributed_retrieval ? "checked" : ""}>
                            <span class="slider round"></span>
                        </label>
                    </div>

                    <div id="rag_distributed_config" class="${settings.distributed_retrieval ? "" : "hidden"}" style="margin-top: 15px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 15px;">
                        
                        <div class="anima-flex-row">
                            <div class="anima-label-group">
                                <span class="anima-label-text">虚拟时间模式</span>
                                <span class="anima-desc-inline">使用当前状态信息的事件计算节日/生理</span>
                            </div>
                            <label class="anima-switch">
                                <input type="checkbox" id="rag_virtual_time_switch" ${settings.virtual_time_mode ? "checked" : ""}>
                                <span class="slider round"></span>
                            </label>
                        </div>

                        <div class="anima-flex-row">
                            <div class="anima-label-group">
                                <span class="anima-label-text">候选倍率</span>
                                <span class="anima-desc-inline">召回数量 = 需求数 x 倍率 (去重用)</span>
                            </div>
                            <div class="anima-input-wrapper">
                                <input type="number" id="rag_multiplier" class="anima-input" 
                                       style="width:60px; text-align:center;"
                                       value="${settings.strategy_settings?.candidate_multiplier || 2}" min="1">
                            </div>
                        </div>

                        <div id="rag_strategy_table_container" style="margin-top: 10px;"></div>
                        
                    </div>

                    <div id="rag_simple_config" class="${settings.distributed_retrieval ? "hidden" : ""}">
                        <div style="padding:10px; text-align:center; color:#666; font-size:12px; font-style:italic;">
                            仅使用基础相关性检索 (Base Count)
                        </div>
                    </div>

                    <div style="margin-top: 15px;">
                        <button id="rag_btn_save_settings_bottom" class="anima-btn primary" style="width:100%">
                            <i class="fa-solid fa-floppy-disk"></i> 保存配置
                        </button>
                    </div>
                 </div>
            </div>

            <div class="anima-setting-group">
                <h2 class="anima-title"><i class="fa-solid fa-syringe"></i> 结果注入配置</h2>
                <div class="anima-card">
                    
                    <div style="margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 20px;">
                        <div style="font-size:14px; font-weight:bold; color:var(--anima-primary); margin-bottom:10px;">
                            <i class="fa-solid fa-comment-dots"></i> 聊天数据检索结果注入
                        </div>

                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 12px;">
                            <div class="anima-compact-input">
                                <div class="anima-label-small">触发策略</div>
                                <select id="rag_inject_strategy" class="anima-select rag-inject-control">
                                    <option value="constant" ${settings.injection_settings?.strategy === "constant" ? "selected" : ""}>🔵 常驻 (Constant)</option>
                                    <option value="selective" ${settings.injection_settings?.strategy === "selective" ? "selected" : ""}>🟢 按需 (Selective)</option>
                                </select>
                            </div>
                            <div class="anima-compact-input">
                                <div class="anima-label-small">插入位置</div>
                                <select id="rag_inject_position" class="anima-select rag-inject-control">
                                    <option value="at_depth" ${settings.injection_settings?.position === "at_depth" ? "selected" : ""}>@D (指定深度)</option>
                                    <option value="before_character_definition" ${settings.injection_settings?.position === "before_character_definition" ? "selected" : ""}>⬆️ 角色定义之前</option>
                                    <option value="after_character_definition" ${settings.injection_settings?.position === "after_character_definition" ? "selected" : ""}>⬇️ 角色定义之后</option>
                                </select>
                            </div>
                        </div>

                        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px; margin-bottom: 15px;">
                            <div class="anima-compact-input">
                                <div class="anima-label-small">角色归属</div>
                                <select id="rag_inject_role" class="anima-select rag-inject-control">
                                    <option value="system" ${settings.injection_settings?.role === "system" ? "selected" : ""}>System</option>
                                    <option value="user" ${settings.injection_settings?.role === "user" ? "selected" : ""}>User</option>
                                    <option value="assistant" ${settings.injection_settings?.role === "assistant" ? "selected" : ""}>Assistant</option>
                                </select>
                            </div>
                            <div class="anima-compact-input" id="rag_inject_depth_wrapper">
                                <div class="anima-label-small">深度</div>
                                <input type="number" id="rag_inject_depth" class="anima-input rag-inject-control" 
                                    value="${settings.injection_settings?.depth ?? 2}" step="1" min="0" placeholder="0">
                            </div>
                            <div class="anima-compact-input">
                                <div class="anima-label-small">顺序</div>
                                <input type="number" id="rag_inject_order" class="anima-input rag-inject-control" 
                                    value="${settings.injection_settings?.order ?? 100}" step="1">
                            </div>
                        </div>

                        <div class="anima-flex-row" style="margin-bottom: 10px;">
                            <div class="anima-label-group">
                                <span class="anima-label-text">强制插入最新N个总结片段</span>
                                <span class="anima-desc-inline">
                                    在模板中使用 <code>{{recent_history}}</code> 插入。
                                </span>
                            </div>
                            <div class="anima-input-wrapper">
                                 <input type="number" id="rag_inject_recent_count" class="anima-input" 
                                        style="width: 60px; text-align:center;"
                                        value="${settings.injection_settings?.recent_count || 2}" min="0" max="10">
                                 <span style="font-size:12px; color:#aaa; margin-left:5px;">条</span>
                            </div>
                        </div>

                        <div style="margin-bottom: 5px;">
                            <div class="anima-label-group" style="margin-bottom: 5px;">
                                <span class="anima-label-text">提示词构建模板</span>
                                <span class="anima-desc-inline">使用 <code>{{rag}}</code> 作为占位符。</span>
                            </div>
                            <textarea id="rag_inject_template" class="anima-textarea" rows="4" 
                                placeholder="例如：以下是相关记忆...\n{{rag}}">${escapeHtml(settings.injection_settings?.template || "以下是相关的记忆内容：\n{{rag}}")}</textarea>
                        </div>
                    </div>

                    <div>
                        <div style="font-size:14px; font-weight:bold; color:#48ecd1; margin-bottom:10px;">
                            <i class="fa-solid fa-book"></i> 知识库注入
                        </div>

                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 12px;">
                             <div class="anima-compact-input">
                                <div class="anima-label-small">触发策略</div>
                                <select id="rag_k_inject_strategy" class="anima-select rag-inject-control">
                                    <option value="constant" ${settings.knowledge_injection?.strategy === "constant" ? "selected" : ""}>🔵 常驻 (Constant)</option>
                                    <option value="selective" ${settings.knowledge_injection?.strategy === "selective" ? "selected" : ""}>🟢 按需 (Selective)</option>
                                </select>
                            </div>

                             <div class="anima-compact-input">
                                <div class="anima-label-small">插入位置</div>
                                <select id="rag_k_inject_position" class="anima-select rag-inject-control">
                                    <option value="at_depth" ${settings.knowledge_injection?.position === "at_depth" ? "selected" : ""}>@D (指定深度)</option>
                                    <option value="before_character_definition" ${settings.knowledge_injection?.position === "before_character_definition" ? "selected" : ""}>⬆️ 角色定义之前</option>
                                    <option value="after_character_definition" ${settings.knowledge_injection?.position === "after_character_definition" ? "selected" : ""}>⬇️ 角色定义之后</option>
                                </select>
                            </div>
                        </div>

                        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px; margin-bottom: 15px;">
                             <div class="anima-compact-input">
                                <div class="anima-label-small">角色归属</div>
                                <select id="rag_k_inject_role" class="anima-select rag-inject-control">
                                    <option value="system" ${settings.knowledge_injection?.role === "system" ? "selected" : ""}>System</option>
                                    <option value="user" ${settings.knowledge_injection?.role === "user" ? "selected" : ""}>User</option>
                                    <option value="assistant" ${settings.knowledge_injection?.role === "assistant" ? "selected" : ""}>Assistant</option>
                                </select>
                            </div>

                            <div class="anima-compact-input">
                                <div class="anima-label-small">深度</div>
                                <input type="number" id="rag_k_inject_depth" class="anima-input rag-inject-control" 
                                    value="${settings.knowledge_injection?.depth ?? 0}" step="1" min="0">
                            </div>

                            <div class="anima-compact-input">
                                <div class="anima-label-small">顺序</div>
                                <input type="number" id="rag_k_inject_order" class="anima-input rag-inject-control" 
                                    value="${settings.knowledge_injection?.order ?? 100}" step="1">
                            </div>
                        </div>

                        <div style="margin-bottom: 15px;">
                            <div class="anima-label-group" style="margin-bottom: 5px;">
                                <span class="anima-label-text">知识库模板</span>
                            </div>
                            <div class="anima-desc-inline" style="margin-bottom:12px;">
                            将写入独立的世界书条目。使用 <code>{{knowledge}}</code> 作为占位符。
                            </div>
                            <textarea id="rag_k_inject_template" class="anima-textarea" rows="4" 
                                placeholder="例如：以下是相关设定\n{{knowledge}}">${escapeHtml(settings.knowledge_injection?.template || "以下是相关设定：\n{{knowledge}}")}</textarea>
                        </div>
                    </div>

                    <div>
                        <button id="rag_btn_save_injection" class="anima-btn primary" style="width:100%; height: 40px; font-weight:bold;">
                            <i class="fa-solid fa-floppy-disk"></i> 保存所有注入配置
                        </button>
                    </div>

                </div>
            </div>
        </div>
        `;
  container.innerHTML = styleFix + masterSwitchHtml + mainContentHtml;
  // 渲染各个子模块
  regexComponent = new RegexListComponent(
    "rag_regex_list", // 容器 ID (保持 rag.js 原有的 div id="rag_regex_list")
    () => settings.regex_strings, // 获取数据
    (newData) => {
      // 保存回调
      settings.regex_strings = newData;
    },
  );
  regexComponent.render();
  renderPromptList(settings.vector_prompt);
  renderStrategyTable(settings);
  renderFileList(safeRagFiles, currentChatId);
  $("#rag_master_switch").on("change", async function () {
    const isEnabled = $(this).prop("checked");

    // A. 更新设置
    settings.rag_enabled = isEnabled;
    saveRagSettings(settings);

    // 🔥🔥 B. [新增] 触发世界书条目状态联动 🔥🔥
    // RAG 开启 -> 禁用所有 Summary 条目
    // RAG 关闭 -> 启用所有 Summary 条目
    await toggleAllSummariesState(isEnabled);

    // C. 控制 UI 显隐
    if (isEnabled) {
      $("#rag_main_content_wrapper").removeClass("hidden");
      toastr.success("向量功能已开启");

      // D. 自动检查脏数据
      if (settings.auto_vectorize) {
        // 假设 checkAndSyncDirtyVectors 已经在该文件其他地方定义或引入
        if (typeof checkAndSyncDirtyVectors === "function") {
          checkAndSyncDirtyVectors();
        }
      }
    } else {
      $("#rag_main_content_wrapper").addClass("hidden");
      toastr.info("向量功能已关闭 (已回退至纯文本模式)"); // 提示语也可以稍微改一下
    }
  });
  bindRagEvents(settings);
}

// ==========================================
// 5. 弹窗与事件系统
// ==========================================

export function showRagModal(title, html) {
  $("#anima-rag-modal-title").text(title);
  $("#anima-rag-modal-body").html(html);
  $("#anima-rag-modal").removeClass("hidden");
}

function bindRagEvents(settings) {
  const $container = $("#tab-rag");

  // 1. 注入位置联动
  $("#rag_inject_position")
    .off("change")
    .on("change", function () {
      const val = $(this).val();
      const $depthInput = $("#rag_inject_depth");
      const $depthRow = $("#rag_inject_depth_row");

      if (val === "at_depth") {
        $depthInput.prop("disabled", false).css("opacity", 1);
        $depthRow.css("opacity", 1);
      } else {
        $depthInput.prop("disabled", true).css("opacity", 0.5);
        $depthRow.css("opacity", 0.5);
      }
    });

  // 关闭 RAG 主弹窗
  $(".anima-close-rag-modal").on("click", () =>
    $("#anima-rag-modal").addClass("hidden"),
  );

  // 关闭 Regex 弹窗
  $container.find(".anima-close-regex-modal").on("click", () => {
    $container.find("#anima-regex-input-modal").addClass("hidden");
  });

  // --- 正则事件 ---
  $("#rag_btn_open_regex_modal").on("click", () => {
    // 使用 $container.find 确保清空的是当前页面的输入框
    $container.find("#anima_new_regex_str").val("");
    $container.find("#anima_new_regex_type").val("extract");
    $container.find("#anima-regex-input-modal").removeClass("hidden");
  });

  $container.find("#anima_btn_confirm_add_regex").on("click", () => {
    const str = $container.find("#anima_new_regex_str").val().trim();
    const type = $container.find("#anima_new_regex_type").val();

    if (!str) return toastr.warning("正则不能为空");

    // 使用组件添加
    if (regexComponent) {
      regexComponent.addRule(str, type);
    }

    $container.find("#anima-regex-input-modal").addClass("hidden");
  });

  // --- 提示词事件 ---
  $("#rag_btn_add_prompt_item").on("click", () => {
    // 🟢 修改：添加时显式指定 type: "text"，防止预览时被忽略
    settings.vector_prompt.unshift({
      role: "system",
      title: "新规则",
      content: "",
    });
    renderPromptList(settings.vector_prompt);
  });

  // --- 分布式开关 ---
  $("#rag_distributed_switch").on("change", function () {
    const isChecked = $(this).prop("checked");
    if (isChecked) {
      $("#rag_simple_config").addClass("hidden");
      $("#rag_distributed_config").removeClass("hidden");
    } else {
      $("#rag_simple_config").removeClass("hidden");
      $("#rag_distributed_config").addClass("hidden");
    }
  });

  // --- 标签编辑 ---
  $("#btn_edit_tags").on("click", () => {
    $("#rag_tags_action_btns").hide();
    $("#rag_tags_edit_btns").css("display", "flex");
    renderTagTable(settings.tags_config, true);
  });
  $("#btn_cancel_tags").on("click", () => {
    $("#rag_tags_edit_btns").hide();
    $("#rag_tags_action_btns").show();
    renderTagTable(settings.tags_config, false);
  });
  $("#btn_save_tags").on("click", () => {
    $(".tag-labels-input").each(function () {
      const key = $(this).data("key");
      const arr = $(this)
        .val()
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter((s) => s);
      settings.tags_config[key].labels = arr;
    });
    $(".tag-count-input").each(function () {
      const key = $(this).data("key");
      settings.tags_config[key].count = parseInt($(this).val()) || 0;
    });
    $("#rag_tags_edit_btns").hide();
    $("#rag_tags_action_btns").show();
    renderTagTable(settings.tags_config, false);
  });

  // --- 节日配置 ---
  $("#rag_btn_holidays").on("click", () => {
    renderHolidayModal(settings);
  });

  const handleSave = async () => {
    // 🟢 必须是 async
    try {
      const currentSettings = getRagSettings();

      // 1. 获取 DOM 数据
      const impTagsArr = (
        $("#rag_row_important").find(".tag-input").val() || ""
      )
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);

      // 2. 组装新对象 (遵循你的分类要求)
      const newSettings = {
        ...currentSettings,
        // 全局项
        base_count: parseInt($("#rag_base_count").val()) || 2,
        min_score: parseFloat($("#rag_min_score").val()) || 0.5,
        auto_vectorize: $("#rag_auto_vectorize").prop("checked"),
        skip_layer_zero: $("#rag_skip_layer_zero").prop("checked"), // 跳过开场白
        regex_skip_user: $("#rag_regex_skip_user").prop("checked"),
        // 角色项
        distributed_retrieval: $("#rag_distributed_switch").prop("checked"),
        virtual_time_mode: $("#rag_virtual_time_switch").prop("checked"),

        strategy_settings: {
          candidate_multiplier: parseInt($("#rag_multiplier").val()) || 2, // 存全局
          important: {
            labels: impTagsArr,
            count: parseInt($("#rag_strat_imp_count").val()) || 1,
          },
          period: {
            labels: currentSettings.strategy_settings?.period?.labels || [
              "Period",
            ],
            count: parseInt($("#rag_strat_period_count").val()) || 1,
          },
          status: {
            labels: currentSettings.strategy_settings?.status?.labels || [],
            count: parseInt($("#rag_strat_status_count").val()) || 1,
            rules: currentSettings.strategy_settings?.status?.rules || [],
          },
          special: {
            count: parseInt($("#rag_strat_holiday_count").val()) || 1,
          },
          diversity: {
            count: parseInt($("#rag_strat_div_count").val()) || 2,
          },
        },
      };

      // 3. 执行异步分流保存
      await saveRagSettings(newSettings);

      // 4. 反馈与刷新
      toastr.success("设置已成功分流保存至全局与角色卡");
      renderStrategyTable(newSettings);
    } catch (err) {
      console.error("[Anima RAG] Save Error:", err);
      toastr.error("保存失败: " + err.message);
    }
  };

  // 🔥🔥🔥 修改绑定：同时绑定顶部和底部的保存按钮 🔥🔥🔥
  // 使用逗号分隔选择器，或者分别绑定
  $("#rag_btn_save_settings_top, #rag_btn_save_settings_bottom")
    .off("click")
    .on("click", handleSave);

  // 绑定其他可能存在的保存按钮（如果有的话）
  $("#rag_btn_save_simple").on("click", handleSave);
  $("#rag_btn_save_kb_settings").on("click", handleSave);
  $("#rag_btn_save_dist").on("click", handleSave);
  $("#rag_btn_save_prompt_cfg").on("click", handleSave);
  $("#rag_btn_save_prompt_bottom").on("click", handleSave);

  $("#rag_btn_save_injection")
    .off("click")
    // 🟢 修改 1: 在这里加上 async
    .on("click", async () => {
      // 1. 获取 Chat Memory 注入配置 (原有)
      const newInjectionSettings = {
        strategy: $("#rag_inject_strategy").val(),
        position: $("#rag_inject_position").val(),
        role: $("#rag_inject_role").val(),
        depth: parseInt($("#rag_inject_depth").val()) || 0,
        order: parseInt($("#rag_inject_order").val()) || 100,
        recent_count: parseInt($("#rag_inject_recent_count").val()) || 2,
        template: $("#rag_inject_template").val(),
      };

      // 2. 获取 Knowledge Base 注入配置 (新增)
      const newKnowledgeInjection = {
        enabled: true, // 默认强制开启
        strategy: $("#rag_k_inject_strategy").val(),
        position: $("#rag_k_inject_position").val(),
        role: $("#rag_k_inject_role").val(),
        depth: parseInt($("#rag_k_inject_depth").val()) || 0,
        order: parseInt($("#rag_k_inject_order").val()) || 100,
        template: $("#rag_k_inject_template").val(),
      };

      // 3. 更新内存对象
      settings.injection_settings = newInjectionSettings;
      settings.knowledge_injection = newKnowledgeInjection;

      // 4. 持久化
      saveRagSettings(settings);

      // 🟢 修改 2: 加上 await，确保同步完成后再提示
      await syncRagSettingsToWorldbook();

      if (window.toastr) toastr.success("注入配置已保存并应用！");
    });

  $("#rag_btn_preview_query").on("click", async () => {
    // 获取当前上下文
    const context = SillyTavern.getContext();
    const chat = context.chat;

    if (!chat || chat.length === 0) {
      toastr.warning("当前没有聊天记录，无法预览");
      return;
    }

    // 临时构建 Settings 对象
    const currentSettings = {
      ...settings,
      skip_layer_zero: $("#rag_skip_layer_zero").prop("checked"),
      regex_skip_user: $("#rag_regex_skip_user").prop("checked"),
      regex_strings: settings.regex_strings,
      vector_prompt: settings.vector_prompt,
    };

    // 1. 获取结构化数据
    const blocks = await constructRagQueryMock(chat, currentSettings);

    // 2. 辅助渲染函数 (完全复刻 Summary 样式)
    const createBlock = (title, contentHtml, color, borderColor, bgColor) => {
      return `
            <div class="anima-preview-block" style="border-color: ${borderColor};">
                <div class="block-header" style="background: ${bgColor}; color: ${color};">
                    <span>${title}</span>
                    <i class="fa-solid fa-chevron-down arrow-icon"></i>
                </div>
                <div class="block-content" style="display: none;">${contentHtml}</div>
            </div>`;
    };

    let finalPreviewHtml = "";
    let totalChars = 0;

    // 3. 遍历构建 HTML
    blocks.forEach((block) => {
      if (block.type === "text") {
        totalChars += block.content.length;
        finalPreviewHtml += createBlock(
          block.title,
          `<div style="white-space: pre-wrap; color: #ccc;">${escapeHtml(block.content)}</div>`,
          "#aaa",
          "#444",
          "rgba(0,0,0,0.3)",
        );
      } else if (block.type === "context") {
        let contextHtml = "";
        if (block.messages.length === 0) {
          contextHtml = `<div style='padding:5px; color:#aaa; font-style:italic;'>⚠️ 此范围内没有有效消息 (可能被过滤或正则清洗为空)</div>`;
        } else {
          contextHtml = block.messages
            .map((m) => {
              totalChars += m.content.length;
              // 复刻 Summary 的颜色逻辑
              const colorClass =
                m.role === "user" ? "color:#4ade80" : "color:#60a5fa"; // 绿/蓝
              const roleLabel = m.role.toUpperCase();
              const skipBadge = m.skippedRegex
                ? `<span style="font-size:10px; background:rgba(255,255,255,0.1); border-radius:3px; padding:0 3px; margin-left:5px; color:#aaa;" title="正则已跳过">RAW</span>`
                : "";

              return (
                `<div style="margin-bottom: 8px; border-left: 2px solid rgba(255,255,255,0.1); padding-left: 6px;">` +
                `<div style="font-weight:bold; font-size: 11px; margin-bottom: 2px; line-height: 1; ${colorClass}">[${roleLabel}]${skipBadge}</div>` +
                `<div style="white-space: pre-wrap; color: #ccc; line-height: 1.4; font-size: 12px; margin: 0;">${escapeHtml(m.content).trim()}</div>` +
                `</div>`
              );
            })
            .join("");
        }

        finalPreviewHtml += createBlock(
          block.title,
          contextHtml,
          "#93c5fd", // 标题文字颜色
          "#64748b", // 边框颜色
          "rgba(100, 149, 237, 0.2)", // 标题背景颜色
        );
      }
    });

    // 4. 定义 CSS (复刻 Summary)
    const style = `<style>
            .anima-preview-block { border: 1px solid #444; border-radius: 6px; margin-bottom: 10px; overflow: hidden; background: rgba(0,0,0,0.1); } 
            .block-header { padding: 8px 10px; font-size: 12px; font-weight: bold; cursor: pointer; display: flex; justify-content: space-between; align-items: center; } 
            .block-header:hover { filter: brightness(1.2); } 
            .block-content { padding: 10px; font-size: 12px; border-top: 1px solid rgba(0,0,0,0.2); background: rgba(0,0,0,0.2); } 
            .anima-preview-block.expanded .arrow-icon { transform: rotate(180deg); }
        </style>`;

    // 5. 元数据头部
    const metaInfo = `
            <div style="margin-bottom: 10px; color: #aaa; font-size: 12px; border-bottom:1px solid #444; padding-bottom:10px;">
                <div style="display:flex; justify-content:space-between;">
                    <span><strong>Source:</strong> Current Chat</span>
                    <span><strong>Total Chars:</strong> ~${totalChars}</span>
                </div>
            </div>
        `;

    // 6. 显示弹窗
    showRagModal(
      "向量提示词预览 (Preview)",
      style +
        metaInfo +
        `<div id="rag-preview-container">${finalPreviewHtml}</div>`,
    );

    // 7. 绑定折叠逻辑
    setTimeout(() => {
      $("#rag-preview-container")
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

  // 绑定到三个保存按钮
  $("#rag_btn_save_simple").on("click", handleSave);
  $("#rag_btn_save_dist").on("click", handleSave);
  // 🟢 新增：绑定提示词下方的保存按钮 (上方那个)
  $("#rag_btn_save_prompt_cfg").on("click", handleSave);
  // ✅ 修复：绑定提示词列表下方的按钮 (新增的唯一ID)
  $("#rag_btn_save_prompt_bottom").on("click", handleSave);

  // --- 状态弹窗 ---
  $("#rag_btn_status").on("click", async () => {
    // 1. 预检查：先判断是否有打开的聊天
    const context = SillyTavern.getContext();
    if (!context.chatId) {
      toastr.warning("请先打开一个聊天窗口");
      return;
    }

    // 2. 安全调用：捕获可能的其他异步错误
    try {
      await showVectorStatusModal();
    } catch (err) {
      console.error("[Anima RAG] Status Error:", err);
      // 提取错误信息提示给用户
      toastr.error("获取状态失败: " + (err.message || "未知错误"));
    }
  });

  $("#rag_btn_last_result").on("click", () => {
    $(this).removeClass("glow-effect");

    if (!_lastRetrievalResult) {
      toastr.info("暂无检索记录 (请先进行一次对话)");
      return;
    }

    const r = _lastRetrievalResult;

    const queryLen = r.query ? r.query.length : 0;
    // 累加所有结果的 text 长度
    const totalResultLen = r.results
      ? r.results.reduce((acc, item) => acc + (item.text || "").length, 0)
      : 0;
    const headerStyle = "font-size:12px; color:#aaa; font-weight:bold;";
    // --- 1. 构建主结果区域 ---
    let contentHtml = `
            <div style="margin-bottom:10px; padding:10px; background:rgba(0,0,0,0.2); border-radius:4px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
                    <div style="${headerStyle}">Query</div>
                    <div style="${headerStyle}; font-family:monospace;">Length: ${queryLen} 字符数</div>
                </div>
                <div style="color:#eee; font-size:13px; white-space: pre-wrap;">${escapeHtml(r.query)}</div>
            </div>
            
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
                <div style="${headerStyle}">检索到的切片 (${r.results ? r.results.length : 0})</div>
                <div style="${headerStyle}; font-family:monospace;">Total Content: ${totalResultLen} 字符数</div>
            </div>
        `;

    if (r.results && r.results.length > 0) {
      contentHtml += r.results
        .map((item, idx) => {
          // 🟢 修改 2：增加 uniqueID / index 显示
          // 优先取 uniqueID，如果没有取 index (兼容不同后端返回格式)
          const displayId = item.uniqueID || item.index || "N/A";

          const sourceDb = item.source || "Unknown";
          const isKb = sourceDb.startsWith("kb_");

          // 🟢 样式分歧配置
          const theme = isKb
            ? {
                borderColor: "#eab308", // Yellow-500
                headerBg: "rgba(234, 179, 8, 0.15)",
                countColor: "#facc15",
                icon: "fa-book",
              }
            : {
                borderColor: "#444", // 默认灰色或保留原来的
                headerBg: "rgba(59, 130, 246, 0.15)", // Blue
                countColor: "#60a5fa",
                icon: "fa-database",
              };

          return `
            <div class="anima-preview-block" style="border:1px solid ${theme.borderColor}; margin-bottom:8px; border-radius:4px; overflow:hidden;">
                <div class="block-header" style="background:${theme.headerBg}; padding:6px 10px; font-size:12px; display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <span style="color:${theme.countColor}; font-weight:bold;">#${idx + 1}</span>
                        <span style="color:#fff; font-weight:bold; margin:0 6px; font-family:monospace;">[${escapeHtml(displayId)}]</span>
                        <span style="color:${theme.countColor};">Score: ${item.score?.toFixed(4)}</span>
                    </div>
                    <span style="color:#aaa; font-size:11px;" title="来源数据库">
                        <i class="fa-solid ${theme.icon}" style="margin-right:4px;"></i>${escapeHtml(sourceDb)}
                    </span>
                </div>
                <div class="block-content" style="padding:10px; font-size:12px; color:#ccc; background:rgba(0,0,0,0.2); white-space:pre-wrap; max-height:150px; overflow-y:auto;">${escapeHtml(item.text)}</div>
            </div>
        `;
        })
        .join("");
    } else {
      contentHtml += `<div style="padding:20px; text-align:center; color:#666;">本次未检索到相关内容 (Score Too Low)</div>`;
    }

    // --- 2. 构建策略追踪日志 ---
    if (r.strategy_log && r.strategy_log.length > 0) {
      const renderLogCard = (logItem) => {
        let data = logItem;
        if (typeof logItem === "string") {
          try {
            data = JSON.parse(logItem);
          } catch (e) {
            data = null;
          }
        }

        if (!data || !data.step) {
          return `<div style="padding:4px 0; color:#888; border-bottom:1px dashed #444; font-family:monospace;">> ${escapeHtml(logItem)}</div>`;
        }

        let stepColor = "#666";
        const stepName = data.step.toUpperCase();
        if (stepName.includes("BASE")) stepColor = "#3b82f6";
        else if (stepName.includes("IMPORTANT")) stepColor = "#eab308";
        else if (stepName.includes("STATUS")) stepColor = "#ef4444";
        else if (stepName.includes("HOLIDAY") || stepName.includes("SPECIAL"))
          stepColor = "#a855f7";
        else if (stepName.includes("PERIOD")) stepColor = "#48ecd1";
        else if (stepName.includes("DIVERSITY")) stepColor = "#59e451";

        const libraryName = data.library || "Unknown DB";

        return `
                <div class="anima-log-card" style="
                    background: rgba(0,0,0,0.3); 
                    border: 1px solid rgba(255,255,255,0.08); 
                    border-left: 3px solid ${stepColor}; 
                    border-radius: 4px; 
                    margin-bottom: 6px; 
                    padding: 8px 10px;
                    font-size: 11px;
                ">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                        <div style="font-weight: bold; color: ${stepColor}; font-size: 13px;"> ${escapeHtml(data.step)}
                        </div>
                        <div style="text-align: right;">
                            <div style="color: #eee; font-family: monospace; font-weight: bold;">${parseFloat(data.score).toFixed(4)}</div>
                        </div>
                    </div>

                    <div style="color: #aaa; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(libraryName)}">
                        <i class="fa-solid fa-database" style="font-size:10px; margin-right:4px;"></i>${escapeHtml(libraryName)}
                    </div>

                    <div style="color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                        <span style="color:#555;">ID:</span> ${data.uniqueID} 
                        <span style="color:#555; margin-left:8px;">Tags:</span> ${escapeHtml(data.tags || "-")}
                    </div>
                </div>`;
      };

      // ✅ 修改点：移除了 border-top:1px solid #444
      contentHtml += `
            <div style="margin-top:15px;">
                <details style="cursor: pointer;">
                    <summary style="font-size:14px; color:#ddd; font-weight:bold; outline:none; list-style:none; display:flex; align-items:center;">
                        <i class="fa-solid fa-caret-right" style="margin-right:8px; transition: transform 0.2s;"></i>
                        🔎 策略执行追踪 (Trace Log)
                        <span style="margin-left:auto; font-size:12px; color:#666; font-weight:normal;">${r.strategy_log.length} steps</span>
                    </summary>
                    
                    <div style="margin-top: 10px; max-height: 300px; overflow-y: auto; padding-right: 5px;" class="anima-scroll">
                        ${r.strategy_log.map((item) => renderLogCard(item)).join("")}
                    </div>
                </details>
                <style>
                    details[open] summary i.fa-caret-right { transform: rotate(90deg); }
                </style>
            </div>`;
    }

    showRagModal(
      "本次检索结果",
      `<div style="padding:10px;">${contentHtml}</div>`,
    );
  });

  async function openDatabaseSelector(options) {
    const {
      title, // 弹窗标题
      confirmText, // 确认按钮文字
      multiSelect, // (保留扩展) 默认 true
      filterOrphans, // 是否过滤掉不存在的库 (导出时需要过滤)
      onConfirm, // 确认回调 (selectedIds) => {}
    } = options;

    // 1. 获取后端真实存在的库
    let allCollections = [];
    try {
      allCollections = await getAvailableCollections();
    } catch (e) {
      toastr.error("无法获取服务器数据库列表");
      return;
    }

    // 2. 获取当前关联状态 (用于高亮 Current)
    const context = SillyTavern.getContext();
    // const smartCurrentId = getSmartCollectionId();
    const currentChatFiles = getChatRagFiles() || [];
    const currentKbFiles = getChatKbFiles() || [];
    const currentChatId = context ? context.chatId : null;

    // 归一化处理 (仅用于 Linked 判定，Current 判定改用新逻辑)
    // A. 定义归一化 (保持和 rag_ui_components.js 一致)
    const normalizeId = (id) => (id || "").toString().replace(/_/g, " ").trim();

    // B. 定义 isSelf 判断函数 (完全复刻 rag_ui_components.js 的逻辑)
    const isSelf = (dbId) => {
      if (!currentChatId || !dbId) return false;
      // 去掉后缀
      const rawChatId = currentChatId.replace(/\.jsonl?$/i, "");

      const normDb = normalizeId(dbId);
      const normChat = normalizeId(rawChatId);

      // 核心匹配：相等 或 数据库名包含了聊天文件名作为后缀 (例如 "角色_时间" endsWith "时间")
      return normDb === normChat || normDb.endsWith(normChat);
    };

    const allLinkedSet = new Set([
      ...currentChatFiles.map(normalizeId),
      ...currentKbFiles.map(normalizeId),
    ]);

    const normCurrentFilesSet = new Set([
      ...currentChatFiles.map(normalizeId),
      ...currentKbFiles.map(normalizeId),
    ]);

    // 3. 构建列表 HTML
    const listItems = allCollections.map((backendName) => {
      const normBackendName = normalizeId(backendName);

      // 判断是否在当前聊天中已关联
      const isLinked = allLinkedSet.has(normBackendName);

      // ✨ [修改点] 判断是否是当前 ChatID 对应的库 (支持带前缀的中文名)
      const isCurrentChat = isSelf(backendName);

      // 标记处理：如果是“关联”模式，已关联的默认勾选；如果是“导出”模式，默认不勾选（或者只勾选当前）
      // 这里我们采用灵活策略：外部不传 defaultSelected，让用户自己选，但我们可以高亮
      let isChecked = false;

      // 💡 特殊逻辑：如果是关联模式(title里包含关联)，则回显已关联的；如果是导出，默认勾选当前同名的
      if (title.includes("关联") || title.includes("Import")) {
        isChecked = isLinked;
      } else if (title.includes("导出") || title.includes("Export")) {
        isChecked = isCurrentChat;
      }

      // 徽章
      let badges = "";
      if (isCurrentChat)
        badges += `<span style="font-size:10px; background:rgba(74, 222, 128, 0.2); color:#4ade80; padding:1px 4px; border-radius:3px; margin-left:5px;">Current</span>`;
      if (isLinked)
        badges += `<span style="font-size:10px; background:rgba(96, 165, 250, 0.2); color:#60a5fa; padding:1px 4px; border-radius:3px; margin-left:5px;">Linked</span>`;

      // 如果是关联模式，我们从 set 里删掉它，方便最后找孤儿
      if (normCurrentFilesSet.has(normBackendName)) {
        normCurrentFilesSet.delete(normBackendName);
      }

      const showDelete = !title.includes("Export") && !title.includes("导出");
      return `
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.05); padding-right:5px;">
                <label class="anima-checkbox-item" style="flex:1; display:flex; justify-content:space-between; align-items:center; padding:8px; cursor:pointer; border-bottom:none; margin:0;">
                    <div style="display:flex; align-items:center; overflow:hidden;">
                        <i class="fa-solid fa-database" style="color:${isCurrentChat ? "var(--anima-primary)" : "#aaa"}; margin-right:8px; flex-shrink:0;"></i>
                        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#ddd;" title="${escapeHtml(backendName)}">
                            ${escapeHtml(backendName)}
                        </span>
                        ${badges}
                    </div>
                    <input type="checkbox" class="anima-checkbox collection-checkbox" value="${escapeHtml(backendName)}" ${isChecked ? "checked" : ""}>
                </label>
                
                ${
                  showDelete
                    ? `
                <button class="anima-btn danger small btn-delete-db-modal" data-id="${escapeHtml(backendName)}" title="物理删除此数据库" style="margin-left:5px; height:24px; width:24px; padding:0; display:flex; align-items:center; justify-content:center;">
                    <i class="fa-solid fa-trash" style="font-size:12px;"></i>
                </button>`
                    : ""
                }
            </div>`;
    });

    // 4. 处理“孤儿” (仅在不过滤孤儿时显示，例如“关联”模式需要显示出来以便用户解绑)
    let orphanItems = [];
    if (!filterOrphans) {
      // 合并所有关联文件列表进行遍历
      const allActiveFiles = [...currentChatFiles, ...currentKbFiles];

      orphanItems = allActiveFiles
        .filter((f) => normCurrentFilesSet.has(normalizeId(f))) // 剩下的就是孤儿
        .map(
          (orphanName) => `
                <label class="anima-checkbox-item" style="display:flex; justify-content:space-between; align-items:center; padding:8px; border-bottom:1px solid rgba(255,255,255,0.05); cursor:pointer; opacity: 0.7;">
                    <div style="display:flex; align-items:center; overflow:hidden;">
                        <i class="fa-solid fa-triangle-exclamation" style="color:#f59e0b; margin-right:8px; flex-shrink:0;"></i>
                        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-decoration:line-through;" title="文件缺失: ${escapeHtml(orphanName)}">
                            ${escapeHtml(orphanName)}
                        </span>
                    </div>
                    <input type="checkbox" class="anima-checkbox collection-checkbox" value="${escapeHtml(orphanName)}" checked>
                </label>`,
        );
    }

    const finalListHtml = [...listItems, ...orphanItems].join("");

    // 5. 渲染弹窗
    const modalContent = `
        <div style="margin-bottom:10px; font-size:12px; color:#aaa;">
            请选择目标数据库：
        </div>
        <div style="max-height:300px; overflow-y:auto; background:rgba(0,0,0,0.2); border:1px solid #444; border-radius:4px;">
            ${finalListHtml || '<div style="padding:10px; text-align:center;">暂无数据</div>'}
        </div>
        <div style="margin-top:15px; display:flex; justify-content:flex-end; gap:10px;">
             <button class="anima-close-rag-modal anima-btn secondary">取消</button>
            <button id="btn_generic_confirm" class="anima-btn primary">${confirmText}</button>
        </div>
        `;

    showRagModal(title, modalContent);

    $("#anima-rag-modal-body")
      .off("click", ".btn-delete-db-modal")
      .on("click", ".btn-delete-db-modal", async function (e) {
        e.stopPropagation(); // 防止冒泡触发 checkbox 勾选
        const dbId = $(this).data("id");

        if (
          !confirm(
            `⚠️ 严重警告：\n\n确定要物理删除数据库 "${dbId}" 吗？\n此操作将彻底删除服务器上的文件，不可恢复！`,
          )
        )
          return;

        // UI 交互反馈
        const $btn = $(this);
        const originHtml = $btn.html();
        $btn
          .html('<i class="fa-solid fa-spinner fa-spin"></i>')
          .prop("disabled", true);

        try {
          // 动态导入删除逻辑
          const { deleteCollection } = await import("./rag_logic.js");
          const res = await deleteCollection(dbId);

          if (res && res.success) {
            toastr.success("已物理删除: " + dbId);
            // 移除 UI 行
            $btn.closest("div").fadeOut(300, function () {
              $(this).remove();
            });
          } else {
            toastr.error("删除失败");
            $btn.html(originHtml).prop("disabled", false);
          }
        } catch (err) {
          toastr.error("删除出错: " + err.message);
          $btn.html(originHtml).prop("disabled", false);
        }
      });

    // 绑定确认
    $(document)
      .off("click", "#btn_generic_confirm")
      .on("click", "#btn_generic_confirm", () => {
        const selected = [];
        $(".collection-checkbox:checked").each(function () {
          selected.push($(this).val());
        });

        // 关闭弹窗
        $("#anima-rag-modal").addClass("hidden");

        // 执行回调
        if (onConfirm) onConfirm(selected);
      });

    // 绑定取消
    $(".anima-close-rag-modal").on("click", () =>
      $("#anima-rag-modal").addClass("hidden"),
    );
  }

  $("#rag_btn_import")
    .off("click")
    .on("click", () => {
      openDatabaseSelector({
        title: "管理数据库关联",
        confirmText: "确认关联",
        filterOrphans: false, // 显示孤儿以便解绑
        onConfirm: async (selectedIds) => {
          // 🟢 核心修改：分流保存逻辑
          const newKbFiles = [];
          const newChatFiles = [];

          selectedIds.forEach((id) => {
            if (id.startsWith("kb_")) {
              newKbFiles.push(id);
            } else {
              newChatFiles.push(id);
            }
          });

          // 分别保存
          await saveChatKbFiles(newKbFiles);
          await saveChatRagFiles(newChatFiles);

          // 刷新界面
          const ctx = SillyTavern.getContext();
          // 注意：此时不需要传参数，因为 renderUnifiedFileList 会自己读 Metadata
          renderUnifiedFileList();

          toastr.success(
            `关联已更新: ${newChatFiles.length} 个记录, ${newKbFiles.length} 个知识库`,
          );
        },
      });
    });

  $("#rag_btn_download_zip")
    .off("click")
    .on("click", () => {
      openDatabaseSelector({
        title: "选择要导出的数据库 (Export)",
        confirmText: `<i class="fa-solid fa-file-arrow-down"></i> 导出选定`,
        filterOrphans: true,
        onConfirm: async (selectedIds) => {
          if (selectedIds.length === 0)
            return toastr.warning("未选择任何数据库");

          const $btn = $("#rag_btn_download_zip");
          const originalHtml = $btn.html();
          $btn
            .prop("disabled", true)
            .html('<i class="fa-solid fa-spinner fa-spin"></i> 处理中...');

          // 定义类型强转，防止 VSCode 报错
          const safeToastr = /** @type {any} */ (toastr);

          // 提示开始
          const total = selectedIds.length;
          safeToastr.info(
            `准备导出 ${total} 个数据库，请允许浏览器下载多个文件...`,
          );

          // 🔥 核心逻辑：串行循环下载
          // 我们使用 for...of 循环 + await，一个个下，防止浏览器同时弹太多请求被拦截
          for (let i = 0; i < total; i++) {
            const dbName = selectedIds[i];

            try {
              // 显示当前正在处理哪个
              const progressToast = safeToastr.info(
                `正在导出 (${i + 1}/${total}): ${dbName}`,
                "",
                { timeOut: 2000 },
              );

              // 调用封装好的下载函数 (返回 Promise)
              await downloadSingleCollection(dbName);

              // 稍微等待一下，给浏览器喘息时间，防止被判定为恶意弹窗
              if (i < total - 1) {
                await new Promise((r) => setTimeout(r, 1000));
              }
            } catch (err) {
              toastr.error(`数据库 ${dbName} 导出失败: ${err.message}`);
            }
          }

          $btn.prop("disabled", false).html(originalHtml);
          toastr.success("所有导出任务已完成");
        },
      });
    });

  function downloadSingleCollection(dbName) {
    return new Promise((resolve, reject) => {
      $.ajax({
        type: "POST",
        url: "/api/plugins/anima-rag/export_collection", // 调用单个导出接口
        data: JSON.stringify({ collectionId: dbName }),
        contentType: "application/json",
        xhrFields: { responseType: "blob" }, // 关键：二进制流
        success: function (blob) {
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${dbName}_backup.zip`;
          document.body.appendChild(a);
          a.click();
          window.URL.revokeObjectURL(url);
          document.body.removeChild(a);
          resolve();
        },
        error: function (xhr) {
          let errMsg = xhr.statusText;
          if (xhr.response instanceof Blob) {
            const reader = new FileReader();
            reader.onload = function () {
              // 🔥 修复：强制类型断言，告诉编辑器 this.result 是 string
              const errorText = /** @type {string} */ (this.result);
              reject(new Error(errorText || "未知错误"));
            };
            reader.readAsText(xhr.response);
          } else {
            reject(new Error(errMsg));
          }
        },
      });
    });
  }
  // 1. 点击按钮触发 input
  $("#rag_btn_upload_zip")
    .off("click")
    .on("click", () => {
      $("#rag_input_import_zip").click();
    });
  // 2. 监听文件选择
  $("#rag_input_import_zip")
    .off("change")
    .on("change", async function () {
      const file = this.files[0];
      if (!file) return;

      // 重置 input value
      $(this).val("");

      const dbName = file.name.replace(/\.zip$/i, "");
      if (!dbName) return toastr.error("文件名无效");

      // A. 预检查：使用 $.ajax
      $.ajax({
        type: "POST",
        url: "/api/plugins/anima-rag/check_collection_exists",
        data: JSON.stringify({ collectionId: dbName }),
        contentType: "application/json",
        success: function (checkData) {
          let force = false;
          if (checkData.exists) {
            if (
              !confirm(
                `数据库 "${dbName}" 已存在于服务器。\n\n是否覆盖？(原有数据将丢失)`,
              )
            ) {
              return; // 用户取消
            }
            force = true;
          }

          // 开始读取文件
          readFileAndUpload(file, dbName, force);
        },
        error: function (xhr) {
          toastr.error("检查文件状态失败: " + xhr.responseText);
        },
      });
    });

  // 辅助函数：读取并上传
  function readFileAndUpload(file, dbName, force) {
    const reader = new FileReader();
    reader.onload = function (e) {
      const base64Content = e.target.result;

      // 类型转换，防止 VSCode 报错
      const safeToastr = /** @type {any} */ (toastr);
      const loadingToast = safeToastr.info("正在上传并解压...", "", {
        timeOut: 0,
      });

      // B. 上传：使用 $.ajax
      $.ajax({
        type: "POST",
        url: "/api/plugins/anima-rag/import_collection",
        data: JSON.stringify({
          collectionId: dbName,
          zipData: base64Content,
          force: force,
        }),
        contentType: "application/json",
        success: function (uploadResult) {
          if (safeToastr.clear) safeToastr.clear(loadingToast);

          if (uploadResult.success) {
            toastr.success(`导入成功: ${dbName}`);

            // 刷新列表
            const context = SillyTavern.getContext();
            if (context.chatId) {
              const currentFiles = getChatRagFiles() || [];
              renderFileList(currentFiles, context.chatId);
            }
          } else {
            toastr.error("导入失败");
          }
        },
        error: function (xhr) {
          if (safeToastr.clear) safeToastr.clear(loadingToast);
          toastr.error("上传错误: " + (xhr.responseText || xhr.statusText));
        },
      });
    };
    reader.readAsDataURL(file);
  }
  $("#rag_btn_kb_import").on("click", () => {
    $("#rag_input_knowledge_file").click();
  });

  // 监听文件选择
  // 🟢 [新增] 知识库文件上传处理
  $("#rag_input_knowledge_file")
    .off("change")
    .on("change", async function () {
      const files = this.files;
      if (!files || files.length === 0) return;

      // 获取当前配置 (切片参数)
      const currentSettings = getRagSettings(); // 确保你导出了这个或在作用域内

      const safeToastr = /** @type {any} */ (toastr);
      safeToastr.info(`正在处理 ${files.length} 个文档，请稍候...`, "", {
        timeOut: 0,
      });

      const newKbIds = [];

      // 引入 rag_logic 中的上传函数
      const { uploadKnowledgeBase } = await import("./rag_logic.js");

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
          // 1. 上传
          const result = await uploadKnowledgeBase(file, currentSettings);

          if (result.success) {
            // 后端返回的 collectionId 是 "kb_xxx"
            newKbIds.push(result.collectionId);
            toastr.success(`导入成功: ${file.name}`);
          }
        } catch (err) {
          toastr.error(`导入失败 ${file.name}: ${err.message}`);
        }
      }

      // 2. 自动关联到当前聊天
      if (newKbIds.length > 0) {
        toastr.info("文档已存入数据库。请在下方列表中手动勾选以启用。");
        renderUnifiedFileList();
      }

      // 清空 input 允许重复上传同名文件
      $(this).val("");
      safeToastr.clear();
    });

  // 查看按钮
  $("#rag_btn_kb_view").on("click", async () => {
    // 1. 获取所有可用数据库
    let allCollections = [];
    try {
      const { getAvailableCollections } = await import("./rag_logic.js");
      allCollections = await getAvailableCollections();
    } catch (e) {
      toastr.error("无法获取数据库列表");
      return;
    }

    // 2. 筛选 kb_ 开头的
    const kbCollections = allCollections.filter((id) => id.startsWith("kb_"));

    if (kbCollections.length === 0) {
      toastr.info("暂无知识库文件");
      return;
    }

    // 🟢 [UI修复] 添加样式覆盖，强制对齐
    // 关键点：height: 32px (与按钮一致), vertical-align: middle, box-sizing: border-box
    const inputFixStyle =
      "height:32px !important; min-height:32px; line-height:30px; box-sizing:border-box; padding: 0 5px; vertical-align:middle; font-size:13px;";

    // 3. 构建弹窗 HTML 骨架
    const modalHtml = `
            <div style="display:flex; gap:10px; align-items:center; margin-bottom:15px; background:rgba(0,0,0,0.2); padding:10px; border-radius:6px;">
                <div style="flex-shrink:0; font-weight:bold; color:#ddd; height:32px; line-height:32px;">选择知识库:</div>
                <select id="rag_kb_viewer_select" class="anima-select" style="flex:1; ${inputFixStyle} margin:0;">
                    <option value="" disabled selected>-- 请选择 --</option>
                    ${kbCollections.map((id) => `<option value="${id}">${id}</option>`).join("")}
                </select>
                <button id="rag_kb_viewer_refresh" class="anima-btn secondary small" style="height:32px; width:32px; padding:0; display:flex; align-items:center; justify-content:center;" title="刷新">
                    <i class="fa-solid fa-rotate"></i>
                </button>
            </div>
            
            <div id="rag_kb_viewer_content" class="anima-scroll" style="max-height:500px; overflow-y:auto; min-height:200px; padding-right:5px;">
                <div style="text-align:center; color:#666; margin-top:50px;">
                    <i class="fa-solid fa-book-open" style="font-size:30px; margin-bottom:10px; opacity:0.5;"></i><br>
                    请选择左上方数据库以查看内容
                </div>
            </div>
            <style>
                .kb-slice-item { border:1px solid #444; background:rgba(255,255,255,0.02); margin-bottom:8px; border-radius:4px; }
                .kb-slice-header { padding:8px 10px; cursor:pointer; display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.05); }
                .kb-slice-header:hover { background:rgba(255,255,255,0.08); }
                .kb-slice-body { padding:10px; border-top:1px solid #444; display:none; white-space:pre-wrap; font-size:12px; color:#ccc; line-height:1.5; }
            </style>
        `;

    showRagModal("📚 知识库查看器 (Knowledge Base Viewer)", modalHtml);

    // 4. 定义加载内容的函数
    const loadKbContent = async (collectionId) => {
      const $container = $("#rag_kb_viewer_content");
      $container.html(
        '<div style="text-align:center; padding:20px;"><i class="fa-solid fa-spinner fa-spin"></i> 加载切片中...</div>',
      );

      try {
        // 🟢 [网络修复] 将 fetch 替换为 $.ajax 以复用 ST 的 Token 和 Cookie
        const data = await new Promise((resolve, reject) => {
          $.ajax({
            type: "POST",
            url: "/api/plugins/anima-rag/view_collection",
            data: JSON.stringify({ collectionId }),
            contentType: "application/json",
            success: (resp) => resolve(resp),
            error: (xhr) =>
              reject(
                new Error(
                  xhr.responseText || xhr.statusText || "Request failed",
                ),
              ),
          });
        });

        if (!data.items || data.items.length === 0) {
          $container.html(
            '<div style="text-align:center; color:#aaa; padding:20px;">此数据库为空</div>',
          );
          return;
        }

        // 排序逻辑：按 chunk_index 排序
        data.items.sort((a, b) => {
          const idxA = a.metadata?.chunk_index ?? 999999;
          const idxB = b.metadata?.chunk_index ?? 999999;
          return idxA - idxB;
        });

        // 渲染列表
        const listHtml = data.items
          .map((item, idx) => {
            const meta = item.metadata || {};
            const chunkIndex =
              meta.chunk_index !== undefined ? meta.chunk_index : "N/A";
            // 截取前50个字符作为标题预览
            const preview =
              (item.text || "").slice(0, 50).replace(/\n/g, " ") + "...";

            return `
                    <div class="kb-slice-item">
                        <div class="kb-slice-header">
                            <div style="display:flex; align-items:center; gap:10px; overflow:hidden;">
                                <span style="font-family:monospace; color:#facc15; font-weight:bold; font-size:11px; flex-shrink:0;">#${chunkIndex}</span>
                                <span style="color:#ddd; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(preview)}</span>
                            </div>
                            <i class="fa-solid fa-chevron-down" style="color:#666; font-size:10px;"></i>
                        </div>
                        <div class="kb-slice-body">${escapeHtml(item.text)}</div>
                    </div>`;
          })
          .join("");

        $container.html(`
                    <div style="margin-bottom:10px; font-size:12px; color:#aaa;">
                        共找到 ${data.items.length} 个切片 (按 Index 排序)
                    </div>
                    ${listHtml}
                `);

        // 绑定折叠/展开
        $container.find(".kb-slice-header").on("click", function () {
          const $body = $(this).next(".kb-slice-body");
          const $icon = $(this).find(".fa-chevron-down");
          if ($body.is(":visible")) {
            $body.slideUp(100);
            $icon.css("transform", "rotate(0deg)");
          } else {
            $body.slideDown(100);
            $icon.css("transform", "rotate(180deg)");
          }
        });
      } catch (err) {
        console.error(err);
        $container.html(
          `<div style="text-align:center; color:#ef4444; padding:20px;">加载失败: ${err.message}</div>`,
        );
      }
    };

    // ... (后续绑定事件代码不变)
    // 5. 绑定下拉框事件
    $("#rag_kb_viewer_select").on("change", function () {
      const val = $(this).val();
      if (val) loadKbContent(val);
    });

    // 刷新按钮
    $("#rag_kb_viewer_refresh").on("click", () => {
      const val = $("#rag_kb_viewer_select").val();
      if (val) loadKbContent(val);
    });
  });
  // --- 策略导入/导出逻辑 ---

  // 1. 导出策略
  $("#rag_strategy_export")
    .off("click")
    .on("click", function () {
      // 导出包含：策略详情、基础计数、门槛分数、倍率、以及依赖的节日/生理配置
      const exportData = {
        base_count: settings.base_count,
        min_score: settings.min_score,
        strategy_settings: settings.strategy_settings,
        holidays: settings.holidays,
        period_config: settings.period_config,
        distributed_retrieval: settings.distributed_retrieval,
        virtual_time_mode: settings.virtual_time_mode,
      };

      const blob = new Blob([JSON.stringify(exportData, null, 4)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `rag_strategy_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toastr.success("包含节日/基础计数的完整策略已导出");
    });

  // 2. 触发导入点击
  $("#rag_strategy_import")
    .off("click")
    .on("click", () => {
      $("#rag_input_strategy_json").click();
    });

  // 3. 处理导入文件读取
  $("#rag_input_strategy_json")
    .off("change")
    .on("change", function (e) {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (e) => {
        // 使用 async 以便处理可能的异步保存
        try {
          const importedData = JSON.parse(e.target.result);

          // 1. 深度合并数据到当前的 settings 对象
          // 确保基础字段和 strategy_settings 都能被覆盖
          Object.assign(settings, importedData);

          // 2. 刷新表格外的“静态”输入框 (这些不在 renderStrategyTable 渲染范围内)
          $("#rag_base_count").val(settings.base_count || 2);
          $("#rag_min_score").val(settings.min_score || 0.5);
          $("#rag_multiplier").val(
            settings.strategy_settings?.candidate_multiplier || 2,
          );

          // 同步开关状态并手动触发 change 事件（以处理 UI 的显隐联动）
          $("#rag_distributed_switch")
            .prop("checked", !!settings.distributed_retrieval)
            .trigger("change");
          $("#rag_virtual_time_switch").prop(
            "checked",
            !!settings.virtual_time_mode,
          );

          // 3. 核心：重新调用渲染函数刷新策略列表
          // 这会根据最新的 settings.strategy_settings 和 settings.holidays 生成新表格
          renderStrategyTable(settings);

          // 4. 立即持久化到 SillyTavern 后端
          saveRagSettings(settings);

          toastr.success("配置已成功导入并自动保存");

          // 可选：如果导入涉及知识库设置变化，可以刷新文件列表
          // renderUnifiedFileList();
        } catch (err) {
          console.error("[Anima RAG] Import Error:", err);
          toastr.error("导入失败，请检查文件格式: " + err.message);
        }
      };
      reader.readAsText(file);
      $(this).val(""); // 清空 input 以允许重复导入同一文件
    });
}
