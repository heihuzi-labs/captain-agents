# 选手联网三档（关 / 白名单 / 全开）：Codex 和 srt 能不能做、怎么写（实测，2026-10-09）

本机版本：codex-cli 0.162.0-alpha.2（ChatGPT 桌面应用自带的那份，`PATH` 里没有 `codex`，路径同 `XAGENTS_CODEX` 的默认值），srt（`@anthropic-ai/sandbox-runtime`）0.0.77，Node 24.13，macOS 15.7（Apple 芯片）。

要回答的问题：主人要给每个项目加联网开关，三档——关（现状）/ 白名单（只放行指定域名）/ 全开外网；无论哪一档，本机端口（127.0.0.1、::1、localhost、本机局域网地址、unix 套接字如 ssh-agent）都必须照旧挡住。

## 1. 结论（先看这里）

| 档位 | Codex（权限表 `xa`） | srt（Grok、Cursor） |
|---|---|---|
| 关 | 能，现状就是。不写 `network` | 能，`allowedDomains` 只留各家自家域名（现状） |
| 白名单 | **能，但有一个很容易踩的坑**：除了在权限表里写 `network`，启动参数还必须加 `--enable network_proxy`，否则域名表被无视，网络整个放开（实测，第 3.1 节）。写法：`network={enabled=true,domains={"域名"="allow"}}` | 能。`allowedDomains` 写域名。但要去掉 srt 环境里继承的 `HTTP_PROXY` 等变量，否则“域名解析到本机”的检查失效（第 4.2 节） |
| 全开外网 | **能**：`domains={"*"="allow"}`，外网全通、本机各种写法全挡。注意：官方说明写“`*` 会被拒”，本版本实测接受，属于没有承诺的行为 | **srt 自己做不到**：`allowedDomains` 不接受 `*`、`**`、`*.com`、网段，也不能省略 `network`。办法是 srt 的外部代理口（`httpProxyPort` / `socksProxyPort`）加一个我们自己写的“外网全开、本机全挡”的小代理（概念验证已通过，第 4.4 节） |
| 本机端口照旧挡 | 白名单和全开两档：直连一律被沙箱拒（EPERM），经代理的所有写法被代理拒（403）；未发现绕过 | 白名单和外部代理两档同样；**但有两条绕过要处理**：继承上游代理环境变量、测试用的这台机器的“域名假地址”环境（第 5 节） |

**测试用的这台机器的特殊情况（务必先读第 5.1 节）**：系统里的代理软件用了 TUN + 域名假地址（普通域名在本机解析出来是 `198.18.x.x`）。结果是：
- Codex 的白名单、全开两档，**对普通域名一律失败**（被当成内网地址拦住），只有 IP 写法和“代理软件不给假地址的域名”能通。
- srt 的“域名解析到本机”检查在这里看不见真实去向，白名单里放 `*.localtest.me`、`*.nip.io` 这类域名就能连到本机端口（实测命中）。

## 2. 测试环境和方法

- 每条探针都在**隔离里**跑，同时在隔离外跑了基线（全部连得上），证明探针本身有效。
- 在隔离外起临时监听（Node 双栈 TCP，随机端口，127.0.0.1、::1、本机局域网地址都连得上；另有一个 unix 套接字）。每个请求写日志，作为“确实连到了”的第二份证据，下面表里“监听命中”指这份日志。
- 真 Chrome 调试口（9222）、本机代理软件的口、ssh-agent 套接字：**只做 TCP/套接字握手，不发任何数据**。
- 探针脚本（临时、已删）做四件事：①直连（`net.connect`，不经代理）；②HTTP 代理 `CONNECT`；③HTTP 代理普通转发；④SOCKS5（域名写法和 IP 写法）。单点复核用 `curl -sS -m 12 -o /dev/null -w 'http=%{http_code} connect=%{http_connect}' <地址>`。
- 目标集合：外网（白名单内/外的真实 IP 域名、`1.1.1.1:443`、被假地址的 `registry.npmjs.org`、`example.com`）；本机（`127.0.0.1`、`localhost`、`LOCALHOST`、`[::1]`、`0.0.0.0`、本机局域网地址、十进制 `2130706433`、`127.1`、`0x7f.1`、`[::ffff:127.0.0.1]`、`127.0.0.1.`（末尾点）、监听端口、`:9222`、本机代理软件口、unix 套接字、ssh-agent）；“域名解析到本机”：`hosts-local.example`（本机 `/etc/hosts` 指到 127.0.0.1）、`localhost.ptlogin2.qq.com`（公网 DNS 直接给 127.0.0.1）、`a.localtest.me`、`127.0.0.1.nip.io`、`foo.localhost`。
- Codex 两种跑法：
  1. `codex sandbox -P xa -C <目录> -c '<权限表>' -- <命令>`（selfcheck 现在用的）；
  2. `codex exec --ignore-user-config --skip-git-repo-check --ephemeral -c 'model_providers.mock={...指向本机假接口...}' -c model_provider="mock" -c default_permissions="xa" -c '<权限表>' -C <目录> --json [--enable network_proxy] "<提示>"`。我在本机起了一个最小的假模型接口（Responses 协议），让“模型”调用 `exec_command` 去跑指定命令，这样命令是在真正的 `codex exec` 隔离里跑的，也带真正的联网代理。全程用**空的临时 `CODEX_HOME`**，没有登录，没碰任何真实模型。
- 权限表用仓库里 `codexPermissions()` 原样生成，只在最后加 `,network={...}`。
- srt：`node dist/cli.js --settings <临时设置文件> <命令>`。分两种环境各跑一遍：①清掉 `HTTP_PROXY` 等变量；②保留主人环境里的 `HTTP_PROXY`（派活时 `workerEnv` 会原样带进去，因为名字不带密钥字样）。

## 3. Codex

### 3.1 配置写法和实测到的行为

| 想要的档位 | 权限表里加 | 启动参数 | 实测 |
|---|---|---|---|
| 关 | 不加 `network` | 无 | `codex sandbox` 和 `codex exec` 两种跑法下，本机监听、外网全部连不上；开着 `network_proxy` 功能时也一样（关档不受功能开关影响） |
| 白名单 | `network={enabled=true,domains={"time.android.com"="allow"}}` | `--enable network_proxy`（等价 `-c features.network_proxy=true`） | 白名单内通，白名单外 403，本机全挡（3.2 表） |
| 全开外网 | `network={enabled=true,domains={"*"="allow"}}` | 同上 | 外网通，本机全挡（3.3 表）。`"**"` 也被接受 |
| **（反例）`codex exec` 忘了加启动参数** | `network={enabled=true,domains={…}}` | 无 `--enable network_proxy` | **整个网络放开，域名表被无视**：本机监听回 HTTP 200，白名单外的真实 IP 域名也直连成功；命令环境里没有任何联网代理变量，没有报错 |
| **（反例）`codex sandbox -P` 不起联网代理** | `network={enabled=true}`（带不带 `domains` 都一样） | 无 | **整个放开**：本机监听（所有写法）、真 Chrome 9222、本机代理软件口、外网、unix 套接字、ssh-agent 全部连上 |

