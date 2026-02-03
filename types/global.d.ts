// global.d.ts
export {};

declare global {
  interface Window {
    TavernHelper: any; // 告诉编辑器 window 上有个叫 TavernHelper 的属性，类型随意
  }
}
