import {
  getChatRagFiles,
  showRagModal,
  saveRagSettings,
  DEFAULT_RAG_SETTINGS,
} from "./rag.js";
import { getAvailableCollections } from "./db_api.js";
import {
  applyRegexRules,
  processMacros,
  escapeHtml,
  getSmartCollectionId,
} from "./utils.js";
// ==========================================
// 4. 子组件渲染逻辑
// ==========================================

export function renderStrategyTable(settings) {
  const container = $("#rag_strategy_table_container");

  // 安全获取配置 (兼容旧数据)
  const strat =
    settings.strategy_settings || DEFAULT_RAG_SETTINGS.strategy_settings;

  // 🔥 [修复开始] 健壮性补全：确保所有策略子对象都存在
  // 防止因对象缺失导致渲染崩溃，或 value="undefined" 导致保存为 0
  if (!strat.important) strat.important = { labels: ["Important"], count: 1 };
  if (!strat.special) strat.special = { count: 1 }; // 节日/Special
  if (!strat.period) strat.period = { labels: ["Period"], count: 1 };
  if (!strat.status) strat.status = { labels: ["Sick", "Injury"], count: 1 };
  if (!strat.diversity) strat.diversity = { count: 2 }; // 丰富度

  // 辅助函数：确保是数组
  const ensureLabels = (obj) => {
    if (!obj) return [];
    if (Array.isArray(obj.labels)) return obj.labels;
    return obj.tag ? [obj.tag] : [];
  };

  const impLabels = ensureLabels(strat.important);

  let periodLabels = [];
  if (settings.period_config && Array.isArray(settings.period_config.events)) {
    // 提取所有已配置事件的 Label
    periodLabels = settings.period_config.events
      .map((e) => e.label)
      .filter((l) => l);
  }

  const statusLabels = ensureLabels(strat.status);

  // 🔥 新增：提取所有节日名称
  const holidayLabels = settings.holidays
    ? settings.holidays.map((h) => h.name)
    : [];

  // Badge 渲染器
  const renderBadges = (arr) => {
    if (!arr || arr.length === 0)
      return '<span style="color:#666; font-size:12px;">(无)</span>';
    return arr
      .map(
        (t) =>
          `<span class="anima-tag-badge" style="display:inline-block; margin:1px; padding:2px 6px; font-size:12px; border:1px solid rgba(255,255,255,0.2); background:rgba(255,255,255,0.05); border-radius:4px;">${escapeHtml(t)}</span>`,
      )
      .join("");
  };

  const html = `
    <style>
        .rag-strat-table th { color:#aaa; font-weight:normal; padding:8px 5px; font-size:12px; text-align:left; }
        .rag-strat-table td { height: 32px; padding: 0 5px; border-bottom: 1px solid rgba(255,255,255,0.05); vertical-align: middle; }
        .rag-tag-cell { max-width: 180px; white-space: normal; word-wrap: break-word; line-height: 1.4; }
        
        /* Flex 容器用于对齐输入框和按钮 */
        .rag-edit-container { display: flex; align-items: center; width: 100%; height: 100%; gap: 5px; }
        
        .rag-compact-input { 
            height: 24px !important; min-height: 24px !important; line-height: 22px !important; 
            padding: 0 6px !important; font-size: 13px !important; margin: 0 !important; 
            border: 1px solid rgba(255,255,255,0.2) !important; background: rgba(0,0,0,0.2) !important;
            color: #fff !important; box-sizing: border-box !important; border-radius: 4px !important;
        }
        .rag-tiny-btn { 
            padding: 0 8px !important; height: 24px !important; min-height: 24px !important;
            font-size: 12px !important; line-height: 22px !important; vertical-align: middle !important;
            box-sizing: border-box !important;
        }
        .rag-table-wrapper {
            overflow-x: auto;
            -ms-overflow-style: none;  /* IE and Edge */
            scrollbar-width: none;     /* Firefox */
        }
        .rag-table-wrapper::-webkit-scrollbar {
            display: none;             /* Chrome, Safari and Opera */
        }
    </style>

    <table class="anima-rag-tag-table rag-strat-table" style="table-layout: fixed;">
        <thead>
            <tr>
                <th width="70">步骤类型</th>
                <th class="rag-tag-cell">标签 / 触发源</th>
                <th width="90" style="text-align:center;">配置 / 编辑</th>
                <th width="50" style="text-align:center;">数量</th>
            </tr>
        </thead>
        <tbody>
            
            <tr id="rag_row_important">
                <td><span style="color:#facc15; font-weight:bold;">重要</span></td>
                <td class="rag-tag-cell">
                    <div class="view-mode">${renderBadges(impLabels)}</div>
                    <div class="edit-mode hidden">
                        <input type="text" class="anima-input rag-compact-input tag-input" 
                               value="${escapeHtml(impLabels.join(", "))}" style="width:100%;">
                    </div>
                </td>
                <td style="text-align:center;">
                    <button class="anima-btn secondary small rag-tiny-btn btn-toggle-edit" title="编辑标签">
                        <i class="fa-solid fa-pen"></i> 编辑
                    </button>
                </td>
                <td style="text-align:center;">
                    <input type="number" id="rag_strat_imp_count" class="anima-input rag-compact-input" 
                           value="${strat.important.count ?? 1}" min="0" style="text-align:center;">
                </td>
            </tr>

            <tr id="rag_row_status">
                <td><span style="color: #ef4444; font-weight:bold;">状态</span></td>
                <td class="rag-tag-cell">
                    <div class="view-mode">${renderBadges(statusLabels)}</div>
                </td>
                <td style="text-align:center;">
                    <button id="rag_btn_cfg_status_rules" class="anima-btn secondary small rag-tiny-btn" title="配置状态映射规则">
                        <i class="fa-solid fa-code-branch"></i> 规则
                    </button>
                </td>
                <td style="text-align:center;">
                    <input type="number" id="rag_strat_status_count" class="anima-input rag-compact-input" 
                           value="${strat.status.count ?? 1}" min="0" style="text-align:center;">
                </td>
            </tr>

            <tr id="rag_row_period">
                <td><span style="color: #48ecd1; font-weight:bold;">生理</span></td>
                <td class="rag-tag-cell">
                    <div class="view-mode">
                        ${renderBadges(periodLabels)}
                    </div>
                </td>
                <td style="text-align:center;">
                    <button id="rag_btn_cfg_period" class="anima-btn secondary small rag-tiny-btn" title="生理周期高级配置">
                        <i class="fa-solid fa-heart-pulse"></i> 配置
                    </button>
                </td>
                <td style="text-align:center;">
                    <input type="number" id="rag_strat_period_count" class="anima-input rag-compact-input" 
                           value="${strat.period.count ?? 1}" min="0" style="text-align:center;">
                </td>
            </tr>

            <tr>
                <td><span style="color: #e73cbc; font-weight:bold;">节日</span></td>
                <td class="rag-tag-cell">
                    <div class="view-mode">
                        ${renderBadges(holidayLabels)}
                    </div>
                </td>
                <td style="text-align:center;">
                    <button id="rag_btn_cfg_holidays" class="anima-btn secondary small rag-tiny-btn">
                        <i class="fa-solid fa-calendar-days"></i> 配置
                    </button>
                </td>
                <td style="text-align:center;">
                    <input type="number" id="rag_strat_holiday_count" class="anima-input rag-compact-input" 
                           value="${strat.special.count ?? 1}" min="0" style="text-align:center;">
                </td>
            </tr>

            <tr>
                <td><span style="color: #59e451; font-weight:bold;">丰富度</span></td>
                <td class="rag-tag-cell">
                    <span style="color:#666; font-size:12px; font-style:italic;">(排除以上所有标签)</span>
                </td>
                <td style="text-align:center;"> - </td>
                <td style="text-align:center;">
                    <input type="number" id="rag_strat_div_count" class="anima-input rag-compact-input" 
                           value="${strat.diversity.count ?? 2}" min="0" style="text-align:center;">
                </td>
            </tr>

        </tbody>
    </table>
    `;

  container.html(html);

  // === 事件绑定 ===

  // 通用编辑切换逻辑 (复用于 Important, Period, Status 行)
  const bindEditToggle = ($row) => {
    $row.find(".btn-toggle-edit").on("click", function () {
      const $view = $row.find(".view-mode");
      const $edit = $row.find(".edit-mode");
      const $icon = $(this).find("i");

      if ($edit.hasClass("hidden")) {
        $view.addClass("hidden");
        $edit.removeClass("hidden");
        $icon.removeClass("fa-pen").addClass("fa-check");
        $(this).removeClass("secondary").addClass("primary");
      } else {
        // 临时渲染 Badge
        const rawVal = $edit.find(".tag-input").val();
        const newArr = rawVal
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter((s) => s);
        $view.html(renderBadges(newArr));

        $edit.addClass("hidden");
        $view.removeClass("hidden");
        $icon.removeClass("fa-check").addClass("fa-pen");
        $(this).removeClass("primary").addClass("secondary");
      }
    });
  };

  bindEditToggle(container.find("#rag_row_important"));
  container.find("#rag_btn_cfg_status_rules").on("click", () => {
    renderStatusRulesModal(settings);
  });

  // 按钮弹窗绑定
  container
    .find("#rag_btn_cfg_holidays")
    .on("click", () => renderHolidayModal(settings));
  container
    .find("#rag_btn_cfg_period")
    .on("click", () => renderPeriodModal(settings));
}