要点：
1. `network.domains` 的值是 `"allow"` / `"deny"`，**deny 优先**（实测：`"*"="allow"` 加 `"time.android.com"="deny"`，前者外网通、后者被拒，提示“明确拒绝”）。
2. 开了 `network_proxy` 之后，Codex 在沙箱**外**起一个 HTTP 代理和一个 SOCKS5 代理（本机随机端口，无口令），命令环境里被设上 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`（指向这两个口）、`NO_PROXY=`（置空）、`CODEX_NETWORK_PROXY_ACTIVE=1`、`CODEX_NETWORK_ALLOW_LOCAL_BINDING=0`。沙箱只放行连这两个口，其他直连（含外网 IP、本机监听、unix 套接字）一律 EPERM（实测）。
3. **`codex sandbox` 看不到域名白名单**：它不起联网代理，所以 selfcheck 现在这套 `codex sandbox -P xa` 的探针没法验证白名单和全开两档。要验这两档必须走 `codex exec`（我这次的假接口做法）。
4. 被代理拒掉的请求，Codex 会把这条命令判为失败（退出码 -1），并在输出末尾附一句“Network access to "X" was blocked: …”；有时命令已被直接结束。选手模型会看到这句话。
5. 请求头 `x-unix-socket: <路径>`（代理的一个功能，能把请求转给本机 unix 套接字）：默认被拒（403），监听无命中。配置项 `unix_sockets`、`dangerously_allow_all_unix_sockets` 保持默认即可。
6. `allow_local_binding=true`（实测）：本机所有环回口放开直连（监听、真 Chrome 9222、本机代理软件口，连本机局域网地址也通），外网直连仍挡、unix 套接字仍挡。**这一项必须保持默认的 false。**
7. 官方说明（`openai/codex` 仓库的 `network-proxy/README.md`，经 context7 取得）和实测不一致的地方：说明写“全局 `*` 会被拒”，本版本实测接受 `*`、`**`、`*.com`，都按预期放行。说明里“解析到内网/本机的域名即使写进白名单也拦”实测成立。
8. 官方文档网页（`developers.openai.com/codex/permissions`，现跳到 `learn.chatgpt.com/docs/permissions`）两次抓取都超时，没读到；上面的依据是仓库里的说明、二进制里的配置键名（`NetworkToml` 共 13 个字段：`enabled`、`proxy_url`、`enable_socks5`、`socks_url`、`enable_socks5_udp`、`allow_upstream_proxy`、`dangerously_allow_non_loopback_proxy`、`dangerously_allow_all_unix_sockets`、`domains`、`unix_sockets`、`allow_local_binding`、`mitm` 等）和实测。

### 3.2 白名单档（`domains` 写了 `time.android.com`、`registry.npmjs.org`、`hosts-local.example`、`localhost.ptlogin2.qq.com`）

命令：`codex exec … --enable network_proxy`，让假模型跑 `curl -sS -m 12 -o /dev/null -w '…' <地址>`（走 Codex 设的代理环境变量）。

| 目标 | 结果 | 监听命中 |
|---|---|---|
| `https://time.android.com/`（白名单内，真实公网 IP） | 通：`connect=200`，真服务器回 404 | — |
| `https://time.cloudflare.com/`（白名单外，真实 IP） | 拒 403：domain is not on the allowlist | — |
| `https://1.1.1.1/`（白名单外 IP 写法） | 拒 403：不在白名单 | — |
| `https://registry.npmjs.org/`（**写在白名单里**，本机解析成假地址） | 拒 403：local/private network addresses are blocked | — |
| `127.0.0.1`、`localhost`、`LOCALHOST`、`[::1]`、`0.0.0.0`、本机局域网地址 | 全部拒 403：local/private network addresses are blocked | 无 |
| `2130706433`、`127.1`、`0x7f.1`、`[::ffff:127.0.0.1]`、`127.0.0.1.` | 全部拒 403（有的提示里已规范成 `127.0.0.1`） | 无 |
| `hosts-local.example`（`/etc/hosts` 指 127.0.0.1，**写在白名单里**） | 拒 403：local/private | 无 |
| `localhost.ptlogin2.qq.com`（公网 DNS 给 127.0.0.1，**写在白名单里**） | 拒 403：local/private | 无 |
| 真 Chrome 调试口 `127.0.0.1:9222` | 拒 403 | — |
| 带头 `x-unix-socket: <本机套接字>` 的转发 | 拒 403 | 无 |
| 直连（绕过代理）：本机监听、局域网地址、9222、本机代理软件口、`1.1.1.1:443`、unix 套接字、ssh-agent | 全部 EPERM（被沙箱直接拒） | 无 |

### 3.3 全开档（`domains={"*"="allow"}`）

| 目标 | 结果 | 监听命中 |
|---|---|---|
| `https://time.cloudflare.com/`（任意真实 IP 域名） | 通：`connect=200` | — |
| `https://time.android.com/` | 通：`connect=200`，回 404 | — |
| `https://1.1.1.1/` | 通：`connect=200`，回 301 | — |
| `https://registry.npmjs.org/`、`https://example.com/` | **拒 403：local/private**（本机解析成假地址，见 5.1） | — |
| 本机各写法：`127.0.0.1`、`localhost`、`LOCALHOST`、`[::1]`、`0.0.0.0`、本机局域网地址、`2130706433`、`127.1`、`0x7f.1`、`[::ffff:127.0.0.1]`、`127.0.0.1.` | 全部拒 403：local/private | 无 |
| 域名解析到本机：`hosts-local.example`、`localhost.ptlogin2.qq.com`、`a.localtest.me`、`127.0.0.1.nip.io` | 全部拒 403：local/private | 无 |
| 真 Chrome `:9222` | 拒 403 | — |
| SOCKS5 路径（`curl -x "$ALL_PROXY"`）：`time.android.com` 通；`127.0.0.1`、`localhost.ptlogin2.qq.com`、`[::1]`、局域网地址 | 通 / 全部拒 | 无 |
| 直连（绕过代理）：全部目标 | 全部 EPERM（外网直连也被拒，只能走代理） | 无 |
| 对照：`allow_upstream_proxy=true` 且保留主人的 `HTTP_PROXY` | 仍拒 403：`registry.npmjs.org`、`example.com`、`127.0.0.1` | 无 |

结论：**Codex 能做到“外网全开、本机全挡”**，本机各写法、借域名解析到本机的写法都挡住了。

## 4. srt（0.0.77）

### 4.1 B1：`allowedDomains` 能不能全放行

不能。配置校验直接报错，`srt` 拒绝启动（不会退回默认配置）：

| 写法 | 结果 |
|---|---|
| `["*"]`、`["**"]`、`["*.com"]` | 报错“Invalid domain pattern … `*.com` or `*` are not allowed” |
| `["0.0.0.0/0"]`（网段） | 同样报错 |
| 不写 `network` / 写 `network:{}` / 不写 `allowedDomains` | 报错“Required”（不能靠省略变成“不限制”） |
| `["1.1.1.1"]`（IP 字面量） | 接受 |
| `["*.example.com"]` | 接受（子域，至少两段）；`*.localhost` 报错（只有一段） |

只有 srt 作为库调用时，省略 `allowedDomains` 才等于不限制（源码里 `(allow network*)` 的分支，连本机端口也一起放开）；命令行不走这条路。

### 4.2 B2：白名单档，本机挡不挡

