# 2048 — iPhone 优先的离线 PWA

无需框架、无需后端、无需账号的 2048 网页游戏。为 iOS Safari / 添加到主屏幕后的 PWA 优化，同时支持桌面浏览器。

## 功能

- 经典 **4×4** 规则、2048 胜利提示、继续挑战、失败检测和计分。
- iPhone **上下左右滑动**，桌面方向键与 WASD；棋盘阻止滑动时的页面滚动。
- 自动保存棋盘、当前得分、最高分和上一步撤销记录（本设备 localStorage）。
- 单步撤销、新游戏确认、减少动态效果、屏幕阅读器状态播报。
- `viewport-fit=cover` 安全区域、**180px Apple Touch Icon**、standalone Web App Manifest。
- Service Worker 缓存离线资源；完成首次联网加载后可离线打开。
- 纯静态文件，所有资源使用相对路径，适用于独立域名根路径，也可自行调整为其他 HTTPS 静态站点路径。

## 本地运行与测试

```bash
npm run check
npm test
npm run build
python3 -m http.server 8000 -d dist
```

浏览器访问 <http://localhost:8000/>。Service Worker 只能在 HTTPS 或 localhost 下注册，不能直接打开 `file://`。

### Windows Git Bash 测试与发布

在 Windows（例如 `MINGW64 /d/code/2048`）执行：

```bash
npm run check
npm test
bash release_deploy.sh --dryrun
bash release_deploy.sh  # 检查无误、且有远端 SSH 权限后正式发布
```

`npm test` 在 Windows 上预期为 **14 passed、7 skipped、0 failed**：7 项涉及 `flock`、原子 symlink、Nginx 回滚的集成测试必须在真正的 Linux 文件系统上运行。Windows Node.js 的 `os.tmpdir()` 是 `C:\...` 风格，而部署脚本只允许远端 Linux POSIX 绝对路径；Git Bash 的 `ln -s` 也不保证具备 Linux symlink 语义。**没有放松生产部署脚本的路径校验，也没有删掉故障注入断言**。

GitHub Actions 的 Ubuntu 作业必须运行全部 8 项部署测试（含 7 项 Linux 集成测试），且不允许跳过；`windows-latest` 作业另行验证 Git Bash 下的测试、静态打包和 `--dryrun`。希望本地跑满 19 项时，可在 WSL2 Linux 内安装 Node.js 后执行 `npm test`（要从 WSL 的 Node 运行，而非调用 `node.exe`）。


## 发布：与 lazyxu/yl 一样的 SSH / Nginx 方案

本仓库已**不再使用 GitHub Pages**。参照 [`lazyxu/yl`](https://github.com/lazyxu/yl) 的 `release.sh` / `release_deploy.sh`：本地构建 → 独立版本目录 → SSH 上传 → 校验 SHA256 → Nginx 配置验证 → 原子切换当前版本 → 失败回滚。CI 只执行检查、测试和构建，**不会自动连接生产服务器**。

2048 是纯静态 PWA，不涉及 `yl` 的 Express、PM2、MySQL、照片上传或备份，因此只部署静态文件；不修改 `/yl0126`、`yl` 的 PM2 服务、数据库及 `/etc/nginx/conf.d/yl0126.conf`。

默认 SSH 目标参照 yl：`root@t-fluid.com:22`；2048 使用**单独目录** `/2048` 和独立 Nginx vhost `/etc/nginx/conf.d/2048.conf`。
默认示例域名是 **`2048.yl0126.com`**（仅为预设值，**不代表 DNS 或 HTTPS 已配置完成**）。可以通过 `--domain` 指定实际的域名。

```bash
# 本地测试、打包、预览部署，不连接服务器
bash release_deploy.sh --dryrun

# 在有服务器 SSH 授权、DNS 和 HTTPS 方案后，手动上线
bash release_deploy.sh --host t-fluid.com --user root --base /2048 --domain 2048.yl0126.com

# 如果目标已有手工管理或证书工具改写的 Nginx 配置，默认会保留它；
# 明确需要覆盖时才用 --nginx-replace（可能覆盖证书配置，请谨慎）
# 已预先手动配置好 Nginx 时，也可用 --skip-nginx
```

首次发布创建 `/2048/.2048-releases/release-*` 和 `current` 符号链接，并在没有现有 `2048.conf` 时安装独立 HTTP vhost。部署器会先读取真正生效的 `nginx -T` 配置：如果 Nginx 使用 `/etc/nginx/conf.d/*.conf`，安装到 `/etc/nginx/conf.d/2048.conf`；若只启用了 `/etc/nginx/sites-enabled/*`，则安装到 `/etc/nginx/sites-enabled/2048.conf`。若都未启用，部署会明确报错并退出，不修改其他站点。`nginx -t` 通过后还会确认配置确实被加载。

**健康检查**：激活后通过 `curl --noproxy '*'` 对本机 `127.0.0.1:80` 发出 `Host: <你的域名>` 的请求，获取 `/release.json`，并与发布包中的版本元数据逐字节比较。HTTP 200 但返回错误站点、HTTP 301/302 重定向、404/403、网络代理导致返回不符等均会触发安全回滚，输出 HTTP 状态、`Location` 和定位命令。自动保留已有 Nginx TLS 配置，但若该配置在 HTTP/80 上强制跳转 HTTPS，本地 HTTP 健康检查会失败；应确保内部 HTTP vhost 可供检查，或使用 `--skip-nginx` 自行负责网关验证。

以后的发布只原子切换 `/2048/current`，保留上一版本及已有 Nginx 配置。上传的版本含 `release.json`、`SHA256SUMS`，校验失败则拒绝激活；Nginx 校验、重载失败自动恢复上一版本（不能替代对生产机器的实际演练）。

**iOS PWA 必须通过 HTTPS 访问**。现有 `yl` 部署的 Nginx 模板是 HTTP 入口；2048 的新模板同样只监听 HTTP/80，需通过现有可信的 HTTPS 反向代理或在服务器上单独配置 TLS 证书（例如 Certbot）。要让 `2048.yl0126.com` 可用，还需先设置 DNS 指向正确的公网服务，并保证 443 可用。仓库本身不会自动申请证书或添加 DNS 记录。不要在已有证书工具管理的站点上盲目使用 `--nginx-replace`。

完成 DNS/TLS 配置和发布后，可验证 `https://<你的域名>/`、`/sw.js`、`/manifest.webmanifest` 及离线安装。因为本地存档保存在 `localStorage`，**原 GitHub Pages 和新域名之间的分数、棋盘不会自动迁移**。

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