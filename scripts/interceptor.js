import { queryDual } from "./rag_logic.js";
import {
    updateRagEntry,
    clearRagEntry,
    getLatestRecentSummaries,
    updateKnowledgeEntry,
    clearKnowledgeEntry,
} from "./worldbook_api.js";
import { applyRegexRules } from "./utils.js";
import {
    clearLastRetrievalResult,
    getChatKbFiles,
    getChatRagFiles,
} from "./rag.js";
/**
 * 格式化并排序 RAG 结果 (纯文本版)
 * 仅负责将切片内容拼接，不添加任何硬编码提示词或标签
 */
function formatRAGResults(results) {
    if (!results || results.length === 0) return "";

    // 1. 排序逻辑：先按 Narrative Time (时间线)，再按 Index
    // (保留排序逻辑，这有助于 LLM 理解事件发展的顺序)
    results.sort((a, b) => {
        // A. 先按时间
        const timeA = new Date(a.timestamp || 0).getTime();
        const timeB = new Date(b.timestamp || 0).getTime();
        if (timeA !== timeB) return timeA - timeB;

        // B. 再按 Index (字符串 "Batch_Slice")
        const idxA = String(a.index || "0_0");
        const idxB = String(b.index || "0_0");

        const [batchA, sliceA] = idxA.split("_").map(Number);
        const [batchB, sliceB] = idxB.split("_").map(Number);

        if (isNaN(batchA) || isNaN(batchB)) {
            return idxA.localeCompare(idxB, undefined, { numeric: true });
        }

        if (batchA !== batchB) return batchA - batchB;
        return (sliceA || 0) - (sliceB || 0);
    });

    // 2. 拼接文本
    // 直接返回 item.text，用双换行符分隔，不加 <memory> 标签
    return results.map((item) => item.text).join("\n\n");
}

// ✨ 修改版：构建查询的核心逻辑 (逻辑已同步至与 UI 预览完全一致)
function constructRagQuery(chat, settings) {
    const promptConfig = settings.vector_prompt || [];
    let finalQueryParts = [];

    // 确保 chat 是数组
    if (!Array.isArray(chat)) return "";

    for (const item of promptConfig) {
        // 1. 处理 Context (聊天记录)
        if (item.type === "context") {
            const count = parseInt(item.count) || 5;

            // A. 过滤逻辑
            let filteredChat = chat.filter((msg, idx) => {
                // 跳过被隐藏的消息 (ST 内部逻辑通常已经过滤了 swipe 掉的消息，但 safe check)
                if (msg.is_system) return false;

                // 配置：跳过开场白 (index 0)
                if (settings.skip_layer_zero && idx === 0) return false;

                // 🔴 注意：拦截器里不再直接根据 "exclude_user_msgs" 丢弃消息
                // 而是保留下来，以便由正则逻辑决定是否清洗/保留
                // 如果你确实希望 "exclude_user_msgs" 是彻底丢弃而不是仅跳过正则，请告诉我
                // 按照 UI 逻辑，我们这里保留，由下面处理
                return true;
            });

            // B. 截取最后 N 条
            const slicedChat = filteredChat.slice(-count);

            // C. 格式化 & 正则清洗
            const textBlock = slicedChat
                .map((msg) => {
                    let content = msg.mes; // ST 消息体
                    const isUser = msg.is_user;

                    // 判断是否应用正则 (逻辑同 UI)
                    // 只有当 (不是User) 或者 (是User但没开启跳过) 时，才应用正则
                    const shouldApplyRegex = !(
                        isUser && settings.regex_skip_user
                    );

                    if (
                        shouldApplyRegex &&
                        settings.regex_strings &&
                        settings.regex_strings.length > 0
                    ) {
                        content = applyRegexRules(
                            content,
                            settings.regex_strings,
                        );
                    }

                    // 清洗后如果是空字符串，则忽略该行
                    // 注意：如果 User 跳过正则，原文通常不为空，所以会保留
                    if (!content || content.trim().length === 0) return null;

                    // 拼接格式：Name: Content
                    const rolePrefix = msg.is_user ? "user" : "assistant";
                    return `${rolePrefix}: ${content}`;
                })
                .filter((t) => t !== null) // 过滤掉 null
                .join("\n");

            if (textBlock) {
                finalQueryParts.push(textBlock);
            }
        }
        // 2. 处理 Text (通常是 Instruction 指令)
        // 兼容旧数据 (没有 type 属性的默认为 text)
        else {
            if (item.content && item.content.trim()) {
                finalQueryParts.push(item.content);
            }
        }
    }

    // 将所有部分用换行符拼接
    return finalQueryParts.join("\n\n").trim();
}

