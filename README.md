# Shiro

Shiro biến ChatGPT Web với GPT-5.6 Sol thành một coding agent đầy đủ trên máy Windows. Sol đưa ra quyết định; Shiro chạy đọc/ghi file, terminal, test, Git, goal, workflow và subagent qua engine DeepSeek Harness.

Giao diện web cục bộ được đóng gói thành ứng dụng Windows bằng Pake. Toàn bộ mã nguồn có thể đọc và chỉnh sửa ngay trong repo này.

## Cấu trúc

- `engine/`: mã nguồn DeepSeek Harness, được dùng làm agent runtime.
- `bridge/`: adapter và MCP bridge kết nối ChatGPT Sol với Harness.
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

## Nâng cấp đã chọn lọc

- `dsh-auto-continue`: tự phục hồi lỗi tạm thời/max-token với backoff, giới hạn số lần, phát hiện vòng lặp và không tiếp tục sau khi người dùng dừng.
- `dsh-subagent-monitor`: bảng trạng thái live cho subagent, chỉ phục vụ trên web server loopback của Shiro.

Plugin và catalog nghiên cứu được ghim commit trong `.gitmodules`/Git index, không bám nhánh `latest`. `Start-Shiro.cmd` tự khởi tạo submodule còn thiếu đúng revision đã ghim; bạn cũng có thể chạy `git submodule update --init --recursive` thủ công. Quyết định nhận/loại và bằng chứng test nằm trong `UPGRADE_AUDIT.md`.

## Chạy trên máy này

Nhấp đúp `Start-Shiro.cmd`. Lần đầu Shiro sẽ cài dependency và build engine; các lần sau sẽ khởi động nhanh hơn. Ứng dụng desktop mở cuộc trò chuyện ChatGPT Work đã gắn nguồn Shiro; hãy nhập yêu cầu ở đó để ChatGPT gọi Harness qua MCP.

`http://127.0.0.1:3080/` là bảng điều khiển Harness cục bộ để xem session và chẩn đoán. Không dùng ô chat tại địa chỉ này làm giao diện ChatGPT: MCP hoạt động theo chiều ChatGPT gọi Shiro nên một tin nhắn gửi trực tiếp tại bảng điều khiển sẽ chờ mà không có model đến nhận.

Để kết nối lại ChatGPT sau khi khởi động máy, chạy `Start-Shiro-Tunnel.cmd`. OpenAI runtime API key chỉ được giữ trong bộ nhớ của tiến trình tunnel và không được ghi vào repo.

Để build lại ứng dụng Windows:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\scripts\Build-Desktop.ps1
```

Nếu đã sửa mã engine, chạy lại với `-Rebuild`:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\scripts\Start-Shiro.ps1 -Rebuild
```

## Ranh giới an toàn

- Web UI và MCP chỉ lắng nghe trên loopback `127.0.0.1`.
- Agent chỉ được thao tác trong `ProjectRoot` đã chọn; mặc định là chính repo Shiro.
- Token, session và cấu hình runtime nằm tại thư mục anh em `E:\Project\.ShiroRuntime`, ngoài project root.
- Không có lệnh tự động push hoặc merge. Git vẫn hoạt động cục bộ trong project root.
- Secure MCP Tunnel là kết nối outbound; MCP cục bộ không được mở trực tiếp ra LAN/Internet.
- Plugin subagent monitor chỉ mở endpoint đọc trạng thái trên cùng web server loopback; không mở cổng mới.
- Test runner và build dùng `sandbox_exec`: chỉ repo Shiro được mount vào một container không có mạng, không có quyền mở rộng và tự hủy sau mỗi lệnh. Các volume dependency dùng chung được mount chỉ-đọc trong lúc chạy task để một phiên không thể làm nhiễm dependency của phiên sau.
- `Start-Shiro.cmd` tự khởi động Docker Desktop khi cần, dựng runner và chuẩn bị dependency Linux riêng trong Docker volumes; nó không ghi đè `node_modules` của Windows.

## Nguồn mở

Shiro tích hợp DeepSeek Harness theo giấy phép MIT và dùng Pake để tạo desktop shell. Xem `THIRD_PARTY.md` và các file giấy phép đi kèm từng thành phần.
