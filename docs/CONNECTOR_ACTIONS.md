# Shiro connector — direct actions và Harness agent

Tài liệu này mô tả bề mặt MCP mà connector Shiro cung cấp cho ChatGPT: **128 action** (cộng thêm tool plugin DSH đăng ký ở layer global, xem "Kho plugin DSH" — trên máy tham chiếu là 134)
chia theo họ, quy ước schema/lỗi/phân trang, và ranh giới an toàn của từng nhóm.

## Direct Actions vs Harness Agent

Shiro có hai lớp thực thi, cố ý tách bạch:

| | **Direct action** | **Harness agent (`harness_start`)** |
|---|---|---|
| Cách chạy | Bridge tự làm, deterministic | Engine DeepSeek Harness chạy agent loop, ChatGPT đóng vai model |
| Gọi LLM | **Không bao giờ** | Có, nhiều lượt |
| Tạo durable session | Không | Có |
| Số lượt MCP cho một việc | 1 | `harness_start` → n × (`harness_get_request` + `harness_continue`) → `harness_status` |
| Phù hợp cho | đọc/ghi file, git, chạy lệnh, test, vòng đời process/fleet/tab | sửa nhiều file có suy luận, refactor, debug, lập kế hoạch |
| Phê duyệt | annotation `destructiveHint` + tham số `confirm` | `harness_respond` với `allowed-once` |

Nguyên tắc cho client: **direct action trước, Harness sau**. Nếu việc cần suy luận
thì mới trả tiền cho một Harness turn; còn lại thì một action là đủ. Harness vẫn là
đường duy nhất cho công việc lập trình thực sự — không direct action nào thay thế nó.

### Bảng ý định → action

| Muốn làm | Dùng | Không cần |
|---|---|---|
| Đọc một file | `fs_read` | `harness_start` |
| Liệt kê thư mục / tìm file theo tên | `fs_list` | `harness_start` |
| Tìm nội dung (grep) | `fs_search` | `harness_start` |
| Metadata + hash một path | `fs_stat` | `harness_start` |
| Tạo / sửa / xóa file dứt điểm | `fs_create_file`, `fs_update_file`, `fs_delete` | `harness_start` |
| Xem trạng thái repo | `git_status`, `git_repo_info` | `harness_start` |
| Xem diff / log / một commit | `git_diff`, `git_log`, `git_show`, `git_compare` | `harness_start` |
| Stage + commit một thay đổi đã biết | `git_add` → `git_commit` | `harness_start` |
| Chạy test | `test_run` (hoặc `task_run`) | `harness_start` |
| Xem repo khai báo những task nào | `task_list` | `harness_start` |
| Chạy đúng một lệnh | `exec_run` | `harness_start` |
| Bật dev server / watcher chạy nền | `process_start` → `process_logs` → `process_stop` | `harness_start` |
| Sức khỏe bridge, đang chạy gì | `bridge_status` | `harness_status` |
| Deployment này có action nào | `bridge_capabilities` | — |
| Sửa/refactor nhiều bước, cần suy luận | `harness_start` | — |
| Giao task coding dài cho project khác | `workspace_open` → `harness_start({workspace})` | copy repo vào Shiro |
| Làm việc trên một project khác (không phải repo Shiro) | `workspace_open` → mọi action kèm `workspace` | copy file vào repo Shiro |
| Chạy nhiều task song song không đụng nhau | `worktree_create` → `harness_start({workspace})` | clone lại repo |
| Lưu điểm an toàn trước khi làm liều | `worktree_snapshot` | `git stash` (đụng vào tree) |
| Chuyển việc dở dang giữa checkout | `worktree_handoff` | copy tay |
| Xem có thể mở những project nào | `workspace_list` (`include_candidates: true`) | — |
| Trả lời một chương trình đang hỏi (REPL, `gh auth`, installer, TUI) | `terminal_start` → `terminal_write` → `terminal_read` | `process_start` (không có stdin) |
| Ngắt một lệnh chạy quá lâu trong terminal | `terminal_write` (`keys: ["ctrl-c"]`) hoặc `terminal_signal` | `terminal_stop` |
| Tải một file/archive/dataset từ URL vào workspace | `download_file` | `exec_run` với curl/wget |
| Thực sự *nhìn* một ảnh | `image_open` | `fs_read` base64 |
| Kích thước/định dạng ảnh mà không tải bytes | `image_metadata` | `fs_stat` |
| Thực sự *nhìn* một trang PDF | `pdf_info` → `pdf_render_page` | trích text bằng CLI |
| Đọc lại một thread như dòng sự kiện | `thread_events` | `harness_session_log` (thô hơn) |
| Bẻ lái một turn đang chạy mà không hủy | `turn_steer` | `harness_cancel` rồi start lại |
| Thử một hướng khác từ giữa thread | `thread_fork` | copy prompt sang session mới |
| Dọn danh sách session dài | `thread_archive`, `thread_prune` | xóa transcript |
| Xem đợt chạy này được phép làm gì | `permission_get` | đọc launcher script |
| Tự siết quyền trước khi chạy việc lạ | `permission_set` | restart với profile hẹp |
| Xem thay đổi theo từng hunk | `review_diff` | `git_diff` (chỉ là text) |
| Nhận một hunk, bỏ một hunk | `review_stage_hunk`, `review_revert_hunk` | `git add -p` tương tác |
| Kiểm tra nhận xét review có đúng chỗ không | `review_findings` | — |
| Worker ChatGPT chạy định kỳ | `fleet_start` | `harness_start` |
| Đổi lịch/prompt của fleet đang chạy | `fleet_update` | `fleet_stop` + `fleet_start` |
| Làm mới hội thoại của một slot | `fleet_worker_recycle` | — |
| Giao việc cho Claude Code / Codex / Grok / Antigravity CLI thật, chạy nền | `subagent_start` → `subagent_status`/`subagent_log` | `harness_start` (đó là Shiro tự làm, không phải CLI khác) |
| Xem CLI nào cài + đăng nhập trước khi dispatch | `subagent_providers` | đoán rồi thử `subagent_start` |

## Khám phá capability và phiên bản

**Đừng giả định mọi deployment lộ cùng một tập action.** Gọi `bridge_capabilities`
trước, rồi mới dùng:

- `direct_actions_version` (số nguyên): tăng mỗi khi bề mặt direct action đổi hình dạng.
- `actions[]`: danh sách chính xác `{name, title, family, read_only, destructive, requires_confirmation}`.
- `features{}`: cờ bật/tắt cho hệ thống con tùy chọn — ví dụ `fleet` và `browser_tabs`
  là `false` khi deployment không cấu hình browser relay; mọi action họ `fleet`/`browser`
  khi đó trả `UNSUPPORTED`.
- `limits{}`: trần cụ thể (số turn đồng thời, kích thước fleet, byte đầu ra, số entry một trang…).
- `unsupported[]`: những thứ **cố ý không có**, kèm lý do, để client không thử lại.

`bridge_status` trả tình trạng chạy thực tế (uptime, số root turn đang chạy, số fleet,
số process bridge đang giữ, cờ health). Cả hai đều là read-only và không gọi LLM.

> ChatGPT cache danh sách tool theo từng app: sau mỗi lần đổi bề mặt MCP, mở
> `chatgpt.com/plugins` → app Shiro → Refresh/Save để nạp lại.

## Quy ước chung

**Đường dẫn.** Mọi tham số path là **tương đối** so với root của workspace đang dùng —
mặc định là project root cố định. Đường dẫn tuyệt đối, `..` vượt gốc, và symlink trỏ ra
ngoài đều bị từ chối bằng `OUTSIDE_SANDBOX` (kiểm tra sau khi resolve symlink, không chỉ
kiểm tra chuỗi). Payload trả về cũng dùng đường dẫn tương đối; đường dẫn tuyệt đối trong
hợp đồng công khai chỉ có `project_root` (`bridge_status`/`bridge_capabilities`) và
`path` của mỗi workspace (`workspace_list`/`workspace_open`).

