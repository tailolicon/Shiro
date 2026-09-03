# Shiro

Shiro biến ChatGPT Web với GPT-5.6 Sol thành một coding agent đầy đủ trên Windows và Omarchy/Arch Linux. Sol đưa ra quyết định; Shiro chạy đọc/ghi file, terminal, test, Git, goal, workflow và subagent qua engine DeepSeek Harness.

Giao diện web cục bộ có launcher native trên Omarchy và có thể được đóng gói thành ứng dụng Windows bằng Pake. Toàn bộ mã nguồn có thể đọc và chỉnh sửa ngay trong repo này.

## Cấu trúc

- `engine/`: mã nguồn DeepSeek Harness, được dùng làm agent runtime.
- `bridge/`: adapter và MCP bridge kết nối ChatGPT Sol với Harness.
- `relay/chatgpt-bridge/`: browser relay đã audit và ghim commit; giữ ChatGPT Web chạy nền nhưng trả kết quả về đúng agent loop của DSH.
- `desktop/`: cấu hình Pake và tài nguyên ứng dụng Windows.
- `plugins/`: các plugin DSH đã audit và ghim đúng commit; mỗi thư mục là một Git submodule có thể đọc/chỉnh sửa.
- `research/awesome-dsh-plugin/`: snapshot catalog đã ghim để Shiro tự nghiên cứu bên trong project root; catalog không được thực thi.
- `scripts/`: cài đặt, khởi động, dừng, mở tunnel và build desktop app.

## Effort và speed

Shiro không còn dùng một nhãn `ChatGPT Web` mơ hồ. Model selector của giao diện local có ba profile:

- `Fast`: vòng lặp ngắn, effort mặc định `Light`.
- `Balanced`: cân bằng, effort mặc định `Standard`.
- `Deep`: ưu tiên xác minh/audit, effort mặc định `High`.

Mỗi profile cho phép chọn `Light`, `Standard`, `High` hoặc `Max`. Trên đường ChatGPT Web, `harness_start` bắt buộc truyền cả `speed_profile` và `reasoning_effort`; kết quả trả về cũng ghi lại đúng hai giá trị này. Dùng `harness_profiles` để xem toàn bộ lựa chọn.

Hai thông số trên điều khiển chính sách làm việc của Shiro và được chuyển nguyên vẹn trong từng model request. Model/compute thật của dịch vụ ChatGPT vẫn do model selector và entitlement của ChatGPT Web quyết định; MCP không thể tự nâng quota hay thay đổi compute phía máy chủ.

### Bối cảnh gửi cho ChatGPT

Shiro không gửi lại toàn bộ lịch sử hội thoại mỗi lượt. Lượt đầu của một thread gửi đầy đủ; các lượt sau chỉ gửi những sự kiện mới kể từ câu trả lời trước, vì thread ChatGPT đã giữ phần cũ. Đo thực tế trên 40 lượt: giảm từ ~2.24 MB (≈588K token) xuống ~0.16 MB (≈41K token), tức **14x**.

Cách này chỉ được dùng khi Shiro chứng minh được thread vẫn khớp với transcript của Harness. Mọi trường hợp nghi ngờ đều quay về gửi đầy đủ trên một thread mới: khởi động lạnh, đổi phiên, sau compaction/rewind (Harness cắt bớt lịch sử nhưng thread vẫn giữ bản gốc), đổi system prompt, sau một lượt lỗi (prompt có thể đã kịp vào khung chat), và khi xoay thread định kỳ. Danh sách tool đổi thì đi kèm trong delta chứ không cần gửi lại transcript.

### Connector actions: direct action trước, Harness sau

Connector Shiro lộ **122 action** cho ChatGPT (trước đây là 12, rồi 74, rồi 118). Việc thường ngày —
đọc file, xem `git status`, chạy test, bật dev server, đổi lịch một fleet — là
**một action, một lượt MCP, không gọi LLM và không tạo durable session**. `harness_start`
vẫn là đường duy nhất cho công việc lập trình thật sự cần suy luận.

