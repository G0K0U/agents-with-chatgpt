# Quanta 安全与发布验收说明

2026-09-06 修复基线：c96534e4220fd0f9b0a4985777efbac8c40415dc。
准确源码版本见 SOURCE-MANIFEST.json，EXE 构建输入见 Quanta.exe.build.json。
旧版报告的 87 项测试和运行结论不适用于后续浮窗版本。

## 本轮修复

- 正常启动路径的未定义 candidate 和鼠标回调的未定义 _trace_click。
- 浮窗保留托盘直达、无标题栏、图例点击开关；所有六个动作按钮完整显示。
  定位按点击所在显示器工作区和缩放计算；退出清理 Tk，线程失败回退原生菜单。
- 看门狗检测实际绑定地址，不再重复创建仍然存活的采集线程；重建 API 前
  正确关闭旧服务，修复成功后的健康标志。仍然卡住的采集会标记过期，不承诺
  能安全强制终止 Python 线程。
- WSL Muse 首次和定期探测、手动检测绕过缓存；过期日期兼容无时区输入。
- GLM / DeepSeek 凭据请求禁用跳转和环境代理，保留默认 TLS 证书验证；
  不把异常中的凭据内容写入快照。厂商、本机 LS、peer JSON 响应限制 2 MB。
- API 保持回环或 Tailscale IPv4、至少 16 字符 token、常量时间比较；
  新增 16 个并发处理上限和 10 秒连接读取超时。
- 配置解析失败保留原文件并报错，不再覆盖；支持 UTF-8 BOM。
- 自启查询关闭注册表句柄；只操作当前用户 Quanta 自启项。
- 冒烟工具改为独立数据目录、随机端口、合成数据；只终止本轮创建的进程树，
  不杀其他 Python 程序，不把超时或旧报告存在当作通过。
- macOS 依赖不再安装 Windows 专用浮窗库。macOS 原生运行仍须真机验证。

## 可复现验收

在 Windows 项目目录，使用已安装依赖的虚拟环境执行：

```text
python -B -m unittest discover -s tests
python tools/audit_scan.py scan
python build_windows.py
python tools/smoke.py --exe dist/Quanta.exe
python tools/release.py build
python tools/release.py verify
```

发布工具要求已提交且干净的源码；EXE 输入摘要和当前源码必须一致。
冒烟结果保存在 work/smoke，逐项包含启动、401/401/200、单实例、真实
Tk 按钮布局与回调、图例开关、真实 WebView DOM、退出、交换文件删除、
本轮看门狗健康。任何超时均失败。AIBAR_DATA_DIR 仅用于隔离本机测试或
独立数据目录；默认仍是 ~/.aibar，不改变现有账户配置。

## 安全边界

已知敏感值扫描覆盖跟踪文件和可达 Git 历史，但不是任意秘密不存在的证明。
发布包不得包含个人 config.json、运行快照、历史或原始对话日志。
配置和缓存可能包含 token、邮箱或账户标识，必须受本机账户权限保护。
认证 API 的快照含账户标识，仅应与可信设备共享 token；Tailscale 地址段
校验本身不证明 VPN 已启用。普通 HTTP 的加密依赖 Tailscale 隧道。

Antigravity 语言服务仅请求固定本机回环，因其自签证书而关闭该本地连接的
证书验证；这不适用于 GLM/DeepSeek 的互联网 HTTPS 请求。
应用刷新仍会读取本机日志及请求已配置的官方服务；这不是完全离线应用。
本轮不推送源码或上传分发包；云端 AI 开发、依赖下载、漏洞库查询仍涉及联网。
临时面板短暂落盘，正常路径删除；断电或强制结束不保证清理，也不保证安全擦除。

Windows 自动验收的动作回调与合成数据不能代替所有 DPI、多显示器实体点击、
厂商后台计费一致性或 macOS AppKit/WebKit、自启和双机同步真机测试。
二进制未签名时，哈希仅用于一致性校验，不是发行者数字签名。
不承诺绝对安全或零缺陷。
