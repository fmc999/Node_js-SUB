# 节点订阅池 —— 多源代理节点聚合与订阅分发服务

[![GitHub](https://img.shields.io/badge/GitHub-fmc999/Node__js--SUB-181717?logo=github)](https://github.com/fmc999/Node_js-SUB)
![CPU](https://img.shields.io/badge/CPU-1vCPU_AMD_EPYC--Genoa-f0f6fc?logo=amd)
![内存](https://img.shields.io/badge/内存-256_MB-f0f6fc)
![硬盘](https://img.shields.io/badge/硬盘-1_GiB-f0f6fc)
![网络](https://img.shields.io/badge/网络-1_Gbps-f0f6fc)
![系统](https://img.shields.io/badge/系统-Debian_12-f0f6fc?logo=debian)

一个基于 Node.js 的轻量级代理节点订阅聚合服务器，最低仅需 256MB 内存即可运行。支持从多个外部订阅源拉取节点、自动去重合并、定时更新，并通过 Base64 编码以标准订阅格式对外分发。内置现代化管理后台、伪装首页与博客系统，兼具安全性、隐蔽性与易用性。

---

## 目录

- [功能概览](#功能概览)
- [项目结构](#项目结构)
- [核心机制详解](#核心机制详解)
  - [多源订阅聚合](#多源订阅聚合)
  - [节点去重与存储](#节点去重与存储)
  - [Base64 订阅分发](#base64-订阅分发)
  - [定时自动更新](#定时自动更新)
  - [伪装首页系统](#伪装首页系统)
  - [博客系统](#博客系统)
  - [Web 管理后台](#web-管理后台)
- [安全防护](#安全防护)
- [快速开始](#快速开始)
  - [环境要求](#环境要求)
  - [启动服务](#启动服务)
  - [访问地址](#访问地址)
- [部署教程](#部署教程)
  - [一、上传项目到服务器](#一上传项目到服务器)
  - [二、直接部署（最小化）](#二直接部署最小化)
  - [三、Nginx 反向代理 + SSL](#三nginx-反向代理--ssl)
  - [四、PM2 进程守护 + 开机自启](#四pm2-进程守护--开机自启)
  - [五、后台首次配置指南](#五后台首次配置指南)
  - [六、防火墙放行](#六防火墙放行)
  - [七、验证部署](#七验证部署)
- [API / 路由说明](#api--路由说明)
- [数据文件说明](#数据文件说明)
- [注意事项](#注意事项)
- [参考来源](#参考来源)
- [许可证](#许可证)

---

## 功能概览

| 功能 | 说明 |
|------|------|
| **多源聚合** | 支持添加多个外部订阅链接，一键拉取全部或单个源，自动合并到节点池 |
| **智能去重** | 合并节点时通过 Set 精确去重，不会出现重复节点 |
| **定时自动更新** | 为每个订阅源设置独立更新间隔（分钟），服务器每 60 秒检查并自动拉取 |
| **Base64 分发** | 通过 `.uuidban` 后缀路径返回 Base64 编码的节点列表，兼容 Clash / V2RayN / Sing-box 等主流代理客户端 |
| **伪装首页** | 首页可设置为任意 HTML 页面，对外隐藏节点池服务的真实用途 |
| **简易博客** | 内置文章系统，可创建 / 编辑 / 删除文章，增加站点"正常感"以提升隐蔽性 |
| **Web 管理面板** | 现代化卡片式管理后台，Tab 切换 + 仪表盘统计，全功能通过 `/fmc` 操作 |
| **安全加固** | 路由白名单、SSRF 防护、路径穿越防护、请求体大小限制、安全响应头 |

---

## 项目结构

```
节点订阅池/
├── blog/
│   ├── server.js              # 主服务入口（HTTP 路由、订阅抓取、定时任务、安全防护）
│   ├── node.js                # 备用入口（空文件）
│   ├── server.log             # 服务运行日志
│   └── data/
│       ├── index.html         # 伪装首页（存在时覆盖默认博客首页）
│       ├── nodes.txt          # 节点池核心文件（每行一个节点链接）
│       ├── subscriptions.json # 订阅源配置（JSON 数组：url + interval）
│       ├── sources.json       # 订阅源备用配置（旧格式兼容）
│       └── posts/             # 博客文章目录（.txt 文件）
│           ├── hello.txt      # 示例文章
│           └── server.txt     # 示例文章
└── README.md                  # 本说明文件
```

---

## 核心机制详解

### 多源订阅聚合

服务支持配置多个外部订阅链接，每个订阅源存储格式：

```json
{
  "url": "https://example.com/subscription/link",
  "interval": 1440
}
```

| 字段 | 说明 |
|------|------|
| `url` | 外部订阅地址（代理服务商提供的订阅链接） |
| `interval` | 自动更新间隔（分钟），0 = 不自动更新，仅手动触发 |

所有外部源抓取到的节点合并写入 `nodes.txt`。

### 节点去重与存储

- 节点以每行一个的格式存储在 `nodes.txt` 中
- 合并时使用 `Set` 去重，时间复杂度 O(n)，比旧版 `Array.includes()` 效率更高
- 手动编辑节点通过管理后台文本框进行，直接修改 `nodes.txt`

### Base64 订阅分发

当客户端访问 `http(s)://服务器地址/任意名称.uuidban` 时：

1. 读取 `nodes.txt` 完整内容
2. UTF-8 编码后做 Base64 编码
3. 以 `text/plain` 格式返回

> **为什么用 `.uuidban` 后缀？** — 避免 `.txt` / `.json` / `.yaml` 等常见路径被轻易扫描和封禁，起到路径隐蔽作用。**注意**：路径形如 `/sub.uuidban`（带前导 `/`），不含多余斜杠。

### 定时自动更新

- 服务器启动后自动运行定时器，每 **60 秒** 检查一次所有订阅源
- 对 `interval >= 1` 的源，当 `当前时间 - 上次成功拉取时间 >= interval 分钟` 时触发自动拉取
- 自动拉取执行合并去重，控制台输出结构化日志 `[AutoFetch:OK]` / `[AutoFetch:ERR]`
- 仅记录成功拉取的时间戳，失败不更新时间，确保重试

### 伪装首页系统

如果 `data/index.html` 存在，访问首页 `/` 将直接展示该 HTML 内容，而非博客文章列表。

可通过管理后台 `/fmc` 自定义或替换为任意 HTML 页面（如企业站、404 伪装页等），对外完全隐藏节点池服务。

> 删除 `data/index.html` 后，首页自动恢复为博客文章列表。

### 博客系统

极简博客系统，用于给站点增加"正常内容"以提升隐蔽性：

- 文章以 `.txt` 格式存储在 `data/posts/` 目录
- 文件名（不含扩展名）即为文章标题
- 支持创建、编辑、删除文章

### Web 管理后台

访问 `/fmc` 进入现代化管理面板：

| 特性 | 说明 |
|------|------|
| **仪表盘** | 4 格统计卡片：节点总数、订阅源数、文章数、伪装页状态 |
| **Tab 切换** | 文章管理 / 首页伪装 / 代理节点 / 订阅源池，四栏无刷新切换 |
| **暗色主题** | GitHub 暗色风格，渐变背景，卡片式布局，响应式适配移动端 |
| **文章管理** | 新建、编辑、删除文章，文件名 + 内容双向编辑 |
| **首页伪装** | 创建 / 编辑伪装页 HTML |
| **代理节点** | 手动编辑节点列表（文本域） |
| **订阅源池** | 添加订阅链接（含间隔设置）、删除、单源更新、全部更新、修改间隔 |

---

## 安全防护

本版本已进行完整的安全审计与加固。

| 防护项 | 说明 |
|--------|------|
| **路由白名单** | 仅允许 `/`、`/fmc`、`/post`、`*.uuidban` 四条路由，其余一律 404 |
| **HTTP 方法限制** | 仅允许 GET / POST / HEAD，其余返回 405 Method Not Allowed |
| **SSRF 防护** | `fetchExternalSubscription` 校验 URL 协议仅限 http/https，屏蔽 localhost / 127.0.0.1 / 10.x / 192.168.x / 172.16-31.x / .local 等内网地址 |
| **路径穿越防护** | 所有文件读写通过 `path.resolve()` + `startsWith()` 严格限制在 `data/` 目录内，防止 `../` 逃逸 |
| **请求体大小限制** | POST 请求体限制 1MB，超出直接销毁连接，防止内存耗尽 |
| **安全响应头** | 全局注入 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`X-XSS-Protection`、`Referrer-Policy: no-referrer`、移除 `X-Powered-By` |
| **XSS 防护** | 所有用户输入在渲染 HTML 前经过 `escapeHtml()` 转义（`& < > "`） |
| **抓取超时** | 外部订阅请求 30 秒超时，防止悬挂连接 |
| **优雅退出** | 监听 SIGTERM / SIGINT 信号，关闭 server 后退出 |

---

## 快速开始（零基础版）

如果你不太熟悉 Linux 命令，跟着下面的步骤一步一步来，每步都有解释和预期结果。

### 环境要求

- **一台服务器**：Linux（Ubuntu/Debian/CentOS 均可），至少 256MB 内存
- **一个域名**（可选但推荐）：用于配置 HTTPS，没有的话直接用 IP 也行
- **你的电脑**：Windows/Mac 均可，需要能 SSH 连到服务器

### 第 1 步：安装 Node.js

项目只需要 Node.js，版本 >= 12 就行（建议装 18 或 20）。

```bash
# 连接到你的服务器（在你的电脑上打开终端/CMD执行）
ssh root@你的服务器IP

# 安装 Node.js 20.x（长期支持版）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs
```

验证装好了没：

```bash
node -v
# 预期输出类似：v20.11.0（版本号 >= 12 即可） 
```

> **常见问题**：如果 `curl` 报 command not found，先执行 `sudo apt-get install -y curl`

### 第 2 步：把代码传到服务器

在你的 **Windows 电脑**上打开 PowerShell（不是 CMD），执行：

```powershell
# 上传 blog 文件夹到服务器的 /root/Node_js-SUB/blog/ 目录下
scp -r C:\Users\Administrator\Desktop\Node_js-SUB\blog root@你的服务器IP:/root/Node_js-SUB/blog/
```

- `scp` 是安全拷贝命令，`-r` 表示递归传整个文件夹
- 输入服务器密码后等待传输完成（文件很小，几秒就好）

传输完成后回到 **服务器终端**，确认文件已到位：

```bash
ls ~/Node_js-SUB/blog
# 预期输出：server.js  data/
```

### 第 3 步：启动服务（前台测试）

先在前台跑一下，确认没问题：

```bash
cd ~/Node_js-SUB/blog
node server.js
```

如果看到以下输出，说明启动成功：

```
[Server] running at http://localhost:80
[Server] data dir: /root/Node_js-SUB/blog/data
[Server] routes: / | /post | /fmc | *.uuidban
```

按 `Ctrl + C` 可以停止。

> **常见问题**：如果报 `EADDRINUSE` 错误，说明 80 端口被占用，改端口：
> ```bash
> vi server.js   # 按 i 进入编辑模式，把第 7 行 const PORT = 80 改成 const PORT = 3000
> # 按 Esc 然后输入 :wq 保存退出
> node server.js
> ```

### 第 4 步：改成后台运行（PM2 守护）

直接 `node server.js` 的话关掉终端服务就没了，用 PM2 可以让它一直跑：

```bash
# 安装 PM2
sudo npm install -g pm2

# 用 PM2 启动
cd ~/Node_js-SUB/blog
pm2 start server.js --name "node-pool"

# 设置开机自启
pm2 save
pm2 startup
# ↑ 执行完后屏幕上会输出一行命令，复制粘贴执行它

# 确认正在运行
pm2 list
# 预期输出：node-pool 状态为 online
```

重启服务：

```bash
pm2 restart node-pool
```

查看日志：

```bash
pm2 logs node-pool
```

### 第 5 步：放行防火墙

```bash
# 如果用的是 80 端口
sudo ufw allow 80/tcp

# 如果改成了 3000 端口
sudo ufw allow 3000/tcp

# 确认规则生效
sudo ufw status
```

> ⚠️ 如果你用的是阿里云/腾讯云等云服务器，**还需要去云控制台的"安全组"里放行对应端口**，不然外面访问不到。

### 第 6 步：打开管理后台

在浏览器访问：

```
http://你的服务器IP/fmc
```

应该能看到暗色主题的管理仪表盘，显示"0 个节点"。

### 第 7 步：添加订阅源并拉取节点

在管理后台的「📡 订阅源池」标签里：

1. 在「添加订阅链接」输入框填入你的外部订阅地址
2. 间隔填 `1440`（表示每 1440 分钟 = 每天自动拉取一次）
3. 点击「**添加**」
4. 点击「🔄 **更新全部**」立即拉取
5. 回到顶部仪表盘，确认"代理节点总数"已增长

### 第 8 步：获取你的订阅链接

```
http://你的服务器IP/sub.uuidban
```

把这个链接填入 V2RayN / Sing-box 等代理客户端即可。

如果是域名 + HTTPS 部署的：

```
https://你的域名/sub.uuidban
```

---

### 可选：绑定域名 + HTTPS

如果你买了域名，建议配置 HTTPS，安全性更好。详见下方 [部署教程 → Nginx 反向代理 + SSL](#三nginx-反向代理--ssl)。

---

## 部署教程

以下以 **Ubuntu / Debian 20.04+** 为例，CentOS 同理（包管理器替换为 `yum`）。

### 一、上传项目到服务器

**方式 A：Git 克隆（推荐，后续更新方便）**

```bash
git clone https://github.com/fmc999/Node_js-SUB.git ~/Node_js-SUB
cd ~/blog
```

**方式 B：SCP 上传**

```bash
# 在本地执行
scp -r c:/Users/Administrator/Desktop/Node_js-SUB/blog root@你的服务器IP:~/Node_js-SUB/blog/
```

**方式 C：直接 SCP 上传整个项目**

```bash
scp -r c:/Users/Administrator/Desktop/Node_js-SUB/blog root@你的服务器IP:~/Node_js-SUB/blog/
```

---

### 二、直接部署（最小化）

```bash
# 1. 安装 Node.js（如已安装跳过）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs

# 2. 验证安装
node -v   # 应 >= 18.x
npm -v

# 3. 进入项目目录
cd ~/Node_js-SUB/blog

# 4. 如需修改端口（80 端口可能被占用）
vi server.js   # 修改第 7 行 const PORT = 80 为其他端口如 3000

# 5. 启动服务（前台测试）
node server.js
```

看到输出即表示启动成功：

```
[Server] running at http://localhost:80
[Server] data dir: /root/Node_js-SUB/blog/data
[Server] routes: / | /post | /fmc | *.uuidban
```

按 `Ctrl+C` 停止。

---

### 三、Nginx 反向代理 + SSL

通过 Nginx 反向代理可以实现 HTTPS 访问，同时隐藏后端端口。

**1. 安装 Nginx 和 Certbot**

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

**2. 配置 Nginx**

```bash
sudo vi /etc/nginx/sites-available/sub-pool
```

写入以下内容（将 `example.com` 替换为你的域名，`3000` 替换为你的 `server.js` 端口）：

```nginx
server {
    listen 80;
    server_name example.com;   # 改为你的域名

    client_max_body_size 5m;       # 允许上传伪装页等大文件

    location / {
        proxy_pass http://127.0.0.1:3000;   # 改为你的实际端口
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**3. 启用站点 + 签发 SSL**

```bash
# 启用站点
sudo ln -s /etc/nginx/sites-available/sub-pool /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

# 测试配置
sudo nginx -t

# 重载 Nginx
sudo nginx -s reload

# 签发 Let's Encrypt 免费 SSL 证书
sudo certbot --nginx -d example.com   # 改为你的域名
# 选择 2 (Redirect) 强制 HTTPS
```

Certbot 会自动修改 Nginx 配置添加 SSL 并设置自动续期。

**4. 验证自动续期**

```bash
sudo certbot renew --dry-run   # 测试能否自动续期
```

---

### 四、PM2 进程守护 + 开机自启

直接 `node server.js` 会在终端关闭后退出，需要进程守护。

**1. 安装 PM2**

```bash
sudo npm install -g pm2
```

**2. 启动并添加开机自启**

```bash
cd ~/blog

# 启动
pm2 start server.js --name "node-pool"

# 保存进程列表
pm2 save

# 开机自启
pm2 startup
# 执行屏幕上输出的命令（通常是 sudo env PATH=...）

pm2 save
```

**3. PM2 常用命令**

| 命令 | 说明 |
|------|------|
| `pm2 list` | 查看所有进程 |
| `pm2 logs node-pool` | 查看日志 |
| `pm2 restart node-pool` | 重启服务 |
| `pm2 stop node-pool` | 停止服务 |
| `pm2 delete node-pool` | 删除进程 |

---

### 五、后台首次配置指南

部署完成后，按以下步骤完成初始化：

**1. 登录管理后台**

```
https://你的域名/fmc
```

**2. 添加订阅源**（必须！）

在「📡 订阅源池」标签 → 「添加订阅链接」：

- 填入你的外部订阅 URL（代理服务商提供的链接）
- 设置更新间隔（建议 1440 = 每天更新一次）
- 点击「添加」

**3. 拉取节点**

添加完成后，点击「🔄 更新全部」拉取节点。

> 成功后仪表盘「📦 代理节点总数」数字会增长。

**4. 设置定时自动更新**

每个订阅源卡片旁的输入框可以修改更新间隔，或在添加时就设置。设置为 1440（每天拉取一次）比较合理。

**5. 配置伪装首页**（可选）

在「🎭 首页伪装」标签：

- 点击「➕ 创建伪装页」
- 粘贴一个正常的 HTML 页面（企业站、个人博客、404 页面等）
- 保存后访问首页将展示该内容，不会暴露节点池

**6. 获取订阅链接**

订阅分发地址为：

```
https://你的域名/任意名称.uuidban
```

例如 `https://example.com/sub.uuidban`，填入 V2RayN / Sing-box 等客户端即可使用。

---

### 六、防火墙放行

```bash
# 如果 Node 直接监听 80 端口
sudo ufw allow 80/tcp

# 如果使用 Nginx + Let's Encrypt
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# 如果是自定义端口（如 3000）
sudo ufw allow 3000/tcp

# 启用防火墙
sudo ufw enable

# 查看状态
sudo ufw status
```

> 云服务器还需在**云服务商控制台的安全组**中放行对应端口。

---

### 七、验证部署

逐一验证以下地址：

| 验证项 | URL | 预期 |
|--------|-----|------|
| 首页 | `https://你的域名/` | 展示伪装页或博客列表 |
| 管理后台 | `https://你的域名/fmc` | 仪表盘正常显示 |
| 节点订阅 | `https://你的域名/sub.uuidban` | 返回一串 Base64 编码文本 |
| 订阅导入 | 在代理客户端导入上述地址 | 成功获取节点列表 |

在客户端导入时如果报 404：

```bash
# 1. 确认 nodes.txt 有内容
cat ~/Node_js-SUB/blog/data/nodes.txt | wc -l

# 2. 确认服务在运行
pm2 list

# 3. 查看实时日志
pm2 logs node-pool
```

---

## API / 路由说明

### 公开路由

| 路由 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 首页：存在 `index.html` 返回伪装页，否则返回文章列表 |
| `/*.uuidban` | GET | 返回 Base64 编码的节点列表 |
| `/post?name=xxx.txt` | GET | 显示指定文章内容 |

### 管理路由（`/fmc`）

| Action | 方法 | 说明 |
|--------|------|------|
| 无 | GET | 仪表盘主页 |
| `edit&type=nodes` | GET | 编辑节点文本域 |
| `edit&type=index` | GET | 编辑伪装页 HTML |
| `edit&type=post&file=xxx.txt` | GET | 编辑指定文章 |
| `newpost` | GET | 新建文章表单 |
| `save&type=...` | POST | 保存编辑内容 |
| `createpost` | POST | 创建新文章 |
| `delete&type=post&file=xxx.txt` | GET | 删除文章 |
| `addsubscription` | POST | 添加订阅源（url + interval） |
| `deletesubscription&index=N` | GET | 删除第 N 个订阅源 |
| `setinterval&index=N` | POST | 设置订阅源更新间隔 |
| `fetchsingle&index=N` | GET | 立即更新单个订阅源并合并 |
| `fetchall` | GET | 更新全部订阅源并合并 |
| `fetch` | POST | 旧版单次抓取（兼容保留） |

> 非白名单路由一律返回 404。

---

## 数据文件说明

| 文件 | 格式 | 说明 |
|------|------|------|
| `data/nodes.txt` | 纯文本，每行一个节点 | **节点池核心文件**，所有节点聚合存储于此 |
| `data/subscriptions.json` | JSON 数组 | 订阅源配置：`[{ url: string, interval: number }]` |
| `data/sources.json` | JSON 数组 | 订阅源备用配置（旧格式兼容，可忽略） |
| `data/index.html` | HTML | 伪装首页，存在时覆盖默认博客首页 |
| `data/posts/*.txt` | 纯文本 | 博客文章，文件名即标题 |

---

## 注意事项

1. **端口权限**：80 端口在 Linux 下通常需要 root 权限，建议使用 3000 以上端口并通过 Nginx 反向代理，或使用 `sudo` 启动。

2. **数据备份**：所有数据存储在 `data/` 目录，请注意定期备份此目录。

3. **订阅源 URL**：添加订阅源时系统会校验合法性——禁止内网地址、仅允许 http/https 协议。

4. **定时更新**：自动更新在「成功拉取」后才会更新时间戳，拉取失败的源会在下次检查周期重试。

5. **管理后台保护**：`/fmc` 无内置身份验证，建议通过 Nginx 添加 HTTP Basic Auth 或 IP 白名单保护。

6. **伪装页建议**：将 `index.html` 自定义为与代理无关的正常网站外观，以提高隐蔽性。默认伪装页为爱心弹窗动画页面。

7. **路由 Bug 修复备忘**：旧版路由白名单中包含 `!pathname.includes('/')` 条件，导致所有 `.uuidban` 路径（如 `/sub.uuidban`）被误判为非法路由返回 404。当前版本已移除该错误条件，路径穿越防护由独立的 `isPathSafe()` 函数负责。

---

## 参考来源

本项目灵感来源于 [CF-Workers-SUB](https://github.com/cmliu/CF-Workers-SUB) —— 一个基于 Cloudflare Workers 的节点订阅聚合工具。与其 Worker 方案不同，本项目基于 Node.js 自建服务器，适合自有 VPS 用户部署，无需依赖 Cloudflare 平台。

---

## 许可证

本项目仅供学习与研究使用，请遵守当地法律法规。
