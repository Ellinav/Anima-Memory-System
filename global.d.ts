// global.d.ts

interface Window {
  toastr: {
    info: (msg: string, title?: string) => void;
    success: (msg: string, title?: string) => void;
    warning: (msg: string, title?: string) => void;
    error: (msg: string, title?: string) => void;
  };
  jQuery: any;
  $: any;
}

declare var toastr: Window["toastr"];

// 简单声明 $ 为 any，能解决报错即可
// 如果想要更强的提示，需要安装 @types/jquery，但目前这样足够了
declare var $: any;
declare var jQuery: any;
