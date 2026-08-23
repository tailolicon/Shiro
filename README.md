# Shiro

Shiro biến ChatGPT Web với GPT-5.6 Sol thành một coding agent đầy đủ trên máy Windows. Sol đưa ra quyết định; Shiro chạy đọc/ghi file, terminal, test, Git, goal, workflow và subagent qua engine DeepSeek Harness.

Giao diện web cục bộ được đóng gói thành ứng dụng Windows bằng Pake. Toàn bộ mã nguồn có thể đọc và chỉnh sửa ngay trong repo này.

## Cấu trúc

- `engine/`: mã nguồn DeepSeek Harness, được dùng làm agent runtime.
- `bridge/`: adapter và MCP bridge kết nối ChatGPT Sol với Harness.
- `desktop/`: cấu hình Pake và tài nguyên ứng dụng Windows.
- `scripts/`: cài đặt, khởi động, dừng, mở tunnel và build desktop app.

## Chạy trên máy này

Nhấp đúp `Start-Shiro.cmd`. Lần đầu Shiro sẽ cài dependency và build engine; các lần sau sẽ khởi động nhanh hơn. Giao diện dùng địa chỉ cục bộ `http://127.0.0.1:3080/`.

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

## Nguồn mở

Shiro tích hợp DeepSeek Harness theo giấy phép MIT và dùng Pake để tạo desktop shell. Xem `THIRD_PARTY.md` và các file giấy phép đi kèm từng thành phần.