// --- 提示词列表渲染 ---
export function renderPromptList(promptList) {
  const listEl = $("#rag_prompt_list");
  listEl.empty();

  promptList.forEach((item, index) => {
    let $item;

    if (item.type === "context") {
      // 🟢 修复：CSS 强制高度和对齐
      $item = $(`
                <div class="anima-prompt-item context" data-idx="${index}" data-type="context">
                    <div style="display:flex; justify-content:space-between; align-items:center; height: 30px;">
                        <div style="display:flex; align-items:center;">
                            <i class="fa-solid fa-bars anima-drag-handle"></i>
                            <span style="font-weight:bold; color:#60a5fa;">📚 最新楼层内容</span>
                        </div>
                        <div style="display:flex; align-items:center; gap:5px;">
                            <span style="font-size:12px; color:#aaa; line-height:24px;">插入数量:</span>
                            <input type="number" class="floor-count-input anima-input" 
                                   style="width: 60px; height: 24px; line-height: 24px; padding: 0; text-align: center; font-size: 13px; margin: 0;" 
                                   min="1" value="${item.count || 2}">
                        </div>
                    </div>
                </div>
            `);
      $item.find(".floor-count-input").on("change", function () {
        item.count = parseInt($(this).val()) || 2;
      });
    } else {
      // === RAG 提示词条目 (CSS优化 & 标题修复版) ===
      const role = item.role || "system";
      const currentTitle = item.title || "";
      const displayTitleHtml = currentTitle
        ? escapeHtml(currentTitle)
        : '<span style="color:#666; font-weight:normal; font-style:normal; font-size:12px;">(未命名条目)</span>';
      const displayRole = role.toUpperCase();

      $item = $(`
                <div class="anima-prompt-item" data-idx="${index}" data-type="text">
                    
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; height:32px;">
                        
                        <div class="view-mode" style="display:flex; align-items:center; gap:8px; width:100%; height:100%;">
                            <i class="fa-solid fa-bars anima-drag-handle" style="cursor:grab; color:#888;"></i>
                            
                            <span class="anima-tag secondary" style="font-family:monospace; min-width:70px; text-align:center; height:24px; line-height:24px; font-size:12px; padding:0; display:inline-block;">${displayRole}</span>

                            <span class="view-title-text" style="font-weight:bold; color:#ddd; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; cursor:text; line-height:32px;">
                                ${displayTitleHtml}
                            </span>
                            
                            <div style="display:flex; gap:5px; align-items:center;">
                                <button class="anima-btn secondary small btn-edit-prompt" style="height:28px; width:28px; padding:0; display:flex; align-items:center; justify-content:center;"><i class="fa-solid fa-pen" style="font-size:12px;"></i></button>
                                <button class="anima-btn danger small btn-del-prompt" style="height:28px; width:28px; padding:0; display:flex; align-items:center; justify-content:center;"><i class="fa-solid fa-trash" style="font-size:12px;"></i></button>
                            </div>
                        </div>

                        <div class="edit-mode" style="display:none; align-items:center; gap:8px; width:100%; height:100%;">
                            <i class="fa-solid fa-bars" style="opacity:0.3;"></i>
                            
                            <select class="anima-select role-select" style="width:auto; padding:0 25px 0 10px; height:30px; line-height:30px; font-size:13px; margin:0; box-sizing:border-box;">
                                <option value="system" ${role === "system" ? "selected" : ""}>SYSTEM</option>
                                <option value="user" ${role === "user" ? "selected" : ""}>USER</option>
                                <option value="assistant" ${role === "assistant" ? "selected" : ""}>ASSISTANT</option>
                            </select>

                            <input type="text" class="anima-input title-input" 
                               value="${escapeHtml(currentTitle)}" 
                               placeholder="条目名称..." 
                               style="flex:1; height:30px; box-sizing:border-box; margin:0; vertical-align:middle;">

                            <div style="display:flex; gap:5px; margin-left: 2px; align-items:center;">
                                <button class="anima-btn primary small btn-confirm" style="height:30px; width:30px; padding:0; display:flex; align-items:center; justify-content:center; margin:0;"><i class="fa-solid fa-check"></i></button>
                                <button class="anima-btn danger small btn-cancel" style="height:30px; width:30px; padding:0; display:flex; align-items:center; justify-content:center; margin:0;"><i class="fa-solid fa-xmark"></i></button>
                            </div>
                        </div>

                    </div>
                    
                    <textarea class="anima-textarea content-input" rows="2" disabled
                              style="width:100%; font-size:13px; line-height:1.4; opacity: 1; color: #ffffff; cursor: default;">${escapeHtml(item.content)}</textarea>
                </div>
            `);

      const $viewMode = $item.find(".view-mode");
      const $editMode = $item.find(".edit-mode");
      const $textarea = $item.find(".content-input");

      // 删除
      $item.find(".btn-del-prompt").on("click", function () {
        promptList.splice(index, 1);
        renderPromptList(promptList);
      });

      // 进入编辑
      const enterEditMode = () => {
        $viewMode.hide();
        $editMode.css("display", "flex");
        $textarea.prop("disabled", false).css({
          opacity: "1",
          cursor: "text",
          "border-color": "#3b82f6",
        });
      };
      $item.find(".btn-edit-prompt").on("click", enterEditMode);
      $item.find(".view-title-text").on("click", enterEditMode);

      // 取消
      $item.find(".btn-cancel").on("click", function () {
        renderPromptList(promptList);
      });

      // 确认
      $item.find(".btn-confirm").on("click", function () {
        const newRole = $item.find(".role-select").val();
        const newTitle = $item.find(".title-input").val().trim();
        const newContent = $textarea.val();

        item.role = newRole;
        item.title = newTitle;
        item.content = newContent;

        renderPromptList(promptList);
      });
    }
    listEl.append($item);
  });

  listEl.sortable({
    handle: ".anima-drag-handle",
    stop: function () {
      const newPrompt = [];
      listEl.children().each(function () {
        const oldIdx = $(this).data("idx");
        // === 修复：直接复用原内存对象 ===
        // RAG 因为逻辑比较简单，直接拿原对象是最安全的
        // 只要 index 没错，原对象里已经包含了最新的 title (因为 confirm 时更新了)
        newPrompt.push(promptList[oldIdx]);
      });
      promptList.length = 0;
      promptList.push(...newPrompt);
      renderPromptList(promptList);
    },
  });
}