设置：`allowedDomains:["time.android.com","registry.npmjs.org","localhost.ptlogin2.qq.com","hosts-local.example"]`。直连用的是同一套沙箱规则（只放行连 srt 自己的代理口），`allowedDomains:[]` 的基线实测全部 EPERM（外网、本机、unix 套接字、ssh-agent 都连不上）；下表是经代理的结果。

| 目标 | 清掉上游代理环境变量 | 保留主人的 `HTTP_PROXY`（上游代理） | 监听命中 |
|---|---|---|---|
| `time.android.com`、`registry.npmjs.org`（白名单内；后者本机是假地址） | 通（隧道建立） | 通 | — |
| `example.com`、`time.cloudflare.com`、`1.1.1.1`（白名单外） | 拒 403 blocked-by-allowlist | 同 | — |
| `127.0.0.1`、`localhost`、`LOCALHOST`、`[::1]`、`0.0.0.0`、局域网地址、`2130706433`、`127.1`、`0x7f.1`、`[::ffff:127.0.0.1]`、`127.0.0.1.`、`:9222`、本机代理软件口 | 全部拒 403 blocked-by-allowlist（HTTP CONNECT、转发、SOCKS5 三条路一致） | 同 | 无 |
| `hosts-local.example`（白名单内，`/etc/hosts` → 127.0.0.1） | 拒 403 blocked-by-sandbox-runtime（解析后地址检查拦下） | 超时（没连到） | 无 |
| `localhost.ptlogin2.qq.com`（白名单内，公网 DNS → 127.0.0.1） | 拒 403 blocked-by-sandbox-runtime | **通到本机监听（CONNECT 和转发都命中）** | **有** |

“保留上游代理”那一列，白名单外的各种本机写法我只逐行核对了一部分（`127.0.0.1`、`localhost`、局域网地址、`[::ffff:127.0.0.1]`、`127.0.0.1.`、`:9222`、本机代理软件口、`example.com`，都是 403）；整轮的监听日志里**只有 `localhost.ptlogin2.qq.com` 命中**，其余写法零命中。

**发现 1：srt 有“解析后地址检查”**（源码 `resolved-address-guard.js`，README 同款说明）：放行的域名在拨出去之前先解析，落在环回、未指定、链路本地、多播、广播、云元数据、本机网卡地址的一律拒。**但检查对“经上游代理”的连接不做**（README 自己写明）。srt 会把环境里的 `HTTP_PROXY`/`HTTPS_PROXY` 当上游代理，所以主人环境一带代理变量，检查就失效，上表最后一行就是证据。

**发现 2：假地址环境下检查看不见真实去向**（第 5.1 节），白名单放 `*.localtest.me`、`*.nip.io`（没有上游代理环境变量也一样）：

| 设置 `allowedDomains` | 目标 | CONNECT | 转发 | SOCKS5 | 监听命中 |
|---|---|---|---|---|---|
| `["*.localtest.me","localtest.me","*.nip.io","foo.localhost","time.android.com"]` | `a.localtest.me`、`127.0.0.1.nip.io` | **通到监听** | **通到监听** | **通到监听** | **有** |
| 同上 | `localtest.me` 本身 | **通到监听** | **通到监听** | 没测 | **有** |
| 同上 | `foo.localhost` | 拒 403（srt 对 `.localhost` 名字有特判） | 拒 | — | 无 |
| 同上 | 白名单外的本机各写法 | 全拒 | 全拒 | 全拒 | 无 |

### 4.3 B3：`allowLocalBinding` 和 unix 套接字相关选项（直连探针，`allowedDomains:[]`）

| 设置 | 本机 TCP | 外网直连 | unix 套接字 / ssh-agent |
|---|---|---|---|
| 默认 | 全 EPERM | EPERM | EPERM |
| `allowLocalBinding:true` | **放开**：`127.0.0.1`、`[::1]`、`0.0.0.0`、`localhost`、本机局域网地址、`2130706433`、`127.1`、`0x7f.1`、真 Chrome `:9222`、本机代理软件口，监听全命中（`[::ffff:127.0.0.1]` 仍 EPERM） | 仍 EPERM | 仍 EPERM |
| `allowAllUnixSockets:true` | 仍 EPERM | EPERM | **放开**：本机套接字命中，ssh-agent 套接字握手成功 |
| `allowUnixSockets:["<某套接字路径>"]` | 仍 EPERM | EPERM | 只放开那一个路径（本机套接字命中），ssh-agent 仍 EPERM |

作用：`allowLocalBinding` 打开的是“直连本机所有端口”（沙箱规则 `remote ip "localhost:*"`），绕过代理，**绝不能开**。unix 套接字三个选项默认全挡，也不能开。

srt 在沙箱里设的环境：`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` 都是 `http://srt:<口令>@localhost:<端口>`（SOCKS5 和 HTTP 复用同一个口），`NO_PROXY` 含 localhost 和内网段（客户端按它直连本机时会被沙箱拒掉）。

### 4.4 “外网全开、本机全挡”：srt 外部代理口 + 自己写的代理（概念验证）

设置：`network:{allowedDomains:[],deniedDomains:[],httpProxyPort:P,socksProxyPort:P}`，P 是我们自己的代理端口。**两个口都要给**，否则 srt 仍会起自己的过滤代理。沙箱只放行连 P，其余直连 EPERM（实测）。

我写了两版小代理（HTTP CONNECT + 普通转发；绑 `127.0.0.1` 随机口）：

| 版本 | 做法 | 结果 |
|---|---|---|
| 朴素版 | 用系统解析，丢掉环回/内网/保留段/本机网卡地址后再拨（198.18.0.0/15 不拦，否则所有域名都失败） | 外网全通。**被绕过**：`a.localtest.me`、`localtest.me`、`127.0.0.1.nip.io`、`127.0.0.1.`（末尾点）都连到了本机监听（假地址环境下系统解析给的是 198.18.x.x，真实连接由代理软件按域名完成） |
| 加固版 | 代理自己用加密 DNS 查询（DoH，问 `1.1.1.1`）拿真实 IP，检查后**用 IP 字面量去拨**；纯数字/十六进制写法和末尾带点的先规范化再用本机 `inet_aton` 解析 | 外网全通（`time.android.com`、`registry.npmjs.org`、`example.com`、`1.1.1.1`、`time.cloudflare.com` 隧道都建立）。本机各写法（含 `localtest.me`、`nip.io`、`127.0.0.1.`、`2130706433`、`127.1`、`0x7f.1`、`[::ffff:127.0.0.1]`、`[::1]`、`0.0.0.0`、局域网地址、`:9222`、本机代理软件口、`localhost.ptlogin2.qq.com`）全部 403；`localhost`/`LOCALHOST`/`foo.localhost` 查不到记录（502，等于拒）。`hosts-local.example`：加密 DNS 给出的是苹果的真实公网地址，隧道连到的是苹果的服务器，不是本机监听（本机 `/etc/hosts` 对它不起作用，因为不再用系统解析）。整轮监听零命中 |

另外各试了一次“公网 IP 当目的地、但 HTTP `Host` / TLS `SNI` 写成会解析到本机的域名”（`1.1.1.1:<监听端口>`，`Host`/`SNI` 为 `a.localtest.me`）：代理软件没有按嗅探到的域名改写目的地，监听零命中。

## 5. 发现的绕过风险

### 5.1 测试用的这台机器的假地址环境（最重要）