**Workspace.** Action họ `filesystem`/`process`(exec+start)/`git`/`task`/`artifact`/
`media`/`network`/`terminal` nhận thêm tham số tùy chọn `workspace`. Bỏ trống = workspace
`project` (root cố định), tức mọi lời gọi cũ giữ nguyên hành vi. Chi tiết ở mục
**workspace** bên dưới.

**Lỗi.** Lỗi nghiệp vụ trả `isError: true` với shape ổn định
`{error: {message, code, retryable}}`. `code` thuộc tập cố định:

`NOT_FOUND` · `ALREADY_EXISTS` · `CONFLICT` · `INVALID_ARGUMENT` · `OUTSIDE_SANDBOX` ·
`PERMISSION_REQUIRED` · `TIMEOUT` · `PROCESS_FAILED` · `GIT_CONFLICT` · `BUSY` ·
`UNSUPPORTED` · `INTERNAL`

Chỉ `TIMEOUT` và `BUSY` mặc định `retryable: true`.

**Phân trang và cắt bớt.** Không action nào đổ dữ liệu không giới hạn. Khi chạm trần,
kết quả mang `truncated: true` kèm con trỏ đi tiếp: `next_cursor` (`fs_list`,
`fleet_runs`), `next_offset` (`fs_read`, `process_logs`, `logs_tail`),
`next_start_line` (`fs_read` chế độ dòng), `next_skip` (`git_log`).
`process_logs` còn báo `dropped_bytes` khi ring buffer đã bỏ phần cũ — không bao giờ
lặng lẽ nhảy cóc.

**Ghi an toàn tuần tự.** Mọi thao tác ghi file trả `sha256` của nội dung mới; truyền lại
làm `expected_sha256` ở lần ghi sau để có optimistic concurrency (file đã đổi → `CONFLICT`,
không ghi đè). `git_commit` nhận `expected_head` tương tự và trả SHA mới.

**Idempotency.** `fs_create_file` với nội dung y hệt → `unchanged: true` (không lỗi);
nội dung khác → `ALREADY_EXISTS`. `fs_mkdir` mặc định `exist_ok`. `git_branch_create`
với `checkout: true` trên nhánh đã có → chuyển nhánh, `created: false`.

**Phê duyệt — mặc định tắt.** Action phá hủy hoặc đi ra khỏi máy *có thể* đòi `confirm: true`
(danh sách: `fs_delete` recursive, `fs_move`/`fs_copy` overwrite, `artifact_delete`,
`git_restore`, `git_reset --hard`, `git_rebase --start`, `git_pull --rebase`, `git_push`,
`download_file`), nhưng cờ đó **mặc định không được thực thi**: trên máy của người vận
hành, một vòng "gọi → bị từ chối → gọi lại y hệt kèm `confirm: true`" không ngăn được gì —
cùng một client trả lời chính câu hỏi nó tự đặt ra — nên chỉ tốn một lượt round-trip.
`bridge_capabilities` báo `requires_confirmation` đúng như nó sẽ hành xử: `false` trừ khi
bật lại. Muốn giữ lại lớp phanh này (một client không tin cậy, hoặc vận hành đa người dùng),
đặt `SHIRO_REQUIRE_CONFIRMATIONS=1` trước khi khởi động.

## Kho plugin DSH — Shiro không có bề mặt cố định

ChatGPT Web không có khái niệm "skill" như Codex. Điều nó *có*, một khi đang nói chuyện với
Shiro, là một engine (DeepSeek Harness) đã mount sẵn nhiều plugin — nhưng trước đây kho đó
chỉ với tới được **từ bên trong một agent turn**: model dùng được trong lúc Shiro tự chạy
vòng lặp, còn ChatGPT (đóng vai model qua MCP) thì không.

**Phạm vi thật, đo trên máy đang chạy:** engine đăng ký tool theo *layer*. Mirror lấy
được **layer global** — nơi plugin cấp deployment đăng ký (hiện tại: 6 tool `memory_*` của
`@shiro-ai/dsh-memory`). Tool của agent (`fs`, `bash`, LSP, todo/plan, subagent…) nằm trong
**scope của từng agent preset**, không phải global, nên `schemas()` không-scope không thấy
chúng — đúng thiết kế: chúng sinh ra để chạy trong vòng lặp agent với một session sống, và
`harness_start` vẫn là đường tới chúng. Đây là giới hạn kiến trúc đã đo, không phải bug.

Bridge giải quyết bằng cách **soi gương** (`bridge/src/engine-tools.js`): mỗi tool trong
`ctx.tools.schemas()` của engine trở thành một MCP tool ngang hàng với `fs_read`, `git_status`
— cùng tên, cùng schema thật của chính plugin đó, gọi thẳng vào `ctx.tools.execute()` engine
dùng cho agent loop. Không danh sách tay: bộ tool tự lớn khi người vận hành mount thêm plugin,
tự nhỏ khi gỡ. Tên trùng với action Shiro có sẵn (hiếm, vd `fs_read` cả hai bên đều có) được
đổi thành `dsh_<tên gốc>` thay vì ghi đè — không bao giờ mất tool nào của bridge.

`bridge_capabilities` liệt kê chúng ở family `plugin`, và chúng đi qua **đúng permission
gate** như mọi action khác — `read-only` chặn được một plugin tool y như chặn `fs_update_file`.
Vì bridge không biết trước một plugin bất kỳ làm gì, mọi tool mirror được khai bảo thủ:
`read_only: false`, `destructive: false` — an toàn theo hướng "coi là có thể ghi" thay vì đoán
sai thành "chắc chắn chỉ đọc".

## Danh mục action

### bridge — sức khỏe và capability
| Action | Loại | Mô tả |
|---|---|---|
| `bridge_status` | read | Version, project root, uptime, root turn đang chạy, fleet, process, cờ health |
| `bridge_capabilities` | read | Danh sách action, feature flag, limit, mã lỗi, mục không hỗ trợ |

### workspace — nhiều root, vẫn trong allowlist
| Action | Loại | Mô tả |
|---|---|---|
| `workspace_list` | read | Workspace đang mở, allowlist của deployment, và (tùy chọn) các project có thể mở |
| `workspace_open` | write · idempotent | Đăng ký một thư mục **đã có** làm root địa chỉ hóa được; trả `workspace_id` |
| `workspace_create` | write · idempotent | Tạo thư mục trong allowlist rồi mở luôn |
| `workspace_close` | write | Ngừng địa chỉ hóa một workspace; **không xóa gì trên đĩa** |

Trước đây mọi action bị khóa cứng ở một project root, nên muốn đụng tới project khác
thì phải copy vào repo Shiro. Workspace là **lớp giới hạn thứ hai đặt trên Sandbox cũ**,
không phải thay thế nó:

1. Người vận hành khai báo `SHIRO_WORKSPACE_ALLOWLIST` (colon-separated, tuyệt đối;
   `/` bị từ chối). Mặc định của launcher là thư mục cha của project root và `/tmp/shiro`.
   Allowlist rỗng ⇒ bridge single-root y như trước, `features.multi_root_workspaces = false`.
2. `workspace_open` nhận **đường dẫn tuyệt đối** (hoặc `~/...`) và chỉ chấp nhận nếu nó
   nằm trong allowlist — kiểm tra allowlist **trước** khi kiểm tra tồn tại, để action
   không thành công cụ dò xem ngoài kia có file gì; rồi realpath và kiểm tra lại, nên
   symlink trong allowlist cũng không trỏ ra ngoài được.