// --- 标签表格渲染 ---
export function renderTagTable(config, isEditing) {
  const container = $("#rag_tags_container");
  const typeMap = {
    basic: "基础 (Basic)",
    important: "重要 (Important)",
    specials: "节日/特殊 (Specials)",
  };
  let rowsHtml = "";
  for (const key of ["basic", "important", "specials"]) {
    const item = config[key];
    let tagsContent = "",
      countContent = "";

    if (isEditing) {
      tagsContent = `<input type="text" class="anima-input tag-labels-input" data-key="${key}" value="${escapeHtml(item.labels.join(", "))}" style="width:100%;">`;
      countContent = `<input type="number" class="anima-input tag-count-input" data-key="${key}" value="${item.count}" min="0" style="width:50px; text-align:center;">`;
    } else {
      tagsContent = item.labels
        .map(
          (t) =>
            `<span class="anima-tag-badge" style="background:rgba(255,255,255,0.1); border:1px solid #555; padding:2px 6px; border-radius:4px; font-size:12px; margin-right:4px;">${escapeHtml(t)}</span>`,
        )
        .join("");
      countContent = `<span style="font-weight:bold; color:var(--anima-primary);">${item.count}</span>`;
    }
    rowsHtml += `<tr><td style="color:#ddd; font-size:12px;">${typeMap[key]}</td><td>${tagsContent}</td><td style="text-align:center;">${countContent}</td></tr>`;
  }
  container.html(
    `<table class="anima-rag-tag-table"><thead><tr><th width="120">类型</th><th>标签定义</th><th width="60" style="text-align:center;">数量</th></tr></thead><tbody>${rowsHtml}</tbody></table>`,
  );
}

