# macOS 实机验收

源码包包含与 Windows 发布版本相同的共享 Python 代码、测试、图标和审计工具。
Windows 上的测试可以覆盖缺失 Windows socket 常量时的运行路径和菜单逻辑；
不能证明 AppKit、WebKit、rumps 或 launchctl 已在 macOS 上成功运行。

先按 [README 独立设备验收](../README.md#device-acceptance) 完成环境记录和手动启动；本文件作为补充清单。不要把依赖安装、登录自启或未测项目默认为已通过。

在 Mac 上解压新源码包并进入其目录：

1. 确认 Python 3.10+ 和虚拟环境依赖安装成功；手动运行通过并退出后，再执行 `bash install_mac.command` 验证登录自启安装。
2. 可选源码测试：在独立终端将 `AIBAR_DATA_DIR` 设为项目 `work/` 下新的空目录，然后执行 `.venv/bin/python -B -m unittest discover -s tests`，记录结果；
   Windows 专用测试允许明确跳过。
3. 检查菜单栏出现图标；Muse 有计数时紫色行正常，不出现 KeyError。
4. 选择“打开面板”，确认按本机检测到的数据源显示卡片，中文和相应读数可见；不要求固定五张卡片，也不要求余额/计数显示额度进度条。
   关闭面板后托盘仍运行；连续打开两个面板内容均完整。
5. 选择“立即刷新”，确认刷新完成并显示合理的失败/未配置提示。
6. 检查用户目录下 `.aibar` 配置权限，确认本地 Muse/Antigravity 数据路径可读。
7. 注销重新登录，确认 launch agent 自动启动且没有重复实例。
8. 仅在配置了自己的两台机器后验证对端同步及 token 鉴权。

任一步失败时记录具体系统版本和错误，不将 Windows 的通过结果替代这份实机验收。

卸载自启动：在本机终端执行 `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.aibar.tray.plist`，
再将该 plist 移到备份目录。保留 `.aibar` 中的配置和数据，除非明确决定删除。
