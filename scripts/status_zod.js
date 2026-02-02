import { getStatusSettings } from "./status_logic.js";
import { getContext } from "./status_logic.js";

/**
 * 核心校验函数
 */
export function validateStatusData(newData, oldData) {
    // 1. 获取全局库 (延迟获取，防止加载顺序问题)
    const z = window.z;
    const _ = window._;

    if (!z || !_) {
        console.error("[Anima] 依赖库缺失 (Zod 或 Lodash 未加载)");
        return newData;
    }

    const settings = getStatusSettings();
    const zodConfig = settings.zod_settings || {};

    // 如果没配置任何规则，直接放行
    if (!zodConfig.mode) return newData;

    console.log(`[Anima Zod] 开始校验... 模式: ${zodConfig.mode}`);

    try {
        // ===============================================
        // 模式分流：严格互斥
        // ===============================================
        if (zodConfig.mode === "ui") {
            return validateWithUI(
                newData,
                oldData,
                zodConfig.rules || [],
                z,
                _,
            );
        } else if (zodConfig.mode === "script") {
            return validateWithScript(
                newData,
                oldData,
                zodConfig.script_content,
                z,
                _,
            );
        }
    } catch (error) {
        // 错误处理 (兼容 issues/errors 写法)
        if (error instanceof z.ZodError) {
            const issues = error.issues || error.errors || [];
            if (Array.isArray(issues) && issues.length > 0) {
                const errorMsg = issues
                    .map((e) => `${e.path.join(".")}: ${e.message}`)
                    .join(" | ");
                throw new Error(`校验失败: ${errorMsg}`);
            } else {
                throw new Error(`校验失败: ${error.message}`);
            }
        }
        throw error;
    }

    return newData;
}

/**
 * 模式 A: UI 配置校验 (实现了自动修正 + 宽容类型转换)
 */
function validateWithUI(newData, oldData, rules, z, _) {
    const result = _.cloneDeep(newData);

    rules.forEach((rule) => {
        const path = rule.path;
        if (!path) return;

        let currentValue = _.get(result, path);
        const previousValue = _.get(oldData, path);

        if (currentValue === undefined || currentValue === null) return;

        // -----------------------
        // 类型 1: 数值 (Number)
        // -----------------------
        if (rule.type === "number") {
            // 🟢 修改 1: 使用 z.coerce.number() 允许字符串 "150" 自动转数字
            // 如果转换失败（例如 "abc"），parse 会抛出错误，正好被外层捕获
            let finalValue = z.coerce
                .number({ invalid_type_error: `${path} 必须是有效数字` })
                .parse(currentValue);

            // 更新宽容转换后的值 (防止后续逻辑还在处理字符串)
            if (finalValue !== currentValue) {
                _.set(result, path, finalValue);
                currentValue = finalValue;
            }

            // 1. Delta (变化幅度) 修正
            if (
                typeof previousValue === "number" &&
                rule.delta !== undefined &&
                rule.delta !== null &&
                rule.delta !== ""
            ) {
                const maxDelta = Number(rule.delta);
                const diff = finalValue - previousValue;

                if (Math.abs(diff) > maxDelta) {
                    console.warn(
                        `[Anima Zod] ${path} 幅度修正: 原始变动 ${diff}, 限制 ${maxDelta}`,
                    );
                    const clampedDiff = diff > 0 ? maxDelta : -maxDelta;
                    finalValue = previousValue + clampedDiff;
                }
            }

            // 2. Min/Max (边界) 修正
            const hasMin =
                rule.min !== undefined && rule.min !== null && rule.min !== "";
            const hasMax =
                rule.max !== undefined && rule.max !== null && rule.max !== "";

            if (hasMin || hasMax) {
                const minVal = hasMin ? Number(rule.min) : -Infinity;
                const maxVal = hasMax ? Number(rule.max) : Infinity;

                if (finalValue < minVal || finalValue > maxVal) {
                    console.warn(
                        `[Anima Zod] ${path} 边界修正: 原始 ${finalValue}, 限制 [${minVal}, ${maxVal}]`,
                    );
                    finalValue = _.clamp(finalValue, minVal, maxVal);
                }
            }

            if (finalValue !== currentValue) {
                _.set(result, path, finalValue);
            }
        }

        // -----------------------
        // 类型 2: 文本 (String)
        // -----------------------
        else if (rule.type === "string") {
            // 🟢 修改 2: 允许把数字 123 转成字符串 "123"
            const strVal = z.coerce.string().parse(currentValue);
            _.set(result, path, strVal); // 更新转换后的值

            // 枚举检查
            if (rule.enum) {
                const enumList = rule.enum
                    .split(/[,，]/)
                    .map((s) => s.trim())
                    .filter((s) => s);
                if (enumList.length > 0) {
                    if (!enumList.includes(strVal)) {
                        throw new Error(
                            `${path} 的值 "${strVal}" 不在允许列表内: [${enumList.join(", ")}]`,
                        );
                    }
                }
            }
        }

        // -----------------------
        // 类型 3: 布尔 (Boolean)
        // -----------------------
        else if (rule.type === "boolean") {
            // 🟢 修改 3: 允许 "true"/"false" 字符串转布尔
            const boolVal = z.coerce.boolean().parse(currentValue);
            _.set(result, path, boolVal);
        }
    });

    return result;
}

