# 来源与第三方组件

## 原始代理项目

本项目基于 yuan240324/workbuddy-openai-proxy 的 v1.4.0（commit 6a1b6e179e927fb07ea1a43aa587ed31ef01e4f5）及本机后续改进。

原项目地址：https://github.com/yuan240324/workbuddy-openai-proxy

原始源码许可为 MIT，版权文本保留在根目录 LICENSE。桌面程序加入 Electron 窗口、托盘、服务生命周期、隔离的数据目录和导入功能；代理与控制台加入模型规则、跨站点回退及新手界面。

## 桌面运行时与构建工具

- Electron：MIT；分发包还包含 Chromium、Node.js 及其他第三方组件的许可，安装包中的 LICENSE.electron.txt 和 LICENSES.chromium.html 等文件需保留。
- electron-builder：MIT，用于构建安装版和便携版。
- Node.js 及 Chromium 的许可与版权归各自贡献者。

商标归各自所有者，本项目不是上述厂商的官方产品。
