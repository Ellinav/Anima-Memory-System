// scripts/api.js

// 1. 定义插件的唯一 ID (非常重要，不要和别的插件重复)
const MODULE_NAME = "anima_memory_system";

// 2. 定义默认配置结构
const defaultSettings = {
  api: {
    llm: {
      source: "openai",
      url: "",
      key: "",
      model: "",
      stream: false,
      temperature: 1.0,
      context_limit: 1000000,
      max_output: 8192,
    },
    status: {
      source: "openai",
      url: "",
      key: "",
      model: "",
      stream: false, // 状态更新通常后台运行，流式非必须，但保持一致性可保留
      temperature: 0.5, // 建议默认低温度，保证格式稳定
      context_limit: 1000000,
      max_output: 8192,
    },
    rag: {
      source: "openai",
      url: "",
      key: "",
      model: "",
      top_k: 5,
      threshold: 0.4,
    },
    rerank: {
      url: "",
      key: "",
      model: "",
      timeout: 15,
    },
  },
};

/**
 * 核心：获取 SillyTavern 的扩展上下文
 * 这里包含了 settings 对象和保存函数
 */
function getStContext() {
  // @ts-ignore
  return window.SillyTavern.getContext();
}

/**
 * 获取当前插件的配置（对外暴露的辅助函数）
 * 如果没有配置，会自动初始化默认值
 */
export function getAnimaConfig() {
  const { extensionSettings } = getStContext();

  // 如果还没存过，初始化默认值
  if (!extensionSettings[MODULE_NAME]) {
    extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
  }

  const settings = extensionSettings[MODULE_NAME];

  // 🟢 确保 api 对象存在
  if (!settings.api) {
    settings.api = structuredClone(defaultSettings.api);
  }

  // 🟢 遍历 defaultSettings.api 来补全缺失字段
  for (const key of Object.keys(defaultSettings.api)) {
    // @ts-ignore
    if (!Object.hasOwn(settings.api, key)) {
      // @ts-ignore
      settings.api[key] = defaultSettings.api[key];
    }
  }

  return settings;
}

/**
 * URL 清洗函数
 */
function processApiUrl(url, provider) {
  if (!url) return "";
  url = url.trim().replace(/\/+$/, "");
  url = url.replace(/0\.0\.0\.0/g, "127.0.0.1");

  if (
    provider !== "google" &&
    !url.includes("/v1") &&
    !url.includes("/chat") &&
    !url.includes("/models")
  ) {
    if (url.split("/").length <= 3) {
      url = url + "/v1";
    }
  }
  return url;
}

/**
 * 初始化 API 面板逻辑
 */