| Muốn làm | Dùng |
|---|---|
| Đọc file | `fs_read` |
| Tìm nội dung | `fs_search` |
| Trạng thái repo | `git_status`, `git_repo_info` |
| Chạy test | `test_run` / `task_run` |
| Chạy đúng một lệnh | `exec_run` |
| Bật dev server chạy nền | `process_start` → `process_logs` → `process_stop` |
| Làm việc trên project khác | `workspace_open` → mọi action kèm `workspace` |
| Chạy nhiều task song song, cô lập | `worktree_create` → `harness_start({workspace})` |
| Giao task coding dài cho project khác | `workspace_open` → `harness_start({workspace})` |
| Trả lời chương trình đang hỏi (REPL, installer, `gh auth`) | `terminal_start` → `terminal_write` → `terminal_read` |
| Tải file từ URL vào workspace | `download_file` |
| Đưa file đính kèm trong ChatGPT vào workspace | `artifact_import` |
| Nhìn ảnh / một trang PDF | `image_open`, `pdf_render_page` |
| Chụp một tab ChatGPT do Shiro sở hữu | `browser_tab_screenshot` |
| Điều khiển browser: điều hướng, tìm element, click, gõ | `browser_tab_navigate`, `browser_dom_query`, `browser_tab_click`, `browser_tab_type` |
| Sửa/refactor nhiều bước | `harness_start` |
| Đọc lại một thread theo dòng sự kiện | `thread_events` |
| Bẻ lái turn đang chạy / rẽ nhánh thread | `turn_steer`, `thread_fork` |
| Xem và tự siết quyền của đợt chạy | `permission_get`, `permission_set` |
| Review theo từng hunk, nhận hunk này bỏ hunk kia | `review_diff` → `review_stage_hunk` / `review_revert_hunk` |
| Worker ChatGPT định kỳ | `fleet_start` |

**Nhiều workspace.** Direct action không còn bị khóa trong repo Shiro: `workspace_open`
đăng ký thêm root và mọi action `fs_*`/`exec_*`/`git_*`/`task_*`/`terminal_*` nhận tham
số `workspace`. Mở được những đâu là do người vận hành quyết định qua
`SHIRO_WORKSPACE_ALLOWLIST` (mặc định của launcher: thư mục cha của project root và
`/tmp/shiro`); để trống thì bridge single-root y như trước. Bên trong mỗi workspace,
luật sandbox cũ nguyên vẹn.

`harness_start({workspace})` neo cả một durable Harness session vào workspace đó, nên agent
chạy task coding dài trên project khác mà **mọi tool của engine** (filesystem, shell, git,
container) đều làm việc đúng cây đó. Session được namespace theo workspace: resume một
session từ workspace khác bị từ chối. Workspace phải đang mở thì mới neo được — id lạ fail
trước khi engine thấy bất kỳ path nào, nên allowlist chi phối cả agent turn.

**Terminal tương tác.** `process_start` chạy nền nhưng không nhận stdin tiếp; họ
`terminal_*` mở pty thật (qua helper Python stdlib) nên REPL, installer, `gh auth login`,
ssh hay debugger đều trả lời được. `terminal_read` dựng lại output theo dòng như terminal
vẽ, và chờ tới khi chương trình im lặng nên viết-rồi-đọc chỉ tốn một lượt.

Cùng bề mặt đó gọi được từ terminal và từ code, không riêng ChatGPT:

```bash
shiro call fs_read --path src/index.js --json
```

`bridge/src/sdk.js` (JS) và `bridge/sdk/shiro.py` (Python, chỉ thư viện chuẩn) cho cùng
các action đó dưới dạng hàm, nối lại thread bằng session id. Không có `shiro exec
"<prompt>"`: model của Shiro là ChatGPT ở phía client, nên một CLI muốn chạy trọn agent
turn sẽ phải *là* model đó.

Client nên gọi `bridge_capabilities` trước để biết deployment này có action nào
(`features.fleet` là `false` khi không cấu hình browser relay, `features.multi_root_workspaces`
là `false` khi không có allowlist, `features.pdf` phụ thuộc poppler) và `bridge_status` để
biết bridge đang chạy gì. Chi tiết đầy đủ — schema, mã lỗi, phân trang, quy tắc phê
duyệt, và những thứ cố ý không hỗ trợ — nằm trong
[`docs/CONNECTOR_ACTIONS.md`](docs/CONNECTOR_ACTIONS.md).

### Công cụ Git và web

Agent có bộ tool Git riêng (first-party, không cài plugin ngoài): `git_status`, `git_diff`, `git_log`, `git_show`, `git_branch`, `git_add`, `git_commit`. Mọi lệnh git chạy qua argv array (không dựng chuỗi shell nên không thể bị chèn lệnh), đường dẫn bị giới hạn trong project root, tên nhánh/ref được kiểm tra, message commit truyền qua stdin, và các thao tác thay đổi (`git_add`/`git_commit`/tạo+chuyển nhánh) phải qua phê duyệt. Các lệnh phá hủy hoặc mạng (reset, restore, checkout, clean, stash, rebase, merge, push, config) không mở cho agent — dùng `pwsh`/`sandbox_exec` cho những việc đó.

