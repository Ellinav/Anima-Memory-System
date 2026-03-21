import { escapeHtml } from "./utils.js"; // 复用 rag.js 的弹窗和转义方法
import { uploadKnowledgeBase } from "./knowledge_logic.js";
import { getLastRetrievalPayload } from "./rag_logic.js";
import { getAnimaConfig } from "./api.js";
import { syncRagSettingsToWorldbook } from "./worldbook_api.js";

export function showKbModal(title, html) {
  $("#anima-kb-modal-title").text(title);
  $("#anima-kb-modal-body").html(html);
  $("#anima-kb-modal").removeClass("hidden");
}

const PARENT_MODULE_NAME = "anima_memory_system";

// 知识库专属默认配置
export const DEFAULT_KB_SETTINGS = {
  kb_enabled: true,
  knowledge_base: {
    delimiter: "",
    chunk_size: 500,
    write_vector: true,
    write_bm25: true,
    dictionary: "default",
    scan_floors: 3,
    search_top_k: 3, // 向量检索数量
    min_score: 0.5, // 向量最低相关性
    bm25_top_k: 3, // BM25 检索数量
  },
  knowledge_injection: {
    strategy: "constant",
    position: "before_character_definition",
    role: "system",
    depth: 0,
    order: 100,
    template: "以下是相关设定：\n{{knowledge}}",
  },
};

// ==========================================
// 🧠 状态管理 (全局字典映射 & 角色卡开关)
// ==========================================

// 获取全局 BM25 设置 (复用你提供的逻辑，用于读取词典列表)
function getGlobalBm25Settings() {
  const { extensionSettings } = SillyTavern.getContext();
  if (!extensionSettings.anima_memory_system)
    extensionSettings.anima_memory_system = {};
  if (!extensionSettings.anima_memory_system.bm25) {
    extensionSettings.anima_memory_system.bm25 = {
      custom_dicts: { default_dict: { words: [] } },
    };
  }
  return extensionSettings.anima_memory_system.bm25;
}

// 🌐 新增：获取全局知识库设置 (用于存储 知识库名 -> 词典名 的映射)
function getGlobalKbSettings() {
  const { extensionSettings } = SillyTavern.getContext();
  if (!extensionSettings.anima_memory_system)
    extensionSettings.anima_memory_system = {};
  if (!extensionSettings.anima_memory_system.kb) {
    extensionSettings.anima_memory_system.kb = {
      dict_mapping: {}, // 结构: { "kb_世界观": "default_dict" }
    };
  }
  return extensionSettings.anima_memory_system.kb;
}

// 保存全局设置
function saveGlobalSettings() {
  if (typeof SillyTavern === "undefined" || !SillyTavern.getContext) return;
  const { saveSettingsDebounced } = SillyTavern.getContext();
  if (typeof saveSettingsDebounced === "function") {
    saveSettingsDebounced();
  }
}

function getGlobalKbSettingsFull() {
  if (typeof SillyTavern === "undefined" || !SillyTavern.getContext)
    return DEFAULT_KB_SETTINGS;
  const { extensionSettings } = SillyTavern.getContext();
  if (!extensionSettings.anima_memory_system)
    extensionSettings.anima_memory_system = {};

  // 提取已保存的配置，如果没有则为空对象
  const savedSettings = extensionSettings.anima_memory_system.kb_settings || {};

  // 🌟 深度合并：以 DEFAULT_KB_SETTINGS 为底本，覆盖上用户已保存的配置
  // 这样即便以后我们给 DEFAULT 加了新字段，也不会因为旧存档报错
  const mergedSettings = $.extend(true, {}, DEFAULT_KB_SETTINGS, savedSettings);

  // 顺手写回内存，确保结构完整
  extensionSettings.anima_memory_system.kb_settings = mergedSettings;

  return mergedSettings;
}

// ==========================================
// 🧠 角色卡状态读写 (SillyTavern V2 Spec)
// ==========================================
function getCharKbSettings() {
  if (typeof SillyTavern === "undefined" || !SillyTavern.getContext)
    return { libs: [] };
  const { characterId, characters } = SillyTavern.getContext();
  if (characterId === undefined) return { libs: [] };
  const char = characters[characterId];
  return char.data?.extensions?.anima_kb_settings || { libs: [] };
}

async function saveCharKbSettings(libsConfig) {
  const { writeExtensionField, characterId } = SillyTavern.getContext();
  if (characterId === undefined)
    return toastr.warning("未选择角色，无法保存专属配置");
  try {
    await writeExtensionField(characterId, "anima_kb_settings", {
      libs: libsConfig,
    });
    toastr.success("知识库检索状态已保存至该角色卡！");
  } catch (e) {
    console.error("[Anima KB] 保存角色卡失败", e);
    toastr.error("保存角色卡发生异常");
  }
}

// ==========================================
// 🌐 后端数据获取与合并逻辑
// ==========================================
export async function loadAndRenderKbList() {
  const $list = $("#kb_management_list");
  if (!$list.length) return;
  $list.html(
    `<div style="text-align:center; padding: 20px; color: #666;"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>`,
  );

  let vectorLibs = [];
  let bm25Libs = [];

  try {
    const [vectorRes, bm25Res] = await Promise.all([
      $.ajax({
        url: "/api/plugins/anima-rag/list",
        type: "GET",
        dataType: "json",
      }).catch(() => []),
      $.ajax({
        url: "/api/plugins/anima-rag/bm25/list",
        type: "GET",
        dataType: "json",
      }).catch(() => []),
    ]);
    vectorLibs = (vectorRes || []).filter((name) => name.startsWith("kb_"));
    bm25Libs = (bm25Res || []).filter((name) => name.startsWith("kb_"));
  } catch (e) {
    return toastr.error("获取后端库列表失败");
  }

  const charSettings = getCharKbSettings();
  const charLibs = charSettings.libs || [];
  const kbSettings = getGlobalKbSettings(); // 取全局映射表
  const allUniqueNames = Array.from(new Set([...vectorLibs, ...bm25Libs]));

  if (allUniqueNames.length === 0) {
    $list.html(
      `<div style="text-align:center; padding: 20px; color: #666;">暂无构建的知识库</div>`,
    );
    return;
  }

  const html = allUniqueNames
    .map((kbName) => {
      const hasVector = vectorLibs.includes(kbName);
      const hasBm25 = bm25Libs.includes(kbName);
      const pref = charLibs.find((l) => l.name === kbName) || {
        vector_enabled: false,
        bm25_enabled: false,
      };

      // ✨ 兼容旧版字符串格式与新版对象格式，提取 dirty 属性
      const mappingData = kbSettings.dict_mapping[kbName];
      const mappedDict =
        typeof mappingData === "object" && mappingData !== null
          ? mappingData.dict
          : mappingData || "未绑定词典";
      const isDirty =
        typeof mappingData === "object" && mappingData !== null
          ? mappingData.dirty === true
          : false;

      const vectorWarning = hasVector
        ? ""
        : `<i class="fa-solid fa-triangle-exclamation" style="color:#f59e0b; font-size:12px; margin-right:5px;" title="向量库缺失"></i>`;
      const bm25Warning = hasBm25
        ? ""
        : `<i class="fa-solid fa-triangle-exclamation" style="color:#f59e0b; font-size:12px; margin-right:5px;" title="BM25库缺失"></i>`;

      // ✨ 核心视觉反馈：如果词典变脏且存在 BM25 库，把重建按钮变成醒目的黄色
      let bm25RebuildBtn = `<button class="anima-btn secondary small btn-rebuild-bm25" data-name="${escapeHtml(kbName)}" title="从当前词典 [${escapeHtml(mappedDict)}] 重建"><i class="fa-solid fa-rotate"></i></button>`;

      if (hasBm25 && isDirty) {
        bm25RebuildBtn = `<button class="anima-btn small btn-rebuild-bm25" style="background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4);" data-name="${escapeHtml(kbName)}" title="⚠️ 词典 [${escapeHtml(mappedDict)}] 已更新，强烈建议点击重建"><i class="fa-solid fa-rotate"></i></button>`;
      }

      return `
        <div class="kb-grid-row">
            <div class="kb-name-col" title="${escapeHtml(kbName)}">
                <i class="fa-solid fa-book" style="margin-right: 5px; color: ${isDirty ? "#fbbf24" : "#888"};"></i>${escapeHtml(kbName.replace(/^kb_/, ""))}
            </div>
            
            <div class="kb-action-group">
                ${vectorWarning}
                <label class="anima-switch"><input type="checkbox" class="kb-toggle-vector" data-name="${escapeHtml(kbName)}" data-exists="${hasVector}" ${pref.vector_enabled && hasVector ? "checked" : ""}><span class="slider round"></span></label>
                <button class="anima-btn secondary small btn-rebuild-vector" data-name="${escapeHtml(kbName)}" title="重新向量化"><i class="fa-solid fa-rotate"></i></button>
                <button class="anima-btn danger small btn-del-vector" data-name="${escapeHtml(kbName)}" title="仅删除向量库"><i class="fa-solid fa-trash"></i></button>
            </div>

            <div class="kb-action-group">
                ${bm25Warning}
                <label class="anima-switch"><input type="checkbox" class="kb-toggle-bm25" data-name="${escapeHtml(kbName)}" data-exists="${hasBm25}" ${pref.bm25_enabled && hasBm25 ? "checked" : ""}><span class="slider round"></span></label>
                ${bm25RebuildBtn}
                <button class="anima-btn danger small btn-del-bm25" data-name="${escapeHtml(kbName)}" title="仅删除BM25库"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>`;
    })
    .join("");

  $list.html(html);
}

