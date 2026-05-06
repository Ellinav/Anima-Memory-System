// scripts/regex_ui.js

/**
 * 通用正则列表组件
 * 负责渲染列表、处理行内编辑、删除和排序
 */
export class RegexListComponent {
  /**
   * @param {string} containerId - 容器的 DOM ID (不带 #)
   * @param {Function} getData - 获取当前数据数组的函数 () => Array
   * @param {Function} onSave - 数据变更后的回调函数 (newData) => void
   */
  constructor(containerId, getData, onSave) {
    this.containerId = containerId;
    this.getData = getData; // 必须是函数，确保获取最新引用
    this.onSave = onSave; // 保存回调
    this.$container = $(`#${containerId}`);
  }

  /**
   * 主渲染方法
   */
  render() {
    const listEl = this.$container;
    const dataList = this.getData();
    listEl.empty();

    if (!dataList || dataList.length === 0) {
      listEl.html(
        `<div style="text-align:center; color:#666; font-size:12px; padding:10px;">暂无规则</div>`,
      );
      return;
    }

    dataList.forEach((item, index) => {
      const isExclude = item.type === "exclude";
      const typeBadge = isExclude
        ? `<span class="anima-tag danger">排除</span>`
        : `<span class="anima-tag primary">提取</span>`;

      const isEnabled = item.enabled !== false; // 兼容旧数据，未定义默认视为开启

      const $row = $(`
          <div class="anima-regex-item is-row" data-idx="${index}">
              <div class="view-mode" style="display:flex; align-items:center; width:100%; gap:10px;">
                  <i class="fa-solid fa-bars anima-drag-handle" style="cursor: grab; color: #888;"></i>
                  
                  <div style="width: 50px; text-align: center; flex-shrink: 0;">
                      ${typeBadge}
                  </div>

                  <span class="regex-text" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:monospace; color:#ccc; ${!isEnabled ? "text-decoration: line-through; opacity: 0.5;" : ""}">
                      ${this.escapeHtml(item.regex)}
                  </span>
                  
                  <div style="display:flex; gap:8px; align-items:center; flex-shrink:0;">
                      <label class="anima-switch" title="启用/禁用" style="margin: 0; flex: 0 0 44px; width: 44px; min-width: 44px;">
                          <input type="checkbox" class="regex-toggle" ${isEnabled ? "checked" : ""}>
                          <span class="anima-slider round"></span>
                      </label>

                      <div style="display:flex; gap:5px; flex-shrink: 0;">
                          <button class="anima-btn secondary small btn-edit" title="编辑"><i class="fa-solid fa-pen"></i></button>
                          <button class="anima-btn danger small btn-del" title="删除"><i class="fa-solid fa-trash"></i></button>
                      </div>
                  </div>
              </div>
              
              <div class="edit-mode" style="display:none; align-items:center; width:100%; gap:5px;">
                  <select class="anima-select edit-type" style="width:80px; margin:0; flex-shrink:0;">
                      <option value="extract">提取</option>
                      <option value="exclude">排除</option>
                  </select>
                  <input type="text" class="anima-input edit-input" value="${this.escapeHtml(item.regex)}" style="margin:0; flex:1;">
                  <button class="anima-btn primary small btn-save"><i class="fa-solid fa-check"></i></button>
                  <button class="anima-btn secondary small btn-cancel"><i class="fa-solid fa-xmark"></i></button>
              </div>
          </div>
          `);

      this._bindItemEvents($row, index, item);
      listEl.append($row);
    });

    this._initSortable();
  }

