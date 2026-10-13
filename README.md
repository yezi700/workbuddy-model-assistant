# WorkBuddy 模型助手

Windows 桌面应用：登录自己的 WorkBuddy / CodeBuddy 账号，选择模型，将本机 OpenAI / Anthropic 兼容接口接入聊天客户端。

基于 [yuan240324/workbuddy-openai-proxy v1.4.0](https://github.com/yuan240324/workbuddy-openai-proxy/releases/tag/v1.4.0) 开发，保留 MIT 许可。项目与腾讯、WorkBuddy、CodeBuddy 及 OpenAI 无隶属关系。

## 下载与使用

在 [Releases](https://github.com/yezi700/workbuddy-model-assistant/releases) 下载：

- `WorkBuddy-Model-Assistant-Setup-1.0.0-x64.exe`：安装版，适合日常使用。
- `WorkBuddy-Model-Assistant-Portable-1.0.0-x64.exe`：免安装版，放到固定位置运行。

运行包已包含 Electron / Node.js，无需另外安装 Node.js。首版暂未进行代码签名，Windows 可能显示未知发布者提示。请核对下载来源及 Release 提供的 SHA-256。

1. 双击应用，代理服务会自动启动。
2. 在「登录账号」中登录自己的国内版或国际版账号，完成官方授权。
3. 在「开始使用」选择模型。
4. 复制 API 地址、密钥、模型名，填入客户端。

客户端通用配置：API 格式选 OpenAI Chat Completions；Base URL 默认为 `http://127.0.0.1:8788/v1`；模型名填 `default`；API Key 从首页复制。

关闭窗口会收起到托盘，服务继续运行。右键托盘图标可以重新打开窗口、启停服务或「退出并停止服务」。开机启动默认关闭，可在服务设置或托盘中开启。

## 从旧代理迁移

先停止旧服务，再在「服务设置 → 导入旧代理的配置和账号」中选择包含 `config.json` 的旧目录。桌面版会备份当前桌面数据，复制旧配置和账号；不修改旧目录，不导入日志与其他文件。

默认个人数据保存在 `%APPDATA%\WorkBuddyModelAssistant\proxy-data`。安装包、源码和 GitHub 仓库中不包含你的配置或凭证。卸载默认保留个人数据；需要彻底清理时自行处理该目录。

端口被占用时，应用不会终止其他程序。停止旧代理，或在启动提示页更改端口；更改后同步更新客户端 API 地址。

## 使用规则与额度

在「更多模型 → 模型参数」设置思考强度和上下文窗口，按模型和渠道分别保存，下一次请求生效。[参数说明](docs/model-parameters-1.0.7.md)。

- 同一个渠道可添加多个账号，失败或额度不足时自动尝试其他可用账号。
- 可以指定优先渠道、允许的备用渠道、夜间时间和活动日期。
- 默认不尝试未允许的收费渠道，不会自动把一个模型替换成另一个模型。
- 新用户的常用模型规则默认使用严格免费检查，价格未知时暂停。国际版优先读取官方模型价格，接口不可用时使用缓存；参考目录中没有可靠价格的模型仍显示价格未知。
- Hy4 夜间规则默认停用；活动随时间变化，不内置某个用户的优惠日期。
- 余额为零不直接判定账号耗尽，因为免费模型可能仍能调用。
- 免费或定时规则损坏时暂停对应模型，在「使用规则」点击「修正规则」保存后恢复。普通限流只短暂冷却账号，确认额度不足才标记耗尽。

免费判断依据目录信息或用户设置，无法保证上游最终扣费为零。登录凭证存在也不保证某模型可用，权限、余额和上游网络均可能影响调用。限流错误可能暂时影响账号选择，可稍后重试或重置账号状态。

## 功能与边界

支持 Chat Completions、Messages、Responses 三种兼容接口。支持流式输出、工具调用、多站点和多账号。

桌面窗口采用隔离且沙箱化的渲染进程，代理由应用独立管理。账号授权在系统浏览器的官方页面完成；只监听本机回环地址。代理使用的上游接口不是官方公开 API，可能变化。请仅使用本人账号并遵守上游服务规则。

首版面向 Windows x64。自动更新、macOS / Linux 安装包、应用签名暂不包含在首版内。

## 开发

使用 Node.js 22 或更新版本：

```powershell
npm ci
npm start
npm test
npm run dist
```

代理后端本身仅使用 Node.js 内置模块；新增开发依赖用于桌面窗口与打包。安装包构建产物在 `dist/`。源码发布与安装包均使用白名单文件，不包含本机配置或凭证。

常用目录：`desktop/` 桌面入口与服务生命周期，`console/` 用户界面，`src/` 代理后端，`test/` 回归测试。

## 来源与许可

原项目：[yuan240324/workbuddy-openai-proxy](https://github.com/yuan240324/workbuddy-openai-proxy)，MIT。原源码的版权许可保留在 [LICENSE](LICENSE)。新增桌面管理、界面与切换优化也以 MIT 发布。依赖组件说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