// 模拟的词典列表
const mockDictionaries = ["default", "jieba_custom_1", "nlp_dict_v2"];

export function initKnowledgeSettings() {
  const container = document.getElementById("tab-knowledge");
  if (!container) return;

  // 🟢 核心修复：渲染 UI 时读取真实的全局设置，而不是 DEFAULT
  const settings = getGlobalKbSettingsFull();

  // 动态读取词典列表
  const globalBm25 = getGlobalBm25Settings();
  let dictionaries = Object.keys(globalBm25.custom_dicts || {});
  if (dictionaries.length === 0) {
    dictionaries = ["default_dict"]; // 兜底
  }

  // 渲染大框架
  renderKnowledgeUI(container, settings, [], dictionaries);

  // 首次加载下方知识库列表
  loadAndRenderKbList();
}

function renderKnowledgeUI(container, settings, kbList, dictionaries) {
  const style = `
    <style>
        .kb-grid-header { display: grid; grid-template-columns: 1.2fr 2fr 2fr; gap: 10px; padding: 10px; border-bottom: 1px solid #444; font-weight: bold; color: #aaa; text-align: center; font-size: 13px; }
        .kb-grid-row { display: grid; grid-template-columns: 1.2fr 2fr 2fr; gap: 10px; padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.05); align-items: center; text-align: center; font-size: 13px; transition: background 0.2s; }
        .kb-action-group { display: flex; align-items: center; justify-content: center; gap: 8px; }
        .kb-grid-row:hover { background: rgba(255,255,255,0.05); }
        .kb-name-col { text-align: left; font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .kb-dict-warning { color: #f87171 !important; } /* 词典变更时的红色警示 */
        
        .kb-file-badge { display: inline-block; padding: 4px 8px; background: rgba(59, 130, 246, 0.2); color: #60a5fa; border-radius: 4px; font-size: 12px; margin-right: 5px; margin-bottom: 5px; border: 1px solid rgba(59, 130, 246, 0.3); }
        
        /* 编辑弹窗里的切片样式 */
        .kb-edit-slice { border: 1px solid #444; border-radius: 4px; margin-bottom: 10px; background: rgba(0,0,0,0.2); }
        .kb-edit-slice-header { padding: 8px 10px; display: flex; justify-content: space-between; align-items: center; cursor: pointer; background: rgba(255,255,255,0.05); }
        .kb-edit-slice-body { padding: 10px; border-top: 1px solid #444; display: none; }
    </style>`;

  const dictOptionsHtml = dictionaries
    .map(
      (d) =>
        `<option value="${d}" ${settings.knowledge_base.dictionary === d ? "selected" : ""}>${d}</option>`,
    )
    .join("");

  const masterSwitchHtml = `
    <div class="anima-setting-group" style="margin-bottom: 10px;">
        <div class="anima-card" style="border-left: 4px solid var(--anima-primary);">
            <div class="anima-flex-row">
                <div class="anima-label-group">
                    <span class="anima-label-text" style="font-size: 1.1em; font-weight: bold;">知识库功能总开关</span>
                    <span class="anima-desc-inline">开启后启用知识库双擎检索与文本注入功能</span>
                </div>
                <label class="anima-switch">
                    <input type="checkbox" id="kb_master_switch" ${settings.kb_enabled ? "checked" : ""}>
                    <span class="slider round"></span>
                </label>
            </div>
        </div>
    </div>
    `;

  const contentVisibilityClass = settings.kb_enabled ? "" : "hidden";

  const mainHtml = `
  ${masterSwitchHtml}
    <div id="kb_main_content_wrapper">
        <div class="anima-setting-group">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 10px;">
                <h2 class="anima-title" style="margin:0;"><i class="fa-solid fa-magnifying-glass"></i> 知识库检索</h2>
                <button id="btn_kb_view_log" class="anima-btn secondary small" title="查看本次检索结果">
                    <i class="fa-solid fa-magnifying-glass-chart"></i> 查看最近检索
                </button>
            </div>
            <div class="anima-card">
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 10px;">
                    <div class="anima-compact-input">
                        <div class="anima-label-text">向量检索数量 (Top K)</div>
                        <input type="number" id="kb_search_vector_k" class="anima-input" style="height: 32px; box-sizing: border-box;" value="${settings.knowledge_base.search_top_k}" min="1" max="20">
                    </div>
                    <div class="anima-compact-input">
                        <div class="anima-label-text">向量最低相关性</div>
                        <input type="number" id="kb_search_min_score" class="anima-input" style="height: 32px; box-sizing: border-box;" value="${settings.knowledge_base.min_score}" step="0.05" min="0" max="1">
                    </div>
                </div>

                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 12px;">
                    <div class="anima-compact-input">
                        <div class="anima-label-text">BM25 检索数量 (Top K)</div>
                        <input type="number" id="kb_search_bm25_k" class="anima-input" style="height: 32px; box-sizing: border-box;" value="${settings.knowledge_base.bm25_top_k}" min="1" max="20">
                    </div>
                </div>
                <div>
                    <button id="btn_kb_save_search" class="anima-btn secondary" style="width:100%">
                        <i class="fa-solid fa-floppy-disk"></i> 保存检索配置
                    </button>
                </div>
            </div>
        </div>
        <div class="anima-setting-group">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 10px;">
                <h2 class="anima-title" style="margin:0;"><i class="fa-solid fa-server"></i> 知识库管理</h2>
                <div style="display:flex; gap: 8px;">
                    <button id="btn_kb_refresh_list" class="anima-btn secondary small" title="刷新列表"><i class="fa-solid fa-rotate"></i></button>
                    <button id="btn_kb_manage_modal" class="anima-btn primary small" title="查看切片"><i class="fa-solid fa-folder-open"></i> 查看</button>
                </div>
            </div>
            <div class="anima-card" style="padding: 0; overflow: hidden;">
                <div class="kb-grid-header">
                    <div style="text-align: left;">知识库名称</div>
                    <div>向量检索</div>
                    <div>BM25 检索</div>
                </div>
                <div id="kb_management_list" style="max-height: 300px; overflow-y: auto;">
                    <div style="text-align:center; padding: 20px; color: #666;"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>
                </div>
                
                <div style="padding: 10px; background: rgba(0,0,0,0.2); border-top: 1px solid rgba(255,255,255,0.05);">
                    <button id="btn_kb_save_char_settings" class="anima-btn secondary" style="width:100%;">
                        <i class="fa-solid fa-floppy-disk"></i> 保存到角色卡
                    </button>
                </div>
            </div>
        </div>

        <div class="anima-setting-group">
            <h2 class="anima-title"><i class="fa-solid fa-hammer"></i> 知识库构建</h2>
            <div class="anima-card">
                
                <div class="anima-flex-row" style="align-items: flex-start; margin-bottom: 15px;">
                    <div class="anima-label-group">
                        <span class="anima-label-text">源文件 (.txt / .md)</span>
                        <span class="anima-desc-inline">选择本地文本以构建新的知识库</span>
                    </div>
                    <div style="display:flex; gap:5px;">
                        <input type="file" id="kb_input_file" accept=".txt,.md,.json" multiple style="display:none;" />
                        <button id="btn_kb_select_file" class="anima-btn secondary small"><i class="fa-solid fa-file-circle-plus"></i> 选择文件</button>
                        <button id="btn_kb_clear_file" class="anima-btn danger small"><i class="fa-solid fa-eraser"></i> 清空</button>
                    </div>
                </div>
                
                <div id="kb_selected_files_area" style="margin-bottom: 15px; display: none; padding: 10px; background: rgba(0,0,0,0.2); border: 1px dashed #555; border-radius: 4px;">
                    </div>

                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px;">
                    <div class="anima-compact-input">
                        <div class="anima-label-small">自定义切分符</div>
                        <input type="text" id="kb_build_delimiter" class="anima-input" placeholder="例如: ###" value="${escapeHtml(settings.knowledge_base.delimiter)}">
                    </div>
                    <div class="anima-compact-input">
                        <div class="anima-label-small">智能字数限制</div>
                        <input type="number" id="kb_build_chunk_size" class="anima-input" value="${settings.knowledge_base.chunk_size}" min="50" step="50">
                    </div>
                </div>

                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px;">
                    <div class="anima-flex-row">
                        <span class="anima-label-text" style="font-size: 13px;">写入向量库</span>
                        <label class="anima-switch">
                            <input type="checkbox" id="kb_build_write_vector" ${settings.knowledge_base.write_vector ? "checked" : ""}>
                            <span class="slider round"></span>
                        </label>
                    </div>
                    <div class="anima-flex-row">
                        <span class="anima-label-text" style="font-size: 13px;">写入 BM25</span>
                        <label class="anima-switch">
                            <input type="checkbox" id="kb_build_write_bm25" ${settings.knowledge_base.write_bm25 ? "checked" : ""}>
                            <span class="slider round"></span>
                        </label>
                    </div>
                </div>

                <div class="anima-flex-row" style="margin-bottom: 15px;">
                    <div class="anima-label-group">
                        <span class="anima-label-text">BM25 词典选择</span>
                        <span class="anima-desc-inline">更换词典会影响检索粒度</span>
                    </div>
                    <div style="display:flex; gap: 10px; align-items: center;">
                        <select id="kb_build_dict_select" class="anima-select" style="height: 32px; width: 150px; box-sizing: border-box; padding: 0 10px; line-height: 30px; vertical-align: middle; margin: 0;">
                            ${dictOptionsHtml}
                        </select>
                        <button id="btn_kb_add_dict" class="anima-btn secondary small" title="新增自定义词典" style="height: 32px; margin: 0; display: flex; align-items: center; justify-content: center;"><i class="fa-solid fa-plus"></i></button>
                    </div>
                </div>

                <div style="display: flex; gap: 10px; margin-top: 20px;">
                    <button id="btn_kb_save_config" class="anima-btn secondary" style="flex: 1">
                        <i class="fa-solid fa-floppy-disk"></i> 保存配置
                    </button>
                    <button id="btn_kb_execute_build" class="anima-btn primary" style="flex: 1">
                        <i class="fa-solid fa-bolt"></i> 一键构建
                    </button>
                </div>

            </div>
        </div>
        

        <div class="anima-setting-group">
            <h2 class="anima-title"><i class="fa-solid fa-syringe"></i> 结果注入配置</h2>
            <div class="anima-card">
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px;">
                     <div class="anima-compact-input">
                        <div class="anima-label-text">触发策略</div>
                        <select id="kb_inject_strategy" class="anima-select" style="height: 32px; box-sizing: border-box; padding: 0 10px; line-height: 30px;">
                            <option value="constant" ${settings.knowledge_injection?.strategy === "constant" ? "selected" : ""}>🔵 常驻 (Constant)</option>
                            <option value="selective" ${settings.knowledge_injection?.strategy === "selective" ? "selected" : ""}>🟢 按需 (Selective)</option>
                        </select>
                    </div>
                     <div class="anima-compact-input">
                        <div class="anima-label-text">插入位置</div>
                        <select id="kb_inject_position" class="anima-select" style="height: 32px; box-sizing: border-box; padding: 0 10px; line-height: 30px;">
                            <option value="at_depth" ${settings.knowledge_injection?.position === "at_depth" ? "selected" : ""}>@D (指定深度)</option>
                            <option value="before_character_definition" ${settings.knowledge_injection?.position === "before_character_definition" ? "selected" : ""}>⬆️ 角色定义之前</option>
                            <option value="after_character_definition" ${settings.knowledge_injection?.position === "after_character_definition" ? "selected" : ""}>⬇️ 角色定义之后</option>
                        </select>
                    </div>
                </div>

                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px; margin-bottom: 15px;">
                     <div class="anima-compact-input">
                        <div class="anima-label-text">角色归属</div>
                        <select id="kb_inject_role" class="anima-select" style="height: 32px; box-sizing: border-box; padding: 0 10px; line-height: 30px;">
                            <option value="system" ${settings.knowledge_injection?.role === "system" ? "selected" : ""}>System</option>
                            <option value="user" ${settings.knowledge_injection?.role === "user" ? "selected" : ""}>User</option>
                            <option value="assistant" ${settings.knowledge_injection?.role === "assistant" ? "selected" : ""}>Assistant</option>
                        </select>
                    </div>
                    <div class="anima-compact-input">
                        <div class="anima-label-text">深度</div>
                        <input type="number" id="kb_inject_depth" class="anima-input" style="height: 32px; box-sizing: border-box;" value="${settings.knowledge_injection?.depth ?? 0}" step="1" min="0">
                    </div>
                    <div class="anima-compact-input">
                        <div class="anima-label-text">顺序</div>
                        <input type="number" id="kb_inject_order" class="anima-input" style="height: 32px; box-sizing: border-box;" value="${settings.knowledge_injection?.order ?? 100}" step="1">
                    </div>
                </div>

                <div style="margin-bottom: 15px;">
                    <div class="anima-label-small" style="margin-bottom: 5px;">知识库模板</div>
                    <div class="anima-desc-inline" style="margin-bottom:8px;">将写入独立的世界书条目。使用 <code>{{knowledge}}</code> 作为占位符。</div>
                    <textarea id="kb_inject_template" class="anima-textarea" rows="4" style="width: 100%; box-sizing: border-box; resize: vertical;">${escapeHtml(settings.knowledge_injection?.template || "以下是相关设定：\n{{knowledge}}")}</textarea>
                </div>
                
                <div>
                    <button id="btn_kb_save_injection" class="anima-btn primary" style="width:100%;">
                        <i class="fa-solid fa-floppy-disk"></i> 保存注入配置
                    </button>
                </div>

            </div>
        </div>

        <div id="anima-kb-modal" class="anima-modal hidden">
             <div class="anima-modal-content">
                <div class="anima-modal-header">
                    <h3 id="anima-kb-modal-title">标题</h3>
                    <span class="anima-close-kb-modal" style="cursor:pointer; font-size:20px;">&times;</span>
                </div>
                <div id="anima-kb-modal-body" class="anima-modal-body"></div>
             </div>
        </div>
    </div>
    `;

  container.innerHTML = style + mainHtml;
  bindKnowledgeEvents(dictionaries);
}

