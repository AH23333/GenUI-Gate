# GenUI Gate

开源、非商业的 **GenUI 质量与可访问性闸门**：在宿主应用内对 Agent 动态生成的 UI 声明做确定性校验（limits / schema / 语义规则），输出可解释的裁决（pass / transform / requireApproval / block）。协议无关，A2UI 优先。

> 状态：pre-alpha（M0）。范围与里程碑见 [docs/产品设计v3-开源版.md](docs/产品设计v3-开源版.md)，技术规格见 [docs/产品设计v2-修订.md](docs/产品设计v2-修订.md)。

## 仓库结构

```
packages/
  ir/     规范化 IR 模型、canonical JSON、确定性哈希（sha256）
  gate/   运行时闸门：limits 校验、verdict 聚合
docs/    产品设计、执行文档（进度/交接/踩坑/开发指南）
```

## 开发

要求：Node >= 20，pnpm 11（`packageManager` 字段已锁定，可用 corepack）。

```bash
pnpm install          # 安装依赖
pnpm test             # 运行全部测试（含属性测试）
pnpm typecheck        # tsc --noEmit
pnpm coverage         # 覆盖率（阈值 90%）
```

## 确定性纪律

- 核心包（ir/gate）零运行时依赖、禁 `Date.now()` / `Math.random()` / locale 相关比较
- 哈希输入经 canonical JSON 规范化（键排序、数字规范化），配合 `.gitattributes` 强制 LF
- sha256 为纯 TS 同步实现，黄金向量（NIST）+ node:crypto 交叉验证 + 属性测试（fast-check）
- 树遍历一律显式栈，禁止递归

## License

Apache-2.0（非商业开源治理层，见 v3 文档第 1 节）