3. Bên trong một workspace, luật cũ nguyên vẹn: path tương đối, không `..`, không symlink
   escape. Mở thêm root **không** nới rộng cái mà một lời gọi đơn lẻ với tới được.

`workspace_close` chỉ là sổ sách: nó không kill process/terminal đang chạy và không xóa
file. Workspace còn process/terminal sống sẽ bị từ chối `BUSY` trừ khi `force: true`.
Workspace `project` không đóng được. Trạng thái này sống theo vòng đời bridge (như
process registry), không bền qua restart.

**Harness cũng theo workspace.** `harness_start({workspace})` neo cả một durable session
vào workspace đó, nên **mọi tool của engine** — filesystem, shell, git, container — làm việc
trên đúng cây đó:

- Engine workspace định danh theo path (`apiProxy.workspace.create({path})`), session neo
  theo `cwd` của workspace.
- Tool fs/bash built-in của engine vốn đã resolve theo `exec.agent.session.header.cwd`.
- Hai tool Shiro tự đăng ký (`shiro-git-tool`, `shiro-container-tool`) nay theo cùng quy tắc
  đó (`bridge/src/session-root.js`) thay vì bind một root lúc `apply()` — nếu không, agent
  sẽ đọc file ở workspace B rồi commit vào repo Shiro.
- **Session được namespace theo workspace**: `harness_sessions({workspace})` chỉ liệt kê
  session của workspace đó, và resume một session từ workspace khác bị từ chối kèm lý do.
- Workspace phải **đang mở** thì mới neo được: id lạ fail `NOT_FOUND` **trước khi** engine
  nhìn thấy bất kỳ path nào, nên allowlist của người vận hành chi phối cả agent turn.

Mọi payload của turn (`harness_start`/`status`/`continue`/`respond`/`cancel`,
`harness_operation_list`) mang thêm trường `workspace`. Bỏ trống `workspace` ở mọi nơi =
project root cố định, đúng như trước.

#### Cách ly control plane

Mọi id client cầm — `operation_id`, `session_id`, `request_id`, `interaction_id` — đều
**opaque**: bản thân nó không nói thuộc cây nào. Nên bất biến là:

```text
Workspace gate → registry (operation/session/request/interaction) → engine
```

chứ không phải nhận id opaque → gọi engine → xong mới kiểm tra.

- **Ghi workspace lúc tạo, không suy ngược sau này.** Pending model request được đóng dấu
  workspace ngay trong `broker.enqueue`; interaction đóng dấu ngay khi `pumpEvents` ghi nhận
  frame approval/question. Một cái gate mà tự tính lại subject của chính nó là gate đua được.
- **Chặn trước khi chạm engine.** `harness_continue`, `harness_respond`, `harness_status`,
  `harness_cancel`, `harness_get_request`, `harness_operation_get` so sánh giá trị đã ghi với
  workspace caller khai, rồi mới làm gì tiếp. Submit bị từ chối **không tiêu** request;
  approval bị từ chối **không tiêu** interaction; cancel bị từ chối **không gửi** gì cho engine.
- **Sai workspace trả `NOT_FOUND`**, không phải "sai workspace". Xác nhận một id có tồn tại
  ở nơi khác chính là chỗ rò.
- **Scope theo mặc định.** Bỏ trống `workspace` = project root, kể cả ở các nhánh suy luận
  ngầm: "chỉ có một turn đang chạy" và "turn gần nhất" chỉ xét trong workspace đó, và payload
  `idle` cũng chỉ liệt kê pending request của workspace đó. `harness_operation_list` không bao
  giờ vô tình thành list-tất-cả.
- **Ngoại lệ có chủ đích**: `bridge_status` đếm turn của cả bridge (`all_workspaces`) — đó là
  một **con số** về tải, không phải trạng thái của workspace khác.

#### Workspace ghim vào realpath

`workspace_open`/`workspace_create` resolve symlink **một lần** lúc mở và lưu đường dẫn
canonical. Đổi symlink sang đích khác sau đó không kéo workspace đang mở đi theo, và mở lại
qua symlink đã đổi thì bị từ chối vì allowlist kiểm tra trên đích đã resolve.

### worktree — một checkout cho mỗi task
| Action | Loại | Mô tả |
|---|---|---|
| `worktree_create` | write | `git worktree add` + **đăng ký luôn thành workspace**, trả `workspace_id` |
| `worktree_list` | read | Mọi checkout của repo, kèm `workspace` id của cái đang mở |
| `worktree_remove` | destructive · confirm | Xóa checkout và đóng workspace tương ứng |
| `worktree_snapshot` | write | Chụp working tree (kể cả file chưa track) thành commit ghim, **không đụng tree** |
| `worktree_snapshots` | read | Danh sách save point của repo |
| `worktree_restore` | destructive · confirm | Áp một snapshot trở lại chính checkout đó |
| `worktree_handoff` | destructive · confirm | Chuyển việc dở dang giữa hai workspace cùng repo |
| `worktree_snapshot_drop` | destructive · confirm | Xóa một save point |

**Vì sao phần này nhỏ**: worktree là một checkout thứ hai của cùng repo ở đường dẫn khác,
dùng chung object store. Shiro đã có sẵn một lớp làm đúng việc "đường dẫn khác mà action
được phép chạy" — workspace. Nên `worktree_create` tạo checkout rồi **đăng ký nó thành
workspace**, và mọi action đã có chạy y nguyên trên đó: `fs_*`, `exec_run`, `git_*`,
`terminal_*`, và `harness_start({workspace})` để chạy **cả một agent turn cô lập** trong
checkout đó. Hai task song song không thấy sửa đổi của nhau; đó chính là isolation cần có.

Đích đến phải nằm trong allowlist **y như `workspace_open`** — kiểm tra trước khi git chạy,
nên không thể tạo checkout ở nơi operator chưa cho phép. Mặc định là
`<repo>.worktrees/<branch>` bên cạnh repo.

**Snapshot là save point, không phải stash.** Nó dựng commit từ một index tạm (nên index
thật không bị đụng), gồm **cả file chưa track**, parent là HEAD, ghim dưới
`refs/shiro/snapshots/` nên `git gc` không thu hồi. Sau khi chụp, working tree và index y
nguyên — không revert gì cả.

**Restore và handoff là cùng một thao tác, khác chỗ đích**: lấy diff của snapshot so với
parent rồi apply. Dùng patch thay vì reset index để kết quả giải thích được — file về dưới
dạng thay đổi working tree bình thường, không tự stage hàng trăm file. Patch được
`git apply --check` **trước**, nên conflict thì fail `GIT_CONFLICT` và đích **không bị đụng
một byte nào** (cố ý không dùng `--3way`: nó ghi conflict marker vào tree khi thất bại).
Đánh đổi: snapshot chỉ apply được nơi context còn khớp; không khớp thì báo, không để lại
đống hỗn độn.

### filesystem — trong root của workspace
| Action | Loại | Mô tả |
|---|---|---|
| `fs_read` | read | Đọc theo cửa sổ byte hoặc khoảng dòng; trả size/mtime/sha256 |
| `fs_list` | read | Liệt kê thư mục, đệ quy tùy chọn, lọc glob, con trỏ phân trang |
| `fs_stat` | read | Kiểu, size, mtime, mode, symlink target, sha256 (tùy chọn) |
| `fs_search` | read | Tìm literal/regex, snippet giới hạn, bỏ qua file nhị phân |
| `fs_create_file` | write | Tạo file (ghi atomic), idempotent theo nội dung |
| `fs_update_file` | write | `replace` / `replace_once` / `append`, có `expected_sha256` |
| `fs_mkdir` | write | Tạo thư mục, `parents`, `exist_ok` |
| `fs_delete` | destructive · confirm | Xóa file/thư mục; cây thư mục cần `recursive` + `confirm` |
| `fs_move` | destructive · confirm | Đổi tên/di chuyển; ghi đè cần `confirm` |
| `fs_copy` | write · confirm | Sao chép file/cây; ghi đè cần `confirm` |

