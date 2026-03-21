import { getAnimaConfig } from "./api.js";
import { getEffectiveSettings } from "./rag_logic.js";

const PLUGIN_API_URL = "/api/plugins/anima-rag";

/**
 * 通用函数：调用后端向量插件 (jQuery 版 - 自动处理 CSRF)
 * @param {string} endpoint - 后端路由，例如 "/insert" 或 "/query"
 * @param {object} payload - 发送的数据
 */
export async function callBackend(endpoint, payload, method = "POST") {
  const settings = getAnimaConfig();
  const apiCredentials = settings?.api?.rag || settings?.rag || {};

  // 🔍 调试日志：看看它到底读到了哪里 (修复后可注释掉)
  // console.log("[Anima Debug] Config Source:", settings?.api?.rag ? "New (api.rag)" : "Old (rag)", apiCredentials);

  if (method === "POST" && (!apiCredentials.key || !apiCredentials.model)) {
    const errMsg = "缺少 API Key 或 Model 配置，请先在设置面板填写！";
    console.error(`[Anima Debug] ❌ 前端拦截: ${errMsg}`, apiCredentials);
    // 强制弹窗
    if (window.toastr) toastr.error(errMsg, "Anima API 拦截");
    throw new Error(errMsg);
  }

  const requestBody = {
    ...payload,
    apiConfig: {
      source: apiCredentials.source,
      url: apiCredentials.url,
      key: apiCredentials.key,
      model: apiCredentials.model,
    },
  };

  return new Promise((resolve, reject) => {
    $.ajax({
      url: `${PLUGIN_API_URL}${endpoint}`,
      type: method,
      contentType: "application/json",
      data: JSON.stringify(requestBody),
      timeout: 30000, // 🟢 新增：30秒超时机制，防止请求死锁挂起
      success: (data) => {
        resolve(data);
      },
      error: (jqXHR, textStatus, errorThrown) => {
        let errMsg = "未知错误";

        // 🟢 新增：细化网络层面的报错
        if (jqXHR.status === 0) {
          errMsg = "无法连接到后端服务器 (请检查 Node.js 后端是否启动)。";
        } else if (textStatus === "timeout") {
          errMsg = "向量 API 请求超时 (超过30秒)，请检查代理或网络。";
        } else {
          try {
            const errData = JSON.parse(jqXHR.responseText);
            errMsg = errData.message || errData.error || errMsg;
          } catch (e) {
            const rawText = jqXHR.responseText || jqXHR.statusText || "";
            errMsg = rawText
              .replace(/<[^>]*>?/gm, "")
              .trim()
              .replace(/\s+/g, " ")
              .substring(0, 150);
            if (!errMsg) errMsg = `HTTP Error ${jqXHR.status}`;
          }
        }

        console.error(`[Anima Debug] ❌ Backend Error:`, errMsg);
        // 失败直接弹窗
        if (window.toastr) toastr.error(errMsg, "Anima 向量接口报错");
        reject(new Error(errMsg));
      },
    });
  });
}

export async function getAvailableCollections() {
  const settings = getEffectiveSettings();
  if (settings && settings.rag_enabled === false) {
    return []; // 直接返回空数组
  }
  try {
    return await callBackend("/list", {}, "GET");
    // 注意：如果你之前的 callBackend 只支持 POST，
    // 你可能需要简单修改 callBackend 支持 GET，或者这里直接用 $.get
    // 下面是直接用 $.ajax 的写法，或者你修改 callBackend
  } catch (e) {
    console.error("获取列表失败", e);
    return [];
  }
}

// 🟢 新增：物理删除整个 Collection 文件夹
export async function deleteCollection(collectionId) {
  const settings = getEffectiveSettings(); // 获取当前配置
  if (settings && settings.rag_enabled === false) {
    console.warn("[Anima RAG] 总开关已关闭，拦截数据库删除。");
    return { success: false, message: "RAG Disabled" };
  }
  if (!collectionId) return;

  try {
    const response = await callBackend("/delete_collection", {
      collectionId: collectionId,
    });
    console.log(`[Anima Client] 数据库删除响应:`, response);
    return response;
  } catch (err) {
    console.error("[Anima Client] 数据库删除失败:", err);
    if (window.toastr) {
      toastr.error("后端删除失败: " + err.message);
    }
    return { success: false };
  }
}

export function getChatKbFiles() {
  const context = SillyTavern.getContext();
  if (!context.chatId || !context.chatMetadata) return [];
  return context.chatMetadata["anima_kb_active_files"] || [];
}