本机系统代理加 TUN，把绝大多数域名解析成 `198.18.0.0/15` 的假地址，真正的域名解析和拨号由代理软件完成。后果：
1. **检查地址的办法看不见真实去向。** srt 的解析后检查和我们的朴素代理都只看到 `198.18.x.x`，放行；代理软件再按域名自己解析，域名若指向 `127.0.0.1`，它就连到本机。实测命中。受影响的是“允许的域名里有人能控制 DNS”的情形：白名单里写了 `*.nip.io`、`*.localtest.me` 这类，或“全开”档（所有域名都允许）。
2. **Codex 反过来太严：** 它的代理把解析到 `198.18.x.x` 的域名当内网地址拦（实测 `registry.npmjs.org`、`example.com`、`a.localtest.me`、`127.0.0.1.nip.io` 都是这个提示），所以这台机器上 Codex 两档对普通域名全部失败（连 `registry.npmjs.org` 都不行），不会绕过，但也用不了。加 `allow_upstream_proxy=true`、保留 `HTTP_PROXY` 都没用。
3. 测试机的 `/etc/hosts` 里有公网域名指到 127.0.0.1（本文用 `hosts-local.example` 代称），是“域名解析到本机”的真实样本；`localhost.ptlogin2.qq.com` 是公网 DNS 直接给 127.0.0.1 且被代理软件豁免假地址的样本（不走假地址，所以 srt 的检查能拦住它）。

可行的缓解（取舍写在第 6 节）：①白名单只写 DNS 可信的固定域名（各家官方域名），不写 `*.nip.io`、`*.github.io`、`*.vercel.app` 这类开放子域给第三方的；②全开档用 4.4 的加固代理；③让代理软件对要放行的域名不用假地址（它的“假地址过滤名单”），再给 srt 加 `deniedResolvedAddresses:["198.18.0.0/15"]`（实测：加了之后 srt 对 `a.localtest.me`、`127.0.0.1.nip.io` 拒绝，同时 `registry.npmjs.org` 这类假地址域名也被拒，`time.android.com` 这类真实 IP 的照旧通）；④让代理软件自己拒绝环回和内网目的地（规则写法由主人的软件决定，**没测**）。

### 5.2 srt 继承上游代理环境变量

见 4.2：`HTTP_PROXY`/`HTTPS_PROXY` 被 srt 当上游代理，“解析后地址检查”对这条路径不做，白名单内且公网 DNS 指向本机的域名能连到本机。派活时 `workerEnv` 只去掉带密钥字样的变量，代理变量会原样带进 srt。

### 5.3 Codex 忘了加功能开关就整个放开

见 3.1 反例：`network={enabled=true,…}` 没有 `--enable network_proxy`，`domains` 被静默无视，网络（含本机端口、unix 套接字）全部放开，没有任何报错。这是三档里最危险的静默失败。

### 5.4 其他会放开本机的开关

Codex 的 `allow_local_binding=true`、srt 的 `allowLocalBinding:true`、`allowAllUnixSockets`、`allowUnixSockets`：打开即放开本机，设置里不许出现（生成配置时写死不写，自检里断言）。

## 6. 建议的实现做法

1. **三档存在项目设置里，派活时强制**：非“关”档必须先通过该档的专项自检；不过就不派（或降成“关”并告诉主人），不悄悄放宽。设置只能在底线之内收窄的原则不变：联网档位属于“放宽”，要主人明确开。
2. **Codex**
   - 关：不变。
   - 白名单：`codexPermissions()` 增加网络参数，生成 `network={enabled=true,domains={…}}`，域名逐个校验（合法域名，不含 `*`、不含空格引号），并在**同一处**返回启动参数 `--enable network_proxy`，保证两者永远成对出现；不写 `allow_local_binding`、`unix_sockets`、`dangerously_*`。
   - 全开：`domains={"*"="allow"}`，同样带 `--enable network_proxy`。由于 `*` 是没有承诺的行为，自检必须覆盖；`*` 将来被拒时 Codex 启动报错或空白名单，都是关着的，不会变宽。
   - 自检：现在的 `codex sandbox` 探针验不了这两档。要加一条走 `codex exec` 加假模型接口的探针（本次的做法），最小集合：①环境里 `CODEX_NETWORK_PROXY_ACTIVE=1`；②白名单内域名通、白名单外 403；③本机监听用 `127.0.0.1`、`localhost`、`[::1]`、局域网地址各一条都被拒、监听日志零命中；④直连 EPERM；⑤再用 `localtest.me` 写进白名单做“环境体检”（见下）。
   - 测试用的这台机器上先别开 Codex 的两档，或先在代理软件里对要放行的域名关掉假地址（第 5.1 节）。
3. **srt（Grok、Cursor）**
   - 关：不变。
   - 白名单：`allowedDomains` = 各家自家域名 + 项目域名；**启动前从 srt 的环境里去掉 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 及小写同名**（测试机有 TUN，srt 直连能通；没有 TUN、必须靠上游代理才能上网的机器要另议）；可选加 `deniedResolvedAddresses` 挡内网段（`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`100.64.0.0/10`、`fc00::/7`；这个选项本身测了，对内网段没测）；禁止开放子域给第三方的通配项。
   - 全开：用 4.4 的外部代理口方案，代理做成派活工作台的一个小模块：每件活起一个，绑 `127.0.0.1` 随机口，带口令，活结束就关；检查方式用加固版（DoH 取真实 IP、检查、用 IP 拨），拦环回、内网段、链路本地、多播、本机网卡地址；同一个口同时给 `httpProxyPort` 和 `socksProxyPort`（srt 把 `ALL_PROXY` 也设成 `http://`，SOCKS5 客户端没测）。
   - 设置里永远不写 `allowLocalBinding`、`allowUnixSockets`、`allowAllUnixSockets`。
4. **自检新增“环境体检”**：对每个开了联网的档位，在隔离里用 `localtest.me` 这类公网 DNS 指向 127.0.0.1 的域名（临时塞进该档的放行表，只在体检用的探针里）去连自检的临时监听；连得上就说明这台机器会被“借域名”绕过，这一档不许开（给出原因：请主人在代理软件里处理，或改用加固代理）。没联网、拿不准时按不通过处理。
5. 探针的做法改了就升自检缓存版本号（现有规矩）。

## 7. 没测到或拿不准

- 官方文档网页没读到（抓取超时），Codex 部分依据仓库里的代理说明、二进制里的字段名和实测。
- 真实派活的完整启动参数（那一串 `--disable`、`shell_environment_policy`）这次没带全，没有运行 `xagents run`，没有真模型参与。被拦之后真实选手的反应（反复重试、请求审批）没测。
- DNS 重绑定的“先给公网 IP、再给本机 IP”（短有效期）没测；Codex 的说明自己也承认挡不住。本机假地址环境下也构造不出来。
- 代理软件按嗅探到的域名改写目的地：只试了 HTTP `Host` 和 TLS `SNI` 各一次、目的地是 `1.1.1.1`，没改写；软件的实际配置不清楚，不能保证别的配置下也不改写。
- srt 的 `deniedResolvedAddresses` 只测了 `198.18.0.0/15`；内网段（10/8 等）没找到可解析到内网的带点域名来测。
- 自己写的代理只是概念验证：没做口令、没做 SOCKS5、没测 IPv6 公网目标、没压测；SOCKS5 客户端经 `ALL_PROXY=http://` 的行为没测。
- UDP（SOCKS5 UDP、QUIC）、ICMP、IPv6 公网目标：两边都没测。Codex 配置里有 `enable_socks5_udp`，没动。
- 选手在隔离里自己起本地服务（跑测试连 localhost）在联网档位下是否还能工作：没测。
- 只测了 macOS；Linux、Windows 完全没测。
- Grok、Cursor 本体没跑，srt 的行为是用 srt 命令行直接跑探针得到的。
- 联网档位用的 Codex 功能 `network_proxy` 目前标着“实验中”，升级后写法和行为可能变，需要每次升级重跑第 3 节的核心几条。