### process — lệnh và tiến trình do bridge sở hữu
| Action | Loại | Mô tả |
|---|---|---|
| `exec_run` | write | Chạy một lệnh foreground; argv array, không shell trừ khi `shell: true` |
| `process_start` | write | Chạy nền, trả `process_id` ổn định |
| `process_status` | read | Trạng thái, exit code, đuôi output |
| `process_logs` | read | Đọc theo con trỏ byte tuyệt đối, báo `dropped_bytes` |
| `process_stop` | destructive | SIGTERM rồi SIGKILL sau `grace_ms` |
| `process_list` | read | **Chỉ** tiến trình do bridge khởi động |

### subagent — Claude Code / Codex / Grok / Antigravity CLI thật, chạy như sub-agent của Shiro
| Action | Loại | Mô tả |
|---|---|---|
| `subagent_providers` | read | CLI nào **cài** và **có vẻ đã đăng nhập**; không đoán, `authenticated` là `true`/`false`/`null` (chưa xác định được) |
| `subagent_start` | write | Dispatch một CLI headless làm tiến trình nền, trả `process_id` ngay |
| `subagent_status` | read | Trạng thái + (khi xong) kết quả đã phân tích: `thread_id`, `message`, `usage` |
| `subagent_log` | read | Đọc raw output theo con trỏ byte, cùng quy ước `process_logs` |
| `subagent_stop` | destructive | SIGTERM rồi SIGKILL, giống `process_stop` |
| `subagent_list` | read | Chỉ tiến trình `subagent_start` tạo ra, không lẫn `process_start` |

**Đây là bốn coding agent CLI thật chạy dưới tài khoản của chính chúng** — không phải một
mô phỏng, không phải gọi API. `subagent_start` dispatch `claude -p`, `codex exec`,
`grok -p`, hay `agy --print` ở chế độ headless, với đầy đủ tool use, sandbox và bộ nhớ
phiên riêng của từng CLI. Xây trên **đúng `ProcessRegistry`** mà `process_*` dùng — một
subagent có PID, ring buffer, confinement, giới hạn số tiến trình đồng thời, và cũng hiện
trong `process_list` (chỉ thiếu việc biết nó là CLI nào, thứ `subagent_list` cho biết).

**Chạy nền, không đồng bộ — có chủ đích.** Mỗi CLI có thể chạy hàng chục phút; ChatGPT tự
nó bị nền tảng cắt sau khoảng 25 phút (xem họ `continuation`). Chặn một lệnh MCP chờ hết
một subagent sẽ buộc hai giới hạn đó cộng dồn vô nghĩa. `subagent_start` trả về ngay;
`subagent_status`/`subagent_log` để hỏi lại.

**Tiếp tục hội thoại**: `resume_from` nhận **hoặc** `process_id` của một `subagent_start`
trước (được giải về đúng session/thread id của chính CLI đó), **hoặc** một session id thô
đã biết. Mỗi lượt vẫn là một tiến trình mới — tiếp tục nghĩa là gọi lại CLI với cờ resume
riêng của nó (`--resume`, `codex exec resume`, `--conversation`), không phải giữ một
tiến trình sống nhận nhiều lượt.

**Đã xác minh thật vs chưa xác minh.** `claude` và `codex` đã chạy thật, có tài khoản, trên
máy triển khai — hình dạng JSON/NDJSON trong `subagent_status`/`subagent_log` là hình dạng
thật. `grok` và `agy` (Antigravity) có cài nhưng **chưa đăng nhập** khi viết tài liệu này;
parser của chúng dựng từ `--help` với nguyên tắc suy giảm an toàn — sai hình dạng thì trả
JSON thô trong `message` kèm `unverified_shape: true`, không bao giờ throw. `unverified: true`
đi kèm mọi kết quả của hai adapter này, và `subagent_providers` liệt kê rõ trước khi bạn
dispatch.

**Cổng disclaimer không bị vượt qua.** `claude`/`grok` có một chế độ `bypassPermissions` bị
khoá sau một bước xác nhận tương tác một lần (`claude --dangerously-skip-permissions` chạy
tay, một lần, trong terminal thật). Yêu cầu mode đó qua `subagent_start` bị từ chối
`PERMISSION_REQUIRED` kèm đúng lệnh cần chạy để mở khoá — Shiro không script qua bước đó.
`codex`/`agy` không có cổng tương tự nên `dangerously_skip_permissions: true` đi thẳng vào
cờ bypass riêng của chúng.

**Quyền**: cả họ `subagent` outward-on-write giống `fleet` — `subagent_start`/`subagent_stop`
cần profile `full` (một CLI tự chủ chạy dưới tài khoản riêng, có thể ra mạng); các action đọc
(`status`/`log`/`list`/`providers`) chạy được ở `read-only`.

### terminal — pty tương tác
| Action | Loại | Mô tả |
|---|---|---|
| `terminal_start` | write | Mở pty chạy argv (mặc định: shell tương tác), trả `terminal_id` |
| `terminal_write` | write | Gõ vào terminal: `input` nguyên văn, `keys` (phím điều khiển có tên), `submit` |
| `terminal_read` | read | Đọc transcript theo con trỏ byte; `wait_ms` + `settle_ms` để chờ chương trình in xong |
| `terminal_resize` | write | Đổi kích thước cửa sổ (TIOCSWINSZ) để chương trình vẽ lại |
| `terminal_signal` | destructive | Gửi tín hiệu cho process group foreground (INT/TERM/…) |
| `terminal_stop` | destructive | Đóng terminal, kill process group, escalate SIGKILL sau `grace_ms` |
| `terminal_list` | read | **Chỉ** terminal do bridge mở |

`process_start` cho tiến trình nền có log, nhưng **không có đường gửi stdin tiếp**. Mọi
thứ biết hỏi lại — REPL Python/Node, `gh auth login`, `npm create`, ssh, package manager,
debugger, TUI — cần một tty thật cộng kênh gõ tiếp. Đó là họ `terminal`.

- **Hiện thực**: Node không có pty trong core và bridge cố ý không thêm native dependency,
  nên mỗi terminal do một tiến trình Python stdlib (`bridge/src/pty-bridge.py`) nắm giữ,
  nói chuyện bằng JSON theo dòng. Không có `python3` ⇒ `terminal_start` trả `UNSUPPORTED`
  nói rõ lý do, không bao giờ giả vờ thành công.
- **Đọc dễ hiểu**: `terminal_read` **dựng lại** output như terminal vẽ (áp dụng di chuyển
  con trỏ, xóa dòng, repaint; bỏ màu), nên echo của REPL ra `>>> 2 + 40` chứ không phải
  `>>> 2>>> 2 >>> 2 +…`. Đây là bộ dựng **theo dòng**, không phải màn hình 2 chiều: TUI
  toàn màn hình sẽ hiện thành nhiều lần repaint. `raw: true` trả đúng bytes gốc.
- **Một round-trip**: `wait_ms` chờ tới khi chương trình **im lặng** `settle_ms` (mặc định
  250 ms) chứ không trả về ở byte đầu tiên — viết rồi đọc là một lượt, không phải vòng poll.
- **Con trỏ byte tuyệt đối** như `process_logs`, kèm `dropped_bytes` khi ring buffer bỏ
  phần cũ. Trần: 8 terminal đồng thời, 1 MiB transcript mỗi terminal, 8 KiB input mỗi lần.

