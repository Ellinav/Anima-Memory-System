import { escapeHtml, showRagModal } from "./rag.js";
import {
  getSummaryTextFromEntry,
  triggerVectorUpdate,
} from "./worldbook_api.js";
import {
  insertMemory, // 🟢 必须引入：用于刷新/重新向量化
  deleteMemory, // 🟢 必须引入：用于删除向量
  getSmartCollectionId,
} from "./rag_logic.js";
// ==========================================
// 7. 向量状态管理 (完美复刻 Summary 历史管理)
// ==========================================

let ragHistoryPage = 1;
let cachedRagData = [];
const RAG_PAGE_SIZE = 20;

export async function showVectorStatusModal() {
  if (!window.TavernHelper) return;

  // 1. 获取数据
  const wbName = await window.TavernHelper.getChatWorldbookName("current");
  if (!wbName) {
    toastr.warning("当前聊天没有绑定世界书，暂无数据。");
    return;
  }

  const entries = await window.TavernHelper.getWorldbook(wbName);
  const animaEntries = entries.filter(
    (e) => e.extra && e.extra.createdBy === "anima_summary",
  );

  // 2. 构建缓存数据 (包含向量状态模拟)
  cachedRagData = [];
  animaEntries.forEach((entry) => {
    if (Array.isArray(entry.extra.history)) {
      entry.extra.history.forEach((hist) => {
        // 🟢 1. 适配 ID 读取逻辑
        // 新版 Summary 应该存的是 unique_id ("5_1")，旧版可能是 index (5)
        // 我们统一用 uniqueId 变量承载
        const uniqueId = hist.unique_id || hist.index;

        // 🟢 2. 获取 batch_id (如果有)
        const batchId = hist.batch_id || null;

        // 🟢 3. 简单的向量状态判断 (以后可以改为从 metadata 读取)
        // 暂时假设只要在 history 里就是处理过的，或者检查 hist.vectorized 字段
        const isVectorized = hist.vectorized !== false;

        cachedRagData.push({
          uid: entry.uid,
          entryName: entry.name,
          uniqueId: uniqueId,
          batchId: batchId,
          range_start: hist.range_start,
          range_end: hist.range_end,
          tags: Array.isArray(hist.tags) ? hist.tags : [],
          narrative_time:
            hist.narrative_time ||
            entry.extra.narrative_time ||
            new Date().toISOString(),
          wbName: wbName,
          isVectorized: isVectorized,
        });
      });
    }
  });

  // 排序逻辑也需要微调，处理字符串 "5_1" 的排序
  cachedRagData.sort((a, b) => {
    // 如果有 batchId，优先按 batch 排序，否则按 uniqueId 字符串排序或 localeCompare
    if (a.batchId && b.batchId && a.batchId !== b.batchId) {
      return b.batchId - a.batchId; // 倒序
    }
    // 简单的字符串比较 fallback
    return String(b.uniqueId).localeCompare(String(a.uniqueId), undefined, {
      numeric: true,
    });
  });
  ragHistoryPage = 1;

  // 3. 构建弹窗 HTML (复刻 summary.js)
  const modalHtml = `
    <div style="margin-bottom:15px; padding-bottom:15px; border-bottom:1px solid rgba(255,255,255,0.1); display:flex; flex-wrap:wrap; gap:10px; justify-content:space-between; align-items:center;">
        <div style="min-width: 200px;">
             <span style="font-size:14px; font-weight:bold;">当前世界书: ${escapeHtml(wbName)}</span>
             <div style="font-size:12px; color:#aaa; margin-top:4px;">共 ${cachedRagData.length} 个切片片段</div>
        </div>
        <div style="display:flex; gap:5px; flex-wrap:wrap;">
            <button id="anima-rag-btn-sync-dirty" class="anima-btn small primary" style="white-space:nowrap;">
                <i class="fa-solid fa-cloud-arrow-up"></i> 一键同步
            </button>
            <button id="anima-rag-btn-rebuild-all" class="anima-btn small" style="background-color: #dc2626; color: white; border: 1px solid #b91c1c; white-space:nowrap;">
                <i class="fa-solid fa-dumpster-fire"></i> 一键重建
            </button>
            <button id="anima-rag-btn-refresh-list" class="anima-btn small secondary" style="white-space:nowrap;">
                <i class="fa-solid fa-sync"></i>
            </button>
        </div>
    </div>
        
        <div id="anima-rag-progress-area" style="display:none; margin-bottom:15px; background:rgba(0,0,0,0.2); padding:10px; border-radius:4px;">
            <div style="display:flex; justify-content:space-between; font-size:12px; color:#ccc; margin-bottom:5px;">
                <span id="anima-rag-progress-text">正在处理: 0 / 0</span>
                <span id="anima-rag-progress-percent">0%</span>
            </div>
            <div style="width:100%; height:8px; background:#444; border-radius:4px; overflow:hidden;">
                <div id="anima-rag-progress-bar" style="width:0%; height:100%; background:var(--anima-primary); transition: width 0.3s;"></div>
            </div>
        </div>
        
        <div id="anima-rag-list-container" style="min-height: 300px;"></div>
        
        <div id="anima-rag-pagination" style="display:flex; justify-content:center; align-items:center; margin-top:15px; gap:15px;"></div>
    `;

  showRagModal("当前向量状态", modalHtml);
  renderRagHistoryPage();

  // 4. 绑定翻页/刷新事件
  $("#anima-rag-btn-refresh-list").on("click", () => showVectorStatusModal());

  $("#anima-rag-btn-sync-dirty").on("click", async function () {
    // 1. 筛选出脏数据 (isVectorized === false)
    const dirtyItems = cachedRagData.filter((item) => !item.isVectorized);
    const total = dirtyItems.length;

    if (total === 0) {
      toastr.success("所有切片均已同步，无需操作。");
      return;
    }

    // 2. 确认提示
    if (!confirm(`发现 ${total} 个未同步的切片。\n是否立即进行向量化处理？`)) {
      return;
    }

    // 3. UI 锁定
    const $btn = $(this);
    const originalHtml = $btn.html();
    $btn
      .prop("disabled", true)
      .html('<i class="fa-solid fa-circle-notch fa-spin"></i> 同步中...');
    $("#anima-rag-btn-rebuild-all").prop("disabled", true);
    $("#anima-rag-btn-refresh-list").prop("disabled", true);

    // 显示进度条
    const $progressArea = $("#anima-rag-progress-area");
    const $progressBar = $("#anima-rag-progress-bar");
    const $progressText = $("#anima-rag-progress-text");
    const $progressPercent = $("#anima-rag-progress-percent");
    $progressArea.slideDown();

    let successCount = 0;
    let failCount = 0;

    // 4. 串行处理 (避免并发爆炸)
    for (let i = 0; i < total; i++) {
      const item = dirtyItems[i];
      const currentNum = i + 1;

      // 更新进度条
      const percent = Math.round((currentNum / total) * 100);
      $progressBar.css("width", `${percent}%`);
      $progressText.text(
        `正在同步: ${currentNum} / ${total} (UID: ${item.uniqueId})`,
      );
      $progressPercent.text(`${percent}%`);

      try {
        // A. 获取文本
        const text = await getSummaryTextFromEntry(item.uid, item.uniqueId);

        if (text) {
          // 1. 获取统一的数据库 ID
          const targetCollectionId = getSmartCollectionId();

          const result = await insertMemory(
            text,
            item.tags,
            item.narrative_time,
            targetCollectionId, // 🟢 替换 wbName
            null,
            item.uniqueId,
            item.batchId,
          );

          // 🔥 核心修改：必须检查 result.success === true
          if (result && result.success === true) {
            successCount++;
            item.isVectorized = true; // 更新缓存

            // 更新世界书状态 (持久化)
            await window.TavernHelper.updateWorldbookWith(wbName, (entries) => {
              const e = entries.find((x) => x.uid === item.uid);
              if (e && e.extra && Array.isArray(e.extra.history)) {
                const h = e.extra.history.find(
                  (x) =>
                    String(x.unique_id || x.index) === String(item.uniqueId),
                );
                if (h) h.vectorized = true;
              }
              return entries;
            });
          } else {
            // 失败分支
            failCount++;
            console.warn(`[Sync] Failed #${item.uniqueId}:`, result?.error);
          }
        } else {
          failCount++;
          console.warn(`[Sync] Empty text for #${item.uniqueId}`);
        }
      } catch (err) {
        console.error(`[Sync] Failed #${item.uniqueId}:`, err);
        failCount++;
      }

      // 稍微防抖
      if (i % 5 === 0) await new Promise((r) => setTimeout(r, 10));
    }

    // 5. 完成结算
    toastr.info(`同步完成\n成功: ${successCount}\n失败: ${failCount}`);

    // 恢复 UI
    $progressArea.delay(1000).slideUp();
    $btn.prop("disabled", false).html(originalHtml);
    $("#anima-rag-btn-rebuild-all").prop("disabled", false);
    $("#anima-rag-btn-refresh-list").prop("disabled", false);

    // 重新渲染当前页面的列表，让变绿的状态立即显示
    renderRagHistoryPage();
  });

  // 🟢 新增：一键重建所有向量
  $("#anima-rag-btn-rebuild-all").on("click", async function () {
    const total = cachedRagData.length;
    if (total === 0) return;

    if (
      !confirm(
        `⚠️ 高危操作警告 ⚠️\n\n即将对 ${total} 个切片进行重新向量化。\n\n1. 这将消耗大量的 Token (取决于总结长度)。\n2. 这可能需要较长时间。\n3. 建议在更换 Embedding 模型后执行此操作。\n\n确定要继续吗？`,
      )
    ) {
      return;
    }

    // 1. UI 锁定与初始化
    const $btn = $(this);
    $btn
      .prop("disabled", true)
      .html('<i class="fa-solid fa-circle-notch fa-spin"></i> 处理中...');
    $("#anima-rag-btn-refresh-list").prop("disabled", true);

    const $progressArea = $("#anima-rag-progress-area");
    const $progressBar = $("#anima-rag-progress-bar");
    const $progressText = $("#anima-rag-progress-text");
    const $progressPercent = $("#anima-rag-progress-percent");

    $progressArea.slideDown();

    let successCount = 0;
    let failCount = 0;

    // 2. 遍历执行 (串行执行以减轻浏览器和后端压力，或者用 Promise.all 限制并发数)
    // 考虑到 LLM API 的 Rate Limit，建议每次并发 3-5 个，或者直接串行。
    // 这里为了稳妥，使用 for...of 串行处理 (也可以避免 UI 卡顿)

    for (let i = 0; i < total; i++) {
      const item = cachedRagData[i];
      const currentNum = i + 1;

      // 更新进度条
      const percent = Math.round((currentNum / total) * 100);
      $progressBar.css("width", `${percent}%`);
      $progressText.text(
        `正在处理: ${currentNum} / ${total} (UID: ${item.uniqueId})`,
      );
      $progressPercent.text(`${percent}%`);

      try {
        const text = await getSummaryTextFromEntry(item.uid, item.uniqueId);

        if (text) {
          // 🔥 修复：获取返回值并检查
          const targetCollectionId = getSmartCollectionId(); // 🟢 获取 ID

          const result = await insertMemory(
            text,
            item.tags,
            item.narrative_time,
            targetCollectionId, // 🟢 替换 wbName
            null,
            item.uniqueId,
            item.batchId,
          );

          // 🔥 核心修改：明确检查 success
          if (result && result.success === true) {
            successCount++;
            item.isVectorized = true;
          } else {
            failCount++;
            console.warn(
              `[Rebuild] API Error #${item.uniqueId}:`,
              result?.error,
            );
          }
        } else {
          failCount++;
          console.warn(`[Rebuild] Skipped empty text for #${item.uniqueId}`);
        }
      } catch (err) {
        console.error(`[Rebuild] Failed #${item.uniqueId}:`, err);
        failCount++;
      }

      // 稍微让出一点主线程，防止 UI 假死
      if (i % 5 === 0) await new Promise((r) => setTimeout(r, 10));
    }

    // 3. 完成结算
    toastr.info(`重建完成\n成功: ${successCount}\n失败: ${failCount}`);

    // 恢复 UI
    $progressArea.delay(1000).slideUp();
    $btn
      .prop("disabled", false)
      .html('<i class="fa-solid fa-dumpster-fire"></i> 重建向量库');
    $("#anima-rag-btn-refresh-list").prop("disabled", false);

    // 刷新当前列表视图以更新状态徽章
    renderRagHistoryPage();
  });

  $("#anima-rag-pagination").on("click", ".page-btn", function () {
    const action = $(this).data("action");
    const maxPage = Math.ceil(cachedRagData.length / RAG_PAGE_SIZE);

    if (action === "prev" && ragHistoryPage > 1) {
      ragHistoryPage--;
      renderRagHistoryPage();
    } else if (action === "next" && ragHistoryPage < maxPage) {
      ragHistoryPage++;
      renderRagHistoryPage();
    }
  });

  // 5. 绑定列表项内部事件 (复刻 bindHistoryListEvents)
  bindRagListEvents(wbName);
}

