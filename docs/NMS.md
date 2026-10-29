# NMS datad 更新协议

当前 `99999` 构建禁用自动更新及 NMS 远程安装，不再上报 `datad.update` 能力。通过身份和有效期校验的 `datad.update.install` 请求返回 `remote_install_disabled`，不会下载或启动安装器；旧配置和环境变量不能重新开启。保留本地 App 主动检查、签名验证安装及 ADB 部署。

`datad.update.check` 与 `datad.update.install` 需要 `protocol_version: 1`、唯一 `request_id`、设备 `identity`、当前 `boot_id` 和未来不超过 300 秒的 `expires_uptime`。安装还要求前次检查得到的 `target_version` 与 `binary_sha256`。不接受下载地址、命令或固件刷写参数。

检查使用设备已有 OTA 更新源并验证 Ed25519 签名。旧版本已启动的安装结果仍会收尾，避免残留“安装中”状态；新远程安装请求按上述策略拒绝。

远程后台仍需本地 `remote_enabled` 开关和服务端口白名单；不开放 datad 管理端口，不处理旧代理的多端口免密交接。

在线心跳固定每 10 秒上报，与可配置的数据上报周期独立，兼容 NMS 的 30 秒离线判定。断开或关闭连接仍发送离线状态，异常断线由 MQTT 遗嘱通知。