## 8. 清理情况

- 我起的三个临时进程（本机监听、假模型接口、自写代理）都已关闭，对应端口已无监听；本机套接字文件随临时目录删除。
- 临时目录（会话草稿目录）里所有我建的文件（脚本、设置文件、权限表、日志、结果、空 `CODEX_HOME`、二进制字符串提取文件、套接字）已全部删除，目录现在是空的。
- 没改主人真实的 `~/.codex`、`~/.grok`、`~/.cursor`、`~/.xagents`：Codex 的每条命令都带了临时 `CODEX_HOME`（只有 `--version`、`--help` 没带，它们只打印）；srt 用临时设置文件。这几个目录在测试期间有文件更新，是本机同时在跑的 ChatGPT 应用和别的派活进程写的，我无法逐个区分，但我没有向它们写任何东西。
- 没有读、没有输出任何密钥和登录文件内容；真 Chrome 调试口、本机代理软件口、ssh-agent 套接字只做了连接握手，没发数据；没有往钥匙串写东西。
- 仓库只新增了这一个文件，没有改代码、没有提交、没有碰 git。

## 9. 第二轮补测（2026-10-09）

设计文档 [design-network.md](../design-network.md) 第 9 节“实施顺序”第 1 步列了三件要先弄清的事，这一轮补测它们。环境同第 1 到 8 节（codex-cli 0.162.0-alpha.2、srt 0.0.77、macOS 15.7）。本机现状：这台机器的环境里有 `HTTP_PROXY`、`HTTPS_PROXY`（指向本机代理软件口），系统 DNS 把普通域名解析成假地址（这次实查：`registry.npmjs.org` 是 `198.18.0.117`，`example.com` 是 `198.18.0.182`，`a.localtest.me` 是 `198.18.0.194`；`time.android.com` 是真实地址 `216.239.35.x`，不被改写）。

### 9.1 先看这里（三个结论）

| 问题 | 结论 |
|---|---|
| 1. Codex 能不能把出口完全交给我们的看门小程序，绕开它自己的假地址检查 | **不能。** 命令只能连 Codex 自己随机起的两个代理口，没有任何字段能把看门口加进放行名单；`proxy_url`、`socks_url` 在这个版本里被忽略。唯一能做的是“第二道”：Codex 先按自己的规则检查（域名白名单加地址检查），通过的再转给看门口。但这不能解决假地址问题（检查在转发之前），所以这台机器上 Codex 的联网档位对 `registry.npmjs.org` 这类域名照样用不了。 |
| 2. cursor-agent 起的命令看不看得到 `CURSOR_AUTH_TOKEN` | **看得到。** 读源码：它给命令的环境是自己的整个环境，加几个固定变量，没有任何地方删掉 `CURSOR_AUTH_TOKEN`。设计里“全开档理论上能把 Cursor 的令牌带出去”对 Cursor 成立。 |
| 3. srt 的 `httpProxyPort` 和 `socksProxyPort` 填同一个口 | **可行。** srt 不再另起代理；隔离里 HTTP 类的变量（含 `ALL_PROXY`）都是 `http://localhost:口`，SOCKS5 客户端（`curl --socks5-hostname`、`nc -X 5`、`FTP_PROXY`）直接连同一个口。看门小程序按第一个字节分流实测可用，必须同时支持：HTTP 的 `CONNECT`、HTTP 明文转发、SOCKS5（无口令、只要 `CONNECT`、域名/IPv4/IPv6 三种地址）。 |

### 9.2 Codex：能不能把出口交给看门小程序

#### 做法

和第 2 节一样：`codex exec` 加本机假模型接口（最小的 Responses 协议服务，让“模型”依次调用 `exec_command` 跑指定命令），空的临时 `CODEX_HOME`，`--ignore-user-config --skip-git-repo-check --ephemeral`，权限表用仓库里的 `codexPermissions()` 原样生成、在最后接 `network={…}`。Codex 进程的环境用 `env -i` 重建（只带 `PATH`、`HOME`、`CODEX_HOME`、`TMPDIR`），需要时再单独加代理变量。

和第一轮不同的两点：
1. 假模型**一轮只发一条命令**。因为被 Codex 的代理拦下的请求会让整条命令被直接结束（第 3.1 节第 4 点），把多条探针写在一个脚本里，第一条被拦就全没了。
2. 看门小程序是一个最小的 Node 代理（只绑 `127.0.0.1`，按第一个字节分 HTTP 和 SOCKS5，用系统解析拨号，对环回和内网字面量一律拒绝并记录），记录收到的每个目标和请求头名字。另起一个双栈本机监听（127.0.0.1、::1、本机局域网地址都连得上）当“不该被连到的本机服务”，每个连接记一行。

每个组合都跑同一组探针：A 组是经 Codex 给的代理环境变量访问外网（`registry.npmjs.org`、`example.com`、`time.android.com`、`1.1.1.1`、`time.cloudflare.com`）；B 组是显式连看门口；C 组是经 Codex 的代理访问本机各写法（`127.0.0.1`、`localhost`、`[::1]`、`a.localtest.me`、局域网地址）；最后一条是直连（不经代理）本机监听、看门口、真 Chrome `:9222`、本机代理软件口、`1.1.1.1:443`，只做 TCP 握手，不发数据。

#### 逐个字段的结果

除特别写明外，都带 `--enable network_proxy`，`domains` 写了 `registry.npmjs.org`、`example.com`、`time.android.com`。表里“本机”指本机监听、`localhost`、`[::1]`、`a.localtest.me`、局域网地址；“监听命中”是本机监听自己的日志。

