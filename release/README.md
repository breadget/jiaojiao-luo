# JiaoJiao-Luo APK

- 文件：`JiaoJiao-Luo-robot-debug.apk`
- 版本：`1.0.0`（versionCode `1`）
- 类型：Debug APK，已通过 v1/v2 签名校验
- SHA-256：见 `SHA256SUMS.txt`
- 安装：下载 APK 到 Android 手机，开启允许安装未知来源应用后安装。

本版启动流程已将 USB/Bluetooth 硬件发现从应用关键启动路径中隔离；没有连接机器人或首次尚未授予附近设备权限时，也会先打开主界面。

控制栈：Arduino Nano + L298N；连接方式：USB OTG 或 Bluetooth。