export function initApiSettings() {
  const container = document.getElementById("tab-api");
  if (!container) return;

  // 1. 添加 CSS 样式
  const styles = `
    <style>
        /* ...之前的样式保持不变... */
        .anima-card-title {
            font-size: 1.5em; 
            font-weight: bold;
            margin-bottom: 15px;
            color: var(--smart-text-color, #ccc);
            border-bottom: 2px solid var(--smart-border-color, #444);
            padding-bottom: 5px;
        }
        
        .anima-card-actions {
            display: flex;
            justify-content: flex-end;
            gap: 10px;
            margin-top: 15px;
        }

        /* 布局通用类 */
        .anima-row {
            display: flex;
            gap: 15px; /* 稍微增加间距 */
            align-items: flex-start; /* 顶部对齐，保证 Label 在同一水平线 */
            margin-bottom: 10px;
        }
        .anima-col {
            flex: 1;
            display: flex;
            flex-direction: column;
        }
        .anima-col label {
            font-size: 0.85em;
            margin-bottom: 5px; /* 统一 Label 和控件的间距 */
            opacity: 0.9;
            height: 1.2em; /* 强制 Label 占据相同高度，防止错位 */
            line-height: 1.2em;
        }
        .anima-col input.anima-input {
            width: 100%;
            height: 38px; /* 强制输入框高度 */
            box-sizing: border-box;
        }

        /* === 新增：大号开关样式 (匹配输入框高度) === */
        .anima-switch-large {
            /* 1. 容器设置：占据 38px 高度，与旁边的输入框保持一致 */
            height: 38px; 
            width: 70px;
            display: flex;         /* 🟢 使用 flex */
            align-items: center;   /* 🟢 核心：让内部的轨道在 38px 高度里垂直居中 */
            cursor: pointer;
            margin-top: 12px;
            position: relative;
        }

        .anima-switch-large input {
            display: none; /* 彻底隐藏 input，避免干扰布局 */
        }
        
        /* 轨道 */
       .anima-switch-large .slider {
            position: relative; /* 改为 relative，由 flex 控制位置 */
            width: 100%;
            height: 34px;       /* 🟢 轨道高度：略小于容器(38px)，显得精致 */
            background-color: var(--anima-bg-input, #374151);
            transition: .4s;
            border-radius: 34px; /* 圆角等于高度，形成完美胶囊 */
            border: 1px solid var(--smart-border-color, #6b7280);
            box-sizing: border-box; /* 确保边框计算在内 */
        }
        
        /* 圆钮 (Knob) */
        .anima-switch-large .slider:before {
            position: absolute;
            content: "";
            height: 26px;       /* 🟢 圆钮高度：34px(轨道) - 2px(边框) - 6px(间隙) = 26px */
            width: 26px;
            left: 3px;          /* 左侧间隙 */
            top: 50%;           /* 垂直居中 */
            transform: translateY(-50%); /* 修正偏移 */
            background-color: white;
            transition: .4s;
            border-radius: 50%;
            box-shadow: 0 2px 4px rgba(0,0,0,0.3);
            z-index: 2;
        }

        /* 激活状态：轨道变绿 */
        .anima-switch-large input:checked + .slider {
            background-color: var(--anima-primary, #10b981);
            border-color: var(--anima-primary, #10b981);
        }
        
        /* 激活状态：圆钮移动 */
        .anima-switch-large input:checked + .slider:before {
            /* 移动距离计算：
               轨道宽(70) - 边框(2) - 圆钮宽(26) - 左间隙(3) - 右预留(3) = 36px
            */
            transform: translate(36px, -50%); 
        }

        /* 弹窗等样式 */
        .anima-modal-overlay {
            position: fixed; inset: 0; width: 100vw; height: 100vh;
            background: rgba(0, 0, 0, 0.6);
            display: flex; justify-content: center; align-items: center;
            z-index: 20000; visibility: hidden; opacity: 0;
            transition: opacity 0.2s; backdrop-filter: blur(2px);
        }
        .anima-modal-overlay.active { visibility: visible; opacity: 1; }
        .anima-modal-box {
            background: var(--smart-background, #1f2937);
            border: 1px solid var(--smart-border-color, #444);
            padding: 20px; border-radius: 8px; width: 300px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.5); text-align: center;
        }
        .anima-btn {
            background-color: #982ac4; color: #ffffff; border: none;
            padding: 8px 16px; border-radius: 5px; cursor: pointer; transition: background 0.2s;
        }
        .anima-btn:hover { background-color: #6f218e; }
        .anima-btn.primary { background-color: #10b981; }
        .anima-btn.primary:hover { background-color: #059669; }    
    </style>
    `;

  // 2. 定义弹窗 HTML
  const modalHtml = `
    <div id="anima-model-modal" class="anima-modal-overlay">
        <div class="anima-modal-box">
            <h3>自定义模型名称</h3>
            <input type="text" id="anima-custom-model-input" class="anima-input" placeholder="输入模型ID (e.g. gpt-4)">
            <div style="display: flex; justify-content: flex-end; gap: 10px;">
                <button class="anima-btn" id="anima-modal-cancel">取消</button>
                <button class="anima-btn primary" id="anima-modal-confirm">确认</button>
            </div>
        </div>
    </div>
    `;

  // 3. 组合界面 (添加 status 卡片)
  container.innerHTML = `
        ${styles}
        <h2 class="anima-title">API 连接配置</h2>
        <p class="anima-subtitle">分别配置用于总结、状态更新和向量检索的模型服务。</p>
        
        ${getApiCardHtml("llm", "🧠 总结模型")}
        ${getApiCardHtml("status", "📊 状态模型")}
        ${getApiCardHtml("rag", "📚 向量模型")}
        ${getApiCardHtml("rerank", "⚖️ 重排模型")}
        ${modalHtml} 
    `;

  // 初始化时加载配置
  loadSettingsToUI();

  bindLogic("llm");
  bindLogic("status");
  bindLogic("rag");
  bindLogic("rerank");

  // 初始化弹窗逻辑
  initModalLogic();
}

