// 1. 机器看的时间：标准 ISO 8601 格式 (用于 send_date 属性)
// ST 最喜欢这种格式，排序最准
function formatIsoDate(timestamp) {
  return new Date(timestamp * 1000).toISOString();
}

// 2. 人类看的时间：可读格式 (用于写入 mes 文本)
// 例如: November 12, 2024 12:43am
function formatHumanDate(timestamp) {
  const date = new Date(timestamp * 1000);
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  let hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12;
  hours = hours ? hours : 12;
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} ${hours}:${minutes}${ampm}`;
}

// --- 核心逻辑 ---
function processGptJson(jsonContent, fileName, userName, charName) {
  try {
    const gptData = JSON.parse(jsonContent);
    const mapping = gptData.mapping;
    let currentNodeId = gptData.current_node;
    const messages = [];

    // 倒序提取消息链
    while (currentNodeId) {
      const node = mapping[currentNodeId];
      if (node && node.message) {
        const msgData = node.message;
        // 简单的空内容过滤
        if (
          msgData.content &&
          msgData.content.parts &&
          msgData.content.parts.length > 0 &&
          msgData.content.parts[0] !== ""
        ) {
          messages.unshift(msgData);
        }
      }
      currentNodeId = node ? node.parent : null;
    }

    if (messages.length === 0) return null;

    // 获取创建时间
    const createTime =
      gptData.create_time || messages[0].create_time || Date.now() / 1000;

    // 头部信息 (Line 1)
    const header = {
      user_name: userName || "User",
      character_name: charName || "Assistant",
      create_date: formatHumanDate(createTime), // 头部用 Human Readable 比较美观
      chat_metadata: { import_info: "Anima Plugin - GPT Converter" },
    };

    const stLines = [JSON.stringify(header)];

    // 循环处理消息
    messages.forEach((msg) => {
      const role = msg.author.role;
      let content = msg.content.parts.join("\n");
      const msgTime = msg.create_time || createTime;

      // 准备两种时间
      const isoTimeStr = formatIsoDate(msgTime); // 给系统看
      const humanTimeStr = formatHumanDate(msgTime); // 给文本看

      // === 核心修改：将时间戳注入到 mes 内容中 ===
      // 策略：只在 User 消息里加，作为回合开始的标记
      if (role === "user") {
        content = `[${humanTimeStr}]\n${content}`;
      }
      // 如果你也想在 Assistant 消息里加，把下面这行注释解开：
      // else if (role === "assistant") { content = `[${humanTimeStr}]\n${content}`; }

      let stMsg = {
        name: "",
        is_user: false,
        is_system: false,
        send_date: isoTimeStr, // 这里现在使用标准的 ISO 格式
        mes: content, // 这里包含了注入的时间戳文本
        extra: {},
        force_avatar: "",
      };

      if (role === "user") {
        stMsg.name = userName || "User";
        stMsg.is_user = true;
      } else if (role === "assistant") {
        stMsg.name = charName || "Assistant";
        stMsg.is_user = false;
      } else if (role === "system" || role === "tool") {
        stMsg.name = "System";
        stMsg.is_system = true;
        stMsg.mes = role === "tool" ? `(Tool Output)\n${content}` : content;
      }
      stLines.push(JSON.stringify(stMsg));
    });

    const blob = new Blob([stLines.join("\n")], { type: "application/jsonl" });

    // 文件名格式化
    const dateObj = new Date(createTime * 1000);
    const timeStr = `${dateObj.getFullYear()}-${dateObj.getMonth() + 1}-${dateObj.getDate()}`;
    const safeCharName = (charName || "Assistant").replace(
      /[^a-z0-9\u4e00-\u9fa5]/gi,
      "_",
    );
    const outputName = `${safeCharName}_${timeStr}_converted.jsonl`;

    return { blob, fileName: outputName };
  } catch (e) {
    console.error("解析失败:", e);
    return null;
  }
}

// ================= UI 定义 (保持上一版的美化样式) =================

const toolsTemplate = `
    <h2 class="anima-title" style="margin-top: 25px;">
        <i class="fa-solid fa-file-import"></i> GPT 格式转换
    </h2>
    <div class="anima-card">
        <div class="anima-flex-row" style="margin-bottom: 15px; border-bottom: 1px solid var(--anima-border, #444); padding-bottom: 10px;">
            <div class="anima-label-group" style="width: 100%;">
                <span class="anima-desc-inline" style="display:block;">
                    将 ChatGPT JSON 转换为 SillyTavern 格式。
                    <br><i class="fa-solid fa-clock" style="margin-right:5px;"></i>自动将时间戳注入到 User 消息头部。
                </span>
            </div>
        </div>

        <div class="anima-flex-row" style="align-items: center; margin-bottom: 10px;">
            <div class="anima-label-group" style="flex: 1;">
                <span class="anima-label-text">你的名字 (User)</span>
            </div>
            <div style="flex: 1.5;">
                <input type="text" id="anima-tool-username" class="anima-input" 
                       placeholder="User" value="User" style="width: 100%;">
            </div>
        </div>

        <div class="anima-flex-row" style="align-items: center; margin-bottom: 15px;">
            <div class="anima-label-group" style="flex: 1;">
                <span class="anima-label-text">对方名字 (Assistant)</span>
            </div>
            <div style="flex: 1.5;">
                <input type="text" id="anima-tool-charname" class="anima-input" 
                       placeholder="Krist" value="Assistant" style="width: 100%;">
            </div>
        </div>

        <div class="anima-flex-row" style="gap: 10px; margin-top: 20px;">
            <input type="file" id="anima-gpt-upload" accept=".json" multiple style="display: none;">
            
            <button id="anima_btn_upload_json" class="anima-btn" style="flex: 1;">
                <i class="fa-solid fa-upload"></i> 上传文件
            </button>
            
            <button id="anima_btn_convert_json" class="anima-btn" style="flex: 1;" disabled>
                <i class="fa-solid fa-bolt"></i> 开始转换
            </button>
        </div>

        <div id="anima-file-list-container" class="anima-file-list-box"></div>
        
        <div id="anima-list-info" style="margin-top: 5px; font-size: 0.8em; opacity: 0.6; text-align: right; display:none;">
            <i class="fa-solid fa-circle-check"></i> 转换完成后将自动清理列表
        </div>
    </div>
    <h2 class="anima-title" style="margin-top: 25px;">
        <i class="fa-solid fa-terminal"></i> 神经连接日志
    </h2>
    <div class="anima-card">
        <div class="anima-flex-row" style="flex-direction: column; align-items: flex-start; gap: 8px; margin-bottom: 10px;">
          <div class="anima-desc-inline" style="width: 100%;">
             <i class="fa-solid fa-bug"></i> 仅包含 "Anima" 的控制台日志
          </div>
          <div style="display: flex; gap: 10px;">
            <button id="anima_btn_clear_log" class="anima-btn" style="padding: 5px 10px; font-size: 0.8em;">
              <i class="fa-solid fa-trash"></i> 清空
            </button>
            <button id="anima_btn_toggle_log" class="anima-btn" style="padding: 5px 10px; font-size: 0.8em;">
               <i class="fa-solid fa-chevron-down"></i> 展开
            </button>
          </div>
    </div>

        <div id="anima-console-container" style="display: none; background: #1e1e1e; color: #36d19dbc; font-family: 'Consolas', monospace; font-size: 12px; padding: 10px; border-radius: 5px; max-height: 400px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;">
            <div id="anima-log-output">等待日志流接入...</div>
        </div>
        
        <div style="margin-top: 5px; font-size: 0.8em; opacity: 0.5; display: flex; align-items: center;">
             <label class="checkbox_label" style="margin:0;">
                <input type="checkbox" id="anima_log_autoscroll" checked> 自动滚动到底部
            </label>
        </div>
    </div>