| 组合 | 命令里 `curl https://registry.npmjs.org/` | 看门口收到什么 | 本机各写法（经代理） | 直连 | 监听命中 |
|---|---|---|---|---|---|
| 对照：只写 `domains` | 失败：Codex 拦下（本机解析成假地址，判为“local/private”）。`time.android.com` 通 | 无 | 全拒 | 全 EPERM | 0 |
| `proxy_url="http://127.0.0.1:<看门口>"`（该口已被看门小程序占着） | 同上，失败 | 无 | 全拒 | 全 EPERM（含直连看门口） | 0 |
| `proxy_url`、`socks_url` 写成空闲的固定口 | 同上 | 无 | 全拒 | 全 EPERM | 0 |
| `allow_upstream_proxy=true`，并给 **Codex 进程**设 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 指向看门口 | 失败：Codex 在转发前就拦了，看门口一条都没收到。`time.android.com` 通 | `CONNECT time.android.com:443`（域名写法；请求头只有 `host`、`user-agent`） | 全拒（Codex 拦，没到看门口） | 全 EPERM | 0 |
| 同上，再把 `domains` 改成 `{"*"="allow"}` | 失败（同上）。`time.android.com`、`1.1.1.1`、`time.cloudflare.com` 都经看门口放行 | 对应的 `CONNECT`（域名或 IP 写法照原样） | 全拒 | 全 EPERM | 0 |
| 同上，但 Codex 进程的代理指向一个没人听的口 | `time.android.com` 隧道建不起来（TLS 握手断），**不会退回直连** | — | — | — | — |
| `allow_upstream_proxy=false`，Codex 进程仍设了代理 | `time.android.com` 通 | 无（Codex 直接出门，不理会） | 全拒 | 全 EPERM | 0 |
| `enable_socks5=false` | 同对照 | — | 全拒 | 全 EPERM | 0 |
| `dangerously_allow_non_loopback_proxy=true` | 同对照（代理口仍绑 127.0.0.1） | — | 全拒 | 全 EPERM | 0 |
| `mitm=true` | 配置报错：必须是一张表（`invalid type: boolean`） | — | — | — | — |
| `mitm={}` | 同对照 | 看门口看到的仍是原样的 `CONNECT`（没有钩子就不拦截） | 全拒 | 全 EPERM | 0 |
| **`allow_local_binding=true`**（不能用，再确认） | **通**（Codex 自己的假地址检查被关掉），看门口也收到 `CONNECT registry.npmjs.org:443` | 同左 | 经代理的本机各写法**全通** | **本机全部放开直连**：监听、Chrome `:9222`、代理软件口、看门口都连上；`1.1.1.1:443` 仍 EPERM | 4 |
| **不加 `--enable network_proxy`**，只写 `network={enabled=true,proxy_url=…,allow_upstream_proxy=true,…}`（不能用，再确认第 5.3 节） | 通（整个网络放开，域名表被无视，命令环境里没有任何代理变量） | 只有 `registry.npmjs.org` 一条（命令显式 `-x` 连看门口） | 全通 | 全放开：监听、`::1`、局域网、Chrome `:9222`、代理软件口、看门口、外网 `1.1.1.1:443` 都连上 | 5 |

补充观察：
1. `proxy_url`、`socks_url` 填什么都不起作用：命令环境里的 `HTTP_PROXY`、`ALL_PROXY` 始终是 Codex 每次随机起的口（如 `54518`、`54519`）。所以没有办法让“沙箱放行的那个口”变成我们的口。直连看门口在所有“带 `--enable network_proxy`”的组合里都是 EPERM。
2. `allow_upstream_proxy` 的上游是从 **Codex 进程自己的环境变量**里读的（`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`），不是权限表里的字段。Codex 进程自己的联网也会走这个代理：实测它自己的 `chatgpt.com:443`、`ab.chatgpt.com:443`、`github.com:443`（两次）都先到了看门口；本机假模型接口因此要用 `NO_PROXY=127.0.0.1,localhost,::1` 跳过，否则整个 Codex 起不来。真要这样接，看门口的放行表里还得有 Codex 自己的域名。
3. 看门口收到的 `CONNECT` 请求里没有任务标识，所以每件活必须单独起一个看门口（各自的端口）才能分清是谁的。
4. `enable_socks5=false` 时 `ALL_PROXY` 变成 `http://127.0.0.1:<口>`（不再是 `socks5h://`），其余不变。
5. 开了 `network_proxy` 后，Codex 给命令设的代理相关变量比第 3.1 节写的多：除 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`（及小写）、`NO_PROXY=`、`CODEX_NETWORK_PROXY_ACTIVE=1`、`CODEX_NETWORK_ALLOW_LOCAL_BINDING=0`、`CODEX_NETWORK_PROXY_ATTRIBUTION=<一个随机编号>` 外，还有 `WS_PROXY`、`WSS_PROXY`、`FTP_PROXY`（`socks5h://`）、`NODE_USE_ENV_PROXY=1`、`ELECTRON_GET_USE_PROXY=true`、`NPM_CONFIG_PROXY`、`NPM_CONFIG_HTTP_PROXY`、`NPM_CONFIG_HTTPS_PROXY`、`NPM_CONFIG_NOPROXY=`（及小写）、`PIP_PROXY`、`YARN_HTTP_PROXY`、`YARN_HTTPS_PROXY`、`BUNDLE_HTTP_PROXY`、`BUNDLE_HTTPS_PROXY`、`BUNDLE_NO_PROXY=`、`DOCKER_HTTP_PROXY`、`DOCKER_HTTPS_PROXY`，以及 `GIT_SSH_COMMAND`（`ssh -o ProxyCommand='nc -X 5 -x 127.0.0.1:<SOCKS 口> %h %p'`）。也就是说 npm、pip、yarn、bundler、Node 内置请求、git over ssh 都已经被 Codex 指向它自己的两个口了。

#### 为什么不能

1. 沙箱放行的口只有 Codex 起的两个代理口，字段里没有“再放行某个口”的办法；唯一放行本机口的字段是 `allow_local_binding`，它放开的是整个环回（含 Chrome 调试口和代理软件口），不能用。
2. Codex 的代理对每个域名都**先自己解析再判断**（文档里写的“best-effort DNS lookup”），解析到非公网地址就拦，`198.18.0.0/15` 被判成内网。这一步在“转给上游代理”之前，所以接了上游代理也一样。
3. 因此这台机器上能用的 Codex 联网档位只覆盖“不被代理软件改写成假地址”的域名（`time.android.com` 这一类）。`registry.npmjs.org`、`pypi.org` 等普通域名要么主人在代理软件里把它们加进“不用假地址”的名单，要么这台机器上 Codex 的白名单和全开两档不可选。

#### 能做到的“第二道”（可选，不建议现在做）

```
权限表：network={enabled=true,allow_upstream_proxy=true,enable_socks5=false,domains={…}}
启动参数：--enable network_proxy
Codex 进程的环境：HTTP_PROXY=HTTPS_PROXY=http://127.0.0.1:<这件活的看门口>
```

好处：Codex 放行的每个连接都会在看门口留一条记录（补上设计里“Codex 只记被拦的”的缺口），看门口还能用 DoH 再查一遍真实地址；上游不通时 Codex 会失败，不会退回直连。代价：Codex 自己的模型流量也要过看门口，看门口得放行 Codex 的几个自家域名；每次 Codex 升级要重测；而假地址问题一点没解决。结论：设计 3.2 节写的“做不到的话，派 Codex 联网活前先做环境体检”这条路要走，“让 Codex 也走看门小程序”这条先不做。

对设计的建议改动：
1. 3.2 节第 1 步的结果写进去：做不到。
2. 环境体检可以很简单：在 Codex 进程外用系统解析查白名单里的域名，落在 `198.18.0.0/15` 就判“这台机器上 Codex 的这一档用不了”，并告诉主人原因和两个出路（改用 Grok、Cursor；或在代理软件里把这些域名排除在假地址之外）。
3. 全开档在这台机器上 Codex 直接不可选（设计里已经写了）。

### 9.3 cursor-agent：命令看不看得到 `CURSOR_AUTH_TOKEN`

**看得到。** 按要求只读源码，没有运行 cursor-agent，没有碰令牌和钥匙串。