// 辅助函数：标准化ID (如果文件里没有这个函数请补上，如果有则忽略)
function normalizeId(id) {
  if (!id) return "";
  return id.toString().replace(/_/g, " ").trim();
}

export async function renderUnifiedFileList() {
  const container = $("#rag_file_list");
  container.empty();

  const activeChatFiles = getChatRagFiles() || [];

  // 🟢 修复：废弃旧的正则替换对比，直接调用最权威的智能 ID 函数
  const isSelf = (dbId) => {
    if (!dbId) return false;
    const expectedDbName = getSmartCollectionId();
    return dbId === expectedDbName;
  };

  if (activeChatFiles.length === 0) {
    container.html(
      `<div style="text-align:center; color:#666; padding:10px; font-size:12px; font-style:italic;">暂无关联数据库，请点击上方“管理”按钮添加</div>`,
    );
    return;
  }

  // 3. 渲染列表项 (剔除了原来的 Case 3 知识库逻辑)
  const html = activeChatFiles
    .map((dbId) => {
      let borderColor = "#3b82f6"; // 默认：其他聊天数据库 (蓝色)
      let iconColor = "#60a5fa";
      let badgeHtml = "";
      let tooltipType = "Linked Chat Log";

      if (isSelf(dbId)) {
        // 当前聊天 (绿色)
        borderColor = "#22c55e";
        iconColor = "#4ade80";
        badgeHtml = `<span style="font-size:10px; background:rgba(74, 222, 128, 0.2); color:#4ade80; padding:1px 4px; border-radius:3px; margin-left:5px; border:1px solid rgba(74,222,128,0.3);">Current</span>`;
        tooltipType = "Current Chat DB";
      }

      return `
        <div class="anima-rag-file-item" style="border-left: 3px solid ${borderColor}; display:flex; justify-content:space-between; align-items:center; padding:8px 10px; margin-bottom:6px; border-radius:4px; background:rgba(0,0,0,0.2);">
            <div style="display:flex; align-items:center; overflow:hidden; gap:8px;">
                <span style="font-size:13px; color:#eee; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(dbId)} (${tooltipType})">
                    <i class="fa-solid fa-database" style="color:${iconColor}; margin-right:6px;"></i>
                    ${escapeHtml(dbId)}
                    ${badgeHtml}
                </span>
            </div>
        </div>`;
    })
    .join("");

  container.html(html);
}

export function renderFileList(ignoredFiles, ignoredChatId) {
  renderUnifiedFileList();
}