function renderRagHistoryPage() {
  const listContainer = $("#anima-rag-list-container");
  const pageContainer = $("#anima-rag-pagination");
  const startIdx = (ragHistoryPage - 1) * RAG_PAGE_SIZE;
  const endIdx = startIdx + RAG_PAGE_SIZE;
  const pageItems = cachedRagData.slice(startIdx, endIdx);

  if (pageItems.length === 0) {
    listContainer.html(
      `<div style="padding:20px; text-align:center;">暂无记录</div>`,
    );
    pageContainer.empty();
    return;
  }

  const html = pageItems
    .map((item) => {
      // 序列化 Tags 和 Time 以便通过 data 属性传递
      const tagsJson = escapeHtml(JSON.stringify(item.tags));

      // 状态徽章逻辑
      const vectorBadge = item.isVectorized
        ? `<span class="anima-tag-badge status-badge" style="background:rgba(74, 222, 128, 0.2); border-color:#22c55e; color:#4ade80; white-space:nowrap;"><i class="fa-solid fa-check"></i> 已向量化</span>`
        : `<span class="anima-tag-badge status-badge" style="background:rgba(248, 113, 113, 0.2); border-color:#ef4444; color:#f87171; white-space:nowrap;"><i class="fa-solid fa-clock"></i> 未向量化</span>`;
      return `
<div class="anima-history-entry" 
     data-unique-id="${item.uniqueId}" 
     data-batch-id="${item.batchId || ""}" 
     data-uid="${item.uid}"
     data-timestamp="${item.narrative_time}"
     data-tags="${tagsJson}">
     
    <div class="anima-history-header">
        <div class="anima-history-meta" style="flex:1; display:flex; align-items:center; flex-wrap:wrap; gap:5px;">
            <span style="color:#fbbf24; font-weight:bold; margin-right:5px; white-space:nowrap;">#${item.uniqueId}</span>
            ${vectorBadge}
            <span style="color:#666; font-size:12px; margin-left:5px; white-space:nowrap;">楼层 ${item.range_start}-${item.range_end}</span>
        </div>
        
        <div class="anima-history-actions" style="display:flex; align-items:center; gap:5px;">
            <div class="actions-normal">
                <button class="anima-btn small secondary btn-refresh-vector" title="刷新向量 (重新读取文本并向量化)">
                    <i class="fa-solid fa-database"></i>
                </button>
                
                <button class="anima-btn small danger btn-del-vector" title="仅删除向量文件"><i class="fa-solid fa-trash"></i></button>
            </div>
            <i class="fa-solid fa-chevron-right toggle-icon" style="font-size: 10px; color: #666; width:15px; text-align:center; transition: transform 0.2s; margin-left: 5px;"></i>
        </div>
    </div>
            
            <div class="anima-history-content" data-loaded="false" style="display:none; font-size:12px; color:#aaa;">
                <div class="loading-placeholder"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading text...</div>
            </div>
            
            <div class="anima-tags-wrapper" style="padding: 5px 10px 8px 10px; border-top: 1px dashed rgba(255,255,255,0.1);">
                <div class="tags-view-mode" style="color:#aaa; font-size:12px;">
                    <i class="fa-solid fa-tags" style="font-size:10px; margin-right:5px;"></i>
                    ${item.tags.map((t) => `<span class="anima-tag-badge">${escapeHtml(t)}</span>`).join("")}
                </div>
            </div>
        </div>`;
    })
    .join("");

  listContainer.html(html);

  const maxPage = Math.ceil(cachedRagData.length / RAG_PAGE_SIZE);
  if (maxPage <= 1) {
    pageContainer.empty();
  } else {
    pageContainer.html(`
            <button class="anima-btn small secondary page-btn" data-action="prev" ${ragHistoryPage === 1 ? 'disabled style="opacity:0.5"' : ""}>&lt;</button>
            <span style="font-weight:bold; color:#ccc;">${ragHistoryPage} / ${maxPage}</span>
            <button class="anima-btn small secondary page-btn" data-action="next" ${ragHistoryPage === maxPage ? 'disabled style="opacity:0.5"' : ""}>&gt;</button>
        `);
  }
}