被读的文件：`~/.local/share/cursor-agent/versions/2026.10.01-14929f9/` 下的 `index.js`（压缩成了 414 行，行号意义不大，下面用“行:列”）和 `8657.index.js`；`cursor-agent` 本身只是 35 行启动脚本，里面没有 `unset`，也没有 `TOKEN`。

证据：

| 位置（`index.js` 第 414 行，列号） | 内容 |
|---|---|
| 5539177 | 命令环境的固定附加项：`TERM=dumb`、`NO_COLOR=1`、`FORCE_COLOR=0`、`_ZO_DOCTOR=0` |
| 5552895（bash 执行器）、5568118（zsh）、5576822（zsh 轻量）、5565277（简易终端） | 起命令用的环境都是 `{...process.env, ...固定附加项, ...本次附带的环境}`，**原样继承 cursor-agent 自己的整个环境** |
| 5535506 附近（cursor 自带的 `cursorsandbox` 包装层） | `{...process.env, ...本次附带的环境, CURSOR_SANDBOX:"native"}`；前面的 `b(e)`（5517631）只去掉 `ELECTRON_RUN_AS_NODE`；只有 Linux 才会去掉 SSH 套接字变量（`scrubSocketEnvVars`），macOS 不去 |
| 2855094（小型命令执行器） | `{...process.env, PAGER=cat, MANPAGER=cat, LESS=-R, PIP_PROGRESS_BAR=off, TQDM_DISABLE=1, CURSOR_AGENT=1}`，再经 `Xw` 只补 `CURSOR_RIPGREP_PATH` 和调整 `PATH` |
| `index.js` 第 8 行 1538070 | 读令牌：`process.env.CURSOR_AUTH_TOKEN`，只读，不删 |
| 全包搜索 | 全部 `index.js`、`8657.index.js` 里没有任何 `delete process.env.CURSOR_*`；唯一的 `delete process.env` 是调试开关 `DEBUG`（`index.js` 第 8 行 77697）；也没有以 `CURSOR_` 开头就过滤的写法 |
| 对比：`8657.index.js` 第 1 行 301941 | 给 MCP 外挂程序起进程时，明确去掉 `CURSOR_API_KEY`、`CURSOR_AUTH_TOKEN`（以及任何值里含这两个令牌的变量）。说明他们知道要去，但这个只管 MCP 外挂程序（这个文件里有 `CLOUD_AGENT_*` 变量名和“Exec-daemon”日志，看起来是云端或远程执行那条路，没有单独确认），命令这条路没有 |

对我们的含义：
1. `runner.ts` 第 77 行把 `CURSOR_AUTH_TOKEN` 放进 cursor-agent 进程的环境，所以选手在 Cursor 里跑的每条命令（`env`、`echo $CURSOR_AUTH_TOKEN`）都读得到它。`env.ts` 注释里写的“它跑的命令看得到这一个”是对的。
2. 联网档位下，它能用 curl 发到任意放行的地址：白名单档只能发到白名单里的网站，全开档能发到任何地方。设计第 6 节第一条（全开时登录可能被带走）对 Cursor 成立，建议设置页的说明里明确写“Cursor 的登录令牌在命令的环境变量里”。
3. 换成别的传法（文件、命令行参数）也没有用：命令同样读得到文件，命令行参数在 `ps` 里更显眼。想真正挡住只能是不让命令联网，或者令牌权限本身要小（Cursor 的令牌是主人的登录令牌，做不到）。
4. 没实测、源码里看到的一处：命令之间保存“shell 状态快照”时，会过滤掉名字里含 `_proxy=` 的行（`index.js` 第 414 行，状态导出脚本里的 `grep -viE '_proxy=|CURSOR_SANDBOX|…'`）。每条命令的基础环境仍然来自 `process.env`，所以 srt 设的代理变量按理还在；但真实 Cursor 选手在联网档位下，后续命令的代理变量会不会丢，得在实施时用真 Cursor 跑一次确认（丢了的话是连不上，不会漏）。

### 9.4 srt 外部代理口：`httpProxyPort` 和 `socksProxyPort` 填同一个口

#### 设置与隔离里的环境

设置：`network:{allowedDomains:[],deniedDomains:[],httpProxyPort:P,socksProxyPort:P}`，看门口只绑 `127.0.0.1`。源码（`sandbox-manager.js`）和实测都确认：两个口都是外部时 srt 不再起自己的代理，也不给代理网址加口令。

隔离里实际的环境（P 是看门口；外面 shell 里原有的 `HTTP_PROXY` 被**覆盖**，没有带进隔离）：

| 变量 | 值 |
|---|---|
| `HTTP_PROXY`、`HTTPS_PROXY`、`http_proxy`、`https_proxy` | `http://localhost:P` |
| `ALL_PROXY`、`all_proxy` | `http://localhost:P`（**是 http，不是 socks5h**，源码注释说是为了 Python 的 httpx 等没装 SOCKS 包时不崩） |
| `GRPC_PROXY`、`grpc_proxy`、`DOCKER_HTTP_PROXY`、`DOCKER_HTTPS_PROXY` | `http://localhost:P` |
| `CLOUDSDK_PROXY_TYPE`、`_ADDRESS`、`_PORT` | `http`、`localhost`、`P` |
| `FTP_PROXY`、`ftp_proxy` | `socks5h://localhost:P` |
| `RSYNC_PROXY` | `localhost:P`（rsync 用 HTTP `CONNECT`） |
| `GIT_SSH_COMMAND` | `ssh -o ControlMaster=no -o ControlPath=none -o ProxyCommand='nc -X 5 -x localhost:P %h %p'`（macOS 用 SOCKS5） |
| `NO_PROXY`、`no_proxy` | `localhost,127.0.0.1,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`（被覆盖成固定的一串；客户端按它直连这些地址时被沙箱拒掉） |
| 另有 | `SANDBOX_RUNTIME=1`、`JAVA_TOOL_OPTIONS=-javaagent:…srt-proxy-agent.jar …`（srt 的 Java 代理桥） |

#### 隔离里各种客户端实际怎么连（看门口按第一个字节分流）

