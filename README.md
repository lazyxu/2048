# 2048 — iPhone 优先的离线 PWA

无需框架、无需后端、无需账号的 2048 网页游戏。为 iOS Safari / 添加到主屏幕后的 PWA 优化，同时支持桌面浏览器。

## 功能

- 经典 **4×4** 规则、2048 胜利提示、继续挑战、失败检测和计分。
- iPhone **上下左右滑动**，桌面方向键与 WASD；棋盘阻止滑动时的页面滚动。
- 自动保存棋盘、当前得分、最高分和上一步撤销记录（本设备 localStorage）。
- 单步撤销、新游戏确认、减少动态效果、屏幕阅读器状态播报。
- `viewport-fit=cover` 安全区域、**180px Apple Touch Icon**、standalone Web App Manifest。
- Service Worker 缓存离线资源；完成首次联网加载后可离线打开。
- 纯静态文件，所有资源使用相对路径，适用于 GitHub Pages 子路径 `/2048/`。

## 本地运行与测试

```bash
npm run check
npm test
npm run build
python3 -m http.server 8000 -d dist
```

浏览器访问 <http://localhost:8000/>。Service Worker 只能在 HTTPS 或 localhost 下注册，不能直接打开 `file://`。

## 发布到 GitHub Pages

1. 在仓库的 **Settings → Pages → Build and deployment** 将 Source 设为 **GitHub Actions**（首次启用需要仓库管理权限）。
2. 推送或合并到 `master` 后，`.github/workflows/pages.yml` 会先运行语法检查、游戏单测和构建，随后部署 Pages。
3. 发布成功后的预期地址：<https://lazyxu.github.io/2048/>；以 GitHub Pages 实际部署状态为准。

若 Pages 尚未启用，**CI 测试可能成功，但部署 Job 会失败**；启用 Pages 后重新运行工作流即可。

## 在 iPhone 安装

1. 使用 **Safari** 打开部署好的 HTTPS 地址（不要在微信等内置浏览器里安装）。
2. 点击「分享」→「添加到主屏幕」→「添加」。
3. 从主屏幕打开 2048；联网访问一次后，游戏可离线使用。

游戏数据只保存在对应的浏览器/App 存储空间，不在多设备间同步；删除主屏幕应用、清理网站数据或切换浏览器可能使存档丢失。

## 项目结构

- `src/game.js` — 无 DOM 的 2048 纯规则，实现可独立单元测试
- `src/app.js` — 渲染、iOS 触摸控制、键盘、游戏存档
- `styles.css` — iPhone 优先布局和方块颜色、动画
- `manifest.webmanifest`、`sw.js` — 安装配置、离线缓存
- `icons/` — PWA 图标、iOS 主屏幕图标
- `tests/` — 规则与静态 PWA 资源检查
- `scripts/build.mjs` — 打包成独立静态 `dist/`