### media — nhìn ảnh và PDF
| Action | Loại | Mô tả |
|---|---|---|
| `image_open` | read | Trả ảnh dưới dạng **MCP image block** (PNG/JPEG/GIF/WebP/BMP), trần 6 MB |
| `image_metadata` | read | Định dạng + kích thước pixel đọc thẳng từ header, không giải mã |
| `pdf_info` | read | Số trang, tiêu đề, khổ giấy, trạng thái mã hóa (poppler `pdfinfo`) |
| `pdf_render_page` | read | Render **một trang** thành PNG trả inline (poppler `pdftoppm`) |

`fs_read` trả base64 cho một PNG, thứ chẳng nói lên điều gì với model. Hai action `*_open`
trả content block thật để ảnh/trang PDF đi tới được model. `pdf_render_page` render qua
stdout nên **không ghi gì vào workspace** trừ khi truyền `save_to`. Thiếu poppler ⇒
`UNSUPPORTED` kèm lý do; `bridge_capabilities.features.pdf` cho biết trước.

### network — mang bytes vào máy
| Action | Loại | Mô tả |
|---|---|---|
| `download_file` | network · destructive · confirm | Tải một URL http(s) thẳng vào file trong workspace |
| `artifact_import` | network · destructive · confirm | Đưa **file người dùng đính kèm trong ChatGPT** vào workspace |

**`artifact_import` — file ingress đúng nghĩa.** Apps SDK của OpenAI có convention cho
file parameter: khai `_meta["openai/fileParams"]: ["file"]` và tham số `file` mang object
`{download_url, file_id, mime_type?, file_name?}` (bắt buộc `download_url` + `file_id`).
Runtime của ChatGPT thay attachment bằng object đó, nên đường đi là:

```text
ChatGPT attachment → connector runtime → file reference (download_url) → artifact_import → workspace
```

chứ không phải nhồi base64 khổng lồ qua JSON. ZIP/PDF/APK/ảnh/database/source archive đều đi
được đường này. `destination` mặc định lấy tên file của attachment, **rút về đúng một path
segment** (`../../etc/passwd` → `passwd`), tạo thư mục cha, ghi atomic, trả `sha256`.

Có hai dạng suy biến được ghi nhận thực tế: runtime đưa **chuỗi file id** hoặc **đường dẫn
container** (`/mnt/data/...`). Cả hai đều không mang bytes tới được connector, nên
`artifact_import` trả `UNSUPPORTED` **nói rõ nhận được gì và vì sao không lấy được** thay vì
lỗi schema mù. Không có attachment thì dùng `source_url`.

`artifact_import` chịu **đúng cổng phê duyệt của `download_file`** (`confirm: true`): nó vẫn
là fetch một URL rồi ghi đĩa, và `download_url` là text model chạm tới được — nếu miễn confirm
thì nó thành đường vòng qua cổng của `download_file`.

Đây là chiều còn thiếu: `fs_create_file` với base64 chỉ hợp cho file nhỏ inline, còn
archive/dataset/font/binary thì không thể đi qua tham số JSON. Bảo đảm:

- chỉ `http`/`https`, **từ chối credential nhúng trong URL**;
- tối đa 5 redirect, **mỗi hop kiểm tra lại** scheme/credential/địa chỉ;
- từ chối host phân giải ra dải link-local `169.254.0.0/16` (instance metadata);
- trần byte (mặc định 25 MB, cứng 200 MB) chặn cả theo `content-length` khai báo lẫn
  trong lúc stream — vượt trần thì hủy và **không để lại file dở**;
- ghi atomic (temp + rename), trả `sha256`; `expected_sha256` sai ⇒ `CONFLICT` và vứt bỏ;
- đích đã tồn tại ⇒ `ALREADY_EXISTS` trừ khi `overwrite: true`;
- vừa ra mạng vừa ghi đĩa nên **bắt buộc `confirm: true`**.

### git — repo cục bộ
| Action | Loại | Mô tả |
|---|---|---|
| `git_status` | read | Porcelain v2 chuẩn hóa: branch, upstream, ahead/behind, từng thay đổi |
| `git_repo_info` | read | Root, HEAD, dirty, remote (đã che credential) |
| `git_diff` | read | Diff worktree/index/hai ref, kèm numstat, có trần byte |
| `git_log` | read | Lịch sử commit chuẩn hóa, `limit`/`skip` |
| `git_show` | read | Một commit: metadata + numstat + patch giới hạn |
| `git_compare` | read | ahead/behind, merge base, file stats, commit giữa hai ref |
| `git_branch_list` | read | Nhánh local (+ remote), upstream, nhánh hiện tại |
| `git_branch_create` | write | Tạo nhánh, tùy chọn checkout |
| `git_checkout` | write | Chuyển sang ref đã có, hoặc detach |
| `git_add` | write | Stage path tường minh; `all` phải yêu cầu rõ ràng |
| `git_commit` | write | Commit staged, `expected_head`, trả SHA |
| `git_restore` | destructive · confirm | Bỏ thay đổi ở path tường minh |
| `git_reset` | destructive · confirm | soft/mixed/hard; `hard` cần `confirm` |
| `git_merge` | write | Merge hoặc `action: abort`; xung đột → `GIT_CONFLICT` |
| `git_rebase` | destructive · confirm | start/continue/skip/abort |
| `git_tag_list` | read | Tag mới nhất trước |
| `git_tag_create` | write | Tag thường hoặc annotated |
| `git_remote_list` | read | Remote với credential đã che |
| `git_fetch` | network | Cập nhật remote-tracking ref |
| `git_pull` | network · destructive | Mặc định `ff-only`; `rebase` cần `confirm` |
| `git_push` | network · destructive · confirm | Hành động **duy nhất** đưa commit ra khỏi máy |

### task — script và target repo tự khai báo
| Action | Loại | Mô tả |
|---|---|---|
| `task_list` | read | package.json scripts (root + sub-package) và Makefile target |
| `task_run` | write | Chạy **một task theo tên**; không có kênh shell tự do |
| `test_run` | write | Chạy suite test đã khai báo; không có thì `UNSUPPORTED` + liệt kê task có sẵn |

### harness — control plane của agent
| Action | Loại | Mô tả |
|---|---|---|
| `harness_start` | write · openWorld | Nhận `workspace` (tùy chọn): neo cả session vào workspace đó |
| `harness_sessions` | read | Nhận `workspace`; chỉ liệt kê session của workspace đó |
| `harness_operation_list` | read | Các root turn đã đăng ký, mới nhất trước |
| `harness_operation_get` | read | Trạng thái đầy đủ, gọn, của một `operation_id` |
| `harness_session_get` | read | Metadata một durable session + turn đang giữ nó; nhận `workspace` |
| `harness_operation_list` | read | Scope theo `workspace`; mặc định = project root |
| `harness_operation_get` | read | Nhận `workspace`; turn của workspace khác trả `NOT_FOUND` |

Tám action Harness nguyên bản (`harness_profiles`, `harness_start`, `harness_sessions`,
`harness_get_request`, `harness_continue`, `harness_status`, `harness_respond`,
`harness_cancel`) giữ nguyên hợp đồng cũ; tất cả nhận thêm `workspace` **tùy chọn** và bỏ
trống thì hành vi y hệt trước.

### fleet — worker ChatGPT Web
| Action | Loại | Mô tả |
|---|---|---|
| `fleet_list` | read | Mọi fleet server đang sở hữu |
| `fleet_update` | write | Đổi prompt/interval/stagger/max_session_runs tại chỗ |
| `fleet_delete` | destructive | Xóa state + lịch sử của fleet **đã dừng** |
| `fleet_run_now` | write | Chạy ngay một vòng, không đợi interval |
| `fleet_runs` | read | Lịch sử vòng chạy gần đây, phân trang |
| `fleet_worker_status` | read | Chi tiết một slot |
| `fleet_worker_recycle` | destructive | Xóa hội thoại + đóng tab của một slot, reset ngân sách run |