function bindKnowledgeEvents(dictionaries) {
  const $container = $("#tab-knowledge");

  // === 0. 总开关控制 ===
  $container.find("#kb_master_switch").on("change", function () {
    const isEnabled = $(this).prop("checked");

    if (isEnabled) {
      $container.find("#kb_main_content_wrapper").removeClass("hidden");
      toastr.success("知识库功能已开启");
    } else {
      $container.find("#kb_main_content_wrapper").addClass("hidden");
      toastr.info("知识库功能已关闭");
    }

    // 模拟保存状态
    console.log("[Anima KB] 知识库总开关状态已保存为:", isEnabled);
  });

  // === 1. 构建区：文件选择与清空 ===
  let selectedFiles = [];
  $container.find("#btn_kb_select_file").on("click", () => {
    $container.find("#kb_input_file").click();
  });

  $container.find("#kb_input_file").on("change", function () {
    if (!this.files || this.files.length === 0) return;
    selectedFiles = Array.from(this.files);

    const $area = $container.find("#kb_selected_files_area");
    $area.empty().show();

    selectedFiles.forEach((f) => {
      $area.append(
        `<span class="kb-file-badge"><i class="fa-solid fa-file-lines" style="margin-right:4px;"></i>${escapeHtml(f.name)}</span>`,
      );
    });
  });
  $(".anima-close-kb-modal").on("click", () =>
    $("#anima-kb-modal").addClass("hidden"),
  );
  $container.find("#btn_kb_clear_file").on("click", () => {
    selectedFiles = [];
    $container.find("#kb_input_file").val("");
    $container.find("#kb_selected_files_area").empty().hide();
    toastr.info("已清空选中文件");
  });

  // === 2. 构建区：功能按钮 ===
  $container.find("#btn_kb_add_dict").on("click", () => {
    // 构建弹窗 HTML
    const modalHtml = `
            <div style="display:flex; gap:10px; margin-bottom:15px; align-items:center;">
                <div style="font-weight:bold; color:#ddd; width:65px; font-size: 13px; line-height: 32px;">词典名称</div>
                <input type="text" id="kb_new_dict_name" class="anima-input" placeholder="例如: 魔法世界专属词典" style="flex:1; height:32px; box-sizing:border-box; margin:0; padding:0 10px;">
            </div>
            
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                <div style="font-size: 11px; color: #aaa;"><i class="fa-solid fa-circle-info"></i> 若触发词留空，则默认等同于索引词。</div>
                <div style="display:flex; gap: 10px;">
                    <button id="btn_kb_dict_auto" class="anima-btn secondary small" title="尝试从文本中提取专有名词"><i class="fa-solid fa-wand-magic-sparkles"></i> 自动检测</button>
                    <button id="btn_kb_dict_add_row" class="anima-btn primary small"><i class="fa-solid fa-plus"></i> 添加</button>
                </div>
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr 30px; gap:10px; padding:8px; border-bottom:1px solid rgba(255,255,255,0.1); font-weight:bold; color:#aaa; font-size:12px; text-align:center;">
                <div style="text-align: left;">触发词 (用户输入)</div>
                <div style="text-align: left;">索引词 (切片提取)</div>
                <div>操作</div>
            </div>

            <div id="kb_dict_rows_container" class="anima-scroll" style="max-height: 250px; overflow-y: auto; padding-right: 5px; margin-bottom: 15px;">
                <div id="kb_dict_empty_tip" style="text-align:center; padding: 20px; color: #666; font-size: 12px;">暂无词条，点击添加或自动检测</div>
            </div>

            <div>
                <button id="btn_kb_dict_save_modal" class="anima-btn primary" style="width:100%; height: 36px;">
                    <i class="fa-solid fa-check"></i> 生成并应用该词典
                </button>
            </div>
        `;

    // 呼出专属弹窗
    showKbModal("新增自定义词典", modalHtml);

    const $modalBody = $("#anima-kb-modal-body");
    const $containerDiv = $modalBody.find("#kb_dict_rows_container");
    const $emptyTip = $modalBody.find("#kb_dict_empty_tip");

    // 辅助函数：添加新行
    const addRow = (triggerVal = "", indexVal = "") => {
      $emptyTip.hide();
      const rowHtml = `
                <div class="kb-dict-row" style="display:grid; grid-template-columns:1fr 1fr 30px; gap:10px; padding: 5px 0; align-items:center; border-bottom:1px dashed rgba(255,255,255,0.05);">
                    <input type="text" class="anima-input dict-trigger" placeholder="留空则同右" value="${escapeHtml(triggerVal)}" style="height: 28px; font-size: 12px; box-sizing: border-box; margin: 0; padding: 0 8px; line-height: 26px;">
                    <input type="text" class="anima-input dict-index" placeholder="必填" value="${escapeHtml(indexVal)}" style="height: 28px; font-size: 12px; box-sizing: border-box; margin: 0; padding: 0 8px; line-height: 26px;">
                    <button class="anima-btn danger small btn-del-dict-row" style="height: 28px; padding: 0; display:flex; align-items:center; justify-content:center; margin: 0;"><i class="fa-solid fa-xmark"></i></button>
                </div>
            `;
      $containerDiv.append(rowHtml);
      $containerDiv.scrollTop($containerDiv[0].scrollHeight);
    };

    // 事件：点击添加行
    $modalBody.find("#btn_kb_dict_add_row").on("click", () => addRow());

    // 事件：删除行
    $modalBody.on("click", ".btn-del-dict-row", function () {
      $(this).closest(".kb-dict-row").remove();
      if ($containerDiv.find(".kb-dict-row").length === 0) {
        $emptyTip.show();
      }
    });

    // 事件：自动检测 (模拟)
    $modalBody.find("#btn_kb_dict_auto").on("click", () => {
      toastr.info("正在分析上传文本中的专有名词...");
      // 模拟延迟后添加捕获到的词汇
      setTimeout(() => {
        addRow("", "艾泽拉斯");
        addRow("法师, 魔法师", "奥术师");
        addRow("", "霜之哀伤");
        toastr.success("已检测到 3 个特征词");
      }, 800);
    });

    // 事件：保存并应用
    $modalBody.find("#btn_kb_dict_save_modal").on("click", () => {
      const dictName = $modalBody.find("#kb_new_dict_name").val().trim();
      if (!dictName) return toastr.warning("必须填写词典名称！");

      const wordPairs = [];
      let hasError = false;

      $modalBody.find(".kb-dict-row").each(function () {
        const triggerStr = $(this).find(".dict-trigger").val().trim();
        const indexStr = $(this).find(".dict-index").val().trim();

        if (!indexStr) {
          hasError = true;
          return false; // break loop
        }

        // 如果触发词为空，则触发词 = 索引词
        const finalTrigger = triggerStr === "" ? indexStr : triggerStr;
        wordPairs.push({ trigger: finalTrigger, index: indexStr });
      });

      if (hasError) return toastr.warning("索引词不能为空！");

      // TODO: 调用后端接口将词典存储到服务器
      console.log(`[Anima KB] 生成新词典 '${dictName}':`, wordPairs);

      // 更新 UI 的下拉框并选中
      $container
        .find("#kb_build_dict_select")
        .append(`<option value="${dictName}" selected>${dictName}</option>`);

      // 关闭弹窗
      $("#anima-kb-modal").addClass("hidden");
      toastr.success("自定义词典已保存并在当前选中");
    });
  });

  $container
    .find("#btn_kb_save_config")
    .off("click")
    .on("click", () => {
      const settings = getGlobalKbSettingsFull();

      settings.knowledge_base.delimiter = $("#kb_build_delimiter").val() || "";
      settings.knowledge_base.chunk_size =
        parseInt($("#kb_build_chunk_size").val()) || 500;
      settings.knowledge_base.dictionary = $("#kb_build_dict_select").val(); // 顺便保存默认选中的词典

      saveGlobalSettings();
      toastr.success("知识库构建配置已保存至全局");
    });
  // === 新增：滑块开关即时更新与保存 ===
  $container
    .find("#kb_build_write_vector, #kb_build_write_bm25")
    .off("change")
    .on("change", function () {
      const settings = getGlobalKbSettingsFull(); // 获取引用

      // 实时更新对象的具体字段
      settings.knowledge_base.write_vector = $("#kb_build_write_vector").prop(
        "checked",
      );
      settings.knowledge_base.write_bm25 = $("#kb_build_write_bm25").prop(
        "checked",
      );

      saveGlobalSettings(); // 落盘
    });

  $container
    .find("#btn_kb_execute_build")
    .off("click")
    .on("click", async () => {
      if (selectedFiles.length === 0) return toastr.warning("请先选择源文件！");

      // 1. 获取前端 UI 配置
      const delimiter = $("#kb_build_delimiter").val() || "";
      const chunkSize = parseInt($("#kb_build_chunk_size").val()) || 500;
      const writeVector = $("#kb_build_write_vector").prop("checked");
      const writeBm25 = $("#kb_build_write_bm25").prop("checked");
      const dictName = $("#kb_build_dict_select").val();

      if (!writeVector && !writeBm25) {
        return toastr.warning("向量库和 BM25 至少需要选择写入一项！");
      }

      // 2. 提取要传给后端的真实词典规则
      const globalBm25 = getGlobalBm25Settings();
      const dictContent = globalBm25.custom_dicts[dictName]?.words || [];

      toastr.info("🚀 开始上传并构建知识库...");
      const $btn = $("#btn_kb_execute_build");
      $btn
        .prop("disabled", true)
        .html(`<i class="fa-solid fa-spinner fa-spin"></i> 构建中...`);

      try {
        // 3. 遍历打包配置并上传
        for (const file of selectedFiles) {
          await uploadKnowledgeBase(file, {
            delimiter,
            chunk_size: chunkSize,
            write_vector: writeVector,
            write_bm25: writeBm25,
            dictName: dictName,
            dictContent: dictContent,
          });

          // 🌟 4. 构建成功后，如果开启了 BM25，立刻将该知识库与选择的词典绑定到全局
          if (writeBm25) {
            const safeName = file.name
              .replace(/\.[^/.]+$/, "")
              .replace(/[^a-zA-Z0-9@\-\._\u4e00-\u9fa5]/g, "_");
            const kbName = `kb_${safeName}`;

            const kbSettings = getGlobalKbSettings();
            // ✨ 修改点：存储为对象结构，默认 dirty 为 false
            kbSettings.dict_mapping[kbName] = { dict: dictName, dirty: false };
            saveGlobalSettings();
          }
        }

        toastr.success("所有选中文件构建完成！");

        // 清空选中区
        selectedFiles = [];
        $container.find("#kb_input_file").val("");
        $container.find("#kb_selected_files_area").empty().hide();

        // 自动刷新下方管理列表
        loadAndRenderKbList();
      } catch (err) {
        console.error("[Anima KB] 构建异常:", err);
        toastr.error("构建失败: " + (err.responseJSON?.message || err.message));
      } finally {
        // 恢复按钮状态
        $btn
          .prop("disabled", false)
          .html(`<i class="fa-solid fa-bolt"></i> 一键构建`);
      }
    });

  $container.find(".btn-delete-kb").on("click", function () {
    const kbName = $(this).data("name");
    if (
      confirm(
        `⚠️ 确定要彻底删除知识库 "${kbName}" 吗？\n这将同时删除其关联的向量库和 BM25 索引，且不可恢复！`,
      )
    ) {
      // TODO: 接入后端删除 API
      $(this)
        .closest(".kb-grid-row")
        .fadeOut(300, function () {
          $(this).remove();
        });
      toastr.success(`已删除知识库: ${kbName}`);
    }
  });

  $container.find(".btn-edit-kb").on("click", function () {
    const kbName = $(this).data("name");
    showKbEditModal(kbName, dictionaries);
  });

  // === 4. 检索与注入配置区 ===

  // 注入位置联动（当选择非 at_depth 时，自动禁用深度输入框）
  $container.find("#kb_inject_position").on("change", function () {
    const val = $(this).val();
    const $depthInput = $container.find("#kb_inject_depth");
    if (val === "at_depth") {
      $depthInput.prop("disabled", false).css("opacity", 1);
    } else {
      $depthInput.prop("disabled", true).css("opacity", 0.5);
    }
  });
  // 初始触发一次联动检查
  $container.find("#kb_inject_position").trigger("change");

  // 保存检索配置按钮
  $container
    .find("#btn_kb_save_search")
    .off("click")
    .on("click", () => {
      const settings = getGlobalKbSettingsFull();

      const searchVK = parseInt($("#kb_search_vector_k").val());
      settings.knowledge_base.search_top_k = !isNaN(searchVK) ? searchVK : 3;

      const minScore = parseFloat($("#kb_search_min_score").val());
      settings.knowledge_base.min_score = !isNaN(minScore) ? minScore : 0.5;

      const bm25K = parseInt($("#kb_search_bm25_k").val());
      settings.knowledge_base.bm25_top_k = !isNaN(bm25K) ? bm25K : 3;

      saveGlobalSettings();
      toastr.success("知识库检索配置已保存");
    });

  // === 4. 结果注入区：手动保存 ===
  $container
    .find("#btn_kb_save_injection")
    .off("click")
    .on("click", async () => {
      const settings = getGlobalKbSettingsFull();

      settings.knowledge_injection.strategy = $("#kb_inject_strategy").val();
      settings.knowledge_injection.position = $("#kb_inject_position").val();
      settings.knowledge_injection.role = $("#kb_inject_role").val();
      settings.knowledge_injection.depth =
        parseInt($("#kb_inject_depth").val()) || 0;
      settings.knowledge_injection.order =
        parseInt($("#kb_inject_order").val()) || 100;
      settings.knowledge_injection.template = $("#kb_inject_template").val();

      saveGlobalSettings();

      // 🌟 新增：强制将刚刚保存的配置立刻刷入当前聊天的世界书中
      if (typeof syncRagSettingsToWorldbook === "function") {
        await syncRagSettingsToWorldbook();
      }

      toastr.success("知识库注入配置已保存，并已实时应用到世界书！");
    });

  // === 5. 查看检索日志 (双轨独立展示版) ===
  $container
    .find("#btn_kb_view_log")
    .off("click")
    .on("click", () => {
      // 🚨 拦截未开启知识库检索的情况
      const globalSettings = getGlobalKbSettingsFull();
      const charSettings = getCharKbSettings();
      const activeLibs = charSettings.libs || [];
      const hasActiveKb =
        globalSettings.kb_enabled &&
        activeLibs.some((lib) => lib.vector_enabled || lib.bm25_enabled);

      if (!hasActiveKb) {
        toastr.warning("没有打开任何知识库检索");
        return;
      }

      if (typeof getLastRetrievalPayload === "undefined") {
        toastr.error("缺失 getLastRetrievalPayload 方法，请检查 import");
        return;
      }

      const payload = getLastRetrievalPayload();

      if (!payload) {
        toastr.info("暂无检索记录 (请先进行一次对话)");
        return;
      }

      // 1. 获取独立的检索结果
      const vectorResults =
        payload.kb_results || payload.vector_kb_results || [];
      const bm25Results = payload.bm25_kb_results || [];

      // 2. 核心排序逻辑：按文件名 -> 序号
      const sortByScoreDesc = (a, b) => {
        const scoreA = parseFloat(a.score) || 0;
        const scoreB = parseFloat(b.score) || 0;
        return scoreB - scoreA; // 分数高的排在前面
      };

      vectorResults.sort(sortByScoreDesc);
      bm25Results.sort(sortByScoreDesc);

      // 3. 提取双轨 Query (兼容旧版只有单 query 的情况)
      const vectorQueryText = payload.query || "未记录向量查询词";
      const bm25QueryText =
        payload.bm25Query || "未记录BM25查询词 (可能未开启或文本为空)";

      const sectionHeaderStyle =
        "font-size:13px; color:#ddd; font-weight:bold; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 5px; margin-top: 15px; margin-bottom: 10px;";

      // 4. 辅助渲染函数：生成 Query 块
      const renderQueryBlock = (text, title, borderColor) => {
        const queryLen = text.length;
        return `
        <div style="margin-bottom:15px; padding:10px; background:rgba(0,0,0,0.2); border-radius:4px; border-left: 3px solid ${borderColor};">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
                <div style="font-size:12px; color:#aaa; font-weight:bold;">${title}</div>
                <div style="font-size:12px; color:#aaa; font-family:monospace;">Length: ${queryLen}</div>
            </div>
            <div style="color:#eee; font-size:13px; white-space: pre-wrap;">${escapeHtml(text)}</div>
        </div>
        `;
      };

      // 5. 辅助渲染函数：生成结果块
      const renderBlocks = (
        results,
        title,
        colorHex,
        colorRgba,
        iconClass,
        isBm25 = false,
      ) => {
        if (results.length === 0) {
          return `
            <div style="${sectionHeaderStyle}"><i class="${iconClass}" style="color:${colorHex}; margin-right:5px;"></i>${title} (0)</div>
            <div style="padding:10px; text-align:center; color:#666; font-size: 12px; background: rgba(0,0,0,0.1); border-radius: 4px;">未命中任何相关切片</div>
         `;
        }

        const totalLen = results.reduce(
          (acc, item) => acc + (item.text || "").length,
          0,
        );
        let html = `
        <div style="display:flex; justify-content:space-between; align-items:flex-end; ${sectionHeaderStyle}">
            <div><i class="${iconClass}" style="color:${colorHex}; margin-right:5px;"></i>${title} (${results.length})</div>
            <div style="font-size:11px; color:#aaa; font-family:monospace; font-weight:normal;">总字数：${totalLen}</div>
        </div>
        `;

        html += results
          .map((item, idx) => {
            const displayId =
              item.chunk_index !== undefined
                ? `Chunk #${item.chunk_index}`
                : item.index || item.id || "N/A";
            const sourceDb =
              item.doc_name || item._source_collection || "Unknown";
            const displayScore = `Score: ${typeof item.score === "number" ? item.score.toFixed(4) : item.score}`;

            let matchInfoHtml = "";
            if (isBm25) {
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

              if (item.match && typeof item.match === "object") {
                const matchedTerms = filterNoise(Object.keys(item.match));
                if (matchedTerms) {
                  matchInfoHtml = `<div style="font-size:11px; color:${colorHex}; margin-bottom:6px; background: ${colorRgba}; padding: 4px 6px; border-radius: 4px; border: 1px dashed ${colorHex}40;">🎯 <b>命中核心词:</b> ${escapeHtml(matchedTerms)}</div>`;
                }
              } else if (item.terms && Array.isArray(item.terms)) {
                const matchedTerms = filterNoise(item.terms);
                if (matchedTerms) {
                  matchInfoHtml = `<div style="font-size:11px; color:${colorHex}; margin-bottom:6px; background: ${colorRgba}; padding: 4px 6px; border-radius: 4px; border: 1px dashed ${colorHex}40;">🎯 <b>命中核心词:</b> ${escapeHtml(matchedTerms)}</div>`;
                }
              }
            }

            return `
            <div class="anima-preview-block" style="border:1px solid ${colorHex}; margin-bottom:8px; border-radius:4px; overflow:hidden;">
                <div class="block-header" style="background:${colorRgba}; border-bottom: 1px solid rgba(255,255,255,0.05); padding:6px 10px; font-size:12px; display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <span style="color:${colorHex}; font-weight:bold;">#${idx + 1}</span>
                        <span style="color:#fff; font-weight:bold; margin:0 6px; font-family:monospace;">[${escapeHtml(displayId)}]</span>
                        <span style="color:${colorHex}; opacity: 0.8;">${escapeHtml(displayScore)}</span>
                    </div>
                    <span style="color:#aaa; font-size:11px;" title="来源文档">
                        <i class="fa-solid fa-file-lines" style="margin-right:4px;"></i>${escapeHtml(sourceDb)}
                    </span>
                </div>
                <div class="block-content" style="padding:10px; font-size:12px; color:#ccc; background:rgba(0,0,0,0.2); max-height:150px; overflow-y:auto;">
                    ${matchInfoHtml}
                    <div style="white-space:pre-wrap;">${escapeHtml(item.text)}</div>
                </div>
            </div>`;
          })
          .join("");

        return html;
      };

      // 6. 拼装最终的 HTML
      let contentHtml = "";

      // === 向量区 ===
      contentHtml += renderQueryBlock(
        vectorQueryText,
        "🧠 向量检索 Query (基于 RAG 设定)",
        "#a855f7",
      );
      contentHtml += renderBlocks(
        vectorResults,
        "向量检索结果",
        "#a855f7",
        "rgba(168, 85, 247, 0.15)",
        "fa-solid fa-cube",
        false,
      );

      // 分隔符
      contentHtml += `<div style="margin: 25px 0; border-bottom: 1px dashed rgba(255,255,255,0.1);"></div>`;

      // === BM25区 ===
      contentHtml += renderQueryBlock(
        bm25QueryText,
        "📚 BM25 检索 Query (基于 BM25 设定)",
        "#3b82f6",
      );
      contentHtml += renderBlocks(
        bm25Results,
        "BM25 检索结果",
        "#3b82f6",
        "rgba(59, 130, 246, 0.15)",
        "fa-solid fa-layer-group",
        true,
      );

      // 7. 呼出弹窗
      showKbModal(
        "知识库双轨检索日志",
        `<div style="padding:10px;">${contentHtml}</div>`,
      );
    });

  // === 知识库管理区：列表刷新与角色卡保存 ===
  $container.find("#btn_kb_refresh_list").on("click", () => {
    loadAndRenderKbList();
  });

  $container.find("#btn_kb_save_char_settings").on("click", async () => {
    const libsConfig = [];

    // 遍历列表里的每一行，抓取选中状态
    $container.find(".kb-grid-row").each(function () {
      // 🚨 核心修复：旧的 .btn-delete-kb 已经不存在了，直接从 switch 开关上提取名字
      const kbName =
        $(this).find(".kb-toggle-vector").data("name") ||
        $(this).find(".kb-toggle-bm25").data("name");

      if (!kbName) return; // 防御性跳过空行

      const vector_enabled =
        $(this).find(".kb-toggle-vector").prop("checked") || false;
      const bm25_enabled =
        $(this).find(".kb-toggle-bm25").prop("checked") || false;

      // 只有至少开启一项时才存入
      if (vector_enabled || bm25_enabled) {
        libsConfig.push({
          name: kbName,
          vector_enabled: vector_enabled,
          bm25_enabled: bm25_enabled,
        });
      }
    });

    // 写入 SillyTavern 角色卡 extension
    await saveCharKbSettings(libsConfig);
  });

  // === 辅助弹窗函数：弹出词典选择并执行 BM25 重构 ===
  const triggerBm25Rebuild = (kbName, toggleCheckbox = null) => {
    const globalBm25 = getGlobalBm25Settings();
    const kbSettings = getGlobalKbSettings();
    const dictNames = Object.keys(globalBm25.custom_dicts || {});

    // ✨ 兼容提取
    const mappingData = kbSettings.dict_mapping[kbName];
    const currentMappedDict =
      typeof mappingData === "object" && mappingData !== null
        ? mappingData.dict
        : mappingData || dictNames[0] || "";

    if (dictNames.length === 0) {
      return toastr.warning("全局未发现任何可用词典，请先去 BM25 页面创建！");
    }

    const optionsHtml = dictNames
      .map(
        (d) =>
          `<option value="${escapeHtml(d)}" ${d === currentMappedDict ? "selected" : ""}>${escapeHtml(d)}</option>`,
      )
      .join("");

    const modalHtml = `
          <div style="margin-bottom: 15px;">
              <label style="display:block; margin-bottom:8px; color:#ddd;">请选择用于提取专有名词的词典：</label>
              <select id="modal_bm25_dict_select" class="anima-select" style="width:100%; height:36px; padding: 0 10px;">
                  ${optionsHtml}
              </select>
              <div style="font-size:11px; color:#888; margin-top:8px;">
                  <i class="fa-solid fa-circle-info"></i> 重建将遍历对应的向量库，重新进行中文分词并打上索引标签。
              </div>
          </div>
          <div style="text-align:right;">
              <button id="btn_modal_confirm_bm25" class="anima-btn primary" style="width:100%;"><i class="fa-solid fa-bolt"></i> 确认开始重建</button>
          </div>
      `;

    showKbModal(`构建 BM25: ${escapeHtml(kbName)}`, modalHtml);

    $("#btn_modal_confirm_bm25")
      .off("click")
      .on("click", async () => {
        const selectedDict = $("#modal_bm25_dict_select").val();
        $("#anima-kb-modal").addClass("hidden");

        // ✨ 修改点 1：使用新的对象格式保存，并在此刻立刻洗白 dirty 状态
        kbSettings.dict_mapping[kbName] = { dict: selectedDict, dirty: false };
        saveGlobalSettings();

        // 2. 获取真实的词典数据
        const dictContent = globalBm25.custom_dicts[selectedDict]?.words || [];

        try {
          const res = await $.ajax({
            url: "/api/plugins/anima-rag/bm25/rebuild_collection",
            type: "POST",
            contentType: "application/json",
            data: JSON.stringify({
              collectionId: kbName,
              bm25Config: { enabled: true, dictionary: dictContent },
            }),
          });

          if (res.success) {
            toastr.success(
              `BM25 库构建完毕！提取并写入了 ${res.count} 条记录。`,
            );
            if (toggleCheckbox) toggleCheckbox.prop("checked", true);
            loadAndRenderKbList(); // 刷新 UI，消除黄三角
          }
        } catch (err) {
          toastr.error(
            "构建失败：" + (err.responseJSON?.message || err.message),
          );
          if (toggleCheckbox) toggleCheckbox.prop("checked", false);
        }
      });
  };

  // === 绑定 1：滑块拦截 ===
  $container.on("click", ".kb-toggle-bm25", function (e) {
    const isExists = $(this).data("exists") === true;
    const isTurningOn = $(this).prop("checked");
    if (!isTurningOn || isExists) return; // 正常开关，放行

    e.preventDefault(); // 拦截强制开启
    triggerBm25Rebuild($(this).data("name"), $(this)); // 弹窗诱导重建
  });

  $container.on("click", ".kb-toggle-vector", function (e) {
    const isExists = $(this).data("exists") === true;
    const isTurningOn = $(this).prop("checked");
    if (!isTurningOn || isExists) return; // 正常开关，放行

    e.preventDefault(); // 拦截强制开启

    // 🌟 核心修复：滑块开启也支持从 BM25 构建向量库
    // 直接触发同一行里“重建向量库”按钮的逻辑
    const $btnRebuild = $(this)
      .closest(".kb-action-group")
      .find(".btn-rebuild-vector");
    $btnRebuild.click();
  });

  // === 绑定 2：专门的重建按钮 ===
  $container.on("click", ".btn-rebuild-bm25", function () {
    triggerBm25Rebuild($(this).data("name"));
  });

  $container.on("click", ".btn-rebuild-vector", async function () {
    const kbName = $(this).data("name");
    const $checkbox = $(this)
      .siblings(".anima-switch")
      .find(".kb-toggle-vector");
    const hasVector = $checkbox.data("exists") === true;

    // 🟢 究极修复：读取 api.rag 对象的配置！
    const fullConfig =
      typeof getAnimaConfig === "function" ? getAnimaConfig() : {};
    const apiConfig = fullConfig.api?.rag || {}; // 👈 这里必须加上 .rag

    if (!apiConfig || !apiConfig.key) {
      return toastr.warning(
        "缺失向量模型 API Key！请先在 API 设置页面配置好 RAG 模型连接。",
      );
    }

    if (!hasVector) {
      // 🛑 场景 A：从 BM25 逆向抽文本重建
      if (
        !confirm(
          `⚠️ 向量库 [${kbName}] 物理文件已丢失！\n\n是否尝试从现存的 BM25 库中提取原文，重新请求大模型生成向量？\n（提示：这将消耗相应的 Token 额度和等待时间）`,
        )
      )
        return;

      toastr.info(`🚀 正在从 BM25 逆向提取原文并重构向量库，请耐心等待...`);
      try {
        const res = await $.ajax({
          url: "/api/plugins/anima-rag/rebuild_vector_from_bm25",
          type: "POST",
          contentType: "application/json",
          data: JSON.stringify({ collectionId: kbName, apiConfig: apiConfig }),
        });
        if (res.success) {
          toastr.success(`向量库逆向重构成功！共还原了 ${res.count} 条向量。`);
          // 🌟 重构成功后，手动把滑块拨过去，消除警告图标
          $checkbox.prop("checked", true).data("exists", true);
          $(this).siblings(".fa-triangle-exclamation").remove();
        }
      } catch (e) {
        toastr.error("重构失败: " + (e.responseJSON?.message || e.message));
      }
    } else {
      // 🟢 场景 B：向量库洗盘
      if (
        !confirm(
          `确定要使用现有的文本重新生成向量吗？\n（这通常用于您更换了向量模型后，需要重新刷新所有数据）`,
        )
      )
        return;

      toastr.info(`🚀 正在使用原有文本重新请求向量化...`);
      try {
        const res = await $.ajax({
          url: "/api/plugins/anima-rag/rebuild_collection",
          type: "POST",
          contentType: "application/json",
          data: JSON.stringify({ collectionId: kbName, apiConfig: apiConfig }),
        });
        if (res.success) {
          toastr.success(
            `✅ 向量库洗盘成功！共更新 ${res.stats.success} 条向量。`,
          );
        }
      } catch (e) {
        toastr.error("洗盘失败: " + (e.responseJSON?.message || e.message));
      }
    }
  });

  // === 绑定 3：各自的物理删除 ===
  $container.on("click", ".btn-del-bm25", async function () {
    const kbName = $(this).data("name");
    if (
      !confirm(
        `确定要彻底删除 [${kbName}] 的 BM25 检索数据吗？\n(向量库将保留)`,
      )
    )
      return;
    try {
      await $.ajax({
        url: "/api/plugins/anima-rag/bm25/delete_single",
        type: "POST",
        contentType: "application/json",
        data: JSON.stringify({ libName: kbName }),
      });
      toastr.success("BM25库已物理删除");
      loadAndRenderKbList();
    } catch (e) {
      toastr.error("删除失败");
    }
  });

  $container.on("click", ".btn-del-vector", async function () {
    const kbName = $(this).data("name");
    // 🌟 修改了提示语，明确告知只删向量库
    if (
      !confirm(
        `确定要彻底删除 [${kbName}] 的向量库数据吗？\n(此操作不会影响已存在的 BM25 库，但失去原文对照后将无法再重建 BM25)`,
      )
    )
      return;
    try {
      await $.ajax({
        url: "/api/plugins/anima-rag/delete_collection",
        type: "POST",
        contentType: "application/json",
        data: JSON.stringify({ collectionId: kbName }),
      });

      // 顺手从全局映射里清理垃圾
      const kbSettings = getGlobalKbSettings();
      delete kbSettings.dict_mapping[kbName];
      saveGlobalSettings();

      toastr.success("向量库已彻底销毁");
      loadAndRenderKbList();
    } catch (e) {
      toastr.error("删除失败");
    }
  });

  // === 知识库切片管理弹窗 ===
  // === 知识库切片管理弹窗 (带分页) ===
  $container
    .find("#btn_kb_manage_modal")
    .off("click")
    .on("click", async () => {
      // 1. 获取所有知识库列表
      let vectorLibs = [];
      let bm25Libs = [];
      try {
        const [vectorRes, bm25Res] = await Promise.all([
          $.ajax({
            url: "/api/plugins/anima-rag/list",
            type: "GET",
            dataType: "json",
          }).catch(() => []),
          $.ajax({
            url: "/api/plugins/anima-rag/bm25/list",
            type: "GET",
            dataType: "json",
          }).catch(() => []),
        ]);
        vectorLibs = (vectorRes || []).filter((name) => name.startsWith("kb_"));
        bm25Libs = (bm25Res || []).filter((name) => name.startsWith("kb_"));
      } catch (e) {
        return toastr.error("获取知识库列表失败");
      }

      const allUniqueNames = Array.from(new Set([...vectorLibs, ...bm25Libs]));
      if (allUniqueNames.length === 0) {
        return toastr.warning("暂无任何知识库数据");
      }

      // 2. 构造下拉框
      const optionsHtml = allUniqueNames
        .map(
          (kb) =>
            `<option value="${escapeHtml(kb)}">${escapeHtml(kb.replace(/^kb_/, ""))}</option>`,
        )
        .join("");

      // 3. 构建弹窗骨架
      const modalHtml = `
        <style>
            /* 隐藏指定容器的滚动条但保留滚动功能 */
            .kb-hide-scrollbar::-webkit-scrollbar { display: none; }
            .kb-hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        </style>
        
        <div style="display: flex; gap: 15px; margin-bottom: 15px; align-items: center; background: rgba(0,0,0,0.2); padding: 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.05);">
            <div style="flex: 1;">
                <div class="anima-label-small" style="margin-bottom: 5px;">选择知识库</div>
                <select id="modal_kb_select" class="anima-select" style="width: 100%; height: 32px; box-sizing: border-box; padding: 0 10px; line-height: 30px; margin: 0;">
                    ${optionsHtml}
                </select>
            </div>
            <div style="flex: 1;">
                <div class="anima-label-small" style="margin-bottom: 5px;">绑定词典</div>
                <div id="modal_kb_dict_display" style="color:#ddd; font-weight:bold; height: 32px; line-height: 32px;">
                    <i class="fa-solid fa-spell-check" style="margin-right: 5px;"></i> <span>加载中...</span>
                </div>
            </div>
            <div style="display:flex; align-items:flex-end; padding-bottom: 0px;">
                <button id="btn_modal_kb_refresh" class="anima-btn secondary small" style="height: 32px; margin: 0;"><i class="fa-solid fa-rotate"></i></button>
            </div>
        </div>
        
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; font-size: 12px; color: #aaa;">
            <div>
                <i class="fa-solid fa-chart-pie" style="margin-right: 5px;"></i> 共 <span id="modal_kb_total" style="color:#ddd; font-weight:bold; margin: 0 4px;">0</span> 个片段
            </div>
            <div id="modal_kb_status_badges" style="display: flex; gap: 12px; font-weight: bold;">
            </div>
        </div>
        
        <div id="kb_slice_list_container" class="anima-scroll kb-hide-scrollbar" style="max-height: 450px; overflow-y: auto; padding-right: 5px;">
            <div style="padding:20px; text-align:center; color:#aaa;">请选择知识库...</div>
        </div>
      `;

      showKbModal("知识库内容管理", modalHtml);

      const $modalBody = $("#anima-kb-modal-body");

      // ================= 新增：分页状态变量 =================
      let currentKbPage = 1;
      const KB_SLICES_PER_PAGE = 20;
      let allKbSlices = [];
      let currentDictData = { words: [] };

      // ================= 新增：单页渲染逻辑 =================
      const renderKbSlicePage = () => {
        const totalItems = allKbSlices.length;
        const totalPages = Math.max(
          1,
          Math.ceil(totalItems / KB_SLICES_PER_PAGE),
        );

        // 越界保护
        if (currentKbPage > totalPages) currentKbPage = totalPages;
        if (currentKbPage < 1) currentKbPage = 1;

        if (totalItems === 0) {
          $modalBody
            .find("#kb_slice_list_container")
            .html(
              `<div style="padding:20px; text-align:center; color:#aaa;">该知识库暂无切片数据或已损坏</div>`,
            );
          return;
        }

        const startIndex = (currentKbPage - 1) * KB_SLICES_PER_PAGE;
        const endIndex = startIndex + KB_SLICES_PER_PAGE;
        const pageItems = allKbSlices.slice(startIndex, endIndex);

        const rowsHtml = pageItems
          .map((item, idx) => {
            // 注意：因为分页了，所以需要计算在全局中的绝对索引，如果 item 没带的话
            const absoluteIdx = startIndex + idx;
            const text = item.text || "";
            const chunkIndex = item.metadata?.chunk_index ?? absoluteIdx;
            const docName = item.metadata?.doc_name || "未知来源";

            // 计算命中的索引词
            let finalIndexWords = [];
            (currentDictData.words || []).forEach((rule) => {
              const triggers = (rule.trigger || "")
                .split(/[,，]/)
                .map((t) => t.trim())
                .filter(Boolean);
              const actualTriggers =
                triggers.length > 0 ? triggers : [(rule.index || "").trim()];

              const hasTrigger = actualTriggers.some((trig) =>
                text.includes(trig),
              );
              if (hasTrigger && rule.index) {
                finalIndexWords.push(rule.index.trim());
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

            // 简略内容处理 (剔除换行，截断长度)
            const cleanText = text.replace(/[\r\n]+/g, " ").trim();
            const shortText =
              cleanText.length > 35
                ? cleanText.substring(0, 35) + "..."
                : cleanText;

            return `
                <div class="anima-history-entry slice-sync-row" style="margin-bottom: 8px; border-radius: 6px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); overflow: hidden;">
                    <div class="anima-history-header toggle-content-area" style="cursor:pointer; display:flex; justify-content:space-between; align-items:center; padding: 10px; background: rgba(0,0,0,0.2);">
                        <div class="anima-history-meta" style="flex:1; display:flex; align-items:center; flex-wrap:nowrap; gap:8px; overflow:hidden;">
                            <span style="color:#fbbf24; font-weight:bold; white-space:nowrap; font-family: monospace;">#${chunkIndex}</span>
                            <span style="color:#888; font-size:12px; white-space:nowrap; text-overflow:ellipsis; overflow:hidden; max-width: 100px;" title="${escapeHtml(docName)}"><i class="fa-solid fa-file-lines"></i> ${escapeHtml(docName)}</span>
                            <span style="color:#ccc; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1;">${escapeHtml(shortText)}</span>
                        </div>
                        
                        <div class="anima-history-actions" style="display:flex; align-items:center; gap:8px; margin-left:10px;">
                            <i class="fa-solid fa-chevron-right toggle-icon" style="font-size: 12px; color: #aaa; width:15px; text-align:center; transition: transform 0.2s;"></i>
                        </div>
                    </div>
                    
                    <div class="anima-history-content" style="display:none; padding: 10px; font-size:12px; color:#ddd; line-height: 1.6; border-top: 1px solid rgba(255,255,255,0.05); background: rgba(0,0,0,0.4); white-space:pre-wrap;">${escapeHtml(text)}</div>
                    
                    <div class="anima-tags-wrapper" style="padding: 6px 10px; border-top: 1px dashed rgba(255,255,255,0.05); background: rgba(0,0,0,0.2);">
                        <div class="tags-view-mode" style="color:#aaa; font-size:12px; display:flex; align-items:center; gap:5px; flex-wrap:wrap;">
                            <i class="fa-solid fa-book-bookmark" style="font-size:10px; color:#3b82f6;"></i> ${tagsHtml}
                        </div>
                    </div>
                </div>`;
          })
          .join("");

        const paginationHtml = `
          <div class="kb-pagination" style="padding-top: 10px; border-top: 1px dashed rgba(255,255,255,0.1); margin-bottom: 10px; display: flex; justify-content: center; align-items: center;">
              <button id="btn_kb_modal_prev_page" class="anima-btn secondary small" ${currentKbPage === 1 ? "disabled" : ""}><i class="fa-solid fa-chevron-left"></i></button>
              <span style="margin: 0 10px; font-size: 12px; color: #888;">第 ${currentKbPage} / ${totalPages} 页</span>
              <button id="btn_kb_modal_next_page" class="anima-btn secondary small" ${currentKbPage === totalPages ? "disabled" : ""}><i class="fa-solid fa-chevron-right"></i></button>
          </div>`;

        $modalBody
          .find("#kb_slice_list_container")
          .html(rowsHtml + paginationHtml);
      };

      // 4. 数据拉取逻辑
      const loadAndRenderSlices = async () => {
        const selectedKb = $modalBody.find("#modal_kb_select").val();
        if (!selectedKb) return;

        // ✨ 动态更新双擎存在状态
        const hasVector = vectorLibs.includes(selectedKb);
        const hasBm25 = bm25Libs.includes(selectedKb);

        const bm25Badge = hasBm25
          ? `<span style="color:#4ade80;"><i class="fa-solid fa-check" style="margin-right:3px;"></i>BM25库</span>`
          : `<span style="color:#f87171;"><i class="fa-solid fa-xmark" style="margin-right:3px;"></i>BM25库</span>`;

        const vectorBadge = hasVector
          ? `<span style="color:#4ade80;"><i class="fa-solid fa-check" style="margin-right:3px;"></i>向量库</span>`
          : `<span style="color:#f87171;"><i class="fa-solid fa-xmark" style="margin-right:3px;"></i>向量库</span>`;

        $modalBody
          .find("#modal_kb_status_badges")
          .html(`${bm25Badge} ${vectorBadge}`);

        $modalBody
          .find("#kb_slice_list_container")
          .html(
            '<div style="padding:20px; text-align:center; color:#aaa;"><i class="fa-solid fa-spinner fa-spin"></i> 正在读取数据...</div>',
          );

        // 获取当前绑定的词典
        const kbSettings = getGlobalKbSettings();
        const mappingData = kbSettings.dict_mapping[selectedKb];
        const dictName =
          typeof mappingData === "object" && mappingData !== null
            ? mappingData.dict
            : mappingData || "未绑定词典";
        $modalBody.find("#modal_kb_dict_display span").text(dictName);

        // 提取词典规则缓存起来，供翻页时使用
        const globalBm25 = getGlobalBm25Settings();
        currentDictData = globalBm25.custom_dicts[dictName] || { words: [] };

        try {
          // 请求后端获取切片数据
          const res = await $.ajax({
            url: "/api/plugins/anima-rag/view_collection",
            type: "POST",
            contentType: "application/json",
            data: JSON.stringify({ collectionId: selectedKb }),
          });

          allKbSlices = res.items || [];
          $modalBody.find("#modal_kb_total").text(allKbSlices.length);
          currentKbPage = 1; // 切换下拉框时重置页码

          renderKbSlicePage();
        } catch (err) {
          $modalBody
            .find("#kb_slice_list_container")
            .html(
              `<div style="padding:20px; text-align:center; color:#ef4444;">获取切片失败: ${err.responseJSON?.error || err.message}</div>`,
            );
        }
      };

      // 5. 绑定弹窗内的下拉框和折叠事件
      $modalBody.find("#modal_kb_select").on("change", loadAndRenderSlices);
      $modalBody.find("#btn_modal_kb_refresh").on("click", loadAndRenderSlices);

      // 新增：翻页事件
      $modalBody
        .off("click", "#btn_kb_modal_prev_page")
        .on("click", "#btn_kb_modal_prev_page", function () {
          currentKbPage--;
          renderKbSlicePage();
        });

      $modalBody
        .off("click", "#btn_kb_modal_next_page")
        .on("click", "#btn_kb_modal_next_page", function () {
          currentKbPage++;
          renderKbSlicePage();
        });

      $modalBody
        .off("click", ".toggle-content-area")
        .on("click", ".toggle-content-area", function (e) {
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

      // 初始化第一次渲染
      await loadAndRenderSlices();
    });
  // === 监听 SillyTavern 的聊天/角色切换事件，自动刷新知识库列表状态 ===
  const STContext =
    typeof SillyTavern !== "undefined" ? SillyTavern.getContext() : null;
  if (STContext && STContext.eventSource && STContext.event_types) {
    STContext.eventSource.on(STContext.event_types.CHAT_CHANGED, () => {
      // 当页面加载完成选中了角色，或者用户手动切换角色时，自动重新渲染列表
      // loadAndRenderKbList 内部会调用 getCharKbSettings() 获取最新状态并勾选开关
      if ($("#kb_management_list").length > 0) {
        loadAndRenderKbList();
      }
    });
  }
}

// === 编辑弹窗 UI (包含手风琴和重建功能) ===
function showKbEditModal(kbName, dictionaries) {
  // 模拟的该数据库包含的切片数据
  const mockChunks = [
    { id: 0, text: "这是第一个切片的预览内容，包含了主角设定的基础信息..." },
    { id: 1, text: "第二个切片，详细描述了世界观中的魔法机制和限制..." },
  ];

  const dictOptions = dictionaries
    .map((d) => `<option value="${d}">${d}</option>`)
    .join("");

  const chunksHtml = mockChunks
    .map(
      (chunk) => `
        <div class="kb-edit-slice" data-chunk-id="${chunk.id}">
            <div class="kb-edit-slice-header">
                <div style="font-weight: bold; color: #bbb; display: flex; align-items: center; gap: 10px;">
                    <span style="color: #facc15;">[切片 #${chunk.id}]</span>
                    <span style="font-size: 12px; font-weight: normal; max-width: 250px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(chunk.text)}</span>
                </div>
                <div style="display: flex; gap: 10px; align-items: center;">
                    <button class="anima-btn danger small btn-del-chunk" title="删除此切片" style="height: 24px; padding: 0 8px;"><i class="fa-solid fa-trash"></i></button>
                    <i class="fa-solid fa-chevron-down fold-icon" style="color: #888; transition: transform 0.2s;"></i>
                </div>
            </div>
            <div class="kb-edit-slice-body">
                <textarea class="anima-textarea chunk-text-input" style="width: 100%; height: 100px;">${escapeHtml(chunk.text)}</textarea>
                <div style="text-align: right; margin-top: 5px;">
                    <button class="anima-btn primary small btn-save-chunk">保存修改</button>
                </div>
            </div>
        </div>
    `,
    )
    .join("");

  const modalHtml = `
        <div style="display: flex; gap: 10px; align-items: center; margin-bottom: 20px; background: rgba(0,0,0,0.2); padding: 10px; border-radius: 6px; height: 52px; box-sizing: border-box;">
            <div style="color: #ddd; font-weight: bold; line-height: 32px;">当前词典:</div>
            <select class="anima-select" id="kb_modal_dict_select" style="width: 150px; height: 32px; box-sizing: border-box; padding: 0 10px; line-height: 30px; vertical-align: middle; margin: 0;">
                ${dictOptions}
            </select>
            <div style="margin-left: auto; display: flex; gap: 10px; align-items: center;">
                <button id="btn_modal_rebuild_vector" class="anima-btn primary small" style="height: 32px; margin: 0; display: flex; align-items: center;"><i class="fa-solid fa-cube" style="margin-right: 5px;"></i> 向量重建</button>
                <button id="btn_modal_rebuild_bm25" class="anima-btn primary small" style="background: #eab308; color: #000; font-weight: bold; height: 32px; margin: 0; display: flex; align-items: center;"><i class="fa-solid fa-layer-group" style="margin-right: 5px;"></i> BM25 重建</button>
            </div>
        </div>

        <div style="margin-bottom: 10px; font-size: 12px; color: #aaa;">
            <i class="fa-solid fa-scissors"></i> 该知识库包含 ${mockChunks.length} 个切片。展开条目以手动修改文本。
        </div>

        <div id="kb_modal_chunk_list" class="anima-scroll" style="max-height: 400px; padding-right: 5px;">
            ${chunksHtml}
        </div>
    `;

  // 使用复用的 showRagModal 渲染弹窗
  showKbModal(`编辑知识库: ${escapeHtml(kbName)}`, modalHtml);

  // 绑定弹窗内的事件
  const $body = $("#anima-rag-modal-body");

  // 重建按钮
  $body
    .find("#btn_modal_rebuild_vector")
    .on("click", () => toastr.info("请求后端：向量重建中..."));
  $body
    .find("#btn_modal_rebuild_bm25")
    .on("click", () =>
      toastr.info("请求后端：BM25重建中... (应用当前选择的词典)"),
    );

  // 手风琴折叠展开
  $body.find(".kb-edit-slice-header").on("click", function (e) {
    // 如果点的是删除按钮，不触发折叠
    if ($(e.target).closest(".btn-del-chunk").length > 0) return;

    const $bodyDiv = $(this).next(".kb-edit-slice-body");
    const $icon = $(this).find(".fold-icon");
    if ($bodyDiv.is(":visible")) {
      $bodyDiv.slideUp(150);
      $icon.css("transform", "rotate(0deg)");
    } else {
      $bodyDiv.slideDown(150);
      $icon.css("transform", "rotate(180deg)");
    }
  });

  // 切片内按钮
  $body.find(".btn-save-chunk").on("click", function () {
    const newText = $(this)
      .closest(".kb-edit-slice-body")
      .find(".chunk-text-input")
      .val();
    toastr.success("切片保存成功");
    // TODO: 触发后端更新切片内容，如果是 BM25 需要重新分词
  });

  $body.find(".btn-del-chunk").on("click", function () {
    if (
      confirm("确定要删除这个文本切片吗？这会立刻从向量库和BM25中移除该条目。")
    ) {
      $(this)
        .closest(".kb-edit-slice")
        .fadeOut(200, function () {
          $(this).remove();
        });
      toastr.success("切片已删除");
    }
  });
}

// ==========================================
// 🛡️ 供外部 (如 rag_logic.js) 调用的载荷生成器
// ==========================================
export function getKbSearchPayload() {
  const globalSettings = getGlobalKbSettingsFull();

  // 1. 如果知识库总开关被关闭，直接拦截，返回空数组
  if (!globalSettings.kb_enabled) {
    return {
      kbContext: { ids: [], strategy: globalSettings.knowledge_base },
      bm25ConfigsKb: [],
    };
  }

  // 2. 提取当前角色卡专属的库开关状态
  const charSettings = getCharKbSettings();
  const activeLibs = charSettings.libs || [];
  const globalBm25 = getGlobalBm25Settings();
  const globalKb = getGlobalKbSettings();

  const vectorIds = [];
  const bm25ConfigsKb = [];

  // 3. 严格按开关组装允许检索的库
  activeLibs.forEach((lib) => {
    if (lib.vector_enabled) {
      vectorIds.push(lib.name);
    }
    if (lib.bm25_enabled) {
      const mappingData = globalKb.dict_mapping[lib.name];
      const dictName =
        typeof mappingData === "object" && mappingData !== null
          ? mappingData.dict
          : mappingData || "";
      const dictContent = globalBm25.custom_dicts?.[dictName]?.words || [];

      bm25ConfigsKb.push({
        dbId: lib.name,
        dictionary: dictContent,
      });
    }
  });
  console.log("[Anima KB Payload] 前端准备发送的知识库载荷:", {
    vectorIds,
    bm25ConfigsKb,
  });
  return {
    kbContext: {
      ids: vectorIds,
      strategy: globalSettings.knowledge_base,
    },
    bm25ConfigsKb: bm25ConfigsKb,
  };
}
