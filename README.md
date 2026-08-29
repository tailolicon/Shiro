# Shiro

Shiro biến ChatGPT Web với GPT-5.6 Sol thành một coding agent đầy đủ trên máy Windows. Sol đưa ra quyết định; Shiro chạy đọc/ghi file, terminal, test, Git, goal, workflow và subagent qua engine DeepSeek Harness.

Giao diện web cục bộ được đóng gói thành ứng dụng Windows bằng Pake. Toàn bộ mã nguồn có thể đọc và chỉnh sửa ngay trong repo này.

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

### Công cụ Git và web

Agent có bộ tool Git riêng (first-party, không cài plugin ngoài): `git_status`, `git_diff`, `git_log`, `git_show`, `git_branch`, `git_add`, `git_commit`. Mọi lệnh git chạy qua argv array (không dựng chuỗi shell nên không thể bị chèn lệnh), đường dẫn bị giới hạn trong project root, tên nhánh/ref được kiểm tra, message commit truyền qua stdin, và các thao tác thay đổi (`git_add`/`git_commit`/tạo+chuyển nhánh) phải qua phê duyệt. Các lệnh phá hủy hoặc mạng (reset, restore, checkout, clean, stash, rebase, merge, push, config) không được mở — dùng `pwsh`/`sandbox_exec` cho những việc đó.

`web_fetch` đã được bật (đọc trọn nội dung một URL, không chỉ snippet search) qua provider first-party đã được làm cứng. Tool `session_search`/`session_trace` cho phép tìm lại phiên cũ. Muốn nối một MCP server ngoài, xem mẫu comment trong `bridge/cordis.patch.yml` (mỗi server một dòng, tool hiện dưới tên `mcp__<server>__<tool>`); Shiro không tự bật vì tool của server đó thừa hưởng toàn bộ quyền tin cậy.

### Grok Build CLI

Nếu máy đã cài và đăng nhập Grok Build CLI (`%USERPROFILE%\.grok\bin\grok.exe`, xác thực qua grok.com), model selector có thêm provider `Shiro · Grok Build` với `grok-4.6` và `grok-4.5`. Bridge chạy CLI ở chế độ headless một lượt với toàn bộ tool/subagent/web-search của CLI bị tắt — DeepSeek Harness vẫn giữ trọn agent loop; Grok chỉ đóng vai trò model. Output bị ép đúng schema blocks qua `--json-schema`, effort `Light/Standard/High/Max` khớp thẳng `low/medium/high/xhigh`, usage token là số thật từ CLI, và mỗi request là một tiến trình riêng nên subagent song song chạy thật sự song song. Ghi đè đường dẫn CLI bằng biến môi trường `SHIRO_GROK_CLI`; không có CLI thì provider tự ẩn.

## Nâng cấp đã chọn lọc

- `dsh-auto-continue`: tự phục hồi lỗi tạm thời/max-token với backoff, giới hạn số lần, phát hiện vòng lặp và không tiếp tục sau khi người dùng dừng.
- `dsh-subagent-monitor`: bảng trạng thái live cho subagent, chỉ phục vụ trên web server loopback của Shiro.

Plugin và catalog nghiên cứu được ghim commit trong `.gitmodules`/Git index, không bám nhánh `latest`. `Start-Shiro.cmd` tự khởi tạo submodule còn thiếu đúng revision đã ghim; bạn cũng có thể chạy `git submodule update --init --recursive` thủ công. Quyết định nhận/loại và bằng chứng test nằm trong `UPGRADE_AUDIT.md`.

## Chạy trên máy này

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
- Token, session, extension đã triển khai và cấu hình runtime nằm tại thư mục anh em `E:\Project\.ShiroRuntime`, ngoài project root.
- Không có lệnh tự động push hoặc merge. Git vẫn hoạt động cục bộ trong project root.
- Secure MCP Tunnel là kết nối outbound; MCP cục bộ không được mở trực tiếp ra LAN/Internet.
- Plugin subagent monitor chỉ mở endpoint đọc trạng thái trên cùng web server loopback; không mở cổng mới.
- Test runner và build dùng `sandbox_exec`: chỉ repo Shiro được mount vào một container không có mạng, không có quyền mở rộng và tự hủy sau mỗi lệnh. Các volume dependency dùng chung được mount chỉ-đọc trong lúc chạy task để một phiên không thể làm nhiễm dependency của phiên sau.
- `Start-Shiro.cmd` tự khởi động Docker Desktop khi cần, dựng runner và chuẩn bị dependency Linux riêng trong Docker volumes; nó không ghi đè `node_modules` của Windows.

## Nguồn mở

Shiro tích hợp DeepSeek Harness theo giấy phép MIT và dùng Pake để tạo desktop shell. Xem `THIRD_PARTY.md` và các file giấy phép đi kèm từng thành phần.
