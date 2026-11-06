---
name: easycad
category: 开发工具
description: >
  下载、安装并启动 EasyCAD——许愿式 AI CAD 客户端（官网 https://cad.easyaisuite.com/）。
  当用户要求安装、打开或启动 EasyCAD，想用一句话生成 CAD 三维模型并导出 STEP/STL，
  或排查 EasyCAD 下载安装问题时使用。自动识别 macOS（Apple 芯片/Intel）与 Windows 平台，
  选择对应安装包完成安装、启动与验证。
---

# easycad

帮助用户下载、安装并启动 EasyCAD。EasyCAD 是许愿式 AI CAD 客户端：用一句话描述需求，AI Agent 自动查找标准件、编写模型、检查零件配合，生成可导出 STEP/STL 的参数化 CAD 模型。Agent 底座 Easy Code 会随客户端自动配置，装好即用，无需额外配置。

## 第一步：检查是否已安装

- macOS：`ls -d /Applications/EasyCAD.app`
- Windows：EasyCAD 安装后**不在 PATH 里**，`where EasyCAD` 查不到不代表没装。先查注册表卸载项（CMD/PowerShell 均可直接运行）：

```powershell
powershell -NoProfile -Command "Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*,HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*,HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName -like '*EasyCAD*'} | Select-Object DisplayName,DisplayVersion,InstallLocation"
```

注册表查不到时，再检查常见安装目录（任一目录下存在 `EasyCAD.exe` 即视为已安装）：

```cmd
dir "%LOCALAPPDATA%\Programs\EasyCAD\EasyCAD.exe" 2>nul & dir "C:\Program Files\EasyCAD\EasyCAD.exe" 2>nul & dir "C:\Program Files (x86)\EasyCAD\EasyCAD.exe" 2>nul
```

已安装（记下查到的 `InstallLocation` 或 exe 路径）就**直接跳到「启动并验证」，绝不要重新运行安装包**。用户明确要求重装时，先卸载再重新安装。

## 第二步：确认平台与下载链接

先打开官网 https://cad.easyaisuite.com/ 确认**最新版本号**（下方链接以 v0.1.6 为例，版本更新后请替换链接中的版本号）：

| 平台 | 下载链接 |
| --- | --- |
| Windows 10/11 x64 | https://download.easycode.bot/easycad/EasyCAD-v0.1.6-setup-x64.exe |
| macOS Apple 芯片（M1–M4） | https://download.easycode.bot/easycad/EasyCAD-v0.1.6-mac-arm64.dmg |
| macOS Intel（Core i5/i7/i9） | https://download.easycode.bot/easycad/EasyCAD-v0.1.6-mac-x64.dmg |

macOS 用 `uname -m` 判断架构：`arm64` 选 Apple 芯片版，`x86_64` 选 Intel 版。不确定时先执行这条命令，不要猜。

## 第三步：下载安装包

下载到用户的下载目录（以下以 `~/Downloads` 为例）：

```sh
curl -L -o ~/Downloads/EasyCAD-v0.1.6-mac-arm64.dmg "https://download.easycode.bot/easycad/EasyCAD-v0.1.6-mac-arm64.dmg"
```

Windows 用 `curl.exe -L -o` 或浏览器直接下载同名 exe。下载完成后检查文件大小，明显偏小（几 MB）说明下载不完整，重新下载。

## 第四步：安装

### macOS（.dmg）

```sh
hdiutil attach ~/Downloads/EasyCAD-v0.1.6-mac-arm64.dmg
ls /Volumes/                       # 找到挂载卷名，通常为 EasyCAD
sudo cp -R "/Volumes/EasyCAD/EasyCAD.app" /Applications/
hdiutil detach "/Volumes/EasyCAD"
```

- `cp` 无权限时改用 Finder 把 EasyCAD.app 拖入应用程序文件夹，或加 `sudo`。
- 首次打开若提示「已损坏，无法打开」或「无法验证开发者」（应用未公证所致）：向用户说明原因并征得同意后执行 `xattr -cr /Applications/EasyCAD.app` 清除隔离属性；或在系统设置 → 隐私与安全性中点「仍要打开」。

### Windows（.exe）

> ⚠️ 下载的 `EasyCAD-v0.1.6-setup-x64.exe` 是**安装器**，不是应用本体：运行它只会进入安装流程，绝不要把它当作 EasyCAD 启动后等待界面出现。安装完成后，应用本体位于安装目录（默认 `%LOCALAPPDATA%\Programs\EasyCAD\EasyCAD.exe`），此后启动一律用应用本体。

双击 `EasyCAD-v0.1.6-setup-x64.exe` 按安装向导默认选项完成。命令行静默安装可尝试追加 `/S` 参数（NSIS 惯例），失败则回到图形向导安装。安装结束后先确认安装目录里存在 `EasyCAD.exe`（见第一步的目录检查），再进入下一步。

## 第五步：启动并验证

- macOS：`open -a EasyCAD`
- Windows：优先用第一步查到的 `InstallLocation`（或 exe 路径）执行 `start "" "<安装目录>\EasyCAD.exe"`；没查到就依次尝试 `%LOCALAPPDATA%\Programs\EasyCAD\EasyCAD.exe`、`C:\Program Files\EasyCAD\EasyCAD.exe`，都失败才考虑重新安装

验证进程已运行：

```sh
pgrep -x EasyCAD          # macOS
tasklist | findstr /i easycad   # Windows
```

启动成功后告诉用户：直接用一句话描述要建的模型即可开始（例如「生成一个带四个安装孔的轴承座」）。

## 常见问题

- **装错架构包**（macOS）：无法安装或启动，重新按 `uname -m` 结果选择 arm64/x64 包。
- **Windows 已装过却判成未装**：不要用 `where EasyCAD` 判断（EasyCAD 不在 PATH），以注册表卸载项和安装目录检查为准；已装就直接启动，不要重复跑安装包。
- **下载慢或中断**：重试；确认网络可达 `download.easycode.bot`。
- **macOS 提示已损坏**：见第四步，清除 quarantine 属性即可。
- **双击 dmg 后拖不动**：确认拖的是卷内的 EasyCAD.app 整体，不是快捷方式。
