# ARM32 编译与 deploy_kano 整包交付

`deploy_kano` 是仓库支持的本地构建与打包方式。正式入口为
[`scripts/build-deploy-kano.ps1`](../scripts/build-deploy-kano.ps1)，
统一交付目录为 **`build/deploy_kano/`**；脚本和模板入库，编译产物与私人配置不入库。

## Windows + WSL 一次构建

在仓库根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-deploy-kano.ps1
```

默认编译带内嵌 Web 的 ARMv7 release，然后重新生成 shell 安装器、tiny
bootstrap、六条分段命令、Go 安装器及 Windows 离线 ADB 包。全部核验成功后
才替换 `build/deploy_kano/`。过程不连接设备、不安装、不上传、不发布 GitHub release。

依赖：

- Windows：PowerShell、Node.js/npm（满足 `web/package.json`）、Windows Android platform-tools。
- WSL Linux：Python 3、Bash、Rust/rustup 1.89.0、Linux Zig、Go 1.25+、UPX、
  `binutils-arm-linux-gnueabihf`、`file`、`sha256sum` 和公共 CA 证书包。
- Rust ARM 目标由构建脚本安装：`armv7-unknown-linux-musleabihf`。

默认从 PATH 查找 `adb.exe`，Zig 优先取 WSL PATH，否则使用 Linux 用户的
`~/zig/zig`。也可以显式传入：

```powershell
powershell -File scripts/build-deploy-kano.ps1 `
  -AdbDir 'C:\Android\platform-tools' `
  -Zig '/opt/zig/zig' `
  -BaseUrl 'https://YOUR-SERVER/datad/u50pro'
```

可将私人配置保存到 **`local/deploy-kano.json`**，该目录被 Git 忽略：

```json
{
  "base_url": "https://YOUR-SERVER/datad/u50pro",
  "adb_dir": "C:\\Android\\platform-tools",
  "zig": "/opt/zig/zig"
}
```

命令行参数优先于该文件；`-ConfigFile` 可指定其他本地配置。
没有服务器目录时，安装命令要求使用者先设置 `DATAD_BASE_URL`，不会嵌入私人地址。
下载支持 HTTP 和 HTTPS；不要在 URL 中放账号、密码或临时令牌。

## 只打包、纯 API 与 Linux 构建

已有 candidate 时，可以跳过主程序编译：

```powershell
powershell -File scripts/build-deploy-kano.ps1 -PackageOnly
```

该选项只核验现有二进制、版本及 provenance 的一致性，**不会核对它是否包含
最新源码改动**。源码修改后应完整构建。默认拒绝误打包纯 API candidate；
只有明确传入 `-ApiOnly` 才构建/打包不含 Web 的版本。

Linux/WSL 也可直接使用同一组仓库脚本（`--adb-dir` 指向 Windows platform-tools）：

```sh
npm ci --prefix web
npm run build --prefix web
ZIG=/opt/zig/zig bash scripts/build-arm32-web.sh --candidate
sh tools/u50get/build.sh
python3 scripts/package-deploy-kano.py \
  --adb-dir /mnt/c/Android/platform-tools \
  --base-url https://YOUR-SERVER/datad/u50pro
```

最底层仍是 [`build-arm32-web.sh`](../scripts/build-arm32-web.sh)、
[`build-arm32-candidate.sh`](../scripts/build-arm32-candidate.sh)、
[`package-u50pro.py`](../scripts/package-u50pro.py)、
[`package-u50pro-adb.py`](../scripts/package-u50pro-adb.py) 和
[`package-u50pro-go.py`](../scripts/package-u50pro-go.py)。单独执行一个基础打包脚本
不等于完整更新全部交付文件；整包入口负责同步、交叉核验和最终替换。

## 输出与校验

| 文件或目录 | 用途 |
| --- | --- |
| `zwrt-datad-armv7`、`install-datad.sh` | 必须配套上传的主程序和安装脚本 |
| `bootstrap-u50pro.sh` | 内嵌 tiny 下载器，固定校验当前安装脚本 |
| `install-steps.txt`、`一键安装命令.txt` | 六条英文命令：准备、四段载荷、校验执行；单条少于 2000 字符 |
| `install-datad-armv7`、`.unpacked` 备用版 | 内嵌当前哈希的 Go 安装器，UPX 压缩版及未压缩版 |
| `U50Pro_ADB/`、`U50Pro_ADB_<版本>.zip` | Windows 离线 ADB 安装包 |
| `LATEST_ADB_PACKAGE.txt` | 指向本轮生成的 ZIP，不沿用旧的带日期包名 |
| `tiny-bootstrap/` | tiny 方案的同步交付副本 |
| `SHA256SUMS`、`INSTALLER-SHA256SUMS` | 文件校验清单 |
| `build-info.json`、`installer-build-info.json` | 构建信息与安装器资源信息 |
| `package-verification.json` | 整套交付核验成功的记录 |

打包先在同一 `build/` 下的临时目录完成。它会核对：主程序副本、版本/大小/
SHA256、完整安装脚本、bootstrap、四段载荷还原、校验清单、Go 生成资源和
ADB ZIP 内的二进制。失败时保留此前的部署包，不发布半套新文件。
输出目录由打包工具管理，只存放生成文件；私人配置、手写源码和抓包应放 `local/`。

`version.json` 是版本来源，不能通过手改安装器 SHA256 绕过不匹配。
provenance 的 `commit` 指向 HEAD，`source_dirty` 表明工作区是否含未提交改动；
它不代表未提交源码的完整内容快照。SHA256 也不等于 Ed25519 发布签名。
签名更新/公开发布另见 [`publish-arm32-release.sh`](../scripts/publish-arm32-release.sh)。

## 清理工作区

先预览，确认没有编译任务运行后再清理：

```powershell
powershell -File scripts/clean-build.ps1 -CargoCache
powershell -File scripts/clean-build.ps1 -CargoCache -Apply
```

只删除列明的可重建中间产物；`-CargoCache` 包含 `rust/target/`，删除后下次
Cargo 构建需要重新编译。始终保留最新 `build/deploy_kano/`、candidate/provenance、
Web 构建结果、真实抓包和参考资料。脚本拒绝顶层目录链接和活动编译进程；
遇到树内符号链接只删除链接本身，不遍历其目标。

历史手写辅助脚本、原始下载器资料保存在忽略的 `local/workspace-archive/`；
不把它们作为正式打包依赖。旧的 `build/refresh-*-deploy-package.py` 不再是构建入口。

## 上传与验证

1. 相关测试通过，构建与整包核验均成功。
2. 将同一套主程序、安装脚本、bootstrap 和 Go 安装器上传完成后，再分发对应安装命令。
3. 实机部署必须等待明确的 `SUCCESS`，再检查运行版本、接口和客户端。

网页默认通过 `http://设备IP:9461/ui/` 访问，原 API 路径继续使用。
`--disable-web-ui` 才禁用网页。编译成功、打包成功和设备部署成功是三个独立状态。