// ==========================================
// 6. 节日配置逻辑 (修复版)
// ==========================================
export function renderHolidayModal(settings) {
  if (!settings.holidays || !Array.isArray(settings.holidays)) {
    settings.holidays = [];
  }
  let tempHolidays = JSON.parse(JSON.stringify(settings.holidays));
  const renderList = (optionalEditIdx = -1) => {
    const tbody = $("#anima_holiday_tbody");
    tbody.empty();

    tempHolidays.forEach((h, idx) => {
      const isEditing = idx === optionalEditIdx;

      // 构建行 HTML
      const $tr = $(`<tr data-idx="${idx}"></tr>`);

      // 1. 日期列
      const tdDate = isEditing
        ? `<td><div class="rag-edit-container"><input type="text" class="anima-input rag-compact-input h-date" value="${escapeHtml(h.date)}" style="width:100%; text-align:center;"></div></td>`
        : `<td><span style="font-family:monospace; color:#ddd;">${escapeHtml(h.date)}</span></td>`;

      // 2. 节日名列
      const tdName = isEditing
        ? `<td><div class="rag-edit-container"><input type="text" class="anima-input rag-compact-input h-name" value="${escapeHtml(h.name)}" style="width:100%;"></div></td>`
        : `<td><span style="font-weight:bold; color:#f472b6;">${escapeHtml(h.name)}</span></td>`;

      // 3. 节前触发
      const tdBefore = isEditing
        ? `<td><div class="rag-edit-container"><input type="number" class="anima-input rag-compact-input h-before" value="${h.range_before || 0}" min="0" style="width:100%; text-align:center;"></div></td>`
        : `<td style="text-align:center;"><span style="color:#aaa;">${h.range_before || 0}</span></td>`;

      // 4. 节后触发
      const tdAfter = isEditing
        ? `<td><div class="rag-edit-container"><input type="number" class="anima-input rag-compact-input h-after" value="${h.range_after || 0}" min="0" style="width:100%; text-align:center;"></div></td>`
        : `<td style="text-align:center;"><span style="color:#aaa;">${h.range_after || 0}</span></td>`;

      // 5. 操作列
      let tdAction = "";
      if (isEditing) {
        tdAction = `
                <td style="text-align:right;">
                    <div class="rag-edit-container" style="justify-content: flex-end;">
                        <button class="anima-btn primary small rag-tiny-btn btn-save" title="保存"><i class="fa-solid fa-check"></i></button>
                        <button class="anima-btn secondary small rag-tiny-btn btn-cancel" title="取消"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                </td>`;
      } else {
        tdAction = `
                <td style="text-align:right;">
                    <div class="rag-edit-container" style="justify-content: flex-end;">
                        <button class="anima-btn secondary small rag-tiny-btn btn-edit" title="编辑"><i class="fa-solid fa-pen"></i></button>
                        <button class="anima-btn danger small rag-tiny-btn btn-del" title="删除"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </td>`;
      }

      $tr.append(tdDate + tdName + tdBefore + tdAfter + tdAction);

      // === 事件绑定 ===
      if (isEditing) {
        $tr.find(".btn-save").click(() => {
          const date = $tr.find(".h-date").val().trim();
          const name = $tr.find(".h-name").val().trim();
          if (!date || !name) return toastr.warning("日期和名称不能为空");

          tempHolidays[idx] = {
            date: date,
            name: name,
            range_before: parseInt($tr.find(".h-before").val()) || 0,
            range_after: parseInt($tr.find(".h-after").val()) || 0,
          };
          renderList();
        });
        $tr.find(".btn-cancel").click(() => renderList());
      } else {
        $tr.find(".btn-edit").click(() => renderList(idx));
        $tr.find(".btn-del").click(() => {
          if (confirm(`删除节日 ${h.name}?`)) {
            // 应该操作临时数组 tempHolidays
            tempHolidays.splice(idx, 1);
            renderList();
          }
        });
      }
      tbody.append($tr);
    });
  };

  const modalHtml = `
        <div style="margin-bottom:10px; font-size:12px; color:#aaa; line-height:1.4;">
             <div><i class="fa-solid fa-circle-info"></i> 
                  日期格式：<code>06-15</code>。节前/节后设置为 0 表示仅当天触发。
             </div>
        </div>
        <div style="margin-bottom:10px; display:flex; justify-content:flex-end;">
             <button id="btn_holiday_add" class="anima-btn primary small"><i class="fa-solid fa-plus"></i> 添加节日</button>
        </div>
        
        <div class="rag-table-wrapper" style="max-height:300px; overflow-y:auto; background:rgba(0,0,0,0.2); border-radius:4px; border:1px solid rgba(255,255,255,0.1);">
            <table class="anima-rag-tag-table rag-strat-table" style="margin:0;">
                <thead>
                    <tr>
                        <th style="width: 20%;">日期</th>
                        <th style="width: 30%;">节日名</th>
                        <th style="width: 15%; text-align:center;">节前</th>
                        <th style="width: 15%; text-align:center;">节后</th>
                        <th style="width: 20%; text-align:right;">操作</th>
                    </tr>
                </thead>
                <tbody id="anima_holiday_tbody"></tbody>
            </table>
        </div>
        <div style="margin-top: 20px; display:flex; justify-content:flex-end; align-items:center; gap: 10px;">
            <button id="btn_holiday_cancel_all" class="anima-btn secondary">取消</button>
            <button id="btn_holiday_save_all" class="anima-btn primary">确认修改</button>
        </div>
    `;

  showRagModal("节日配置", modalHtml);
  renderList();

  $("#btn_holiday_add").on("click", () => {
    tempHolidays.push({
      date: "",
      name: "",
      range_before: 0,
      range_after: 0,
    });
    renderList(tempHolidays.length - 1); // 自动进入编辑模式
  });

  // 2. 🔥 [新增] 取消按钮
  $("#btn_holiday_cancel_all").on("click", () => {
    $("#anima-rag-modal").addClass("hidden"); // 直接关闭，丢弃修改
  });

  // 3. 🔥 [新增] 确认修改按钮 (核心逻辑)
  $("#btn_holiday_save_all").on("click", () => {
    // (1) 将临时副本应用到 settings
    settings.holidays = tempHolidays;

    // (2) 持久化保存
    saveRagSettings(settings);

    // (3) 刷新主界面表格 (让新标签显示出来)
    renderStrategyTable(settings);

    // (4) 关闭弹窗
    $("#anima-rag-modal").addClass("hidden");
    toastr.success("节日配置已保存");
  });
}

