# DeepSeek 用量 · 余额面板

极简的 DeepSeek 余额 / 用量显示板，集成在 DSH 设置页，无需额外窗口。

## 功能

| 功能        | 说明                                                        |
| --------- | --------------------------------------------------------- |
| 账户余额      | 官方 `GET /user/balance`，多币种（总余额 / 充值 / 赠送）+ 可用状态灯（绿/黄/红/灰） |
| 用量统计      | 今日 / 本月 token、消费、请求次数，以及缓存命中 / 未命中 / 输出的 token 构成         |
| 分模型拆分     | 每个模型的 token 用量与消费                                         |
| 分 API Key | 按 `api_key_name` 筛选单个 key 的用量（对应官方页面的「按 API 筛选」）          |
| 总消费       | 全部历史累计消费（逐月汇总）                                            |
| 自动刷新      | 可勾选「每 60 秒自动刷新」，偏好持久化                                     |

## 截图

![主界面](screenshot-main.png)

![用量与分模型](screenshot-details.png)

## 细节说明

### 数据来源

| 数据      | 接口                                               | 认证            |
| ------- | ------------------------------------------------ | ------------- |
| 余额      | `api.deepseek.com/user/balance`（官方公开）            | API Key       |
| 用量 / 消费 | `platform.deepseek.com/api/v0/usage/*`（开放平台网页接口） | 登录态 userToken |

> 用量 / 消费接口是 platform.deepseek.com 的私有接口，非官方公开 API，可能随时变更。

### 凭据

| 凭据        | 存放                                         | 说明            |
| --------- | ------------------------------------------ | ------------- |
| API Key   | DSH 凭据服务 `DEEPSEEK_API_KEY`（与调用 LLM 共用，只读） | 在 DSH 模型设置中更改 |
| userToken | `~/.dsh/ds-balance.json`                   | 自动尝试失败时需手动粘贴  |

## 安全设计

- 凭据服务端保存：API Key 走 DSH 凭据服务，userToken 存 `~/.dsh/ds-balance.json`（0600），浏览器只读掩码。
- Node 原生 `fetch` 直连：无 shell / 子进程中间层，凭据只在进程内存流转。
- 回环 + 同源守卫：所有路由仅接受 127.0.0.1 回环与同源请求，内置 DNS-rebinding 防护。
- 稳定错误码 + 最小日志：日志只记录 `{code, status}`。

## 安装

```bash
dsh plugin --profile web add github:AzureHalcyon/dsh-deepseek-usage#main
```

本地目录安装：

```bash
dsh plugin --profile web add file:<本仓库绝对路径>
```

装完重启 DSH。

## 使用

1. 打开 **设置 → DeepSeek 用量**；
2. API Key 自动复用 DSH 的 `DEEPSEEK_API_KEY`（只读展示，无需额外配置）；
3. userToken 自动读取浏览器已登录的 `platform.deepseek.com` 会话；读不到时按提示手动粘贴（登录后控制台执行 `localStorage.getItem("userToken")`）；
4. 点「立即同步」。

## 插件管理

已装插件建议用 plugin-registry 的薄控制台管理（浏览器面板）：管理 profile 插件安装态（bundle 层栈 + insert 行 + 启停），无需手改配置。安装：

```bash
dsh plugin --profile web add "github:vlln/plugin-registry#main&path:/packages/plugin/console"
```