function getApiCardHtml(type, title) {
  let extraSettingsHtml = "";

  // 默认的 API 类型选择 HTML
  let apiTypeHtml = `
    <label>API 类型</label>
    <select class="anima-select" id="anima-${type}-source">
        <option value="openai">自定义OpenAI</option>
        <option value="google">Google Gemini</option>
    </select>
  `;

  if (type === "llm" || type === "status") {
    extraSettingsHtml = `
        <div class="anima-row">
            <div class="anima-col">
                <label>温度</label>
                <input type="number" class="anima-input" id="anima-${type}-temperature" step="0.1" min="0" max="2" placeholder="${type === "status" ? "0.5" : "1.0"}">
            </div>
            <div class="anima-col">
                <label>上下文</label>
                <input type="number" class="anima-input" id="anima-${type}-context" step="1024" placeholder="32000">
            </div>
            <div class="anima-col">
                <label>最大输出</label>
                <input type="number" class="anima-input" id="anima-${type}-maxout" step="128" placeholder="4096">
            </div>
            <div class="anima-col">
                <label>流式</label>
                <label class="anima-switch-large">
                    <input type="checkbox" id="anima-${type}-stream">
                    <span class="slider round"></span>
                </label>
            </div>
        </div>
        `;
  } else if (type === "rerank") {
    // ⚖️ 重排模型不需要选择 API 类型，隐藏掉
    apiTypeHtml = "";
    extraSettingsHtml = `
        <div class="anima-row">
            <div class="anima-col">
                <label>超时时间 (秒)</label>
                <input type="number" class="anima-input" id="anima-${type}-timeout" step="1" min="1" placeholder="15">
            </div>
        </div>
    `;
  }

  // 为 Rerank 提供更明确的 URL 提示
  let urlLabel =
    type === "rerank"
      ? "Endpoint URL (需包含 /rerank 结尾)"
      : "Endpoint URL (Base URL)";
  let urlPlaceholder =
    type === "rerank"
      ? "例如: https://api.siliconflow.cn/v1/rerank"
      : "https://api.openai.com/v1";

  return `
    <div class="anima-card" data-config-type="${type}">
        <div class="anima-card-title">${title}</div>
        
        ${apiTypeHtml}
        
        <label>${urlLabel}</label>
        <div class="anima-input-group">
            <input type="text" class="anima-input" placeholder="${urlPlaceholder}" id="anima-${type}-url">
        </div>
        
        <label>API Key</label>
        <input type="password" class="anima-input" placeholder="sk-..." id="anima-${type}-key">
        
        <label>选择或输入模型</label>
        <div class="anima-input-group">
            <select class="anima-select" id="anima-${type}-model">
                <option value="" disabled selected>请先连接...</option>
            </select>
            <button class="anima-icon-btn" id="btn-edit-${type}" title="手动填写模型ID">
                <i class="fa-solid fa-plus"></i>
            </button>
        </div>

        ${extraSettingsHtml}

        <div class="anima-card-actions">
             <button class="anima-btn" id="btn-test-${type}" style="margin-right: auto;">
                <i class="fa-solid fa-vial"></i> 测试
             </button>
             <button class="anima-btn" id="btn-connect-${type}">
                <i class="fa-solid fa-plug"></i> 获取模型
            </button>
            <button class="anima-btn primary" id="btn-save-${type}">
                <i class="fa-solid fa-save"></i> 保存
            </button>
        </div>
    </div>
    `;
}

/**
 * 💾 保存逻辑 (升级版：存入 ST 后端)
 */
function saveSettingsFromUI() {
  const { extensionSettings, saveSettingsDebounced } = getStContext();

  const getVal = (id) => {
    const el = /** @type {HTMLInputElement} */ (document.getElementById(id));
    return el?.value || "";
  };
  const getCheck = (id) => {
    const el = /** @type {HTMLInputElement} */ (document.getElementById(id));
    return el?.checked || false;
  };
  // 辅助：转数字，如果为空或无效则返回 undefined (让后续逻辑用默认值)
  const getNum = (id) => {
    const el = /** @type {HTMLInputElement} */ (document.getElementById(id));
    return el?.value ? Number(el.value) : undefined;
  };

  const newApiConfig = {
    llm: {
      source: getVal("anima-llm-source"),
      url: getVal("anima-llm-url"),
      key: getVal("anima-llm-key"),
      model: getVal("anima-llm-model"),
      stream: getCheck("anima-llm-stream"), // 滑块开关
      temperature: getNum("anima-llm-temperature") ?? 1.0,
      context_limit: getNum("anima-llm-context") ?? 64000,
      max_output: getNum("anima-llm-maxout") ?? 8192,
    },
    status: {
      source: getVal("anima-status-source"),
      url: getVal("anima-status-url"),
      key: getVal("anima-status-key"),
      model: getVal("anima-status-model"),
      stream: getCheck("anima-status-stream"),
      temperature: getNum("anima-status-temperature") ?? 0.5,
      context_limit: getNum("anima-status-context") ?? 32000,
      max_output: getNum("anima-status-maxout") ?? 4096,
    },
    rag: {
      source: getVal("anima-rag-source"),
      url: getVal("anima-rag-url"),
      key: getVal("anima-rag-key"),
      model: getVal("anima-rag-model"),
      top_k: extensionSettings[MODULE_NAME]?.rag?.top_k ?? 5,
      threshold: extensionSettings[MODULE_NAME]?.rag?.threshold ?? 0.4,
    },
    rerank: {
      url: getVal("anima-rerank-url"),
      key: getVal("anima-rerank-key"),
      model: getVal("anima-rerank-model"),
      timeout: getNum("anima-rerank-timeout") ?? 15,
    },
  };

  if (!extensionSettings[MODULE_NAME].api) {
    extensionSettings[MODULE_NAME].api = {};
  }

  // 🟢 保存到 .api 下
  // 注意：这里我们读取旧的 rag 配置时，也要从 .api 里读
  const currentRag = extensionSettings[MODULE_NAME].api.rag || {}; // 获取当前已保存的rag以保留 top_k 等

  // 更新 newApiConfig 里的 RAG 额外参数 (top_k/threshold)
  newApiConfig.rag.top_k = currentRag.top_k ?? 5;
  newApiConfig.rag.threshold = currentRag.threshold ?? 0.4;

  // 赋值
  extensionSettings[MODULE_NAME].api.llm = newApiConfig.llm;
  extensionSettings[MODULE_NAME].api.status = newApiConfig.status;
  extensionSettings[MODULE_NAME].api.rag = newApiConfig.rag;
  extensionSettings[MODULE_NAME].api.rerank = newApiConfig.rerank;

  saveSettingsDebounced();

  if (window.toastr) window.toastr.success("配置已保存", "Anima System");
}

