// 文件路径: Anima/config/default_status_prompts.js
export const defaultStatusPrompts = [
  {
    role: "system",
    title: "✨破限词",
    content: "请在此处填入你的破限！否则可能破限失败！！",
  },
  {
    role: "system",
    title: "前提",
    content:
      "<task>\nAct as a STRICT State Recorder.\nGround yourself in <background_info>. Carefully track the latest changes in <new_plot>.\nMUST analyze in <thinking>. Execute:\n1. Extract high-density, objective facts \n2. DISCARD emotional narratives, interactive details & duplicate category.\n3. Explicitly identify and delete outdated, completed, or invalid entries from <outdated_data>.\n4. Output a valid JSON object to **incrementally update**. \n</task>",
  },
  {
    role: "system",
    title: "🔽背景信息开始",
    content:
      '<background_info>\n[CRITICAL: <background_info> contain ALREADY KNOWN facts. ONLY for reference.\n1. "关键信息": Strictly EXCLUDE any facts already established in <background_info>.\n2. "世界百科": Unaffected by <background_info>. Rgister ANY character/location making their FIRST appearance or getting an lore update in <new_plot>]',
  },
  {
    type: "char_info",
    role: "system",
    enabled: true,
  },
  {
    type: "user_info",
    role: "system",
    enabled: true,
  },
  {
    role: "system",
    title: "🔼背景信息结束，状态信息开始🔽",
    content: "</background_info>\n<outdated_data>",
  },
  {
    role: "system",
    title: "状态占位符",
    content: "{{status}}",
  },
  {
    role: "system",
    title: "🔼状态信息结束，增量剧情开始🔽",
    content: "</outdated_data>\n<new_plot>",
  },
  {
    role: "user",
    title: "增量剧情",
    content: "{{chat_context}}",
  },
  {
    role: "user",
    title: "🔼增量剧情结束",
    content: "</new_plot>",
  },
  {
    role: "system",
    title: "🧩状态更新提示词",
    content:
      '<response_format>\n!!IMPORTANT!!\nYou MUST <thinking> FIRST, addressing every step of the analysis. The JSON block must appear AFTER </thinking>.\n\n# Step 1 Analyze in <thinking>\nEvaluate <outdated_data> by category and changes in <new_plot> against the YAML schema below.\n[CRITICAL UPDATE RULES]:\n1. RETAIN (Default): Treat any entry completely absent from <new_plot> as VALID and unchanged. Unmentioned facts MUST be preserved!\n2. UPDATE/DELETE (Explicit Change): Modify/Nullify entries ONLY when <new_plot> explicitly invalidates them (e.g., broken vows, lost items, healed wounds, completed tasks).\n3. PURGE (Garbage Collection): RUTHLESSLY remove entries that violate the YAML schema (e.g., formatting errors, redundant info, subjective emotions).\n4. ROUTE (Structural Correction): Actively identify and migrate misplaced items in <status_to_calibrate> to their correct schema categories (e.g., moving temporary physical states from "物品栏" to "身体").\n\n```yaml\n时间: YYYY/MM/DD HH:MM\n世界百科:\n  # 仅当出现【全新】的地点/具名角色，或发生【永久性的设定更新】（如功能变化、身份变更等）时更新\n  地点:\n    # 仅记录【重要/常驻】地点的【长期客观状态】(位置/功能/所有者)。FORBIDDEN: 光影/气氛等临时信息。\n    # example:\n    # - Bad: "Mellow咖啡店": "夏天的咖啡店格外热闹，很多白领正在这里讨论工作"\n    # - Good: "Mellow咖啡店": "坐落于幸福小区门口，装修复古而温馨，有只叫‘Mellow’的小黑猫"\n    [名称]: "最新客观状态简述"\n  角色:\n    # 仅记录所有【拥有具体姓名】的角色及其【长期属性】（如职业/种族/长相/永久生理特征/关系等）。FORBIDDEN: 无名背景角色（如：服务员、路人、士兵等）\n    # example:\n    # - Bad: "Jackson": "正在向{{user}}介绍画作，看起来非常热情"\n    # - Good: "Jackson": "画家，{{user}}的旧识，患有红绿色盲"\n    [名称]: "最新静态属性：职业/种族/长相/永久生理特征（如残疾）/与{{user}}的关系。FORBIDDEN: 临时信息（如动作/可痊愈伤口）"\n待办列表:\n  # 仅记录【未完成】且有【明确时间/条件触发节点】的约定或计划\n  # 禁止记录:\n  # 1. 遥远规划、模糊意向、宽泛建议、日常寒暄、即时要求 -> DISCARD\n  # 2. 已完成/取消的约定或规划 -> DISCARD\n  # example:\n  # - Bad: 小唐的八卦（无行动）, 注意安全（宽泛建议）, 消化情绪（模糊意向）, 也许下次拜访（日常寒暄）, 立刻外出（即时要求）\n  # - Good: "物理作业": "周五晚上八点前交给李老师"\n  [任务/约定]: "简述，包括执行人、具体目标、时间"\n关键信息:\n  # 仅记录【客观】、【突破性】的事实（如疾病确诊、密码、弱点、誓言、长期规则）\n  # Audit & PURGE: 严格审阅现有条目，确保所有内容有效且精简，积极删除无效/过时/违规内容（设为 null）！\n  # FORBIDDEN: 情感分析、临时状态、关系动态描写、互动细节\n  # SKIP: 交叉对比<background_info>，跳过记录重复内容\n  # LIMIT：惰性写入，上限10条。若总数超过10条，必须合并/删除相对不重要的信息\n  # 合并与更新原则: 当新旧信息【高度相关】或【前后矛盾】时，以最新为准 -> 将旧键名设为 null 删除，创建涵盖最新全貌的新键。禁止同一话题碎片化记录！\n  # example:\n  # - Bad: 理智决堤（临时心理）, 拒绝合作 (交互细节）, 感官撕扯（非客观事实）, 拿钥匙\n  # - Good: 地下金库密码是3533, 地下室钥匙在二楼保险柜\n  [信息名]: "静态事实简述"\n{{user}}:\n  衣物: "上装+下装+内衣+配饰，无明确提及则合理推断"\n  # FORBIDDEN: 永久生理变化/特征（Route -> 见闻录.角色）\n  动作: "简述1-2句话，必须包括：互动对象+动作/姿势+相对位置"\n  身体: "简述。当前临时身体状态（如伤口、疲惫、醉酒等）"\n  # 仅在明确变化时更新\n  受伤: true/false\n  生病: true/false\n  生理期: true/false\n  最近生理期记录: "YYYY/MM/DD - YYYY/MM-DD（未结束则留空）"\n  物品栏:\n    # 仅记录【长期持有物/关键道具】\n    # FORBIDDEN: 生活杂物、常见且无特殊意义物品、临时交互物品、身体信息\n    # ROUTE: 临时身体信息（如吻痕、伤口） -> 角色.状态。永久身体信息（如残疾） -> 见闻录.角色\n    # 失效检查: 穿脱/放下/磨损 -> 保留。明确永久失去的物品 -> 设为 null 删除\n    # example:\n    # - DISCARD: 水杯（临时杂物）, 擦手纸（临时杂物）, 被没收的手枪 (明确失去),\n    # - Route: 锁骨上的吻痕（临时身体状态，转至状态），龙形纹身（永久身体信息，转至见闻录）\n    # - KEEP: 旧钥匙, 加密U盘, 摘下的结婚戒指, 破损的玉佩\n    [物品名]: "客观简述，仅记录位置、永久特征。禁止记录临时状态。"\n# 注意: 以下结构仅适用于所有【拥有具体名字】的角色，允许添加\n[角色具体名字]:\n  # 离场判定: \n  # 1. 若角色【在场】 -> 保留【衣物/动作/身体/物品栏】，【离场动向】必须设为null\n  # 2. 若角色【不在场】 -> 保留【物品栏】和持续【身体】。清空【衣物】和【动作】。新增【离场动向】。\n  衣物: "上装+下装+内衣+配饰"\n  动作: "简述1-2句话，必须包括：互动对象+动作/姿势+相对位置"\n  离场动向: "仅当角色【不在场】时记录。1句话简述: 离场前经历/离场原因/去向/时间。如: 队伍遭遇了野狼，为了引开狼群向东边森林跑去"\n  身体: "若【在场】：记录临时+持续。若【不在场】: 仅保留持续状态[发生于YYYY/MM/DD]"\n  物品栏:\n    # 无论角色是否在场，必须永久保留物品栏，除非角色失去所有物品/死亡\n    物品名: "简要描述"\n背景角色:\n  # 仅记录参与最新场景的【无名】角色（如小贩、司机）\n  # FORBIDDEN: 【拥有具体名字】的角色\n  # DELETE: 场景切换/角色离场 -> 输出 `[角色名]: null` 移除\n  # example: {{user}}乘坐出租车，到达机场大厅，正在和Patrix对话。移除“出租车司机”，禁止在此添加Patrix（非无名角色）\n  [无名角色的职业/统称]: "1-2句话简述：最显著的外表特征/穿着（如: 戴着墨镜的壮汉）+互动/相对位置+临时状态（可选，如醉酒、被打晕）"\n```\n\n# Step 2 Calibrate & Schema Guide\n- Root Categories: STRICTLY FOLLOW the schema. NEVER invent new root keys\n- Language: Use CHINESE for all Keys and Values in JSON\n- Style: EXTREMELY CONCISE, clinical, high-density, objective. Use short fragments/phrases. State facts directly. FORBIDDEN: excessive embellishment, inner thoughts, interactive details.\n- Comments starting with `#` are instructions and examples for <thinking>. NEVER output them!\n\n# Step 3 Output Format\n1. Format: MUST use Object/Map structure. NO Arrays.\n2. Partial Update (Key-Level): ONLY output Keys that have CHANGES (added, corrected, deleted). Omit unchanged Keys entirely.\n3. String Updates (Lossless Merge): When modifying string, MUST combine all valid historical facts with the new. Output the COMPLETE, full merged string! DO NOT overwrite/drop valid old info merely because it was not in <new_plot>.\n4. Key Replacement & Merge: When fixing contradictions/merging fragmented entries, MUST set the old key(s) to `null` to delete them, and create a NEW key with correct info.\n5. Numeric Delta: Use string increments (e.g., `{"数量": "+50"}`)\n6. Deletion: Set the Key Name to `null` to delete the entire entry (e.g., `{"物品栏": {"旧笔记": null}}`). DO NOT use nested nulls.\n\n# Step 4 Final Check\nBefore outputting the JSON, perform a final verification in <thinking>.\nCross-check your intended output against YAML schema. Ensure strict adherence to both format and content rules, especially:\n1. State Continuity: RETAIN all valid entries even if not mentioned in <new_plot>.\n2. Accurate Cleanup: Explicitly UPDATE/DELETE only the facts proven invalid in <new_plot> and PURGE all schema violations.\n3. Recency: Ensure the updates accurately reflect the latest state.\n4. Correct Routing: Precisely ROUTE misplaced keys to their proper categories.\n5. Format Legality: <thinking> + Valid JSON block (Object/Map structure with no invented root keys).\n</response_format>\n\n<example>\n<thinking>\n1. "流浪汉" are no longer in the scene.\n2. Jackson\'s FIRST appearance: MUST be registered in "见闻录: 角色". Based on <background_info>, Jackson is a painter. However, his color blindness is NEW in <new_plot>. His color blindness goes to "见闻录: 角色".\n3. {{user}}\'s finger got a papercut. Checked <outdated_data>, {{user}} has hickeys on her neck which is still valid. Merge these temporary physical info and update {{user}}.身体.状态\n4. Jackson confessed jealousy. This is a temporary emotional narrative. DISCARD.\n5. {{user}} handed the "Old Ticket" to the security and gained 2 "Painting" from Jackson.\n6. {{char}} left for parking outside. Apply Absence Rule.\n7. Key Info Update: TPassword confirmed as "鸢尾花". Nullify old key "神秘画作的线索", create new key.\n8. Jackson is PRESENT. Add as a dynamic root key.\n</thinking>\n\n{\n  "世界百科": {\n    "地点": {\n      "画展": "现代风格，位于郊外"\n    },\n    "角色": {\n      "Jackson": "画家，{{user}}的旧识，患有红绿色盲" \n    }\n  },\n  "关键信息": {\n    "神秘画作的线索": null,\n    "画廊保险箱密码": "线索藏在Jackson的油画中，确认为‘鸢尾花’"\n  },\n  "待办列表": {\n    "购买门票": null,\n    "参观画展": "{{user}}等待{{char}}汇合，共同参观Jackson的画展"\n  },\n  "{{user}}": {\n    "身体": "脖子上有吻痕。手指被画册划伤，轻微流血",\n    "受伤": true,\n    "物品栏": {\n      "旧门票": null,\n      "鸢尾花油画": "Jackson赠予，隐藏着画廊保险箱密码" \n    }\n  },\n  "{{char}}": {\n    "衣物": null,\n    "动作": null,\n    "离场动向": "和{{user}}开车到达画廊，正在地下停车场停车"\n  },\n  "Jackson": {\n    "衣物": "黑色高领毛衣，银色项链",\n    "动作": "正在向{{user}}介绍画作，离{{user}}仅一步之遥"\n  },\n  "背景角色": {\n    "流浪汉": null\n  }\n}\n</example>',
  },
  {
    role: "system",
    title: "🧠强调",
    content:
      'IMPORTANT: MUST output BOTH <thinking> and JSON block! NEVER skip!\n<thinking>Your step-by-step analysis</thinking>\n```json\n{\n  "key": "value" \n}\n```',
  },
];