function renderPeriodModal(settings) {
  // 1. 数据结构兼容性迁移 (旧版 -> 新版数组)
  // 如果是旧版结构(有start_date但没有events数组)，自动转换
  if (!settings.period_config) {
    settings.period_config = { enabled: true, events: [] };
  }
  if (!Array.isArray(settings.period_config.events)) {
    const old = settings.period_config;
    const initialEvents = [];
    // 如果旧版有数据，迁移过来
    if (old.start_date) {
      initialEvents.push({
        label: "Period",
        start_date: old.start_date,
        cycle_length: old.cycle_length || 28,
        duration: old.duration || 5,
        range_before: old.range_before || 2,
        range_after: old.range_after || 2,
      });
    }
    // 重构结构，保留总开关
    settings.period_config = {
      enabled: old.enabled !== undefined ? old.enabled : true,
      events: initialEvents,
    };
  }

  const pConfig = settings.period_config;
  const events = pConfig.events;

  // 🔥 1. 创建临时副本 (Deep Copy)，实现“点击保存再写入”
  // 所有的行内编辑、删除、添加都操作这个 tempEvents
  let tempEvents = JSON.parse(
    JSON.stringify(settings.period_config.events || []),
  );

  // 引用配置对象，用于读取 enabled 开关状态 (开关通常建议实时生效，或者你也想把它做成最后保存？)
  // 这里假设开关还是实时生效，或者跟随最后保存也可以。为了简单，我们让开关也只操作临时对象，最后一起保存。
  let tempEnabled = settings.period_config.enabled;

  const renderList = (optionalEditIdx = -1) => {
    const tbody = $("#anima_period_tbody");
    tbody.empty();

    if (tempEvents.length === 0) {
      tbody.html(
        '<tr><td colspan="7" style="text-align:center; color:#666; padding:20px;">暂无周期事件，请点击右上方按钮添加</td></tr>',
      );
      return;
    }

    tempEvents.forEach((ev, idx) => {
      const isEditing = idx === optionalEditIdx;
      const $tr = $(`<tr data-idx="${idx}"></tr>`);

      // 样式优化：输入框和普通文本都强制居中
      const inputStyle =
        "width:100%; text-align:center; height:32px; line-height:32px; box-sizing: border-box; font-size: 14px;";
      const textStyle = "text-align:center; vertical-align:middle; color:#ddd;";

      const makeCell = (
        val,
        cls,
        type = "text",
        min = "",
        placeholder = "",
      ) => {
        if (isEditing) {
          return `<td><div class="rag-edit-container" style="justify-content:center;">
                        <input type="${type}" class="anima-input rag-compact-input ${cls}" 
                               value="${escapeHtml(val)}" ${min ? `min="${min}"` : ""} 
                               placeholder="${placeholder}"
                               style="${inputStyle}">
                    </div></td>`;
        }
        return `<td style="${textStyle}">${escapeHtml(val)}</td>`;
      };

      // 构建单元格 (保持原有逻辑，仅应用样式)
      const tdLabel = makeCell(ev.label, "p-label", "text", "", "TagName");
      const tdStart = makeCell(
        ev.start_date,
        "p-start",
        "text",
        "",
        "YYYY-MM-DD",
      );
      const tdCycle = makeCell(ev.cycle_length, "p-cycle", "number", "1");
      const tdDur = makeCell(ev.duration, "p-dur", "number", "1");
      const tdBefore = makeCell(ev.range_before, "p-before", "number", "0");
      const tdAfter = makeCell(ev.range_after, "p-after", "number", "0");

      // 操作列
      let tdAction = "";
      const btnContainerStyle =
        "display:flex; justify-content:center; align-items:center; gap:5px; height:100%;";

      if (isEditing) {
        tdAction = `
                <td style="vertical-align:middle;">
                    <div style="${btnContainerStyle}">
                        <button class="anima-btn primary small rag-tiny-btn btn-save-row" title="暂存行"><i class="fa-solid fa-check"></i></button>
                        <button class="anima-btn secondary small rag-tiny-btn btn-cancel-row" title="取消编辑"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                </td>`;
      } else {
        tdAction = `
                <td style="vertical-align:middle;">
                    <div style="${btnContainerStyle}">
                        <button class="anima-btn secondary small rag-tiny-btn btn-edit-row" title="编辑"><i class="fa-solid fa-pen"></i></button>
                        <button class="anima-btn danger small rag-tiny-btn btn-del-row" title="删除"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </td>`;
      }

      $tr.append(
        tdLabel + tdStart + tdCycle + tdDur + tdBefore + tdAfter + tdAction,
      );

      // === 事件绑定 (操作 tempEvents) ===
      if (isEditing) {
        $tr.find(".btn-save-row").click(() => {
          const label = $tr.find(".p-label").val().trim();
          const start = $tr.find(".p-start").val().trim();
          if (!label || !start) return toastr.warning("标签和开始日期不能为空");

          // 更新临时数组
          tempEvents[idx] = {
            label: label,
            start_date: start,
            cycle_length: parseInt($tr.find(".p-cycle").val()) || 28,
            duration: parseInt($tr.find(".p-dur").val()) || 5,
            range_before: parseInt($tr.find(".p-before").val()) || 0,
            range_after: parseInt($tr.find(".p-after").val()) || 0,
          };
          renderList();
          // 注意：这里不再调用 renderStrategyTable，因为还没保存到外部
        });
        $tr.find(".btn-cancel-row").click(() => renderList()); // 重新渲染以取消编辑状态
      } else {
        $tr.find(".btn-edit-row").click(() => renderList(idx));
        $tr.find(".btn-del-row").click(() => {
          // 删除临时数组项
          tempEvents.splice(idx, 1);
          renderList();
        });
      }
      tbody.append($tr);
    });
  };

  // 获取当前模式提示
  const isVirtual = settings.virtual_time_mode;
  const modeText = isVirtual
    ? `<span style="color:#60a5fa;"><i class="fa-solid fa-globe"></i> 虚拟时间</span>`
    : `<span style="color:#4ade80;"><i class="fa-solid fa-clock"></i> 现实时间</span>`;

  const html = `
    <div style="padding: 10px;">
        <div class="anima-flex-row">
            <div class="anima-label-group">
                <span class="anima-label-text">启用周期事件追踪</span>
                <span class="anima-desc-inline">当前基准: ${modeText}</span>
            </div>
            <label class="anima-switch">
                <input type="checkbox" id="rag_period_enabled_temp" ${tempEnabled ? "checked" : ""}>
                <span class="slider round"></span>
            </label>
        </div>
        
        <div class="anima-divider"></div>

        <div style="margin-bottom:10px; font-size:12px; color:#aaa; line-height:1.4;">
             <div><i class="fa-solid fa-circle-info"></i> 日期格式: <code>2025-01-30</code></div>
             <div>✨ 请左右滑动表格完成完整配置！</div>
        </div>
        <div style="margin-bottom:10px; display:flex; justify-content:flex-end;">
             <button id="btn_period_add" class="anima-btn primary small"><i class="fa-solid fa-plus"></i> 添加事件</button>
        </div>

        <div class="rag-table-wrapper" style="max-height:300px; overflow-y:auto; background:rgba(0,0,0,0.2); border-radius:4px; border:1px solid rgba(255,255,255,0.1);">
            <table class="anima-rag-tag-table rag-strat-table" style="margin:0; min-width: 580px; white-space: nowrap;">
                <thead>
                    <tr>
                        <th style="width: 15%; text-align:center; min-width: 80px;">标签</th>
                        <th style="width: 22%; text-align:center; min-width: 110px;">基准日期</th>
                        <th style="width: 10%; text-align:center; min-width: 60px;">周期</th>
                        <th style="width: 10%; text-align:center; min-width: 60px;">持续</th>
                        <th style="width: 12%; text-align:center; min-width: 70px;">前(天)</th>
                        <th style="width: 12%; text-align:center; min-width: 70px;">后(天)</th>
                        <th style="width: 15%; text-align:center; min-width: 90px;">操作</th>
                    </tr>
                </thead>
                <tbody id="anima_period_tbody"></tbody>
            </table>
        </div>
        
        <div style="margin-top: 20px; display:flex; justify-content:flex-end; align-items:center; gap: 10px;">
            <button id="btn_period_cancel_all" class="anima-btn secondary">取消</button>
            <button id="btn_period_save_all" class="anima-btn primary">确认修改</button>
        </div>
    </div>
    `;

  showRagModal("周期事件配置", html);
  renderList();

  // === 事件绑定 ===

  // 添加按钮 (操作 tempEvents)
  $("#btn_period_add").on("click", () => {
    tempEvents.push({
      label: "",
      start_date: "",
      cycle_length: 28,
      duration: 5,
      range_before: 2,
      range_after: 2,
    });
    renderList(tempEvents.length - 1); // 自动进入编辑最后一行
  });

  // 临时开关监听
  $("#rag_period_enabled_temp").on("change", function () {
    tempEnabled = $(this).prop("checked");
  });

  // 取消按钮：直接关闭，不保存
  $("#btn_period_cancel_all").on("click", () => {
    $("#anima-rag-modal").addClass("hidden");
  });

  // 🔥 保存修改按钮：核心逻辑
  $("#btn_period_save_all").on("click", () => {
    // 1. 将临时数据写入 settings
    settings.period_config.events = tempEvents;
    settings.period_config.enabled = tempEnabled;

    // 2. 持久化
    saveRagSettings(settings);

    // 3. 刷新主界面 (更新小勾勾和标签预览)
    renderStrategyTable(settings);

    // 4. 关闭弹窗
    $("#anima-rag-modal").addClass("hidden");
    toastr.success("生理周期配置已保存");
  });

  // 依然保留右上角的关闭叉号，作为取消处理
  $(".anima-close-rag-modal")
    .off("click")
    .on("click", () => {
      $("#anima-rag-modal").addClass("hidden");
    });
}

