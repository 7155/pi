# 实验 03：Compaction 断言校正

`CompactionEntry` 不删除 `firstKeptEntryId` 开始的保留尾部。对于本实验的：

```text
U3B → A3B → COMP1 → U4 → A4
```

当 `COMP1.firstKeptEntryId = "U3B"` 且当前叶节点为 `A4` 时，活动 Context Entry 应为：

```ts
expect(activeEntries.map((entry) => entry.id)).toEqual([
    "COMP1",
    "U3B",
    "A3B",
    "U4",
    "A4",
]);
```

Provider Context 角色应为：

```ts
expect(context.messages.map((message) => message.role)).toEqual([
    "compactionSummary",
    "user",
    "assistant",
    "user",
    "assistant",
]);
```

原因是 Compaction 只用 Summary 替换 `firstKeptEntryId` 之前的活动历史；保留尾部和 Compaction 之后的新消息仍以原始 Entry 投影到 Context。完整 Session Tree 中压缩前 Entry 也继续保留，用于审计和 Fork。

课程主导航将本文件作为实验 03 的强制勘误；实现测试时必须使用这里的断言，不运行 README 中故意留下的旧断言。