  /**
   * 绑定单行事件 (内部使用)
   */
  _bindItemEvents($row, index, item) {
    $row.find(".regex-toggle").on("change", (e) => {
      const list = this.getData();
      // 获取当前勾选状态并保存
      list[index].enabled = $(e.target).prop("checked");
      this.onSave(list);
      // 重新渲染，以刷新样式 (比如被禁用时的文本删除线)
      this.render();
    });

    // 1. 删除
    $row.find(".btn-del").on("click", () => {
      if (confirm("确定删除此规则吗？")) {
        const list = this.getData();
        list.splice(index, 1);
        this.onSave(list); // 通知外部保存
        this.render();
      }
    });

    // 2. 进入编辑
    $row.find(".btn-edit").on("click", () => {
      $row.find(".view-mode").hide();
      $row.find(".edit-mode").css("display", "flex");
      $row.find(".edit-type").val(item.type);
    });

    // 3. 取消编辑
    $row.find(".btn-cancel").on("click", () => {
      $row.find(".edit-mode").hide();
      $row.find(".view-mode").css("display", "flex");
      // 重置输入框内容防止脏数据残留
      $row.find(".edit-input").val(item.regex);
    });

    // 4. 保存编辑
    $row.find(".btn-save").on("click", () => {
      const newType = $row.find(".edit-type").val();
      const newStr = $row.find(".edit-input").val();

      if (!newStr.trim()) {
        // 如果有 toastr 可以用 toastr，否则用 alert
        if (window.toastr) toastr.warning("正则不能为空");
        else alert("正则不能为空");
        return;
      }

      const list = this.getData();
      list[index].type = newType;
      list[index].regex = newStr;

      this.onSave(list);
      this.render();
    });
  }

  /**
   * 初始化拖拽排序
   */
  _initSortable() {
    const listEl = this.$container;
    const self = this;

    // 检查是否已经初始化过，防止重复绑定
    if (listEl.data("ui-sortable")) {
      listEl.sortable("destroy");
    }

    listEl.sortable({
      handle: ".anima-drag-handle",
      placeholder: "ui-state-highlight", // 需要确保 CSS 有这个类，或者沿用你原有的样式
      stop: function (event, ui) {
        const newData = [];
        const currentData = self.getData();

        // 根据 DOM 顺序重组数组
        listEl.children().each(function () {
          const oldIdx = $(this).data("idx");
          // 必须做一个浅拷贝或者直接引用，防止索引错乱
          if (currentData[oldIdx]) {
            newData.push(currentData[oldIdx]);
          }
        });

        // 更新数据源
        // 注意：这里我们不能直接修改 this.getData() 返回的数组引用，
        // 而是通过 onSave 传回一个新数组
        self.onSave(newData);

        // 重新渲染以修正 DOM 上的 data-idx
        self.render();
      },
    });
  }

  /**
   * 添加新规则的辅助方法 (供外部调用)
   */
  addRule(regexStr, type) {
    const list = this.getData();
    list.push({ regex: regexStr, type: type, enabled: true });
    this.onSave(list);
    this.render();
  }

  /**
   * 工具函数
   */
  escapeHtml(text) {
    if (!text) return text;
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}

/**
 * 获取通用的“添加正则”模态框 HTML
 * 只需要在页面任意位置插入一次即可
 */
export function getRegexModalHTML() {
  return `
    <div id="anima-regex-input-modal" class="anima-modal hidden">
        <div class="anima-modal-content" style="max-width: 500px;">
            <div class="anima-modal-header">
                <h3>添加正则规则</h3>
                <span class="anima-close-regex-modal" style="cursor:pointer;">&times;</span>
            </div>
            <div class="anima-modal-body">
                <div class="anima-input-group" style="flex-direction: column;">
                    <label>规则类型</label>
                    <select id="anima_new_regex_type" class="anima-select">
                        <option value="extract">🔍 提取</option>
                        <option value="exclude">🚫 排除</option>
                    </select>
                </div>
                <div class="anima-input-group" style="flex-direction: column;">
                    <label>正则表达式</label>
                    <input type="text" id="anima_new_regex_str" class="anima-input" placeholder="/<content>(.*?)<\\/content>/gs">
                </div>
            </div>
            <div class="anima-modal-footer">
                <button id="anima_btn_confirm_add_regex" class="anima-btn primary">确定</button>
                <button class="anima-close-regex-modal anima-btn secondary">取消</button>
            </div>
        </div>
    </div>`;
}