| 客户端写法 | 实际发给看门口的 | 结果 |
|---|---|---|
| `curl https://registry.npmjs.org/`（走 `HTTPS_PROXY`） | HTTP `CONNECT registry.npmjs.org:443`，无口令 | 通 |
| `curl http://example.com/`（走 `HTTP_PROXY`） | HTTP 绝对地址转发 `GET http://example.com/…` | 通 |
| 去掉 `HTTP(S)_PROXY`，只剩 `ALL_PROXY` | HTTP `CONNECT example.com:443` | 通 |
| `curl --socks5-hostname localhost:P …`、`curl -x socks5h://localhost:P …` | SOCKS5 握手（方法 `[0,1]`：无口令加 GSSAPI），再 `CONNECT` 域名 | 通 |
| `curl --socks5-hostname u:p@localhost:P …` | SOCKS5 握手（方法 `[0,1,2]`），看门口选无口令（`0`） | 通 |
| `nc -X 5 -x localhost:P registry.npmjs.org 443`（`GIT_SSH_COMMAND` 同款） | SOCKS5 握手（方法 `[0]`），`CONNECT` 域名 | 通 |
| `curl --socks5 localhost:P …`（SOCKS5，**本地解析域名**） | 只发了握手，随后 curl 自己报“Could not resolve host”，没有 `CONNECT` | 失败：隔离里没有 DNS，只有 `socks5h` 这类“把域名交给代理解析”的写法能用，这与看门口无关 |
| `curl --socks5-hostname` 访问 `http://[::1]:口` | SOCKS5 `CONNECT`，地址类型是 **IPv6（16 字节）** | 见下面的提醒 |
| `curl --socks5-hostname` 访问 `http://127.0.0.1:口`、`http://localhost:口` | IPv4 / 域名 | 被看门口的本机检查拒绝，监听零命中 |
| 直连（`--noproxy '*'`）本机监听、局域网地址、`1.1.1.1:443` | — | 全 EPERM（沙箱只放行连 P） |
| Node 连 `localhost:P`，默认（自动换地址） | `localhost` 在隔离里解析成 `['::1','127.0.0.1']`（`::1` 在前） | 连上（自动换到 127.0.0.1） |
| Node 连 `localhost:P`，`autoSelectFamily:false`（不换地址） | 先连 `::1` | **ECONNREFUSED**（看门口只听 127.0.0.1）。让看门口再听 `::1` 的同一个口后：连上（隔离放行 `localhost:P`，`::1` 也在内） |

提醒：我的测试看门口按“字符串”检查本机地址，而 SOCKS5 里的 IPv6 地址是 16 字节二进制，curl 对 `[::1]` 发出的被我写成 `0:0:0:0:0:0:0:1`，**绕过了字符串检查，连到了本机监听**；`a.localtest.me`（域名，系统解析到本机）也连上了。这两条是测试代理自己太朴素，不是 srt 的问题，但它们说明正式的看门小程序必须：①SOCKS5 的二进制地址（IPv4、IPv6）先转成标准 IP 再做分类；②域名靠 DoH 查到的真实地址再判断。curl 对十进制 `2130706433` 之类的写法自己先转成了 `127.0.0.1` 再发，别的客户端未必，所以规范化仍然要做。

#### 只填 `httpProxyPort` 会怎样

只填 HTTP 口时 srt 仍会另起一个自己的代理（口和看门口不同），把 `FTP_PROXY`、`RSYNC_PROXY`、`GIT_SSH_COMMAND` 指向它；它按 `allowedDomains:[]` 全拒（实测 `curl --socks5-hostname` 经这个口得到失败）。所以不会漏，但 SOCKS5 客户端用不了，且多一个监听口。设计里“两个都要给”成立。

#### 看门小程序要支持什么（按这一轮实测）

1. **HTTP `CONNECT`**：`HTTPS_PROXY`、`ALL_PROXY`、`GRPC_PROXY`、`DOCKER_*`、`CLOUDSDK_*`、`RSYNC_PROXY` 全是这条，是主路径。
2. **HTTP 明文转发**（请求行是绝对地址）：`http://` 网址走 `HTTP_PROXY`。
3. **SOCKS5**：只要无口令方法（`0`），客户端同时报 `[0,1]`、`[0,1,2]` 都选 `0`；只要 `CONNECT` 命令；地址类型三种都要处理（域名、IPv4、IPv6）。不需要 SOCKS4、口令认证、`BIND`、UDP。
4. 第一个字节：`0x05` 走 SOCKS5，大写字母（`C`、`G`、`P`、`H` 等）走 HTTP，其他的关掉。实测按这个分流，三种路径都在同一个口上通了。
5. **监听 `127.0.0.1` 和 `::1` 的同一个口**，因为隔离里 `localhost` 先解析成 `::1`。
6. 外部口模式下 srt 不设口令：本机上任何进程都连得上看门口并借道上网。风险有限（它们本来就能上网），但看门口必须每件活一个随机口、只绑环回、活结束就关，且所有放行规则都在看门口里，不能靠“没人知道口”。

### 9.5 这一轮没测到或拿不准

- 官方文档网页仍没读到，Codex 的依据是仓库说明（经 context7 取得）、二进制字符串和实测。说明里 `proxy_url` 是“HTTP 代理监听地址”，本版本在 `codex exec` 受管模式下忽略它，未看到忽略的原因；独立运行的 Codex 代理程序或别的运行方式下可能生效，没测。
- `unix_sockets` 放行某个路径、`dangerously_allow_all_unix_sockets`、`enable_socks5_udp`：这一轮没测。unix 套接字路径在 macOS 上最长 103 个字符，会话草稿目录的路径太长，建不出符合条件的套接字，第一轮已测的“默认全挡”结论不变。
- 第 9.2 节“第二道”只测了 `time.android.com` 这类不被假地址的域名；没测过真实选手的整套启动参数（那一串 `--disable`、`shell_environment_policy`），也没测 Codex 自己的模型流量全部经过看门口时会多出哪些域名（只见到 `chatgpt.com`、`ab.chatgpt.com`、`github.com`，且是假模型、空登录下的）。
- Codex 进程里设代理后，`NO_PROXY` 对 Codex 上游选择的影响（能不能只把模型流量排除在看门口之外）没测。
- 一次 Codex 运行在启动阶段卡住（假接口一个请求都没收到，到 150 秒闹钟被杀），同样的配置重跑正常，原因不明；因此长时间运行时 Codex 经看门口上游的稳定性没有定论。
- 假地址范围里只确认了 IPv4 的 `198.18.0.0/15`（本机 `dscacheutil` 还查到 `registry.npmjs.org` 有 `2001:2::73` 这样的 IPv6 假地址，Codex 对它的判断没单独测）。
- 第 9.3 节是读源码的结论，没有真跑 cursor-agent；快照过滤 `_proxy=` 对后续命令的影响没验证。
- 第 9.4 节的看门口是测试用的最小实现，没做 DoH、规范化、端口限制、记录上限，也没压测；srt 对 SOCKS5 UDP、`BIND` 的行为没测。
- Linux、Windows 完全没测（srt 在 Linux 上经 socat 桥接，行为可能不同）。

### 9.6 清理情况（第二轮）

- 我起的进程：测试看门口、本机监听、假模型接口（每次 Codex 运行一个）、一次临时的 `::1` 监听，以及所有 `codex exec`、`srt` 运行，都已结束，没有残留，对应端口无监听。`ps` 里还能看到的几个 `codex exec`、`codex exec-server` 进程是别的派活会话和 ChatGPT 桌面应用自己的（带 `--disable plugins …` 等参数，启动时间与我无关），我没有动它们。
- 临时目录（会话草稿目录下的 `r2`）里我建的所有东西（脚本、设置文件、探针清单、日志、空的临时 `CODEX_HOME`、二进制字符串提取文件）已整个删除。
- 没改主人真实的 `~/.codex`、`~/.grok`、`~/.cursor`、`~/.xagents`：每次 Codex 运行都用临时 `CODEX_HOME` 和 `env -i` 重建的环境；`XAGENTS_HOME` 指向临时目录（生成权限表时用，实际没有创建任何文件）；srt 用临时设置文件。cursor-agent 只读了源码文件，没有运行。
- 没有读、没有输出任何密钥、令牌、登录文件内容；真 Chrome `:9222`、本机代理软件口、本机监听只做了 TCP 握手，没发数据；没有碰钥匙串。
- 仓库里只改了这一个文件（本节），没有改代码、没有提交、没有碰 git。