Connector còn có họ `git_*` riêng cho ChatGPT (xem mục trên), dùng chung đúng lớp
argv/confinement này; ở đó reset/restore/rebase/push *có* mặt nhưng bị chặn sau
`confirm: true`, và `git_push` là hành động duy nhất đưa commit ra khỏi máy.

`web_fetch` đã được bật (đọc trọn nội dung một URL, không chỉ snippet search) qua provider first-party đã được làm cứng. Tool `session_search`/`session_trace` cho phép tìm lại phiên cũ. Muốn nối một MCP server ngoài, xem mẫu comment trong `bridge/cordis.patch.yml` (mỗi server một dòng, tool hiện dưới tên `mcp__<server>__<tool>`); Shiro không tự bật vì tool của server đó thừa hưởng toàn bộ quyền tin cậy.

### Grok Build CLI

Nếu máy đã cài và đăng nhập Grok Build CLI (`%USERPROFILE%\.grok\bin\grok.exe`, xác thực qua grok.com), model selector có thêm provider `Shiro · Grok Build` với `grok-4.6` và `grok-4.5`. Bridge chạy CLI ở chế độ headless một lượt với toàn bộ tool/subagent/web-search của CLI bị tắt — DeepSeek Harness vẫn giữ trọn agent loop; Grok chỉ đóng vai trò model. Output bị ép đúng schema blocks qua `--json-schema`, effort `Light/Standard/High/Max` khớp thẳng `low/medium/high/xhigh`, usage token là số thật từ CLI, và mỗi request là một tiến trình riêng nên subagent song song chạy thật sự song song. Ghi đè đường dẫn CLI bằng biến môi trường `SHIRO_GROK_CLI`; không có CLI thì provider tự ẩn.

## Nâng cấp đã chọn lọc

- `dsh-auto-continue`: tự phục hồi lỗi tạm thời/max-token với backoff, giới hạn số lần, phát hiện vòng lặp và không tiếp tục sau khi người dùng dừng.
- `dsh-subagent-monitor`: bảng trạng thái live cho subagent, chỉ phục vụ trên web server loopback của Shiro.

Plugin và catalog nghiên cứu được ghim commit trong `.gitmodules`/Git index, không bám nhánh `latest`. `Start-Shiro.cmd` tự khởi tạo submodule còn thiếu đúng revision đã ghim; bạn cũng có thể chạy `git submodule update --init --recursive` thủ công. Quyết định nhận/loại và bằng chứng test nằm trong `UPGRADE_AUDIT.md`.

## Chạy trên Omarchy / Arch Linux

Máy cần Node.js 24+, pnpm 11, Chromium và Docker. Trên Omarchy, chạy một lần:

```bash
npm run install:omarchy
```

Lệnh này bật Docker, thêm user hiện tại vào nhóm `docker` và cài launcher **Shiro** vào application menu. Sau đó mở Shiro từ launcher hoặc chạy:

```bash
npm run start:linux
```

Lần đầu Shiro cài dependency, build engine, dựng runner cô lập và mở profile Chromium riêng. Trên Hyprland, cửa sổ Chromium này khởi động trong workspace ẩn `special:minimized` — kéo ra bằng `hyprctl dispatch 'hl.dsp.window.move({ workspace = "1", window = "pid:<PID>" })'`. Đăng nhập `chatgpt.com`, sau đó mở trang setup tại `http://127.0.0.1:23158/setup` và kết nối extension bằng Bridge token hiển thị ở đó — panel nhập token mở qua icon **ChatGPT Browser Bridge** trên toolbar (nút Bridge nổi góc phải dưới chỉ hiện sau khi đã kết nối relay). Profile và token được lưu ở thư mục `.ShiroRuntime` nằm cạnh repo, không nằm trong Git.

Dừng toàn bộ backend, relay và profile Chromium riêng bằng:

```bash
npm run stop:linux
```

### ChatGPT Web gọi Shiro như một connector chính thức (Secure MCP Tunnel)

Ngoài luồng mặc định (Shiro UI → tab ChatGPT), Shiro có thể được nối vào ChatGPT Web như một **connector MCP chính thức**: bạn chat thẳng trên `chatgpt.com` và ChatGPT gọi các tool `harness_start`/`harness_continue`/`harness_status`/`harness_respond`/`harness_cancel` để thao tác trên máy — giống cách Codex làm việc. Đường kết nối dùng [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) của OpenAI: `tunnel-client` chạy trên máy chỉ mở kết nối outbound tới OpenAI rồi chuyển tiếp về MCP server loopback `127.0.0.1:23157/mcp`, kèm Bridge token trong header — không mở cổng nào ra Internet.

