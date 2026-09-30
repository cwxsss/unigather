# UniGather 项目规则

## 版本升级

- 用户要求后续功能修改或缺陷修复默认自动递增末位版本号（patch），例如 `0.1.0 -> 0.1.1 -> 0.1.2`。一次完整修改与交付只升级一次，重复构建不升级版本。
- 用户明确指定版本时，以指定版本为准。本次基准版本为 `0.1.0`。
- 同步修改 `package.json`、`package-lock.json` 的根包版本、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 的 unigather 包版本、`src-tauri/tauri.conf.json` 和 `src/main.js` 中的 `APP_VERSION`。
- 打包前核对上述版本一致；仓库提交、推送和 Release 发布沿用用户授权与工具审批要求。
