---
name: sop-demo
description: 演示 SOP Guard 的清单：看仓库、读失败测试、等人点头、改代码、提交。加载这个 skill 会为当前会话武装五步流程。
---

# SOP Guard 演示

这个 skill 只用来演示 [dsh-sop-guard](https://github.com/ExpertKT/dsh-sop-guard) 怎么工作。

同目录的 `SOP.json` 是一份五步清单：

1. `inspect` —— 允许 `pwsh`，但命令必须匹配白名单。
2. `review` —— `witness: true`，不许改任何东西，必须先用 `read` / `glob` / `grep` 真的读过东西才能推进。
3. `await-approval` —— `approval: true`，要人输入 `/sop approve` 才能推进。确认只在内存里，会话恢复后要重新问。
4. `write` —— 允许 `write` / `edit`。
5. `commit` —— 允许 `pwsh`，命令白名单是 `git add` / `git commit`。

模型每一步都要先调用 `sop_step({"step":"<id>"})` 申报。没申报就调被看管的工具，调用会在执行前被拒，拒信会写清当前步骤、允许的工具、白名单和下一步。

`/sop` 查看当前步骤，`/sop off` 解除本会话的流程。

清单内容只是演示。真要用，把它换成你自己的步骤和命令正则。