Chuẩn bị một lần:

1. Tạo tunnel tại `https://platform.openai.com/settings/organization/tunnels` (được ID dạng `tunnel_...`).
2. Tạo runtime API key tại `https://platform.openai.com/settings/organization/api-keys` với quyền Tunnels **Read + Use**.
3. Cài tunnel client chính thức (ghim version + verify SHA-256, tải từ `github.com/openai/tunnel-client`):

```bash
npm run tunnel:install
```

Sau đó chạy thiết lập một lần:

```bash
npm run tunnel:linux
```

Script hỏi tunnel ID (lưu ở `.ShiroRuntime/state/tunnel-id.txt`) và runtime API key (lưu ở `.ShiroRuntime/state/runtime-api-key.txt`, quyền 0600, ngoài Git). Từ đó về sau **mở Shiro là đủ**: launcher/`npm run start:linux` tự khởi động tunnel nền cùng backend, và `npm run stop:linux` dừng cả tunnel. Ai không muốn ghi key ra đĩa có thể export `CONTROL_PLANE_API_KEY` rồi chạy `npm run tunnel:linux` — khi đó tunnel chạy foreground và key chỉ nằm trong bộ nhớ.

Cuối cùng, trên ChatGPT Web (cần bật **Developer mode** trong Settings → Apps & Connectors → Advanced): mở `chatgpt.com/plugins`, bấm **+** tạo developer-mode app, chọn **Tunnel** ở mục **Connection** rồi chọn tunnel vừa chạy (hoặc dán `tunnel_id`). Từ đó mỗi cuộc chat có thể bật app Shiro và giao việc; mọi tool vẫn chạy trong project root đã khóa, các thao tác ghi/nguy hiểm vẫn phải qua phê duyệt (`harness_respond`).

Lưu ý: ChatGPT không hỗ trợ gắn header tĩnh cho connector tự tạo, nên đừng tự expose `127.0.0.1:23157` qua ngrok/cloudflared ở chế độ "No authentication" — tunnel chính thức là đường duy nhất giữ được Bridge token. Developer mode với đầy đủ tool ghi hiện tùy gói tài khoản (Pro/Business/Enterprise có thể khác nhau); nếu tool ghi bị chặn bởi safety check phía OpenAI, hãy kiểm tra lại quyền của workspace.

## Chạy trên Windows

Nhấp đúp **`Shiro.exe`** ở gốc repo (build lại bằng `scripts\Build-Launcher.ps1` nếu thiếu). Launcher chạy ngầm toàn bộ chuỗi: relay ChatGPT → backend DSH → trình duyệt ChatGPT ẩn → ứng dụng desktop. `Start-Shiro.cmd` vẫn dùng được nếu muốn xem log trực tiếp. Lần đầu Shiro sẽ cài dependency và build engine; các lần sau khởi động nhanh hơn. Ứng dụng desktop mở giao diện DSH cục bộ tại `http://127.0.0.1:3080/`, gồm session, goal, workflow, subagent và các plugin đã ghim.

Shiro tự mở một cửa sổ Chrome thu nhỏ dùng profile riêng (`E:\Project\.ShiroRuntime\chrome-profile`) đã nạp sẵn extension companion. Lần đầu tiên bạn cần làm hai việc một lần trong cửa sổ đó:

1. Đăng nhập `chatgpt.com`.
2. Mở nút Bridge ở góc phải dưới, dán Bridge token hiển thị trên trang setup (`http://127.0.0.1:23158/setup`, tự mở khi chưa kết nối) rồi chọn Save & connect.

Đăng nhập và token được lưu trong profile riêng, nên từ lần sau mọi thứ tự chạy ẩn hoàn toàn. Nếu không muốn trình duyệt ẩn (tự quản lý tab ChatGPT trong Chrome chính), chạy `Start-Shiro.ps1 -NoHiddenBrowser`. Từ đó luồng local là `DSH UI → GPT-5.6 Sol trong tab ChatGPT đã đăng nhập → DSH agent loop`; mọi file, terminal, test, Git, goal, workflow, subagent và plugin vẫn do DeepSeek Harness chạy và hiển thị trong Shiro.