`fleet_start`/`fleet_status`/`fleet_stop` giữ nguyên hợp đồng cũ.

**Mẫu “mỗi worker chạy N lượt rồi làm mới hội thoại”**: đặt `max_session_runs` khi
`fleet_start` (tự động), hoặc gọi `fleet_worker_recycle` để làm ngay bằng tay. Cả hai
đi qua cùng một đường đã xác minh: ở chat mode `normal`, hội thoại ChatGPT do Shiro sở
hữu bị **xóa có xác nhận** trước khi tab đóng; slot giữ nguyên danh tính và vòng sau mở
hội thoại mới. `fleet_runs` cho thấy điều đó đã xảy ra.

### browser — chỉ tab Shiro sở hữu
| Action | Loại | Mô tả |
|---|---|---|
| `browser_owned_tabs` | read | Tab do fleet sở hữu; `include_foreign` chỉ để *xem* |
| `browser_tab_close` | destructive | Đóng một tab sở hữu, đã xác minh, đang rảnh |
| `browser_tab_send_prompt` | write | Gửi một prompt vào tab sở hữu; tính vào ngân sách run của slot |
| `browser_tab_screenshot` | write · openWorld | Chụp một tab sở hữu, ghi ảnh vào workspace, trả path + resource uri |
| `browser_tab_navigate` | destructive · openWorld | Điều hướng một tab sở hữu; http(s) only, localhost/LAN được phép |
| `browser_dom_query` | write · openWorld | Tìm element, trả descriptor có giới hạn + element handle opaque |
| `browser_tab_click` | destructive · openWorld | Click element theo handle, resolve lại ngay trước khi click |
| `browser_tab_type` | destructive · openWorld | Nhập text vào element theo handle; không echo lại text |
| `browser_tab_evaluate` | destructive · confirm | Chạy JavaScript trong tab sở hữu — làm cuối cùng, bắt buộc `confirm` |

Không có action nào chiếm quyền trình duyệt cá nhân: tab không thuộc fleet luôn bị từ chối.

#### Owned-tab gate (một chỗ duy nhất)

Mọi browser action đi qua đúng một đường (`bridge/src/browser-ownership.js`):

```text
browser request → verified owned-tab gate → validation riêng của capability
                → re-check ownership → relay → response có giới hạn
```

- **Authority đến từ registry của Shiro, không từ request.** Caller chỉ được truyền
  `browser_tab_id`; `browser_client_id` và relay target là **output** của việc resolve.
  Truyền `browser_client_id` vào không thay đổi được gì (có test).
- **Tab lạ và tab không tồn tại trả lời giống hệt nhau** — cùng `NOT_FOUND`, cùng câu chữ.
  Phân biệt được nghĩa là xác nhận id nào có thật trong trình duyệt người dùng.
  `include_foreign=true` **chỉ để quan sát**: có regression test chứng minh nó không cấp
  quyền cho bất kỳ action đọc-nội-dung hay ghi nào.
- **Re-check ngay trước relay call.** Resolve trả về một *marker* (client id + URL + worker
  + slot); ngay trước khi gọi relay, identity được lấy lại và so marker. Tab đã điều hướng,
  đã đóng-mở lại, hay đã bị recycle sang slot khác → `CONFLICT`, không thực hiện. Bước
  re-check cố ý **chỉ** lặp phần identity: verify đầy đủ tốn một layout capture 15k node.
- **Busy policy theo từng action.** Screenshot là read-only nên **được phép** chụp khi tab
  đang generate; click/type/close thì `BUSY`. Relay báo busy bằng chuỗi bằng chứng
  (`active_request`, `stop_control`, …) chứ không phải boolean.

#### `browser_tab_screenshot`

Ảnh **không** đi vào JSON result: ghi vào workspace (mặc định `.shiro/screenshots/`), trả
`path` + `sha256` + kích thước + `shiro://` resource uri — xem bằng `image_open`. Trần
6 MB, `full_page` phải xin tường minh (mặc định viewport), magic byte phải khớp format yêu
cầu, và mọi thất bại đều **không để lại file dở** (ghi atomic temp + rename).

Action này cần một relay build có route screenshot. `bridge_capabilities.features.
browser_screenshot` được **probe trực tiếp** từ relay, không phải hằng số; thiếu route thì
action trả `UNSUPPORTED` nói rõ cần gì.

#### Browser automation qua CDP (relay v2, 2026-09-03)

Cả họ browser chạy trên **một** `DebuggerSessionManager` phía extension — không trộn
`chrome.tabs`, content script và CDP. Extension cần permission `debugger`; **không**
activate/focus tab, **không** resize cửa sổ.

| Phase | Action | CDP domain/method |
|---|---|---|
| 1 | `browser_tab_screenshot` | `Page.captureScreenshot`, `Page.getLayoutMetrics` (+`captureBeyondViewport` cho full page) |
| 2 | `browser_tab_navigate` | `Page.navigate` + `Page.loadEventFired`/`frameStoppedLoading`, `Page.getNavigationHistory` |
| 3 | `browser_dom_query` | `Runtime.evaluate` với **biểu thức cố định**, selector chèn dạng JSON literal |
| 4 | `browser_tab_click` / `browser_tab_type` | `Input.dispatchMouseEvent`, `Input.insertText`, `Input.dispatchKeyEvent` |
| 5 | `browser_tab_evaluate` | `Runtime.evaluate` với biểu thức của caller |

**Element handle** opaque, scope hai lớp: registry phía page theo *document generation*
(điều hướng/reload là mất sạch handle cũ) và bridge gắn thêm *tab id* (handle của tab này
bị từ chối ở tab khác **trước khi** chạm relay). Click/type **resolve lại handle ngay
trước thao tác** rồi mới lấy tọa độ — layout đổi sau lúc query không làm click nhầm chỗ.
Handle chết trả `CONFLICT` kèm hướng dẫn query lại.

**Busy policy theo từng action**: `browser_tab_screenshot` và `browser_dom_query` là
read-only nên chạy được khi tab đang generate; navigate/click/type/evaluate trả `BUSY`.

**Giới hạn output**: query trần 200 element và 4 KB text mỗi element, có `total`/`truncated`;
evaluate serialize và đo size **trong page** nên giá trị cyclic hoặc khổng lồ không bao giờ
qua dây (vượt trần → `INVALID_ARGUMENT`, không phải flood transcript). Text đã gõ **không**
echo lại — chỉ trả độ dài. Field password/one-time-code: query không đọc value, type **từ
chối thẳng** (người ngồi bàn phím tự nhập).

**Navigate**: chỉ `http`/`https`; `javascript:`/`data:`/`blob:`/`file:`/`chrome:`/
`chrome-extension:`/`devtools:`/`about:` bị từ chối, và redirect kết thúc ở scheme cấm cũng
fail. **localhost, 127.0.0.1, LAN/private IP được phép** — điều khiển dev server nội bộ là
mục đích, không phải lỗ hổng. Đưa một slot của fleet **đang chạy** ra khỏi ChatGPT bị từ
chối (dừng fleet trước); fleet đã dừng thì cần `confirm`.

**`browser_tab_evaluate` để cuối cùng và bắt buộc `confirm`**: bốn action trên đã phủ phần
lớn automation với giới hạn riêng cho từng loại, còn cái này làm được mọi thứ trang làm
được, trong một tab đang giữ session ChatGPT sống.

