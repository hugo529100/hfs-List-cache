# List-cache

List-cache 是给 [HFS](https://github.com/rejetto/hfs) 使用的列表缓存插件。它把大文件夹的完整文件列表预先取出、切成分页包保存，之后打开该文件夹时不再让 HFS 扫描整个目录，而是直接读取冻结好的列表。

适合：

- 几千到几万文件的音乐、图片、备份、离线网站目录
- 目录扫描很慢、首屏等待明显的文件夹
- 希望在冻结列表上继续使用 HFS 原生排序、评论、Fixed-folder-order、Hide-file 的场景

当前版本：**3.5**  
存储布局版本：**2.6**  
要求：HFS **3.4.1**（插件 API 12.3）或兼容版本

---

## 功能概览

- 超过阈值的文件夹自动冻结列表，不必手动登记
- 冻结列表按页切包，支持首屏快速打开
- 三档处理：小目录不冻结 / 第一级本地完整列表 / 第二级懒加载
- 第一级把完整列表载入浏览器，可做全列表排序、评论重排、FileShow 完整浏览
- 第二级只加载当前页，滚动继续取包，适合几千到几万文件
- 评论从 `descript.ion` 实时覆盖，修改评论不需要重建列表
- Fixed-folder-order 作为最高权重排序，第一级使用独立第二列表，第二级按已加载页处理
- Hide-file 规则在建立冻结列表时应用，规则变化会自动重建
- HFS 原生搜索 UI 保留；第一级用 HFS 原生搜索，第二级从冻结包搜索
- 页面右上角显示冻结信息（一行，宽屏与目录按钮共用底部）
- 原生统计标签在冻结模式中隐藏，避免与插件信息重复

---

## 安装

1. 把整个 `List-cache` 文件夹放到 HFS 的插件目录，例如：

   ```text
   HFS3/plugins/List-cache/
   ```

2. 在 HFS 的插件/Options 界面启用 **List-cache**。
3. 刷新页面。

插件没有额外的总开关：**在 HFS 插件列表中启用即生效**。

首次访问超过阈值的文件夹时，HFS 会正常生成一次列表，插件在旁边建立冻结副本；这次访问仍可能较慢。建立完成后，下一次访问开始使用冻结列表。

> 页面大小取自 HFS 的 `config.yaml` 的 `page_size`，不是插件面板里的独立选项。修改 `page_size` 后需要重启 HFS，旧冻结库会被整体清空并按新页大小重建。

---

## 三档行为

| 文件夹条目数 | 行为 |
|---|---|
| `<= minEntries`（默认 200） | 不冻结，完全走 HFS 原生列表 |
| `201 – localSortUpTo`（默认 5,000） | **第一级**：建立一份完整冻结库；浏览器一次载入完整列表，本地排序、本地分页 |
| `localSortUpTo + 1 – largeFoldersOver`（默认 5,001 – 10,000） | **第二级**：懒加载；只取当前页，滚动继续取包；使用普通有效期（默认 31 天） |
| `> largeFoldersOver`（默认 10,000） | 第二级懒加载，使用长有效期（默认 365 天） |

阈值比较是严格的“大于”：

- 200 条：不冻结
- 201 条：开始冻结
- 5,000 条：第一级
- 5,001 条：第二级
- 10,000 条：普通有效期
- 10,001 条：长有效期

如果 `localSortUpTo` 小于 `minEntries`，实际第一级上限会提升到 `minEntries`。

---

## 第一级：完整列表在浏览器里

适用：201 – 5,000 条（默认）。

1. 打开文件夹时，后端返回一份完整冻结列表。
2. 浏览器保存完整列表，并把它作为本地排序的主数据。
3. 页面仍然只渲染当前页（默认 50 条），不会一次生成几千个 DOM 节点。
4. 使用插件自己的分页条，不依赖 HFS 原生 pager。
5. 排序、翻页、评论重排都在浏览器里完成。

### 排序

第一级支持 HFS 的完整排序状态：

- `name`
- `extension`
- `size`
- `time`
- `creation`
- `invert_order`
- `folders_first`
- `sort_numerics`

排序会作用于**完整本地列表**，不是当前页。

### Fixed-folder-order 第二列表

Fixed-folder-order 在第一级不是每次都临时比较，而是建立一份**独立的第二列表**：

1. 先得到当前 HFS 排序下的原生顺序（base）。
2. 用 Fixed 的 `sortCompare` 做最高权重排序。
3. Fixed 认为相等的项目，保留 base 中的原始顺序，而不是重新按名称排序。

因此：

- 有 comment tag 的文件会被强制提前，顺序遵循 Fixed 的 `commentOrder`（例如 `top` → `3` → `2` → `1`）。
- 没有 tag 的文件保持原来的本地列表顺序。
- Fixed 的 comment tag、文件模式、文件夹模式都仍然是最高权重。
- Fixed 被关闭时，直接使用原生排序列表。

Comment 改变后会清除 Fixed 第二列表并重建；其他排序变化也会重建对应缓存。

### Fixed 插件设置

要让 comment tag 生效，需要：

1. HFS 启用 **Fixed-folder-order**。
2. 在其 Options 中开启 **Enable Custom Sorting**。
3. 配置 `commentOrder`，例如：

   ```yaml
   top
   3
   2
   1
   ```

4. `commentOrderEnabled: true`（默认配置）。

List-cache 不复制 Fixed 的配置，只在浏览器里调用 HFS 的 `sortCompare` 事件。

### FileShow / 图片浏览

第一级平时 `HFS.state.list` 只有当前页。打开 HFS 的 `.file-show` 对话框时，插件会暂时把完整本地列表放进 `state.list`，让 FileShow 可以左右浏览全部文件；关闭后恢复当前页。

### 头部信息

冻结模式会在 header 底部显示一行：

```text
Frozen list mode - local sort | FRO:11-25 / EXP:12-26 | 3,485 items / size: 98.4 MB
```

- 宽屏且右侧空间足够时，与目录按钮共用底部同一行。
- 窄屏或路径很长时自动回到独立一行。
- 原生 `#folder-stats` 统计标签隐藏，避免出现两个数量模块。
- `rebuild needed` 会替代 `local sort` 提示。

---

## 第二级：懒加载

适用：超过 `localSortUpTo`（默认 5,000）的文件夹。

- 打开时只请求第一页。
- 页面底部使用插件分页条；点击页码只读取对应包。
- 滚动接近底部自动追加下一页；在顶部向上滚动会补前一页。
- 排序控件被禁用，列表固定为冻结时的名称/文件夹顺序（由 HFS 配置决定）。
- Fixed-folder-order 只对**当前已加载的页**应用，不会对全库重排。
- 搜索请求由后端从冻结包中查找，评论搜索走 HFS 原生搜索。
- 大文件夹使用更长有效期。

第二级不会把完整列表载入浏览器，因此 FileShow 只能看到当前已加载窗口。

---

## 搜索与筛选

### 搜索

- **第一级**：把请求交给 HFS 原生搜索，直接在当前文件夹/磁盘上搜索。
- **第二级**：HFS 搜索请求由 List-cache 从冻结包中返回匹配项，分页也由冻结数据提供。
- **评论搜索**：始终走 HFS 原生搜索，因为评论可能在冻结后被修改。
- 搜索对话框可以显式选择 HFS 原生递归搜索（`lcNative`）。

### 筛选

- **第二级**：打开 HFS 原生筛选时，插件会加载完整冻结列表，再交给 HFS 原生过滤/分页。
- **第一级**：列表由插件分页器管理，HFS 原生筛选只作用于当前页；第一级暂未另做完整本地筛选。

---

## 评论

评论来自文件夹中的 `descript.ion`。

- 每次返回页面、完整列表或搜索结果时，插件都会读取当前 `descript.ion` 并覆盖评论字段。
- 因此修改评论**不需要重建冻结库**。
- 通过 HFS 界面修改评论时，当前列表会同步更新；第一级的 Fixed 第二列表也会失效并重建。
- 直接编辑 `descript.ion` 后，需要刷新页面（或重新访问文件夹）。
- 评论搜索始终使用 HFS 原生搜索。

---

## Hide-file

Hide-file 是前端插件；如果冻结列表绕过它，被隐藏的文件会重新出现。List-cache 的处理方式是：

- 建立冻结库时应用 Hide-file 规则。
- 计算规则的签名并写入 `meta.json`。
- 之后每次访问比较签名；规则变化时把冻结库视为过期并重建。
- 隐藏规则、启用列表等变化都会触发签名变化。

---

## 设置项

| 设置 | 默认值 | 说明 |
|---|---:|---|
| Freeze folders with more entries than | 200 | 超过此数量才冻结 |
| Load complete listing in the browser up to | 5000 | 第一级上限；超过则懒加载 |
| Valid for | 31 天 | 普通文件夹冻结列表有效期 |
| Very large folders over | 10000 | 超过后使用长有效期 |
| Valid for very large folders | 365 天 | 超大文件夹有效期 |
| Regenerate before | 空 | 早于该时间的列表在下次访问时重建；可选 |
| Debug log | 关闭 | 输出调试日志到插件日志和 `storage/debug.log` |

### 页面大小

页面大小不在插件面板中设置，而是读取 HFS `config.yaml` 的 `page_size`。

- 插件启动时读取当前 `page_size`。
- `settings.json` 保存建库时使用的页大小。
- 页大小改变后，插件会清空整个冻结库，避免不同页大小的包混用。
- 修改后重启 HFS 生效。

---

## 重建与有效期

冻结列表会在以下情况视为过期：

1. 超过有效期（普通 31 天，超大 365 天）
2. 超过 `regenerateBefore` 指定的时间
3. 文件夹条目数已经不大于 `minEntries`（阈值上调后的旧库）
4. Hide-file 规则签名变化
5. 存储布局版本变化（`VERSION_TAG`）
6. HFS `page_size` 变化（启动时整体清库）

过期的列表在下次访问时重建。重建期间，已经启动构建的后续请求仍可读取旧副本；构建完成后切换到新副本。

> 调整 `minEntries` 后，旧的小目录冻结库不会继续作为冻结库使用；下一次访问会走 HFS 原生列表并清理旧记录。

---

## 存储结构

所有数据位于插件 storage 目录：

```text
storage/
  settings.json                 建库时使用的 pageSize
  folders.json                  uri -> { dir, count, updatedAt }
  version.json                  存储布局版本
  debug.log                     仅在 debug 开启时出现
  lists/
    <slug>-<hash>/
      <gen>/
        meta.json               format, uri, count, pageSize, updatedAt, gen, chunks, accounts
        c0000.json              一页，格式为 [["+", entry], ...]
        c0001.json
        ...
```

条目字段：

- `n`：名称；文件夹名以 `/` 结尾
- `c`：creation ISO 时间
- `m`：modified ISO 时间
- `s`：大小
- 评论可能在建库时写入包中，但每次读取都会用当前 `descript.ion` 覆盖；因此评论修改不需要重建

### 版本号规则

- `exports.version` 是插件信息版本，**不会**清空冻结库。
- `VERSION_TAG` 是存储布局版本，只有 meta/chunks 格式变化时才应该修改；修改会清空所有冻结库。
- 不要为了 CSS、排序、头部显示等前端改动提升 `VERSION_TAG`。

---

## 权限与安全

- 冻结列表只是 HFS 已经生成的列表的缓存；**谁可以打开文件夹仍由 HFS 决定**。
- `meta.json` 记录已经由 HFS 服务过该文件夹的账号。
- 只有记录过的账号才能读取该冻结列表；其他账号仍走 HFS 原流程，并在 HFS 返回后记录。
- 根目录 `/` 不冻结。
- Hide-file 在建立列表时应用，避免缓存绕过隐藏规则。
- 评论覆盖读取源目录，遵循 HFS 的目录访问范围。
- 插件不改变 HFS 的认证、权限或密码逻辑。

---

## 内部接口

供前端和调试使用，HFS 会加上下划线前缀：

| 名称 | 用途 |
|---|---|
| `lc_meta` | 查询文件夹是否冻结、条目数、页大小、有效期、是否第一级 |
| `lc_page` | 按页读取冻结包 |
| `lc_all` | 读取完整冻结列表（第一级本地排序、筛选） |
| `lc_comment` | 读取/刷新评论信息 |

后端还挂接 HFS 的 `get_file_list` 请求，用于拦截普通列表请求。

---

## 文件结构

```text
List-cache/
  plugin.js              后端：捕获、切包、索引、有效期、Hide-file、评论覆盖、API
  public/main.js         前端：三档入口、第一级本地排序/分页、Fixed 第二列表、FileShow、搜索 UI
  public/style.css       头部信息、分页条、原生统计隐藏、窄屏适配
  README.md              本文件
```

无构建步骤，修改 `plugin.js` 后由 HFS 热加载；修改 `public/*` 后需要 **Ctrl+F5** 强制刷新浏览器缓存。

---

## 常见问题

### 第一次打开还是很慢

第一次访问需要 HFS 扫描并生成冻结副本，慢是正常的。建立完成后再次打开才会使用缓存。

### 文件夹没有冻结

- 条目数不超过 `minEntries`（默认 200）
- 是根目录 `/`
- 当前账号尚未被 HFS 服务过该文件夹
- 正在构建中

### 排序控件被禁用

第二级懒加载模式有意禁用排序，避免只对当前页排序造成错位。要使用完整排序，需要把 `localSortUpTo` 提高到覆盖该文件夹。

### Fixed 的顺序没有生效

检查：

1. Fixed-folder-order 是否启用
2. Options 中的 **Enable Custom Sorting** 是否开启
3. `commentOrderEnabled` 是否为 true
4. 文件是否真的有 `descript.ion` 评论
5. 第二级只对已加载页生效；第一级才使用完整第二列表

### 修改评论后顺序没变

- 通过 HFS 界面改评论：当前页会刷新，第一级 Fixed 列表会重建
- 直接改 `descript.ion`：刷新页面
- 评论搜索使用 HFS 原生搜索，不走冻结库

### 修改了 page_size 后缓存全没了

这是预期行为：不同页大小的包不能混用，插件启动时会清空冻结库。

### 想强制重建全部

停止 HFS 后删除：

```text
plugins/List-cache/storage/lists/
plugins/List-cache/storage/folders.json
```

再启动 HFS。`version.json` 和 `settings.json` 可以保留；删除 `version.json` 也会触发清库。

### 头部出现两个数量

原生统计标签已在冻结模式隐藏；如果仍看到，强制刷新 CSS/JS（Ctrl+F5）。

---

## 已知限制

- 第一级会把完整列表载入内存，适合到 `localSortUpTo` 为止；默认 5,000。
- 第一级 HFS 原生筛选只作用于当前页，完整本地筛选尚未实现。
- 第二级 FileShow 只能浏览已加载窗口。
- 第二级排序控件禁用，Fixed 只作用于当前页。
- 评论从 `descript.ion` 读取；外部修改后需要刷新。
- 超过 3,000,000 条的极端目录会触发捕获安全上限。

---

## 开发说明

- 后端入口：`plugin.js` 的 `exports.init(api)`
- 前端入口：`public/main.js`、`public/style.css`
- 存储布局常量：`FORMAT`、`VERSION_TAG`
- 第一级判定：`meta.count <= localSortThreshold()`
- 第一级本地排序：`public/main.js` 的 `localPureOrder()` 与 `localOrderForCurrentSort()`
- Fixed 第二列表：`localOrderForCurrentSort()` 内部的稳定覆盖排序
- 修改后检查语法：

  ```bash
  node --check plugin.js
  node --check public/main.js
  ```

- 不要为纯前端改动提升 `VERSION_TAG`，否则所有冻结库会被清空并重建。

---

## 版本记录

### 3.5

- 三档分界：200 / 5,000 / 10,000
- 第一级完整列表本地排序、本地分页
- Fixed-folder-order 独立第二列表，Fixed 最高权重，原生顺序作 tie-breaker
- FileShow 在第一级临时取得完整列表
- 头部信息改为单行，宽屏与目录按钮共用底部
- 原生统计标签隐藏
- 移除插件内部总开关，HFS 启用插件即生效

存储布局：`VERSION_TAG = 2.6`，本次前端改动不清库。

---

## 相关项目

- HFS：<https://github.com/rejetto/hfs>
- 本插件仓库：<https://github.com/hugo529100/hfs-List-cache>
- 配套插件：Fixed-folder-order、Hide-file、Tree-nav、Musicplayer+