// 绑定列表内的复杂交互 (编辑/展开/删除)
function bindRagListEvents(wbName) {
  const container = $("#anima-rag-list-container");
  container.off("click");

  // 1. 展开/收起 (保持不变，只是为了查看内容)
  container.on("click", ".anima-history-header", async function (e) {
    if ($(e.target).closest("button").length) return; // 点击按钮时不展开
    const $entry = $(this).closest(".anima-history-entry");
    const $content = $entry.find(".anima-history-content");
    const $icon = $entry.find(".toggle-icon");

    if ($content.is(":visible")) {
      $content.slideUp(150);
      $icon.css("transform", "rotate(0deg)");
    } else {
      if ($content.attr("data-loaded") === "false") {
        const uid = $entry.data("uid");
        const uniqueId = $entry.attr("data-unique-id");
        try {
          const text = await getSummaryTextFromEntry(uid, uniqueId);
          $content.text(text);
        } catch {
          $content.text("(内容加载失败)");
        }
        $content.attr("data-loaded", "true");
      }
      $content.slideDown(150);
      $icon.css("transform", "rotate(90deg)");
    }
  });

  // 2. 刷新/重新向量化 (Refres/Re-embed)
  container.on("click", ".btn-refresh-vector", async function (e) {
    e.stopPropagation();
    const $btn = $(this);
    const $entry = $btn.closest(".anima-history-entry");
    const $badge = $entry.find(".status-badge");

    // 1. 获取唯一标识 (这是永远不变的锚点)
    const uniqueId = $entry.attr("data-unique-id");
    // const uid = $entry.attr("data-uid"); // ❌ 不再信任 DOM 里的 uid
    const batchId = $entry.attr("data-batch-id");
    const timestamp = $entry.attr("data-timestamp");

    // 解析 Tags
    let tags = [];
    try {
      tags = JSON.parse(decodeURIComponent($entry.attr("data-tags") || "[]"));
    } catch (err) {
      tags = [];
    }

    // 2. UI 锁定
    const originalHtml = $btn.html();
    $btn
      .prop("disabled", true)
      .html('<i class="fa-solid fa-spinner fa-spin"></i>');
    $badge.html('<i class="fa-solid fa-spinner fa-spin"></i> 处理中...');

    try {
      // ============================================================
      // 🟢 核心修复 1: 暴力扫描最新世界书，获取鲜活的 UID
      // ============================================================
      const currentEntries = await window.TavernHelper.getWorldbook(wbName);

      let freshUid = null;

      // 遍历所有 Anima 创建的条目，寻找包含此 uniqueId 的宿主
      const hostEntry = currentEntries.find(
        (entry) =>
          entry.extra &&
          entry.extra.createdBy === "anima_summary" &&
          Array.isArray(entry.extra.history) &&
          entry.extra.history.some(
            (h) => String(h.unique_id || h.index) === String(uniqueId),
          ),
      );

      if (hostEntry) {
        freshUid = hostEntry.uid;
        console.log(`[Anima] 重新定位切片 #${uniqueId} -> 新UID: ${freshUid}`);
      } else {
        throw new Error(
          "在当前世界书中找不到该切片，请刷新列表或检查是否已被删除。",
        );
      }

      // 3. 获取文本 (使用刚找到的 freshUid)
      const text = await getSummaryTextFromEntry(freshUid, uniqueId);

      // ============================================================
      // 🟢 核心修复 2: 拦截错误字符串，防止污染数据库
      // ============================================================
      if (!text || text === "(条目已丢失)" || text.includes("(条目已丢失)")) {
        throw new Error("无法读取切片文本 (内容丢失或无效)");
      }

      // 4. 调用底层接口
      const targetCollectionId = getSmartCollectionId();

      const result = await insertMemory(
        text,
        tags,
        timestamp,
        targetCollectionId,
        null,
        uniqueId,
        batchId,
      );

      // 5. 成功回调
      if (result && result.success === true) {
        // 更新世界书状态 (使用 freshUid)
        await window.TavernHelper.updateWorldbookWith(wbName, (entries) => {
          const e = entries.find((x) => x.uid === freshUid);
          if (e && e.extra && Array.isArray(e.extra.history)) {
            const h = e.extra.history.find(
              (x) => String(x.unique_id || x.index) === String(uniqueId),
            );
            if (h) h.vectorized = true;
          }
          return entries;
        });

        toastr.success(`切片 #${uniqueId} 更新成功`);

        // 更新 DOM 上的 uid，方便下次操作
        $entry.attr("data-uid", freshUid);

        $badge.html('<i class="fa-solid fa-check"></i> 已向量化').css({
          color: "#4ade80",
          borderColor: "#22c55e",
          background: "rgba(74, 222, 128, 0.2)",
        });
      } else {
        throw new Error(result?.error || "后端未返回成功标识");
      }
    } catch (err) {
      console.error(err);
      toastr.error("更新失败: " + err.message);
      $badge.html('<i class="fa-solid fa-xmark"></i> 失败').css({
        color: "#f87171",
        borderColor: "#ef4444",
        background: "rgba(248, 113, 113, 0.2)",
      });
    } finally {
      $btn.prop("disabled", false).html(originalHtml);
    }
  });

  // 3. 删除向量 (Delete Vector Only)
  // 逻辑：调用 deleteMemory -> UI 更新为未向量化
  container.on("click", ".btn-del-vector", async function (e) {
    e.stopPropagation();
    const uniqueId = $(this)
      .closest(".anima-history-entry")
      .attr("data-unique-id");
    const $entry = $(this).closest(".anima-history-entry");
    const $badge = $entry.find(".status-badge");

    if (
      !confirm(`确定要物理删除 #${uniqueId} 的向量文件吗？\n(世界书文本将保留)`)
    )
      return;
    const targetCollectionId = getSmartCollectionId();
    try {
      await deleteMemory(targetCollectionId, uniqueId);

      toastr.success(`向量 #${uniqueId} 已删除`);

      // UI 更新为未向量化
      $badge.html('<i class="fa-solid fa-clock"></i> 未向量化').css({
        color: "#f87171",
        borderColor: "#ef4444",
        background: "rgba(248, 113, 113, 0.2)",
      });
    } catch (err) {
      toastr.error("删除失败: " + err.message);
    }
  });
}

