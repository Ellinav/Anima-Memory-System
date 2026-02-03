// 引入各个页面的管理器
import { initApiSettings } from "./scripts/api.js";
import { initStatusSettings, refreshStatusPanel } from "./scripts/status.js";
import {
  initSummarySettings,
  updateStatusInputs,
  refreshAutomationUI,
} from "./scripts/summary.js";
import {
  runSummarizationTask,
  getIsSummarizing,
  getSummarySettings,
} from "./scripts/summary_logic.js";
import { initRagSettings, clearLastRetrievalResult } from "./scripts/rag.js";
import { insertMemory, queryDual } from "./scripts/rag_logic.js";
import { initInterceptor } from "./scripts/interceptor.js";
import {
  clearRagEntry,
  clearKnowledgeEntry,
  syncRagSettingsToWorldbook,
} from "./scripts/worldbook_api.js";
import {
  getStatusSettings,
  getStatusFromMessage,
  handleStatusUpdate,
  cancelStatusTimer,
  initStatusMacro,
  handleGreetingSwipe,
  checkInitialGreetingStatus,
  checkReplyIntegrity,
  syncStatusToWorldBook,
} from "./scripts/status_logic.js";
import { objectToYaml } from "./scripts/utils.js";

(function () {
  // 1. 定义基础外壳
  const shellHtml = `
    <div id="anima-overlay" class="anima-hidden">
        <div class="anima-header-bar">
            <div class="anima-brand">
                <div id="anima-toggle-sidebar"><i class="fa-solid fa-bars"></i></div>
                <span>Anima Memory System</span>
            </div>
            <div id="anima-close-btn" title="关闭"><i class="fa-solid fa-xmark"></i></div>
        </div>
        <div class="anima-main-layout">
            <div class="anima-sidebar" id="anima-sidebar">
                <div class="anima-nav-item active" data-tab="tab-api">
                    <i class="fa-solid fa-server fa-fw"></i> <span>API 设置</span>
                </div>
                <div class="anima-nav-item" data-tab="tab-summary">
                    <i class="fa-solid fa-clock-rotate-left fa-fw"></i> <span>总结与记录</span>
                </div>
                <div class="anima-nav-item" data-tab="tab-rag">
                    <i class="fa-solid fa-database fa-fw"></i> <span>向量 RAG</span>
                </div>
                <div class="anima-nav-item" data-tab="tab-status">
                    <i class="fa-solid fa-table-list fa-fw"></i> <span>状态变量</span>
                </div>
            </div>
            <div class="anima-content-area">
                <div id="tab-api" class="anima-tab-content active"></div>
                <div id="tab-status" class="anima-tab-content"></div>
                <div id="tab-core" class="anima-tab-content"></div>
                <div id="tab-summary" class="anima-tab-content"></div>
                <div id="tab-rag" class="anima-tab-content"></div>
            </div>
        </div>
    </div>
    `;

  // 2. 注入 HTML 并初始化各模块
  function initPlugin() {
    if (document.getElementById("anima-overlay")) return;
    document.body.insertAdjacentHTML("beforeend", shellHtml);

    bindGlobalEvents();
    checkMobileState();

    initApiSettings();
    initStatusSettings();
    initSummarySettings();
    initRagSettings();
    initInterceptor();
    initStatusMacro();

    window["animaTest"] = {
      insert: insertMemory,
      query: queryDual,
    };
    console.log("[Anima] RAG 测试工具已挂载，请输入 window.animaTest 查看");
    console.log("[Anima] Plugin initialized successfully.");
  }

  // 3. 全局事件绑定
  function bindGlobalEvents() {
    $("#anima-close-btn").on("click", () => {
      $("#anima-overlay").addClass("anima-hidden");
    });

    $("#anima-toggle-sidebar").on("click", () => {
      $("#anima-sidebar").toggleClass("collapsed");
    });

    $(".anima-nav-item").on("click", function () {
      $(".anima-nav-item").removeClass("active");
      $(".anima-tab-content").removeClass("active");

      $(this).addClass("active");
      const tabId = $(this).data("tab");
      $(`#${tabId}`).addClass("active");

      if (window.innerWidth <= 768) {
        $("#anima-sidebar").addClass("collapsed");
      }
    });

    window.addEventListener("resize", () => {
      if (
        window.innerWidth > 768 &&
        $("#anima-sidebar").hasClass("collapsed")
      ) {
        // 视情况决定是否要在变大时自动展开
      }
    });

    const context = SillyTavern.getContext();
    if (context && context.eventSource) {
      // --- 提取公共的防抖与检查逻辑 ---
      let debounceTimer = null;

      const triggerAutomationCheck = (source, customDelay = 1000) => {
        // 🛑 卫语句 1: 如果自动化根本没开... (保持不变)
        const settings = getSummarySettings();
        if (!settings || !settings.auto_run) {
          return;
        }

        // 🛑 卫语句 2: (保持不变)
        if (getIsSummarizing()) {
          console.log(`[Anima] Ignored ${source}: Task already running.`);
          return;
        }

        // ✅ 通过检查，进入防抖
        if (debounceTimer) clearTimeout(debounceTimer);

        // 使用传入的 customDelay
        debounceTimer = setTimeout(() => {
          console.log(
            `[Anima] Triggering automation check from ${source} (Delay: ${customDelay}ms)...`,
          );
          runSummarizationTask();
        }, customDelay);
      };

      // --- 聊天切换事件 ---
      context.eventSource.on("chat_id_changed", async (chatId) => {
        console.log("[Anima] Chat Changed to:", chatId || "None (Closed)");

        // 1. 既然聊天变了（无论是换人还是关闭），RAG 缓存和配置必须“全量刷新”
        // 由于我们在 rag.js 中重构了读取逻辑，这里的 initRagSettings() 会执行以下操作：
        // - 调用 getRagSettings()：自动合并 [全局设置] + [当前角色卡扩展设置]
        // - 调用 getChatRagFiles()：从当前 [聊天 Metadata] 中读取关联的数据库列表
        // - 最后刷新 RAG 面板 UI
        try {
          await clearRagEntry();
          await clearKnowledgeEntry();
        } catch (e) {
          console.warn(
            "[Anima] Failed to clear Worldbook entries on chat change:",
            e,
          );
        }

        clearLastRetrievalResult();
        initRagSettings(); // 🟢 核心：触发 rag.js 里的多源重新获取逻辑

        if (chatId) {
          try {
            // 这里不传参，让它按默认逻辑读取 (有卡读卡，没卡读全局)
            await syncStatusToWorldBook();
            console.log("[Anima] 状态注入条目已同步");
          } catch (e) {
            console.warn("[Anima] 状态注入同步失败:", e);
          }
          try {
            // 自动将目前的聊天总结/知识库条目设置应用到当前聊天世界书
            await syncRagSettingsToWorldbook();
            console.log("[Anima] RAG与知识库注入配置已自动同步至世界书");
          } catch (e) {
            console.warn("[Anima] RAG注入同步失败:", e);
          }
          toastr.success("Anima 记忆系统已就绪!");
        }

        // 2. 延时刷新 UI 与 初始状态检查 (维持原有状态变量逻辑)
        let attempts = 0;
        const maxAttempts = 10;

        const initCheckInterval = setInterval(() => {
          attempts++;

          if (attempts === 1) {
            initStatusSettings();
            updateStatusInputs();
            refreshStatusPanel();
            refreshAutomationUI();
          }

          if (!chatId) {
            clearInterval(initCheckInterval);
            return;
          }

          const isReady = checkInitialGreetingStatus();

          if (isReady || attempts >= maxAttempts) {
            clearInterval(initCheckInterval);
          }
        }, 500);

        if (chatId) {
          setTimeout(() => runSummarizationTask(), 2000);
        }
      });

      // --- 用户消息上屏 ---
      context.eventSource.on("user_message_rendered", () => {
        // 💡 关键修改：
        // 用户消息刚上屏 -> 主 API 正在请求中 -> 强制让 Anima 等待 2.5秒
        // 这样就实现了你想要的“错峰”请求，不需要等待主API完全回复，但避开了并发高峰
        triggerAutomationCheck("user_message_rendered", 2500);
      });

      let statusDebounceTimer = null;

      // --- AI 消息上屏 ---
      context.eventSource.on("character_message_rendered", (messageId) => {
        triggerAutomationCheck("character_message_rendered", 1000);
      });
      let wasGenerationStopped = false;
      context.eventSource.on("generation_started", (type, arg1, arg2) => {
        const isDryRun = arg1 === true || arg2 === true;
        if (isDryRun) {
          return;
        }
        if (swipeCheckTimer) {
          console.log(
            "[Anima] 检测到真实生成 (Regenerate)，取消开场白状态注入。",
          );
          clearTimeout(swipeCheckTimer);
          swipeCheckTimer = null;
        }
        // B. 有效生成开始：重置中断状态
        wasGenerationStopped = false;

        // C. 取消上一轮的倒计时 (如果有)
        console.log("[Anima] 🚨 检测到新请求，重置状态标志并取消倒计时。");
        cancelStatusTimer();
      });
      context.eventSource.on("generation_stopped", () => {
        console.log("[Anima] 🛑 用户手动取消了生成 (Generation Stopped)");
        wasGenerationStopped = true;
        // 既然停止了，自然也要取消倒计时（虽然此时通常还没开始倒计时，但作为防御）
        cancelStatusTimer();
      });
      // --- 生成结束 (最可靠的触发点) ---
      // 建议：与其监听 character_message_rendered (可能会在编辑消息时多次触发)
      // 不如重点监听 generation_ended，这是 AI 回复完成的确切时间点
      context.eventSource.on("generation_ended", async () => {
        // A. 拦截中断情况
        if (wasGenerationStopped) {
          console.log(
            "[Anima] ⚠️ 检测到生成被中断，跳过所有自动化流程 (Status & Summary)。",
          );
          return;
        }

        // 🔥【修复核心】增加 50ms 延时，确保 ST 已将回复完全写入历史记录
        // generation_ended 触发时，有时候内存里的 chat 数组还没来得及更新
        await new Promise((resolve) => setTimeout(resolve, 50));

        // 🔥【修复核心】改用 TavernHelper 获取最新的 1 条消息
        // 相比 getContext().chat，这个接口能通过 -1 准确拿到最新的 Message 对象
        const latestMsgs = window.TavernHelper.getChatMessages(-1);

        if (latestMsgs && latestMsgs.length > 0) {
          const lastMsg = latestMsgs[0];

          // 兼容检查：确保是 AI 的回复
          // 根据你提供的类型定义，检查 role === 'assistant' 或 is_user === false
          const isAi =
            lastMsg.role === "assistant" || lastMsg.is_user === false;

          if (isAi) {
            // 打印一下长度，方便排查（如果还是报错，看控制台这个长度是多少）
            console.log(
              `[Anima Debug] 完整性检查: ID=${lastMsg.message_id}, 长度=${lastMsg.message?.length || 0}`,
            );

            if (!checkReplyIntegrity(lastMsg.message)) {
              console.warn(
                "[Anima] 🛑 主模型回复未通过完整性检查(过短或截断)，停止自动更新状态。",
              );
              return;
            }
          }
        } else {
          console.warn("[Anima] ⚠️ 无法获取最新消息，跳过检查。");
        }

        console.log(
          "[Anima] Generation ended (Success). Triggering automation...",
        );

        // --- 1. 原有的 RAG 清理逻辑 (保留) ---
        await clearRagEntry();
        await clearKnowledgeEntry();

        // --- 2. 原有的总结自动化逻辑 (保留) ---
        triggerAutomationCheck("generation_ended", 1000);

        // --- 3. 新的状态更新逻辑 (保留) ---
        try {
          await handleStatusUpdate(); // 执行逻辑层更新
        } catch (e) {
          console.error("[Anima] Post-generation status update failed:", e);
        }
      });

      context.eventSource.on("message_edited", (payload) => {
        // payload 通常是 messageId
        console.log("[Anima] 检测到消息编辑，ID:", payload);
        // 未来可以在这里调用 status_logic 里的 checkAndShowRefreshButton(payload)
      });
      // --- 开场白切换监听 (Message Swiped) ---
      let swipeCheckTimer = null;

      context.eventSource.on("message_swiped", (msgId) => {
        if (msgId !== 0) return;
        // console.log("[Anima] Swipe detected on Layer 0...");

        if (swipeCheckTimer) clearTimeout(swipeCheckTimer);

        // 延迟 500ms 执行，如果在中途检测到“真实生成”，则会被取消
        swipeCheckTimer = setTimeout(() => {
          handleGreetingSwipe(false); // false = 显示 Toast
          swipeCheckTimer = null;
        }, 500);
      });
    }
  }

  // 4. 手机端状态检查
  function checkMobileState() {
    if (window.innerWidth <= 768) {
      $("#anima-sidebar").addClass("collapsed");
    } else {
      $("#anima-sidebar").removeClass("collapsed");
    }
  }

  // 5. 添加入口按钮
  function addExtensionButton() {
    const menuId = "extensionsMenu";
    const menu = document.getElementById(menuId);
    // 如果菜单还没加载出来，稍微等一下
    if (!menu) {
      setTimeout(addExtensionButton, 500);
      return;
    }
    if (document.getElementById("anima-wand-btn")) return;

    const container = document.createElement("div");
    container.className = "extension_container interactable";
    container.innerHTML = `
            <div id="anima-wand-btn" class="list-group-item flex-container flexGap5 interactable" title="Anima 记忆系统">
                <div class="fa-fw fa-solid fa-brain extensionsMenuExtensionButton" style="color: #10b981;"></div>
                <span>Anima 记忆系统</span>
            </div>
        `;
    container.addEventListener("click", () => {
      $("#anima-overlay").removeClass("anima-hidden");
    });
    menu.appendChild(container);
  }

  /**
   * 获取当前插件的根目录路径
   * 基于 document.currentScript (如果同步加载) 或推断
   */
  function getExtensionBasePath() {
    // 1. 尝试在已加载的脚本中查找包含当前插件名的路径
    const scripts = document.querySelectorAll("script");
    const targetFolder = "Anima-Memory-System"; // <--- 这里必须匹配你的文件夹名

    for (const script of scripts) {
      if (script.src && script.src.includes(`/${targetFolder}/index.js`)) {
        return script.src.replace("/index.js", "/");
      }
    }

    // 2. 如果自动检测失败，使用正确的硬编码路径
    console.warn(`[Anima] 路径自动检测失败，使用默认路径: ${targetFolder}`);
    return `scripts/extensions/third-party/${targetFolder}/`;
  }

  /**
   * 动态加载本地库文件
   */
  function loadLocalLibrary(relativePath) {
    return new Promise((resolve, reject) => {
      const basePath = getExtensionBasePath();
      // 确保路径拼接正确，去除多余的斜杠
      const finalUrl =
        basePath.replace(/\/$/, "") + "/" + relativePath.replace(/^\//, "");

      console.log(`[Anima] 正在加载依赖: ${finalUrl}`);

      const script = document.createElement("script");
      script.src = finalUrl;
      script.onload = () => {
        console.log(`[Anima] ✅ 库加载成功: ${relativePath}`);
        resolve();
      };
      script.onerror = (e) => {
        console.error(`[Anima] ❌ 本地库加载失败 (404): ${finalUrl}`);
        console.error(
          `请检查：文件是否位于 C:\\AI\\SillyTavern\\public\\scripts\\extensions\\third-party\\Anima-Memory-System\\lib\\${relativePath}`,
        );
        resolve();
      };
      document.head.appendChild(script);
    });
  }

  async function startAnima() {
    console.log("[Anima] 正在启动...");

    // 1. 加载依赖库
    // 只有当 window 对象上没有这些库时才加载
    if (typeof window.jsyaml === "undefined") {
      await loadLocalLibrary("lib/js-yaml.min.js");
    } else {
      console.log("[Anima] js-yaml 已存在，跳过加载。");
    }

    if (typeof window.z === "undefined") {
      await loadLocalLibrary("lib/zod.min.js");
    } else {
      console.log("[Anima] Zod 已存在，跳过加载。");
    }

    // 2. 初始化插件
    initPlugin();
    addExtensionButton();
  }

  /**
   * 轮询检测 TavernHelper 是否就绪
   */
  function waitForTavernHelper(retryCount = 0) {
    const MAX_RETRIES = 30;

    if (typeof window.TavernHelper !== "undefined") {
      console.log("[Anima] TavernHelper 检测通过，启动插件。");
      startAnima();
    } else {
      if (retryCount >= MAX_RETRIES) {
        toastr.error("Anima 启动失败：等待 酒馆助手 超时。", "依赖缺失");
        return;
      }
      setTimeout(() => waitForTavernHelper(retryCount + 1), 500);
    }
  }

  // 入口点
  $(document).ready(function () {
    waitForTavernHelper();
  });
})();
