# Bàn giao reload Shiro — bộ công cụ làm game, 2026-09-10

## Kết quả

Đã sửa mã nguồn connector tại `/home/tailolicon/Projects/Shiro`, không chỉ bổ sung script trong repo game. Bản trên đĩa dùng `DIRECT_ACTIONS_VERSION = 5`, `GAME_TOOLS_VERSION = 1`, thêm 11 action cho Unity, Blender, media/audio, desktop và kiểm tra tiến trình trước reload. Backend hiện chạy vẫn báo catalog v4; chưa tự restart.

Blender 5.2.0 LTS đã được cài từ kho Arch có kiểm tra chữ ký. Python, Unity CLI, FFmpeg, FFprobe và công cụ desktop cần thiết đã được tìm thấy. Không nâng Unity/package của game, không sửa driver GPU, không mua dịch vụ hoặc tự tạo quyền tài khoản.

Kiểm thử cuối: **578/578 đạt, 0 lỗi, 0 bỏ qua**, qua task test đã khai báo của repo. Bằng chứng chi tiết và giới hạn: `docs/GAME_DEVELOPMENT_CONNECTOR.md`, `.shiro/evidence/game-toolchain-20260910/final-test-summary.json`.

## Bảo toàn game

Snapshot game trước reload:

- Repo: `/home/tailolicon/Projects/doomsday-prepper-sim`
- Snapshot ID: `ce073d079529`
- Snapshot commit: `ce073d07952952c0e52d6a4c3a8ddd37a4ed41e9`
- Base HEAD: `28e0c6588a49359f23866ca251d94060891505d9`
- 592 file thay đổi được ghi nhận trong snapshot.

Snapshot giữ nguyên working tree/index, không reset hay thay thế công việc hiện tại. Hai worker game được thấy ở đầu lượt không còn trong danh sách tiến trình đang chạy khi kiểm tra trước bàn giao.

## Lưu ý trước khi reload

Lần kiểm tra gần nhất cho thấy **2 tiến trình Hachimi và 1 fleet còn hoạt động**, không phải công việc do lượt nâng cấp connector này khởi chạy:

- `hachimi-temp3-T1-handoff`, process `f5d7a21c-1bc1-4ea2-b37e-c847b2f33a69`.
- `hachimi-temp3-T2`, process `c443f603-a2ff-497a-8bfd-fb91f768a41d`.

Không tự dừng chúng để tránh phá việc từ phiên khác. Kiểm tra lại `process_list` và `bridge_status` ngay trước reload; chờ hoặc tạm dừng công việc Hachimi qua phiên điều phối của nó. Reload có thể ngắt tiến trình đang chạy và làm gián đoạn lịch fleet. Không coi đĩa đã lưu code là bằng chứng mọi side effect của worker đã hoàn tất.

## Cách nạp bản mới

1. Sau khi công việc đang chạy đã được lưu/tạm dừng, **restart backend Shiro trên máy** qua launcher hiện dùng. Repo có task `reload:linux` (`pnpm run reload:linux`); task này đã được tìm thấy nhưng không được thực thi trong lượt nâng cấp.
2. Sau khi backend trở lại, refresh/reload connector trong ChatGPT để lấy danh sách tool mới.
3. Gọi `bridge_capabilities` hoặc `bridge_status`: catalog phải báo `direct_actions_version: 5`. Danh sách phải có `game_toolchain_status`, `unity_command`, `blender_run`, `blender_inspect`, `blender_render`, `media_probe`, `audio_analyze`, `desktop_windows`, `desktop_capture`, `desktop_input`, `reload_readiness`.

Nếu chỉ refresh tool catalog khi backend vẫn chạy mã cũ, các action mới sẽ chưa xuất hiện. Không có bằng chứng cần reboot toàn bộ máy hoặc restart Unity để nạp bản connector này.

## Kiểm tra sau reload

Gọi `game_toolchain_status` cho workspace `doomsday-prepper`, rồi `unity_command` với `command: "editor_status"`. File cấu hình `.shiro/game-dev.json` của game đã chỉ định `prototype` và `doomsday-prepper-unity-editor.service` để wrapper chọn đúng Editor.

Các kiểm thử Blender tạo model, xuất GLB, nhập lại GLB và render PNG đã chạy thật; WAV của game đã được phân tích bằng Python và FFprobe. Ảnh roundtrip đã được mở xem và có khối lập phương mong đợi. Đây là bằng chứng đường công cụ hoạt động, không phải xác nhận mọi asset/gameplay/co-op của game đã hoàn thiện.

## Giới hạn còn rõ ràng

- Focus và phím F8 qua API Lua Hyprland đã được quan sát trong cửa sổ kiểm thử riêng. Click chuột native Wayland chưa được chứng minh, nên bản mới trả `UNSUPPORTED`, không trả thành công giả.
- Wrapper chụp desktop đã được sửa theo API focus đúng, nhưng lượt chạy GUI tích hợp cuối bị chặn ở lớp kiểm tra an toàn của công cụ; chưa đánh dấu đạt. Không thử vượt chặn bằng đường khác.
- Quyền local `full` không tự cấp quota/tài khoản cloud, giấy phép asset trả phí, quyền Steam publishing hay kết quả playtest con người.
- Các log/receipt trên đĩa còn sau reload; tiến trình đang chạy không tự được bảo toàn. Kiểm tra kết quả trước khi tiếp tục hoặc chạy lại một thao tác có side effect.

Tài liệu này là bàn giao công cụ để tiếp tục hoàn thiện game. Trạng thái hoàn thành 100% của game chưa được xác nhận.
