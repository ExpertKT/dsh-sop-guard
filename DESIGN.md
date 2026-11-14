# 设计与边界

这份文件说清 `dsh-sop-guard` 怎么工作、为什么这么接、哪些事它做不到。[中文 README](README.md) 讲怎么用，这里讲为什么。

## 要解决的问题

skill 里写了流程，模型可能忘：跳过分析直接给答案，或者为省时间抄近路。提示词只是建议，改不动工具调用。插件把流程搬到工具闸门上——被拒的调用在工具执行前就停，没有副作用。

## 挂载点

主线是 `tools.guard` 卡调用、`tools/post-execute` 武装流程、`systemPrompt.context()` 播报当前步骤；下面几个事件负责把状态接住。

| 框架事件 | 用途 | 为什么是这里 |
|---|---|---|
| `tools.guard` | 每一步的硬拦截 | 返回字符串即拒绝，工具体不会跑，调用零副作用 |
| `tools/post-execute` | 加载 `skill` 的结果、把清单挂到会话 | 这个瀑布被调用方 `await`，结果提交前一定完成 |
| `tools/result` | 只记「本步观察到几次成功的工具执行」 | 观察者是 fire-and-forget，不能在这里改状态 |
| `agent/created` | 会话恢复、子 agent 继承 | `serial` 事件逐个 `await` 监听器，第一个工具调用前一定完成 |
| `agent/disposed` | 清掉本会话内存状态 | 磁盘状态按会话留着，供恢复使用 |

两个竞态是这么绕开的：skill 装载曾放在 `tools/result`，同批里的下一个工具在清单击盘之前就过了 gate；会话恢复曾写成 `void restoreFlow(...).then(...)`，`serial` 只等监听器返回值，读盘没完就放行。现在都挪到被 `await` 的事件里。

`tools/post-execute` 只处理 `skill` 且结果成功、`resourceBase.kind === 'directory'` 的调用。坏的清单不会静默解除流程：它作为一条 `additionalContexts` 消息告诉模型错在哪，插件自己记一条 `notice`，模型查状态时才消费。

## 状态与持久化

一个 `sessions` Map，键是 `agent.id`，值里每个已装载清单一份 `flow`（索引、是否申报、本步成功执行记录、evidence、observed）。默认值写进 `~/.dsh/sop-guard/flows/<agent.id>.json`：

- 写盘走「临时文件 + `rename` 原子替换」，`${key}.lock` 独占锁挡跨进程并发。Windows 上 `rename` 偶发 `EPERM` / `EBUSY`，只对这些错误短重试几次。
- 同会话的 `persist` 与「结束流程的删盘」走同一条 `writes` 串行链。删盘不排队会让一次迟到的写把已结束的流程写回来。
- `restoreFlow` 按**步骤 id** 比对本进程清单与磁盘快照；清单变了就回第 1 步。恢复后一律 `declared: false`、`doneWork: 0`、`observed: []`——申报属于某一步，不跨进程继承。
- 会话内重新加载同一个 skill 走同一套比对：只按索引留进度的话，改了清单再重载，旧步骤的申报、读取记录、人的确认会挂到同一位置的另一个步骤上。id 对不上就整步清零，回到第 1 步。

`config.mode` 只认 `enforce` / `warn`，别的值在加载时抛错。`warn` 只把同样的拒信写进日志然后放行。`config.stateDir = false` 时完全不落盘。

## 每一步怎么判

1. 调用 `sop_step({ step: "<当前 id>" })` 申报。申报对整步有效，不按调用次数消耗。推进之后新一步要重新申报。
2. 被看管的工具调用进 `tools.guard`：没申报、工具不在本步 `tools`、命令不在 `commands` 白名单、程序体里出现不该有的模块字面量——任一命中就拒。拒信带步骤、原因、申报提示、允许的工具、白名单、下一步、清单位置。
3. 推进要 `evidence`（≥8 字符）+ 本步至少一次成功的工具执行；标了 `witness` 的步骤只认 `read` / `read_image` / `glob` / `grep`；标了 `approval` 的步骤要人输入 `/sop approve`。
4. `done` 会丢掉整条闸门，所以它和推进一样：本步已申报 + `evidence` + 观察到的成功执行 + `approval`，并记一条审计日志。人可以用 `/sop off` 整条解除。

`/sop approve` 走框架的 `commands.execute(agent, line, ...)`，生命周期事件写死 `source: { kind: "user" }`。模型的工具调用到不了这里，所以「只有人能确认」成立。确认标记 `approved` 只在内存里，推进后清空，也不写进状态文件——恢复后重新问人。

## 运行时上下文

`systemPrompt.context()` 每步播报「流程名、第 N/M 步、是否已申报、允许的工具、白名单、下一步」。用 context 而不是把动态文本塞进 section：section 属于系统提示前缀，每推进一次就重写前缀；context 由框架单独投影成快照消息，且只在文本变化时才重投。静态规则 `RULES` 保持常量，KV cache 前缀不动。

播报是提醒，不是拦截。真正拦住的只有 `tools.guard`。

## 明确做不到的事

- **不是沙箱。** 命令白名单是词法层解析：按 `;` `&` `|` 换行切段，剥一层引号，拒 shell 套 shell、未闭合引号、重定向、变量展开、编码命令、从文件/标准输入读命令、写盘类命令。展开之后真正执行了什么，插件看不见。
- **`run_code` 程序体只做文本扫描。** 扫所有字符串字面量里的 Node 文件/子进程模块名。`"node:" + "fs"` 这种拼出来的名字看不到；换成 Python flavor 也不在这个表内。
- **`evidence` 是自述。** `witness` 只能证明「读过东西」，不证明读的是该读的文件、内容支持那个结论。
- **`approval` 证明不了人真看了方案。** 它证明的是有人敲了 `/sop approve`。
- **子 agent 继承清单与进度，不继承申报、成功执行与确认。** 申报和观察到的成功执行都算它自己那一步的。
- **运行时文本是中文。** 拒信、`sop_step` 说明、系统提示都是中文；英文 README 是配套参考。
- **跨进程只有一个锁文件。** 同一会话多进程同时写，靠 `${key}.lock`；全局协调需要真正的会话日志，没做。

## 测试

`node test/guard.test.mjs` 用一份假 Cordis 上下文跑全套，不依赖运行中的 DSH。它会抽两份 README 里的 JSON 示例写进临时 `SOP.json` 真装载、真走完，也会核对 `examples/sop-demo/` 与示例结构一致——文档里的清单不能悄悄失效。CI 在 Node 22 / 24 上跑 `node --check` 与 `npm test`。测试脚本、示例、两份 README 都打进 npm 包，装完 `node node_modules/dsh-sop-guard/test/guard.test.mjs` 能直接跑，不用再 clone 仓库。

线上验证欠着：第 13 批之后的多数改动只有单元测试，还没在运行中的 DSH 里从头走完一条完整清单。
