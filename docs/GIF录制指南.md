# GIF 录制指南（README 演示动图）

> 目标：README 顶部 demo GIF（约 15–20 秒），展示 `genui-audit` 一次 PASS + 一次 BLOCK 的完整终端会话。
> 录制完成后：文件存为 `docs/demo.gif`，取消 README.md 中 `![genui-audit demo](docs/demo.gif)` 的注释，提交。

## 录制前检查

- `pnpm test` 全绿（README 里承诺 188 测试，录制时数字须一致）
- 终端字体/配色清晰（建议 14pt+，深色背景，宽度 ~100 列）
- 终端为 PowerShell 或 bash 均可，提示符干净（无长路径污染画面）

## 录制内容（按序执行，一条命令一屏）

```powershell
# 1. PASS 案例（全展开树，20 组件）
node packages/audit/bin/genui-audit.mjs packages/adapter-a2ui/test/fixtures/official/basic-v1/30_live-invitation-builder.json

# 2. BLOCK 案例（深度 33 链，恰好 1 条违规）
node packages/audit/bin/genui-audit.mjs <too-deep.json 路径>

# 3. 退出码 + --json 一闪而过
echo "exit code: $LASTEXITCODE"
```

`too-deep.json` 生成命令（或从本仓库历史/临时目录重建）：

```powershell
$d = 33
$c = for ($i = 0; $i -lt $d; $i++) {
  if ($i -eq 32) { @{ id = "n$i"; component = 'Card' } }
  else { @{ id = if ($i -eq 0) { 'root' } else { "n$i" }; component = 'Card'; child = "n$($i+1)" } }
}
ConvertTo-Json @(@{ version = '1.0'; createSurface = @{ surfaceId = 'too-deep'; components = $c } }) -Depth 10 -Compress | Set-Content too-deep.json -Encoding UTF8
```

## 工具建议

- Windows：ScreenToGif（开源，导出 gif 直接裁剪帧）
- 跨平台：asciinema 录制 + `agg` 转 gif（文本级录制，画质最优）
- 帧率 12–15fps 足够；GIF 控制在 2MB 内（GitHub README 显示上限 10MB，但加载速度影响首屏）

## 注意

- 不要录到绝对路径里的用户名/机器名（用相对路径命令）
- 录制中输出的 sha256/IR hash 是确定性的，与 README 文本块中一致，无泄漏风险
