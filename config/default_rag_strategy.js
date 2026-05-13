// 文件路径: Anima/config/default_rag_strategy.js
export const defaultRagStrategy = {
  strategy_settings: {
    important: {
      labels: ["Important"],
      count: 1,
    },
    period: {
      labels: ["Period", "Array"],
      count: 1,
    },
    status: {
      labels: ["Sick", "Injury", "Period"],
      count: 1,
      rules: [
        {
          tag: "Sick",
          path: "Ellina.生病",
          op: "eq",
          value: "true",
        },
        {
          tag: "Injury",
          path: "Ellina.受伤",
          op: "eq",
          value: "true",
        },
        {
          tag: "Period",
          path: "Ellina.生理期",
          op: "eq",
          value: "true",
        },
      ],
    },
    special: {
      count: 1,
    },
    diversity: {
      count: 2,
    },
  },
  holidays: [
    {
      date: "12-25",
      name: "Christmas",
      range_before: 3,
      range_after: 3,
    },
    {
      date: "2-14",
      name: "Valentine",
      range_before: 2,
      range_after: 2,
    },
    {
      date: "1-1",
      name: "NewYear",
      range_before: 3,
      range_after: 3,
    },
    {
      date: "10-31",
      name: "Halloween",
      range_before: 1,
      range_after: 1,
    },
  ],
  period_config: {
    enabled: true,
    events: [],
  },
  distributed_retrieval: true,
  virtual_time_mode: false,
};
