/**
 * 告诉 VS Code 这些变量在运行时是存在的，
 * 类型设为 any 可以跳过具体的属性检查，快速消除报错。
 */

// SillyTavern 全局对象
declare var SillyTavern: any;
declare var TavernHelper: any;

// 第三方库
declare var toastr: {
  success: (msg: string, title?: string) => void;
  info: (msg: string, title?: string) => void;
  warning: (msg: string, title?: string) => void;
  error: (msg: string, title?: string) => void;
  [key: string]: any;
};

// jQuery
declare var $: any;
declare var jQuery: any;

// 扩展 Window 接口，解决 window.toastr 报错
interface Window {
  TavernHelper: any;
  SillyTavern: any;
  toastr: any;
}