`Start-Shiro-Tunnel.cmd` chỉ còn là đường tùy chọn ngược lại để một cuộc chat trên ChatGPT gọi vào Shiro qua MCP. Direct chat trong Shiro không cần tunnel này. OpenAI runtime API key của tunnel chỉ được giữ trong bộ nhớ và không được ghi vào repo.

Để build lại ứng dụng Windows:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\scripts\Build-Desktop.ps1
```

Nếu đã sửa mã engine, chạy lại với `-Rebuild`:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\scripts\Start-Shiro.ps1 -Rebuild
```

### Tự gửi prompt định kỳ vào ChatGPT Web

Sau khi Shiro đã chạy và tab ChatGPT đã kết nối bridge, có thể gửi cùng một prompt ngay lập tức rồi lặp lại mỗi 27 phút:

```powershell
npm run prompt:repeat -- --prompt "Tiếp tục công việc hiện tại và báo cáo tiến độ."
```

Với prompt nhiều dòng, nên đặt nội dung trong file để không phải xử lý dấu nháy ở command line:

```powershell
npm run prompt:repeat -- --prompt-file .\prompt.txt
```

Script tự đọc URL và API token từ `.ShiroRuntime/state/chatgpt-relay.env`, không in token ra màn hình. Thêm `--wait-first` nếu muốn chờ đủ 27 phút trước lần gửi đầu, `--session <conversation-id>` để cố định một cuộc chat, hoặc `--once` để thử một lần. Nhấn Ctrl+C để dừng. Mỗi lần chạy dùng endpoint `POST /browser/passive-prompt`, tức là bridge điền prompt và bấm gửi trên ChatGPT Web; nếu tab đang bận, lần gửi đó thất bại an toàn và scheduler tiếp tục ở mốc 27 phút kế tiếp.

## Ranh giới an toàn

- Web UI và MCP chỉ lắng nghe trên loopback `127.0.0.1`.
- Browser relay chỉ lắng nghe trên `127.0.0.1:23158`, dùng API token và Bridge token tách biệt. Extension chỉ được cấp host permission cho ChatGPT và loopback.
- Mỗi tool call từ ChatGPT phải khớp đúng tên tool DSH đã cấp trong model request; tool lạ bị adapter từ chối trước khi đi vào Harness.
- Agent chỉ được thao tác trong `ProjectRoot` đã chọn; mặc định là chính repo Shiro.
- Token, session, extension đã triển khai và cấu hình runtime nằm tại thư mục `.ShiroRuntime` cạnh repo (ví dụ `/home/user/Projects/.ShiroRuntime` hoặc `E:\Project\.ShiroRuntime`), ngoài project root.
- Không có lệnh tự động push hoặc merge. Git vẫn hoạt động cục bộ trong project root; `git_push` của connector luôn đòi `confirm: true` và nêu đúng nhánh/remote/số commit trước khi chạy.
- Direct action của connector dùng chung một lớp sandbox: path tương đối, chặn `..`, chặn path tuyệt đối và chặn symlink trỏ ra ngoài `ProjectRoot` (kiểm tra sau khi resolve symlink).
- `exec_run`/`process_start` chạy argv array không qua shell (trừ khi `shell: true` được yêu cầu rõ ràng), cwd bắt buộc nằm trong project root, và tiến trình con chỉ nhận environment allowlist — token của bridge và relay không bao giờ được kế thừa.
- Bridge chỉ liệt kê và dừng những tiến trình do chính nó khởi động; tắt bridge thì kill hết.
- Remote URL có credential, output git mạng, `config_get` và `logs_tail` đều đi qua bộ che secret.
- Secure MCP Tunnel là kết nối outbound; MCP cục bộ không được mở trực tiếp ra LAN/Internet.
- Plugin subagent monitor chỉ mở endpoint đọc trạng thái trên cùng web server loopback; không mở cổng mới.
- Test runner và build dùng `sandbox_exec`: chỉ repo Shiro được mount vào một container không có mạng, không có quyền mở rộng và tự hủy sau mỗi lệnh. Các volume dependency dùng chung được mount chỉ-đọc trong lúc chạy task để một phiên không thể làm nhiễm dependency của phiên sau.
- Launcher tự chuẩn bị runner và dependency Linux riêng trong Docker volumes; nó không ghi đè `node_modules` của host.

## Nguồn mở

Shiro tích hợp DeepSeek Harness theo giấy phép MIT và dùng Pake để tạo desktop shell. Xem `THIRD_PARTY.md` và các file giấy phép đi kèm từng thành phần.