/**
 * 检查并同步所有“脏”向量 (Vectorized = false)
 */
export async function checkAndSyncDirtyVectors() {
  if (!window.TavernHelper) return;

  // 1. 获取当前数据
  const wbName = await window.TavernHelper.getChatWorldbookName("current");
  if (!wbName) return;
  const entries = await window.TavernHelper.getWorldbook(wbName);

  // 2. 搜集脏数据 (Anima创建 且 vectorized === false)
  const dirtyItems = [];

  entries.forEach((entry) => {
    if (
      entry.extra &&
      entry.extra.createdBy === "anima_summary" &&
      Array.isArray(entry.extra.history)
    ) {
      entry.extra.history.forEach((h) => {
        // 如果明确标记为 false，或者压根没有这个字段但它是新建的
        if (h.vectorized === false) {
          dirtyItems.push({
            uid: entry.uid, // 条目 UID
            index: h.unique_id || h.index, // 切片 ID
          });
        }
      });
    }
  });

  if (dirtyItems.length === 0) return;

  // 3. 提示用户
  toastr.warning(
    `检测到 ${dirtyItems.length} 个未同步的切片，请前往【当前向量状态】补录...`,
  );
  console.log(
    `[Anima Auto-Sync] 发现 ${dirtyItems.length} 个脏切片:`,
    dirtyItems,
  );

  // 4. 动态导入 triggerVectorUpdate 并执行 (利用既有逻辑)
  // 注意：triggerVectorUpdate 没有 export，但在 worldbook_api.js 内部
  // 这里我们其实需要调用的是 scheduleVectorUpdate 或者直接由 worldbook_api 暴露一个 sync 方法
  // 为了简单起见，我们直接模拟一次“更新”操作，或者在 worldbook_api.js 里加一个 export 的 syncEntry 方法

  // 💡 更好的办法：直接复用 updateSummaryContent 的逻辑有点重
  // 我们在 rag.js 里直接调用 rag_logic.js 的 insertMemory 吗？不，那样不更新 WB 状态。
  // 最佳方案：让用户手动点一下“刷新列表”其实就能看到红色的状态，然后点刷新按钮。

  // 如果你坚持要全自动，你需要去 worldbook_api.js 导出一个 forceSync(index) 函数
  // 鉴于不想让你改太多文件，我们采用【模拟点击刷新按钮】的逻辑，或者仅提示用户。

  // 这里推荐：仅提示用户。因为批量并发写入可能会卡顿。
  // 如果你非常想要自动执行，请告诉我，我给你 worldbook_api.js 增加一个 export 函数。
}
