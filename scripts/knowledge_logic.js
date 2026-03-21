import { getAnimaConfig } from "./api.js";
import { callBackend } from "./db_api.js"; // 🟢 复用底层请求函数

// ==========================================
// 🧠 知识库核心逻辑 (knowledge_logic.js)
// ==========================================

// 🟢 [从 rag_logic.js 完整移入] 上传知识库文件
export async function uploadKnowledgeBase(file, config) {
  // 🟢 修复：精确提取 rag 配置
  const fullConfig =
    typeof getAnimaConfig === "function" ? getAnimaConfig() : {};
  const apiConfig = fullConfig.api?.rag || {};

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const content = e.target.result;
      try {
        // 组装对接后端 /import_knowledge 的 Payload
        const payload = {
          fileName: file.name,
          fileContent: content,
          settings: {
            delimiter: config.delimiter,
            chunk_size: config.chunk_size,
          },
          apiConfig: apiConfig,
          vectorConfig: {
            enabled: config.write_vector,
          },
          bm25Config: {
            enabled: config.write_bm25,
            dictionary: config.dictContent,
          },
        };

        const response = await callBackend("/import_knowledge", payload);

        resolve(response);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = (err) => reject(err);
    reader.readAsText(file);
  });
}

// 💡 后续你可以在这里继续添加 knowledge.js 里的 TODO 对应的逻辑：
// export async function deleteKnowledgeBase(...) {}
// export async function rebuildBM25(...) {}
