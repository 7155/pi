# Pi 源码学习课程

本目录用于存放面向源码理解与 Agent 工程实践的课程。

## 当前课程

| 课程 | 适合谁 | 目标 |
|---|---|---|
| [Pi 0.84 源码学习课程](pi-source-learning/README.md) | 想理解 Agent Loop、Session、Compaction、Extension、Harness 与产品 Runtime 的学习者 | 从一次真实用户请求出发，读懂 Pi 的完整调用链，并完成一个可用于面试展示的数据准备 Agent |

课程不是 API 速查表，也不是逐文件翻译。每一课都按下面的顺序组织：

```text
为什么需要它
→ 谁调用它
→ 没有它会坏在哪里
→ 一次真实请求怎样流过它
→ 核心源码
→ 状态、输出、失败与并发
→ 最后补 TypeScript 语法
```

课程源码基线、课时依赖和维护规则见课程内部的
[`course-manifest.json`](pi-source-learning/course-manifest.json)。