export async function initInterceptor() {
    globalThis.Anima_RAG_Interceptor = async function (
        chat,
        contextSize,
        abort,
        type,
    ) {
        // 1. 强制日志
        console.log(`[Anima Debug] Interceptor Called! Type: ${type}`);

        // ⚡ 修复点 1：把 "normal" 加入允许列表
        const allowedTypes = ["chat", "impersonate", "swipe", "normal"];

        if (type && !allowedTypes.includes(type)) {
            console.log(`[Anima Debug] 跳过非聊天类型: ${type}`);
            return;
        }

        const context = SillyTavern.getContext();

        // 获取设置
        const settings = context.extensionSettings["anima_rag"] || {};

        // 检查开关
        if (settings.rag_enabled === false) {
            console.log(
                "[Anima Debug] RAG 开关已关闭 (settings.rag_enabled === false)",
            );
            return;
        }

        const currentChatId = context.chatId;

        // 🔴 修复点：安全访问 chatMetadata，防止崩溃
        // 之前的写法如果 chatMetadata 是 undefined 会直接报错停止
        const extraFiles =
            context.chatMetadata?.["anima_rag_active_files"] || [];

        // 打印一下当前的库信息供调试
        console.log(`[Anima] 当前主库: ${currentChatId}, 附加库:`, extraFiles);

        try {
            // 1. 清理旧状态
            clearLastRetrievalResult();

            // 2. 构建查询文本 (Prompt)
            let queryText = "";
            // 这里的 constructRagQuery 就在 interceptor.js 本文件上方定义，保持原样调用
            queryText = constructRagQuery(chat, settings);

            if (!queryText || queryText.trim().length === 0) {
                console.log("[Anima] 检索文本为空，跳过");
                return;
            }
            console.log(`[Anima] 检索 Query Length: ${queryText.length}`);

            // 3. 获取近期总结 (用于去重)
            const recentCount = settings.injection_settings?.recent_count || 0;
            let recentData = { text: "", ids: [] };

            if (recentCount > 0) {
                recentData = await getLatestRecentSummaries(recentCount);
            }

            // =========================================================
            // 🚀 发起双轨检索 (核心修改)
            // =========================================================

            // A. 获取当前聊天 ID (去除后缀)
            const currentChatId = context.chatId
                ? context.chatId.replace(/\.jsonl?$/i, "")
                : null;

            // B. 获取所有勾选的库文件
            // 注意：这两个函数需要在顶部 import
            const extraChatFiles = getChatRagFiles() || []; // 勾选的“聊天记录”库
            const kbFiles = getChatKbFiles() || []; // 勾选的“知识库”库

            console.log(
                `[Anima] 🚀 发起双轨检索... ChatFiles: ${extraChatFiles.length}, KbFiles: ${kbFiles.length}`,
            );

            // C. 调用 rag_logic.js 中的新函数
            const { chat_results, kb_results } = await queryDual({
                searchText: queryText,
                currentChatId: currentChatId,
                extraChatFiles: extraChatFiles,
                kbFiles: kbFiles,
                excludeIds: recentData.ids, // 排除掉近期总结里已经包含的 ID
            });

            console.log(
                `[Anima] 检索完成. Chat命中: ${chat_results.length}, KB命中: ${kb_results.length}`,
            );

            // =========================================================
            // 📝 处理 Chat 结果 -> 注入到 Chat Memory
            // =========================================================
            // 使用本文件上方的 formatRAGResults 辅助函数进行格式化
            const chatRagText = formatRAGResults(chat_results);

            const injectCfg = settings.injection_settings || {};
            const template = injectCfg.template || "{{rag}}";

            let finalMemoryContent = "";
            const hasRag = chatRagText && chatRagText.trim().length > 0;
            const hasRecent =
                recentData.text && recentData.text.trim().length > 0;

            if (hasRag || hasRecent) {
                // 替换占位符
                finalMemoryContent = template.replace(
                    /\{\{rag\}\}/gi,
                    chatRagText,
                );
                finalMemoryContent = finalMemoryContent.replace(
                    /\{\{recent_history\}\}/gi,
                    recentData.text,
                );
            } else {
                finalMemoryContent = "";
            }

            // 执行注入 (Worldbook API)
            await updateRagEntry(finalMemoryContent, injectCfg);

            // =========================================================
            // 📚 处理 Knowledge 结果 -> 注入到 World Info
            // =========================================================
            if (kb_results.length > 0) {
                // 简单的格式化：[Source: 文件名] \n 内容
                const formattedKbText = kb_results
                    .map((item) => {
                        const sourceName =
                            item.doc_name || item.source || "Unknown Doc";
                        return `[Source: ${sourceName}]\n${item.text}`;
                    })
                    .join("\n\n");

                // 执行注入 (Worldbook API)
                // 注意：这里我们假设 Knowledge 总是常驻或按需，这里简单调用 update
                await updateKnowledgeEntry(formattedKbText);
            } else {
                // 如果没查到，清空条目，防止残留
                await updateKnowledgeEntry("");
            }
        } catch (err) {
            console.error("[Anima Interceptor] Critical Error:", err);
            // 发生严重错误时，清空两个注入区，防止报错信息卡在 Prompt 里
            await clearRagEntry();
            await clearKnowledgeEntry();
        }
    };

    console.log("[Anima] RAG 拦截器已就绪 (调试修复版)");
}
