# 思考强度与上下文窗口（1.0.7）

打开「更多模型」，点击「当前模型参数」，或某一行的「模型参数」。选择思考强度和上下文窗口后点击「保存」，下一次请求生效，无需重启服务。

- 思考强度只显示该渠道官方目录声明的档位。未知能力不会猜测；「跟随上游默认」不发送额外档位。Step-5-Preview 的实际选择以账号接口为准。
- 窗口只显示官方声明的可选长度。指定窗口作为代理保留历史消息的 token 估算预算，与输出长度参数不同，也不会扩大上游模型的硬上限。即使关闭自动上下文压缩，明确指定的窗口仍会生效。
- 小窗口会删除较早的对话块，必要时截短消息内容，不是调用模型生成摘要。系统提示保持不变；极长的系统提示可能仍超过预算。若上游继续报输入过长，现有收缩重试逻辑仍可能进一步减少历史。
- 参数按「渠道／实际模型 ID」分别保存，默认模型与别名解析后使用同一记录。自动切换到备用渠道时，使用备用渠道自己的设置。
- 客户端显式参数优先于 GUI 默认值；不支持的档位或窗口返回 400，不会静默换成另一个设置。「恢复默认」删除该模型的记录。

三种接口示例（均是请求体中的字段）：

```jsonc
// Chat Completions: POST /v1/chat/completions
{"reasoning_effort":"medium","context_window":300000}

// Responses: POST /v1/responses
{"reasoning":{"effort":"medium"},"context_window":300000}

// Anthropic Messages: POST /v1/messages
{"output_config":{"effort":"medium"},"context_window":300000}
```

以上是参数片段，需要与对应协议的 model、messages/input 等字段合并。`context_window` 是本代理扩展字段，仅用于本机处理，不传给上游。Anthropic 的 `thinking.budget_tokens` 尚未映射为强度档位。

配置保存在个人数据目录的 `config.json` 的 `modelParameters` 中，例如：

```json
{"modelParameters":{"cn-cli/step-5-preview":{"reasoning_effort":"medium","context_window":300000}}}
```

传参形式参考本机官方 WorkBuddy 客户端：思考档位规范为 `reasoning_effort`，上下文选择为客户端历史预算。435 项自动测试通过，覆盖三种协议的模拟上游实际收到的请求、窗口裁剪、非法选项、持久化与恢复默认。未发送真实模型测试请求，未验证模型内部推理投入的变化。