// ==========================================
// 8. 状态规则配置弹窗 (新增)
// ==========================================
function renderStatusRulesModal(settings) {
  // 确保 rules 数组存在
  if (!settings.strategy_settings.status.rules) {
    settings.strategy_settings.status.rules = [];
  }
  const rules = settings.strategy_settings.status.rules;

  const renderRuleRows = () => {
    const tbody = $("#anima_status_rules_tbody");
    tbody.empty();

    if (rules.length === 0) {
      tbody.html(
        '<tr><td colspan="5" style="text-align:center; color:#666; padding:10px;">暂无映射规则，请点击右上角添加</td></tr>',
      );
      return;
    }

    rules.forEach((rule, idx) => {
      const $tr = $(`<tr data-idx="${idx}"></tr>`);

      // 1. Tag Name (触发的标签)
      const tdTag = `<td><input type="text" class="anima-input rag-compact-input rule-tag" value="${escapeHtml(rule.tag)}" placeholder="例如: Injury"></td>`;

      // 2. JSON Path (路径)
      const tdPath = `<td><input type="text" class="anima-input rag-compact-input rule-path" value="${escapeHtml(rule.path)}" placeholder="例如: Player.HP"></td>`;

      // 3. Operator (操作符)
      const ops = [
        { v: "eq", t: "== (等于)" },
        { v: "neq", t: "!= (不等于)" },
        { v: "gt", t: "> (大于)" },
        { v: "lt", t: "< (小于)" },
        { v: "gte", t: "≥ (大等)" },
        { v: "lte", t: "≤ (小等)" },
        { v: "includes", t: "Includes (包含)" },
        { v: "not_includes", t: "Not Includes (不包含)" },
        { v: "exists", t: "Exists (存在)" },
      ];
      let opOptions = ops
        .map(
          (o) =>
            `<option value="${o.v}" ${rule.op === o.v ? "selected" : ""}>${o.t}</option>`,
        )
        .join("");
      const tdOp = `<td><select class="anima-select rag-compact-input rule-op">${opOptions}</select></td>`;

      // 4. Target Value (目标值)
      // 如果是 exists 操作符，值输入框应该禁用
      const isNoValue = rule.op === "exists";
      const tdValue = `<td><input type="text" class="anima-input rag-compact-input rule-val" value="${escapeHtml(rule.value)}" placeholder="30 / true / Sick" ${isNoValue ? 'disabled style="opacity:0.5"' : ""}></td>`;

      // 5. Delete Button
      const tdDel = `<td style="text-align:center;"><button class="anima-btn danger small rag-tiny-btn btn-del-rule"><i class="fa-solid fa-trash"></i></button></td>`;

      $tr.append(tdTag + tdPath + tdOp + tdValue + tdDel);

      // 绑定行内事件
      $tr.find(".btn-del-rule").on("click", () => {
        rules.splice(idx, 1);
        renderRuleRows();
      });

      // 操作符联动禁用 Value 输入框
      $tr.find(".rule-op").on("change", function () {
        const val = $(this).val();
        const $input = $tr.find(".rule-val");
        if (val === "exists") {
          $input.prop("disabled", true).css("opacity", 0.5);
        } else {
          $input.prop("disabled", false).css("opacity", 1);
        }
      });

      tbody.append($tr);
    });
  };

  const modalHtml = `
        <div style="margin-bottom:10px; font-size:12px; color:#aaa; line-height:1.4;">
            <div>当命中状态变量时，对应 <b>Tag</b> 将被用于向量检索。请左右滑动表格完成完整配置！</div>
            <div>✨ 请左右滑动表格完成完整配置！</div>
            <div style="margin-top:4px;">Path 示例: <code>Player.HP</code></div>
        </div>
        <div style="margin-bottom:10px; display:flex; justify-content:flex-end;">
             <button id="btn_add_rule" class="anima-btn primary small"><i class="fa-solid fa-plus"></i> 添加规则</button>
        </div>
        
        <div class="rag-table-wrapper" style="max-height:300px; overflow-y:auto; background:rgba(0,0,0,0.2); border-radius:4px; border:1px solid rgba(255,255,255,0.1);">
            <table class="anima-rag-tag-table rag-strat-table" style="margin:0; min-width: 540px; white-space: nowrap;">
                <thead>
                    <tr>
                        <th style="width: 20%; min-width: 90px;">标签</th>
                        <th style="width: 25%; min-width: 120px;">路径</th>
                        <th style="width: 20%; min-width: 110px;">逻辑</th>
                        <th style="width: 25%; min-width: 120px;">值</th>
                        <th style="width: 10%; text-align:center; min-width: 90px;">操作</th>
                    </tr>
                </thead>
                <tbody id="anima_status_rules_tbody"></tbody>
            </table>
        </div>

        <div style="margin-top:15px; display:flex; justify-content:flex-end; align-items:center; gap: 10px;">
            <button class="anima-close-rag-modal anima-btn secondary">取消</button>
            <button id="rag_btn_save_rules" class="anima-btn primary">确认修改</button>
        </div>
    `;

  showRagModal("状态映射规则", modalHtml);
  renderRuleRows();

  // 添加按钮
  $("#btn_add_rule").on("click", () => {
    rules.push({ tag: "", path: "", op: "eq", value: "" });
    renderRuleRows();
  });

  // 保存按钮
  $("#rag_btn_save_rules").on("click", () => {
    // 1. 采集数据
    const newRules = [];
    $("#anima_status_rules_tbody tr").each(function () {
      const tag = $(this).find(".rule-tag").val().trim();
      const path = $(this).find(".rule-path").val().trim();
      const op = $(this).find(".rule-op").val();
      const value = $(this).find(".rule-val").val().trim();

      if (tag && path) {
        newRules.push({ tag, path, op, value });
      }
    });

    // 2. 更新 Settings
    settings.strategy_settings.status.rules = newRules;

    // 3. 自动更新 labels (用于主界面展示)
    // 提取所有不重复的 Tag
    const uniqueTags = [...new Set(newRules.map((r) => r.tag))];
    settings.strategy_settings.status.labels = uniqueTags;

    // 4. 持久化并刷新
    saveRagSettings(settings);
    renderStrategyTable(settings); // 刷新主表格以显示新的 Labels
    $("#anima-rag-modal").addClass("hidden");
    toastr.success(`已保存 ${newRules.length} 条状态规则`);
  });
}

