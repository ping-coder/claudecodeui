# {{projectName}}

## AGENTS 约定

- 模型的思考过程和结论总结都使用中文
- 每次提问结束显示这次提问的所有TOKEN数，使用K和M的单位
- 允许根据任务复杂度开启多个并列工作流，具体数量请自行决定
- 生成的文档应该用人类的思维，而不是AI的语言，也不需要将你思考和验证的文字写进去，尽最大可能性的精炼，并且文档都需要double check

## TASK

- 任务和 Issue 都在 TASKS.md，按 task-runner skill 开发，用 issue skill 记录问题

## 跑测试

- 所有测试命令都加 `timeout`，例如 `timeout 600 <测试命令>`
- 本项目的测试命令：（待补充）
