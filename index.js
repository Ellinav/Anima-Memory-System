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
      // 🟢 1. 确保 debounceTimer 定义在这一层，让下面所有事件都能访问到
      let debounceTimer = null;
      let isGenerationActive = false;
      const triggerAutomationCheck = (source, customDelay = 1000) => {
        const settings = getSummarySettings();
        if (!settings || !settings.auto_run) return;

        // 🟢 2. 新增：如果正在生成中，直接无视所有渲染事件！
        // 这样即便 user_message_rendered 晚于 generation_started 触发，也会被这里拦截
        if (isGenerationActive) {
          console.log(
            `[Anima] 🔒 生成进行中，忽略来自 ${source} 的自动化请求。`,
          );
          return;
        }

        if (getIsSummarizing()) {
          // console.log(`[Anima] Ignored ${source}: Task already running.`);
          return;
        }

        if (debounceTimer) clearTimeout(debounceTimer);

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
      context.eventSource.on("user_message_rendered", async (messageId) => {
        // 🔥【新增】: 零容忍清洗。User 楼层绝对不允许持有 anima_data。
        // 哪怕是 ST 核心或其他插件写进去的，只要是 User，一律删。
        try {
          // 如果 messageId 传进来了就用，没传就由 TavernHelper 找
          const targetId = messageId || -1;
          // 注意：这里我们不做 isUser 判断了，因为事件名就是 user_message_rendered
          const vars = window.TavernHelper.getVariables({
            type: "message",
            message_id: targetId,
          });

          if (vars && vars.anima_data) {
            console.warn(
              `[Anima] 🧹 发现 User 楼层(#${targetId}) 被非法注入变量，正在执行【瞬杀】...`,
            );
            const clean = { ...vars };
            delete clean.anima_data;
            // 使用 await 确保在生成开始前清理完毕
            await window.TavernHelper.replaceVariables(clean, {
              type: "message",
              message_id: targetId,
            });
            console.log("[Anima] ✅ User 楼层已净化。");
          }
        } catch (e) {
          console.warn("[Anima] User净化失败:", e);
        }

        // ... 原有的 triggerAutomationCheck 代码保持不变 ...
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
        isGenerationActive = true;

        try {
          const msgs = window.TavernHelper.getChatMessages(-1);
          if (msgs && msgs.length > 0) {
            const userMsg = msgs[0]; 
            
            // 再次确认是 User
            const isUser = userMsg.is_user || userMsg.role === "user" || String(userMsg.name).toLowerCase() === "you";

            if (isUser) {
              const vars = window.TavernHelper.getVariables({
                type: "message",
                message_id: userMsg.message_id,
              });
              
              // 只要有 anima_data，不管是不是一样的，直接删
              if (vars && vars.anima_data) {
                console.warn(`[Anima] 🛑 生成前哨战：发现 User 楼层(#${userMsg.message_id}) 携带脏数据，强制清除！`);
                const cleanVars = { ...vars };
                delete cleanVars.anima_data;
                
                // 注意：这里虽然在事件里用 await 可能阻塞不了 ST 核心，但值得一试
                await window.TavernHelper.replaceVariables(cleanVars, {
                  type: "message",
                  message_id: userMsg.message_id,
                });
              }
            }
          }
        } catch (e) {
          console.warn("[Anima] 净化逻辑异常:", e);
        }

        console.log("[Anima] 🔒 生成开始，锁定自动化触发器。");
        if (debounceTimer) {
          console.log("[Anima] 🚨 生成开始，强制取消挂起的自动化检查定时器。");
          clearTimeout(debounceTimer);
          debounceTimer = null;
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
        cancelStatusTimer(true);
      });

      context.eventSource.on("generation_stopped", () => {
        console.log("[Anima] 🛑 用户手动取消了生成 (Generation Stopped)");
        wasGenerationStopped = true;
        isGenerationActive = false;
        // 既然停止了，自然也要取消倒计时（虽然此时通常还没开始倒计时，但作为防御）
        cancelStatusTimer(true);
      });
      // --- 生成结束 (最可靠的触发点) ---
      // 建议：与其监听 character_message_rendered (可能会在编辑消息时多次触发)
      // 不如重点监听 generation_ended，这是 AI 回复完成的确切时间点
      context.eventSource.on("generation_ended", async () => {
        isGenerationActive = false;
        if (wasGenerationStopped) {
          console.log("[Anima] ⚠️ 检测到生成被中断，跳过所有自动化流程。");
          return;
        }

        // 等待 ST 完成数组更新
        await new Promise((resolve) => setTimeout(resolve, 50));

        const latestMsgs = window.TavernHelper.getChatMessages(-1);
        if (!latestMsgs || latestMsgs.length === 0) {
          console.warn("[Anima] ⚠️ 无法获取最新消息，跳过检查。");
          return;
        }

        const lastMsg = latestMsgs[0];

        // 如果成功生成，latestMsgs[0]是AI，latestMsgs[1]是User
        // 如果生成失败，latestMsgs[0]是User
        // 我们通通扫描一遍最近的2条消息，只要发现 User 带着 anima_data 就干掉

        try {
          const checkQueue = latestMsgs.slice(0, 2); // 检查最近两条
          for (const msg of checkQueue) {
            const isUser =
              msg.is_user ||
              msg.role === "user" ||
              String(msg.name).toLowerCase() === "you";
            if (isUser) {
              const vars = window.TavernHelper.getVariables({
                type: "message",
                message_id: msg.message_id,
              });
              if (
                vars &&
                vars.anima_data &&
                Object.keys(vars.anima_data).length > 0
              ) {
                console.warn(
                  `[Anima] 🧹 生成结束：检测到 User 楼层(#${msg.message_id}) 脏数据，执行清理。`,
                );
                const clean = JSON.parse(JSON.stringify(vars));
                delete clean.anima_data;
                await window.TavernHelper.replaceVariables(clean, {
                  type: "message",
                  message_id: msg.message_id,
                });
              }
            }
          }
        } catch (e) {
          console.warn("[Anima] 回溯净化失败:", e);
        }

        // 1. 判断是否为 AI 消息
        // 兼容性写法：检查 role 或 is_user 状态
        const isAi = lastMsg.role === "assistant" || lastMsg.is_user === false;

        // 🔴【核心修复点】如果最新的消息不是 AI (说明生成失败被回滚了)，直接终止！
        if (!isAi) {
          console.log("[Anima] 🛑 最新消息不是 Assistant (生成出错回滚)。");

          // 🚑 检查当前 User 楼层是否莫名其妙带上了变量
          try {
            const ghostVars = window.TavernHelper.getVariables({
              type: "message",
              message_id: lastMsg.message_id,
            });

            if (
              ghostVars &&
              ghostVars.anima_data &&
              Object.keys(ghostVars.anima_data).length > 0
            ) {
              console.warn(
                "[Anima] 🧹 捕获到 User 楼层的幽灵变量 (Ghost Data)！正在执行强制净化...",
              );

              // 💥 强制清空该楼层的 anima_data
              // 注意：这里我们只清空 anima_data，保留其他可能的插件数据
              // 如果你想彻底清空，传 {} 即可，但下面的写法更安全
              const cleanData = { ...ghostVars };
              delete cleanData.anima_data;

              await window.TavernHelper.replaceVariables(cleanData, {
                type: "message",
                message_id: lastMsg.message_id,
              });
              refreshStatusPanel();
              console.log("[Anima] ✅ 净化完成，User 楼层已恢复纯净。");
              if (window.toastr)
                window.toastr.info("已自动清理异常残留的变量数据");
            } else {
              console.log("[Anima] ✅ User 楼层干净，无异常。");
            }
          } catch (e) {
            console.error("[Anima] 净化过程出错:", e);
          }

          return; // ⛔ 终止后续流程
        }

        if (isAi) {
            try {
                const ghostVars = window.TavernHelper.getVariables({
                    type: "message",
                    message_id: lastMsg.message_id,
                });

                if (ghostVars && ghostVars.anima_data) {
                    console.warn(`[Anima] 👻 捕获 AI 楼层(#${lastMsg.message_id}) 的幽灵数据，执行无条件斩杀。`);
                    
                    const cleanData = { ...ghostVars };
                    delete cleanData.anima_data; // 移除脏数据
                    
                    await window.TavernHelper.replaceVariables(cleanData, {
                        type: "message",
                        message_id: lastMsg.message_id
                    });
                    console.log("[Anima] ✅ AI 楼层已重置为白板状态。");
                }
            } catch (e) {
                console.warn("[Anima] 斩杀失败:", e);
            }
        }
        // 2. 只有确认是 AI 后，才检查完整性
        // (之前的代码里 checkReplyIntegrity 如果不在 isAi 块里会报错，现在安全了)
        console.log(
          `[Anima Debug] 完整性检查: ID=${lastMsg.message_id}, 长度=${lastMsg.message?.length || 0}`,
        );

        if (!checkReplyIntegrity(lastMsg.message)) {
          console.warn(
            "[Anima] 🛑 主模型回复未通过完整性检查(过短或截断)，停止自动更新状态。",
          );
          return;
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