export async function constructRagQueryMock(chat, settings) {
  const promptConfig = settings.vector_prompt || [];
  const structuredResult = [];

  for (const [index, item] of promptConfig.entries()) {
    // 🟢 修改逻辑：显式检查是否为 context，否则一律视为 text
    // 这样可以兼容没有 type 属性的旧数据或新添加的条目
    if (item.type === "context") {
      const count = item.count || 5;

      // 1. 过滤逻辑
      let filteredChat = chat.filter((msg, idx) => {
        if (settings.skip_layer_zero && idx === 0) return false;
        // 确保 User 消息参与后续逻辑（由 shouldApplyRegex 决定是否清洗）
        return true;
      });

      // 2. 截取最后 N 条
      const slicedChat = filteredChat.slice(-count);

      // 3. 处理每一条消息
      const processedMsgs = slicedChat
        .map((msg) => {
          // 🟢 修改 A：先进行宏替换，再进行正则清洗
          // 这样 {{char}} 会先变成名字，然后正则才能正确匹配名字
          let content = processMacros(msg.mes);
          const isUser = msg.is_user;

          const shouldApplyRegex = !(isUser && settings.regex_skip_user);

          if (
            shouldApplyRegex &&
            settings.regex_strings &&
            settings.regex_strings.length > 0
          ) {
            content = applyRegexRules(content, settings.regex_strings);
          }

          return {
            original_name: msg.name,
            role: isUser ? "user" : "assistant",
            content: content,
            skippedRegex: !shouldApplyRegex && isUser,
            isValid: !!content,
          };
        })
        .filter((m) => m.isValid);

      structuredResult.push({
        type: "context",
        title: `📚 楼层内容 (Context - Last ${count})`,
        messages: processedMsgs,
      });
    } else {
      // 🟢 Else 分支：处理 Text (手动填写的 prompt)
      const roleStr = item.role || "system";
      const titleLabel = item.title
        ? `${item.title} (${roleStr})`
        : `📝 Prompt #${index + 1} (${roleStr})`;

      // 🟢 修改 B：在这里对用户填写的文本进行宏替换
      const processedContent = processMacros(item.content || "");

      structuredResult.push({
        type: "text",
        title: titleLabel,
        content: processedContent, // 使用替换后的内容
        role: roleStr,
      });
    }
  }
  return structuredResult;
}
