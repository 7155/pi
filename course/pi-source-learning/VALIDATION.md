# 课程验证

在仓库根目录执行：

```bash
node course/pi-source-learning/scripts/validate-course.mjs
```

验证器检查：

- `course-manifest.json` 可以解析；
- 导读、版本专题、机制教材、实验和项目手册数量符合 Manifest；
- Manifest 引用的课程路径存在；
- 相对 Markdown 链接存在；
- Markdown 代码围栏成对闭合；
- 不再出现旧的“某某练习题”模板标题；
- 统计 Markdown、Mermaid 和核心代码块数量。

它验证的是**课程结构**，不等于实验代码已经编译或真实模型 E2E 已运行。实验 README 中的代码应在个人学习分支按各章命令创建并执行；没有 Provider 凭证时，Faux Provider 和纯函数实验仍必须运行。

课程源码或目录变动后，先更新 [`course-manifest.json`](course-manifest.json)，再运行验证器。若上游运行语义变化，还必须重新运行对应 Runtime Test，不能只修链接。