### thread — vòng đời hội thoại
| Action | Loại | Mô tả |
|---|---|---|
| `thread_events` | read | Thread như dòng item có `seq` ổn định; lọc theo `types`, tiếp tục bằng `from_seq` |
| `turn_steer` | write | Thêm một message vào turn **đang chạy**, không hủy nó |
| `thread_fork` | write | Nhánh từ một `seq`: cùng lịch sử tới đó, đi hướng khác |
| `thread_archive` / `thread_unarchive` | write | Ẩn/hiện một thread khỏi listing |
| `thread_archived` | read | Danh sách thread đã ẩn |
| `thread_prune` | write | Ẩn hàng loạt thread cũ — **mặc định dry-run**, và từ chối quét không giới hạn |

**Archive không xóa gì.** Engine giữ nguyên transcript; bridge chỉ ghi một marker của
riêng nó, và mỗi kết quả trả về `engine_transcript_retained: true` để không ai nhầm
"dọn danh sách" với "xóa dữ liệu". `thread_unarchive` vì thế luôn khôi phục được.

`turn_steer` chỉ có nghĩa khi turn còn sống: nếu turn đã kết thúc, action nói thẳng
điều đó thay vì lặng lẽ biến message thành prompt của lượt sau.

### permission — một nút chỉnh cho cả bề mặt
| Action | Loại | Mô tả |
|---|---|---|
| `permission_get` | read | Profile đang hiệu lực, trần (ceiling), và các rule lệnh/host |
| `permission_set` | write | **Chỉ được siết**, không được nới |

Ba profile: `read-only` → `workspace-write` → `full`. Trần đến từ cấu hình launcher
(`SHIRO_PERMISSION_PROFILE`); runtime hạ xuống được, nâng lên thì không — một caller
tự nâng trần của chính mình thì không còn là trần.

**Đây là tuyên bố ý định ở biên action, không phải sandbox.** Nói rõ vì nó quyết định
cách dùng: `workspace-write` chặn mọi action *có mục đích* rời khỏi máy (họ `network`,
họ `browser`, `git_fetch`/`git_pull`/`git_push`), nhưng `exec_run` vẫn chạy được `curl` —
chặn điều đó nghĩa là kiểm soát network của tiến trình con, việc lớp này không làm.
Các action khám phá (`bridge_status`, `bridge_capabilities`, `config_get`,
`permission_*`, `logs_tail`, `metrics_snapshot`) luôn gọi được ở mọi profile, nếu không
một client bị siết sẽ không thể biết mình được phép làm gì và vì sao vừa bị từ chối.

### review — nhận từng phần thay đổi
| Action | Loại | Mô tả |
|---|---|---|
| `review_diff` | read | Thay đổi tách theo **hunk**, mỗi hunk có `hunk_id` |
| `review_stage_hunk` | write | Stage đúng một hunk |
| `review_revert_hunk` | destructive · confirm | Hoàn tác đúng một hunk |
| `review_findings` | read | Chuẩn hóa + đối chiếu nhận xét với thay đổi thật |

`hunk_id` là **content-addressed**: nó băm nội dung hunk, nên khi cây đã đổi, id cũ
không còn mô tả thứ gì và action trả `CONFLICT` kèm lời nhắc chạy lại `review_diff` —
thay vì áp patch vào bất cứ thứ gì vừa trôi vào vị trí đó.

Phạm vi review đặt bằng `since_snapshot` (đúng những gì một turn đã đổi, dùng save point
của `worktree_snapshot`), `staged`, `base`, hoặc `paths`. `review_findings` đánh dấu
`in_changed_file` / `in_changed_hunk`, nên một nhận xét về code **không nằm trong thay
đổi** bị gọi tên ra chứ không lẫn vào danh sách.

Ghi chú triển khai đã cắn một lần: diff luôn chạy với `--src-prefix=a/ --dst-prefix=b/`,
vì `diff.mnemonicPrefix` của người dùng biến header thành `c/… w/…` và parser nào tin
vào `a/`/`b/` sẽ đọc sai path.

### artifact
| Action | Loại | Mô tả |
|---|---|---|
| `artifact_list` | read | File đã sinh, mới nhất trước, phân loại image/text/blob + `resource_uri` |
| `artifact_metadata` | read | Size/hash/kind/mime/uri mà không chuyển bytes |
| `artifact_delete` | destructive · confirm | Xóa **một file thường** (cây thư mục dùng `fs_delete`) |

`harness_get_artifact` vẫn là action lấy bytes thật (resource link, ảnh inline, base64).

### config / logs / metrics
| Action | Loại | Mô tả |
|---|---|---|
| `config_get` | read | Cấu hình hiệu lực, không có secret, đã qua redactor |
| `config_validate` | read | Kiểm tra một cấu hình ứng viên mà không áp dụng |
| `logs_tail` | read | Đuôi log dịch vụ theo **tên stream** trong allowlist, đã che secret |
| `metrics_snapshot` | read | Đếm call/lỗi/latency theo từng action |

### continuation — sống qua giới hạn 25 phút của ChatGPT
| Action | Loại | Mô tả |
|---|---|---|
| `continuation_set` | write | Chỉ định tab ChatGPT (chính hội thoại đang chạy) mà Shiro được phép gõ "continue" vào |
| `continuation_status` | read | Đang chỉ định tab nào, còn bao nhiêu nudge, lịch sử gần nhất |
| `continuation_clear` | write | Quên tab đã chỉ định — không huỷ turn nào, chỉ ngừng gõ |
| `continuation_check` | write | Chạy ngay một vòng quét (thay vì chờ timer), để xác nhận cấu hình đúng |

**Vấn đề**: khi ChatGPT điều khiển Shiro, ChatGPT chính là "model" — một turn chỉ tiến
được khi ChatGPT tiếp tục trả lời `harness_get_request` bằng `harness_continue`. Nền tảng
buộc dừng sau khoảng 25 phút. Turn không lỗi — nó nằm im ở `model_input_required` mãi mãi,
chờ một câu trả lời sẽ không bao giờ tới. (Trên máy triển khai từng thấy 3 turn treo kiểu
này, hai cái đã 10 tiếng.)

**Cách giải quyết**: Shiro tự gõ "continue" vào **chính hội thoại đó**. Ở phút 27 — sau mốc
cắt ~25 phút, đủ xa để không ngắt một câu trả lời chỉ đang chậm. `continuation_set` không
mở một quyền browser mới: hội thoại của bạn nằm trong tab ChatGPT cá nhân, và ownership gate
(xem "Owned-tab gate" bên dưới) mặc định từ chối mọi automation chạm vào tab không thuộc
fleet. Thay vì nới lỏng luật đó cho mọi action, người vận hành **tự đặt tên đúng một tab**
và cấp cho nó đúng một quyền — nhận nudge này. Không action browser nào khác nhận
"designated tab"; việc chỉ định chỉ sống trong bộ nhớ và mất khi bridge restart.

Tham số: `after_minutes` (mặc định 27), `cooldown_minutes` giữa hai lần nudge (mặc định 3,
tránh gõ hai dòng "continue" liên tiếp đọc như nhiễu), `max_nudges` (mặc định 8, dừng tự
động khi hết ngân sách thay vì gõ vô hạn), `text` (mặc định "continue"). Một lần nudge thất
bại (relay lỗi) **không** trừ ngân sách và **không** bắt đầu cooldown — turn vẫn đang treo,
từ chối thử lại sẽ bỏ rơi nó.

## Gọi từ shell và từ script

ChatGPT không phải client duy nhất. Cùng một bề mặt action dùng được từ terminal và từ
code, qua ba lớp mỏng dùng chung đúng endpoint MCP đó:

```bash
shiro actions --family git          # bề mặt deployment này thật sự có
shiro schema fs_read --json         # input + output schema, để script tự validate
shiro call fs_read --path src/index.js --json
shiro call worktree_create --branch task-1 --json
```