/**
 * 📖 读取逻辑 (升级版：从 ST 后端读取)
 */
function loadSettingsToUI() {
  const rootConfig = getAnimaConfig();
  const config = rootConfig.api;
  const setVal = (id, val) => {
    const el = /** @type {HTMLInputElement} */ (document.getElementById(id));
    if (el) el.value = val !== undefined ? val : "";
  };
  const setCheck = (id, val) => {
    const el = /** @type {HTMLInputElement} */ (document.getElementById(id));
    if (el) el.checked = !!val;
  };
  const setModel = (type, val) => {
    if (!val) return;
    const select = document.getElementById(`anima-${type}-model`);
    if (select)
      select.innerHTML = `<option value="${val}" selected>${val}</option>`;
  };

  // LLM 加载
  if (config.llm) {
    setVal("anima-llm-source", config.llm.source);
    setVal("anima-llm-url", config.llm.url);
    setVal("anima-llm-key", config.llm.key);
    setModel("llm", config.llm.model);
    setCheck("anima-llm-stream", config.llm.stream);
    // 新增参数
    setVal("anima-llm-temperature", config.llm.temperature);
    setVal("anima-llm-context", config.llm.context_limit);
    setVal("anima-llm-maxout", config.llm.max_output);
  }
  if (config.status) {
    setVal("anima-status-source", config.status.source);
    setVal("anima-status-url", config.status.url);
    setVal("anima-status-key", config.status.key);
    setModel("status", config.status.model);
    setCheck("anima-status-stream", config.status.stream);
    setVal("anima-status-temperature", config.status.temperature);
    setVal("anima-status-context", config.status.context_limit);
    setVal("anima-status-maxout", config.status.max_output);
  }
  // RAG 加载
  if (config.rag) {
    setVal("anima-rag-source", config.rag.source);
    setVal("anima-rag-url", config.rag.url);
    setVal("anima-rag-key", config.rag.key);
    setModel("rag", config.rag.model);
  }
  if (config.rerank) {
    setVal("anima-rerank-url", config.rerank.url);
    setVal("anima-rerank-key", config.rerank.key);
    setModel("rerank", config.rerank.model);
    setVal("anima-rerank-timeout", config.rerank.timeout);
  }
}

/**
 * 绑定单个卡片的交互逻辑
 */