`;

export function initToolsSettings() {
  $("#tab-tools").html(toolsTemplate);

  const uploadInput = $("#anima-gpt-upload");
  const listContainer = $("#anima-file-list-container");
  const infoText = $("#anima-list-info");
  const convertBtn = $("#anima_btn_convert_json");
  const uploadBtn = $("#anima_btn_upload_json");

  // 1. 点击“上传”按钮触发 Input
  uploadBtn.on("click", () => {
    uploadInput.click();
  });

  // 2. 监听文件选择
  uploadInput.on("change", function () {
    const files = Array.from(this.files);
    listContainer.empty();

    if (files.length > 0) {
      listContainer.css("display", "block");
      infoText.show();
      convertBtn.prop("disabled", false);
      uploadBtn.html(
        `<i class="fa-solid fa-rotate"></i> 重新选择 (${files.length})`,
      );

      files.forEach((file) => {
        const itemHtml = `
                    <div class="anima-file-item">
                        <i class="fa-solid fa-file-code" style="color: #10b981;"></i>
                        <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                            ${file.name}
                        </span>
                        <span style="opacity:0.6; font-size:0.85em;">${(file.size / 1024).toFixed(1)}KB</span>
                    </div>
                `;
        listContainer.append(itemHtml);
      });
    } else {
      resetState();
    }
  });

  // 3. 执行转换
  convertBtn.on("click", async () => {
    const files = uploadInput[0].files;
    const userName = $("#anima-tool-username").val();
    const charName = $("#anima-tool-charname").val();

    toastr.info(`正在准备转换 ${files.length} 个文件...`);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const reader = new FileReader();

      reader.onload = function (e) {
        const result = processGptJson(
          e.target.result,
          file.name,
          userName,
          charName,
        );
        if (result) {
          const link = document.createElement("a");
          link.href = URL.createObjectURL(result.blob);
          link.download = result.fileName;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(link.href);
        }
      };
      reader.readAsText(file);
    }

    setTimeout(() => {
      toastr.success(`全部转换完成！文件已开始下载。`);
      resetState();
    }, 1500);
  });

  function resetState() {
    uploadInput.val("");
    listContainer.empty().hide();
    infoText.hide();
    convertBtn.prop("disabled", true);
    uploadBtn.html(`<i class="fa-solid fa-upload"></i> 上传文件`);
  }

  // === 新增：日志工具逻辑 ===

  // 1. 启动拦截器 (单例模式，只会运行一次)
  setupLogInterceptor();

  // 2. 展开/收起 按钮逻辑
  const logContainer = $("#anima-console-container");
  const toggleBtn = $("#anima_btn_toggle_log");

  toggleBtn.on("click", () => {
    logContainer.slideToggle(200, function () {
      const isVisible = $(this).is(":visible");
      toggleBtn.html(
        isVisible
          ? `<i class="fa-solid fa-chevron-up"></i> 收起`
          : `<i class="fa-solid fa-chevron-down"></i> 展开`,
      );

      // 修复：展开时，如果勾选了自动滚动，则立刻滚到底部
      if (isVisible && $("#anima_log_autoscroll").is(":checked")) {
        $(this).scrollTop($(this)[0].scrollHeight);
      }
    });
  });

  // 3. 清空按钮逻辑
  $("#anima_btn_clear_log").on("click", () => {
    $("#anima-log-output").empty();
  });
}

// 这里的 Set 用于防止重复拦截
let isConsoleProxied = false;
// 缓存日志，防止切换 Tab 时丢失（可选，视需求而定，这里为了简单直接写 DOM）
const MAX_LOG_LINES = 50;

function setupLogInterceptor() {
  if (isConsoleProxied) return;

  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalInfo = console.info;

  // 通用处理函数
  function processLog(type, args) {
    // 1. 将参数转换为字符串以便检查
    const msgStr = args
      .map((arg) => {
        if (typeof arg === "object") {
          try {
            return JSON.stringify(arg);
          } catch (e) {
            return "[Circular/Object]";
          }
        }
        return String(arg);
      })
      .join(" ");

    // 2. 筛选关键词 (大小写不敏感)
    if (msgStr.toLowerCase().includes("anima")) {
      const outputDiv = $("#anima-log-output");
      if (outputDiv.length > 0) {
        // 构造 HTML
        const time = new Date().toLocaleTimeString();
        let color = "#a3e635"; // 默认绿色
        if (type === "warn") color = "#facc15";
        if (type === "error") color = "#f87171";

        const logHtml =
          `<div style="border-bottom: 1px solid #333; padding: 2px 0;">` +
          `<span style="opacity:0.5; font-size:0.9em;">[${time}]</span> ` +
          `<span style="color:${color};">[${type.toUpperCase()}]</span> ` +
          `${msgStr}` +
          `</div>`;

        if (
          outputDiv.children().length === 0 &&
          outputDiv.text().includes("等待日志流接入")
        ) {
          outputDiv.empty();
        }
        outputDiv.append(logHtml);

        // 限制行数防止卡顿
        if (outputDiv.children().length > MAX_LOG_LINES) {
          outputDiv.children().first().remove();
        }

        // 自动滚动
        if (
          $("#anima_log_autoscroll").is(":checked") &&
          $("#anima-console-container").is(":visible")
        ) {
          const container = $("#anima-console-container");
          // 使用 setTimeout 宏任务，确保 DOM 渲染更新完成再获取高度
          setTimeout(() => {
            container.scrollTop(container[0].scrollHeight);
          }, 0);
        }
      }
    }
  }

  // 代理 console 方法
  console.log = function (...args) {
    originalLog.apply(console, args);
    processLog("log", args);
  };
  console.warn = function (...args) {
    originalWarn.apply(console, args);
    processLog("warn", args);
  };
  console.error = function (...args) {
    originalError.apply(console, args);
    processLog("error", args);
  };
  console.info = function (...args) {
    originalInfo.apply(console, args);
    processLog("info", args);
  };

  isConsoleProxied = true;
  console.log("[Anima] Log Interceptor Attached.");
}