/**
 * 模式 B: 脚本校验 (完全信赖用户代码)
 * 修改说明：注入了 utils 工具箱，让脚本可以使用 autoNum
 */
function validateWithScript(newData, oldData, scriptContent, z, _) {
    if (!scriptContent || !scriptContent.trim()) return newData;

    // ============== 新增开始: 定义工具箱 ==============
    const utils = {
        // 1. 快捷取旧值
        val: (path, def) => _.get(oldData, path, def),

        // 2. 快捷取全局变量
        getVar: (name) => {
            if (window.TavernHelper && window.TavernHelper.getVariable) {
                return window.TavernHelper.getVariable(name);
            }
            return null;
        },

        // 3. 核心: 自动数值修补器
        autoNum: (path, opts) => createAutoNumberSchema(path, opts, oldData, _),
    };
    // ============== 新增结束 ==============

    // 修改点：在 new Function 的参数里加上 "utils"
    const createSchema = new Function(
        "z",
        "_",
        "oldData",
        "utils",
        scriptContent,
    );

    // 修改点：执行时把 utils 对象传进去
    const userSchema = createSchema(z, _, oldData, utils);

    if (!userSchema || typeof userSchema.parse !== "function") {
        throw new Error("自定义脚本必须返回一个有效的 Zod Schema");
    }

    return userSchema.parse(newData);
}

/**
 * 辅助函数: 自动数值构建器
 * 实现了: 字符串转数字("+10") + Delta限制 + Range限制
 */
export function createAutoNumberSchema(path, options, oldData, _) {
    const rawOld = _.get(oldData, path);
    // 确保旧值安全，默认为 0
    const safeOldValue =
        typeof rawOld === "number" && !isNaN(rawOld)
            ? rawOld
            : options.fallback || 0;

    // 1. 预处理 (Preprocess): 处理字符串和相对值
    const preprocessor = (val) => {
        if (typeof val === "string") {
            const trimmed = val.trim();
            // 处理 "+50", "-20"
            if (trimmed.startsWith("+") || trimmed.startsWith("-")) {
                const delta = Number(trimmed);
                return isNaN(delta) ? val : safeOldValue + delta;
            }
            // 处理 "100"
            const parsed = Number(trimmed);
            return isNaN(parsed) ? val : parsed;
        }
        return val;
    };

    // 2. 转换与修补 (Transform)
    const transformer = (val) => {
        let finalVal = val;
        const { min, max, maxDelta } = options || {};
        const priority = options.priority || "delta"; // 默认优先限制幅度

        if (priority === "delta") {
            // 先限制变化幅度
            if (maxDelta !== undefined) {
                const diff = finalVal - safeOldValue;
                if (Math.abs(diff) > maxDelta) {
                    const clampedDiff = diff > 0 ? maxDelta : -maxDelta;
                    finalVal = safeOldValue + clampedDiff;
                }
            }
            // 再限制绝对边界
            if (min !== undefined) finalVal = Math.max(finalVal, min);
            if (max !== undefined) finalVal = Math.min(finalVal, max);
        } else {
            // 先限制绝对边界 (Range优先)
            if (min !== undefined) finalVal = Math.max(finalVal, min);
            if (max !== undefined) finalVal = Math.min(finalVal, max);
            // 再限制变化幅度
            if (maxDelta !== undefined) {
                const diff = finalVal - safeOldValue;
                if (Math.abs(diff) > maxDelta) {
                    const clampedDiff = diff > 0 ? maxDelta : -maxDelta;
                    finalVal = safeOldValue + clampedDiff;
                }
            }
        }
        return finalVal;
    };

    return window.z.preprocess(
        preprocessor,
        window.z.number().transform(transformer),
    );
}