function bindLogic(type) {
  const btnConnect = /** @type {HTMLButtonElement} */ (
    document.getElementById(`btn-connect-${type}`)
  );
  const btnSave = document.getElementById(`btn-save-${type}`);
  const btnEdit = document.getElementById(`btn-edit-${type}`);
  const btnTest = /** @type {HTMLButtonElement} */ (
    document.getElementById(`btn-test-${type}`)
  );

  const selectModel = /** @type {HTMLSelectElement} */ (
    document.getElementById(`anima-${type}-model`)
  );
  const selectSource = /** @type {HTMLSelectElement} */ (
    document.getElementById(`anima-${type}-source`)
  );
  const inputUrl = /** @type {HTMLInputElement} */ (
    document.getElementById(`anima-${type}-url`)
  );
  const inputKey = /** @type {HTMLInputElement} */ (
    document.getElementById(`anima-${type}-key`)
  );

  // 1. 下拉框变动逻辑
  if (selectSource) {
    selectSource.addEventListener("change", () => {
      // 只有当输入框为空时才自动填充，避免覆盖用户的反代地址
      if (selectSource.value === "google") {
        if (!inputUrl.value)
          inputUrl.value = "https://generativelanguage.googleapis.com";
      } else {
        if (!inputUrl.value) inputUrl.value = "https://api.openai.com/v1";
      }
    });
  }

  // 2. 自定义模型按钮
  if (btnEdit) {
    btnEdit.addEventListener("click", () => {
      openModelModal(type);
    });
  }

  // 3. 保存按钮
  if (btnSave) {
    btnSave.addEventListener("click", () => {
      saveSettingsFromUI();
    });
  }

  if (btnTest) {
    btnTest.addEventListener("click", async () => {
      const currentSource = selectSource ? selectSource.value : "openai";
      const currentUrl = inputUrl.value;
      const currentKey = inputKey.value;
      const currentModel = selectModel.value;

      if (!currentKey) {
        if (window.toastr) window.toastr.warning("请填写 API Key");
        return;
      }

      const originalHtml = btnTest.innerHTML;
      btnTest.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 请求中...`;
      btnTest.disabled = true; // 🟢 VS Code 现在不会报错了

      try {
        // ============================
        // 🟢 分支 A: RAG 模型 (走后端测试)
        // ============================
        if (type === "rerank") {
          // 🟢 分支 C: Rerank 模型 (直接构造虚假切片进行打分测试)
          if (!currentUrl) throw new Error("请填写 Rerank 的 URL");
          const configPayload = {
            model: currentModel || "BAAI/bge-reranker-v2-m3",
            query: "苹果",
            documents: ["红富士", "香蕉", "汽车"], // 测试数据
          };

          const res = await fetch(currentUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${currentKey}`,
            },
            body: JSON.stringify(configPayload),
          });

          if (!res.ok) {
            const errText = await res.text();
            throw new Error(
              `Rerank 报错 (${res.status}): ${errText.substring(0, 100)}`,
            );
          }

          const data = await res.json();
          // 如果返回结构里有 results 数组，说明完全跑通了标准格式
          const firstScore = data.results?.[0]?.relevance_score || "成功获取";
          if (window.toastr)
            window.toastr.success(
              `测试成功! 返回相关性首位得分: ${firstScore}`,
              "Rerank 系统",
            );
          console.log("[Anima] Rerank Test Result:", data);
        } else if (type === "rag") {
          const configPayload = {
            source: currentSource,
            url: currentUrl,
            key: currentKey,
            model: currentModel || "text-embedding-3-small",
          };

          // ✨ 使用 ST 全局的 jQuery 发送请求，它会自动带上 CSRF Token
          const data = await new Promise((resolve, reject) => {
            // @ts-ignore
            $.ajax({
              type: "POST",
              url: "/api/plugins/anima-rag/test_connection",
              data: JSON.stringify({ apiConfig: configPayload }),
              contentType: "application/json",
              success: function (response) {
                resolve(response);
              },
              error: function (jqXHR, textStatus, errorThrown) {
                // 尝试获取后端返回的具体错误信息
                const errMsg =
                  jqXHR.responseText || errorThrown || "连接请求被拒绝";
                reject(new Error(errMsg));
              },
            });
          });

          // 成功后的处理逻辑保持不变
          if (window.toastr)
            window.toastr.success(data.message, "RAG 连接成功");
          console.log("[Anima] RAG Test Result:", data);
        }

        // ============================
        // 🟢 分支 B: LLM / Status 模型 (走 generateText)
        // ============================
        else {
          const tempConfig = {
            source: currentSource,
            url: currentUrl,
            key: currentKey,
            model: currentModel,
            stream: false,
            temperature: 0.5,
            max_output: 2000, // 测试只需要很少的字
          };

          const testPrompt = [{ role: "user", content: "Hi" }];

          // 调用 generateText
          const reply = await generateText(testPrompt, type, tempConfig);

          if (window.toastr) {
            const shortReply =
              reply.length > 30 ? reply.substring(0, 30) + "..." : reply;
            window.toastr.success(
              `连接成功！回复: ${shortReply}`,
              "Anima System",
            );
          }
        }
      } catch (e) {
        console.error(`[Anima] Test Failed:`, e);
        let errorMsg = e.message || "未知错误";
        // 简单美化一下常见错误
        if (errorMsg.includes("401")) errorMsg = "401 鉴权失败 (请检查 Key)";
        if (errorMsg.includes("404")) errorMsg = "404 路径错误 (请检查 URL)";
        if (errorMsg.includes("400"))
          errorMsg = "400 请求参数错误 (请检查模型名)";

        if (window.toastr)
          window.toastr.error(`连接失败: ${errorMsg}`, "Anima System");
      } finally {
        btnTest.innerHTML = originalHtml;
        btnTest.disabled = false;
      }
    });
  }

  // 4. 连接按钮逻辑 (已修复 Google 反代支持)
  if (btnConnect) {
    btnConnect.addEventListener("click", async () => {
      const source = selectSource ? selectSource.value : "openai";
      let url = inputUrl.value;
      const key = inputKey.value;

      if (!key) {
        if (window.toastr) window.toastr.warning("请填写 API Key");
        return;
      }

      const originalHtml = btnConnect.innerHTML;
      btnConnect.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 连接中...`;
      btnConnect.disabled = true;

      try {
        let models = [];

        if (source === "google") {
          // === Google 连接逻辑 (支持反代) ===
          const isCustomUrl = url && !url.includes("googleapis.com");
          let fetchUrl;
          /** @type {Record<string, string>} */
          let headers = {};

          if (isCustomUrl) {
            // 反代模式：通常是 Bearer Token，路径需要适配
            // 尝试获取模型列表的通用路径
            let baseUrl = url.trim().replace(/\/+$/, "");
            // 如果用户填的是 /v1beta/models/... 这种深层路径，尝试截取
            // 这里做一个简单的假设：反代地址通常支持 /v1beta/models
            if (!baseUrl.endsWith("/models")) {
              baseUrl = `${baseUrl}/v1beta/models`;
            }
            fetchUrl = baseUrl;
            headers = { Authorization: `Bearer ${key}` };
          } else {
            // 官方直连模式
            fetchUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
          }

          const res = await fetch(fetchUrl, { headers });

          if (!res.ok) {
            const errText = await res.text();
            throw new Error(
              `Google 连接失败 (${res.status}): ${errText.substring(0, 50)}`,
            );
          }

          const data = await res.json();
          if (data.models) {
            models = data.models.map((m) => m.name.replace("models/", ""));
          }
        } else {
          // === OpenAI/通用 连接逻辑 (严格模式：不使用保底列表) ===
          let modelsFetchUrl = url;
          if (type === "rerank") {
            // 针对 rerank：原 url 通常以 /rerank 结尾。为了获取模型列表，我们退回到 base URL
            // 例如 https://api.siliconflow.cn/v1/rerank -> https://api.siliconflow.cn/v1
            modelsFetchUrl =
              url.replace(/\/rerank\/?$/, "").replace(/\/v1\/?$/, "") + "/v1";
            // 注意：这里不要覆盖 inputUrl.value，保留用户输入的完整 rerank url 供保存
          } else {
            url = processApiUrl(url, source);
            inputUrl.value = url;
            modelsFetchUrl = url;
          }

          try {
            // 1. 尝试直接从浏览器 Fetch (直连)
            const directResponse = await fetch(`${modelsFetchUrl}/models`, {
              method: "GET",
              headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
              },
            });

            if (directResponse.ok) {
              const data = await directResponse.json();
              if (data.data && Array.isArray(data.data)) {
                models = data.data.map((m) => m.id);
              } else if (Array.isArray(data)) {
                models = data.map((m) => m.id);
              }
            } else {
              throw new Error("直连请求未成功"); // 抛出异常去触发下方的 catch，走代理尝试
            }
          } catch (err) {
            console.warn("[Anima] 直连失败，尝试 ST 后端代理:", err);

            // 2. 如果直连失败，回退到 ST 后端代理
            // @ts-ignore
            const response = await $.ajax({
              url: "/api/backends/chat-completions/status",
              type: "POST",
              contentType: "application/json",
              data: JSON.stringify({
                chat_completion_source: "custom",
                custom_url: modelsFetchUrl,
                reverse_proxy: modelsFetchUrl,
                proxy_password: key,
                custom_include_headers: "",
              }),
            });
            const data = response;
            if (Array.isArray(data)) models = data.map((m) => m.id);
            else if (data.data && Array.isArray(data.data))
              models = data.data.map((m) => m.id);

            // 🔥 核心修改：如果代理也没拿到数据，不要给默认值，直接报错！
            if (!models || models.length === 0) {
              throw new Error("连接失败：无法获取模型列表，请检查 URL 和 Key");
            }
          }
        }

        if (models.length > 0) {
          if (window.toastr) window.toastr.success("连接成功");
          selectModel.innerHTML = "";
          models.forEach((m) => {
            const opt = document.createElement("option");
            opt.value = m;
            opt.innerText = m;
            selectModel.appendChild(opt);
          });
          selectModel.value = models[0];
        }
      } catch (/** @type {any} */ e) {
        console.error(e);
        let errorMsg = e.message;
        if (e.status === 403) errorMsg = "403 Forbidden: 检查 Key 或白名单";
        else if (e.responseText) errorMsg = `错误: ${e.status}`;
        if (window.toastr) window.toastr.error(errorMsg);
      } finally {
        btnConnect.innerHTML = originalHtml;
        btnConnect.disabled = false;
      }
    });
  }
}
let currentEditType = null; // 用于记录当前正在编辑哪个卡片(llm 或 rag)

function initModalLogic() {
  const overlay = document.getElementById("anima-model-modal");
  const input = /** @type {HTMLInputElement} */ (
    document.getElementById("anima-custom-model-input")
  );
  const btnCancel = document.getElementById("anima-modal-cancel");
  const btnConfirm = document.getElementById("anima-modal-confirm");

  if (!overlay) return;

  // 隐藏弹窗函数
  const closeModal = () => {
    overlay.classList.remove("active");
    if (input) input.value = "";
    currentEditType = null;
  };

  // 取消点击
  btnCancel.addEventListener("click", closeModal);

  // 点击背景关闭
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });

  // 确认点击
  btnConfirm.addEventListener("click", () => {
    const val = input.value.trim();
    if (val && currentEditType) {
      const selectModel = /** @type {HTMLSelectElement} */ (
        document.getElementById(`anima-${currentEditType}-model`)
      );
      if (selectModel) {
        // 添加选项并选中
        const opt = document.createElement("option");
        opt.value = val;
        opt.innerText = val + " (自定义)";
        opt.selected = true;
        selectModel.appendChild(opt);
        selectModel.value = val;
      }
    }
    closeModal();
  });
}

// 辅助函数：打开弹窗
function openModelModal(type) {
  currentEditType = type;
  const overlay = document.getElementById("anima-model-modal");
  if (overlay) overlay.classList.add("active");
  // 自动聚焦输入框
  setTimeout(
    () => document.getElementById("anima-custom-model-input")?.focus(),
    100,
  );
}

/**
 * 🚀 核心功能：发送请求生成文本 (最终修正版)
 * 遵循原则：
 * 1. 外部直连 (Google) -> 使用 fetch，支持反代，兼容多种返回格式
 * 2. 内部转发 (OpenAI/ST) -> 使用 $.ajax，自动处理 CSRF，手动处理流式数据防止 502
 */
export async function generateText(
  promptOrMessages,
  purpose = "llm",
  overrideConfig = null,
) {
  const config = overrideConfig || getAnimaConfig().api[purpose];
  if (!config || !config.key) {
    if (config.source !== "openai" && config.source !== "google") {
      // 允许无 key
    } else {
      throw new Error(`未配置 ${purpose.toUpperCase()} 的 API Key`);
    }
  }

  const { source, key, model, stream } = config;
  let { url } = config;
  if (key && /[^\x20-\x7E]/.test(key)) {
    throw new Error(
      "API Key 包含非法字符（如中文标点或全角空格），请重新检查！",
    );
  }
  if (url && /[^\x20-\x7E]/.test(url)) {
    throw new Error(
      "API URL 包含非法字符（如中文标点或全角空格），请重新检查！",
    );
  }
  // 获取高级参数 (赋予默认值以防万一)
  const temperature = Number(config.temperature ?? 1.0);
  const maxOutput = Number(config.max_output ?? 8192);

  // 🔥【关键修改 1】标准化数据格式
  // 无论传进来是字符串还是数组，统一转成数组处理
  let messages = [];
  if (typeof promptOrMessages === "string") {
    messages = [{ role: "user", content: promptOrMessages }];
  } else {
    messages = promptOrMessages; // 直接使用传入的数组
  }

  // ============================================================
  // 1. Google Gemini 处理逻辑
  // ============================================================
  if (source === "google") {
    let targetUrl;
    const headers = { "Content-Type": "application/json" };
    const isCustomUrl = url && !url.includes("googleapis.com");

    // 第一步：将所有角色映射为 user 或 model
    const rawGoogleContents = messages.map((msg) => {
      let gRole = "user";
      if (msg.role === "assistant") {
        gRole = "model"; // AI 回复映射为 model
      } else if (msg.role === "system") {
        gRole = "user"; // System 映射为 user
      } else {
        gRole = "user"; // User 保持 user
      }
      return {
        role: gRole,
        parts: [{ text: msg.content }],
      };
    });

    // 🔥【关键修改 2】第二步：强制合并相邻的同角色消息 (满足 Gemini 强制交替规则)
    const googleContents = [];
    rawGoogleContents.forEach((curr) => {
      if (
        googleContents.length > 0 &&
        googleContents[googleContents.length - 1].role === curr.role
      ) {
        // 如果当前角色和上一个角色相同，直接把文本用双换行拼接在一起
        googleContents[googleContents.length - 1].parts[0].text +=
          "\n\n" + curr.parts[0].text;
      } else {
        // 否则作为一个新的消息块推入数组
        googleContents.push(curr);
      }
    });

    // 构造请求体
    const requestBody = {
      contents: googleContents,
      safetySettings: [
        {
          category: "HARM_CATEGORY_HARASSMENT",
          threshold: "BLOCK_NONE",
        },
        {
          category: "HARM_CATEGORY_HATE_SPEECH",
          threshold: "BLOCK_NONE",
        },
        {
          category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
          threshold: "BLOCK_NONE",
        },
        {
          category: "HARM_CATEGORY_DANGEROUS_CONTENT",
          threshold: "BLOCK_NONE",
        },
        {
          category: "HARM_CATEGORY_CIVIC_INTEGRITY",
          threshold: "BLOCK_NONE",
        },
      ],
      generationConfig: {
        temperature: temperature, // ✅ 应用温度
        topP: 0.98,
        topK: 60,
        maxOutputTokens: maxOutput, // ✅ 应用最大输出
      },
    };

    // 确定 Endpoint：流式 vs 非流式
    const methodAction = stream ? "streamGenerateContent" : "generateContent";

    if (isCustomUrl) {
      let baseUrl = url.trim().replace(/\/+$/, "");
      if (
        !baseUrl.includes("/models") &&
        !baseUrl.includes("/generateContent")
      ) {
        baseUrl = `${baseUrl}/v1beta/models/${model}:${methodAction}`;
      } else {
        // 如果用户填了 ...:generateContent，我们尝试根据开关替换成 ...:streamGenerateContent
        if (stream)
          baseUrl = baseUrl.replace(
            ":generateContent",
            ":streamGenerateContent",
          );
        else
          baseUrl = baseUrl.replace(
            ":streamGenerateContent",
            ":generateContent",
          );
      }
      targetUrl = baseUrl;
      headers["Authorization"] = `Bearer ${key}`;
    } else {
      targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${methodAction}?key=${key}`;
    }

    // 🔴 [DEBUG] 打印 Google 请求日志
    console.log(
      `[Anima Debug] Google Request:`,
      JSON.parse(JSON.stringify({ url: targetUrl, body: requestBody })),
    );

    try {
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        let errorMsg = response.statusText;
        try {
          const errData = await response.json();
          errorMsg = errData.error?.message || JSON.stringify(errData);
        } catch (e) {}
        throw new Error(`Google API Error (${response.status}): ${errorMsg}`);
      }

      const data = await response.json();
      console.log("[Anima Debug] Google Raw Response:", data);

      // 解析响应
      let text = "";

      if (stream) {
        if (Array.isArray(data)) {
          data.forEach((chunk) => {
            const chunkText = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
            if (chunkText) text += chunkText;
          });
        } else {
          text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        }
      } else {
        text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text)
          text = data.choices?.[0]?.message?.content || data.choices?.[0]?.text;
      }

      if (!text) {
        console.warn("[Anima] Google 响应解析为空，原始数据:", data);
        throw new Error("API 返回结构未知");
      }

      return text;
    } catch (error) {
      throw error;
    }
  }

  // ============================================================
  // 2. 通用/OpenAI Compatible (浏览器直连模式 - 彻底解决 Auth 问题)
  // ============================================================
  else {
    let conversationStarted = false;
    // 1. 消息格式清洗
    messages = messages.map((msg, index) => {
      if (msg.role === "user" || msg.role === "assistant") {
        conversationStarted = true;
      }
      if (msg.role === "system") {
        if (index > 0 || conversationStarted) {
          return { ...msg, role: "user" };
        }
      }
      return msg;
    });

    // 2. URL 构造
    // processApiUrl 会自动处理 /v1 后缀
    let targetUrl = processApiUrl(url, source);
    // 防御性清理：去掉末尾的 /chat/completions 或 /，我们下面手动加
    targetUrl = targetUrl
      .replace(/\/chat\/completions\/?$/, "")
      .replace(/\/+$/, "");

    const endpoint = `${targetUrl}/chat/completions`;

    // 3. 构造请求体
    const requestBody = {
      model: model,
      messages: messages,
      temperature: temperature,
      max_tokens: maxOutput, // OpenAI 标准参数
      top_p: 1,
      stream: !!stream, // 根据开关决定是否流式
    };

    // 4. 发起原生 Fetch 请求
    console.log(`[Anima Debug] Direct Fetch to: ${endpoint}`, requestBody);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`, // 🔥 直接发送 Key，ST 无法干预
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errText = await response.text();
        let errMsg = errText;

        // 尝试解析厂商返回的详细 JSON 错误
        try {
          const errJson = JSON.parse(errText);
          if (errJson.error && errJson.error.message) {
            errMsg = errJson.error.message;
          } else if (errJson.message) {
            errMsg = errJson.message;
          }
        } catch (e) {}

        // 抛出带有状态码的错误，这样 toastr 就能显示 "401: Invalid Key"
        throw new Error(
          `API Error (${response.status}): ${errMsg.substring(0, 100)}`,
        );
      }

      // ==========================================
      // 响应解析 (兼容流式和非流式)
      // ==========================================

      // A. 非流式
      if (!stream) {
        const data = await response.json();

        // 🔥【新增】优先检查厂商返回的错误信息
        // 很多中转站或 API 会返回 200 OK 但 body 里包含 error
        if (data.error) {
          console.error("[Anima] API Error Details:", data.error);
          const errorMsg =
            data.error.message || data.error.code || JSON.stringify(data.error);
          throw new Error(`API 业务错误: ${errorMsg}`);
        }

        const choice = data.choices?.[0];
        const message = choice?.message;

        // 优先取 content；如果为空，尝试取 reasoning_content（防止因 max_tokens 截断导致报错）；最后尝试 text
        const content =
          message?.content || message?.reasoning_content || choice?.text;

        // 🔥 2. HTTP 200 但内容为空的处理
        if (!content) {
          console.warn(
            "[Anima] Empty Content. Full Response:",
            JSON.stringify(data, null, 2),
          );

          // [细化错误提示]
          let extraHint = "";
          // 检测是不是 Gemini 模型
          if (model.toLowerCase().includes("gemini")) {
            extraHint =
              " 检测到 Gemini 模型且内容为空，这通常是因为 OpenAI 格式没有 Safety Settings 导致破限失败。如API支持，请尝试切换为 'Google Gemini' 格式。";
          }

          const finalErrorMsg = "模型返回内容为空。" + extraHint;

          // ✅【新增】强制弹窗：不管调用方怎么处理，先弹个窗告诉用户
          if (window.toastr) {
            // timeOut: 0 表示不自动消失（或者是设置长一点时间），让用户看清楚
            window.toastr.error(finalErrorMsg, "Anima Critical Error");
          }

          // 继续抛出错误，中断后续逻辑
          throw new Error(finalErrorMsg);
        }
        return content;
      }

      // B. 流式解析 (SSE)
      // 即使是 summary 任务通常等待结果，我们也要正确消耗流
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let fullText = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // 解码当前块并追加到缓冲区
        buffer += decoder.decode(value, { stream: true });

        // 按行分割处理
        const lines = buffer.split("\n");
        // 数组最后一行可能不完整，留到下一次处理
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ")) {
            const jsonStr = trimmed.slice(6);
            if (jsonStr === "[DONE]") continue;
            try {
              const json = JSON.parse(jsonStr);
              const content =
                json.choices?.[0]?.delta?.content ||
                json.choices?.[0]?.text ||
                json.content;
              if (content) fullText += content;
            } catch (e) {
              // 忽略解析错误的帧
            }
          }
        }
      }

      if (!fullText) throw new Error("流式传输完成，但未收到有效内容");
      return fullText;
    } catch (error) {
      console.error("[Anima] Direct API Error Details:", error);
      throw error;
    }
  }
}