Quy ước tham số phản chiếu schema: `--path x` (chuỗi), `--limit 20` (số), `--confirm` /
`--no-confirm` (bool), `--paths a --paths b` (mảng), và `--json-args '{"…"}'` cho thứ cờ
không diễn đạt được. Ép kiểu **cố ý dè dặt**: `"20"` thành số, còn `1.2.3` hay `007abc`
giữ nguyên chuỗi, vì một sha hay version bị biến thành số là sai âm thầm.

Mã thoát: `0` thành công, `1` action từ chối (mã lỗi in ra **stderr**, stdout trống nên
`shiro call … | jq` không bao giờ đọc phải nửa câu trả lời), `2` sai cú pháp, `3` không
với tới bridge. Endpoint và token đọc từ đúng biến launcher đã export
(`SHIRO_BRIDGE_URL`/`SHIRO_BRIDGE_PORT`, `SHIRO_BRIDGE_TOKEN`/`SHIRO_BRIDGE_TOKEN_FILE`),
mặc định là file token trong `.ShiroRuntime/state/`.

**SDK JavaScript** (`bridge/src/sdk.js`) và **SDK Python** (`bridge/sdk/shiro.py`) cho
cùng bề mặt đó dưới dạng hàm. Cả hai bỏ lớp vỏ MCP, và **ném lỗi** khi action từ chối —
trả về object lỗi sẽ khiến `await shiro.fs_read(...)` trông như đã chạy được:

```js
import { connectShiro } from './bridge/src/sdk.js'
const shiro = await connectShiro()
const { branch } = await shiro.git_status()
try { await shiro.fs_read({ path: '/etc/passwd' }) }
catch (error) { error.code === 'OUTSIDE_SANDBOX' }
await shiro.thread(sessionId).events({ from_seq: 0 })
```

```python
from shiro import Shiro, ShiroActionError
with Shiro() as shiro:
    print(shiro.git_status()["branch"])
    for event in shiro.thread(session_id).events(from_seq=0)["events"]:
        print(event["type"])
```

Bản Python chỉ dùng thư viện chuẩn — một script muốn đọc file hay mở worktree không nên
phải thêm dependency protocol. Đơn vị nối lại của SDK là **session id**, không phải object
trong bộ nhớ: script chết giữa chừng vẫn nối lại đúng thread đó. Trong mọi thread helper,
`session_id` được áp **sau cùng**, nên một `session_id` lạc trong tham số không thể chuyển
hướng lời gọi sang thread khác.

**Không có `shiro exec "<prompt>"`.** Model của Shiro là ChatGPT, đứng ở phía client MCP:
một CLI muốn chạy trọn một agent turn thì phải *là* model đó. Lệnh như vậy sẽ start một
turn rồi treo chờ người khác trả lời — nên nó không tồn tại, thay vì tồn tại và nói dối.

## Ranh giới an toàn

- **Sandbox**: một implementation duy nhất (`bridge/src/sandbox.js`) cho mọi action.
  Path tuyệt đối, `..`, và symlink chain ra ngoài root đều fail. Path chưa tồn tại được
  kiểm tra qua realpath của tổ tiên gần nhất, nên không thể ghi xuyên qua thư mục symlink.
- **Workspace là lớp thứ hai, không phải cửa sau**: chỉ thư mục trong allowlist mới mở
  được, allowlist kiểm tra trước cả sự tồn tại, và bên trong workspace thì Sandbox y hệt.
  Allowlist chứa `/` bị từ chối ngay lúc nạp cấu hình.
- **Không shell theo mặc định**: `exec_run`/`process_start` nhận argv array chạy với
  `shell: false`; `shell: true` là opt-in từng lần và được báo lại trong kết quả.
  Mọi lệnh git là argv array, không bao giờ ghép chuỗi shell.
- **Environment là allowlist**: tiến trình con chỉ nhận `PATH`, `HOME`, `LANG`, `TZ`,
  `TMPDIR`, … cộng overlay `env` do caller truyền. Token của bridge và của relay
  **không bao giờ** được kế thừa.
- **cwd bắt buộc trong sandbox** cho cả `exec_run`, `process_start` và `terminal_start`.
- **Terminal chỉ của bridge**: `terminal_list` không liệt kê tty hệ thống; `terminal_signal`
  chỉ tới process group của pty do bridge tạo; khi bridge tắt, mọi terminal bị kill.
- **Ra mạng có kiểm soát**: `download_file` chỉ http(s), chặn credential trong URL, chặn
  dải link-local, giới hạn redirect và byte, và luôn đòi `confirm`.
- **Chỉ tiến trình của bridge**: `process_list` không liệt kê tiến trình hệ thống;
  `process_stop` không gửi tín hiệu cho tiến trình lạ. Khi bridge tắt, mọi tiến trình
  nó khởi động bị kill.
- **Che secret**: remote URL có credential, output `git_fetch`/`pull`/`push`, `config_get`
  và `logs_tail` đều đi qua redactor (`bridge/src/redact.js`).
- **`logs_tail` là ngoại lệ có kiểm soát**: log dịch vụ nằm ngoài project root, nên
  action nhận **tên stream** trong danh sách cố định chứ không nhận đường dẫn.
- **Tab trình duyệt**: chỉ tab đã đăng ký cho một fleet slot, đã xác minh chat mode và
  (trừ action read-only) đang rảnh mới bị tác động. Ownership check nằm ở **một** helper
  dùng chung, được re-check ngay trước mỗi relay call.
- **Control plane cách ly theo workspace**: id opaque mang sẵn workspace của nó, gate chạy
  trước engine, sai workspace trả `NOT_FOUND`, và mọi nhánh mặc định đều scope về project
  root (xem mục workspace ở trên).

## Cố ý không hỗ trợ

| Thứ | Vì sao |
|---|---|
| `bridge_reload` / `bridge_restart` | Bridge là plugin cordis chạy trong tiến trình engine. Reload in-band sẽ hạ chính HTTP server đang phục vụ request đó, nên không thể trả về thành công một cách trung thực. Khởi động lại từ launcher. |
| `harness_session_delete`, `harness_session_prune` | `apiProxy.sessions` chỉ có list/create/history/rename/fork — không có delete hay archive. Xóa lịch sử ngoài luồng sẽ làm hỏng store của engine. |
| `config_set` | Cấu hình bridge được chốt một lần khi plugin `apply()`; không có setting nào đổi được an toàn lúc chạy. Dùng `config_validate` rồi khởi động lại. |
| `browser_tab_focus` | Relay không có route focus, và giật focus cửa sổ khỏi người dùng không phải việc một connector nền nên làm âm thầm. |
| `harness_wait` riêng | `harness_status` đã nhận `wait_ms` (trần 30s) và trả về ngay khi turn chuyển trạng thái; một action thứ hai làm đúng việc đó chỉ là trùng lặp. |
| ~~Upload file từ client làm tham số~~ | **Đã bỏ khỏi danh sách này (2026-09-03).** Kết luận cũ sai: nó dựa trên "tham số MCP là JSON" mà không kiểm chứng lớp connector runtime. Apps SDK **có** convention file parameter (`_meta["openai/fileParams"]` + object `{download_url, file_id, …}`), và `artifact_import` nay dùng đúng convention đó. |
| Terminal render toàn màn hình | `terminal_read` dựng lại output **theo dòng** (đủ cho REPL/prompt/installer). Emulator màn hình 2 chiều là một hệ thống khác hẳn; TUI hiện thành nhiều lần repaint, và `raw: true` luôn trả bytes gốc. |

`bridge_capabilities.unsupported[]` trả lại đúng danh sách này lúc chạy.
